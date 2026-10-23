import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBrowserListInvestors, useBrowserGetSummary, useBrowserUpdateInvestor, useBrowserImportInvestors, browserExportInvestors, getBrowserListInvestorsQueryKey, getBrowserGetSummaryQueryKey, type Investor } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Search, Plus, Upload, Download, LayoutGrid, Table2, ArrowUpDown } from 'lucide-react';
import { STATUSES, TYPES, STATUS_TONE, TEMPLATE_CSV, EXPERT_FIELD_FILTERS, filterExpertField, defaultExpertFieldFor, type ExpertFieldFilter, download } from '@/lib/crm';
import { InvestorSheet } from '@/components/investor-sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Splash } from '@/pages/login';

const POLL = 30000;
const sel = 'rounded-md border border-input bg-card px-2 py-1.5 text-sm';
const isForbidden = (e: unknown) => (e as any)?.status === 403;

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return <div className="min-w-[110px] flex-1 border-l border-border px-4 first:border-l-0"><div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div><div className="font-display text-2xl leading-tight" data-testid={`stat-${label.toLowerCase().replace(/\W+/g, '-')}`}>{value}</div>{sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}</div>;
}
const Pill = ({ s }: { s: string }) => <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[s] ?? ''}`}>{s}</span>;
const Fit = ({ n }: { n: number }) => <span className="font-mono-ui text-xs" title={`Fit ${n}/5`}>{'●'.repeat(n)}<span className="opacity-20">{'●'.repeat(Math.max(0, 5 - n))}</span></span>;

export default function Dashboard() {
  const [expertField, setExpertField] = useState<ExpertFieldFilter>('Dentistry');
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useBrowserListInvestors(undefined, { query: { queryKey: getBrowserListInvestorsQueryKey(), refetchInterval: POLL, retry: (n: number, e: unknown) => !isForbidden(e) && n < 2 } });
  const summaryParams = expertField === 'All' ? undefined : { expert_field: expertField };
  const sum = useBrowserGetSummary(summaryParams, { query: { queryKey: getBrowserGetSummaryQueryKey(summaryParams), refetchInterval: POLL, retry: (n: number, e: unknown) => !isForbidden(e) && n < 2 } });
  const update = useBrowserUpdateInvestor();
  const importer = useBrowserImportInvestors();
  const [view, setView] = useState<'board' | 'table'>('board');
  const [q, setQ] = useState(''); const [fs, setFs] = useState(''); const [ft, setFt] = useState(''); const [ff, setFf] = useState('');
  const [sort, setSort] = useState<{ k: keyof Investor; d: 1 | -1 }>({ k: 'updated_at', d: -1 });
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [imp, setImp] = useState(false); const [csv, setCsv] = useState('');
  const [importError, setImportError] = useState('');
  const dragId = useRef<number | null>(null);
  const refresh = () => qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('/api/crm') });

  const fieldRows = useMemo(() => filterExpertField(list.data ?? [], expertField), [list.data, expertField]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const r = fieldRows.filter((i) => (!fs || i.status === fs) && (!ft || i.investor_type === ft) && (!ff || i.fit_score === +ff) &&
      (!s || [i.name, i.firm, i.email, i.location, i.thesis_notes, i.stage_focus].join(' ').toLowerCase().includes(s)));
    return [...r].sort((a, b) => { const x = a[sort.k] as any, y = b[sort.k] as any; return (typeof x === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * sort.d; });
  }, [fieldRows, q, fs, ft, ff, sort]);

  const move = (id: number, status: string) => update.mutate({ id, data: { status: status as any } }, { onSuccess: refresh, onError: () => toast({ title: 'Status change failed', variant: 'destructive' }) });
  const doExport = async () => { try { download('notara-investors.csv', await browserExportInvestors()); } catch { toast({ title: 'Export failed', variant: 'destructive' }); } };
  const doImport = () => {
    setImportError('');
    importer.mutate({ data: { csv } }, {
      onSuccess: (r) => { toast({ title: `Imported: ${r.created} created, ${r.updated} updated` }); setImp(false); setCsv(''); refresh(); },
      onError: (err) => {
        const body = (err as { data?: { error?: string } }).data;
        const message = body?.error || (err instanceof Error ? err.message : 'Import failed');
        setImportError(message);
        toast({ title: 'Import failed', description: message, variant: 'destructive' });
      },
    });
  };

  if (isForbidden(list.error) || isForbidden(sum.error)) return <Splash><h1 className="font-display text-3xl">Session expired</h1><p className="max-w-sm text-sm text-muted-foreground">Reload to sign in with your PIN.</p><button onClick={() => window.location.reload()} className="mt-2 rounded-md border px-4 py-2 text-sm">Reload</button></Splash>;

  const th = (k: keyof Investor, label: string) => <th className="px-3 py-2 text-left"><button onClick={() => setSort((p) => ({ k, d: p.k === k ? (-p.d as 1 | -1) : 1 }))} className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">{label}<ArrowUpDown className="h-3 w-3" /></button></th>;
  const s = sum.data;

  return (
    <div className="min-h-[100dvh]">
      <header className="flex flex-wrap items-center gap-3 border-b bg-sidebar px-5 py-3 text-sidebar-foreground">
        <span className="font-display text-xl">Notara</span><span className="text-xs opacity-60">Expert pipeline</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button data-testid="button-new" onClick={() => setOpen('new')} className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"><Plus className="h-4 w-4" />Add expert</button>
          <button data-testid="button-import" onClick={() => setImp(true)} className="flex items-center gap-1 rounded-md border border-sidebar-border px-3 py-1.5 text-sm"><Upload className="h-4 w-4" />Import</button>
          <button data-testid="button-export" onClick={doExport} className="flex items-center gap-1 rounded-md border border-sidebar-border px-3 py-1.5 text-sm"><Download className="h-4 w-4" />Export</button>
        </div>
      </header>

      <section className="flex flex-wrap items-center gap-3 border-b bg-card px-5 py-3">
        <span className="text-xs font-medium text-muted-foreground">Expert field</span>
        <div role="group" aria-label="Expert field filter" className="flex rounded-md border bg-background p-0.5">
          {EXPERT_FIELD_FILTERS.map(({ value, label }) => <button key={value} data-testid={`filter-field-${value}`} aria-pressed={expertField === value} onClick={() => setExpertField(value)} className={`rounded px-3 py-1.5 text-sm font-medium ${expertField === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>{label}</button>)}
        </div>
      </section>

      <section className="border-b bg-card px-5 py-4">
        {sum.isLoading ? <div className="h-14 animate-pulse rounded bg-muted" /> : sum.isError ? <div className="text-sm">Summary failed to load. <button className="underline" onClick={() => sum.refetch()}>Retry</button></div> : s && (
          <>
            <div className="flex flex-wrap gap-y-3">
              <Stat label="Total" value={s.total} />
              <Stat label="Contacted this week" value={s.contacted_this_week} />
              <Stat label="Response rate" value={`${(s.response_rate <= 1 ? s.response_rate * 100 : s.response_rate).toFixed(1)}%`} sub={`${s.responses} responses`} />
              <Stat label="Meetings set" value={s.meetings_set} />
              <Stat label="Follow-ups due today" value={s.followups_due_today} />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">{STATUSES.map((st) => <button key={st} onClick={() => setFs(fs === st ? '' : st)} className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${fs === st ? 'border-foreground' : ''}`}><Pill s={st} /><span className="font-mono-ui">{s.counts?.[st] ?? 0}</span></button>)}</div>
          </>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><input data-testid="input-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, firm, thesis" className={`${sel} w-64 pl-8`} /></div>
        <select data-testid="filter-status" className={sel} value={fs} onChange={(e) => setFs(e.target.value)}><option value="">All statuses</option>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select>
        <select data-testid="filter-type" className={sel} value={ft} onChange={(e) => setFt(e.target.value)}><option value="">All tiers</option>{TYPES.map((x) => <option key={x}>{x}</option>)}</select>
        <select data-testid="filter-fit" className={sel} value={ff} onChange={(e) => setFf(e.target.value)}><option value="">Any fit</option>{[5, 4, 3, 2, 1].map((x) => <option key={x} value={x}>Fit {x}</option>)}</select>
        <div className="ml-auto flex rounded-md border bg-card p-0.5">
          {([['board', LayoutGrid, 'Board'], ['table', Table2, 'Table']] as const).map(([v, Ic, l]) => <button key={v} data-testid={`view-${v}`} onClick={() => setView(v)} className={`flex items-center gap-1 rounded px-3 py-1 text-sm ${view === v ? 'bg-sidebar text-sidebar-foreground' : ''}`}><Ic className="h-4 w-4" />{l}</button>)}
        </div>
      </div>

      <main className="px-5 pb-10">
        {list.isLoading ? <div className="flex gap-3 overflow-hidden">{[0, 1, 2, 3].map((i) => <div key={i} className="h-72 w-64 shrink-0 animate-pulse rounded-lg bg-muted" />)}</div>
        : list.isError ? <div className="rounded-lg border border-destructive/30 p-8 text-center"><p className="font-display text-xl">Could not load experts</p><button onClick={() => list.refetch()} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Retry</button></div>
        : fieldRows.length === 0 ? <div className="mx-auto mt-10 max-w-md rounded-lg border border-dashed bg-card p-8 text-center"><h2 className="font-display text-2xl">Your pipeline is empty</h2><p className="mb-4 mt-2 text-sm text-muted-foreground">Add an expert by hand, or import a CSV using the template headers.</p><div className="flex justify-center gap-2"><button onClick={() => setOpen('new')} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Add expert</button><button onClick={() => setImp(true)} className="rounded-md border px-4 py-2 text-sm">Import CSV</button></div></div>
        : view === 'board' ? (
          <div className="flex gap-3 overflow-x-auto pb-3">
            {STATUSES.map((st) => { const col = rows.filter((i) => i.status === st); return (
              <div key={st} data-testid={`column-${st}`} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId.current) move(dragId.current, st); dragId.current = null; }} className="w-64 shrink-0 rounded-lg bg-secondary/70 p-2">
                <div className="mb-2 flex items-center justify-between px-1"><Pill s={st} /><span className="font-mono-ui text-xs text-muted-foreground" data-testid={`count-${st}`}>{col.length}</span></div>
                <div className="space-y-2">
                  {col.map((i) => (
                    <div key={i.id} draggable onDragStart={() => (dragId.current = i.id)} data-testid={`card-investor-${i.id}`} className="rise cursor-grab rounded-md border bg-card p-2.5 shadow-sm">
                      <button onClick={() => setOpen(i.id)} className="block w-full text-left"><div className="text-sm font-semibold leading-tight">{i.name}</div><div className="truncate text-xs text-muted-foreground">{i.firm}</div>
                        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground"><span>{i.investor_type}</span><Fit n={i.fit_score} /></div>
                        {i.next_follow_up_date && <div className="mt-1 font-mono-ui text-[11px] text-primary">Follow up {i.next_follow_up_date}</div>}</button>
                      <select aria-label="Status" data-testid={`select-card-status-${i.id}`} value={i.status} onChange={(e) => move(i.id, e.target.value)} className="mt-2 w-full rounded border bg-background px-1 py-0.5 text-xs">{STATUSES.map((x) => <option key={x}>{x}</option>)}</select>
                    </div>
                  ))}
                  {col.length === 0 && <div className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">Drop here</div>}
                </div>
              </div>); })}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm"><thead className="border-b bg-secondary/60"><tr>{th('name', 'Name')}{th('firm', 'Firm')}{th('investor_type', 'Tier')}{th('typical_check_size', 'Check')}{th('fit_score', 'Fit')}{th('status', 'Status')}{th('next_follow_up_date', 'Follow up')}{th('updated_at', 'Updated')}</tr></thead>
              <tbody>{rows.map((i) => <tr key={i.id} data-testid={`row-investor-${i.id}`} onClick={() => setOpen(i.id)} className="cursor-pointer border-b last:border-0 hover:bg-secondary/50"><td className="px-3 py-2 font-medium">{i.name}</td><td className="px-3 py-2">{i.firm}</td><td className="px-3 py-2">{i.investor_type}</td><td className="px-3 py-2">{i.typical_check_size}</td><td className="px-3 py-2"><Fit n={i.fit_score} /></td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}><select value={i.status} onChange={(e) => move(i.id, e.target.value)} className="rounded border bg-background px-1 py-0.5 text-xs">{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></td>
                <td className="px-3 py-2 font-mono-ui text-xs">{i.next_follow_up_date}</td><td className="px-3 py-2 font-mono-ui text-xs">{i.updated_at?.slice(0, 10)}</td></tr>)}</tbody></table>
            {rows.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No experts match these filters.</div>}
          </div>
        )}
      </main>

      <InvestorSheet id={open} open={open !== null} onClose={() => setOpen(null)} defaultExpertField={defaultExpertFieldFor(expertField)} />

      <Dialog open={imp} onOpenChange={setImp}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle className="font-display text-2xl">Import experts</DialogTitle><DialogDescription>Paste CSV text or choose a file. Columns can be in any order; values are matched by header name. expert_field is optional: Dentistry, Economics, Law Firms, Chinese Law or Indian Law (case-insensitive). Blank means Dentistry.</DialogDescription></DialogHeader>
          <code className="block break-words rounded bg-muted p-2 font-mono-ui text-[11px]">{TEMPLATE_CSV.trim()}</code>
          <div className="flex gap-2"><button data-testid="button-template" onClick={() => download('notara-template.csv', TEMPLATE_CSV)} className="rounded-md border px-3 py-1.5 text-sm">Download template</button>
            <input data-testid="input-csv-file" type="file" accept=".csv,text/csv" className="text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} /></div>
          <textarea data-testid="input-csv" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} className="w-full rounded-md border bg-card p-2 font-mono-ui text-xs" />
          {importError && <p role="alert" data-testid="text-import-error" className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{importError}</p>}
          <button data-testid="button-run-import" disabled={!csv.trim() || importer.isPending} onClick={doImport} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{importer.isPending ? 'Importing...' : 'Import'}</button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
