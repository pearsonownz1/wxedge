import { AlertTriangle, KeyRound, WifiOff } from "lucide-react";

type FeedStatusDetail = "live" | "no_api_key" | "key_lacks_access" | "unavailable";

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
    detail === "no_api_key" ? <KeyRound className="w-4 h-4 shrink-0" /> :
    detail === "key_lacks_access" ? <KeyRound className="w-4 h-4 shrink-0" /> :
    detail === "unavailable" ? <WifiOff className="w-4 h-4 shrink-0" /> :
    <AlertTriangle className="w-4 h-4 shrink-0" />;

  const message =
    detail === "no_api_key"
      ? "No Kalshi API key — showing stub prices. Set KALSHI_API_KEY to enable live data."
      : detail === "key_lacks_access"
        ? "API key lacks weather market access — showing stub prices. Check key permissions."
        : `Feed stale. Last good snapshot: ${timestampLst}.`;

  return (
    <div className="bg-orange-100 text-orange-900 border-b border-orange-200 px-4 py-2 flex items-center gap-2 text-sm font-medium">
      {icon}
      <span>
        {message}
        {hideEdgeSignal && " Edge signals hidden."}
      </span>
    </div>
  );
}
