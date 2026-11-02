import { transaction, upsert } from "./crmData";
import { logger } from "./logger";
import {
  GRAPH_BASE,
  OutlookError,
  TOKEN_URL,
  decryptSecret,
  outlookRedirectUri,
  displayNameFromEmail,
  encryptSecret,
  eventFromGraph,
  graphDateToIso,
  messageFromGraph,
  shouldAutoCreateSender,
  tokenRequestBody,
  type GraphEvent,
  type GraphMessage,
} from "./outlookLogic";
import {
  emailExists,
  getAccount,
  listAccounts,
  saveAccount,
  saveCursor,
  saveSyncStatus,
  saveTokens,
  upsertSyncedEvent,
  upsertSyncedMessage,
  pruneEvents,
  userName,
  type OutlookAccount,
} from "./outlookStore";

const refreshing = new Map<number, Promise<string>>();
const syncing = new Map<number, Promise<SyncResult>>();

export type SyncResult = { inbox: number; sent: number; events: number; peopleCreated: number };

async function refreshAccount(account: OutlookAccount): Promise<string> {
  const refreshToken = decryptSecret(account.refreshTokenEnc);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const json = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !json.access_token) {
    throw new OutlookError(401, "Outlook needs to be reconnected", "reconnect");
  }
  const access = json.access_token;
  const nextRefresh = json.refresh_token || refreshToken;
  const expires = new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000);
  await saveTokens(account.userId, encryptSecret(access), encryptSecret(nextRefresh), expires);
  return access;
}

export async function getAccessToken(userId: number, force = false): Promise<string> {
  const account = await getAccount(userId);
  if (!account) throw new OutlookError(409, "Connect Outlook first", "not_connected");
  if (!force && account.expiresAt.getTime() > Date.now() + 60_000) return decryptSecret(account.accessTokenEnc);
  const existing = refreshing.get(userId);
  if (existing) return existing;
  const pending = refreshAccount(account).finally(() => refreshing.delete(userId));
  refreshing.set(userId, pending);
  return pending;
}

export async function exchangeAuthCode(userId: number, code: string, verifier: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: outlookRedirectUri(),
      code_verifier: verifier,
    }),
  });
  const json = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !json.access_token || !json.refresh_token) {
    logger.warn({ message: String(json.error_description || "token exchange failed").slice(0, 240) }, "outlook oauth failed");
    throw new OutlookError(400, "Microsoft did not complete the Outlook connection", "oauth");
  }
  const profileResponse = await fetch(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${json.access_token}` },
  });
  const profile = await profileResponse.json().catch(() => ({})) as { id?: string; displayName?: string; mail?: string; userPrincipalName?: string };
  const email = String(profile.mail || profile.userPrincipalName || "").trim().toLowerCase();
  if (!profileResponse.ok || !email) throw new OutlookError(400, "Microsoft account has no mailbox address", "oauth");
  await saveAccount({
    userId,
    email,
    microsoftId: profile.id || "",
    displayName: profile.displayName || email,
    accessTokenEnc: encryptSecret(json.access_token),
    refreshTokenEnc: encryptSecret(json.refresh_token),
    expiresAt: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000),
    scopes: "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite",
  });
  return email;
}

export async function graphJson<T>(userId: number, path: string, init: RequestInit = {}): Promise<T> {
  const run = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
    return fetch(url, { ...init, headers });
  };
  let response = await run(await getAccessToken(userId));
  if (response.status === 401) response = await run(await getAccessToken(userId, true));
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    let message = `Outlook request failed (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      if (parsed.error?.message) message = parsed.error.message.slice(0, 300);
      if (response.status === 410 || parsed.error?.code === "SyncStateNotFound") {
        throw new OutlookError(410, message, "resync");
      }
    } catch (err) {
      if (err instanceof OutlookError) throw err;
    }
    throw new OutlookError(response.status === 401 ? 401 : 502, message, response.status === 401 ? "reconnect" : "graph");
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

type DeltaPage = { value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

async function pullMailDelta(userId: number, folder: "inbox" | "sent", cursor: string | null, pageBudget: { left: number }) {
  const initial = folder === "inbox"
    ? "/me/mailFolders/inbox/messages/delta?$top=25"
    : "/me/mailFolders/sentitems/messages/delta?$top=25";
  let url: string | null = cursor || initial;
  let guard = cursor;
  let upserted = 0;
  const candidates: Array<{ email: string; name: string; receivedAt: string | null }> = [];
  while (url && pageBudget.left > 0) {
    pageBudget.left -= 1;
    let page: DeltaPage;
    try {
      page = await graphJson<DeltaPage>(userId, url, { headers: { Prefer: "odata.maxpagesize=25" } });
    } catch (err) {
      if (err instanceof OutlookError && err.status === 410 && guard) {
        guard = null;
        url = initial;
        continue;
      }
      throw err;
    }
    for (const item of page.value || []) {
      const stored = messageFromGraph(item, folder);
      if (!stored) continue;
      await upsertSyncedMessage(userId, stored);
      if (!stored.removed) {
        upserted += 1;
        if (folder === "inbox" && stored.fromEmail) candidates.push({ email: stored.fromEmail, name: stored.fromName, receivedAt: stored.receivedAt });
      }
    }
    if (page["@odata.deltaLink"]) {
      url = null;
      await saveCursor(userId, folder, page["@odata.deltaLink"]);
    } else if (page["@odata.nextLink"]) {
      url = page["@odata.nextLink"];
      await saveCursor(userId, folder, page["@odata.nextLink"]);
    } else {
      url = null;
    }
  }
  return { upserted, candidates };
}

async function pullCalendar(userId: number) {
  const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const end = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    $orderby: "start/dateTime",
    $top: "50",
    $select: "id,subject,bodyPreview,start,end,location,organizer,attendees,isAllDay,webLink,isCancelled",
  });
  let url: string | null = `/me/calendarView?${params.toString()}`;
  const keep: string[] = [];
  let pages = 0;
  let upserted = 0;
  type CalendarPage = { value?: GraphEvent[]; "@odata.nextLink"?: string };
  while (url && pages < 5) {
    pages += 1;
    const page: CalendarPage = await graphJson<CalendarPage>(userId, url, {
      headers: { Prefer: 'outlook.timezone="UTC"' },
    });
    for (const item of page.value || []) {
      const stored = eventFromGraph(item);
      if (!stored) continue;
      await upsertSyncedEvent(userId, stored);
      keep.push(stored.graphId);
      upserted += 1;
    }
    url = page["@odata.nextLink"] || null;
  }
  await pruneEvents(userId, start.toISOString(), end.toISOString(), keep);
  return upserted;
}

async function createPeople(userId: number, accountEmail: string, candidates: Array<{ email: string; name: string; receivedAt: string | null }>) {
  const owner = await userName(userId);
  const seen = new Set<string>();
  let created = 0;
  for (const candidate of candidates) {
    if (created >= 20) break;
    const email = candidate.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (candidate.receivedAt) {
      const age = Date.now() - new Date(candidate.receivedAt).getTime();
      if (Number.isFinite(age) && age > 14 * 24 * 60 * 60 * 1000) continue;
    }
    const exists = await emailExists(email);
    if (!shouldAutoCreateSender({ enabled: true, sender: email, selfEmail: accountEmail, alreadyExists: exists })) continue;
    await transaction(client => upsert(client, {
      name: displayNameFromEmail(email, candidate.name),
      email,
      status: "New",
      lead_source: "Outlook",
      owner,
      client_type: "new lead",
      deal_value: 0,
      expert_field: "Law Firms",
      notes: "Added from an Outlook inbox sender because auto-create is on.",
    }));
    created += 1;
  }
  return created;
}

export async function syncOutlookUser(userId: number): Promise<SyncResult> {
  const existing = syncing.get(userId);
  if (existing) return existing;
  const pending = runSync(userId).finally(() => syncing.delete(userId));
  syncing.set(userId, pending);
  return pending;
}

async function runSync(userId: number): Promise<SyncResult> {
  const account = await getAccount(userId);
  if (!account) throw new OutlookError(409, "Connect Outlook first", "not_connected");
  const pages = { left: 8 };
  const inbox = await pullMailDelta(userId, "inbox", account.inboxCursor, pages);
  const fresh = await getAccount(userId);
  const sent = await pullMailDelta(userId, "sent", fresh?.sentCursor ?? account.sentCursor, pages);
  const events = await pullCalendar(userId);
  const peopleCreated = account.autoCreatePeople ? await createPeople(userId, account.email, inbox.candidates) : 0;
  await saveSyncStatus(userId, "");
  return { inbox: inbox.upserted, sent: sent.upserted, events, peopleCreated };
}

export async function syncAllOutlookAccounts() {
  const accounts = await listAccounts();
  const results: Array<{ userId: number; error?: string } & Partial<SyncResult>> = [];
  for (const account of accounts) {
    try {
      results.push({ userId: account.userId, ...(await syncOutlookUser(account.userId)) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sync failed";
      await saveSyncStatus(account.userId, message).catch(() => undefined);
      results.push({ userId: account.userId, error: message });
    }
  }
  return results;
}

export function publicMessage(message: GraphMessage) {
  const to = (message.toRecipients || []).map(item => item.emailAddress?.address || "").filter(Boolean);
  const cc = (message.ccRecipients || []).map(item => item.emailAddress?.address || "").filter(Boolean);
  return {
    id: message.id,
    conversationId: message.conversationId || "",
    subject: message.subject || "(no subject)",
    preview: message.bodyPreview || "",
    from: message.from?.emailAddress?.address || "",
    fromName: message.from?.emailAddress?.name || "",
    to,
    cc,
    receivedAt: message.receivedDateTime || message.sentDateTime || null,
    hasAttachments: !!message.hasAttachments,
    isRead: !!message.isRead,
    webLink: message.webLink || "",
  };
}

export function publicEvent(event: GraphEvent) {
  const attendees = (event.attendees || []).map(item => ({
    email: item.emailAddress?.address || "",
    name: item.emailAddress?.name || "",
  })).filter(item => item.email);
  return {
    id: event.id,
    subject: event.subject || "(no title)",
    preview: event.bodyPreview || "",
    location: event.location?.displayName || "",
    start: graphDateToIso(event.start),
    end: graphDateToIso(event.end),
    organizer: event.organizer?.emailAddress?.address || "",
    attendees,
    isAllDay: !!event.isAllDay,
    webLink: event.webLink || "",
  };
}

export async function listFolderMessages(userId: number, folder: "inbox" | "sent") {
  const name = folder === "sent" ? "sentitems" : "inbox";
  const order = folder === "sent" ? "sentDateTime desc" : "receivedDateTime desc";
  const params = new URLSearchParams({
    $top: "40",
    $orderby: order,
    $select: "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,webLink",
  });
  const page = await graphJson<{ value?: GraphMessage[] }>(userId, `/me/mailFolders/${name}/messages?${params.toString()}`);
  return (page.value || []).map(publicMessage);
}

export async function readMessage(userId: number, id: string) {
  const select = "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,webLink";
  const message = await graphJson<GraphMessage>(userId, `/me/messages/${encodeURIComponent(id)}?$select=${select}`);
  const conversationId = message.conversationId || "";
  let thread: ReturnType<typeof publicMessage>[] = [];
  if (conversationId) {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
      $top: "30",
      $select: "id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead",
    });
    const page = await graphJson<{ value?: GraphMessage[] }>(userId, `/me/messages?${params.toString()}`);
    thread = (page.value || []).map(publicMessage);
  }
  return {
    message: {
      ...publicMessage(message),
      body: message.body?.content || "",
      bodyType: message.body?.contentType || "text",
      bcc: (message.bccRecipients || []).map(item => item.emailAddress?.address || "").filter(Boolean),
    },
    thread,
  };
}

export async function listAttachments(userId: number, id: string) {
  const page = await graphJson<{ value?: Array<{ id?: string; name?: string; contentType?: string; size?: number; isInline?: boolean }> }>(
    userId,
    `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline`,
  );
  return (page.value || []).filter(item => !item.isInline).map(item => ({
    id: item.id,
    name: item.name || "attachment",
    contentType: item.contentType || "application/octet-stream",
    size: item.size || 0,
  }));
}

export async function downloadAttachment(userId: number, messageId: string, attachmentId: string) {
  const item = await graphJson<{ name?: string; contentType?: string; contentBytes?: string }>(
    userId,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (!item.contentBytes) throw new OutlookError(404, "Attachment has no file content");
  return {
    name: item.name || "attachment",
    contentType: item.contentType || "application/octet-stream",
    bytes: Buffer.from(item.contentBytes, "base64"),
  };
}

export async function folderCounts(userId: number) {
  const [inbox, sent] = await Promise.all([
    graphJson<{ totalItemCount?: number; unreadItemCount?: number }>(userId, "/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount"),
    graphJson<{ totalItemCount?: number }>(userId, "/me/mailFolders/sentitems?$select=totalItemCount"),
  ]);
  return { inbox: inbox.totalItemCount || 0, unread: inbox.unreadItemCount || 0, sent: sent.totalItemCount || 0 };
}

export async function listEvents(userId: number, start: string, end: string, timeZone: string) {
  const params = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
    $orderby: "start/dateTime",
    $top: "100",
    $select: "id,subject,bodyPreview,start,end,location,organizer,attendees,isAllDay,webLink,isCancelled",
  });
  const page = await graphJson<{ value?: GraphEvent[] }>(userId, `/me/calendarView?${params.toString()}`, {
    headers: { Prefer: `outlook.timezone="${timeZone}"` },
  });
  return (page.value || []).filter(event => !event.isCancelled).map(publicEvent);
}

export async function saveEvent(userId: number, input: {
  id?: string;
  subject: string;
  body: string;
  start: string;
  end: string;
  timeZone: string;
  location: string;
  attendees: string[];
  notify: boolean;
}) {
  const payload: Record<string, unknown> = {
    subject: input.subject.slice(0, 300) || "(no title)",
    body: { contentType: "Text", content: input.body.slice(0, 8000) },
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
    location: { displayName: input.location.slice(0, 300) },
  };
  if (input.notify) {
    payload.attendees = input.attendees.map(address => ({ emailAddress: { address }, type: "required" }));
  }
  const path = input.id ? `/me/events/${encodeURIComponent(input.id)}` : "/me/events";
  const event = await graphJson<GraphEvent>(userId, path, { method: input.id ? "PATCH" : "POST", body: JSON.stringify(payload) });
  if (event?.id) return publicEvent(event);
  if (input.id) {
    const fresh = await graphJson<GraphEvent>(userId, `/me/events/${encodeURIComponent(input.id)}`);
    return publicEvent(fresh);
  }
  throw new OutlookError(502, "Outlook did not return the event");
}

export async function searchMessages(userId: number, emails: string[]) {
  const safe = emails.map(email => email.replace(/["\\]/g, "")).filter(email => email.includes("@")).slice(0, 3);
  if (!safe.length) return [];
  const query = safe.map(email => `from:${email} OR to:${email}`).join(" OR ");
  const params = new URLSearchParams({
    $search: `"${query}"`,
    $top: "25",
    $select: "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,webLink",
  });
  const page = await graphJson<{ value?: GraphMessage[] }>(userId, `/me/messages?${params.toString()}`, {
    headers: { ConsistencyLevel: "eventual" },
  });
  return (page.value || []).map(publicMessage);
}
