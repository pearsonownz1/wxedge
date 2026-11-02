import { useEffect, useState } from "react";
import { Mail, Paperclip, Send, Trash2 } from "lucide-react";
import {
  fileToAttachment,
  outlookFetch,
  OutlookApiError,
  type ComposeSeed,
  type MailDraft,
  type MailListItem,
  type MailMessage,
  type MailTemplate,
} from "@/lib/outlook";

type Tab = "inbox" | "sent" | "drafts" | "outbox" | "templates";
type ComposeState = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: Array<{ name: string; contentType: string; contentBytes: string }>;
  investorId?: number;
  replyId?: string;
  forwardId?: string;
  draftId?: number;
};

const emptyCompose = (): ComposeState => ({ to: "", cc: "", bcc: "", subject: "", body: "", attachments: [] });
const field = "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-600 focus:outline-none";
const primary = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50";
const ghost = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";

const EMPTY: Record<Tab, { title: string; body: string }> = {
  inbox: { title: "Inbox is empty", body: "Messages from Outlook will show up here." },
  sent: { title: "No sent mail yet", body: "Mail you send from SellingHighs appears in Outlook Sent." },
  drafts: { title: "No email drafts yet", body: "Save a message here. It stays in the CRM until you click Send." },
  outbox: { title: "Outbox is clear", body: "Mail is sent only when you click Send. Failed sends wait here for another click." },
  templates: { title: "No templates yet", body: "Save a message you send often. Using a template never sends it." },
};

function htmlToText(html: string) {
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
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function EmailsPanel({ composeSeed }: { composeSeed: ComposeSeed }) {
  const [tab, setTab] = useState<Tab>("inbox");
  const [counts, setCounts] = useState({ inbox: 0, sent: 0, drafts: 0, outbox: 0, templates: 0, unread: 0, connected: false });
  const [messages, setMessages] = useState<MailListItem[]>([]);
  const [openMessage, setOpenMessage] = useState<{ message: MailMessage; thread: MailListItem[] } | null>(null);
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; contentType: string; size: number }>>([]);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [showCc, setShowCc] = useState(false);
  const [formatted, setFormatted] = useState(false);
  const [templateEditor, setTemplateEditor] = useState<MailTemplate | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");

  const loadCounts = async () => {
    try {
      const data = await outlookFetch<typeof counts>("/api/integrations/outlook/counts");
      setCounts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load mail");
    }
  };

  const loadTab = async (next = tab) => {
    setLoading(true);
    setError("");
    setOpenMessage(null);
    try {
      if (next === "inbox" || next === "sent") {
        const data = await outlookFetch<{ messages: MailListItem[] }>(`/api/integrations/outlook/messages?folder=${next}`);
        setMessages(data.messages);
      } else if (next === "drafts" || next === "outbox") {
        const data = await outlookFetch<{ drafts: MailDraft[] }>(`/api/integrations/outlook/drafts?status=${next === "outbox" ? "outbox" : "draft"}`);
        setDrafts(data.drafts);
      } else {
        const data = await outlookFetch<{ templates: MailTemplate[] }>("/api/integrations/outlook/templates");
        setTemplates(data.templates);
      }
    } catch (err) {
      if (err instanceof OutlookApiError && err.code === "not_connected") setMessages([]);
      else setError(err instanceof Error ? err.message : "Could not load this folder");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCounts();
  }, []);

  useEffect(() => {
    void loadTab(tab);
  }, [tab]);

  useEffect(() => {
    if (!composeSeed) return;
    setCompose({ ...emptyCompose(), to: composeSeed.to, investorId: composeSeed.investorId });
    setShowCc(false);
  }, [composeSeed?.nonce]);

  const open = async (item: MailListItem) => {
    setBusy("open");
    setFormatted(false);
    try {
      const data = await outlookFetch<{ message: MailMessage; thread: MailListItem[] }>(`/api/integrations/outlook/message?id=${encodeURIComponent(item.id)}`);
      setOpenMessage(data);
      const files = await outlookFetch<{ attachments: Array<{ id: string; name: string; contentType: string; size: number }> }>(`/api/integrations/outlook/attachments?id=${encodeURIComponent(item.id)}`);
      setAttachments(files.attachments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the message");
    } finally {
      setBusy("");
    }
  };

  const download = async (messageId: string, file: { id: string; name: string }) => {
    const response = await fetch(`/api/integrations/outlook/attachment?messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(file.id)}`, { credentials: "include" });
    if (!response.ok) {
      setError("Could not download the attachment");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  const sendCompose = async () => {
    if (!compose) return;
    setBusy("send");
    setError("");
    try {
      const payload = { ...compose, investorId: compose.investorId };
      if (compose.replyId) await outlookFetch("/api/integrations/outlook/reply", { method: "POST", body: JSON.stringify({ ...payload, id: compose.replyId }) });
      else if (compose.forwardId) await outlookFetch("/api/integrations/outlook/forward", { method: "POST", body: JSON.stringify({ ...payload, id: compose.forwardId }) });
      else await outlookFetch("/api/integrations/outlook/send", { method: "POST", body: JSON.stringify(payload) });
      if (compose.draftId) await outlookFetch(`/api/integrations/outlook/drafts/${compose.draftId}`, { method: "DELETE" });
      setCompose(null);
      await loadCounts();
      await loadTab();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy("");
    }
  };

  const saveDraft = async () => {
    if (!compose) return;
    setBusy("draft");
    try {
      const path = compose.draftId ? `/api/integrations/outlook/drafts/${compose.draftId}` : "/api/integrations/outlook/drafts";
      await outlookFetch(path, { method: compose.draftId ? "PATCH" : "POST", body: JSON.stringify(compose) });
      setCompose(null);
      setTab("drafts");
      await loadCounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the draft");
    } finally {
      setBusy("");
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!compose || !list) return;
    try {
      const next = [...compose.attachments];
      for (const file of Array.from(list)) {
        if (next.length >= 3) break;
        next.push(await fileToAttachment(file));
      }
      setCompose({ ...compose, attachments: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach the file");
    }
  };

  const useTemplate = (template: MailTemplate) => {
    setCompose({ ...emptyCompose(), subject: template.subject, body: template.body });
  };

  const editDraft = async (id: number) => {
    const data = await outlookFetch<{ draft: MailDraft }>(`/api/integrations/outlook/drafts/${id}`);
    const draft = data.draft;
    setCompose({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      attachments: (draft.attachments || []).filter(file => file.contentBytes && file.name).map(file => ({
        name: file.name || "attachment",
        contentType: file.contentType || "application/octet-stream",
        contentBytes: file.contentBytes || "",
      })),
      investorId: draft.investorId || undefined,
      replyId: draft.replyMessageId || undefined,
      forwardId: draft.forwardMessageId || undefined,
      draftId: draft.id,
    });
    setShowCc(!!(draft.cc || draft.bcc));
  };

  const sendStored = async (id: number) => {
    setBusy(`send-${id}`);
    setError("");
    try {
      await outlookFetch(`/api/integrations/outlook/drafts/${id}/send`, { method: "POST" });
      await loadCounts();
      await loadTab();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
      await loadTab();
    } finally {
      setBusy("");
    }
  };

  const removeDraft = async (id: number) => {
    await outlookFetch(`/api/integrations/outlook/drafts/${id}`, { method: "DELETE" });
    await loadCounts();
    await loadTab();
  };

  const saveTemplate = async () => {
    if (!templateEditor?.name.trim()) return;
    setBusy("template");
    try {
      const path = templateEditor.id ? `/api/integrations/outlook/templates/${templateEditor.id}` : "/api/integrations/outlook/templates";
      await outlookFetch(path, {
        method: templateEditor.id ? "PATCH" : "POST",
        body: JSON.stringify({ name: templateEditor.name, subject: templateEditor.subject, body: templateEditor.body }),
      });
      setTemplateEditor(null);
      await loadCounts();
      await loadTab("templates");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the template");
    } finally {
      setBusy("");
    }
  };

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: "inbox", label: "Inbox", count: counts.inbox },
    { id: "sent", label: "Sent", count: counts.sent },
    { id: "drafts", label: "Drafts", count: counts.drafts },
    { id: "outbox", label: "Outbox", count: counts.outbox },
    { id: "templates", label: "Templates", count: counts.templates },
  ];

  const listEmpty = tab === "inbox" || tab === "sent" ? messages.length === 0 : tab === "templates" ? templates.length === 0 : drafts.length === 0;

  return (
    <div className="flex min-h-[70vh] flex-col rounded-xl border bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {tabs.map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab === item.id ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50"}`}
            >
              {item.label}
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600">{item.count}</span>
            </button>
          ))}
        </div>
        <button className={primary} onClick={() => { setCompose(emptyCompose()); setShowCc(false); }}>Compose email</button>
      </div>

      {error && <div className="border-b bg-red-50 px-4 py-2 text-sm text-red-800">{error}</div>}
      {!counts.connected && tab !== "drafts" && tab !== "templates" && tab !== "outbox" && (
        <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-900">Connect Outlook in Settings to read and send mail.</div>
      )}

      <div className="flex min-h-0 flex-1">
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-500">Loading...</div>
        ) : listEmpty && !openMessage ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
            <div className="mb-4 flex h-24 w-24 items-center justify-center rounded-2xl border border-dashed border-slate-300 text-slate-400">
              <Mail className="h-10 w-10" />
            </div>
            <h2 className="font-display text-xl font-bold text-slate-900">{EMPTY[tab].title}</h2>
            <p className="mt-2 max-w-md text-sm text-slate-500">{EMPTY[tab].body}</p>
            <button className={`${primary} mt-4`} onClick={() => setCompose(emptyCompose())}>Compose email</button>
          </div>
        ) : (
          <div className="grid min-h-[32rem] flex-1 md:grid-cols-[320px_1fr]">
            <div className="border-r">
              {(tab === "inbox" || tab === "sent") && messages.map(item => (
                <button key={item.id} onClick={() => open(item)} className="block w-full border-b px-4 py-3 text-left hover:bg-slate-50">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${item.isRead ? "text-slate-700" : "font-semibold text-slate-900"}`}>{item.fromName || item.from || "Unknown"}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{item.receivedAt ? new Date(item.receivedAt).toLocaleDateString() : ""}</span>
                  </div>
                  <div className="truncate text-sm text-slate-800">{item.subject}</div>
                  <div className="truncate text-xs text-slate-500">{item.preview}</div>
                </button>
              ))}
              {(tab === "drafts" || tab === "outbox") && drafts.map(draft => (
                <div key={draft.id} className="border-b px-4 py-3">
                  <button className="block w-full text-left" onClick={() => editDraft(draft.id)}>
                    <div className="truncate text-sm font-semibold">{draft.subject || "(no subject)"}</div>
                    <div className="truncate text-xs text-slate-500">{draft.to || "No recipient"}</div>
                    {draft.error && <div className="mt-1 text-xs text-red-700">{draft.error}</div>}
                  </button>
                  <div className="mt-2 flex gap-2">
                    <button className={primary} disabled={busy === `send-${draft.id}`} onClick={() => sendStored(draft.id)}>Send</button>
                    <button className={ghost} onClick={() => removeDraft(draft.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              ))}
              {tab === "templates" && (
                <div className="p-3">
                  <button className={`${ghost} mb-3 w-full`} onClick={() => setTemplateEditor({ id: 0, name: "", subject: "", body: "", updatedAt: null })}>New template</button>
                  {templates.map(template => (
                    <div key={template.id} className="mb-2 rounded-md border p-3">
                      <div className="text-sm font-semibold">{template.name}</div>
                      <div className="truncate text-xs text-slate-500">{template.subject}</div>
                      <div className="mt-2 flex gap-2">
                        <button className={ghost} onClick={() => useTemplate(template)}>Use</button>
                        <button className={ghost} onClick={() => setTemplateEditor(template)}>Edit</button>
                        <button className={ghost} onClick={async () => { await outlookFetch(`/api/integrations/outlook/templates/${template.id}`, { method: "DELETE" }); await loadCounts(); await loadTab(); }}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-5">
              {openMessage ? (
                <article>
                  <h2 className="font-display text-xl font-bold">{openMessage.message.subject}</h2>
                  <p className="mt-1 text-sm text-slate-500">{openMessage.message.fromName || openMessage.message.from} · {openMessage.message.receivedAt ? new Date(openMessage.message.receivedAt).toLocaleString() : ""}</p>
                  <p className="text-xs text-slate-400">To {openMessage.message.to.join(", ") || "—"}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className={ghost} onClick={() => setCompose({ ...emptyCompose(), to: openMessage.message.from, subject: openMessage.message.subject.startsWith("Re:") ? openMessage.message.subject : `Re: ${openMessage.message.subject}`, replyId: openMessage.message.id, body: "" })}>Reply</button>
                    <button className={ghost} onClick={() => setCompose({ ...emptyCompose(), subject: openMessage.message.subject.startsWith("Fwd:") ? openMessage.message.subject : `Fwd: ${openMessage.message.subject}`, forwardId: openMessage.message.id, body: htmlToText(openMessage.message.body) })}>Forward</button>
                    <button className={ghost} onClick={() => setFormatted(value => !value)}>{formatted ? "Show text" : "Show formatted"}</button>
                  </div>
                  {attachments.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {attachments.map(file => (
                        <button key={file.id} className={ghost} onClick={() => download(openMessage.message.id, file)}>
                          <span className="inline-flex items-center gap-1"><Paperclip className="h-3.5 w-3.5" /> {file.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {formatted ? (
                    <iframe title="Email body" sandbox="" srcDoc={openMessage.message.body} className="mt-4 h-96 w-full rounded-md border bg-white" />
                  ) : (
                    <pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-6 text-slate-800">{htmlToText(openMessage.message.body) || openMessage.message.preview}</pre>
                  )}
                  {openMessage.thread.length > 1 && (
                    <div className="mt-6 space-y-2 border-t pt-4">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Thread</div>
                      {openMessage.thread.map(item => (
                        <button key={item.id} onClick={() => open(item)} className="block w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-slate-50">
                          <span className="font-medium">{item.fromName || item.from}</span>
                          <span className="mt-0.5 block text-slate-500">{item.preview}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">{busy === "open" ? "Opening..." : "Select a message"}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {compose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-bold">{compose.replyId ? "Reply" : compose.forwardId ? "Forward" : "Compose email"}</h2>
              <button className={ghost} onClick={() => setCompose(null)}>Close</button>
            </div>
            <div className="space-y-2">
              <input className={field} placeholder="To" value={compose.to} onChange={event => setCompose({ ...compose, to: event.target.value })} />
              <button className="text-xs font-semibold text-blue-700" onClick={() => setShowCc(value => !value)}>{showCc ? "Hide Cc/Bcc" : "Cc/Bcc"}</button>
              {showCc && (
                <>
                  <input className={field} placeholder="Cc" value={compose.cc} onChange={event => setCompose({ ...compose, cc: event.target.value })} />
                  <input className={field} placeholder="Bcc" value={compose.bcc} onChange={event => setCompose({ ...compose, bcc: event.target.value })} />
                </>
              )}
              <input className={field} placeholder="Subject" value={compose.subject} onChange={event => setCompose({ ...compose, subject: event.target.value })} />
              <textarea className={field} rows={10} placeholder="Write your message. It sends only when you click Send." value={compose.body} onChange={event => setCompose({ ...compose, body: event.target.value })} />
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <label className={`${ghost} cursor-pointer`}>
                  Attach
                  <input type="file" multiple className="hidden" onChange={event => { void addFiles(event.target.files); event.target.value = ""; }} />
                </label>
                {compose.attachments.map(file => <span key={file.name}>{file.name}</span>)}
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className={ghost} disabled={busy === "draft"} onClick={saveDraft}>Save draft</button>
              <button className={primary} disabled={busy === "send"} onClick={sendCompose}>
                <span className="inline-flex items-center gap-1"><Send className="h-3.5 w-3.5" /> {busy === "send" ? "Sending..." : "Send"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {templateEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="font-display text-lg font-bold">{templateEditor.id ? "Edit template" : "New template"}</h2>
            <div className="mt-3 space-y-2">
              <input className={field} placeholder="Name" value={templateEditor.name} onChange={event => setTemplateEditor({ ...templateEditor, name: event.target.value })} />
              <input className={field} placeholder="Subject" value={templateEditor.subject} onChange={event => setTemplateEditor({ ...templateEditor, subject: event.target.value })} />
              <textarea className={field} rows={8} placeholder="Body" value={templateEditor.body} onChange={event => setTemplateEditor({ ...templateEditor, body: event.target.value })} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className={ghost} onClick={() => setTemplateEditor(null)}>Cancel</button>
              <button className={primary} disabled={busy === "template"} onClick={saveTemplate}>Save template</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
