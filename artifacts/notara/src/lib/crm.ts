export const STATUSES = ['New', 'Contacted', 'Meeting set', 'Proposal sent', 'Contract review', 'Closed'] as const;
export type StageStatus = typeof STATUSES[number];
export const CLIENT_TYPES = ['new lead', 'cold client', 'active client'] as const;
export type ClientType = typeof CLIENT_TYPES[number];

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
  'expert_field', 'lead_source', 'deal_value', 'expected_close_date',
  'owner', 'client_type', 'source_url', 'fit_score', 'status', 'pitch_subject',
  'pitch_body', 'last_contacted_date', 'next_follow_up_date', 'notes',
] as const;

export const EXPERT_FIELDS = ['Law Firms', 'Chinese Law', 'Indian Law'] as const;
export type ExpertField = typeof EXPERT_FIELDS[number];
export type ExpertFieldFilter = ExpertField | 'All';

export const EXPERT_FIELD_FILTERS = [
  { value: 'Law Firms', label: 'Brazil' },
  { value: 'Chinese Law', label: 'Chinese Law' },
  { value: 'Indian Law', label: 'Indian Law' },
  { value: 'All', label: 'All' },
] as const;

export function expertFieldOf(record: { expert_field?: string | null }): ExpertField {
  return EXPERT_FIELDS.find(field => field === record.expert_field) ?? 'Law Firms';
}

export function filterExpertField<T extends { expert_field?: string | null }>(records: T[], field: ExpertFieldFilter): T[] {
  return field === 'All' ? records : records.filter(record => expertFieldOf(record) === field);
}

export function defaultExpertFieldFor(field: ExpertFieldFilter): ExpertField {
  return field === 'All' ? 'Law Firms' : field;
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
