import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useBrowserListInvestors,
  useBrowserGetSummary,
  useBrowserUpdateInvestor,
  useBrowserImportInvestors,
  browserExportInvestors,
  getBrowserListInvestorsQueryKey,
  getBrowserGetSummaryQueryKey,
  type Investor,
  type CrmUser,
  type CrmPinSessionStatus,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import {
  Search,
  Plus,
  Upload,
  Download,
  LayoutGrid,
  Table2,
  ArrowUpDown,
  Home,
  Users,
  Kanban,
  BarChart3,
  Send,
  PhoneCall,
  MessageSquare,
  UserCheck,
  Sparkles,
  LogOut,
} from 'lucide-react';
import {
  STATUSES,
  CLIENT_TYPES,
  STAGE_PROBABILITIES,
  STATUS_TONE,
  CLIENT_TYPE_TONE,
  TEMPLATE_CSV,
  EXPERT_FIELD_FILTERS,
  filterExpertField,
  defaultExpertFieldFor,
  type ExpertFieldFilter,
  type StageStatus,
  download,
  fmtCurrency,
  fmtTs,
} from '@/lib/crm';
import { InvestorSheet } from '@/components/investor-sheet';
import {
  ReportsPanel,
  CampaignsPanel,
  TelnyxPhonePanel,
  WhatsAppPanel,
  TeamWorkspacesPanel,
} from '@/components/crm-panels';
import { SESSION_KEY } from '@/components/pin-gate';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Splash } from '@/pages/login';

const POLL = 30000;
const sel = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none';
const isForbidden = (e: unknown) => (e as any)?.status === 403;

type NavSection = 'overview' | 'contacts' | 'deals' | 'reports' | 'campaigns' | 'phone' | 'whatsapp' | 'team';

const Pill = ({ s }: { s: string }) => (
  <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[s] ?? 'bg-slate-100 text-slate-800'}`}>
    {s}
  </span>
);

const ClientTypeBadge = ({ t }: { t?: string }) => {
  const val = t || 'new lead';
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${CLIENT_TYPE_TONE[val] ?? 'bg-slate-100 text-slate-700'}`}>
      {val}
    </span>
  );
};

const Fit = ({ n }: { n: number }) => (
  <span className="font-mono-ui text-xs text-amber-500" title={`Fit ${n}/5`}>
    {'●'.repeat(n)}
    <span className="opacity-25">{'●'.repeat(Math.max(0, 5 - n))}</span>
  </span>
);

export default function Dashboard() {
  const [nav, setNav] = useState<NavSection>('deals');
  const [expertField, setExpertField] = useState<ExpertFieldFilter>('All');
  const [workspaceOwner, setWorkspaceOwner] = useState<string>('All');
  const [dateRange, setDateRange] = useState<'all' | 'this_month' | 'this_quarter' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState<string>('2026-10-01');
  const [customTo, setCustomTo] = useState<string>('2026-10-31');

  const qc = useQueryClient();
  const { toast } = useToast();
  const sessionData = qc.getQueryData<CrmPinSessionStatus>(SESSION_KEY);

  const list = useBrowserListInvestors(undefined, {
    query: {
      queryKey: getBrowserListInvestorsQueryKey(),
      refetchInterval: POLL,
      retry: (n: number, e: unknown) => !isForbidden(e) && n < 2,
    },
  });

  const summaryParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (expertField !== 'All') p.expert_field = expertField;
    if (workspaceOwner !== 'All') p.owner = workspaceOwner;
    if (dateRange !== 'all') p.range = dateRange;
    if (dateRange === 'custom') {
      p.from = customFrom;
      p.to = customTo;
    }
    return Object.keys(p).length ? (p as any) : undefined;
  }, [expertField, workspaceOwner, dateRange, customFrom, customTo]);

  const sum = useBrowserGetSummary(summaryParams, {
    query: {
      queryKey: getBrowserGetSummaryQueryKey(summaryParams),
      refetchInterval: POLL,
      retry: (n: number, e: unknown) => !isForbidden(e) && n < 2,
    },
  });

  const usersQuery = useQuery<CrmUser[]>({
    queryKey: ['/api/crm/team'],
    queryFn: async () => {
      const r = await fetch('/api/crm/team', { credentials: 'include' });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const callsQuery = useQuery<any[]>({
    queryKey: ['/api/crm/calls'],
    queryFn: async () => {
      const r = await fetch('/api/crm/calls', { credentials: 'include' });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const whatsappQuery = useQuery<any[]>({
    queryKey: ['/api/crm/whatsapp'],
    queryFn: async () => {
      const r = await fetch('/api/crm/whatsapp', { credentials: 'include' });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const campaignsQuery = useQuery<any[]>({
    queryKey: ['/api/crm/campaigns'],
    queryFn: async () => {
      const r = await fetch('/api/crm/campaigns', { credentials: 'include' });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const update = useBrowserUpdateInvestor();
  const importer = useBrowserImportInvestors();
  const [view, setView] = useState<'board' | 'table'>('board');
  const [q, setQ] = useState('');
  const [fs, setFs] = useState('');
  const [fct, setFct] = useState('');
  const [ff, setFf] = useState('');
  const [sort, setSort] = useState<{ k: keyof Investor; d: 1 | -1 }>({ k: 'updated_at', d: -1 });
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [imp, setImp] = useState(false);
  const [csv, setCsv] = useState('');
  const [importError, setImportError] = useState('');
  const dragId = useRef<number | null>(null);

  const [dialCardId, setDialCardId] = useState<number | ''>('');
  const [dialPhone, setDialPhone] = useState('');
  const [dialFirm, setDialFirm] = useState('');
  const [waCardId, setWaCardId] = useState<number | ''>('');
  const [waPhone, setWaPhone] = useState('');

  const refresh = () => {
    qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('/api/crm') });
  };

  const teamOwners = useMemo(() => {
    const names = (usersQuery.data ?? []).map((u) => u.name);
    return names.length ? names : ['Guy', 'Eduardo', 'Growth'];
  }, [usersQuery.data]);

  const fieldRows = useMemo(() => {
    let base = filterExpertField(list.data ?? [], expertField);
    if (workspaceOwner !== 'All') {
      const target = workspaceOwner.toLowerCase();
      base = base.filter((i) => String((i as any).owner || 'Guy').toLowerCase() === target);
    }
    return base;
  }, [list.data, expertField, workspaceOwner]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const r = fieldRows.filter(
      (i) =>
        (!fs || i.status === fs) &&
        (!fct || ((i as any).client_type || 'new lead') === fct) &&
        (!ff || i.fit_score === +ff) &&
        (!s ||
          [
            i.name,
            i.firm,
            i.email,
            i.location,
            (i as any).lead_source,
            (i as any).owner,
          ]
            .join(' ')
            .toLowerCase()
            .includes(s)),
    );
    return [...r].sort((a, b) => {
      const x = a[sort.k] as any;
      const y = b[sort.k] as any;
      return (typeof x === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * sort.d;
    });
  }, [fieldRows, q, fs, fct, ff, sort]);

  const kpiMetrics = useMemo(() => {
    const s = sum.data;
    const valOf = (i: Investor) => Number((i as any).deal_value) || 2500;
    const totalPipelineVal = s?.total_pipeline_value ?? rows.reduce((acc, i) => acc + valOf(i), 0);
    const weightedForecast =
      s?.pipeline_forecast ??
      Math.round(
        rows.reduce((acc, i) => {
          const prob = STAGE_PROBABILITIES[i.status as StageStatus] ?? 0.05;
          return acc + valOf(i) * prob;
        }, 0),
      );
    const avgDays = s?.avg_days_to_close ?? 18;
    const closedCount = rows.filter((i) => i.status === 'Closed').length;
    const meetingReached = rows.filter((i) =>
      ['Meeting set', 'Proposal sent', 'Contract review', 'Closed'].includes(i.status),
    ).length;
    const convRate =
      s?.meeting_to_closed_rate ??
      (meetingReached > 0 ? Math.round((closedCount / meetingReached) * 1000) / 10 : 0);

    const totalCount = Math.max(rows.length, 1);
    const funnel =
      s?.funnel ??
      STATUSES.map((st) => {
        const stRows = rows.filter((i) => i.status === st);
        const stVal = stRows.reduce((acc, i) => acc + valOf(i), 0);
        const prob = STAGE_PROBABILITIES[st];
        return {
          stage: st,
          count: stRows.length,
          value: stVal,
          probability: prob,
          weighted_value: Math.round(stVal * prob),
          conversion_rate: Math.round((stRows.length / totalCount) * 1000) / 10,
        };
      });

    return { avgDays, weightedForecast, totalPipelineVal, convRate, funnel };
  }, [sum.data, rows]);

  const recentActivities = useMemo(() => {
    const all: Array<{ cardId: number; firm: string; name: string; timestamp: string; kind: string; message: string }> = [];
    for (const r of fieldRows) {
      for (const a of r.activity_log || []) {
        all.push({
          cardId: r.id,
          firm: r.firm || r.name,
          name: r.name,
          timestamp: a.timestamp,
          kind: a.kind,
          message: a.message,
        });
      }
    }
    return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 25);
  }, [fieldRows]);

  const move = (id: number, status: string) =>
    update.mutate(
      { id, data: { status: status as any } },
      { onSuccess: refresh, onError: () => toast({ title: 'Stage update failed', variant: 'destructive' }) },
    );

  const doExport = async () => {
    try {
      download('sellinghighs-crm.csv', await browserExportInvestors());
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    }
  };

  const doImport = () => {
    setImportError('');
    importer.mutate(
      { data: { csv } },
      {
        onSuccess: (r) => {
          toast({ title: `Imported: ${r.created} created, ${r.updated} updated` });
          setImp(false);
          setCsv('');
          refresh();
        },
        onError: (err) => {
          const body = (err as { data?: { error?: string } }).data;
          const message = body?.error || (err instanceof Error ? err.message : 'Import failed');
          setImportError(message);
          toast({ title: 'Import failed', description: message, variant: 'destructive' });
        },
      },
    );
  };

  const purgeDuplicates = async () => {
    try {
      const r = await fetch('/api/crm/investors/deduplicate', { method: 'POST', credentials: 'include' });
      const data = await r.json();
      toast({ title: `Deduplication complete: ${data.deleted_count ?? 0} duplicate cards removed` });
      refresh();
    } catch {
      toast({ title: 'Deduplication failed', variant: 'destructive' });
    }
  };

  const logout = async () => {
    await fetch('/api/crm/session', { method: 'DELETE', credentials: 'include' });
    window.location.reload();
  };

  if (isForbidden(list.error) || isForbidden(sum.error)) {
    return (
      <Splash>
        <h1 className="font-display text-3xl">Session expired</h1>
        <p className="max-w-sm text-sm text-muted-foreground">Reload to sign in to your workspace.</p>
        <button onClick={() => window.location.reload()} className="mt-2 rounded-md border px-4 py-2 text-sm">
          Reload
        </button>
      </Splash>
    );
  }

  const th = (k: keyof Investor, label: string) => (
    <th className="px-3 py-2.5 text-left">
      <button
        onClick={() => setSort((p) => ({ k, d: p.k === k ? (-p.d as 1 | -1) : 1 }))}
        className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-900"
      >
        {label}
        <ArrowUpDown className="h-3 w-3" />
      </button>
    </th>
  );

  const navItems: Array<{ id: NavSection; label: string; icon: any; badge?: string | number }> = [
    { id: 'overview', label: 'Overview', icon: Home },
    { id: 'contacts', label: 'Contacts', icon: Users, badge: fieldRows.length },
    { id: 'deals', label: 'Deals (Kanban)', icon: Kanban, badge: rows.length },
    { id: 'reports', label: 'Reports & Forecast', icon: BarChart3 },
    { id: 'campaigns', label: 'Campaigns', icon: Send, badge: campaignsQuery.data?.length || 3 },
    { id: 'phone', label: 'Dialer', icon: PhoneCall, badge: callsQuery.data?.length || 0 },
    { id: 'whatsapp', label: 'WhatsApp', icon: MessageSquare, badge: whatsappQuery.data?.length || 0 },
    { id: 'team', label: 'Team Workspaces', icon: UserCheck, badge: usersQuery.data?.length || 4 },
  ];

  return (
    <div className="flex min-h-[100dvh] bg-slate-50 text-slate-900">
      <aside className="flex w-60 shrink-0 flex-col bg-[#1b2538] text-slate-200">
        <div className="flex items-center gap-2.5 border-b border-slate-700/70 px-4 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 font-bold text-white shadow">
            SH
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-base font-bold text-white">SellingHighs</div>
            <div className="truncate text-[11px] text-blue-300/80">
              {workspaceOwner === 'All' ? 'All Team Workspace' : `${workspaceOwner}'s Workspace`}
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-2.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = nav === item.id;
            return (
              <button
                key={item.id}
                data-testid={`nav-${item.id}`}
                onClick={() => setNav(item.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono-ui text-[11px] ${
                      active ? 'bg-blue-700 text-white' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-700/70 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between text-slate-400">
            <span>Signed in</span>
            <span className="font-semibold text-white">{sessionData?.user?.name || 'Admin'}</span>
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b bg-white px-6 py-3 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Workspace:</span>
            <select
              data-testid="select-workspace-owner"
              value={workspaceOwner}
              onChange={(e) => setWorkspaceOwner(e.target.value)}
              className={sel}
            >
              <option value="All">All Team Members</option>
              {teamOwners.map((o) => (
                <option key={o} value={o}>
                  {o}&apos;s Workspace
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2"><span className="text-xs font-semibold uppercase tracking-wider text-slate-500">MARKET / REGION:</span><div role="group" aria-label="MARKET / REGION" className="flex rounded-lg border bg-slate-100 p-0.5">
            {EXPERT_FIELD_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                data-testid={`filter-field-${value}`}
                aria-pressed={expertField === value}
                onClick={() => setExpertField(value)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                  expertField === value ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div></div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              data-testid="button-deduplicate"
              onClick={purgeDuplicates}
              className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Sparkles className="h-3.5 w-3.5 text-blue-600" /> Remove Duplicates
            </button>
            <button
              data-testid="button-new"
              onClick={() => setOpen('new')}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> Add Deal
            </button>
            <button
              data-testid="button-import"
              onClick={() => setImp(true)}
              className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Upload className="h-3.5 w-3.5" /> Import
            </button>
            <button
              data-testid="button-export"
              onClick={doExport}
              className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
          </div>
        </header>

        {/* Top Bar KPIs — Exact 4 Requested KPIs */}
        <section className="grid grid-cols-1 gap-3 border-b bg-white px-6 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              1. Average Days to Close
            </div>
            <div className="mt-1 font-display text-2xl font-bold text-slate-900" data-testid="kpi-avg-days-to-close">
              {kpiMetrics.avgDays} days
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">Lead creation to Closed stage velocity</div>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">
              2. Forecast (Current Pipeline)
            </div>
            <div className="mt-1 font-display text-2xl font-bold text-blue-900" data-testid="kpi-pipeline-forecast">
              {fmtCurrency(kpiMetrics.weightedForecast)}
            </div>
            <div className="mt-0.5 text-[11px] text-blue-700/80">
              Stage value × win probability (20% / 50% / 80%)
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              3. Total Pipeline Value
            </div>
            <div className="mt-1 font-display text-2xl font-bold text-slate-900" data-testid="kpi-total-pipeline-value">
              {fmtCurrency(kpiMetrics.totalPipelineVal)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">Across {rows.length} deals in view</div>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
              4. Meeting Set → Closed Rate
            </div>
            <div className="mt-1 font-display text-2xl font-bold text-emerald-900" data-testid="kpi-meeting-to-closed-rate">
              {kpiMetrics.convRate.toFixed(1)}%
            </div>
            <div className="mt-0.5 text-[11px] text-emerald-700/80">Conversion from Meeting set to Closed</div>
          </div>
        </section>

        <main className="flex-1 p-6">
          {nav === 'overview' && (
            <div className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-xl border bg-white p-5 shadow-xs">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h2 className="font-display text-lg font-bold text-slate-900">Pipeline Stage &amp; Forecast Summary</h2>
                      <p className="text-xs text-slate-500">Deal count, raw value, and probability-weighted forecast</p>
                    </div>
                    <button onClick={() => setNav('reports')} className="text-xs font-semibold text-blue-600 hover:underline">
                      Full Reports →
                    </button>
                  </div>
                  <div className="space-y-3">
                    {kpiMetrics.funnel.map((f) => (
                      <div key={f.stage} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-2 font-semibold">
                            <Pill s={f.stage} />
                            <span className="text-slate-500">({Math.round(f.probability * 100)}% win prob)</span>
                          </span>
                          <span className="font-mono-ui text-slate-700">
                            {f.count} deals · {fmtCurrency(f.value)} → <strong>{fmtCurrency(f.weighted_value)}</strong>
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-blue-600"
                            style={{ width: `${Math.max(4, f.conversion_rate)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border bg-white p-5 shadow-xs">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h2 className="font-display text-lg font-bold text-slate-900">Recent Outbound Activity</h2>
                      <p className="text-xs text-slate-500">Live emails sent, replies, proposals, and outbound calls</p>
                    </div>
                    <button onClick={() => setNav('campaigns')} className="text-xs font-semibold text-blue-600 hover:underline">
                      Log Outbound →
                    </button>
                  </div>
                  <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
                    {recentActivities.slice(0, 10).map((a, idx) => (
                      <div
                        key={`${a.cardId}-${idx}`}
                        onClick={() => setOpen(a.cardId)}
                        className="cursor-pointer rounded-lg border border-slate-100 bg-slate-50/70 p-2.5 text-xs hover:bg-blue-50/40"
                      >
                        <div className="flex items-center justify-between font-mono-ui text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-800">{a.firm}</span>
                          <span>{fmtTs(a.timestamp)} · {a.kind}</span>
                        </div>
                        <div className="mt-1 truncate text-slate-700">{a.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {(nav === 'deals' || nav === 'contacts') && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    data-testid="input-search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search name, firm, owner, source..."
                    className={`${sel} w-64 pl-8`}
                  />
                </div>
                <select data-testid="filter-status" className={sel} value={fs} onChange={(e) => setFs(e.target.value)}>
                  <option value="">All 6 stages</option>
                  {STATUSES.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <select data-testid="filter-client-type" className={sel} value={fct} onChange={(e) => setFct(e.target.value)}>
                  <option value="">All client types</option>
                  {CLIENT_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <select data-testid="filter-fit" className={sel} value={ff} onChange={(e) => setFf(e.target.value)}>
                  <option value="">Any fit</option>
                  {[5, 4, 3, 2, 1].map((x) => (
                    <option key={x} value={x}>
                      Fit {x}
                    </option>
                  ))}
                </select>

                {nav === 'deals' && (
                  <div className="ml-auto flex rounded-lg border bg-white p-0.5">
                    {(
                      [
                        ['board', LayoutGrid, 'Kanban'],
                        ['table', Table2, 'Table'],
                      ] as const
                    ).map(([v, Ic, l]) => (
                      <button
                        key={v}
                        data-testid={`view-${v}`}
                        onClick={() => setView(v)}
                        className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold ${
                          view === v ? 'bg-blue-600 text-white' : 'text-slate-600'
                        }`}
                      >
                        <Ic className="h-3.5 w-3.5" />
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {list.isLoading ? (
                <div className="flex gap-3 overflow-hidden">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-72 w-64 shrink-0 animate-pulse rounded-lg bg-slate-200" />
                  ))}
                </div>
              ) : nav === 'deals' && view === 'board' ? (
                <div className="flex gap-3 overflow-x-auto pb-4">
                  {STATUSES.map((st) => {
                    const col = rows.filter((i) => i.status === st);
                    const colVal = col.reduce((acc, i) => acc + (Number((i as any).deal_value) || 2500), 0);
                    return (
                      <div
                        key={st}
                        data-testid={`column-${st}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragId.current) move(dragId.current, st);
                          dragId.current = null;
                        }}
                        className="w-72 shrink-0 rounded-xl border border-slate-200 bg-slate-100/80 p-2.5"
                      >
                        <div className="mb-2.5 flex items-center justify-between px-1">
                          <div className="flex items-center gap-1.5">
                            <Pill s={st} />
                            <span className="font-mono-ui text-xs font-semibold text-slate-600" data-testid={`count-${st}`}>
                              {col.length}
                            </span>
                          </div>
                          <span className="font-mono-ui text-[11px] font-semibold text-slate-500">
                            {fmtCurrency(colVal)}
                          </span>
                        </div>

                        <div className="space-y-2">
                          {col.map((i) => (
                            <div
                              key={i.id}
                              draggable
                              onDragStart={() => (dragId.current = i.id)}
                              data-testid={`card-investor-${i.id}`}
                              className="rise cursor-grab rounded-lg border border-slate-200 bg-white p-3 shadow-xs hover:border-blue-400"
                            >
                              <button onClick={() => setOpen(i.id)} className="block w-full text-left">
                                <div className="flex items-start justify-between gap-1">
                                  <div className="text-sm font-bold leading-snug text-slate-900">{i.name}</div>
                                  <span className="font-mono-ui text-xs font-bold text-blue-700">
                                    {fmtCurrency((i as any).deal_value)}
                                  </span>
                                </div>
                                <div className="truncate text-xs text-slate-500">{i.firm}</div>

                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  <ClientTypeBadge t={(i as any).client_type} />
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                                    Owner: {(i as any).owner || 'Guy'}
                                  </span>
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                    {(i as any).lead_source || 'Outbound'}
                                  </span>
                                </div>

                                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                                  <span>{i.expert_field}</span>
                                  <Fit n={i.fit_score} />
                                </div>
                                {((i as any).expected_close_date || i.next_follow_up_date) && (
                                  <div className="mt-1 font-mono-ui text-[11px] text-blue-600">
                                    Close: {(i as any).expected_close_date || i.next_follow_up_date}
                                  </div>
                                )}
                              </button>

                              <select
                                aria-label="Status"
                                data-testid={`select-card-status-${i.id}`}
                                value={i.status}
                                onChange={(e) => move(i.id, e.target.value)}
                                className="mt-2 w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-xs"
                              >
                                {STATUSES.map((x) => (
                                  <option key={x}>{x}</option>
                                ))}
                              </select>
                            </div>
                          ))}
                          {col.length === 0 && (
                            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-400">
                              Drop deal card here
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border bg-white shadow-xs">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-slate-50">
                      <tr>
                        {th('name', 'Name')}
                        {th('firm', 'Firm')}
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          Type
                        </th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          Deal Value
                        </th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          Lead Source
                        </th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          Owner
                        </th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          Expected Close
                        </th>
                        {th('status', 'Stage')}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((i) => (
                        <tr
                          key={i.id}
                          data-testid={`row-investor-${i.id}`}
                          onClick={() => setOpen(i.id)}
                          className="cursor-pointer border-b last:border-0 hover:bg-slate-50"
                        >
                          <td className="px-3 py-2.5 font-semibold text-slate-900">{i.name}</td>
                          <td className="px-3 py-2.5 text-slate-600">{i.firm}</td>
                          <td className="px-3 py-2.5">
                            <ClientTypeBadge t={(i as any).client_type} />
                          </td>
                          <td className="px-3 py-2.5 font-mono-ui font-semibold text-blue-700">
                            {fmtCurrency((i as any).deal_value)}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">{(i as any).lead_source || 'Outbound'}</td>
                          <td className="px-3 py-2.5 text-xs font-medium">{(i as any).owner || 'Guy'}</td>
                          <td className="px-3 py-2.5 font-mono-ui text-xs">
                            {(i as any).expected_close_date || i.next_follow_up_date || '—'}
                          </td>
                          <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <select
                              value={i.status}
                              onChange={(e) => move(i.id, e.target.value)}
                              className="rounded border bg-slate-50 px-1.5 py-0.5 text-xs"
                            >
                              {STATUSES.map((x) => (
                                <option key={x}>{x}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {nav === 'reports' && (
            <ReportsPanel
              workspaceOwner={workspaceOwner}
              dateRange={dateRange}
              setDateRange={setDateRange}
              customFrom={customFrom}
              setCustomFrom={setCustomFrom}
              customTo={customTo}
              setCustomTo={setCustomTo}
              funnel={kpiMetrics.funnel}
              totalDeals={rows.length}
              totalPipelineVal={kpiMetrics.totalPipelineVal}
              weightedForecast={kpiMetrics.weightedForecast}
            />
          )}

          {nav === 'campaigns' && (
            <CampaignsPanel
              campaigns={campaignsQuery.data ?? []}
              onLogSuccess={() => {
                campaignsQuery.refetch();
                refresh();
              }}
              toast={toast}
            />
          )}

          {nav === 'phone' && (
            <TelnyxPhonePanel
              rows={rows}
              calls={callsQuery.data ?? []}
              dialCardId={dialCardId}
              setDialCardId={setDialCardId}
              dialPhone={dialPhone}
              setDialPhone={setDialPhone}
              dialFirm={dialFirm}
              setDialFirm={setDialFirm}
              workspaceOwner={workspaceOwner}
              onDialSuccess={() => {
                callsQuery.refetch();
                refresh();
              }}
              toast={toast}
            />
          )}

          {nav === 'whatsapp' && (
            <WhatsAppPanel
              rows={rows}
              messages={whatsappQuery.data ?? []}
              waCardId={waCardId}
              setWaCardId={setWaCardId}
              waPhone={waPhone}
              setWaPhone={setWaPhone}
              workspaceOwner={workspaceOwner}
              onSendSuccess={() => {
                whatsappQuery.refetch();
                refresh();
              }}
              toast={toast}
            />
          )}

          {nav === 'team' && (
            <TeamWorkspacesPanel
              users={usersQuery.data ?? []}
              onSelectWorkspace={(ownerName) => {
                setWorkspaceOwner(ownerName);
                setNav('deals');
              }}
              onRefreshUsers={() => usersQuery.refetch()}
              toast={toast}
            />
          )}
        </main>
      </div>

      <InvestorSheet
        id={open}
        open={open !== null}
        onClose={() => setOpen(null)}
        defaultExpertField={defaultExpertFieldFor(expertField)}
        teamOwners={teamOwners}
        onDialContact={(cardId, phone, firm) => {
          setDialCardId(cardId);
          setDialPhone(phone);
          setDialFirm(firm);
          setNav('phone');
        }}
        onOpenWhatsApp={(cardId, phone) => {
          setWaCardId(cardId);
          setWaPhone(phone);
          setNav('whatsapp');
        }}
      />

      <Dialog open={imp} onOpenChange={setImp}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl">Import Deals / Contacts</DialogTitle>
            <DialogDescription>
              Paste CSV text or choose a file. Columns can be in any order; values are matched by header name.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-words rounded bg-muted p-2 font-mono-ui text-[11px]">{TEMPLATE_CSV.trim()}</code>
          <div className="flex gap-2">
            <button
              data-testid="button-template"
              onClick={() => download('sellinghighs-template.csv', TEMPLATE_CSV)}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              Download template
            </button>
            <input
              data-testid="input-csv-file"
              type="file"
              accept=".csv,text/csv"
              className="text-sm"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
              }}
            />
          </div>
          <textarea
            data-testid="input-csv"
            rows={6}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            className="w-full rounded-md border bg-card p-2 font-mono-ui text-xs"
          />
          {importError && (
            <p
              role="alert"
              data-testid="text-import-error"
              className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {importError}
            </p>
          )}
          <button
            data-testid="button-run-import"
            disabled={!csv.trim() || importer.isPending}
            onClick={doImport}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {importer.isPending ? 'Importing...' : 'Import'}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
