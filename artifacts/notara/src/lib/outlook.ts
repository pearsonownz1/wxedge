export class OutlookApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function outlookFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = data as { error?: string; code?: string };
    throw new OutlookApiError(body.error || `Request failed (${response.status})`, response.status, body.code);
  }
  return data as T;
}

export type OutlookAccountStatus = {
  configured: boolean;
  configError: string | null;
  connected: boolean;
  email: string;
  displayName: string;
  autoCreatePeople: boolean;
  lastSyncAt: string | null;
  lastSyncError: string;
};

export type MailListItem = {
  id: string;
  conversationId: string;
  subject: string;
  preview: string;
  from: string;
  fromName: string;
  to: string[];
  cc?: string[];
  receivedAt: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  webLink: string;
};

export type MailMessage = MailListItem & { body: string; bodyType: string; bcc?: string[] };

export type MailDraft = {
  id: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  investorId: number | null;
  replyMessageId: string;
  forwardMessageId: string;
  status: string;
  error: string;
  updatedAt: string | null;
  attachments: Array<{ name?: string; contentType?: string; contentBytes?: string }>;
};

export type MailTemplate = { id: number; name: string; subject: string; body: string; updatedAt: string | null };

export type OutlookEvent = {
  id: string;
  subject: string;
  preview: string;
  location: string;
  start: string | null;
  end: string | null;
  organizer: string;
  attendees?: Array<{ email: string; name: string }>;
  isAllDay: boolean;
  webLink: string;
};

export type ComposeSeed = { to: string; investorId?: number; nonce: number } | null;

export async function fileToAttachment(file: File): Promise<{ name: string; contentType: string; contentBytes: string }> {
  if (file.size > 3 * 1024 * 1024) throw new Error(`${file.name} is larger than 3 MB`);
  const dataUrl = await file.arrayBuffer();
  const bytes = new Uint8Array(dataUrl);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { name: file.name, contentType: file.type || "application/octet-stream", contentBytes: btoa(binary) };
}
