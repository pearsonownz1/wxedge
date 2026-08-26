/**
 * Live page — per-station weather view with race track, calibration,
 * kill feed, and intraday temperature trail.
 * (Previously the Dashboard page before the trading dashboard was added.)
 */

import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import {
  useListStations,
  getListStationsQueryKey,
  useGetStation,
  getGetStationQueryKey,
  useGetStationDistribution,
  getGetStationDistributionQueryKey,
} from "@workspace/api-client-react";
import { cn, formatPts } from "@/lib/utils";
import { Shell } from "@/components/shell";
import { FeedBanner } from "@/components/feed-banner";
import { RaceTrack } from "@/components/race-track";
import { KillFeed } from "@/components/kill-feed";
import { ArrowRight, Target } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, ReferenceLine } from "recharts";

export default function Live() {
  const { data: stations, isLoading: loadingStations } = useListStations({
    query: {
      refetchInterval: 300000,
      queryKey: getListStationsQueryKey(),
    },
  });

  const sortedStations = useMemo(() => {
    if (!stations) return [];
    return [...stations].sort((a, b) => {
      const edgeA = a.bestEdgePts ? Math.abs(a.bestEdgePts) : 0;
      const edgeB = b.bestEdgePts ? Math.abs(b.bestEdgePts) : 0;
      return edgeB - edgeA;
    });
  }, [stations]);

  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);

  useEffect(() => {
    if (sortedStations.length > 0 && !selectedStationId) {
      setSelectedStationId(sortedStations[0].id);
    }
  }, [sortedStations, selectedStationId]);

  const station = sortedStations.find(s => s.id === selectedStationId);

  return (
    <Shell>
      {station && <FeedBanner fresh={station.feedFresh} timestampLst={station.obsTimestampLst} hideEdgeSignal />}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 border-r bg-card shrink-0 flex flex-col overflow-y-auto">
          <div className="p-4 border-b">
            <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Settlement Stations</h2>
          </div>
          <div className="flex-1">
            {loadingStations && <div className="p-4 text-sm text-muted-foreground">Loading stations...</div>}
            {sortedStations.map(s => {
              const isSelected = s.id === selectedStationId;
              const hasActionableEdge = s.isActionable && s.feedFresh;
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedStationId(s.id)}
                  className={cn(
                    "w-full text-left px-4 py-3 border-b flex items-center justify-between transition-colors",
                    isSelected ? "bg-accent" : "hover:bg-accent/50"
                  )}
                >
                  <div>
                    <div className="font-bold">{s.id}</div>
                    <div className="text-xs text-muted-foreground">{s.name.split(",")[0]}</div>
                  </div>
                  <div className="text-right">
                    {s.feedFresh ? (
                      <div className={cn("text-sm data-mono", hasActionableEdge ? "edge-positive" : "edge-neutral")}>
                        {formatPts(s.bestEdgePts)}
                      </div>
                    ) : (
                      <div className="text-sm data-mono edge-neutral" title="Feed Stale">—</div>
                    )}
                    <div className="text-[10px] text-muted-foreground uppercase">{s.bestBracket || "—"}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main Panel */}
        <div className="flex-1 bg-background overflow-y-auto">
          {selectedStationId ? (
            <StationView stationId={selectedStationId} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Select a station
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function StationView({ stationId }: { stationId: string }) {
  const { data: detail } = useGetStation(stationId, {
    query: {
      enabled: !!stationId,
      refetchInterval: 300000,
      queryKey: getGetStationQueryKey(stationId),
    },
  });

  const { data: dist } = useGetStationDistribution(stationId, {
    query: {
      enabled: !!stationId,
      refetchInterval: 300000,
      queryKey: getGetStationDistributionQueryKey(stationId),
    },
  });

  if (!detail || !dist) {
    return <div className="p-8 text-sm text-muted-foreground">Loading station data...</div>;
  }

  const { settlementWindow: win } = detail;
  const obsStale  = !dist.feedStatus.nwsFresh;
  const stale     = obsStale;

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Main column ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 min-w-0">

        {/* Header row */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <h1 className="text-2xl font-bold tracking-tight">{detail.id}</h1>
              <span className="text-2xl text-muted-foreground font-light">·</span>
              <h2 className="text-2xl font-medium text-muted-foreground">{win.contractDate}</h2>
            </div>
            <div className="text-sm text-muted-foreground">
              {detail.name} · window {win.lstStart}–{win.lstEnd} LST
              {" · "}
              <span className="data-mono">
                {Math.floor(win.hoursRemaining)}h {Math.floor((win.hoursRemaining % 1) * 60)}m remaining
              </span>
            </div>
            {win.dstActive && win.spillsToNextDay && win.spillsToDate && (
              <div className="text-[10px] text-orange-600 font-medium mt-1 bg-orange-50 inline-block px-1.5 py-0.5">
                DST active — window spills to {win.spillsToDate}
              </div>
            )}
          </div>

          {/* Running high */}
          <div className="text-right shrink-0">
            <div className={cn("text-5xl font-bold tracking-tighter data-mono", stale && "opacity-50")}>
              {detail.runningHighF.toFixed(1)}
              <span className="text-xl text-muted-foreground font-light ml-1">°F</span>
            </div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-0.5">
              {stale ? "Last good high" : "Running High"}
            </div>
          </div>
        </div>

        {/* Stale banner */}
        {stale && (
          <div className="border border-muted-foreground/30 bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground flex items-center justify-between">
            <span>
              Observation feed stale. Track frozen at last-good high; eliminations and edge signals suspended.
            </span>
            <span className="text-[10px] font-bold uppercase tracking-widest ml-4 shrink-0">
              Edge Signals Hidden
            </span>
          </div>
        )}

        {/* Race Track */}
        <div className="border bg-card p-5">
          <RaceTrack
            brackets={dist.brackets}
            runningHighF={detail.runningHighF}
            stationId={detail.id}
            contractDate={win.contractDate}
            stale={stale}
          />
        </div>

        {/* Model Run Calibration */}
        <div className="border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-3">
            <Target className="w-3.5 h-3.5" />
            <span className="text-[9px] font-bold uppercase tracking-widest">Model Run · Calibration Applied</span>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Mean Bias</div>
              <div className={cn("text-lg font-bold data-mono", detail.calibration.meanBias > 0 ? "text-primary" : "text-[oklch(0.55_0.09_250)]")}>
                {detail.calibration.meanBias > 0 ? "+" : ""}{detail.calibration.meanBias.toFixed(2)}°F
              </div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">RMSE</div>
              <div className="text-lg data-mono">{detail.calibration.rmse.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Valid Pairs</div>
              <div className="text-lg data-mono">{detail.calibration.pairCount}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Last Run</div>
              <div className="text-lg data-mono">{new Date(detail.calibration.lastUpdated).toLocaleDateString()}</div>
            </div>
          </div>

          {/* NBM Spread strip */}
          {dist.nbmSpread && (() => {
            const spread = dist.nbmSpread;
            const rangeF = spread.p90F - spread.p10F;
            const pct = (v: number) =>
              rangeF > 0 ? Math.max(0, Math.min(100, ((v - spread.p10F) / rangeF) * 100)) : 50;
            return (
              <div className="mt-4 pt-3 border-t">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">NBM Spread</span>
                  <span className={cn(
                    "text-[8px] px-1 py-0.5 font-bold uppercase tracking-wider",
                    spread.source === "nbm" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                  )}>
                    {spread.source === "nbm" ? "NBM" : "Approx"}
                  </span>
                </div>
                <div className="relative h-5 mb-5">
                  <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-muted" />
                  <div
                    className="absolute h-1 top-1/2 -translate-y-1/2 bg-primary/30"
                    style={{ left: `${pct(spread.p25F)}%`, width: `${pct(spread.p75F) - pct(spread.p25F)}%` }}
                  />
                  <div
                    className="absolute w-0.5 h-4 top-1/2 -translate-y-1/2 bg-primary"
                    style={{ left: `${pct(spread.p50F)}%`, transform: "translateX(-50%) translateY(-50%)" }}
                  />
                  {[
                    { v: spread.p10F, label: `${spread.p10F.toFixed(0)}°` },
                    { v: spread.p50F, label: `${spread.p50F.toFixed(0)}°`, bold: true },
                    { v: spread.p90F, label: `${spread.p90F.toFixed(0)}°` },
                  ].map(({ v, label, bold }) => (
                    <span
                      key={v}
                      className={cn("absolute text-[9px] data-mono top-4 -translate-x-1/2", bold ? "text-primary font-bold" : "text-muted-foreground")}
                      style={{ left: `${pct(v)}%` }}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Market board link */}
        <div>
          <Link
            href="/markets"
            className="inline-flex items-center justify-center text-sm font-bold bg-primary text-primary-foreground h-9 px-6 data-mono uppercase tracking-wider hover:bg-primary/90 transition-colors"
          >
            Open {stationId} market board
            <ArrowRight className="ml-2 w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* ── Right panel: Kill Feed + sparkline ────────────────────── */}
      <div className="w-64 shrink-0 border-l flex flex-col overflow-hidden">

        {/* Kill Feed */}
        <div className="flex-1 overflow-hidden flex flex-col border-b">
          <KillFeed
            brackets={dist.brackets}
            intradayObs={detail.intradayObs}
            stationId={detail.id}
            stale={stale}
          />
        </div>

        {/* Intraday sparkline */}
        <div className="p-3 shrink-0">
          <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
            Intraday High Trail
          </div>
          <div className="h-16 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={detail.intradayObs}>
                <XAxis dataKey="timeLst" hide />
                <YAxis domain={["dataMin - 1", "dataMax + 1"]} hide />
                <Line
                  type="stepAfter"
                  dataKey="tempF"
                  stroke="hsl(var(--foreground))"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <ReferenceLine y={detail.runningHighF} stroke="hsl(var(--primary))" strokeDasharray="2 2" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground data-mono mt-1">
            <span>{detail.intradayObs[0]?.timeLst}</span>
            <span>{detail.intradayObs[detail.intradayObs.length - 1]?.timeLst}</span>
          </div>
        </div>

        {/* Snapshot timestamp */}
        <div className="px-3 pb-2 shrink-0">
          <div className="text-[9px] text-muted-foreground data-mono">
            Book snap {dist.bookSnapshotTimeLst}
          </div>
        </div>
      </div>

    </div>
  );
}
