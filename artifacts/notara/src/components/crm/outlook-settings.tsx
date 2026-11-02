import { useEffect, useState } from "react";
import { Calendar, Check, ExternalLink, Mail, RefreshCw, Unplug } from "lucide-react";
import { outlookFetch, type OutlookAccountStatus } from "@/lib/outlook";

const btn = "rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-blue-700 disabled:opacity-50";
const ghost = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";

export function OutlookSettings({ notice }: { notice: string }) {
  const [account, setAccount] = useState<OutlookAccountStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = async () => {
    try {
      setAccount(await outlookFetch<OutlookAccountStatus>("/api/integrations/outlook/account"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Outlook");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const togglePeople = async (enabled: boolean) => {
    setBusy("toggle");
    try {
      await outlookFetch("/api/integrations/outlook/account", { method: "PATCH", body: JSON.stringify({ autoCreatePeople: enabled }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the setting");
    } finally {
      setBusy("");
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    setError("");
    try {
      await outlookFetch("/api/integrations/outlook/sync", { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Outlook for your user? Synced mail and calendar cache for this account will be removed. Drafts and templates stay in the CRM.")) return;
    setBusy("disconnect");
    try {
      await outlookFetch("/api/integrations/outlook/disconnect", { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy("");
    }
  };

  const noticeText =
    notice === "connected" ? "Outlook is connected." :
    notice === "denied" ? "Microsoft sign-in was cancelled." :
    notice === "user_required" ? "Sign in with your team email (not only the shared PIN) so this mailbox stays yours." :
    notice === "missing_config" ? "Outlook is not configured on the server yet." :
    notice === "oauth_failed" ? "Outlook connection did not finish. Try Connect Outlook again." : "";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {(noticeText || error) && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
          {error || noticeText}
        </div>
      )}

      <section className="rounded-xl border bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl font-bold">Outlook</h2>
                {account?.connected && <Check className="h-4 w-4 text-emerald-600" />}
              </div>
              <p className="text-sm text-slate-500">Connect your Microsoft 365 mailbox and calendar. Each teammate connects their own account.</p>
              {account?.connected && (
                <p className="mt-1 text-sm font-medium text-slate-800">{account.displayName ? `${account.displayName} · ` : ""}{account.email}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {account?.connected ? (
              <>
                <a className={ghost} href="https://outlook.office.com/mail/" target="_blank" rel="noreferrer">
                  <span className="inline-flex items-center gap-1"><ExternalLink className="h-3.5 w-3.5" /> Open</span>
                </a>
                <button className={ghost} disabled={busy === "disconnect"} onClick={disconnect}>
                  <span className="inline-flex items-center gap-1"><Unplug className="h-3.5 w-3.5" /> Disconnect</span>
                </button>
              </>
            ) : (
              <a className={btn} href="/api/integrations/outlook/connect">Connect Outlook</a>
            )}
          </div>
        </div>
        {account && !account.configured && (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {account.configError}. Add the Outlook env vars in Vercel, then connect.
          </p>
        )}
      </section>

      <section className="grid gap-6 rounded-xl border bg-white p-5 shadow-xs md:grid-cols-[180px_1fr]">
        <div className="space-y-4 text-sm text-slate-600">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Category</div>
            <div className="mt-1">Communication</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Built by</div>
            <div className="mt-1">Microsoft</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Resources</div>
            <a className="mt-1 block text-blue-700 hover:underline" href="https://learn.microsoft.com/graph/auth-v2-user" target="_blank" rel="noreferrer">Microsoft identity</a>
          </div>
        </div>
        <div className="space-y-6">
          <div>
            <h3 className="font-display text-lg font-bold">Overview</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Connect SellingHighs to your Outlook account to read and send mail, and to see your calendar, inside the CRM.
              Mail is sent only when you click Send. Nothing in sync, templates, or drafts sends on its own.
            </p>
          </div>
          <div>
            <h3 className="font-display text-lg font-bold">How it works</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Inbox and Sent come from Microsoft Graph. Drafts, Outbox, and Templates stay in the CRM. Contact, company, and deal
              records show messages to and from that record&apos;s email addresses, plus upcoming meetings that include them.
            </p>
          </div>
          <div>
            <h3 className="font-display text-lg font-bold">Configure</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-slate-600">
              <li>Open Settings in the left sidebar.</li>
              <li>Choose Email and calendar accounts.</li>
              <li>Click Connect Outlook and sign in with Microsoft.</li>
              <li>Authorize SellingHighs to read and send mail and manage your calendar.</li>
            </ol>
          </div>
          {account?.connected && (
            <div className="space-y-3 border-t pt-4">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={account.autoCreatePeople}
                  disabled={busy === "toggle"}
                  onChange={event => togglePeople(event.target.checked)}
                />
                <span>
                  <span className="font-semibold text-slate-900">Create People from new inbox senders</span>
                  <span className="mt-0.5 block text-slate-500">Off by default. When sync runs, unknown senders from the last 14 days can become New contacts. No email is sent.</span>
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                <button className={ghost} disabled={busy === "sync"} onClick={syncNow}>
                  <span className="inline-flex items-center gap-1"><RefreshCw className="h-3.5 w-3.5" /> {busy === "sync" ? "Syncing..." : "Sync now"}</span>
                </button>
                <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> {account.lastSyncAt ? `Last sync ${new Date(account.lastSyncAt).toLocaleString()}` : "Not synced yet"}</span>
              </div>
              {account.lastSyncError && <p className="text-sm text-red-700">{account.lastSyncError}</p>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
