import { useEffect, useMemo, useRef, useState } from 'react';
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
  ChevronDown,
  Check,
  Briefcase,
  GraduationCap,
  Mail,
  CalendarDays,
  Settings,
} from 'lucide-react';
import {
  STATUSES,
  CLIENT_TYPES,
  TYPES,
  STAGE_PROBABILITIES,
  STATUS_TONE,
  CLIENT_TYPE_TONE,
  TIER_TONE,
  TEMPLATE_CSV,
  SALES_FIELD_FILTERS,
  SALES_FIELDS_LIST,
  ADD_EXPERT_TYPE_OPTION,
  WORKSPACE_OPTIONS,
  getAvailableExpertDisciplines,
  getDynamicExpertFieldFilters,
  saveCustomExpertType,
  filterByWorkspace,
  workspaceOfRecord,
  defaultExpertFieldFor,
  parseDealValue,
  toDateInputValue,
  type ExpertFieldFilter,
  type StageStatus,
  type WorkspaceMode,
  download,
  fmtCurrency,
  fmtTs,
} from '@/lib/crm';
import { InvestorSheet } from '@/components/investor-sheet';
import { EmailsPanel } from '@/components/crm/emails-panel';
import { CalendarPanel } from '@/components/crm/calendar-panel';
import { OutlookSettings } from '@/components/crm/outlook-settings';
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
const sel = 'h-9 rounded-[4px] border border-[#e4e7ec] bg-white px-2.5 text-[13px] text-[#0b1220] outline-none focus:border-[#1f5eff]';
const isForbidden = (e: unknown) => (e as any)?.status === 403;

type NavSection = 'overview' | 'contacts' | 'deals' | 'emails' | 'calendar' | 'reports' | 'campaigns' | 'phone' | 'whatsapp' | 'team' | 'settings';

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

const TierBadge = ({ t }: { t?: string }) => {
  const val = t === "PREMIUM" ? "PREMIUM" : "STANDARD";
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TIER_TONE[val] ?? "bg-slate-100 text-slate-700"}`}>
      {val}
    </span>
  );
};

function getInitialWorkspace(): WorkspaceMode {
  if (typeof window === "undefined") return "sales";
  const params = new URLSearchParams(window.location.search);
  const q = params.get("workspace")?.toLowerCase();
  if (q === "experts" || q === "expert") return "experts";
  if (q === "sales" || q === "sale") return "sales";
  return window.localStorage.getItem("sellinghighs_workspace_mode") === "experts" ? "experts" : "sales";
}

const Fit = ({ n }: { n: number }) => (
  <span className="font-mono-ui text-xs text-amber-500" title={`Fit ${n}/5`}>
    {'●'.repeat(n)}
    <span className="opacity-25">{'●'.repeat(Math.max(0, 5 - n))}</span>
  </span>
);

export default function Dashboard() {
  const [workspaceMode, setWorkspaceModeState] = useState<WorkspaceMode>(getInitialWorkspace);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const [ft, setFt] = useState("");
  const [nav, setNav] = useState<NavSection>("deals");

  const setWorkspaceMode = (mode: WorkspaceMode) => {
    setWorkspaceModeState(mode);
    setExpertField("All");
    setFs("");
    setFct("");
    setFt("");
    setWorkspaceMenuOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("sellinghighs_workspace_mode", mode);
      const url = new URL(window.location.href);
      url.searchParams.set("workspace", mode);
      window.history.replaceState({}, "", url.toString());
    }
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWorkspaceMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
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
    const p: Record<string, string> = { workspace: workspaceMode };
    if (expertField !== 'All') p.expert_field = expertField;
    if (workspaceOwner !== 'All') p.owner = workspaceOwner;
    if (dateRange !== 'all') p.range = dateRange;
    if (dateRange === 'custom') {
      p.from = customFrom;
      p.to = customTo;
    }
    return Object.keys(p).length ? (p as any) : undefined;
  }, [workspaceMode, expertField, workspaceOwner, dateRange, customFrom, customTo]);

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

  const expertTypesQuery = useQuery<{ expert_types: string[]; custom_expert_types: string[] }>({
    queryKey: ['/api/crm/expert-types'],
    queryFn: async () => {
      const r = await fetch('/api/crm/expert-types', { credentials: 'include' });
      if (!r.ok) return { expert_types: [], custom_expert_types: [] };
      return r.json();
    },
  });

  const [expertTypesVersion, setExpertTypesVersion] = useState(0);
  const [headerAddingType, setHeaderAddingType] = useState(false);
  const [headerNewTypeInput, setHeaderNewTypeInput] = useState('');
  const [importExpertField, setImportExpertField] = useState<string>('');
  const [importAddingType, setImportAddingType] = useState(false);
  const [importNewTypeInput, setImportNewTypeInput] = useState('');

  useEffect(() => {
    const onTypesUpdated = () => {
      setExpertTypesVersion((v) => v + 1);
      expertTypesQuery.refetch();
    };
    window.addEventListener('gcs-crm-expert-types-updated', onTypesUpdated);
    return () => window.removeEventListener('gcs-crm-expert-types-updated', onTypesUpdated);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outlook = params.get('outlook');
    if (!outlook) return;
    setNav('settings');
    setOutlookNotice(outlook === 'connected' ? 'connected' : params.get('reason') || 'oauth_failed');
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState({}, '', `${url.pathname}${url.hash}`);
  }, []);

  const update = useBrowserUpdateInvestor();
  const importer = useBrowserImportInvestors();
  const [view, setView] = useState<'board' | 'table'>('board');
  const [q, setQ] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [mailCompose, setMailCompose] = useState<{ to: string; investorId: number; nonce: number } | null>(null);
  const [outlookNotice, setOutlookNotice] = useState('');
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

  const workspaceCounts = useMemo(() => {
    const all = list.data ?? [];
    let sales = 0;
    let experts = 0;
    for (const r of all) {
      if (workspaceOfRecord(r) === "experts") experts++;
      else sales++;
    }
    return { sales, experts };
  }, [list.data]);

  const fieldRows = useMemo(() => {
    let base = filterByWorkspace(list.data ?? [], workspaceMode, expertField);
    if (workspaceOwner !== "All") {
      const target = workspaceOwner.toLowerCase();
      base = base.filter((i) => String((i as any).owner || "Guy").toLowerCase() === target);
    }
    return base;
  }, [list.data, workspaceMode, expertField, workspaceOwner]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const r = fieldRows.filter(
      (i) =>
        (!fs || i.status === fs) &&
        (!fct || ((i as any).client_type || "new lead") === fct) &&
        (!ft || (i.investor_type || "STANDARD") === ft) &&
        (!ff || i.fit_score === +ff) &&
        (!s ||
          [
            i.name,
            i.firm,
            i.title,
            i.email,
            i.location,
            i.stage_focus,
            i.thesis_notes,
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
  }, [fieldRows, q, fs, fct, ft, ff, sort]);

  const kpiMetrics = useMemo(() => {
    const s = sum.data;
    const valOf = (i: Investor) => parseDealValue((i as any).deal_value);
    const totalPipelineVal = rows.reduce((acc, i) => acc + valOf(i), 0);
    const weightedForecast = Math.round(
      rows.reduce((acc, i) => {
        const prob = STAGE_PROBABILITIES[i.status as StageStatus] ?? 0.05;
        return acc + valOf(i) * prob;
      }, 0),
    );
    const closedRows = rows.filter((i) => i.status === 'Closed');
    let computedAvgDays: number | null = null;
    if (closedRows.length > 0) {
      const daysList = closedRows.map((i) => {
        const c = Date.parse(i.created_at || '');
        const closedAct = [...(i.activity_log || [])].reverse().find((a) => a.kind === 'status:Closed');
        const closeDateStr = (i as any).expected_close_date && /^\d{4}-\d{2}-\d{2}$/.test((i as any).expected_close_date)
          ? `${(i as any).expected_close_date}T12:00:00.000Z`
          : (closedAct?.timestamp || i.updated_at || '');
        const u = Date.parse(closeDateStr);
        return !Number.isNaN(c) && !Number.isNaN(u) ? Math.max(0, Math.round((u - c) / (1000 * 60 * 60 * 24))) : 0;
      });
      computedAvgDays = Math.round((daysList.reduce((a, b) => a + b, 0) / daysList.length) * 10) / 10;
    } else {
      const withExpected = rows.filter((i) => i.created_at && (i as any).expected_close_date && /^\d{4}-\d{2}-\d{2}$/.test((i as any).expected_close_date));
      if (withExpected.length > 0) {
        const daysList = withExpected.map((i) => {
          const c = Date.parse(i.created_at || '');
          const u = Date.parse(`${(i as any).expected_close_date}T12:00:00.000Z`);
          return !Number.isNaN(c) && !Number.isNaN(u) ? Math.max(0, Math.round((u - c) / (1000 * 60 * 60 * 24))) : 0;
        });
        computedAvgDays = Math.round((daysList.reduce((a, b) => a + b, 0) / daysList.length) * 10) / 10;
      }
    }
    const avgDays = computedAvgDays ?? s?.avg_days_to_close ?? 0;
    const closedCount = rows.filter((i) => i.status === 'Closed').length;
    const meetingReached = rows.filter((i) =>
      ['Meeting set', 'Proposal sent', 'Contract review', 'Closed', 'Awaiting Gusto Setup'].includes(i.status),
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

    const premiumCount = rows.filter((i) => i.investor_type === "PREMIUM").length;
    const standardCount = rows.length - premiumCount;
    const pitchReadyCount = rows.filter((i) => Boolean(i.pitch_subject || i.pitch_body)).length;
    return { avgDays, weightedForecast, totalPipelineVal, convRate, funnel, premiumCount, standardCount, pitchReadyCount };
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
      download('gcs-crm.csv', await browserExportInvestors());
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    }
  };

  const doImport = () => {
    setImportError('');
    let chosenField = importExpertField;
    if (importAddingType && importNewTypeInput.trim()) {
      chosenField = saveCustomExpertType(importNewTypeInput.trim());
      setImportExpertField(chosenField);
      setImportAddingType(false);
      setImportNewTypeInput('');
    }
    importer.mutate(
      { data: { csv, ...(chosenField && chosenField !== ADD_EXPERT_TYPE_OPTION ? { default_expert_field: chosenField } : {}) } },
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

  const isExperts = workspaceMode === "experts";
  const availableExpertTypes = useMemo(
    () => getAvailableExpertDisciplines(list.data, expertTypesQuery.data?.expert_types),
    [list.data, expertTypesQuery.data, expertTypesVersion],
  );
  const activeFieldFilters = useMemo(
    () => (isExperts ? getDynamicExpertFieldFilters(list.data, expertTypesQuery.data?.custom_expert_types) : SALES_FIELD_FILTERS),
    [isExperts, list.data, expertTypesQuery.data, expertTypesVersion],
  );

  const signedInName = sessionData?.user?.name || 'Admin';
  const signedInEmail = sessionData?.user?.email || '';
  const signedInInitials = signedInName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'G';
  const pageCopy: Record<NavSection, { title: string; subtitle: string }> = {
    overview: { title: 'Overview', subtitle: isExperts ? 'Faculty pipeline and recruitment.' : 'Law firm pipeline and forecast.' },
    contacts: { title: isExperts ? 'Expert Directory' : 'People', subtitle: isExperts ? 'Faculty contacts in this workspace.' : 'Contacts in this workspace.' },
    deals: { title: isExperts ? 'Experts' : 'Deals', subtitle: isExperts ? 'Expert faculty on the board.' : 'Open deals on the board.' },
    emails: { title: 'Emails', subtitle: 'Inbox, sent mail, drafts, and templates.' },
    calendar: { title: 'Calendar', subtitle: 'Meetings from the connected calendar.' },
    reports: { title: isExperts ? 'Recruitment Funnel' : 'Reports', subtitle: 'Forecast and stage conversion.' },
    campaigns: { title: isExperts ? 'Expert Campaigns' : 'Campaigns', subtitle: 'Outbound activity by campaign.' },
    phone: { title: 'Dialer', subtitle: 'Calls placed from this workspace.' },
    whatsapp: { title: 'WhatsApp', subtitle: 'Messages with people in this workspace.' },
    team: { title: 'Team', subtitle: 'Per-person workspaces and teammates.' },
    settings: { title: 'Settings', subtitle: 'Email and calendar accounts.' },
  };
  const navGroups: Array<{ label: string; items: Array<{ id: NavSection; label: string; icon: any; badge?: string | number }> }> = [
    {
      label: 'Records',
      items: [
        { id: 'contacts', label: isExperts ? 'Expert Directory' : 'People', icon: Users, badge: fieldRows.length },
        { id: 'deals', label: isExperts ? 'Experts' : 'Deals', icon: Kanban, badge: rows.length },
      ],
    },
    {
      label: 'Communication',
      items: [
        { id: 'emails', label: 'Emails', icon: Mail },
        { id: 'calendar', label: 'Calendar', icon: CalendarDays },
        { id: 'whatsapp', label: 'WhatsApp', icon: MessageSquare, badge: whatsappQuery.data?.length || 0 },
        { id: 'phone', label: 'Dialer', icon: PhoneCall, badge: callsQuery.data?.length || 0 },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { id: 'overview', label: 'Overview', icon: Home },
        { id: 'reports', label: isExperts ? 'Recruitment Funnel' : 'Reports', icon: BarChart3 },
        { id: 'campaigns', label: isExperts ? 'Expert Campaigns' : 'Campaigns', icon: Send, badge: campaignsQuery.data?.length || 3 },
        { id: 'team', label: 'Team', icon: UserCheck, badge: usersQuery.data?.length || 4 },
      ],
    },
  ];
  const renderNav = (item: { id: NavSection; label: string; icon: any; badge?: string | number }) => {
    const Icon = item.icon;
    const active = nav === item.id;
    return (
      <button
        key={item.id}
        type="button"
        data-testid={`nav-${item.id}`}
        onClick={() => { setNav(item.id); setNavOpen(false); }}
        className={`flex w-full items-center gap-2.5 rounded-[4px] px-2.5 py-2 text-left text-sm ${active ? 'bg-[#eaf0ff] font-medium text-[#1f5eff]' : 'text-[#374151] hover:bg-white'}`}
      >
        <Icon className="size-[17px] shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.badge !== undefined && (
          <span className={`rounded-[9px] px-[7px] text-[11px] ${active ? 'bg-white text-[#1f5eff]' : 'bg-[#eef0f4] text-[#5b6474]'}`}>{item.badge}</span>
        )}
      </button>
    );
  };

  return (
    <div className="crm-app flex min-h-[100dvh] bg-[#f6f7f9] text-[#0b1220]">
      {navOpen && <button type="button" aria-label="Close menu" className="fixed inset-0 z-30 bg-[#0b1220]/30 md:hidden" onClick={() => setNavOpen(false)} />}
      <aside className={`${navOpen ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden'} w-[220px] shrink-0 flex-col border-r border-[#e4e7ec] bg-[#f4f6f8] px-3.5 py-4 md:static md:flex`}>
        <div ref={workspaceMenuRef} className="relative pb-3">
          <button
            type="button"
            data-testid="workspace-dropdown-trigger"
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="listbox"
            onClick={() => setWorkspaceMenuOpen((o) => !o)}
            className="flex w-full items-center gap-2.5 rounded-[4px] border border-[#e4e7ec] bg-white px-2.5 py-2 text-left hover:border-[#1f5eff]"
          >
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] text-white ${isExperts ? 'bg-purple-600' : 'bg-[#1f5eff]'}`}>
              {isExperts ? <GraduationCap className="h-4 w-4" strokeWidth={1.5} /> : <Briefcase className="h-4 w-4" strokeWidth={1.5} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-[#0b1220]">GCS CRM</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${isExperts ? 'bg-purple-100 text-purple-800' : 'bg-[#eaf0ff] text-[#1f5eff]'}`}>
                  {isExperts ? 'Experts' : 'Sales'}
                </span>
              </div>
              <div className="truncate text-[11px] text-[#5b6474]">
                {isExperts ? 'Experts Workspace (Faculty)' : 'Sales Workspace (Law Firms)'}
              </div>
            </div>
            <ChevronDown className={`h-4 w-4 shrink-0 text-[#5b6474] ${workspaceMenuOpen ? 'rotate-180' : ''}`} strokeWidth={1.5} />
          </button>
          {workspaceMenuOpen && (
            <div
              role="listbox"
              aria-label="Select Workspace"
              data-testid="workspace-dropdown-menu"
              className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-[4px] border border-[#e4e7ec] bg-white p-1.5 shadow-sm"
            >
              <div className="px-2.5 py-1.5 text-[11px] uppercase tracking-[0.06em] text-[#5b6474]">Switch Workspace</div>
              {WORKSPACE_OPTIONS.map((ws) => {
                const active = workspaceMode === ws.id;
                const count = ws.id === 'sales' ? workspaceCounts.sales : workspaceCounts.experts;
                const WsIcon = ws.id === 'sales' ? Briefcase : GraduationCap;
                return (
                  <button
                    key={ws.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-testid={`workspace-option-${ws.id}`}
                    onClick={() => setWorkspaceMode(ws.id)}
                    className={`flex w-full items-start gap-2.5 rounded-[4px] px-2.5 py-2 text-left ${active ? 'bg-[#eaf0ff] text-[#1f5eff]' : 'text-[#374151] hover:bg-[#f6f7f9]'}`}
                  >
                    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] text-white ${ws.id === 'sales' ? 'bg-[#1f5eff]' : 'bg-purple-600'}`}>
                      <WsIcon className="h-4 w-4" strokeWidth={1.5} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-medium text-[#0b1220]">{ws.fullLabel}</span>
                        <span className="rounded-[9px] bg-[#eef0f4] px-2 py-0.5 text-[10px] text-[#5b6474]">{count}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] leading-snug text-[#5b6474]">{ws.subtitle}</div>
                    </div>
                    {active && <Check className="mt-1 h-4 w-4 shrink-0 text-[#1f5eff]" strokeWidth={1.5} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <label className="mb-1 flex h-9 items-center justify-between rounded-[4px] border border-[#e4e7ec] bg-white px-2.5 text-[13px] text-[#5b6474]">
          <span className="sr-only">Search records</span>
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search records…" className="w-full bg-transparent outline-none placeholder:text-[#5b6474]" />
          <span className="text-[11px]">⌘K</span>
        </label>
        <nav className="flex-1 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="mx-2 mt-[18px] mb-1.5 text-[11.5px] uppercase tracking-[0.06em] text-[#5b6474]">{group.label}</p>
              <div className="space-y-0.5">{group.items.map(renderNav)}</div>
            </div>
          ))}
        </nav>
        <div className="mt-auto border-t border-[#e4e7ec] pt-2">
          {renderNav({ id: 'settings', label: 'Settings', icon: Settings })}
          <div className="relative">
            <button type="button" aria-expanded={accountOpen} onClick={() => setAccountOpen((open) => !open)} className="flex w-full items-center gap-2.5 px-2 py-2 text-left text-[13.5px]">
              <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-[#eaf0ff] text-xs font-medium text-[#1f5eff]">{signedInInitials}</span>
              <span className="min-w-0">
                <span className="block truncate">{signedInName}</span>
                <span className="block truncate text-xs text-[#5b6474]">{signedInEmail || 'Signed in'}</span>
              </span>
            </button>
            {accountOpen && (
              <div className="absolute bottom-full left-0 z-20 mb-2 w-52 rounded-[4px] border border-[#e4e7ec] bg-white p-1 text-sm shadow-sm">
                <button type="button" onClick={logout} className="flex w-full items-center gap-2 rounded-[3px] px-3 py-2 text-left hover:bg-[#f6f7f9]">
                  <LogOut className="size-[15px]" strokeWidth={1.5} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[#e4e7ec] bg-white px-4 py-3 md:hidden">
          <button type="button" className="text-sm font-medium" onClick={() => setNavOpen(true)}>Menu</button>
          <span className="text-sm font-medium">GCS CRM</span>
          <button type="button" className="text-sm text-[#5b6474]" onClick={logout}>Sign out</button>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-9 md:py-7">
        <div className="mb-[18px] flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[26px] font-medium tracking-[-0.6px]">{pageCopy[nav].title}</h1>
            <p className="mt-1 text-sm text-[#5b6474]">{pageCopy[nav].subtitle}</p>
          </div>
        </div>
        <header className="mb-[18px] flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] uppercase tracking-[0.06em] text-[#5b6474]">Workspace</span>
            <select
              data-testid="select-workspace-mode"
              aria-label="Workspace mode"
              value={workspaceMode}
              onChange={(e) => setWorkspaceMode(e.target.value as WorkspaceMode)}
              className={sel}
            >
              <option value="sales">Sales Workspace ({workspaceCounts.sales} Law Firms)</option>
              <option value="experts">Experts Workspace ({workspaceCounts.experts} Professors)</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11.5px] uppercase tracking-[0.06em] text-[#5b6474]">Member</span>
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

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] uppercase tracking-[0.06em] text-[#5b6474]">
              {isExperts ? "Discipline" : "Market"}
            </span>
            <div role="group" aria-label={isExperts ? "DISCIPLINE" : "MARKET / REGION"} className="flex flex-wrap rounded-[4px] border border-[#e4e7ec] bg-white p-0.5">
              {activeFieldFilters.map(({ value, label }) => (
                <button
                  key={value}
                  data-testid={`filter-field-${value}`}
                  aria-pressed={expertField === value}
                  onClick={() => setExpertField(value)}
                  className={`rounded-[3px] px-2.5 py-1 text-xs font-medium transition ${
                    expertField === value
                      ? isExperts
                        ? "bg-purple-100 text-purple-800"
                        : "bg-[#eaf0ff] text-[#1f5eff]"
                      : "text-[#5b6474] hover:text-[#0b1220]"
                  }`}
                >
                  {label}
                </button>
              ))}
              {isExperts && (
                <button
                  type="button"
                  data-testid="button-header-add-expert-type"
                  onClick={() => setHeaderAddingType((prev) => !prev)}
                  className="flex items-center gap-0.5 rounded-md px-2.5 py-1 text-xs font-semibold text-purple-700 hover:bg-purple-100/70"
                >
                  <Plus className="h-3 w-3" /> Add Expert Type
                </button>
              )}
            </div>
            {isExperts && headerAddingType && (
              <div className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-2 py-1">
                <input
                  data-testid="input-header-expert-type"
                  type="text"
                  value={headerNewTypeInput}
                  onChange={(e) => setHeaderNewTypeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && headerNewTypeInput.trim()) {
                      const saved = saveCustomExpertType(headerNewTypeInput.trim());
                      setExpertField(saved);
                      setHeaderNewTypeInput('');
                      setHeaderAddingType(false);
                      toast({ title: `Added expert type "${saved}"` });
                    }
                  }}
                  placeholder="New expert type..."
                  className="w-40 rounded border border-purple-300 bg-white px-2 py-0.5 text-xs focus:outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  data-testid="button-header-confirm-expert-type"
                  onClick={() => {
                    if (!headerNewTypeInput.trim()) return;
                    const saved = saveCustomExpertType(headerNewTypeInput.trim());
                    setExpertField(saved);
                    setHeaderNewTypeInput('');
                    setHeaderAddingType(false);
                    toast({ title: `Added expert type "${saved}"` });
                  }}
                  className="rounded bg-purple-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-purple-700"
                >
                  Add
                </button>
              </div>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              data-testid="button-deduplicate"
              onClick={purgeDuplicates}
              className="inline-flex h-9 items-center gap-1 rounded-[4px] border border-[#e4e7ec] bg-white px-3 text-[13px] font-medium text-[#0b1220] hover:bg-[#f6f7f9]"
            >
              <Sparkles className="h-3.5 w-3.5 text-blue-600" /> Remove Duplicates
            </button>
            <button
              data-testid="button-new"
              onClick={() => setOpen('new')}
              className="inline-flex h-10 items-center gap-1 rounded-[4px] bg-[#1f5eff] px-[18px] text-sm font-medium text-white hover:bg-[#1648cc]"
            >
              <Plus className="h-4 w-4" /> {isExperts ? "Add Expert" : "Add Deal"}
            </button>
            <button
              data-testid="button-import"
              onClick={() => setImp(true)}
              className="inline-flex h-9 items-center gap-1 rounded-[4px] border border-[#e4e7ec] bg-white px-3 text-[13px] font-medium text-[#0b1220] hover:bg-[#f6f7f9]"
            >
              <Upload className="h-3.5 w-3.5" /> Import
            </button>
            <button
              data-testid="button-export"
              onClick={doExport}
              className="inline-flex h-9 items-center gap-1 rounded-[4px] border border-[#e4e7ec] bg-white px-3 text-[13px] font-medium text-[#0b1220] hover:bg-[#f6f7f9]"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
          </div>
        </header>

        {/* Top Bar KPIs — Tailored to Sales vs. Experts Workspace */}
        {nav !== 'emails' && nav !== 'calendar' && nav !== 'settings' && (isExperts ? (
          <section className="mb-[22px] grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-purple-700">
                1. Total Expert Faculty
              </div>
              <div className="mt-1 font-display text-2xl font-bold text-purple-950" data-testid="kpi-total-experts">
                {rows.length} Professors
              </div>
              <div className="mt-0.5 text-[11px] text-purple-700/80">
                {kpiMetrics.standardCount} Standard · {kpiMetrics.premiumCount} Premium
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                2. Deans &amp; Named Chairs (Premium)
              </div>
              <div className="mt-1 font-display text-2xl font-bold text-slate-900" data-testid="kpi-premium-experts">
                {kpiMetrics.premiumCount} Chairs
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                Department chairs, deans &amp; center directors ($400/letter)
              </div>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                3. Pitch-Ready &amp; Verified
              </div>
              <div className="mt-1 font-display text-2xl font-bold text-blue-900" data-testid="kpi-pitch-ready-experts">
                {kpiMetrics.pitchReadyCount} Ready
              </div>
              <div className="mt-0.5 text-[11px] text-blue-700/80">
                Custom research-matched outreach letters drafted
              </div>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
                4. Honorarium Rate Structure
              </div>
              <div className="mt-1 font-display text-2xl font-bold text-emerald-900" data-testid="kpi-expert-honorarium">
                $200 / $400
              </div>
              <div className="mt-0.5 text-[11px] text-emerald-700/80">
                Standard ($200/letter) · Premium ($400/letter)
              </div>
            </div>
          </section>
        ) : (
        <section className="mb-[22px] grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-[4px] border border-[#e4e7ec] bg-white p-[18px]">
            <div className="text-[12.5px] font-medium text-[#5b6474]">
              Average days to close
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
        ))}

        <main>
          {nav === 'emails' && <EmailsPanel composeSeed={mailCompose} />}
          {nav === 'calendar' && <CalendarPanel />}
          {nav === 'settings' && <OutlookSettings notice={outlookNotice} />}
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
                {isExperts ? (
                  <select data-testid="filter-type" className={sel} value={ft} onChange={(e) => setFt(e.target.value)}>
                    <option value="">All academic tiers</option>
                    {TYPES.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select data-testid="filter-client-type" className={sel} value={fct} onChange={(e) => setFct(e.target.value)}>
                    <option value="">All client types</option>
                    {CLIENT_TYPES.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                )}
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
                  {STATUSES.filter((st) => workspaceMode === 'experts' || st !== 'Awaiting Gusto Setup').map((st) => {
                    const col = rows.filter((i) => i.status === st);
                    const colVal = col.reduce((acc, i) => acc + parseDealValue((i as any).deal_value), 0);
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
                                  {isExperts ? (
                                    <span className="font-mono-ui text-[11px] font-bold text-purple-700">
                                      {i.typical_check_size || (i.investor_type === "PREMIUM" ? "$400/letter" : "$200/letter")}
                                    </span>
                                  ) : (
                                    <span className="font-mono-ui text-xs font-bold text-blue-700">
                                      {fmtCurrency((i as any).deal_value)}
                                    </span>
                                  )}
                                </div>
                                <div className="truncate text-xs text-slate-500">{i.firm}</div>
                                {isExperts && i.title && (
                                  <div className="mt-0.5 truncate text-[11px] text-slate-500">{i.title}</div>
                                )}

                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  {isExperts ? (
                                    <>
                                      <TierBadge t={i.investor_type} />
                                      <span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-800">
                                        {i.expert_field}
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <ClientTypeBadge t={(i as any).client_type} />
                                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                                        Owner: {(i as any).owner || "Guy"}
                                      </span>
                                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                        {(i as any).lead_source || "Outbound"}
                                      </span>
                                    </>
                                  )}
                                </div>
                                {isExperts && i.stage_focus && (
                                  <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-slate-500">
                                    {i.stage_focus}
                                  </div>
                                )}

                                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                                  <span>{i.expert_field}</span>
                                  <Fit n={i.fit_score} />
                                </div>
                                <div className="mt-1 flex items-center justify-between font-mono-ui text-[10px] text-slate-400">
                                  <span>Created: {toDateInputValue(i.created_at)}</span>
                                  {((i as any).expected_close_date || i.next_follow_up_date) && (
                                    <span className="text-blue-600">
                                      Close: {(i as any).expected_close_date || i.next_follow_up_date}
                                    </span>
                                  )}
                                </div>
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
                            {isExperts ? <TierBadge t={i.investor_type} /> : <ClientTypeBadge t={(i as any).client_type} />}
                          </td>
                          <td className="px-3 py-2.5 font-mono-ui font-semibold text-blue-700">
                            {isExperts ? (i.typical_check_size || (i.investor_type === "PREMIUM" ? "$400/letter" : "$200/letter")) : fmtCurrency((i as any).deal_value)}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">{isExperts ? (i.stage_focus || i.expert_field) : ((i as any).lead_source || "Outbound")}</td>
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
      </div>

      <InvestorSheet
        id={open}
        open={open !== null}
        onClose={() => setOpen(null)}
        defaultExpertField={defaultExpertFieldFor(expertField, workspaceMode)}
        workspaceMode={workspaceMode}
        teamOwners={teamOwners}
        availableExpertTypes={availableExpertTypes}
        onExpertTypeAdded={(newType) => {
          setExpertTypesVersion((v) => v + 1);
          expertTypesQuery.refetch();
          if (workspaceMode === 'experts') setExpertField(newType);
        }}
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
        onComposeEmail={(address, id) => {
          setMailCompose({ to: address, investorId: id, nonce: Date.now() });
          setOpen(null);
          setNav('emails');
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
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">
              {isExperts ? 'Expert Type / Discipline for Imported Leads' : 'Category / Expert Type for Imported Leads'}
            </label>
            <select
              data-testid="select-import-expert-field"
              value={importAddingType ? ADD_EXPERT_TYPE_OPTION : importExpertField}
              onChange={(e) => {
                if (e.target.value === ADD_EXPERT_TYPE_OPTION) {
                  setImportAddingType(true);
                } else {
                  setImportAddingType(false);
                  setImportExpertField(e.target.value);
                }
              }}
              className={`${sel} w-full`}
            >
              <option value="">Use CSV expert_field column (or default)</option>
              <optgroup label="Expert Disciplines">
                {availableExpertTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Sales Markets">
                {SALES_FIELDS_LIST.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </optgroup>
              <option value={ADD_EXPERT_TYPE_OPTION}>+ Add Expert Type</option>
            </select>
            {importAddingType && (
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  data-testid="input-import-custom-expert-type"
                  type="text"
                  value={importNewTypeInput}
                  onChange={(e) => setImportNewTypeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && importNewTypeInput.trim()) {
                      e.preventDefault();
                      const saved = saveCustomExpertType(importNewTypeInput.trim());
                      setImportExpertField(saved);
                      setImportAddingType(false);
                      setImportNewTypeInput('');
                      toast({ title: `Added expert type "${saved}"` });
                    }
                  }}
                  placeholder="Enter new expert type (e.g. Civil Engineering)..."
                  className={`${sel} flex-1`}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!importNewTypeInput.trim()) return;
                    const saved = saveCustomExpertType(importNewTypeInput.trim());
                    setImportExpertField(saved);
                    setImportAddingType(false);
                    setImportNewTypeInput('');
                    toast({ title: `Added expert type "${saved}"` });
                  }}
                  className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
                >
                  Add
                </button>
              </div>
            )}
          </div>
          <code className="block break-words rounded bg-muted p-2 font-mono-ui text-[11px]">{TEMPLATE_CSV.trim()}</code>
          <div className="flex gap-2">
            <button
              data-testid="button-template"
              onClick={() => download('gcs-crm-template.csv', TEMPLATE_CSV)}
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
