export const STATUSES = ['New','Enriched','Pitch Drafted','Approved to Send','Contacted','Followed Up','Responded','Meeting Set','Passed','Committed'] as const;
export const TYPES = ['STANDARD','PREMIUM'] as const;
export const FIELDS = ['name','firm','title','email','linkedin_url','website','location','investor_type','typical_check_size','stage_focus','thesis_notes','warm_intro_path','source_url','fit_score','status','pitch_subject','pitch_body','last_contacted_date','next_follow_up_date','notes'] as const;
export const TEMPLATE_CSV = FIELDS.join(',') + '\n';
export const STATUS_TONE: Record<string,string> = {
  'New':'bg-stone-200 text-stone-800','Enriched':'bg-sky-100 text-sky-900','Pitch Drafted':'bg-indigo-100 text-indigo-900','Approved to Send':'bg-amber-100 text-amber-900','Contacted':'bg-teal-100 text-teal-900','Followed Up':'bg-cyan-100 text-cyan-900','Responded':'bg-emerald-100 text-emerald-900','Meeting Set':'bg-emerald-200 text-emerald-950','Passed':'bg-rose-100 text-rose-900','Committed':'bg-[hsl(8_62%_44%)] text-white'};
export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
export function fmtTs(s: string) { const d = new Date(s); return isNaN(+d) ? s : d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
