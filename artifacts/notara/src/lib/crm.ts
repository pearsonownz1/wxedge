export const STATUSES = ['New','Contacted','Followed Up','Responded','Meeting Set','Closed'] as const;
export const TYPES = ['STANDARD','PREMIUM'] as const;
export const FIELDS = ['name','firm','title','email','linkedin_url','website','location','investor_type','expert_field','typical_check_size','stage_focus','thesis_notes','warm_intro_path','source_url','fit_score','status','pitch_subject','pitch_body','last_contacted_date','next_follow_up_date','notes'] as const;
export const EXPERT_FIELDS = ['Dentistry', 'Economics', 'Law Firms', 'Chinese Law', 'Indian Law', 'Brazilian Law'] as const;
export type ExpertField = typeof EXPERT_FIELDS[number];
export type ExpertFieldFilter = ExpertField | 'All';
export const EXPERT_FIELD_FILTERS = [
  { value: 'Dentistry', label: 'Dentists' },
  { value: 'Economics', label: 'Economists' },
  { value: 'Law Firms', label: 'Law Firms' },
  { value: 'Chinese Law', label: 'Chinese Law' },
  { value: 'Indian Law', label: 'Indian Law' },
  { value: 'Brazilian Law', label: 'Brazilian Law' },
  { value: 'All', label: 'All' },
] as const;
export function expertFieldOf(record: { expert_field?: string | null }): ExpertField {
  return EXPERT_FIELDS.find(field => field === record.expert_field) ?? 'Dentistry';
}
export function filterExpertField<T extends { expert_field?: string | null }>(records: T[], field: ExpertFieldFilter): T[] {
  return field === 'All' ? records : records.filter(record => expertFieldOf(record) === field);
}
export function defaultExpertFieldFor(field: ExpertFieldFilter): ExpertField {
  return field === 'All' ? 'Dentistry' : field;
}
export const TEMPLATE_CSV = FIELDS.join(',') + '\n';
export const STATUS_TONE: Record<string,string> = {
  'New':'bg-stone-200 text-stone-800','Contacted':'bg-teal-100 text-teal-900','Followed Up':'bg-cyan-100 text-cyan-900','Responded':'bg-emerald-100 text-emerald-900','Meeting Set':'bg-emerald-200 text-emerald-950','Closed':'bg-stone-300 text-stone-900'};
export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
export function fmtTs(s: string) { const d = new Date(s); return isNaN(+d) ? s : d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
