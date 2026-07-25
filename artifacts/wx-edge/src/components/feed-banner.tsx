import { AlertTriangle, Clock, KeyRound, WifiOff } from "lucide-react";

type FeedStatusDetail =
  | "live"
  | "no_api_key"
  | "auth_failed"           // 401/403 confirmed from Kalshi
  | "rate_limited"          // 429 — transient, retrying
  | "network_error"         // timeout / unreachable — transient
  | "key_lacks_access"      // legacy alias for auth_failed
  | "no_current_contracts"
  | "unavailable";

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
    detail === "no_api_key"           ? <KeyRound     className="w-4 h-4 shrink-0" /> :
    detail === "auth_failed"          ? <KeyRound     className="w-4 h-4 shrink-0" /> :
    detail === "key_lacks_access"     ? <KeyRound     className="w-4 h-4 shrink-0" /> :
    detail === "rate_limited"         ? <WifiOff      className="w-4 h-4 shrink-0" /> :
    detail === "network_error"        ? <WifiOff      className="w-4 h-4 shrink-0" /> :
    detail === "no_current_contracts" ? <Clock        className="w-4 h-4 shrink-0" /> :
    detail === "unavailable"          ? <AlertTriangle className="w-4 h-4 shrink-0" /> :
    <AlertTriangle className="w-4 h-4 shrink-0" />;

  const message =
    detail === "no_api_key"
      ? "No Kalshi API key — live market data unavailable. Set KALSHI_API_KEY to enable live prices."
      : detail === "auth_failed" || detail === "key_lacks_access"
        ? "Kalshi API key rejected (401/403) — live prices unavailable. Check key permissions."
        : detail === "rate_limited"
          ? "Kalshi rate limited (429) — retrying shortly. Live prices temporarily unavailable."
          : detail === "network_error"
            ? "Kalshi unreachable — retrying. Live prices temporarily unavailable."
            : detail === "no_current_contracts"
              ? "Today's Kalshi contracts haven't opened yet — the board will populate once they go live."
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
