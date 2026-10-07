import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBrowserGetInvestor, useBrowserUpsertInvestor, useBrowserUpdateInvestor, useBrowserAppendActivity, getBrowserGetInvestorQueryKey, type InvestorInput } from '@workspace/api-client-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useToast } from '@/hooks/use-toast';
import { Copy } from 'lucide-react';
import { STATUSES, TYPES, FIELDS, fmtTs } from '@/lib/crm';

type F = Record<string, string>;
const empty = (): F => ({ ...Object.fromEntries(FIELDS.map((k) => [k, ''])), status: 'New', fit_score: '3', investor_type: 'angel' });
const LONG = ['thesis_notes', 'pitch_body', 'notes', 'warm_intro_path'];
const DATES = ['last_contacted_date', 'next_follow_up_date'];
const lbl = (k: string) => k.replace(/_/g, ' ');
const inp = 'w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40';

export function InvestorSheet({ id, open, onClose }: { id: number | 'new' | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isNew = id === 'new';
  const numId = typeof id === 'number' ? id : 0;
  const { data, isLoading, isError, refetch } = useBrowserGetInvestor(numId, { query: { enabled: !!numId && open, queryKey: getBrowserGetInvestorQueryKey(numId) } });
  const [f, setF] = useState<F>(empty());
  const [msg, setMsg] = useState('');
  const dirty = useRef(false);
  useEffect(() => { dirty.current = false; setMsg(''); }, [numId, open]);
  const create = useBrowserUpsertInvestor();
  const update = useBrowserUpdateInvestor();
  const append = useBrowserAppendActivity();

  useEffect(() => { if (isNew) setF(empty()); }, [isNew, open]);
  useEffect(() => {
    if (!dirty.current && data && data.id === numId) setF(Object.fromEntries(FIELDS.map((k) => [k, String((data as any)[k] ?? '')])));
  }, [data?.id, data?.updated_at, numId]);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/api/crm') });
  const set = (k: string, v: string) => { dirty.current = true; setF((p) => ({ ...p, [k]: v })); };
  const copy = async (t: string, what: string) => {
    try { await navigator.clipboard.writeText(t); toast({ title: `${what} copied` }); }
    catch { toast({ title: 'Copy failed — select and copy the text manually', variant: 'destructive' }); }
  };

  const payload = (): InvestorInput => {
    const o: any = {};
    FIELDS.forEach((k) => { if (k === 'fit_score') o[k] = Math.min(5, Math.max(1, parseInt(f[k]) || 3)); else if (k === 'investor_type' && !f[k]) return; else o[k] = f[k]; });
    return o;
  };
  const save = () => {
    if (!f.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return; }
    const done = { onSuccess: () => { toast({ title: 'Saved' }); refresh(); if (isNew) onClose(); }, onError: () => toast({ title: 'Save failed', variant: 'destructive' }) };
    if (isNew) create.mutate({ data: payload() }, done);
    else update.mutate({ id: numId, data: payload() }, done);
  };
  const addNote = () => {
    if (!msg.trim() || !numId) return;
    append.mutate({ id: numId, data: { message: msg.trim(), kind: 'note' } }, { onSuccess: () => { setMsg(''); refresh(); }, onError: () => toast({ title: 'Could not add activity', variant: 'destructive' }) });
  };
  const pending = create.isPending || update.isPending;
  const field = (k: string) => (
    <label key={k} className={`block ${LONG.includes(k) ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{lbl(k)}</span>
      {k === 'status' ? <select data-testid="select-status" className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
        : k === 'investor_type' ? <select data-testid="select-type" className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)}>{TYPES.map((s) => <option key={s}>{s}</option>)}</select>
        : k === 'fit_score' ? <select data-testid="select-fit" className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)}>{[1, 2, 3, 4, 5].map((s) => <option key={s}>{s}</option>)}</select>
        : LONG.includes(k) ? <textarea data-testid={`input-${k}`} rows={k === 'pitch_body' ? 8 : 3} className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)} />
        : <input data-testid={`input-${k}`} type={DATES.includes(k) ? 'date' : 'text'} className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)} />}
    </label>
  );
  const log = [...(data?.activity_log ?? [])].reverse();

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-background sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-display text-2xl">{isNew ? 'New investor' : f.name || 'Investor'}</SheetTitle>
          <SheetDescription>{isNew ? 'Add an investor to the pipeline.' : [f.title, f.firm].filter(Boolean).join(' at ') || 'Investor record'}</SheetDescription>
        </SheetHeader>
        {!isNew && isLoading && <div className="mt-6 space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}</div>}
        {!isNew && isError && <div className="mt-6 rounded-md border border-destructive/30 p-4 text-sm">Could not load this investor. <button className="underline" onClick={() => refetch()}>Retry</button></div>}
        {(isNew || data) && (
          <div className="mt-5 space-y-6 pb-8">
            <div className="grid gap-3 sm:grid-cols-2">{FIELDS.filter((k) => k !== 'pitch_subject' && k !== 'pitch_body' && k !== 'notes' && k !== 'thesis_notes').map(field)}{field('thesis_notes')}{field('notes')}</div>
            <section className="rounded-lg border bg-card p-4">
              <h3 className="font-display text-lg">Pitch draft</h3>
              <p className="mb-3 text-xs text-muted-foreground">Copy text only. Nothing is sent from here.</p>
              <div className="grid gap-3">
                <div className="flex items-end gap-2"><div className="flex-1">{field('pitch_subject')}</div><button data-testid="button-copy-subject" onClick={() => copy(f.pitch_subject, 'Subject')} className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"><Copy className="h-3.5 w-3.5" />Copy subject</button></div>
                {field('pitch_body')}
                <button data-testid="button-copy-body" onClick={() => copy(f.pitch_body, 'Body')} className="flex w-fit items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"><Copy className="h-3.5 w-3.5" />Copy body</button>
              </div>
            </section>
            <button data-testid="button-save" disabled={pending} onClick={save} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{pending ? 'Saving...' : isNew ? 'Create investor' : 'Save changes'}</button>
            {!isNew && (
              <section>
                <h3 className="font-display text-lg">Activity</h3>
                <div className="my-2 flex gap-2">
                  <input data-testid="input-activity" className={inp} placeholder="Log a call, reply, or next step" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addNote()} />
                  <button data-testid="button-add-activity" disabled={append.isPending || !msg.trim()} onClick={addNote} className="rounded-md bg-secondary px-3 text-sm font-medium disabled:opacity-50">Add</button>
                </div>
                {log.length === 0 ? <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No activity yet. Entries are timestamped when added.</p> :
                  <ol className="space-y-2 border-l pl-4">{log.map((a) => <li key={a.id} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" /><span className="font-mono-ui text-[11px] text-muted-foreground">{fmtTs(a.timestamp)} · {a.kind}</span><div>{a.message}</div></li>)}</ol>}
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
