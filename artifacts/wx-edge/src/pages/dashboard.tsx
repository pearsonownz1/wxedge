import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { 
  useListStations, 
  getListStationsQueryKey,
  useGetStation,
  getGetStationQueryKey,
  useGetStationDistribution,
  getGetStationDistributionQueryKey
} from "@workspace/api-client-react";
import { cn, formatPts, formatTemp, formatPct } from "@/lib/utils";
import { Shell } from "@/components/shell";
import { FeedBanner } from "@/components/feed-banner";
import { ArrowRight, Thermometer, Clock, Target, Info } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, ReferenceLine } from "recharts";

export default function Dashboard() {
  const { data: stations, isLoading: loadingStations } = useListStations({
    query: {
      refetchInterval: 300000,
      queryKey: getListStationsQueryKey(),
    }
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
                    <div className="text-xs text-muted-foreground">{s.name.split(',')[0]}</div>
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
    }
  });

  const { data: dist } = useGetStationDistribution(stationId, {
    query: {
      enabled: !!stationId,
      refetchInterval: 300000,
      queryKey: getGetStationDistributionQueryKey(stationId),
    }
  });

  if (!detail || !dist) {
    return <div className="p-8 text-sm text-muted-foreground">Loading station data...</div>;
  }

  const { settlementWindow: window } = detail;
  const showEdge = dist.feedFresh;

  const activeBrackets = dist.brackets;

  return (
    <div className="max-w-6xl mx-auto p-8 flex gap-8">
      {/* Left Column: Data & Chart */}
      <div className="flex-1 flex flex-col gap-8">
        
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-3xl font-bold tracking-tight">{detail.id}</h1>
              <span className="text-3xl text-muted-foreground font-light">·</span>
              <h2 className="text-3xl font-medium text-muted-foreground">{window.contractDate}</h2>
            </div>
            <div className="text-muted-foreground">{detail.name}</div>
          </div>
          <div className="text-right">
            <div className="text-5xl font-bold tracking-tighter text-foreground data-mono">
              {detail.runningHighF.toFixed(0)}<span className="text-2xl text-muted-foreground font-light ml-1">°F</span>
            </div>
            <div className="text-sm text-muted-foreground uppercase tracking-widest mt-1">Running High</div>
          </div>
        </div>

        {/* Info Cards Row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="border bg-card p-4 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <Clock className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-wider">Settlement Window</span>
            </div>
            <div>
              <div className="text-lg font-medium data-mono">
                {window.lstStart} – {window.lstEnd} <span className="text-sm text-muted-foreground">LST</span>
              </div>
              <div className="text-sm text-muted-foreground data-mono">
                {window.localStart} – {window.localEnd} <span className="text-xs">Local</span>
              </div>
              {window.dstActive && window.spillsToNextDay && window.spillsToDate && (
                <div className="text-xs text-orange-600 font-medium mt-1 bg-orange-50 inline-block px-1.5 py-0.5 rounded-sm">
                  DST active — window spills to {window.spillsToDate}
                </div>
              )}
            </div>
            <div className="mt-3 text-sm font-medium">
              {Math.floor(window.hoursRemaining)}h {Math.floor((window.hoursRemaining % 1) * 60)}m remaining
            </div>
          </div>

          <div className="border bg-card p-4 flex flex-col">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <Thermometer className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-wider">Intraday High</span>
            </div>
            <div className="flex-1 h-20 w-full mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={detail.intradayObs}>
                  <XAxis dataKey="timeLst" hide />
                  <YAxis domain={['dataMin - 2', 'dataMax + 2']} hide />
                  <Line 
                    type="stepAfter" 
                    dataKey="tempF" 
                    stroke="hsl(var(--foreground))" 
                    strokeWidth={2} 
                    dot={false}
                    isAnimationActive={false}
                  />
                  <ReferenceLine y={detail.runningHighF} stroke="hsl(var(--primary))" strokeDasharray="3 3" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-2 data-mono">
              <span>{detail.intradayObs[0]?.timeLst}</span>
              <span>{detail.intradayObs[detail.intradayObs.length - 1]?.timeLst}</span>
            </div>
          </div>
        </div>

        {/* Main Chart */}
        <div className="border bg-card p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold">Probability Distribution</h3>
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-primary rounded-sm"></div>
                <span>Model</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-foreground rounded-sm opacity-20"></div>
                <span>Market Implied</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {activeBrackets.map((b) => {
              const isBest = dist.bestDivergencePts !== 0 && Math.abs(b.edgePts) === Math.abs(dist.bestDivergencePts);
              const isDead = b.lockStatus === 'dead';
              const maxBarWidth = 100; // %
              
              return (
                <div key={b.label} className={cn("relative flex items-center group", isDead && "opacity-30")}>
                  {/* Bracket Label */}
                  <div className="w-20 shrink-0 text-sm font-bold data-mono text-right pr-4">
                    {b.label}
                  </div>
                  
                  {/* Bars Container */}
                  <div className="flex-1 h-12 relative flex items-center border-l pl-4">
                    <div className="w-full relative h-8 flex flex-col justify-center gap-1">
                      {/* Model Bar */}
                      <div 
                        className="h-3 bg-primary transition-all duration-500 rounded-r-sm" 
                        style={{ width: `${Math.max(b.modelPct, 1)}%` }}
                      />
                      {/* Implied Bar */}
                      <div 
                        className="h-3 bg-foreground opacity-20 transition-all duration-500 rounded-r-sm" 
                        style={{ width: `${Math.max(b.impliedPct, 1)}%` }}
                      />
                    </div>
                  </div>

                  {/* Values */}
                  <div className="w-48 shrink-0 pl-4 flex flex-col justify-center">
                    <div className="text-xs data-mono text-muted-foreground">
                      Mod {b.modelPct.toFixed(0)}% · Mkt {b.impliedPct.toFixed(0)}%
                    </div>
                    {showEdge && !isDead && (
                      <div className={cn("text-sm font-bold data-mono", 
                        isBest ? "text-primary" : "text-foreground"
                      )}>
                        {formatPts(b.edgePts)} pts
                      </div>
                    )}
                    {isDead && (
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mt-0.5">
                        Eliminated
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* NBM Spread annotation */}
          {dist.nbmSpread && (
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center gap-2 mb-2">
                <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  NBM Spread
                </div>
                <div className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider",
                  dist.nbmSpread.source === 'nbm'
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                )}>
                  {dist.nbmSpread.source === 'nbm' ? 'NBM' : 'Approx'}
                </div>
              </div>
              <div className="relative h-6">
                {/* Compute bar positions relative to P10–P90 range */}
                {(() => {
                  const spread = dist.nbmSpread;
                  const rangeF = spread.p90F - spread.p10F;
                  const pct = (v: number) =>
                    rangeF > 0 ? Math.max(0, Math.min(100, ((v - spread.p10F) / rangeF) * 100)) : 50;
                  return (
                    <div className="relative w-full h-full flex items-center">
                      {/* P10–P90 track */}
                      <div className="absolute inset-x-0 h-1.5 rounded-full bg-muted" />
                      {/* P25–P75 interquartile band */}
                      <div
                        className="absolute h-1.5 bg-primary/30 rounded-sm"
                        style={{
                          left: `${pct(spread.p25F)}%`,
                          width: `${pct(spread.p75F) - pct(spread.p25F)}%`,
                        }}
                      />
                      {/* P50 tick */}
                      <div
                        className="absolute w-1 h-4 bg-primary rounded-full -translate-x-0.5"
                        style={{ left: `${pct(spread.p50F)}%` }}
                      />
                      {/* P10 label */}
                      <span
                        className="absolute text-[10px] data-mono text-muted-foreground -translate-x-1/2 top-4"
                        style={{ left: `${pct(spread.p10F)}%` }}
                      >
                        {spread.p10F.toFixed(0)}°
                      </span>
                      {/* P50 label */}
                      <span
                        className="absolute text-[10px] data-mono font-bold text-primary -translate-x-1/2 top-4"
                        style={{ left: `${pct(spread.p50F)}%` }}
                      >
                        {spread.p50F.toFixed(0)}°
                      </span>
                      {/* P90 label */}
                      <span
                        className="absolute text-[10px] data-mono text-muted-foreground -translate-x-1/2 top-4"
                        style={{ left: `${pct(spread.p90F)}%` }}
                      >
                        {spread.p90F.toFixed(0)}°
                      </span>
                    </div>
                  );
                })()}
              </div>
              <div className="mt-6 flex gap-4 text-[10px] text-muted-foreground">
                <span>P10={dist.nbmSpread.p10F.toFixed(1)}°</span>
                <span>P25={dist.nbmSpread.p25F.toFixed(1)}°</span>
                <span className="font-bold text-foreground">P50={dist.nbmSpread.p50F.toFixed(1)}°</span>
                <span>P75={dist.nbmSpread.p75F.toFixed(1)}°</span>
                <span>P90={dist.nbmSpread.p90F.toFixed(1)}°</span>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between text-xs text-muted-foreground border-t pt-4">
            <div className="flex items-center gap-1">
              <Info className="w-3 h-3" />
              Faded = mathematically eliminated
            </div>
            <div>Snapshot {dist.bookSnapshotTimeLst}</div>
          </div>
        </div>

        <div>
          <Link href="/markets" className="inline-flex items-center justify-center whitespace-nowrap text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-10 px-8 data-mono uppercase tracking-wider w-full md:w-auto">
            Open {stationId} market board
            <ArrowRight className="ml-2 w-4 h-4" />
          </Link>
        </div>

      </div>

      {/* Right Column: Calibration Sidebar */}
      <div className="w-64 shrink-0 flex flex-col gap-4">
        <div className="border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-4">
            <Target className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-wider">Calibration</span>
          </div>
          
          <div className="space-y-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Mean Bias Applied</div>
              <div className={cn("text-xl font-bold data-mono", detail.calibration.meanBias > 0 ? "text-primary" : "text-blue-600")}>
                {detail.calibration.meanBias > 0 ? "+" : ""}{detail.calibration.meanBias.toFixed(2)}°F
              </div>
            </div>
            
            <div className="pt-4 border-t">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">RMSE</div>
              <div className="text-lg data-mono">{detail.calibration.rmse.toFixed(2)}</div>
            </div>
            
            <div className="pt-4 border-t">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Valid Pairs</div>
              <div className="text-lg data-mono">{detail.calibration.pairCount}</div>
            </div>

            <div className="pt-4 border-t space-y-2 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Season</span>
                <span className="font-medium text-foreground">{detail.calibration.season}</span>
              </div>
              <div className="flex justify-between">
                <span>Source</span>
                <span className="font-medium text-foreground text-right max-w-[120px] truncate" title={detail.calibration.dataSource}>{detail.calibration.dataSource}</span>
              </div>
              <div className="flex justify-between">
                <span>Updated</span>
                <span className="font-medium text-foreground data-mono">{new Date(detail.calibration.lastUpdated).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
