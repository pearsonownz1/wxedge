import { AlertTriangle } from "lucide-react";

export function FeedBanner({ 
  fresh, 
  timestampLst,
  hideEdgeSignal 
}: { 
  fresh: boolean; 
  timestampLst: string;
  hideEdgeSignal?: boolean;
}) {
  if (fresh) return null;
  
  return (
    <div className="bg-orange-100 text-orange-900 border-b border-orange-200 px-4 py-2 flex items-center gap-2 text-sm font-medium">
      <AlertTriangle className="w-4 h-4" />
      <span>
        Feed stale. Last good snapshot: {timestampLst} LST.
        {hideEdgeSignal && " Edge signals hidden."}
      </span>
    </div>
  );
}
