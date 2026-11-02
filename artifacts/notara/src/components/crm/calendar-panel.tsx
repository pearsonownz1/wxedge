import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { outlookFetch, OutlookApiError, type OutlookEvent } from "@/lib/outlook";

type Mode = "week" | "day" | "agenda";
const field = "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-600 focus:outline-none";
const ghost = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50";
const primary = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50";

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date) {
  const next = startOfDay(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Editor = {
  id?: string;
  subject: string;
  body: string;
  start: string;
  end: string;
  location: string;
  attendees: string;
  notify: boolean;
};

export function CalendarPanel() {
  const [mode, setMode] = useState<Mode>("week");
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState<OutlookEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const range = useMemo(() => {
    if (mode === "day") {
      const start = startOfDay(cursor);
      return { start, end: addDays(start, 1), days: [start] };
    }
    if (mode === "agenda") {
      const start = startOfDay(cursor);
      return { start, end: addDays(start, 14), days: [] as Date[] };
    }
    const start = startOfWeek(cursor);
    return { start, end: addDays(start, 7), days: Array.from({ length: 7 }, (_, index) => addDays(start, index)) };
  }, [cursor, mode]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ start: range.start.toISOString(), end: range.end.toISOString(), timeZone: zone });
      const data = await outlookFetch<{ events: OutlookEvent[] }>(`/api/integrations/outlook/events?${params.toString()}`);
      setEvents(data.events);
      setConnected(true);
    } catch (err) {
      if (err instanceof OutlookApiError && err.code === "not_connected") setConnected(false);
      else setError(err instanceof Error ? err.message : "Could not load the calendar");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [range.start.getTime(), range.end.getTime()]);

  const onDay = (day: Date) => events.filter(event => {
    if (!event.start) return false;
    const start = new Date(event.start);
    return start >= day && start < addDays(day, 1);
  });

  const openNew = () => {
    const start = new Date(cursor);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start);
    end.setHours(9, 30, 0, 0);
    setEditor({ subject: "", body: "", start: localInput(start), end: localInput(end), location: "", attendees: "", notify: false });
  };

  const openEvent = (event: OutlookEvent) => {
    setEditor({
      id: event.id,
      subject: event.subject,
      body: event.preview || "",
      start: event.start ? localInput(new Date(event.start)) : "",
      end: event.end ? localInput(new Date(event.end)) : "",
      location: event.location || "",
      attendees: (event.attendees || []).map(item => item.email).join(", "),
      notify: false,
    });
  };

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError("");
    try {
      await outlookFetch("/api/integrations/outlook/events", {
        method: editor.id ? "PATCH" : "POST",
        body: JSON.stringify({ ...editor, timeZone: zone }),
      });
      setEditor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the event");
    } finally {
      setBusy(false);
    }
  };

  const shift = mode === "day" ? 1 : mode === "agenda" ? 14 : 7;

  return (
    <div className="rounded-xl border bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <button className={ghost} onClick={() => setCursor(date => addDays(date, -shift))}><ChevronLeft className="h-4 w-4" /></button>
          <button className={ghost} onClick={() => setCursor(new Date())}>Today</button>
          <button className={ghost} onClick={() => setCursor(date => addDays(date, shift))}><ChevronRight className="h-4 w-4" /></button>
          <h1 className="font-display text-lg font-bold">{range.start.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</h1>
        </div>
        <div className="flex items-center gap-2">
          {(["week", "day", "agenda"] as Mode[]).map(item => (
            <button key={item} onClick={() => setMode(item)} className={`rounded-md px-3 py-1.5 text-sm font-semibold capitalize ${mode === item ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-50"}`}>{item}</button>
          ))}
          <button className={primary} onClick={openNew}>New event</button>
        </div>
      </div>
      {error && <div className="border-b bg-red-50 px-4 py-2 text-sm text-red-800">{error}</div>}
      {!connected && <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-900">Connect Outlook in Settings to see and edit your calendar.</div>}
      {loading ? (
        <div className="p-10 text-center text-sm text-slate-500">Loading calendar...</div>
      ) : mode === "agenda" ? (
        <div className="divide-y">
          {events.length === 0 && <p className="p-10 text-center text-sm text-slate-500">No events in the next two weeks.</p>}
          {events.map(event => (
            <button key={event.id} onClick={() => openEvent(event)} className="block w-full px-4 py-3 text-left hover:bg-slate-50">
              <div className="text-sm font-semibold">{event.subject}</div>
              <div className="text-xs text-slate-500">{event.start ? new Date(event.start).toLocaleString() : ""}{event.location ? ` · ${event.location}` : ""}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className={`grid ${mode === "day" ? "grid-cols-1" : "grid-cols-7"} min-h-[32rem]`}>
          {range.days.map(day => (
            <div key={day.toISOString()} className="border-r p-2 last:border-r-0">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</div>
              <div className="space-y-1">
                {onDay(day).map(event => (
                  <button key={event.id} onClick={() => openEvent(event)} className="block w-full rounded-md bg-blue-50 px-2 py-1 text-left text-xs text-blue-900 hover:bg-blue-100">
                    <div className="font-semibold">{event.start ? new Date(event.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}</div>
                    <div className="truncate">{event.subject}</div>
                  </button>
                ))}
                {onDay(day).length === 0 && <p className="text-[11px] text-slate-400">No events</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {editor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="font-display text-lg font-bold">{editor.id ? "Edit event" : "New event"}</h2>
            <div className="mt-3 space-y-2">
              <input className={field} placeholder="Title" value={editor.subject} onChange={event => setEditor({ ...editor, subject: event.target.value })} />
              <div className="grid gap-2 sm:grid-cols-2">
                <input className={field} type="datetime-local" value={editor.start} onChange={event => setEditor({ ...editor, start: event.target.value })} />
                <input className={field} type="datetime-local" value={editor.end} onChange={event => setEditor({ ...editor, end: event.target.value })} />
              </div>
              <input className={field} placeholder="Location" value={editor.location} onChange={event => setEditor({ ...editor, location: event.target.value })} />
              <textarea className={field} rows={4} placeholder="Notes" value={editor.body} onChange={event => setEditor({ ...editor, body: event.target.value })} />
              <input className={field} placeholder="Guest emails, comma separated" value={editor.attendees} onChange={event => setEditor({ ...editor, attendees: event.target.value })} />
              <label className="flex items-start gap-2 text-sm text-slate-600">
                <input type="checkbox" className="mt-1" checked={editor.notify} onChange={event => setEditor({ ...editor, notify: event.target.checked })} />
                <span>Send calendar invitations to guests. Leave this off and no invitation email is sent. Saving a time change can still update guests who were already invited.</span>
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className={ghost} onClick={() => setEditor(null)}>Cancel</button>
              <button className={primary} disabled={busy} onClick={save}>{busy ? "Saving..." : editor.notify ? "Save and send invitations" : "Save event"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
