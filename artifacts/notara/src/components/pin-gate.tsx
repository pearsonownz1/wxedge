import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CrmPinSessionStatus } from "@workspace/api-client-react";
import { ShieldCheck, Lock, Mail, KeyRound } from "lucide-react";
import { Splash } from "@/pages/login";

export const SESSION_KEY = ["crm-pin-session"];
type Session = CrmPinSessionStatus;

export function PinGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"password" | "pin">("password");
  const [email, setEmail] = useState("guy@gcs.org");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const session = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async (): Promise<Session> => {
      const response = await fetch("/api/crm/session", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Cannot check sign-in. Please try again.");
      return response.json();
    },
    retry: false,
    refetchInterval: 60000,
  });

  useEffect(() => {
    if (session.data && !session.data.signed_in) {
      qc.removeQueries({ predicate: query => query.queryKey[0] !== SESSION_KEY[0] });
    }
  }, [session.data, qc]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = mode === "password" ? { email, password } : { pin };
      const response = await fetch("/api/crm/session", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Sign-in failed");
      setPin("");
      setPassword("");
      qc.setQueryData(SESSION_KEY, result as Session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  if (session.isPending) return <Splash />;
  if (session.data?.signed_in) return children;

  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1.15fr_1fr]">
      <div className="hidden flex-col justify-between bg-[#1b2538] p-12 text-white md:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white shadow">SH</div>
          <div>
            <div className="font-display text-xl font-bold tracking-tight">SellingHighs CRM</div>
            <div className="text-[11px] text-blue-200/80">SellingHighs CRM — Law Firm Pipeline</div>
          </div>
        </div>
        <div>
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-400/40 bg-blue-500/10 text-blue-300">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h1 className="font-display text-4xl font-semibold leading-tight">
            Pipeline, Outbound,<br />Dialer &amp; WhatsApp<br />in one workspace.
          </h1>
          <p className="mt-4 max-w-md text-sm text-slate-300">
            Sign in with your team account password to access your personal pipeline dashboard, conversion funnel, weighted revenue forecast, and call intelligence.
          </p>
        </div>
        <p className="font-mono-ui text-xs text-slate-400">SellingHighs CRM · Multi-User Team Workspaces</p>
      </div>

      <div className="flex items-center justify-center bg-slate-50 p-8">
        <form onSubmit={login} className="rise w-full max-w-md rounded-xl border bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">Sign in to SellingHighs</h1>
              <p className="mt-1 text-xs text-slate-500">Choose Team Password or Quick PIN authentication</p>
            </div>
          </div>

          <div className="mb-6 grid grid-cols-2 rounded-lg border bg-slate-100 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => { setMode("password"); setError(""); }}
              className={`flex items-center justify-center gap-1.5 rounded-md py-2 transition ${mode === "password" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
            >
              <Mail className="h-3.5 w-3.5" /> Team Password
            </button>
            <button
              type="button"
              onClick={() => { setMode("pin"); setError(""); }}
              className={`flex items-center justify-center gap-1.5 rounded-md py-2 transition ${mode === "pin" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
            >
              <KeyRound className="h-3.5 w-3.5" /> Quick PIN
            </button>
          </div>

          {mode === "password" ? (
            <>
              <label htmlFor="crm-email" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Work Email
              </label>
              <input
                id="crm-email"
                data-testid="input-email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="guy@gcs.org"
                className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <label htmlFor="crm-password" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Password
              </label>
              <input
                id="crm-password"
                data-testid="input-password"
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                autoFocus
              />
              <div className="mb-4 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                <span>Team accounts:</span>
                {["guy@gcs.org", "eduardo@gcs.org", "growth@gcs.org"].map(acct => (
                  <button
                    key={acct}
                    type="button"
                    onClick={() => setEmail(acct)}
                    className="rounded border bg-slate-100 px-1.5 py-0.5 font-mono-ui hover:bg-blue-50 hover:text-blue-700"
                  >
                    {acct.split("@")[0]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <label htmlFor="crm-pin" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Workspace PIN
              </label>
              <input
                id="crm-pin"
                data-testid="input-pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                required
                maxLength={128}
                value={pin}
                onChange={event => setPin(event.target.value)}
                className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-blue-600 focus:outline-none"
                autoFocus
              />
            </>
          )}

          {(error || session.error) && (
            <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
              {error || (session.error as Error)?.message}
            </p>
          )}

          <button
            data-testid="button-pin-login"
            disabled={busy || (mode === "password" ? !email || !password : !pin)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            <Lock className="h-4 w-4" />
            {busy ? "Signing in..." : "Sign in to Workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
