import { useParams, Link } from "wouter";
import { 
  useGetMarket, 
  getGetMarketQueryKey 
} from "@workspace/api-client-react";
import { cn, formatPts, formatPct, formatTemp } from "@/lib/utils";
import { Shell } from "@/components/shell";
import { FeedBanner } from "@/components/feed-banner";
import { ArrowLeft, ExternalLink, Copy, CheckCircle2 } from "lucide-react";
import { useState } from "react";

export default function ContractDetail() {
  const { contractId } = useParams<{ contractId: string }>();

  const { data: market, isLoading } = useGetMarket(contractId!, {
    query: {
      enabled: !!contractId,
      refetchInterval: 30000,
      queryKey: getGetMarketQueryKey(contractId!),
    }
  });

  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <Shell>
        <div className="p-8 text-sm text-muted-foreground">Loading contract details...</div>
      </Shell>
    );
  }

  if (!market) {
    return (
      <Shell>
        <div className="p-8 text-sm text-destructive">Contract not found.</div>
      </Shell>
    );
  }

  const handleCopy = () => {
    const text = `WX Edge Analysis: ${market.contractId} (${market.bracket})
Model: ${market.modelPct.toFixed(0)}% | Ask: ${market.askCents ? market.askCents + '¢' : 'N/A'} | Edge: ${market.edgeNetPts.toFixed(1)} pts
NBM Median: ${market.disagreementBreakdown.rawNbmMedianF.toFixed(1)}°F -> Calibrated: ${market.disagreementBreakdown.calibratedMedianF.toFixed(1)}°F
${market.disagreementBreakdown.runningHighFloorNote ? 'Floor: ' + market.disagreementBreakdown.runningHighFloorNote : ''}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showEdge = market.feedFresh;
  const isActionable = market.status === 'actionable';

  return (
    <Shell>
      <FeedBanner fresh={market.feedFresh} timestampLst={market.bookSnapshotTimeLst} hideEdgeSignal />
      
      <div className="flex-1 bg-background overflow-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">
          
          {/* Top nav */}
          <div>
            <Link href="/markets" className="inline-flex items-center text-sm font-bold text-muted-foreground hover:text-foreground uppercase tracking-wider transition-colors">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Market Board
            </Link>
          </div>

          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b pb-6">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-4xl font-bold tracking-tight data-mono">{market.contractId}</h1>
                {isActionable && (
                  <span className="bg-primary/10 text-primary px-3 py-1 rounded-sm text-xs font-bold uppercase tracking-widest border border-primary/20">
                    Actionable
                  </span>
                )}
                {market.status === 'locked' && (
                  <span className="bg-muted text-muted-foreground px-3 py-1 rounded-sm text-xs font-bold uppercase tracking-widest border border-border">
                    Locked
                  </span>
                )}
              </div>
              <div className="text-xl text-muted-foreground font-medium">
                {market.stationName} · {market.contractDate} · High temp {market.bracket}
              </div>
            </div>
            
            <div className="text-right flex flex-col items-end">
              <div className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-1">Snapshot</div>
              <div className="flex items-center gap-3 text-lg data-mono">
                <span>Mod {formatPct(market.modelPct)}</span>
                <span className="text-muted-foreground">·</span>
                <span>Ask {market.askCents !== null ? `${market.askCents}¢` : "—"}</span>
                <span className="text-muted-foreground">·</span>
                <span className={cn("font-bold", isActionable && showEdge ? "text-primary" : (showEdge ? "text-foreground" : "text-muted-foreground"))}>
                  Edge {showEdge ? formatPts(market.edgeNetPts) : "—"} pts
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            
            {/* Left Column */}
            <div className="space-y-8">
              
              {/* Breakdown */}
              <section className="border bg-card p-6">
                <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-6">Why the model disagrees</h2>
                
                <div className="space-y-4 text-sm font-medium">
                  <div className="flex justify-between items-end border-b border-dashed border-border pb-2">
                    <span className="text-muted-foreground">Raw NBM Point Forecast (Median)</span>
                    <span className="text-lg data-mono">{market.disagreementBreakdown.rawNbmMedianF.toFixed(1)}°F</span>
                  </div>
                  
                  <div className="flex justify-between items-end border-b border-dashed border-border pb-2">
                    <span className="text-primary">{market.disagreementBreakdown.biasLabel}</span>
                    <span className="text-lg data-mono text-primary">
                      {market.disagreementBreakdown.biasAppliedF > 0 ? "+" : ""}{market.disagreementBreakdown.biasAppliedF.toFixed(2)}°F
                    </span>
                  </div>
                  
                  <div className="flex justify-between items-end border-b border-border pb-2">
                    <span className="font-bold">Calibrated Median</span>
                    <span className="text-xl font-bold data-mono">{market.disagreementBreakdown.calibratedMedianF.toFixed(1)}°F</span>
                  </div>
                  
                  <div className="flex justify-between items-end border-b border-dashed border-border pb-2 pt-2">
                    <span className="text-muted-foreground">Calibrated probability mass in bracket</span>
                    <span className="text-lg data-mono">{market.disagreementBreakdown.bracketMassPct.toFixed(1)}%</span>
                  </div>
                  
                  {market.disagreementBreakdown.runningHighFloorNote && (
                    <div className="flex justify-between items-end border-b border-dashed border-border pb-2">
                      <span className="text-primary">Running High Floor Active</span>
                      <span className="text-lg data-mono text-primary text-right max-w-[200px]">
                        {market.disagreementBreakdown.runningHighFloorNote}
                      </span>
                    </div>
                  )}

                  {market.disagreementBreakdown.lockinAmbiguityNote && (
                    <div className="flex justify-between items-end pb-2">
                      <span className="text-orange-600">METAR Rounding Caveat</span>
                      <span className="text-sm data-mono text-orange-600 text-right max-w-[200px]">
                        {market.disagreementBreakdown.lockinAmbiguityNote}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              {/* Actions */}
              <section className="flex gap-4">
                {market.kalshiUrl && (
                  <a 
                    href={market.kalshiUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex-1 bg-primary text-primary-foreground h-12 flex items-center justify-center gap-2 font-bold uppercase tracking-wider text-sm shadow hover:bg-primary/90 transition-colors"
                  >
                    Open on Kalshi
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
                <button 
                  onClick={handleCopy}
                  className="flex-1 bg-card border h-12 flex items-center justify-center gap-2 font-bold uppercase tracking-wider text-sm shadow-sm hover:bg-accent transition-colors"
                >
                  {copied ? (
                    <>Copied <CheckCircle2 className="w-4 h-4 text-green-600" /></>
                  ) : (
                    <>Copy Analysis <Copy className="w-4 h-4" /></>
                  )}
                </button>
              </section>

            </div>

            {/* Right Column */}
            <div className="space-y-8">
              
              {/* Order Book */}
              <section className="border bg-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Order Book Ladder</h2>
                  <div className="text-xs text-muted-foreground data-mono">{market.bookSnapshotTimeLst} LST</div>
                </div>

                <div className="bg-background border font-medium">
                  <div className="grid grid-cols-2 text-xs uppercase tracking-wider text-muted-foreground border-b bg-muted/30">
                    <div className="p-2 text-right border-r">Size</div>
                    <div className="p-2 pl-4">Price</div>
                  </div>
                  
                  <div className="divide-y text-sm data-mono">
                    {/* Asks (Sell) */}
                    {market.orderBook.filter(l => l.side === 'ask').reverse().map((level, i) => (
                      <div key={`ask-${i}`} className={cn(
                        "grid grid-cols-2 transition-colors",
                        level.isBest ? "bg-red-50 dark:bg-red-950/30 text-primary font-bold" : "text-muted-foreground hover:bg-accent"
                      )}>
                        <div className="p-2 text-right border-r">{level.size}</div>
                        <div className="p-2 pl-4">{level.priceCents}¢</div>
                      </div>
                    ))}
                    
                    {/* Spread indicator */}
                    <div className="grid grid-cols-2 bg-muted/50 border-y-2 border-border/50">
                      <div className="p-1 text-right border-r text-[10px] uppercase text-muted-foreground tracking-widest">Spread</div>
                      <div className="p-1 pl-4 text-[10px] text-muted-foreground">
                        {(() => {
                          const bestAsk = market.orderBook.find(l => l.side === 'ask' && l.isBest)?.priceCents;
                          const bestBid = market.orderBook.find(l => l.side === 'bid' && l.isBest)?.priceCents;
                          if (bestAsk !== undefined && bestBid !== undefined) return `${bestAsk - bestBid}¢`;
                          return "—";
                        })()}
                      </div>
                    </div>

                    {/* Bids (Buy) */}
                    {market.orderBook.filter(l => l.side === 'bid').map((level, i) => (
                      <div key={`bid-${i}`} className={cn(
                        "grid grid-cols-2 transition-colors",
                        level.isBest ? "bg-blue-50 dark:bg-blue-950/30 text-blue-600 font-bold" : "text-muted-foreground hover:bg-accent"
                      )}>
                        <div className="p-2 text-right border-r">{level.size}</div>
                        <div className="p-2 pl-4">{level.priceCents}¢</div>
                      </div>
                    ))}

                    {market.orderBook.length === 0 && (
                      <div className="p-4 text-center text-muted-foreground text-sm">Book empty</div>
                    )}
                  </div>
                </div>
              </section>

              {/* Mini All-Brackets Chart */}
              <section className="border bg-card p-6">
                <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-6">Full Station Distribution</h2>
                
                <div className="space-y-2">
                  {market.allBrackets.map(b => {
                    const isCurrent = b.label === market.bracket;
                    return (
                      <div key={b.label} className={cn("flex items-center gap-3", isCurrent ? "" : "opacity-60")}>
                        <div className={cn("w-16 shrink-0 text-xs text-right data-mono", isCurrent ? "font-bold" : "text-muted-foreground")}>
                          {b.label}
                        </div>
                        <div className="flex-1 h-6 relative border-l pl-2 flex items-center">
                          <div className="w-full relative h-4 flex flex-col justify-center gap-[1px]">
                            <div className={cn("h-1.5 rounded-r-sm", isCurrent ? "bg-primary" : "bg-muted-foreground")} style={{ width: `${Math.max(b.modelPct, 1)}%` }} />
                            <div className="h-1.5 bg-foreground/20 rounded-r-sm" style={{ width: `${Math.max(b.impliedPct, 1)}%` }} />
                          </div>
                        </div>
                        <div className="w-16 shrink-0 text-[10px] data-mono text-muted-foreground flex flex-col justify-center">
                          <div>M {b.modelPct.toFixed(0)}%</div>
                          <div>K {b.impliedPct.toFixed(0)}%</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

            </div>

          </div>

        </div>
      </div>
    </Shell>
  );
}
