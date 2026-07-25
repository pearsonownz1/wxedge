/**
 * KillFeed — today's bracket elimination log.
 * Design spec: frames 1a / 1b from WX Edge Design Handoff 25 Jul 2026.
 *
 * Derives elimination events from the intraday observation series:
 * a bracket is eliminated when the running high first crosses its upper bound.
 * Timestamps come from the obs array, so accuracy depends on obs cadence (~1h).
 *
 * Kill feed rules (from spec):
 * - Day-scoped. No sound, no unread counters.
 * - While stale: header shows PAUSED, rows dim, events backfill at true timestamp.
 * - Empty state: "No eliminations yet — first usually lands after ~1 PM local."
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface Bracket {
  label: string;
  lowerBoundF: number | null;
  upperBoundF: number | null;
  bidCents: number | null;
  lockStatus: string;
}

interface IntradayObs {
  timeLst: string;
  tempF: number;
}

interface KillEvent {
  time: string;       // e.g. "2:42 PM"
  tag: "ELIMINATION";
  text: string;       // "KNYC passed 92.0°. Bracket 91–92° eliminated."
  clause: string;     // "Market still pricing it at 3¢."
}

interface KillFeedProps {
  brackets: Bracket[];
  intradayObs: IntradayObs[];
  stationId: string;
  stale?: boolean;
}

export function KillFeed({ brackets, intradayObs, stationId, stale = false }: KillFeedProps) {
  const events = useMemo<KillEvent[]>(() => {
    const dead = brackets.filter(
      (b) => b.lockStatus === "dead" && b.upperBoundF !== null
    );
    if (!dead.length || !intradayObs.length) return [];

    const found: KillEvent[] = [];

    for (const b of dead) {
      const threshold = b.upperBoundF!;
      // Find the first observation where running high crossed this bracket's ceiling
      const crossingObs = intradayObs.find((obs) => obs.tempF >= threshold);

      if (crossingObs) {
        const mktStr =
          b.bidCents !== null ? `Market still pricing it at ${b.bidCents}¢.` : "";
        found.push({
          time: crossingObs.timeLst,
          tag: "ELIMINATION",
          text: `${stationId} passed ${threshold.toFixed(0)}°. Bracket ${b.label} eliminated.`,
          clause: mktStr,
        });
      }
    }

    // Sort by the bracket's upper bound ascending (order of elimination)
    return found.sort((a, b) => {
      // Sort by time of first crossing — derive from intradayObs index
      const tA = intradayObs.findIndex((o) => o.timeLst === a.time);
      const tB = intradayObs.findIndex((o) => o.timeLst === b.time);
      return tA - tB;
    });
  }, [brackets, intradayObs, stationId]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
          {stale ? "Kill Feed · Paused" : "Kill Feed"}
        </span>
        <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
          Today · All Times LST
        </span>
      </div>

      {/* Event list */}
      <div className={cn("flex-1 overflow-y-auto divide-y", stale && "opacity-60")}>
        {events.length === 0 ? (
          <div className="px-3 py-6 text-[11px] text-muted-foreground text-center leading-relaxed">
            No eliminations yet —<br />
            first usually lands after ~1 PM local.
          </div>
        ) : (
          events.map((ev, i) => (
            <div key={i} className="px-3 py-2.5 group hover:bg-accent/50 transition-colors">
              {/* Time + tag row */}
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] data-mono text-muted-foreground">
                  {ev.time}
                </span>
                <span className="text-[8px] font-bold uppercase tracking-widest px-1 py-0.5 bg-foreground text-background">
                  {ev.tag}
                </span>
              </div>
              {/* Event text */}
              <p className="text-[11px] text-foreground leading-snug">
                {ev.text}
              </p>
              {/* Clause */}
              {ev.clause && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {ev.clause}
                </p>
              )}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {stale && (
        <div className="px-3 py-1.5 border-t text-[9px] text-muted-foreground uppercase tracking-wider shrink-0">
          Feed paused · events backfill at true timestamp
        </div>
      )}
    </div>
  );
}
