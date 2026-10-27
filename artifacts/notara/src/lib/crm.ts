export const STATUSES = ['New', 'Contacted', 'Meeting set', 'Proposal sent', 'Contract review', 'Closed'] as const;
export type StageStatus = typeof STATUSES[number];
export const CLIENT_TYPES = ['new lead', 'cold client', 'active client'] as const;
export type ClientType = typeof CLIENT_TYPES[number];
export const TYPES = ['STANDARD', 'PREMIUM'] as const;
export type ExpertTier = typeof TYPES[number];

export type WorkspaceMode = 'sales' | 'experts';

export const WORKSPACE_OPTIONS = [
  {
    id: 'sales' as const,
    label: 'Sales',
    fullLabel: 'Sales Workspace',
    subtitle: 'Law Firms & Deal Pipeline',
    description: 'Immigration law firm deals, Brazil / Chinese Law / Indian Law pipeline & revenue forecast',
  },
  {
    id: 'experts' as const,
    label: 'Experts',
    fullLabel: 'Experts Workspace',
    subtitle: 'Professor & Evaluator Network',
    description: 'University faculty, PhD reviewers & opinion letter signers across all disciplines',
  },
] as const;

export const STAGE_PROBABILITIES: Record<StageStatus, number> = {
  'New': 0.05,
  'Contacted': 0.10,
  'Meeting set': 0.20,
  'Proposal sent': 0.50,
  'Contract review': 0.80,
  'Closed': 1.00,
};

export const FIELDS = [
  'name', 'firm', 'title', 'email', 'phone', 'linkedin_url', 'website', 'location',
  'investor_type', 'expert_field', 'lead_source', 'deal_value', 'expected_close_date',
  'owner', 'client_type', 'typical_check_size', 'stage_focus', 'thesis_notes',
  'warm_intro_path', 'source_url', 'fit_score', 'status', 'pitch_subject',
  'pitch_body', 'last_contacted_date', 'next_follow_up_date', 'notes',
] as const;

export const SALES_FIELDS_LIST = ['Law Firms', 'Chinese Law', 'Indian Law'] as const;
export const EXPERT_DISCIPLINE_LIST = [
  'Dentistry',
  'Economics',
  'Computer Science & AI',
  'Medicine & Healthcare',
  'Biotechnology & Life Sciences',
  'Engineering',
  'Finance & Business',
  'Data Science & Analytics',
  'Cybersecurity',
  'Public Health',
  'Education',
  'Law & Policy',
] as const;
export const EXPERT_FIELDS = ['Law Firms', 'Chinese Law', 'Indian Law', 'Dentistry', 'Economics'] as const;
export type ExpertField = typeof EXPERT_FIELDS[number] | (string & {});
export type ExpertFieldFilter = ExpertField | 'All';

export const ADD_EXPERT_TYPE_OPTION = '__ADD_EXPERT_TYPE__' as const;
export const CUSTOM_EXPERT_TYPES_STORAGE_KEY = 'gcs_crm_custom_expert_types';

export const SALES_FIELD_FILTERS = [
  { value: 'Law Firms' as const, label: 'Brazil' },
  { value: 'Chinese Law' as const, label: 'Chinese Law' },
  { value: 'Indian Law' as const, label: 'Indian Law' },
  { value: 'All' as const, label: 'All Sales' },
] as const;

export const EXPERTS_FIELD_FILTERS = [
  { value: 'Dentistry' as const, label: 'Dentists' },
  { value: 'Economics' as const, label: 'Economists' },
  { value: 'All' as const, label: 'All Experts' },
] as const;

export const EXPERT_FIELD_FILTERS = [
  { value: 'Law Firms' as const, label: 'Brazil' },
  { value: 'Chinese Law' as const, label: 'Chinese Law' },
  { value: 'Indian Law' as const, label: 'Indian Law' },
  { value: 'Dentistry' as const, label: 'Dentists' },
  { value: 'Economics' as const, label: 'Economists' },
  { value: 'All' as const, label: 'All' },
] as const;

export function isSalesField(field?: string | null): boolean {
  const f = (field || 'Law Firms').trim();
  return (SALES_FIELDS_LIST as readonly string[]).includes(f);
}

export function getCustomExpertTypes(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_EXPERT_TYPES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x) => Boolean(x) && !isSalesField(x));
  } catch {
    return [];
  }
}

export function saveCustomExpertType(rawName: string): string {
  const cleaned = rawName.trim();
  if (!cleaned || isSalesField(cleaned)) return cleaned;
  if (typeof window !== 'undefined') {
    try {
      const current = getCustomExpertTypes();
      if (!current.some((x) => x.toLowerCase() === cleaned.toLowerCase())) {
        const next = [...current, cleaned];
        window.localStorage.setItem(CUSTOM_EXPERT_TYPES_STORAGE_KEY, JSON.stringify(next));
      }
      window.dispatchEvent(new CustomEvent('gcs-crm-expert-types-updated', { detail: cleaned }));
    } catch {
      // ignore storage errors
    }
    fetch('/api/crm/expert-types', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleaned }),
    }).catch(() => {});
  }
  return cleaned;
}

export function getAvailableExpertDisciplines(
  records?: Array<{ expert_field?: string | null }>,
  serverCustomTypes?: string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (val?: string | null) => {
    const trimmed = typeof val === 'string' ? val.trim() : '';
    if (!trimmed || isSalesField(trimmed)) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  };
  for (const d of EXPERT_DISCIPLINE_LIST) push(d);
  for (const c of getCustomExpertTypes()) push(c);
  if (serverCustomTypes) {
    for (const s of serverCustomTypes) push(s);
  }
  if (records) {
    for (const r of records) push(r.expert_field);
  }
  return result;
}

export function getDynamicExpertFieldFilters(
  records?: Array<{ expert_field?: string | null }>,
  serverCustomTypes?: string[],
): Array<{ value: ExpertFieldFilter; label: string }> {
  const baseLabels: Record<string, string> = {
    Dentistry: 'Dentists',
    Economics: 'Economists',
  };
  const activeSet = new Set<string>(['Dentistry', 'Economics']);
  for (const c of getCustomExpertTypes()) activeSet.add(c);
  if (serverCustomTypes) {
    for (const s of serverCustomTypes) {
      if (s && !isSalesField(s)) activeSet.add(s.trim());
    }
  }
  if (records) {
    for (const r of records) {
      const f = typeof r.expert_field === 'string' ? r.expert_field.trim() : '';
      if (f && !isSalesField(f)) activeSet.add(f);
    }
  }
  const items: Array<{ value: ExpertFieldFilter; label: string }> = Array.from(activeSet).map((value) => ({
    value,
    label: baseLabels[value] || value,
  }));
  items.push({ value: 'All', label: 'All Experts' });
  return items;
}

export function expertFieldOf(record: { expert_field?: string | null }): ExpertField {
  const raw = typeof record.expert_field === 'string' ? record.expert_field.trim() : '';
  return (raw || 'Law Firms') as ExpertField;
}

export function workspaceOfRecord(record: { expert_field?: string | null }): WorkspaceMode {
  const f = expertFieldOf(record);
  return isSalesField(f) ? 'sales' : 'experts';
}

export function filterExpertField<T extends { expert_field?: string | null }>(records: T[], field: ExpertFieldFilter): T[] {
  return field === 'All' ? records : records.filter(record => expertFieldOf(record) === field);
}

export function filterByWorkspace<T extends { expert_field?: string | null }>(
  records: T[],
  workspace: WorkspaceMode,
  field: ExpertFieldFilter = 'All',
): T[] {
  const scoped = records.filter(r => workspaceOfRecord(r) === workspace);
  return field === 'All' ? scoped : scoped.filter(r => expertFieldOf(r) === field);
}

export function defaultExpertFieldFor(field: ExpertFieldFilter, workspace: WorkspaceMode = 'sales'): ExpertField {
  if (field !== 'All') {
    if (workspace === 'experts' && isSalesField(field)) return 'Dentistry';
    if (workspace === 'sales' && !isSalesField(field)) return 'Law Firms';
    return field;
  }
  return workspace === 'experts' ? 'Dentistry' : 'Law Firms';
}

export const TEMPLATE_CSV = FIELDS.join(',') + '\n';

export const STATUS_TONE: Record<string, string> = {
  'New': 'bg-slate-100 text-slate-800 border border-slate-300',
  'Contacted': 'bg-blue-100 text-blue-900 border border-blue-300',
  'Meeting set': 'bg-indigo-100 text-indigo-900 border border-indigo-300',
  'Proposal sent': 'bg-amber-100 text-amber-900 border border-amber-300',
  'Contract review': 'bg-purple-100 text-purple-900 border border-purple-300',
  'Closed': 'bg-emerald-100 text-emerald-950 border border-emerald-300',
};

export const CLIENT_TYPE_TONE: Record<string, string> = {
  'new lead': 'bg-sky-50 text-sky-800 border border-sky-200',
  'cold client': 'bg-slate-100 text-slate-700 border border-slate-300',
  'active client': 'bg-emerald-50 text-emerald-800 border border-emerald-200',
};

export const TIER_TONE: Record<string, string> = {
  'PREMIUM': 'bg-purple-100 text-purple-900 border border-purple-300',
  'STANDARD': 'bg-teal-50 text-teal-800 border border-teal-200',
};

export function parseDealValue(val: unknown): number {
  if (val === 0 || val === '0' || val === '$0') return 0;
  if (typeof val === 'number') return Number.isFinite(val) && val >= 0 ? val : 0;
  const str = String(val ?? '').replace(/[$,\s]/g, '').trim();
  if (!str) return 0;
  const n = Number(str);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function fmtCurrency(val: unknown): string {
  const n = parseDealValue(val);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

export function todayDateInput(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const p = (k: string) => parts.find((x) => x.type === k)?.value || '';
    return `${p('year')}-${p('month')}-${p('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function toDateInputValue(isoOrDate?: string | null): string {
  if (!isoOrDate) return todayDateInput();
  const trimmed = String(isoOrDate).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const d = new Date(trimmed);
  if (isNaN(+d)) return todayDateInput();
  return d.toISOString().slice(0, 10);
}

export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function fmtTs(s: string) {
  const d = new Date(s);
  return isNaN(+d) ? s : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
