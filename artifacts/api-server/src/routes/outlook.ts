import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { CrmError, activity, businessDate, getInvestor, transaction } from "../lib/crmData";
import { nextStageForEvent, normalizeStage } from "../lib/crmStages";
import { logger } from "../lib/logger";
import { createCrmPinAuth, crmAuthConfigFromEnv, type CrmSessionUser } from "../lib/crmPin";
import {
  exchangeAuthCode,
  folderCounts,
  listAttachments,
  listEvents,
  listFolderMessages,
  downloadAttachment,
  readMessage,
  saveEvent,
  searchMessages,
  syncAllOutlookAccounts,
  syncOutlookUser,
} from "../lib/outlookGraph";
import {
  OutlookError,
  authorizeUrl,
  createPkce,
  cronAuthorized,
  eventIncludes,
  outlookConfigError,
  parseAddressList,
  participantBlob,
  safeFileName,
} from "../lib/outlookLogic";
import { forwardMessage, replyToMessage, sendNewMail } from "../lib/outlookSend";
import {
  deleteAccount,
  deleteDraft,
  deleteTemplate,
  eventsForEmails,
  getAccount,
  getDraft,
  investorContext,
  listDrafts,
  listTemplates,
  localCounts,
  markDraft,
  messagesForEmails,
  putOAuthState,
  saveDraft,
  saveTemplate,
  setAutoCreate,
  takeOAuthState,
} from "../lib/outlookStore";

const pinAuth = createCrmPinAuth(() => crmAuthConfigFromEnv());
const router = Router();
const manualSyncAt = new Map<number, number>();

function redirectHome(req: Request, res: Response, query: string) {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "crm.gcs.org").split(",")[0].trim();
  res.redirect(302, `${proto}://${host}/?${query}`);
}

function handleError(err: unknown, res: Response) {
  if (err instanceof OutlookError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof CrmError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ message: err instanceof Error ? err.message : "outlook failed" }, "outlook request failed");
  res.status(500).json({ error: "Outlook request failed" });
}

function protectedRoute(handler: (req: Request, res: Response, user: CrmSessionUser) => Promise<void>) {
  return (req: Request, res: Response) => {
    pinAuth.requirePin(req, res, () => {
      const user = pinAuth.getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Sign in with your team email to use Outlook.", code: "user_required" });
        return;
      }
      handler(req, res, user).catch(err => handleError(err, res));
    });
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function graphItemId(value: unknown): string {
  if (typeof value !== "string" || value.length < 4 || value.length > 2000 || /\s/.test(value)) {
    throw new OutlookError(400, "Missing Outlook item id");
  }
  return value;
}

function numericId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new OutlookError(400, "Invalid id");
  return n;
}

function timeZoneOf(value: unknown): string {
  const zone = typeof value === "string" && zoneSafe(value) ? value.trim() : "UTC";
  return zone;
}

function zoneSafe(value: string): boolean {
  return /^[A-Za-z0-9_+\-/]{1,64}$/.test(value.trim());
}

function localDateTime(value: unknown): string {
  if (typeof value !== "string") throw new OutlookError(400, "Choose a start and end time");
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/);
  if (!match) throw new OutlookError(400, "Use a date and time");
  return `${match[1]}:00`;
}

function isoQuery(value: unknown, fallback: Date): string {
  if (typeof value !== "string" || !value.trim()) return fallback.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new OutlookError(400, "Invalid date");
  return date.toISOString();
}

type DraftRecord = NonNullable<Awaited<ReturnType<typeof getDraft>>>;

function publicDraft(row: DraftRecord | null, full: boolean) {
  if (!row) return null;
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  return {
    id: row.id,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    body: row.body,
    investorId: row.investorId,
    replyMessageId: row.replyMessageId,
    forwardMessageId: row.forwardMessageId,
    status: row.status,
    error: row.error,
    updatedAt: row.updatedAt,
    attachments: attachments.map(item => {
      const file = item as { name?: string; contentType?: string; contentBytes?: string };
      return full
        ? { name: file.name, contentType: file.contentType, contentBytes: file.contentBytes }
        : { name: file.name || "attachment", contentType: file.contentType || "" };
    }),
  };
}

async function noteSent(investorId: number | null, to: string[], subject: string) {
  try {
    let id = investorId;
    if (!id && to[0]) {
      const found = await pool.query("SELECT id FROM crm_investors WHERE email_key=$1 LIMIT 1", [to[0]]);
      if (found.rows[0]) id = Number(found.rows[0].id);
    }
    if (!id) return false;
    await transaction(async client => {
      const investor = await getInvestor(client, id as number);
      const stage = normalizeStage(investor.status) ?? "New";
      const next = nextStageForEvent(stage, "email_sent");
      await activity(client, id as number, `Outlook: sent "${subject || "(no subject)"}" to ${to.join(", ")}`, "email_sent");
      const date = businessDate();
      if (next !== stage) {
        await client.query(
          "UPDATE crm_investors SET data=jsonb_set(jsonb_set(data,'{status}',to_jsonb($2::text),true),'{last_contacted_date}',to_jsonb($3::text),true), updated_at=NOW() WHERE id=$1",
          [id, next, date],
        );
      } else {
        await client.query(
          "UPDATE crm_investors SET data=jsonb_set(data,'{last_contacted_date}',to_jsonb($2::text),true), updated_at=NOW() WHERE id=$1",
          [id, date],
        );
      }
    });
    return true;
  } catch (err) {
    logger.warn({ message: err instanceof Error ? err.message : "log failed" }, "outlook activity log failed");
    return false;
  }
}

router.get("/callback", async (req, res) => {
  try {
    if (req.query.error) {
      redirectHome(req, res, "outlook=error&reason=denied");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const saved = state ? await takeOAuthState(state) : null;
    if (!saved || !code) {
      redirectHome(req, res, "outlook=error&reason=oauth_failed");
      return;
    }
    await exchangeAuthCode(saved.userId, code, saved.verifier);
    redirectHome(req, res, "outlook=connected");
  } catch (err) {
    logger.warn({ message: err instanceof Error ? err.message : "callback failed" }, "outlook callback failed");
    redirectHome(req, res, "outlook=error&reason=oauth_failed");
  }
});

router.get("/cron", async (req, res) => {
  try {
    if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 16) {
      res.status(503).json({ error: "Set CRON_SECRET to a random string of at least 16 characters" });
      return;
    }
    if (!cronAuthorized(req.get("authorization") || undefined)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const results = await syncAllOutlookAccounts();
    res.json({
      ok: true,
      results: results.map(item => ({
        userId: item.userId,
        inbox: item.inbox || 0,
        sent: item.sent || 0,
        events: item.events || 0,
        peopleCreated: item.peopleCreated || 0,
        error: item.error || "",
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get("/connect", (req, res) => {
  pinAuth.requirePin(req, res, async () => {
    try {
      const user = pinAuth.getSessionUser(req);
      if (!user) {
        redirectHome(req, res, "outlook=error&reason=user_required");
        return;
      }
      if (outlookConfigError()) {
        redirectHome(req, res, "outlook=error&reason=missing_config");
        return;
      }
      const { verifier, challenge } = createPkce();
      const state = randomBytes(32).toString("base64url");
      await putOAuthState(state, user.id, verifier);
      res.redirect(302, authorizeUrl(state, challenge));
    } catch (err) {
      logger.warn({ message: err instanceof Error ? err.message : "connect failed" }, "outlook connect failed");
      redirectHome(req, res, "outlook=error&reason=oauth_failed");
    }
  });
});

router.get("/account", protectedRoute(async (_req, res, user) => {
  const configError = outlookConfigError();
  const account = await getAccount(user.id);
  res.json({
    configured: !configError,
    configError,
    connected: !!account,
    email: account?.email || "",
    displayName: account?.displayName || "",
    autoCreatePeople: account?.autoCreatePeople || false,
    lastSyncAt: account?.lastSyncAt || null,
    lastSyncError: account?.lastSyncError || "",
  });
}));

router.patch("/account", protectedRoute(async (req, res, user) => {
  if (typeof req.body?.autoCreatePeople !== "boolean") throw new OutlookError(400, "autoCreatePeople must be true or false");
  const account = await getAccount(user.id);
  if (!account) throw new OutlookError(409, "Connect Outlook first", "not_connected");
  await setAutoCreate(user.id, req.body.autoCreatePeople);
  res.json({ autoCreatePeople: req.body.autoCreatePeople });
}));

router.post("/disconnect", protectedRoute(async (_req, res, user) => {
  await deleteAccount(user.id);
  res.json({ connected: false });
}));

router.post("/sync", protectedRoute(async (_req, res, user) => {
  const last = manualSyncAt.get(user.id) || 0;
  if (Date.now() - last < 15_000) throw new OutlookError(429, "Wait a few seconds before syncing again");
  manualSyncAt.set(user.id, Date.now());
  const result = await syncOutlookUser(user.id);
  res.json(result);
}));

router.get("/counts", protectedRoute(async (_req, res, user) => {
  const local = await localCounts(user.id);
  const account = await getAccount(user.id);
  if (!account) {
    res.json({ connected: false, inbox: 0, sent: 0, unread: 0, ...local });
    return;
  }
  try {
    const folders = await folderCounts(user.id);
    res.json({ connected: true, ...folders, ...local });
  } catch {
    res.json({ connected: true, inbox: 0, sent: 0, unread: 0, ...local });
  }
}));

router.get("/messages", protectedRoute(async (req, res, user) => {
  const folder = req.query.folder === "sent" ? "sent" : "inbox";
  res.json({ messages: await listFolderMessages(user.id, folder) });
}));

router.get("/message", protectedRoute(async (req, res, user) => {
  res.json(await readMessage(user.id, graphItemId(req.query.id)));
}));

router.get("/attachments", protectedRoute(async (req, res, user) => {
  res.json({ attachments: await listAttachments(user.id, graphItemId(req.query.id)) });
}));

router.get("/attachment", protectedRoute(async (req, res, user) => {
  const file = await downloadAttachment(user.id, graphItemId(req.query.messageId), graphItemId(req.query.attachmentId));
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(file.name)}"`);
  res.send(file.bytes);
}));

router.post("/send", protectedRoute(async (req, res, user) => {
  const result = await sendNewMail(user.id, req.body || {});
  const investorId = req.body?.investorId ? numericId(req.body.investorId) : null;
  const logged = await noteSent(investorId, result.to, result.subject);
  res.json({ sent: true, logged });
}));

router.post("/reply", protectedRoute(async (req, res, user) => {
  await replyToMessage(user.id, graphItemId(req.body?.id), req.body || {});
  const investorId = req.body?.investorId ? numericId(req.body.investorId) : null;
  let recipients: string[] = [];
  try { recipients = parseAddressList(text(req.body?.to, 2000)); } catch { recipients = []; }
  const logged = investorId && recipients.length ? await noteSent(investorId, recipients, text(req.body?.subject, 500)) : false;
  res.json({ sent: true, logged });
}));

router.post("/forward", protectedRoute(async (req, res, user) => {
  const result = await forwardMessage(user.id, graphItemId(req.body?.id), req.body || {});
  const investorId = req.body?.investorId ? numericId(req.body.investorId) : null;
  const logged = await noteSent(investorId, result.to, text(req.body?.subject, 500));
  res.json({ sent: true, logged });
}));

function draftInput(body: Record<string, unknown>) {
  return {
    to: text(body.to, 2000),
    cc: text(body.cc, 2000),
    bcc: text(body.bcc, 2000),
    subject: text(body.subject, 500),
    body: text(body.body, 200_000),
    attachments: Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [],
    investorId: body.investorId ? numericId(body.investorId) : null,
    replyMessageId: text(body.replyMessageId, 2000),
    forwardMessageId: text(body.forwardMessageId, 2000),
  };
}

router.get("/drafts", protectedRoute(async (req, res, user) => {
  const status = req.query.status === "outbox" ? "outbox" : "draft";
  const rows = await listDrafts(user.id, status);
  res.json({ drafts: rows.map(row => publicDraft(row, false)) });
}));

router.get("/drafts/:id", protectedRoute(async (req, res, user) => {
  const row = await getDraft(user.id, numericId(req.params.id));
  if (!row) throw new OutlookError(404, "Draft not found");
  res.json({ draft: publicDraft(row, true) });
}));

router.post("/drafts", protectedRoute(async (req, res, user) => {
  const saved = await saveDraft(user.id, draftInput(req.body || {}));
  res.status(201).json({ draft: publicDraft(saved, false) });
}));

router.patch("/drafts/:id", protectedRoute(async (req, res, user) => {
  const saved = await saveDraft(user.id, { id: numericId(req.params.id), ...draftInput(req.body || {}) });
  if (!saved) throw new OutlookError(404, "Draft not found");
  res.json({ draft: publicDraft(saved, false) });
}));

router.delete("/drafts/:id", protectedRoute(async (req, res, user) => {
  await deleteDraft(user.id, numericId(req.params.id));
  res.json({ deleted: true });
}));

router.post("/drafts/:id/send", protectedRoute(async (req, res, user) => {
  const id = numericId(req.params.id);
  const draft = await getDraft(user.id, id);
  if (!draft) throw new OutlookError(404, "Draft not found");
  const payload = { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, attachments: draft.attachments };
  try {
    let recipients: string[] = [];
    if (draft.replyMessageId) await replyToMessage(user.id, draft.replyMessageId, payload);
    else if (draft.forwardMessageId) recipients = (await forwardMessage(user.id, draft.forwardMessageId, payload)).to;
    else recipients = (await sendNewMail(user.id, payload)).to;
    await deleteDraft(user.id, id);
    const logged = recipients.length ? await noteSent(draft.investorId, recipients, draft.subject) : false;
    res.json({ sent: true, logged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Send failed";
    await markDraft(user.id, id, "outbox", message);
    throw err;
  }
}));

router.get("/templates", protectedRoute(async (_req, res, user) => {
  res.json({ templates: await listTemplates(user.id) });
}));

router.post("/templates", protectedRoute(async (req, res, user) => {
  const name = text(req.body?.name, 120).trim();
  if (!name) throw new OutlookError(400, "Template name is required");
  const saved = await saveTemplate(user.id, { name, subject: text(req.body?.subject, 500), body: text(req.body?.body, 200_000) });
  res.status(201).json({ template: saved });
}));

router.patch("/templates/:id", protectedRoute(async (req, res, user) => {
  const name = text(req.body?.name, 120).trim();
  if (!name) throw new OutlookError(400, "Template name is required");
  const saved = await saveTemplate(user.id, { id: numericId(req.params.id), name, subject: text(req.body?.subject, 500), body: text(req.body?.body, 200_000) });
  if (!saved) throw new OutlookError(404, "Template not found");
  res.json({ template: saved });
}));

router.delete("/templates/:id", protectedRoute(async (req, res, user) => {
  await deleteTemplate(user.id, numericId(req.params.id));
  res.json({ deleted: true });
}));

router.get("/events", protectedRoute(async (req, res, user) => {
  const start = isoQuery(req.query.start, new Date());
  const end = isoQuery(req.query.end, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  res.json({ events: await listEvents(user.id, start, end, timeZoneOf(req.query.timeZone)) });
}));

router.post("/events", protectedRoute(async (req, res, user) => {
  const notify = req.body?.notify === true;
  const attendees = notify ? parseAddressList(text(req.body?.attendees, 2000)) : [];
  const event = await saveEvent(user.id, {
    subject: text(req.body?.subject, 300),
    body: text(req.body?.body, 8000),
    start: localDateTime(req.body?.start),
    end: localDateTime(req.body?.end),
    timeZone: timeZoneOf(req.body?.timeZone),
    location: text(req.body?.location, 300),
    attendees,
    notify,
  });
  res.status(201).json({ event });
}));

router.patch("/events", protectedRoute(async (req, res, user) => {
  const notify = req.body?.notify === true;
  const attendees = notify ? parseAddressList(text(req.body?.attendees, 2000)) : [];
  const event = await saveEvent(user.id, {
    id: graphItemId(req.body?.id),
    subject: text(req.body?.subject, 300),
    body: text(req.body?.body, 8000),
    start: localDateTime(req.body?.start),
    end: localDateTime(req.body?.end),
    timeZone: timeZoneOf(req.body?.timeZone),
    location: text(req.body?.location, 300),
    attendees,
    notify,
  });
  res.json({ event });
}));

router.get("/records/:id", protectedRoute(async (req, res, user) => {
  const investorId = numericId(req.params.id);
  const context = await investorContext(investorId);
  if (!context) throw new OutlookError(404, "Record not found");
  const account = await getAccount(user.id);
  if (!account) {
    res.json({ connected: false, email: "", recordEmail: context.email, firm: context.firm, messages: [], meetings: [] });
    return;
  }
  let messages: Array<Record<string, unknown>> = [];
  if (context.emails.length) {
    try {
      messages = await searchMessages(user.id, context.emails);
    } catch {
      const rows = await messagesForEmails(user.id, context.emails);
      messages = rows.map(row => ({
        id: row.graph_id,
        conversationId: row.conversation_id,
        subject: row.subject || "(no subject)",
        preview: row.preview,
        from: row.from_email,
        fromName: row.from_name,
        to: [],
        receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at || null,
        hasAttachments: !!row.has_attachments,
        isRead: !!row.is_read,
        webLink: row.web_link,
      }));
    }
  }
  const rangeStart = new Date().toISOString();
  const rangeEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  let meetings: Array<Record<string, unknown>> = [];
  try {
    const events = await listEvents(user.id, rangeStart, rangeEnd, "UTC");
    meetings = events.filter(event => eventIncludes(participantBlob([event.organizer, ...event.attendees.map(item => item.email)]), context.emails));
  } catch {
    const rows = await eventsForEmails(user.id, context.emails, rangeStart);
    meetings = rows.map(row => ({
      id: row.graph_id,
      subject: row.subject || "(no title)",
      preview: row.preview,
      location: row.location,
      start: row.start_at instanceof Date ? row.start_at.toISOString() : row.start_at || null,
      end: row.end_at instanceof Date ? row.end_at.toISOString() : row.end_at || null,
      organizer: row.organizer_email,
      webLink: row.web_link,
      isAllDay: !!row.is_all_day,
    }));
  }
  res.json({
    connected: true,
    email: account.email,
    recordEmail: context.email,
    firm: context.firm,
    messages,
    meetings,
  });
}));

export default router;
