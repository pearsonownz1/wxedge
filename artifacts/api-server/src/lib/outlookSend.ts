import { graphJson } from "./outlookGraph";
import {
  OutlookError,
  buildSendMailBody,
  cleanAttachments,
  parseAddressList,
  toHtmlBody,
  type OutboundAttachment,
} from "./outlookLogic";

export type SendInput = {
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  attachments?: unknown;
};

async function deleteDraft(userId: number, draftId: string) {
  await graphJson(userId, `/me/messages/${encodeURIComponent(draftId)}`, { method: "DELETE" }).catch(() => undefined);
}

async function attachFiles(userId: number, draftId: string, files: OutboundAttachment[]) {
  for (const file of files) {
    await graphJson(userId, `/me/messages/${encodeURIComponent(draftId)}/attachments`, {
      method: "POST",
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: file.name,
        contentType: file.contentType,
        contentBytes: file.contentBytes,
      }),
    });
  }
}

export async function sendNewMail(userId: number, input: SendInput) {
  const to = parseAddressList(input.to || "");
  const cc = parseAddressList(input.cc || "");
  const bcc = parseAddressList(input.bcc || "");
  const html = toHtmlBody(input.body || "");
  if (!html) throw new OutlookError(400, "Write a message before sending");
  const attachments = cleanAttachments(input.attachments);
  const payload = buildSendMailBody({ to, cc, bcc, subject: input.subject || "", html, attachments });
  await graphJson(userId, "/me/sendMail", { method: "POST", body: JSON.stringify(payload) });
  return { to, subject: input.subject || "" };
}

export async function replyToMessage(userId: number, messageId: string, input: SendInput) {
  const html = toHtmlBody(input.body || "");
  if (!html) throw new OutlookError(400, "Write a reply before sending");
  const attachments = cleanAttachments(input.attachments);
  const draft = await graphJson<{ id?: string }>(userId, `/me/messages/${encodeURIComponent(messageId)}/createReply`, {
    method: "POST",
    body: "{}",
  });
  if (!draft?.id) throw new OutlookError(502, "Outlook did not create the reply");
  try {
    await graphJson(userId, `/me/messages/${encodeURIComponent(draft.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ body: { contentType: "HTML", content: html } }),
    });
    await attachFiles(userId, draft.id, attachments);
    await graphJson(userId, `/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
  } catch (err) {
    await deleteDraft(userId, draft.id);
    throw err;
  }
}

export async function forwardMessage(userId: number, messageId: string, input: SendInput) {
  const to = parseAddressList(input.to || "");
  const html = toHtmlBody(input.body || "");
  if (!html) throw new OutlookError(400, "Write a note before forwarding");
  const attachments = cleanAttachments(input.attachments);
  const draft = await graphJson<{ id?: string }>(userId, `/me/messages/${encodeURIComponent(messageId)}/createForward`, {
    method: "POST",
    body: "{}",
  });
  if (!draft?.id) throw new OutlookError(502, "Outlook did not create the forward");
  try {
    await graphJson(userId, `/me/messages/${encodeURIComponent(draft.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        body: { contentType: "HTML", content: html },
        toRecipients: to.map(address => ({ emailAddress: { address } })),
      }),
    });
    await attachFiles(userId, draft.id, attachments);
    await graphJson(userId, `/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
  } catch (err) {
    await deleteDraft(userId, draft.id);
    throw err;
  }
  return { to };
}
