import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { outlookFetch } from "@/lib/outlook";

type TimelineMessage = {
  id: string;
  subject: string;
  preview: string;
  from: string;
  fromName: string;
  receivedAt: string | null;
  webLink?: string;
};

type Meeting = {
  id: string;
  subject: string;
  start: string | null;
  end: string | null;
  location?: string;
  organizer?: string;
  webLink?: string;
};

export function OutlookRecord({
  investorId,
  email,
  onCompose,
}: {
  investorId: number;
  email: string;
  onCompose: (address: string, id: number) => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [firm, setFirm] = useState("");
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    outlookFetch<{ connected: boolean; firm: string; messages: TimelineMessage[]; meetings: Meeting[] }>(`/api/integrations/outlook/records/${investorId}`)
      .then(data => {
        if (cancelled) return;
        setConnected(data.connected);
        setFirm(data.firm || "");
        setMessages(data.messages || []);
        setMeetings(data.meetings || []);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load Outlook activity");
      });
    return () => {
      cancelled = true;
    };
  }, [investorId]);

  return (
    <section className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base font-bold text-slate-900">Outlook email and meetings</h3>
        <button
          type="button"
          disabled={!email}
          onClick={() => onCompose(email, investorId)}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Mail className="h-3.5 w-3.5" /> Compose email
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {email ? `Messages to and from ${email}` : "Add an email on this record to match mail."}
        {firm ? ` Also includes other people at ${firm}.` : ""} Nothing sends until you click Send.
      </p>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {connected === false && <p className="mt-3 text-sm text-slate-500">Connect Outlook in Settings to see this record&apos;s mail and meetings.</p>}

      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Email</div>
        {messages.length === 0 ? (
          <p className="mt-2 rounded-md border border-dashed p-3 text-center text-sm text-slate-500">No matching email yet.</p>
        ) : (
          <ol className="mt-2 space-y-2">
            {messages.slice(0, 12).map(message => (
              <li key={message.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900">{message.subject || "(no subject)"}</span>
                  <span className="shrink-0 text-[11px] text-slate-500">{message.receivedAt ? new Date(message.receivedAt).toLocaleString() : ""}</span>
                </div>
                <div className="text-xs text-slate-500">{message.fromName || message.from}</div>
                <p className="mt-1 text-slate-700">{message.preview}</p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Upcoming meetings</div>
        {meetings.length === 0 ? (
          <p className="mt-2 rounded-md border border-dashed p-3 text-center text-sm text-slate-500">No upcoming meetings include this contact.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {meetings.map(meeting => (
              <li key={meeting.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-semibold text-slate-900">{meeting.subject}</div>
                <div className="text-xs text-slate-500">
                  {meeting.start ? new Date(meeting.start).toLocaleString() : ""}
                  {meeting.location ? ` · ${meeting.location}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
