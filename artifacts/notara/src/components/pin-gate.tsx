import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CrmPinSessionStatus } from "@workspace/api-client-react";
import { ShieldCheck } from "lucide-react";
import { Splash } from "@/pages/login";

const SESSION_KEY = ["crm-pin-session"];
type Session = CrmPinSessionStatus;

export function PinGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
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
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/crm/session", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Sign-in failed");
      setPin("");
      qc.setQueryData(SESSION_KEY, result as Session);
    } catch (err) { setError(err instanceof Error ? err.message : "Sign-in failed"); }
    finally { setBusy(false); }
  };
  if (session.isPending) return <Splash />;
  if (session.data?.signed_in) return children;
  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1.1fr_1fr]">
      <div className="hidden flex-col justify-between bg-sidebar p-12 text-sidebar-foreground md:flex">
        <div className="font-display text-2xl">Notara</div>
        <div>
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border-2 border-primary text-primary"><ShieldCheck className="h-7 w-7" /></div>
          <h1 className="font-display text-5xl leading-tight">Your expert<br />pipeline,<br />in one place.</h1>
        </div>
        <p className="font-mono-ui text-xs opacity-60">Private workspace. PIN access required.</p>
      </div>
      <div className="flex items-center justify-center p-8">
        <form onSubmit={login} className="rise w-full max-w-sm">
          <div className="mb-8 font-display text-2xl md:hidden">Notara</div>
          <h1 className="font-display text-3xl">Enter your PIN</h1>
          <p className="mb-6 mt-2 text-sm text-muted-foreground">Sign in to view and manage the expert pipeline. This browser stays signed in for 30 days.</p>
          <label htmlFor="crm-pin" className="mb-2 block text-sm font-medium">PIN</label>
          <input id="crm-pin" data-testid="input-pin" type="password" inputMode="numeric" autoComplete="current-password" required maxLength={128} value={pin} onChange={event => setPin(event.target.value)} className="mb-4 w-full rounded-md border bg-background px-3 py-2 text-base" autoFocus />
          {(error || session.error || session.data?.configured === false) && <p role="alert" className="mb-4 text-sm text-destructive">{error || (session.error as Error)?.message || "PIN login is not configured yet. Add CRM_PIN in Replit Secrets."}</p>}
          <button data-testid="button-pin-login" disabled={busy || !pin || session.data?.configured === false || !!session.error} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{busy ? "Signing in..." : "Sign in"}</button>
          {session.error && <button type="button" onClick={() => session.refetch()} className="mt-3 w-full text-sm underline">Try again</button>}
        </form>
      </div>
    </div>
  );
}
