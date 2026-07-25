import { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { 
  useListMarkets, 
  getListMarketsQueryKey,
  useListStations,
  getListStationsQueryKey
} from "@workspace/api-client-react";
import { cn, formatPts, formatPct } from "@/lib/utils";
import { Shell } from "@/components/shell";
import { FeedBanner, type FeedStatusDetail } from "@/components/feed-banner";

type Filter = "All" | "Actionable" | "Locked";

export default function Markets() {
  const [location] = useLocation();
  const isCalibration = location === "/markets" && window.location.search.includes("tab=calibration");

  return (
    <Shell>
      {isCalibration ? <CalibrationView /> : <MarketsView />}
    </Shell>
  );
}

function MarketsView() {
  const { data: marketData, isLoading } = useListMarkets({
    query: {
      refetchInterval: 30000,
      queryKey: getListMarketsQueryKey(),
    }
  });

  const [filter, setFilter] = useState<Filter>("All");
  const [, setLocation] = useLocation();

  const filteredMarkets = useMemo(() => {
    if (!marketData) return [];
    let markets = marketData.markets;
    
    if (filter === "Actionable") {
      markets = markets.filter(m => m.status === 'actionable');
    } else if (filter === "Locked") {
      markets = markets.filter(m => m.status === 'locked' || m.lockStatus === 'dead');
    }
    
    return markets;
  }, [marketData, filter]);

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading market board...</div>;
  }

  if (!marketData) return null;

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <FeedBanner fresh={marketData.feedFresh} timestampLst={marketData.bookSnapshotTimeLst} hideEdgeSignal feedStatusDetail={marketData.feedStatusDetail as FeedStatusDetail | undefined} />
      
      <div className="p-4 border-b flex items-center justify-between shrink-0 bg-card">
        <div className="flex items-center gap-2">
          {(["All", "Actionable", "Locked"] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors border",
                filter === f 
                  ? "bg-foreground text-background border-foreground" 
                  : "bg-background text-muted-foreground border-transparent hover:bg-accent hover:text-foreground"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="sticky top-0 bg-card z-10 shadow-[0_1px_0_0_hsl(var(--border))] text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Market</th>
              <th className="px-4 py-3 font-medium">Bracket</th>
              <th className="px-4 py-3 font-medium text-right">Model %</th>
              <th className="px-4 py-3 font-medium text-right">Implied %</th>
              <th className="px-4 py-3 font-medium text-right">Δ Mod−Mkt</th>
              <th className="px-4 py-3 font-medium text-right">Bid / Ask</th>
              <th className="px-4 py-3 font-medium text-right text-foreground">Edge (Net)</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredMarkets.map((m) => {
              const isActionable = m.status === 'actionable';
              const isSettledShort = m.status === 'settled_short';
              const isBelow = m.status === 'below_threshold';
              const isLocked = m.lockStatus === 'dead';
              const showEdge = marketData.feedFresh;

              return (
                <tr 
                  key={m.contractId}
                  onClick={() => setLocation(`/markets/${m.contractId}`)}
                  className={cn(
                    "group cursor-pointer transition-colors hover:bg-accent",
                    isActionable && "bg-red-50/50 dark:bg-red-950/20 border-l-4 border-l-primary",
                    !isActionable && "border-l-4 border-l-transparent",
                    (isSettledShort || isLocked) && "opacity-50",
                    isBelow && "text-muted-foreground"
                  )}
                >
                  <td className="px-4 py-3 font-bold data-mono">{m.contractId}</td>
                  <td className={cn("px-4 py-3 data-mono font-medium", isSettledShort && "line-through text-muted-foreground")}>
                    {m.bracket}
                  </td>
                  <td className="px-4 py-3 text-right data-mono">{formatPct(m.modelPct)}</td>
                  <td className="px-4 py-3 text-right data-mono">{formatPct(m.impliedPct)}</td>
                  <td className="px-4 py-3 text-right data-mono font-bold" style={
                    (() => {
                      // No real book → no divergence number, neutral color.
                      if (!marketData.feedFresh || m.impliedPct == null) return { color: "hsl(0 0% 45%)" };
                      const d = m.modelPct - m.impliedPct;
                      return d >= 0
                        ? { color: "hsl(350 85% 55%)" }
                        : { color: "oklch(0.55 0.09 250)" };
                    })()
                  }>
                    {marketData.feedFresh && m.impliedPct != null
                      ? `${m.modelPct - m.impliedPct > 0 ? "+" : ""}${(m.modelPct - m.impliedPct).toFixed(1)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right data-mono text-muted-foreground">
                    {m.bidCents !== null ? `${m.bidCents}¢` : "—"} / {m.askCents !== null ? `${m.askCents}¢` : "—"}
                  </td>
                  <td className={cn(
                    "px-4 py-3 text-right font-bold data-mono",
                    isActionable && showEdge ? "text-primary" : (showEdge ? "text-foreground" : "text-muted-foreground")
                  )}>
                    {showEdge ? formatPts(m.edgeNetPts) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {isLocked && <span className="bg-muted text-muted-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-sm border">Locked</span>}
                      {m.lockStatus === 'ambiguous' && <span className="bg-orange-100 text-orange-800 border-orange-200 border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-sm">Ambiguous</span>}
                      {!isLocked && m.lockStatus !== 'ambiguous' && (
                        <span className="text-xs uppercase tracking-wider text-muted-foreground">{m.status.replace('_', ' ')}</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredMarkets.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No markets match the current filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t flex items-center justify-between text-xs text-muted-foreground shrink-0 bg-card">
        <div>Ranked by fee-adjusted edge · view only</div>
        <div className="data-mono">
          Book snapshot {marketData.bookSnapshotTimeLst} · {marketData.bookLatencySeconds.toFixed(1)}s latency
        </div>
      </div>
    </div>
  );
}

function CalibrationView() {
  const { data: stations, isLoading } = useListStations({
    query: {
      refetchInterval: 300000,
      queryKey: getListStationsQueryKey(),
    }
  });

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading calibration stats...</div>;
  }

  // To display calibration we need to fetch all stations details.
  // Actually, listStations doesn't return calibration stats. Let's create a combined view or show a message.
  // Wait, the prompt says "Table of the 6 stations: ID, Site name, BIAS (colored +/- red/blue), RMSE, Pairs, Season, Data source, Last updated."
  // Since we only have `useGetStation(stationId)`, we can create a child component for each row that fetches it, or fetch them in parallel if possible.
  // Let's use the row component approach.

  return (
    <div className="flex-1 bg-background p-8 overflow-auto">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold tracking-tight mb-8">Calibration Status</h1>
        <div className="border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Station</th>
                <th className="px-4 py-3 font-medium">Site Name</th>
                <th className="px-4 py-3 font-medium text-right">Bias Applied</th>
                <th className="px-4 py-3 font-medium text-right">RMSE</th>
                <th className="px-4 py-3 font-medium text-right">Pairs</th>
                <th className="px-4 py-3 font-medium">Season</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {stations?.map(s => (
                <CalibrationRow key={s.id} stationId={s.id} stationName={s.name} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useGetStation, getGetStationQueryKey } from "@workspace/api-client-react";

function CalibrationRow({ stationId, stationName }: { stationId: string, stationName: string }) {
  const { data } = useGetStation(stationId, {
    query: {
      enabled: !!stationId,
      refetchInterval: 300000,
      queryKey: getGetStationQueryKey(stationId),
    }
  });

  if (!data) {
    return (
      <tr>
        <td className="px-4 py-3 font-bold data-mono">{stationId}</td>
        <td className="px-4 py-3 text-muted-foreground truncate max-w-[200px]">{stationName}</td>
        <td colSpan={6} className="px-4 py-3 text-muted-foreground text-center text-xs">Loading...</td>
      </tr>
    );
  }

  const { calibration } = data;

  return (
    <tr className="hover:bg-accent transition-colors">
      <td className="px-4 py-3 font-bold data-mono">{stationId}</td>
      <td className="px-4 py-3 text-muted-foreground truncate max-w-[200px]" title={stationName}>{stationName}</td>
      <td className={cn("px-4 py-3 text-right font-bold data-mono", calibration.meanBias > 0 ? "text-primary" : "text-blue-600")}>
        {calibration.meanBias > 0 ? "+" : ""}{calibration.meanBias.toFixed(2)}°F
      </td>
      <td className="px-4 py-3 text-right data-mono">{calibration.rmse.toFixed(2)}</td>
      <td className="px-4 py-3 text-right data-mono">{calibration.pairCount}</td>
      <td className="px-4 py-3 capitalize">{calibration.season}</td>
      <td className="px-4 py-3 text-xs text-muted-foreground max-w-[150px] truncate" title={calibration.dataSource}>{calibration.dataSource}</td>
      <td className="px-4 py-3 text-right data-mono text-xs">{new Date(calibration.lastUpdated).toLocaleDateString()}</td>
    </tr>
  );
}
