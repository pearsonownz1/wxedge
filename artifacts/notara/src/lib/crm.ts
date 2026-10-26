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
    description: 'University faculty, PhD reviewers & opinion letter signers (Dentists, Economists)',
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
export const EXPERT_DISCIPLINE_LIST = ['Dentistry', 'Economics'] as const;
export const EXPERT_FIELDS = ['Law Firms', 'Chinese Law', 'Indian Law', 'Dentistry', 'Economics'] as const;
export type ExpertField = typeof EXPERT_FIELDS[number];
export type ExpertFieldFilter = ExpertField | 'All';

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

export function expertFieldOf(record: { expert_field?: string | null }): ExpertField {
  return EXPERT_FIELDS.find(field => field === record.expert_field) ?? 'Law Firms';
}

export function workspaceOfRecord(record: { expert_field?: string | null }): WorkspaceMode {
  const f = expertFieldOf(record);
  return f === 'Dentistry' || f === 'Economics' ? 'experts' : 'sales';
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
  if (field !== 'All') return field;
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

export function fmtCurrency(val: unknown): string {
  const n = typeof val === 'number' ? val : Number(String(val ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '$2,500';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
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
