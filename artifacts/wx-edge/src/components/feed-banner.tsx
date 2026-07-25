import { AlertTriangle, Clock, KeyRound, PowerOff, WifiOff } from "lucide-react";

export type FeedStatusDetail =
  | "live"
  | "auth_failed"           // 401/403 confirmed from Kalshi
  | "rate_limited"          // 429 — transient, retrying
  | "network_error"         // timeout / unreachable — transient
  | "polling_disabled"      // POLLING_ENABLED=false on this instance — fetch pipeline off
  | "no_current_contracts"  // Kalshi returned 0 events — markets not open yet
  | "unavailable";          // generic stale / unknown

export function FeedBanner({
  fresh,
  timestampLst,
  hideEdgeSignal,
  feedStatusDetail,
}: {
  fresh: boolean;
  timestampLst: string;
  hideEdgeSignal?: boolean;
  feedStatusDetail?: FeedStatusDetail;
}) {
  if (fresh) return null;

  const detail = feedStatusDetail ?? "unavailable";

  const icon =
    detail === "auth_failed"          ? <KeyRound      className="w-4 h-4 shrink-0" /> :
    detail === "rate_limited"         ? <WifiOff       className="w-4 h-4 shrink-0" /> :
    detail === "network_error"        ? <WifiOff       className="w-4 h-4 shrink-0" /> :
    detail === "polling_disabled"     ? <PowerOff      className="w-4 h-4 shrink-0" /> :
    detail === "no_current_contracts" ? <Clock         className="w-4 h-4 shrink-0" /> :
                                        <AlertTriangle className="w-4 h-4 shrink-0" />;

  const message =
    detail === "auth_failed"
      ? "Kalshi auth error — live prices unavailable."
      : detail === "rate_limited"
        ? "Kalshi rate limited (429) — retrying shortly. Live prices temporarily unavailable."
        : detail === "network_error"
          ? "Kalshi unreachable — retrying. Live prices temporarily unavailable."
          : detail === "polling_disabled"
            ? "Kalshi polling is disabled on this instance (POLLING_ENABLED=false) — no live market data is being fetched."
            : detail === "no_current_contracts"
              ? "Today's contracts haven't opened yet — board will populate once markets go live."
              : `Kalshi feed stale — last good snapshot: ${timestampLst}.`;

  return (
    <div className="bg-orange-100 text-orange-900 border-b border-orange-200 px-4 py-2 flex items-center gap-2 text-sm font-medium">
      {icon}
      <span>
        {message}
        {hideEdgeSignal && detail !== "no_current_contracts" && " Edge signals hidden."}
      </span>
    </div>
  );
}
