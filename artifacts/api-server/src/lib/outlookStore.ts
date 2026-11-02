import { pool } from "@workspace/db";
import { ensureCrmTablesAndDefaults } from "./crmData";
import { logger } from "./logger";
import type { StoredEvent, StoredMessage } from "./outlookLogic";

export type OutlookAccount = {
  userId: number;
  email: string;
  microsoftId: string;
  displayName: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: Date;
  scopes: string;
  autoCreatePeople: boolean;
  inboxCursor: string | null;
  sentCursor: string | null;
  lastSyncAt: string | null;
  lastSyncError: string;
};

let schemaReady: Promise<void> | null = null;

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1 || value === "1";
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function exec(sql: string, params: unknown[] = []) {
  return pool.query(sql, params);
}

export function ensureOutlookSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = createOutlookSchema().catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function createOutlookSchema() {
  try {
    await ensureCrmTablesAndDefaults({ query: pool.query.bind(pool) });
  } catch (err) {
    logger.warn({ message: err instanceof Error ? err.message : "ensure failed" }, "outlook continued without crm table ensure");
  }
  const statements = [
    `CREATE TABLE IF NOT EXISTS crm_outlook_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      email TEXT NOT NULL,
      microsoft_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      scopes TEXT NOT NULL DEFAULT '',
      auto_create_people BOOLEAN NOT NULL DEFAULT FALSE,
      inbox_cursor TEXT,
      sent_cursor TEXT,
      last_sync_at TIMESTAMPTZ,
      last_sync_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS crm_outlook_oauth_states (
      state TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS crm_outlook_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      graph_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      participants TEXT NOT NULL DEFAULT '',
      received_at TIMESTAMPTZ,
      has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      web_link TEXT NOT NULL DEFAULT '',
      UNIQUE (user_id, graph_id)
    )`,
    `CREATE INDEX IF NOT EXISTS crm_outlook_messages_user_idx ON crm_outlook_messages (user_id, received_at)`,
    `CREATE TABLE IF NOT EXISTS crm_outlook_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      graph_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      organizer_email TEXT NOT NULL DEFAULT '',
      attendees TEXT NOT NULL DEFAULT '',
      is_all_day BOOLEAN NOT NULL DEFAULT FALSE,
      web_link TEXT NOT NULL DEFAULT '',
      UNIQUE (user_id, graph_id)
    )`,
    `CREATE INDEX IF NOT EXISTS crm_outlook_events_user_idx ON crm_outlook_events (user_id, start_at)`,
    `CREATE TABLE IF NOT EXISTS crm_email_templates (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS crm_email_drafts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      to_addresses TEXT NOT NULL DEFAULT '',
      cc_addresses TEXT NOT NULL DEFAULT '',
      bcc_addresses TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      investor_id INTEGER,
      reply_message_id TEXT NOT NULL DEFAULT '',
      forward_message_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];
  for (const sql of statements) await exec(sql);
}

function mapAccount(row: Record<string, unknown>): OutlookAccount {
  return {
    userId: Number(row.user_id),
    email: String(row.email || ""),
    microsoftId: String(row.microsoft_id || ""),
    displayName: String(row.display_name || ""),
    accessTokenEnc: String(row.access_token_enc || ""),
    refreshTokenEnc: String(row.refresh_token_enc || ""),
    expiresAt: new Date(String(row.expires_at)),
    scopes: String(row.scopes || ""),
    autoCreatePeople: flag(row.auto_create_people),
    inboxCursor: row.inbox_cursor ? String(row.inbox_cursor) : null,
    sentCursor: row.sent_cursor ? String(row.sent_cursor) : null,
    lastSyncAt: iso(row.last_sync_at),
    lastSyncError: String(row.last_sync_error || ""),
  };
}

export async function getAccount(userId: number): Promise<OutlookAccount | null> {
  await ensureOutlookSchema();
  const result = await exec("SELECT * FROM crm_outlook_accounts WHERE user_id=$1", [userId]);
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

export async function listAccounts(): Promise<OutlookAccount[]> {
  await ensureOutlookSchema();
  const result = await exec("SELECT * FROM crm_outlook_accounts ORDER BY user_id");
  return result.rows.map(mapAccount);
}

export async function saveAccount(input: {
  userId: number;
  email: string;
  microsoftId: string;
  displayName: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: Date;
  scopes: string;
}) {
  await ensureOutlookSchema();
  await exec(
    `INSERT INTO crm_outlook_accounts
      (user_id, email, microsoft_id, display_name, access_token_enc, refresh_token_enc, expires_at, scopes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
      email=EXCLUDED.email,
      microsoft_id=EXCLUDED.microsoft_id,
      display_name=EXCLUDED.display_name,
      access_token_enc=EXCLUDED.access_token_enc,
      refresh_token_enc=EXCLUDED.refresh_token_enc,
      expires_at=EXCLUDED.expires_at,
      scopes=EXCLUDED.scopes,
      inbox_cursor=NULL,
      sent_cursor=NULL,
      last_sync_error='',
      updated_at=NOW()`,
    [input.userId, input.email, input.microsoftId, input.displayName, input.accessTokenEnc, input.refreshTokenEnc, input.expiresAt.toISOString(), input.scopes],
  );
}

export async function saveTokens(userId: number, accessTokenEnc: string, refreshTokenEnc: string, expiresAt: Date) {
  await exec(
    "UPDATE crm_outlook_accounts SET access_token_enc=$2, refresh_token_enc=$3, expires_at=$4, updated_at=NOW() WHERE user_id=$1",
    [userId, accessTokenEnc, refreshTokenEnc, expiresAt.toISOString()],
  );
}

export async function setAutoCreate(userId: number, enabled: boolean) {
  await ensureOutlookSchema();
  await exec("UPDATE crm_outlook_accounts SET auto_create_people=$2, updated_at=NOW() WHERE user_id=$1", [userId, enabled]);
}

export async function saveCursor(userId: number, folder: "inbox" | "sent", cursor: string | null) {
  const column = folder === "inbox" ? "inbox_cursor" : "sent_cursor";
  await exec(`UPDATE crm_outlook_accounts SET ${column}=$2, updated_at=NOW() WHERE user_id=$1`, [userId, cursor]);
}

export async function saveSyncStatus(userId: number, error: string) {
  await exec("UPDATE crm_outlook_accounts SET last_sync_at=NOW(), last_sync_error=$2, updated_at=NOW() WHERE user_id=$1", [userId, error.slice(0, 500)]);
}

export async function deleteAccount(userId: number) {
  await ensureOutlookSchema();
  await exec("DELETE FROM crm_outlook_messages WHERE user_id=$1", [userId]);
  await exec("DELETE FROM crm_outlook_events WHERE user_id=$1", [userId]);
  await exec("DELETE FROM crm_outlook_oauth_states WHERE user_id=$1", [userId]);
  await exec("DELETE FROM crm_outlook_accounts WHERE user_id=$1", [userId]);
}

export async function putOAuthState(state: string, userId: number, verifier: string) {
  await ensureOutlookSchema();
  await exec("DELETE FROM crm_outlook_oauth_states WHERE expires_at < NOW()");
  await exec(
    "INSERT INTO crm_outlook_oauth_states(state, user_id, code_verifier, expires_at) VALUES($1,$2,$3,NOW() + INTERVAL '10 minutes')",
    [state, userId, verifier],
  );
}

export async function takeOAuthState(state: string): Promise<{ userId: number; verifier: string } | null> {
  await ensureOutlookSchema();
  const result = await exec("SELECT user_id, code_verifier FROM crm_outlook_oauth_states WHERE state=$1 AND expires_at >= NOW()", [state]);
  const row = result.rows[0];
  if (!row) return null;
  await exec("DELETE FROM crm_outlook_oauth_states WHERE state=$1", [state]);
  return { userId: Number(row.user_id), verifier: String(row.code_verifier) };
}

export async function upsertSyncedMessage(userId: number, message: StoredMessage) {
  if (message.removed) {
    await exec("DELETE FROM crm_outlook_messages WHERE user_id=$1 AND graph_id=$2", [userId, message.graphId]);
    return;
  }
  await exec(
    `INSERT INTO crm_outlook_messages
      (user_id, graph_id, conversation_id, folder, subject, preview, from_email, from_name, participants, received_at, has_attachments, is_read, web_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, graph_id) DO UPDATE SET
      conversation_id=EXCLUDED.conversation_id,
      folder=EXCLUDED.folder,
      subject=EXCLUDED.subject,
      preview=EXCLUDED.preview,
      from_email=EXCLUDED.from_email,
      from_name=EXCLUDED.from_name,
      participants=EXCLUDED.participants,
      received_at=EXCLUDED.received_at,
      has_attachments=EXCLUDED.has_attachments,
      is_read=EXCLUDED.is_read,
      web_link=EXCLUDED.web_link`,
    [
      userId,
      message.graphId,
      message.conversationId,
      message.folder,
      message.subject,
      message.preview,
      message.fromEmail,
      message.fromName,
      message.participants,
      message.receivedAt,
      message.hasAttachments,
      message.isRead,
      message.webLink,
    ],
  );
}

export async function upsertSyncedEvent(userId: number, event: StoredEvent) {
  await exec(
    `INSERT INTO crm_outlook_events
      (user_id, graph_id, subject, preview, location, start_at, end_at, organizer_email, attendees, is_all_day, web_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id, graph_id) DO UPDATE SET
      subject=EXCLUDED.subject,
      preview=EXCLUDED.preview,
      location=EXCLUDED.location,
      start_at=EXCLUDED.start_at,
      end_at=EXCLUDED.end_at,
      organizer_email=EXCLUDED.organizer_email,
      attendees=EXCLUDED.attendees,
      is_all_day=EXCLUDED.is_all_day,
      web_link=EXCLUDED.web_link`,
    [userId, event.graphId, event.subject, event.preview, event.location, event.startAt, event.endAt, event.organizerEmail, event.attendees, event.isAllDay, event.webLink],
  );
}

export async function pruneEvents(userId: number, startIso: string, endIso: string, keepIds: string[]) {
  if (!keepIds.length) {
    await exec("DELETE FROM crm_outlook_events WHERE user_id=$1 AND start_at >= $2 AND start_at < $3", [userId, startIso, endIso]);
    return;
  }
  const placeholders = keepIds.map((_, index) => `$${index + 4}`).join(",");
  await exec(
    `DELETE FROM crm_outlook_events WHERE user_id=$1 AND start_at >= $2 AND start_at < $3 AND graph_id NOT IN (${placeholders})`,
    [userId, startIso, endIso, ...keepIds],
  );
}

export async function messagesForEmails(userId: number, emails: string[]) {
  if (!emails.length) return [];
  const clauses = emails.map((_, index) => `strpos(participants, $${index + 2}) > 0`);
  const result = await exec(
    `SELECT graph_id, conversation_id, folder, subject, preview, from_email, from_name, participants, received_at, has_attachments, is_read, web_link
     FROM crm_outlook_messages WHERE user_id=$1 AND (${clauses.join(" OR ")})
     ORDER BY received_at DESC NULLS LAST LIMIT 40`,
    [userId, ...emails.map(email => `,${email},`)],
  );
  return result.rows;
}

export async function eventsForEmails(userId: number, emails: string[], fromIso: string) {
  if (!emails.length) return [];
  const clauses = emails.map((_, index) => `strpos(attendees, $${index + 3}) > 0`);
  const result = await exec(
    `SELECT graph_id, subject, preview, location, start_at, end_at, organizer_email, attendees, is_all_day, web_link
     FROM crm_outlook_events WHERE user_id=$1 AND start_at >= $2 AND (${clauses.join(" OR ")})
     ORDER BY start_at ASC LIMIT 20`,
    [userId, fromIso, ...emails.map(email => `,${email},`)],
  );
  return result.rows;
}

export async function investorContext(investorId: number): Promise<{ email: string; firm: string; name: string; emails: string[] } | null> {
  const row = await exec("SELECT data FROM crm_investors WHERE id=$1", [investorId]);
  if (!row.rows[0]) return null;
  const data = row.rows[0].data || {};
  const email = String(data.email || "").trim().toLowerCase();
  const firm = String(data.firm || "").trim();
  const emails = new Set<string>();
  if (email) emails.add(email);
  if (firm) {
    const siblings = await exec(
      "SELECT lower(trim(coalesce(data->>'email',''))) AS email FROM crm_investors WHERE lower(trim(coalesce(data->>'firm','')))=$1 AND trim(coalesce(data->>'email','')) <> '' LIMIT 15",
      [firm.toLowerCase()],
    );
    for (const sibling of siblings.rows) if (sibling.email) emails.add(String(sibling.email));
  }
  return { email, firm, name: String(data.name || ""), emails: [...emails] };
}

export async function emailExists(email: string): Promise<boolean> {
  const result = await exec("SELECT 1 FROM crm_investors WHERE email_key=$1 LIMIT 1", [email]);
  return !!result.rows[0];
}

export async function userName(userId: number): Promise<string> {
  const result = await exec("SELECT name FROM crm_users WHERE id=$1", [userId]);
  return String(result.rows[0]?.name || "Guy");
}

export type DraftRow = {
  id: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: unknown[];
  investorId: number | null;
  replyMessageId: string;
  forwardMessageId: string;
  status: string;
  error: string;
  updatedAt: string | null;
};

function mapDraft(row: Record<string, unknown>): DraftRow {
  let attachments = row.attachments;
  if (typeof attachments === "string") {
    try { attachments = JSON.parse(attachments); } catch { attachments = []; }
  }
  return {
    id: Number(row.id),
    to: String(row.to_addresses || ""),
    cc: String(row.cc_addresses || ""),
    bcc: String(row.bcc_addresses || ""),
    subject: String(row.subject || ""),
    body: String(row.body_html || ""),
    attachments: Array.isArray(attachments) ? attachments : [],
    investorId: row.investor_id == null ? null : Number(row.investor_id),
    replyMessageId: String(row.reply_message_id || ""),
    forwardMessageId: String(row.forward_message_id || ""),
    status: String(row.status || "draft"),
    error: String(row.error || ""),
    updatedAt: iso(row.updated_at),
  };
}

export async function listDrafts(userId: number, status: "draft" | "outbox") {
  await ensureOutlookSchema();
  const result = await exec(
    "SELECT * FROM crm_email_drafts WHERE user_id=$1 AND status=$2 ORDER BY updated_at DESC LIMIT 100",
    [userId, status],
  );
  return result.rows.map(mapDraft);
}

export async function getDraft(userId: number, id: number): Promise<DraftRow | null> {
  await ensureOutlookSchema();
  const result = await exec("SELECT * FROM crm_email_drafts WHERE user_id=$1 AND id=$2", [userId, id]);
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

export async function saveDraft(userId: number, input: {
  id?: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: unknown[];
  investorId: number | null;
  replyMessageId: string;
  forwardMessageId: string;
  status?: string;
  error?: string;
}) {
  await ensureOutlookSchema();
  const attachments = JSON.stringify(input.attachments || []);
  if (input.id) {
    const result = await exec(
      `UPDATE crm_email_drafts SET to_addresses=$3, cc_addresses=$4, bcc_addresses=$5, subject=$6, body_html=$7,
        attachments=$8::jsonb, investor_id=$9, reply_message_id=$10, forward_message_id=$11, status=$12, error=$13, updated_at=NOW()
       WHERE user_id=$1 AND id=$2 RETURNING id`,
      [userId, input.id, input.to, input.cc, input.bcc, input.subject, input.body, attachments, input.investorId, input.replyMessageId, input.forwardMessageId, input.status || "draft", input.error || ""],
    );
    if (!result.rows[0]) return null;
    return getDraft(userId, input.id);
  }
  const result = await exec(
    `INSERT INTO crm_email_drafts
      (user_id, to_addresses, cc_addresses, bcc_addresses, subject, body_html, attachments, investor_id, reply_message_id, forward_message_id, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) RETURNING id`,
    [userId, input.to, input.cc, input.bcc, input.subject, input.body, attachments, input.investorId, input.replyMessageId, input.forwardMessageId, input.status || "draft", input.error || ""],
  );
  return getDraft(userId, Number(result.rows[0].id));
}

export async function markDraft(userId: number, id: number, status: "draft" | "outbox", error: string) {
  await exec("UPDATE crm_email_drafts SET status=$3, error=$4, updated_at=NOW() WHERE user_id=$1 AND id=$2", [userId, id, status, error.slice(0, 500)]);
}

export async function deleteDraft(userId: number, id: number) {
  await ensureOutlookSchema();
  await exec("DELETE FROM crm_email_drafts WHERE user_id=$1 AND id=$2", [userId, id]);
}

export async function listTemplates(userId: number) {
  await ensureOutlookSchema();
  const result = await exec("SELECT id, name, subject, body_html, updated_at FROM crm_email_templates WHERE user_id=$1 ORDER BY updated_at DESC", [userId]);
  return result.rows.map(row => ({
    id: Number(row.id),
    name: String(row.name),
    subject: String(row.subject || ""),
    body: String(row.body_html || ""),
    updatedAt: iso(row.updated_at),
  }));
}

export async function saveTemplate(userId: number, input: { id?: number; name: string; subject: string; body: string }) {
  await ensureOutlookSchema();
  if (input.id) {
    const result = await exec(
      "UPDATE crm_email_templates SET name=$3, subject=$4, body_html=$5, updated_at=NOW() WHERE user_id=$1 AND id=$2 RETURNING id, name, subject, body_html, updated_at",
      [userId, input.id, input.name, input.subject, input.body],
    );
    return result.rows[0] ? { id: Number(result.rows[0].id), name: String(result.rows[0].name), subject: String(result.rows[0].subject), body: String(result.rows[0].body_html), updatedAt: iso(result.rows[0].updated_at) } : null;
  }
  const result = await exec(
    "INSERT INTO crm_email_templates(user_id, name, subject, body_html) VALUES($1,$2,$3,$4) RETURNING id, name, subject, body_html, updated_at",
    [userId, input.name, input.subject, input.body],
  );
  const row = result.rows[0];
  return { id: Number(row.id), name: String(row.name), subject: String(row.subject), body: String(row.body_html), updatedAt: iso(row.updated_at) };
}

export async function deleteTemplate(userId: number, id: number) {
  await ensureOutlookSchema();
  await exec("DELETE FROM crm_email_templates WHERE user_id=$1 AND id=$2", [userId, id]);
}

export async function localCounts(userId: number) {
  await ensureOutlookSchema();
  const drafts = await exec("SELECT count(*)::int AS n FROM crm_email_drafts WHERE user_id=$1 AND status='draft'", [userId]);
  const outbox = await exec("SELECT count(*)::int AS n FROM crm_email_drafts WHERE user_id=$1 AND status='outbox'", [userId]);
  const templates = await exec("SELECT count(*)::int AS n FROM crm_email_templates WHERE user_id=$1", [userId]);
  return {
    drafts: Number(drafts.rows[0]?.n || 0),
    outbox: Number(outbox.rows[0]?.n || 0),
    templates: Number(templates.rows[0]?.n || 0),
  };
}
