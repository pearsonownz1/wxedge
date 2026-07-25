/**
 * RaceTrack — horizontal gauge showing bracket zones, running high marker,
 * and a book/divergence table. Design spec: WX Edge Design Handoff 25 Jul 2026,
 * frames 1a/1b.
 *
 * Layout:
 *   ┌─ zone ─┬─ zone ─┬─ zone ─┬─ zone ─┬─ zone ─┐
 *   │ DEAD   │ DEAD   │ DEAD   │ ═══════│         │
 *   └────────┴────────┴────────┴────────┴─────────┘
 *                              ↑ running high marker
 *
 * Below the track: per-bracket MKT / MODEL table.
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface Bracket {
  label: string;
  lowerBoundF: number | null;
  upperBoundF: number | null;
  modelPct: number;
  impliedPct: number;
  bidCents: number | null;
  askCents: number | null;
  lockStatus: string;
}

interface RaceTrackProps {
  brackets: Bracket[];
  runningHighF: number;
  stationId: string;
  contractDate: string;
  stale?: boolean;
}

// oklch(0.55 0.09 250) – divergence-negative hue from design spec
const DIV_NEGATIVE = "oklch(0.55 0.09 250)";

/** Best estimate of a bracket's temperature midpoint for ordering. */
function midpoint(b: Bracket): number {
  if (b.lowerBoundF !== null && b.upperBoundF !== null)
    return (b.lowerBoundF + b.upperBoundF) / 2;
  if (b.lowerBoundF !== null) return b.lowerBoundF + 0.5;
  if (b.upperBoundF !== null) return b.upperBoundF - 0.5;
  return 0;
}

export function RaceTrack({
  brackets,
  runningHighF,
  stationId,
  contractDate,
  stale = false,
}: RaceTrackProps) {
  const sorted = useMemo(
    () => [...brackets].sort((a, b) => midpoint(a) - midpoint(b)),
    [brackets]
  );

  // Derive fixed range from bracket bounds
  const { trackMin, trackMax, totalRange } = useMemo(() => {
    const lows = sorted
      .map((b) => b.lowerBoundF)
      .filter((v): v is number => v !== null);
    const highs = sorted
      .map((b) => b.upperBoundF)
      .filter((v): v is number => v !== null);
    if (!lows.length || !highs.length) return { trackMin: 80, trackMax: 110, totalRange: 30 };
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    return { trackMin: min, trackMax: max, totalRange: max - min };
  }, [sorted]);

  /** Convert °F to % position along track. */
  function pct(tempF: number) {
    return Math.max(0, Math.min(100, ((tempF - trackMin) / totalRange) * 100));
  }

  /** Width % for a single bracket. */
  function zonePct(b: Bracket) {
    const lo = b.lowerBoundF ?? trackMin;
    const hi = b.upperBoundF ?? trackMax;
    return ((hi - lo) / totalRange) * 100;
  }

  const markerPct = pct(runningHighF);

  /** True when running high is inside this zone. */
  const currentZoneIdx = useMemo(
    () =>
      sorted.findIndex(
        (b) =>
          (b.lowerBoundF === null || runningHighF >= b.lowerBoundF) &&
          (b.upperBoundF === null || runningHighF < b.upperBoundF)
      ),
    [sorted, runningHighF]
  );

  const isDead = (b: Bracket) => b.lockStatus === "dead";
  const divDelta = (b: Bracket) => b.modelPct - b.impliedPct;

  return (
    <div className={cn("flex flex-col gap-0", stale && "opacity-60")}>
      {/* Track header */}
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          THE RACE TRACK · {stationId} {contractDate}
        </span>
        <span className="text-[10px] text-muted-foreground data-mono">
          range {trackMin}–{trackMax}°F
        </span>
      </div>

      {/* Track + marker container */}
      <div className="relative">
        {/* Zone strip */}
        <div className="flex h-10 w-full border border-border overflow-hidden">
          {sorted.map((b, i) => {
            const dead = isDead(b);
            const isCurrent = i === currentZoneIdx;
            const isPast = !dead && midpoint(b) < runningHighF && i < currentZoneIdx;
            const w = zonePct(b);

            return (
              <div
                key={b.label}
                className={cn(
                  "relative flex-none border-r last:border-r-0 flex items-end pb-0.5 overflow-hidden transition-all",
                  dead
                    ? "bg-muted/60"
                    : isCurrent
                    ? "bg-primary/10 border-t-2 border-t-primary"
                    : isPast
                    ? "bg-muted/30"
                    : "bg-background"
                )}
                style={{ width: `${w}%` }}
              >
                {/* Zone label */}
                <span
                  className={cn(
                    "absolute bottom-0.5 left-0 right-0 text-center text-[8px] font-bold data-mono uppercase tracking-wide truncate px-0.5",
                    dead
                      ? "text-muted-foreground/50"
                      : isCurrent
                      ? "text-primary"
                      : "text-muted-foreground"
                  )}
                >
                  {dead ? "✕" : b.label.replace("°", "")}
                </span>

                {/* Dead diagonal overlay */}
                {dead && (
                  <div
                    className="absolute inset-0 opacity-20"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(-45deg, currentColor 0, currentColor 1px, transparent 0, transparent 50%)",
                      backgroundSize: "6px 6px",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Running high marker — vertical line + dot + label */}
        <div
          className={cn(
            "absolute top-0 bottom-0 pointer-events-none flex flex-col items-center",
            stale ? "opacity-45" : ""
          )}
          style={{ left: `${markerPct}%`, transform: "translateX(-50%)" }}
        >
          <div className="w-px h-full bg-foreground" />
          {/* Tick above track */}
          <div
            className="absolute -top-5 flex flex-col items-center"
            style={{ transform: "translateX(-50%)", left: "50%" }}
          >
            <span className="text-[9px] font-bold data-mono whitespace-nowrap bg-background border border-foreground px-1 leading-tight">
              {runningHighF.toFixed(1)}°
            </span>
          </div>
        </div>
      </div>

      {/* Temperature axis labels */}
      <div className="relative h-4 mt-0.5">
        <span className="absolute left-0 text-[9px] text-muted-foreground data-mono">{trackMin}°</span>
        <span className="absolute right-0 text-[9px] text-muted-foreground data-mono">{trackMax}°</span>
      </div>

      {/* TOP OF BOOK table */}
      <div className="mt-4 border border-border">
        <div className="flex items-center gap-3 px-3 py-1.5 border-b bg-muted/50">
          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
            Top of Book · Divergence
          </span>
        </div>
        <div className="divide-y">
          {sorted
            .filter((b) => !isDead(b) && b.modelPct > 0)
            .map((b) => {
              const delta = divDelta(b);
              const isPositive = delta >= 0;

              return (
                <div
                  key={b.label}
                  className={cn(
                    "flex items-center px-3 py-1.5 text-[11px] gap-3",
                    b.lockStatus === "ambiguous" && "opacity-60"
                  )}
                >
                  {/* Bracket label */}
                  <span className="w-16 font-bold data-mono shrink-0 text-foreground">
                    {b.label}
                  </span>

                  {/* Market price */}
                  <div className="flex-1">
                    <span className="text-muted-foreground text-[9px] uppercase tracking-wider block leading-none mb-0.5">
                      MKT
                    </span>
                    <span className="data-mono font-medium text-muted-foreground">
                      {b.bidCents !== null ? `${b.bidCents}¢` : "—"}
                    </span>
                  </div>

                  {/* Model % */}
                  <div className="flex-1">
                    <span className="text-[9px] uppercase tracking-wider block leading-none mb-0.5 text-primary">
                      MODEL
                    </span>
                    <span className="data-mono font-bold text-primary">
                      {b.modelPct.toFixed(1)}%
                    </span>
                  </div>

                  {/* Δ divergence */}
                  <div className="w-14 text-right">
                    <span className="text-[9px] uppercase tracking-wider block leading-none mb-0.5 text-muted-foreground">
                      Δ
                    </span>
                    <span
                      className="data-mono font-bold text-[11px]"
                      style={
                        !isPositive ? { color: DIV_NEGATIVE } : undefined
                      }
                    >
                      <span className={cn(isPositive ? "text-primary" : "")}>
                        {isPositive ? "+" : ""}
                        {delta.toFixed(1)}
                      </span>
                    </span>
                  </div>

                  {/* Mini divergence bar */}
                  <div className="w-20 shrink-0 h-4 relative flex items-center">
                    <div className="absolute left-1/2 w-px h-full bg-border" />
                    <div
                      className={cn(
                        "absolute h-2 max-w-[38px]",
                        isPositive ? "bg-primary/70 left-1/2" : "right-1/2"
                      )}
                      style={{
                        width: `${Math.min(Math.abs(delta) * 1.2, 38)}px`,
                        backgroundColor: !isPositive ? DIV_NEGATIVE : undefined,
                        opacity: !isPositive ? 0.7 : undefined,
                      }}
                    />
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {stale && (
        <div className="mt-2 text-[10px] text-muted-foreground uppercase tracking-wider text-center">
          Track frozen at last-good high — obs feed stale
        </div>
      )}
    </div>
  );
}
