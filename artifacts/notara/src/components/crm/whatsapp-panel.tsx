import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { Investor } from '@workspace/api-client-react';
import { fmtTs } from '@/lib/crm';

const sel = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none';

export function WhatsAppPanel({
  rows,
  messages,
  waCardId,
  setWaCardId,
  waPhone,
  setWaPhone,
  workspaceOwner,
  onSendSuccess,
  toast,
}: {
  rows: Investor[];
  messages: any[];
  waCardId: number | '';
  setWaCardId: (v: number | '') => void;
  waPhone: string;
  setWaPhone: (v: string) => void;
  workspaceOwner: string;
  onSendSuccess: () => void;
  toast: any;
}) {
  const [waText, setWaText] = useState('');
  const [waBusy, setWaBusy] = useState(false);

  const sendWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = waText.trim();
    if (!body) return;
    const rawPhone = waPhone.trim() || '+15619031414';
    const digits = rawPhone.replace(/\D/g, '');
    const cleanPhone = digits.length === 10 ? `1${digits}` : digits;
    if (typeof window !== 'undefined' && cleanPhone) {
      window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(body)}`, '_blank', 'noopener,noreferrer');
    }
    setWaBusy(true);
    try {
      const r = await fetch('/api/crm/whatsapp/send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: waCardId || undefined,
          phone: rawPhone,
          body,
          sender: workspaceOwner === 'All' ? 'Guy' : workspaceOwner,
        }),
      });
      if (!r.ok) throw new Error('WhatsApp send failed');
      setWaText('');
      onSendSuccess();
      toast({ title: 'WhatsApp opened & message logged to deal timeline' });
    } catch {
      toast({ title: 'Could not log WhatsApp message', variant: 'destructive' });
    } finally {
      setWaBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <form onSubmit={sendWhatsApp} className="rounded-xl border bg-white p-5 shadow-xs">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900">WhatsApp CRM Messenger</h2>
            <p className="text-xs text-slate-500">Opens WhatsApp live &amp; auto-logs onto the contact&apos;s deal timeline</p>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Select Contact / Deal</label>
            <select
              value={waCardId}
              onChange={(e) => {
                const cid = e.target.value ? Number(e.target.value) : '';
                setWaCardId(cid);
                const found = rows.find((r) => r.id === cid);
                if (found && (found as any).phone) setWaPhone((found as any).phone);
              }}
              className={`${sel} w-full`}
            >
              <option value="">-- Select contact --</option>
              {rows.slice(0, 120).map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.firm || r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">WhatsApp Number</label>
            <input
              value={waPhone}
              onChange={(e) => setWaPhone(e.target.value)}
              placeholder="+14078021717"
              className={`${sel} w-full font-mono-ui`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Message</label>
            <textarea
              required
              rows={4}
              value={waText}
              onChange={(e) => setWaText(e.target.value)}
              placeholder="Hi! Following up on our EB-2 NIW expert opinion letter proposal..."
              className={`${sel} w-full`}
            />
          </div>
          <button
            disabled={waBusy}
            className="w-full rounded-lg bg-teal-600 py-2.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {waBusy ? 'Sending...' : 'Send WhatsApp & Log Activity'}
          </button>
        </div>
      </form>

      <div className="rounded-xl border bg-white p-5 shadow-xs">
        <h2 className="mb-3 font-display text-lg font-bold text-slate-900">WhatsApp Conversation Feed</h2>
        {messages.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-slate-500">
            No WhatsApp messages logged yet. Send a message on the left to start a thread.
          </div>
        ) : (
          <div className="space-y-2.5">
            {messages.map((w: any) => (
              <div key={w.id} className="rounded-lg border border-teal-200/70 bg-teal-50/30 p-3 text-xs">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span className="font-bold text-teal-900">{w.firm || w.contact_name || w.phone} ({w.sender})</span>
                  <span>{fmtTs(w.created_at)}</span>
                </div>
                <p className="mt-1 text-slate-800">{w.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
