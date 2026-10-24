import { useState } from 'react';
import { Calendar, CheckCircle2, PhoneCall, MessageSquare, Trash2, Play } from 'lucide-react';
import type { Investor, CrmUser } from '@workspace/api-client-react';
import { STATUS_TONE, fmtCurrency, fmtTs } from '@/lib/crm';

const sel = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none';

const Pill = ({ s }: { s: string }) => (
  <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[s] ?? 'bg-slate-100 text-slate-800'}`}>
    {s}
  </span>
);

export function ReportsPanel({
  workspaceOwner,
  dateRange,
  setDateRange,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
  funnel,
  totalDeals,
  totalPipelineVal,
  weightedForecast,
}: {
  workspaceOwner: string;
  dateRange: 'all' | 'this_month' | 'this_quarter' | 'custom';
  setDateRange: (r: 'all' | 'this_month' | 'this_quarter' | 'custom') => void;
  customFrom: string;
  setCustomFrom: (s: string) => void;
  customTo: string;
  setCustomTo: (s: string) => void;
  funnel: Array<{ stage: string; count: number; value: number; probability: number; weighted_value: number; conversion_rate: number }>;
  totalDeals: number;
  totalPipelineVal: number;
  weightedForecast: number;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4 shadow-xs">
        <div>
          <h2 className="font-display text-lg font-bold text-slate-900">
            Per-User Conversion Funnel &amp; Weighted Pipeline Forecast
          </h2>
          <p className="text-xs text-slate-500">
            Filter by team member and date range (This Month, This Quarter, Custom Range, or All Time)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="h-4 w-4 text-slate-500" />
          <select
            data-testid="select-report-range"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as any)}
            className={sel}
          >
            <option value="all">All Time</option>
            <option value="this_month">This Month</option>
            <option value="this_quarter">This Quarter</option>
            <option value="custom">Custom Range</option>
          </select>
          {dateRange === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={sel} />
              <span className="text-xs text-slate-500">to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={sel} />
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-5 shadow-xs">
          <h3 className="mb-4 font-display text-base font-bold text-slate-900">
            Conversion Funnel by Stage ({workspaceOwner === 'All' ? 'All Team' : workspaceOwner})
          </h3>
          <div className="space-y-4">
            {funnel.map((f) => (
              <div key={f.stage} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800">{f.stage}</span>
                  <span className="font-mono-ui text-slate-600">
                    {f.count} deals ({f.conversion_rate}% of pipeline)
                  </span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all"
                    style={{ width: `${Math.max(4, f.conversion_rate)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border bg-white p-5 shadow-xs">
          <h3 className="mb-4 font-display text-base font-bold text-slate-900">
            Weighted Pipeline Forecast (Stage Value × Win Probability)
          </h3>
          <table className="w-full text-sm">
            <thead className="border-b bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Stage</th>
                <th className="px-3 py-2 text-right">Deals</th>
                <th className="px-3 py-2 text-right">Stage Value</th>
                <th className="px-3 py-2 text-right">Win Prob</th>
                <th className="px-3 py-2 text-right">Weighted Forecast</th>
              </tr>
            </thead>
            <tbody>
              {funnel.map((f) => (
                <tr key={f.stage} className="border-b last:border-0">
                  <td className="px-3 py-2.5"><Pill s={f.stage} /></td>
                  <td className="px-3 py-2.5 text-right font-mono-ui">{f.count}</td>
                  <td className="px-3 py-2.5 text-right font-mono-ui">{fmtCurrency(f.value)}</td>
                  <td className="px-3 py-2.5 text-right font-mono-ui text-slate-500">{Math.round(f.probability * 100)}%</td>
                  <td className="px-3 py-2.5 text-right font-mono-ui font-bold text-blue-700">{fmtCurrency(f.weighted_value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 bg-slate-50 font-bold">
              <tr>
                <td className="px-3 py-2.5">Total Forecast</td>
                <td className="px-3 py-2.5 text-right font-mono-ui">{totalDeals}</td>
                <td className="px-3 py-2.5 text-right font-mono-ui">{fmtCurrency(totalPipelineVal)}</td>
                <td className="px-3 py-2.5 text-right font-mono-ui">—</td>
                <td className="px-3 py-2.5 text-right font-mono-ui text-blue-700">{fmtCurrency(weightedForecast)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

export function CampaignsPanel({
  campaigns,
  onLogSuccess,
  toast,
}: {
  campaigns: any[];
  onLogSuccess: () => void;
  toast: any;
}) {
  const [actEmailOrId, setActEmailOrId] = useState('');
  const [actType, setActType] = useState<'email_sent' | 'reply_received' | 'proposal_sent'>('email_sent');
  const [actSubject, setActSubject] = useState('');
  const [actSnippet, setActSnippet] = useState('');
  const [actCampaign, setActCampaign] = useState('law-firms-niw-q4');
  const [actBusy, setActBusy] = useState(false);

  const submitGrokActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actEmailOrId.trim()) return;
    setActBusy(true);
    try {
      const isNum = /^\d+$/.test(actEmailOrId.trim());
      const r = await fetch('/api/crm/activity', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(isNum ? { card_id: Number(actEmailOrId.trim()) } : { email: actEmailOrId.trim() }),
          event_type: actType,
          subject: actSubject.trim(),
          snippet: actSnippet.trim(),
          campaign: actCampaign.trim(),
          actor: 'Grok',
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to log activity');
      }
      setActSubject('');
      setActSnippet('');
      onLogSuccess();
      toast({ title: `Grok logged ${actType} and auto-advanced pipeline stage` });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : 'Activity log failed', variant: 'destructive' });
    } finally {
      setActBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <div className="rounded-xl border bg-white p-5 shadow-xs">
        <h2 className="mb-1 font-display text-lg font-bold text-slate-900">Outbound Campaigns</h2>
        <p className="mb-4 text-xs text-slate-500">
          Automated outbound campaigns run by Grok &amp; @Growth with automatic stage progression
        </p>
        <table className="w-full text-sm">
          <thead className="border-b bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Campaign Tag</th>
              <th className="px-3 py-2 text-left">Segment</th>
              <th className="px-3 py-2 text-right">Emails Sent</th>
              <th className="px-3 py-2 text-right">Replies</th>
              <th className="px-3 py-2 text-right">Proposals</th>
              <th className="px-3 py-2 text-right">Pipeline</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c: any) => (
              <tr key={c.name} className="border-b last:border-0">
                <td className="px-3 py-2.5 font-mono-ui text-xs font-bold text-blue-700">{c.name}</td>
                <td className="px-3 py-2.5 text-xs">{c.field}</td>
                <td className="px-3 py-2.5 text-right font-mono-ui">{c.emails_sent}</td>
                <td className="px-3 py-2.5 text-right font-mono-ui text-emerald-700">{c.replies}</td>
                <td className="px-3 py-2.5 text-right font-mono-ui text-amber-700">{c.proposals_sent}</td>
                <td className="px-3 py-2.5 text-right font-mono-ui font-semibold">{fmtCurrency(c.pipeline_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={submitGrokActivity} className="rounded-xl border bg-white p-5 shadow-xs">
        <h3 className="font-display text-base font-bold text-slate-900">
          Register Grok Outbound Activity (`POST /api/crm/activity`)
        </h3>
        <p className="mb-4 text-xs text-slate-500">
          Logs `email_sent`, `reply_received`, or `proposal_sent` by Card ID or Email and auto-advances stages (`New` → `Contacted`, → `Proposal sent`).
        </p>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Contact Email or Card ID</label>
            <input
              required
              value={actEmailOrId}
              onChange={(e) => setActEmailOrId(e.target.value)}
              placeholder="e.g. millene@apsanlaw.com or 293"
              className={`${sel} w-full`}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Event Type</label>
              <select value={actType} onChange={(e) => setActType(e.target.value as any)} className={`${sel} w-full`}>
                <option value="email_sent">email_sent (→ Contacted)</option>
                <option value="reply_received">reply_received (→ Contacted)</option>
                <option value="proposal_sent">proposal_sent (→ Proposal sent)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Campaign Tag</label>
              <input value={actCampaign} onChange={(e) => setActCampaign(e.target.value)} className={`${sel} w-full`} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Subject</label>
            <input
              value={actSubject}
              onChange={(e) => setActSubject(e.target.value)}
              placeholder="EB-2 NIW Expert Opinion Partnership"
              className={`${sel} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Body / Snippet</label>
            <textarea
              rows={3}
              value={actSnippet}
              onChange={(e) => setActSnippet(e.target.value)}
              placeholder="Message snippet or proposal summary..."
              className={`${sel} w-full`}
            />
          </div>
          <button
            disabled={actBusy}
            className="w-full rounded-lg bg-blue-600 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {actBusy ? 'Logging...' : 'Log Activity & Auto-Advance Stage'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function TelnyxPhonePanel({
  rows,
  calls,
  dialCardId,
  setDialCardId,
  dialPhone,
  setDialPhone,
  dialFirm,
  setDialFirm,
  workspaceOwner,
  onDialSuccess,
  toast,
}: {
  rows: Investor[];
  calls: any[];
  dialCardId: number | '';
  setDialCardId: (v: number | '') => void;
  dialPhone: string;
  setDialPhone: (v: string) => void;
  dialFirm: string;
  setDialFirm: (v: string) => void;
  workspaceOwner: string;
  onDialSuccess: () => void;
  toast: any;
}) {
  const [dialGoal, setDialGoal] = useState('Introduce our 48-hour EB-2 NIW expert opinion letter service and book a 15-min partner call.');
  const [dialBusy, setDialBusy] = useState(false);

  const triggerTelnyxDial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialPhone.trim()) {
      toast({ title: 'Enter a destination phone number', variant: 'destructive' });
      return;
    }
    setDialBusy(true);
    try {
      const r = await fetch('/api/crm/calls/dial', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: dialCardId || undefined,
          to: dialPhone.trim(),
          firm: dialFirm.trim() || dialPhone.trim(),
          goal: dialGoal.trim(),
          actor: workspaceOwner === 'All' ? 'Guy' : workspaceOwner,
        }),
      });
      if (!r.ok) throw new Error('Dial failed');
      toast({ title: `Telnyx Call initiated from +15619031414 → ${dialPhone}` });
      onDialSuccess();
    } catch {
      toast({ title: 'Failed to place Telnyx call', variant: 'destructive' });
    } finally {
      setDialBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.45fr]">
      <form onSubmit={triggerTelnyxDial} className="rounded-xl border bg-white p-5 shadow-xs">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
            <PhoneCall className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900">Telnyx CRM Dialer</h2>
            <p className="text-xs text-slate-500">Caller ID `+15619031414` · App `3077013926030869814`</p>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Select CRM Contact (optional)</label>
            <select
              value={dialCardId}
              onChange={(e) => {
                const cid = e.target.value ? Number(e.target.value) : '';
                setDialCardId(cid);
                const found = rows.find((r) => r.id === cid);
                if (found) {
                  setDialFirm(found.firm || found.name);
                  if ((found as any).phone) setDialPhone((found as any).phone);
                }
              }}
              className={`${sel} w-full`}
            >
              <option value="">-- Choose a deal card or dial directly --</option>
              {rows.slice(0, 120).map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.firm || r.name} ({(r as any).phone || 'no phone on file'})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Destination Phone (+E.164)</label>
            <input
              required
              value={dialPhone}
              onChange={(e) => setDialPhone(e.target.value)}
              placeholder="+14078021717"
              className={`${sel} w-full font-mono-ui`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Firm / Contact Label</label>
            <input
              value={dialFirm}
              onChange={(e) => setDialFirm(e.target.value)}
              placeholder="Symphorien-Saavedra Law"
              className={`${sel} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Call Objective / AI Prompt</label>
            <textarea rows={3} value={dialGoal} onChange={(e) => setDialGoal(e.target.value)} className={`${sel} w-full`} />
          </div>
          <button
            disabled={dialBusy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-emerald-700 disabled:opacity-50"
          >
            <PhoneCall className="h-4 w-4" />
            {dialBusy ? 'Dialing via Telnyx...' : 'Dial Now & Record with Gong AI'}
          </button>
        </div>
      </form>

      <div className="rounded-xl border bg-white p-5 shadow-xs">
        <h2 className="font-display text-lg font-bold text-slate-900">Gong-Style Call Intelligence &amp; Recordings</h2>
        <p className="mb-4 text-xs text-slate-500">
          Every call includes dual-channel MP3 recording, AI Executive Overview, Transcript, and Bullet Action Items / Next Steps.
        </p>
        {calls.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-slate-500">
            No Telnyx calls logged yet. Place a call on the left or run `telnyx_gong_sync.py`.
          </div>
        ) : (
          <div className="space-y-4">
            {calls.map((c: any) => (
              <div key={c.id} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-display text-sm font-bold text-slate-900">
                      {c.firm || c.contact_name || c.to_number}
                    </span>
                    <span className="ml-2 font-mono-ui text-xs text-slate-500">
                      {c.from_number} → {c.to_number} ({c.duration_sec}s)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                      {c.outcome}
                    </span>
                    <span className="font-mono-ui text-[11px] text-slate-500">{fmtTs(c.created_at)}</span>
                  </div>
                </div>
                <div className="mt-2.5 rounded-lg border bg-white p-3 text-xs">
                  <div className="font-bold uppercase tracking-wider text-blue-700">Gong AI Overview</div>
                  <p className="mt-1 text-slate-700">{c.ai_overview}</p>
                  {Array.isArray(c.action_items) && c.action_items.length > 0 && (
                    <div className="mt-2.5">
                      <div className="font-bold uppercase tracking-wider text-emerald-700">Action Items &amp; Next Steps</div>
                      <ul className="mt-1 space-y-1">
                        {c.action_items.map((item: string, idx: number) => (
                          <li key={idx} className="flex items-start gap-1.5 text-slate-800">
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {c.recording_url && (
                    <div className="mt-3 flex items-center gap-2">
                      <Play className="h-3.5 w-3.5 text-blue-600" />
                      <audio controls src={c.recording_url} className="h-8 w-full max-w-md" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export { WhatsAppPanel } from './crm/whatsapp-panel';

export function TeamWorkspacesPanel({
  users,
  onSelectWorkspace,
  onRefreshUsers,
  toast,
}: {
  users: CrmUser[];
  onSelectWorkspace: (ownerName: string) => void;
  onRefreshUsers: () => void;
  toast: any;
}) {
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'member'>('member');
  const [teamBusy, setTeamBusy] = useState(false);

  const createTeamMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserName.trim() || !newUserEmail.trim() || !newUserPassword.trim()) return;
    setTeamBusy(true);
    try {
      const r = await fetch('/api/crm/team', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newUserName.trim(),
          email: newUserEmail.trim(),
          password: newUserPassword,
          role: newUserRole,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || 'Could not create team member');
      }
      setNewUserName('');
      setNewUserEmail('');
      setNewUserPassword('');
      onRefreshUsers();
      toast({ title: `Added team member ${newUserName}` });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : 'Failed to add member', variant: 'destructive' });
    } finally {
      setTeamBusy(false);
    }
  };

  const removeTeamMember = async (uid: number, name: string) => {
    await fetch(`/api/crm/team/${uid}`, { method: 'DELETE', credentials: 'include' });
    onRefreshUsers();
    toast({ title: `Removed ${name}` });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <div className="rounded-xl border bg-white p-5 shadow-xs">
        <h2 className="font-display text-lg font-bold text-slate-900">Team Members &amp; Individual Workspaces</h2>
        <p className="mb-4 text-xs text-slate-500">
          Each team member has a real email + password login and a dedicated workspace for their own deals, funnel, and forecast.
        </p>
        <table className="w-full text-sm">
          <thead className="border-b bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2 text-right">Workspace</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b last:border-0">
                <td className="px-3 py-2.5 font-semibold">{u.name}</td>
                <td className="px-3 py-2.5 font-mono-ui text-xs text-slate-600">{u.email}</td>
                <td className="px-3 py-2.5">
                  <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold uppercase text-blue-700">
                    {u.role}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      onClick={() => onSelectWorkspace(u.name)}
                      className="rounded border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                    >
                      Switch to Workspace
                    </button>
                    <button
                      onClick={() => removeTeamMember(u.id, u.name)}
                      className="rounded border border-red-200 bg-red-50 p-1 text-red-600 hover:bg-red-100"
                      title="Remove user"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={createTeamMember} className="rounded-xl border bg-white p-5 shadow-xs">
        <h3 className="font-display text-base font-bold text-slate-900">Add Team Member Account</h3>
        <p className="mb-4 text-xs text-slate-500">
          Creates a real password account and personal CRM workspace for this team member.
        </p>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Full Name</label>
            <input
              required
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
              placeholder="e.g. Alex Rivera"
              className={`${sel} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Email Address</label>
            <input
              required
              type="email"
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
              placeholder="alex@gcs.org"
              className={`${sel} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Password</label>
            <input
              required
              type="password"
              minLength={4}
              value={newUserPassword}
              onChange={(e) => setNewUserPassword(e.target.value)}
              placeholder="Minimum 4 characters"
              className={`${sel} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Role</label>
            <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as any)} className={`${sel} w-full`}>
              <option value="member">Team Member (Personal Workspace)</option>
              <option value="admin">Admin (All Workspaces &amp; Team Management)</option>
            </select>
          </div>
          <button
            disabled={teamBusy}
            className="w-full rounded-lg bg-blue-600 py-2.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {teamBusy ? 'Creating...' : 'Create Team Member & Workspace'}
          </button>
        </div>
      </form>
    </div>
  );
}
