import { useGetPipelineHealth, getGetPipelineHealthQueryKey } from "@workspace/api-client-react";
import { AlertOctagon, ShieldAlert, Hourglass } from "lucide-react";

/**
 * Pipeline watchdog banner — surfaces when the trading pipeline has gone
 * dark (blocked / stalled / dark), naming the dominant suppression reason.
 * Renders nothing when the pipeline is "ok" or legitimately "quiet".
 */
export function PipelineBanner() {
  const { data: health } = useGetPipelineHealth({
    query: {
      refetchInterval: 300000,
      queryKey: getGetPipelineHealthQueryKey(),
    },
  });

  if (!health) return null;
  if (health.status === "ok" || health.status === "quiet") return null;

  const isDark = health.status === "dark";
  const isBlocked = health.status === "blocked";

  const icon = isDark ? (
    <AlertOctagon className="w-4 h-4 shrink-0" />
  ) : isBlocked ? (
    <ShieldAlert className="w-4 h-4 shrink-0" />
  ) : (
    <Hourglass className="w-4 h-4 shrink-0" />
  );

  const label = isDark
    ? "PIPELINE DARK"
    : isBlocked
      ? "PIPELINE BLOCKED"
      : "PIPELINE STALLED";

  const message = isDark
    ? `No signals evaluated in the last ${health.windowHours}h — the signal engine isn't running or has no data. Last signal: ${health.lastSignalTs ? new Date(health.lastSignalTs).toLocaleString() : "never"}.`
    : isBlocked
      ? `All ${health.evaluatedCount.toLocaleString()} signals in the last ${health.windowHours}h were suppressed — dominant reason: ${health.dominantReason ?? "unknown"}${health.dominantShare != null ? ` (${Math.round(health.dominantShare * 100)}% of suppressions)` : ""}. This looks systemic, not a quiet market.`
      : `${health.liveCount} live signals in the last ${health.windowHours}h but zero proposals reached the approval queue — risk checks or cooldown may be rejecting everything.`;

  return (
    <div
      className={
        isDark || isBlocked
          ? "bg-red-600 text-white px-4 py-2 flex items-center gap-2.5 text-sm font-medium"
          : "bg-amber-500 text-black px-4 py-2 flex items-center gap-2.5 text-sm font-medium"
      }
      role="alert"
    >
      {icon}
      <span className="font-bold text-[11px] uppercase tracking-widest shrink-0">{label}</span>
      <span className="opacity-95">{message}</span>
    </div>
  );
}
