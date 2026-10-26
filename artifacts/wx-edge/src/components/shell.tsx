import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Activity } from "lucide-react";
import { PipelineBanner } from "@/components/pipeline-banner";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const isDashboard  = location === "/";
  const isLive       = location === "/live";
  const isMarkets    = location.startsWith("/markets") && !location.includes("tab=calibration");
  const isCalibration = location === "/markets" && window.location.search.includes("tab=calibration");
  const isApprovals  = location === "/approvals";

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="h-12 border-b flex items-center px-4 shrink-0 bg-card z-10 sticky top-0">
        <div className="flex items-center gap-2 mr-8">
          <div className="w-4 h-4 bg-primary rounded-sm flex items-center justify-center">
            <Activity className="w-3 h-3 text-primary-foreground" />
          </div>
          <span className="font-bold text-sm tracking-tight">WX EDGE</span>
        </div>
        <nav className="flex items-center h-full gap-1">
          <Link href="/" className={cn("px-3 h-full flex items-center text-sm font-medium border-b-2 transition-colors", isDashboard ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")}>
            Dashboard
          </Link>
          <Link href="/live" className={cn("px-3 h-full flex items-center text-sm font-medium border-b-2 transition-colors", isLive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")}>
            Live
          </Link>
          <Link href="/markets" className={cn("px-3 h-full flex items-center text-sm font-medium border-b-2 transition-colors", isMarkets ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")}>
            Markets
          </Link>
          <Link href="/markets?tab=calibration" className={cn("px-3 h-full flex items-center text-sm font-medium border-b-2 transition-colors", isCalibration ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")}>
            Calibration
          </Link>
          <Link href="/approvals" className={cn("px-3 h-full flex items-center text-sm font-medium border-b-2 transition-colors", isApprovals ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")}>
            Approvals
          </Link>
        </nav>
      </header>
      <main className="flex-1 flex flex-col">
        <PipelineBanner />
        {children}
      </main>
    </div>
  );
}
