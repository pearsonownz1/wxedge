import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useBrowserGetInvestor,
  useBrowserUpsertInvestor,
  useBrowserUpdateInvestor,
  getBrowserGetInvestorQueryKey,
  type InvestorInput,
} from '@workspace/api-client-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useToast } from '@/hooks/use-toast';
import { Copy, Trash2, PhoneCall, MessageSquare, Send } from 'lucide-react';
import {
  STATUSES,
  CLIENT_TYPES,
  FIELDS,
  EXPERT_FIELDS,
  expertFieldOf,
  type ExpertField,
  fmtTs,
} from '@/lib/crm';

type F = Record<string, string>;
const empty = (expertField: ExpertField = 'Law Firms', defaultOwner = 'Guy'): F => ({
  ...Object.fromEntries(FIELDS.map((k) => [k, ''])),
  status: 'New',
  fit_score: '3',
  expert_field: expertField,
  lead_source: 'Outbound',
  deal_value: '2500',
  expected_close_date: '',
  owner: defaultOwner,
  client_type: 'new lead',
  phone: '',
});

const LONG = ['pitch_body', 'notes'];
const DATES = ['last_contacted_date', 'next_follow_up_date', 'expected_close_date'];
const lbl = (k: string) => {
  if (k === 'expert_field') return 'MARKET / REGION';
  if (k === 'client_type') return 'type (lead / client)';
  if (k === 'deal_value') return 'deal value ($ USD)';
  return k.replace(/_/g, ' ');
};
const inp = 'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

export function InvestorSheet({
  id,
  open,
  onClose,
  defaultExpertField = 'Law Firms',
  teamOwners = ['Guy', 'Eduardo', 'Growth'],
  onDialContact,
  onOpenWhatsApp,
}: {
  id: number | 'new' | null;
  open: boolean;
  onClose: () => void;
  defaultExpertField?: ExpertField;
  teamOwners?: string[];
  onDialContact?: (cardId: number, phone: string, firm: string) => void;
  onOpenWhatsApp?: (cardId: number, phone: string, firm: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isNew = id === 'new';
  const numId = typeof id === 'number' ? id : 0;
  const { data, isLoading, isError, refetch } = useBrowserGetInvestor(numId, {
    query: { enabled: !!numId && open, queryKey: getBrowserGetInvestorQueryKey(numId) },
  });
  const [f, setF] = useState<F>(() => empty(defaultExpertField));
  const [msg, setMsg] = useState('');
  const [eventType, setEventType] = useState<'note' | 'email_sent' | 'reply_received' | 'proposal_sent' | 'call_logged' | 'whatsapp_sent'>('note');
  const [campaignTag, setCampaignTag] = useState('law-firms-niw-q4');
  const [deleting, setDeleting] = useState(false);
  const [loggingAct, setLoggingAct] = useState(false);
  const dirty = useRef(false);

  useEffect(() => {
    dirty.current = false;
    setMsg('');
  }, [numId, open]);

  const create = useBrowserUpsertInvestor();
  const update = useBrowserUpdateInvestor();

  useEffect(() => {
    if (isNew && open) setF(empty(defaultExpertField));
  }, [isNew, open, defaultExpertField]);

  useEffect(() => {
    if (!dirty.current && data && data.id === numId) {
      setF(
        Object.fromEntries(
          FIELDS.map((k) => [
            k,
            k === 'expert_field'
              ? expertFieldOf(data)
              : k === 'deal_value'
                ? String((data as any).deal_value ?? 2500)
                : k === 'client_type'
                  ? String((data as any).client_type || (data as any).type || 'new lead')
                  : k === 'owner'
                    ? String((data as any).owner || 'Guy')
                    : k === 'lead_source'
                      ? String((data as any).lead_source || 'Outbound')
                      : String((data as any)[k] ?? ''),
          ]),
        ),
      );
    }
  }, [data?.id, data?.updated_at, numId]);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/api/crm') });
  const set = (k: string, v: string) => {
    dirty.current = true;
    setF((p) => ({ ...p, [k]: v }));
  };
  const copy = async (t: string, what: string) => {
    try {
      await navigator.clipboard.writeText(t);
      toast({ title: `${what} copied` });
    } catch {
      toast({ title: 'Copy failed — select and copy the text manually', variant: 'destructive' });
    }
  };

  const payload = (): InvestorInput => {
    const o: any = {};
    FIELDS.forEach((k) => {
      if (k === 'fit_score') o[k] = Math.min(5, Math.max(1, parseInt(f[k]) || 3));
      else if (k === 'deal_value') o[k] = Math.max(0, Number(String(f[k] || '0').replace(/[$,\s]/g, '')) || 0);
      else o[k] = f[k];
    });
    return o;
  };

  const save = () => {
    if (!f.name.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' });
      return;
    }
    const done = {
      onSuccess: () => {
        toast({ title: 'Deal card saved' });
        refresh();
        if (isNew) onClose();
      },
      onError: () => toast({ title: 'Save failed', variant: 'destructive' }),
    };
    if (isNew) create.mutate({ data: payload() }, done);
    else update.mutate({ id: numId, data: payload() }, done);
  };

  const deleteCard = async () => {
    if (!numId) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/crm/investors/${numId}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error('Delete failed');
      toast({ title: `Deleted card #${numId}` });
      refresh();
      onClose();
    } catch {
      toast({ title: 'Could not delete card', variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  const addActivity = async () => {
    if (!msg.trim() || !numId) return;
    setLoggingAct(true);
    try {
      const r = await fetch(`/api/crm/investors/${numId}/activity`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          eventType === 'note'
            ? { message: msg.trim(), kind: 'note' }
            : {
                event_type: eventType,
                subject: eventType === 'proposal_sent' ? 'Proposal Sent' : eventType === 'email_sent' ? f.pitch_subject || 'Outbound Email' : 'CRM Activity',
                snippet: msg.trim(),
                campaign: campaignTag,
                actor: f.owner || 'Guy',
              },
        ),
      });
      if (!r.ok) throw new Error('Failed');
      setMsg('');
      refetch();
      refresh();
      toast({ title: `Logged ${eventType.replace('_', ' ')}` });
    } catch {
      toast({ title: 'Could not add activity', variant: 'destructive' });
    } finally {
      setLoggingAct(false);
    }
  };

  const pending = create.isPending || update.isPending;
  const field = (k: string) => (
    <label key={k} className={`block ${LONG.includes(k) ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">{lbl(k)}</span>
      {k === 'status' ? (
        <select data-testid="select-status" className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : k === 'client_type' ? (
        <select data-testid="select-client-type" className={inp} value={f[k] || 'new lead'} onChange={(e) => set(k, e.target.value)}>
          {CLIENT_TYPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      ) : k === 'owner' ? (
        <input
          data-testid="input-owner"
          list="crm-owners-list"
          className={inp}
          value={f[k]}
          onChange={(e) => set(k, e.target.value)}
          placeholder="Guy, Eduardo, Growth..."
        />
      ) : k === 'expert_field' ? (
        <select data-testid="select-expert-field" className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)}>
          {EXPERT_FIELDS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : k === 'fit_score' ? (
        <select data-testid="select-fit" className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)}>
          {[1, 2, 3, 4, 5].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : k === 'deal_value' ? (
        <input
          data-testid="input-deal_value"
          type="number"
          min="0"
          step="100"
          className={inp}
          value={f[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      ) : LONG.includes(k) ? (
        <textarea data-testid={`input-${k}`} rows={k === 'pitch_body' ? 6 : 3} className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)} />
      ) : (
        <input
          data-testid={`input-${k}`}
          type={DATES.includes(k) ? 'date' : 'text'}
          className={inp}
          value={f[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      )}
    </label>
  );
  const log = [...(data?.activity_log ?? [])].reverse();

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-slate-50 sm:max-w-2xl">
        <datalist id="crm-owners-list">
          {teamOwners.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <SheetHeader>
          <div className="flex items-start justify-between gap-2 pr-6">
            <div>
              <SheetTitle className="font-display text-2xl font-bold text-slate-900">
                {isNew ? 'New Deal / Contact' : f.name || 'Deal Record'}
              </SheetTitle>
              <SheetDescription className="text-slate-600">
                {isNew ? 'Add a new law firm deal card to SellingHighs CRM.' : [f.title, f.firm].filter(Boolean).join(' · ') || `Card #${numId}`}
              </SheetDescription>
            </div>
            {!isNew && (
              <div className="flex items-center gap-1.5">
                {onDialContact && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onDialContact(numId, f.phone || '', f.firm || f.name);
                    }}
                    className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                  >
                    <PhoneCall className="h-3.5 w-3.5" /> Dial
                  </button>
                )}
                {onOpenWhatsApp && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenWhatsApp(numId, f.phone || '', f.firm || f.name);
                    }}
                    className="flex items-center gap-1 rounded-md bg-teal-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-teal-700"
                  >
                    <MessageSquare className="h-3.5 w-3.5" /> WhatsApp
                  </button>
                )}
                <button
                  type="button"
                  data-testid="button-delete-investor"
                  disabled={deleting}
                  onClick={deleteCard}
                  className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            )}
          </div>
        </SheetHeader>

        {!isNew && isLoading && (
          <div className="mt-6 space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-slate-200" />
            ))}
          </div>
        )}
        {!isNew && isError && (
          <div className="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-700">
            Could not load this record.{' '}
            <button className="underline" onClick={() => refetch()}>
              Retry
            </button>
          </div>
        )}

        {(isNew || data) && (
          <div className="mt-5 space-y-6 pb-8">
            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <div className="mb-3 text-xs font-bold uppercase tracking-wider text-blue-700">
                Deal &amp; Pipeline Fields
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field('status')}
                {field('deal_value')}
                {field('expected_close_date')}
                {field('owner')}
                {field('lead_source')}
                {field('client_type')}
              </div>
            </div>

            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-600">
                Contact &amp; Law Firm Details
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {FIELDS.filter(
                  (k) =>
                    ![
                      'status',
                      'deal_value',
                      'expected_close_date',
                      'owner',
                      'lead_source',
                      'client_type',
                      'pitch_subject',
                      'pitch_body',
                      'notes',
                    ].includes(k),
                ).map(field)}
                {field('notes')}
              </div>
            </div>

            <section className="rounded-xl border bg-white p-4 shadow-sm">
              <h3 className="font-display text-base font-bold text-slate-900">Outbound Pitch / Proposal Template</h3>
              <p className="mb-3 text-xs text-slate-500">
                Synced automatically when an email_sent or proposal_sent event is logged.
              </p>
              <div className="grid gap-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">{field('pitch_subject')}</div>
                  <button
                    type="button"
                    data-testid="button-copy-subject"
                    onClick={() => copy(f.pitch_subject, 'Subject')}
                    className="flex items-center gap-1 rounded-md border bg-slate-50 px-2.5 py-1.5 text-xs hover:bg-slate-100"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy subject
                  </button>
                </div>
                {field('pitch_body')}
                <button
                  type="button"
                  data-testid="button-copy-body"
                  onClick={() => copy(f.pitch_body, 'Body')}
                  className="flex w-fit items-center gap-1 rounded-md border bg-slate-50 px-2.5 py-1.5 text-xs hover:bg-slate-100"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy body
                </button>
              </div>
            </section>

            <button
              data-testid="button-save"
              disabled={pending}
              onClick={save}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
            >
              {pending ? 'Saving...' : isNew ? 'Create Deal Card' : 'Save Deal Changes'}
            </button>

            {!isNew && (
              <section className="rounded-xl border bg-white p-4 shadow-sm">
                <h3 className="font-display text-base font-bold text-slate-900">
                  Activity Log (Outbound, Emails, Replies, Proposals &amp; Calls)
                </h3>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <select
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value as any)}
                    className={inp}
                  >
                    <option value="note">Note (manual)</option>
                    <option value="email_sent">Email Sent (→ Contacted)</option>
                    <option value="reply_received">Reply Received (→ Contacted)</option>
                    <option value="proposal_sent">Proposal Sent (→ Proposal sent)</option>
                    <option value="call_logged">Call Logged</option>
                    <option value="whatsapp_sent">WhatsApp Sent</option>
                  </select>
                  <input
                    className={inp}
                    value={campaignTag}
                    onChange={(e) => setCampaignTag(e.target.value)}
                    placeholder="Campaign tag (e.g. law-firms-niw-q4)"
                  />
                  <div className="flex gap-1.5">
                    <input
                      data-testid="input-activity"
                      className={inp}
                      placeholder="Log snippet, reply, or next step..."
                      value={msg}
                      onChange={(e) => setMsg(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addActivity()}
                    />
                    <button
                      data-testid="button-add-activity"
                      disabled={loggingAct || !msg.trim()}
                      onClick={addActivity}
                      className="flex items-center gap-1 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" /> Add
                    </button>
                  </div>
                </div>

                <div className="mt-4">
                  {log.length === 0 ? (
                    <p className="rounded-md border border-dashed p-4 text-center text-sm text-slate-500">
                      No activity yet. Entries are timestamped when added.
                    </p>
                  ) : (
                    <ol className="space-y-2.5 border-l-2 border-blue-200 pl-4">
                      {log.map((a) => (
                        <li key={a.id} className="relative text-sm">
                          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-blue-600 ring-2 ring-white" />
                          <div className="flex items-center gap-2 font-mono-ui text-[11px] text-slate-500">
                            <span>{fmtTs(a.timestamp)}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">{a.kind}</span>
                          </div>
                          <div className="mt-0.5 text-slate-800">{a.message}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
