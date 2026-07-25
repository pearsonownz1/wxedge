import { AlertTriangle, Clock, KeyRound, WifiOff } from "lucide-react";

type FeedStatusDetail =
  | "live"
  | "no_api_key"
  | "key_lacks_access"
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
    detail === "no_api_key"           ? <KeyRound className="w-4 h-4 shrink-0" /> :
    detail === "key_lacks_access"     ? <KeyRound className="w-4 h-4 shrink-0" /> :
    detail === "no_current_contracts" ? <Clock    className="w-4 h-4 shrink-0" /> :
    detail === "unavailable"          ? <WifiOff  className="w-4 h-4 shrink-0" /> :
    <AlertTriangle className="w-4 h-4 shrink-0" />;

  const message =
    detail === "no_api_key"
      ? "No Kalshi API key — live market data unavailable. Set KALSHI_API_KEY to enable live prices."
      : detail === "key_lacks_access"
        ? "Kalshi API key lacks weather market access — live prices unavailable. Check key permissions."
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
