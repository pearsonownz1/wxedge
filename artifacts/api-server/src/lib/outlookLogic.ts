import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"] as const;

export const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const DEFAULT_REDIRECT = "https://crm.gcs.org/api/integrations/outlook/callback";

export class OutlookError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function outlookRedirectUri(): string {
  const value = process.env.MS_OUTLOOK_REDIRECT_URI?.trim();
  return value || DEFAULT_REDIRECT;
}

export function outlookConfigError(): string | null {
  if (!process.env.MS_OUTLOOK_CLIENT_ID?.trim()) return "MS_OUTLOOK_CLIENT_ID is not set";
  if (!process.env.MS_OUTLOOK_CLIENT_SECRET?.trim()) return "MS_OUTLOOK_CLIENT_SECRET is not set";
  if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) return "TOKEN_ENCRYPTION_KEY is not set";
  try {
    parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    return err instanceof Error ? err.message : "TOKEN_ENCRYPTION_KEY is invalid";
  }
  return null;
}

export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")) return decoded;
  throw new OutlookError(500, "TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex", "config");
}

export function encryptSecret(plain: string, key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || "")): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(payload: string, key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || "")): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new OutlookError(500, "Stored Outlook token could not be read", "config");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const data = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: process.env.MS_OUTLOOK_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: outlookRedirectUri(),
    response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function tokenRequestBody(fields: Record<string, string>): string {
  return new URLSearchParams({
    client_id: process.env.MS_OUTLOOK_CLIENT_ID || "",
    client_secret: process.env.MS_OUTLOOK_CLIENT_SECRET || "",
    scope: OUTLOOK_SCOPES.join(" "),
    ...fields,
  }).toString();
}

export function cronAuthorized(header: string | undefined, secret = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 16) return false;
  const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseAddressList(value: string, limit = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,;\n]/)) {
    const email = part.trim().toLowerCase().replace(/^mailto:/, "");
    if (!email) continue;
    if (!EMAIL_RE.test(email) || email.length > 320) {
      throw new OutlookError(400, `Invalid email address: ${email.slice(0, 80)}`);
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length > limit) throw new OutlookError(400, `Too many recipients (max ${limit})`);
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toHtmlBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return trimmed.slice(0, 200_000);
  return escapeHtml(trimmed).replace(/\n/g, "<br>");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function participantBlob(emails: Array<string | null | undefined>): string {
  const unique = [...new Set(emails.map(e => (e || "").trim().toLowerCase()).filter(e => EMAIL_RE.test(e)))];
  return unique.length ? `,${unique.join(",")},` : "";
}

export function blobHas(blob: string, email: string): boolean {
  const needle = `,${email.trim().toLowerCase()},`;
  return needle.length > 2 && blob.toLowerCase().includes(needle);
}

const NOISY_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?|bounces?|newsletter|automated)$/i;

export function isNoisySender(email: string): boolean {
  const local = email.trim().toLowerCase().split("@")[0] || "";
  return !local || NOISY_LOCAL.test(local) || local.startsWith("noreply") || local.startsWith("no-reply");
}

export function shouldAutoCreateSender(input: {
  enabled: boolean;
  sender: string;
  selfEmail: string;
  alreadyExists: boolean;
}): boolean {
  const sender = input.sender.trim().toLowerCase();
  if (!input.enabled || input.alreadyExists) return false;
  if (!EMAIL_RE.test(sender) || isNoisySender(sender)) return false;
  if (sender === input.selfEmail.trim().toLowerCase()) return false;
  return true;
}

export type GraphEmail = { emailAddress?: { address?: string; name?: string } };

export function addressOf(value: GraphEmail | undefined): string {
  return (value?.emailAddress?.address || "").trim().toLowerCase();
}

export function nameOf(value: GraphEmail | undefined): string {
  return (value?.emailAddress?.name || "").trim();
}

export type GraphMessage = {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphEmail;
  toRecipients?: GraphEmail[];
  ccRecipients?: GraphEmail[];
  bccRecipients?: GraphEmail[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  isRead?: boolean;
  webLink?: string;
  "@removed"?: { reason?: string };
};

export type StoredMessage = {
  graphId: string;
  conversationId: string;
  folder: "inbox" | "sent";
  subject: string;
  preview: string;
  fromEmail: string;
  fromName: string;
  participants: string;
  receivedAt: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  webLink: string;
  removed: boolean;
};

export function messageFromGraph(message: GraphMessage, folder: "inbox" | "sent"): StoredMessage | null {
  const graphId = message.id || "";
  if (!graphId) return null;
  if (message["@removed"]) {
    return {
      graphId,
      conversationId: "",
      folder,
      subject: "",
      preview: "",
      fromEmail: "",
      fromName: "",
      participants: "",
      receivedAt: null,
      hasAttachments: false,
      isRead: false,
      webLink: "",
      removed: true,
    };
  }
  const to = (message.toRecipients || []).map(addressOf);
  const cc = (message.ccRecipients || []).map(addressOf);
  const fromEmail = addressOf(message.from);
  return {
    graphId,
    conversationId: message.conversationId || "",
    folder,
    subject: (message.subject || "").slice(0, 500),
    preview: (message.bodyPreview || "").slice(0, 500),
    fromEmail,
    fromName: nameOf(message.from).slice(0, 200),
    participants: participantBlob([fromEmail, ...to, ...cc]),
    receivedAt: message.receivedDateTime || message.sentDateTime || null,
    hasAttachments: !!message.hasAttachments,
    isRead: !!message.isRead,
    webLink: message.webLink || "",
    removed: false,
  };
}

export type GraphEvent = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: GraphEmail;
  attendees?: Array<GraphEmail & { type?: string }>;
  isAllDay?: boolean;
  isCancelled?: boolean;
  webLink?: string;
};

export type StoredEvent = {
  graphId: string;
  subject: string;
  preview: string;
  location: string;
  startAt: string | null;
  endAt: string | null;
  organizerEmail: string;
  attendees: string;
  isAllDay: boolean;
  webLink: string;
};

export function graphDateToIso(value: { dateTime?: string; timeZone?: string } | undefined): string | null {
  const raw = value?.dateTime?.trim();
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const zone = (value?.timeZone || "UTC").toUpperCase();
  const date = new Date(zone === "UTC" ? `${raw.replace(/\.\d+$/, "")}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function eventFromGraph(event: GraphEvent): StoredEvent | null {
  if (!event.id || event.isCancelled) return null;
  const attendees = (event.attendees || []).map(addressOf);
  const organizer = addressOf(event.organizer);
  return {
    graphId: event.id,
    subject: (event.subject || "").slice(0, 500),
    preview: (event.bodyPreview || "").slice(0, 500),
    location: (event.location?.displayName || "").slice(0, 300),
    startAt: graphDateToIso(event.start),
    endAt: graphDateToIso(event.end),
    organizerEmail: organizer,
    attendees: participantBlob([organizer, ...attendees]),
    isAllDay: !!event.isAllDay,
    webLink: event.webLink || "",
  };
}

export function eventIncludes(attendeesBlob: string, emails: string[]): boolean {
  return emails.some(email => blobHas(attendeesBlob, email));
}

export type OutboundAttachment = { name: string; contentType: string; contentBytes: string };

export function cleanAttachment(input: { name?: string; contentType?: string; contentBytes?: string }): OutboundAttachment {
  const name = (input.name || "attachment").replace(/[/\\]/g, "").replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) || "attachment";
  const contentType = (input.contentType || "application/octet-stream").split(";")[0].trim().slice(0, 120) || "application/octet-stream";
  const raw = (input.contentBytes || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new OutlookError(400, `Attachment ${name} is not valid base64`);
  }
  const bytes = Buffer.from(raw, "base64").length;
  if (bytes > 3 * 1024 * 1024) throw new OutlookError(413, `Attachment ${name} is larger than 3 MB`);
  return { name, contentType, contentBytes: raw };
}

export function cleanAttachments(list: unknown): OutboundAttachment[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new OutlookError(400, "Attachments must be a list");
  if (list.length > 3) throw new OutlookError(400, "Attach up to 3 files");
  const files = list.map(item => cleanAttachment((item || {}) as { name?: string; contentType?: string; contentBytes?: string }));
  const total = files.reduce((sum, file) => sum + Buffer.from(file.contentBytes, "base64").length, 0);
  if (total > 3 * 1024 * 1024) throw new OutlookError(413, "Attachments must total 3 MB or less");
  return files;
}

export function buildSendMailBody(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  attachments?: OutboundAttachment[];
}) {
  if (!input.to.length) throw new OutlookError(400, "Add at least one recipient");
  return {
    message: {
      subject: input.subject.slice(0, 500),
      body: { contentType: "HTML", content: input.html },
      toRecipients: input.to.map(address => ({ emailAddress: { address } })),
      ccRecipients: (input.cc || []).map(address => ({ emailAddress: { address } })),
      bccRecipients: (input.bcc || []).map(address => ({ emailAddress: { address } })),
      attachments: (input.attachments || []).map(file => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: file.name,
        contentType: file.contentType,
        contentBytes: file.contentBytes,
      })),
    },
    saveToSentItems: true,
  };
}

export function safeFileName(name: string): string {
  return name.replace(/[/\\"]/g, "").slice(0, 180) || "attachment";
}

export function displayNameFromEmail(email: string, name?: string): string {
  const trimmed = (name || "").trim();
  if (trimmed && !trimmed.includes("@")) return trimmed.slice(0, 120);
  const local = email.split("@")[0] || email;
  return local.replace(/[._-]+/g, " ").replace(/\b\w/g, char => char.toUpperCase()).slice(0, 120);
}
