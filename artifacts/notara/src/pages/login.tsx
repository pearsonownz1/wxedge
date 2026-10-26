import { ShieldCheck } from 'lucide-react';

export function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between bg-sidebar p-12 text-sidebar-foreground md:flex">
        <div>
          <div className="font-display text-2xl">SellingHighs CRM — Law Firm Pipeline</div>
          <p className="mt-1 text-xs opacity-75">SellingHighs CRM — Law Firm Pipeline</p>
        </div>
        <div>
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border-2 border-primary text-primary"><ShieldCheck className="h-7 w-7" /></div>
          <h1 className="font-display text-5xl leading-tight">Every law firm,<br />with the context<br />to close.</h1>
        </div>
        <p className="font-mono-ui text-xs opacity-60">SellingHighs CRM — Law Firm Pipeline. Owner access only.</p>
      </div>
      <div className="flex items-center justify-center p-8">
        <div className="rise w-full max-w-sm">
          <div className="font-display mb-8 text-2xl md:hidden">SellingHighs CRM — Law Firm Pipeline</div>
          <h2 className="font-display text-3xl">Founder sign in</h2>
          <p className="mb-6 mt-2 text-sm text-muted-foreground">SellingHighs CRM — Law Firm Pipeline. Only authorized team members can view the pipeline.</p>
          <button data-testid="button-login" onClick={onLogin} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">Log in</button>
        </div>
      </div>
    </div>
  );
}

export function Splash({ children }: { children?: React.ReactNode }) {
  return <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 p-8 text-center">{children ?? <><div className="font-display text-2xl">SellingHighs CRM — Law Firm Pipeline</div><div className="h-1 w-32 animate-pulse rounded bg-primary/40" /></>}</div>;
}
