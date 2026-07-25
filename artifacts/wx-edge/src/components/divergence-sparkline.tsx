/**
 * DivergenceSparkline — 120×28 inline chart of (model% − market%) over 24h.
 * Design spec: frame 1c, WX Edge Design Handoff 25 Jul 2026.
 *
 * Rules from spec:
 * - Above zero: model more confident than market (primary red)
 * - Below zero: market more confident (oklch(0.55 0.09 250) blue-slate)
 * - Zero axis: agreement
 * - Gap: feed outage — NEVER interpolated, shown as literal break
 * - Terminus dot: suppressed when stale, otherwise shown
 */

const DIV_NEGATIVE = "oklch(0.55 0.09 250)";
const DIV_POSITIVE = "hsl(350 85% 55%)"; // --primary

interface SparkPoint {
  delta: number;       // model% − market%  (can be NaN/null for gaps)
  timeLst: string;
}

interface DivergenceSparklineProps {
  points?: SparkPoint[];
  width?: number;
  height?: number;
  stale?: boolean;
}

export function DivergenceSparkline({
  points = [],
  width = 120,
  height = 28,
  stale = false,
}: DivergenceSparklineProps) {
  if (!points.length) {
    // Flat line placeholder while data is loading / absent
    return (
      <svg width={width} height={height} aria-hidden>
        <line
          x1={0} y1={height / 2}
          x2={width} y2={height / 2}
          stroke="hsl(0 0% 80%)" strokeWidth={1}
        />
      </svg>
    );
  }

  const validDeltas = points.map((p) => p.delta).filter((d) => isFinite(d));
  if (!validDeltas.length) return null;

  const maxAbs = Math.max(Math.abs(Math.min(...validDeltas)), Math.abs(Math.max(...validDeltas)), 5);
  const midY = height / 2;
  const scaleY = (delta: number) => midY - (delta / maxAbs) * (midY - 2);

  const n = points.length;

  // Build SVG path segments; gaps (NaN) break the path
  function buildPath(positiveOnly: boolean): string {
    let d = "";
    let penDown = false;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * width;
      const delta = points[i].delta;
      const isGap = !isFinite(delta);
      if (isGap) {
        penDown = false;
        continue;
      }
      if (positiveOnly && delta < 0) { penDown = false; continue; }
      if (!positiveOnly && delta > 0) { penDown = false; continue; }
      const y = scaleY(delta);
      if (!penDown) {
        d += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
        penDown = true;
      } else {
        d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
      }
    }
    return d;
  }

  // Terminus point
  const last = [...points].reverse().find((p) => isFinite(p.delta));
  const lastX = last ? ((points.lastIndexOf(last)) / (n - 1)) * width : null;
  const lastY = last ? scaleY(last.delta) : null;
  const lastColor = last && last.delta < 0 ? DIV_NEGATIVE : DIV_POSITIVE;

  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block", overflow: "visible" }}>
      {/* Zero axis */}
      <line
        x1={0} y1={midY} x2={width} y2={midY}
        stroke="hsl(0 0% 85%)" strokeWidth={0.5}
      />
      {/* Positive line (model > market) */}
      <path
        d={buildPath(true)}
        fill="none"
        stroke={DIV_POSITIVE}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Negative line (market > model) */}
      <path
        d={buildPath(false)}
        fill="none"
        stroke={DIV_NEGATIVE}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Terminus dot — suppressed when stale */}
      {!stale && last && lastX !== null && lastY !== null && (
        <circle cx={lastX} cy={lastY} r={2.5} fill={lastColor} />
      )}
    </svg>
  );
}
