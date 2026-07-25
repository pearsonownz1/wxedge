/**
 * Distribution builder and bracket probability calculator.
 *
 * Approach:
 *   1. Use NWS/NBM forecast as the "NBM median".
 *   2. Apply station-specific seasonal bias correction to all percentiles.
 *   3. Model temperature distribution as an asymmetric two-sided half-normal
 *      fitted to the NBM P10/P50/P90 spread (skewed distribution).
 *      Falls back to symmetric Normal(calibratedMedian, rmse) when NBM
 *      percentiles are unavailable.
 *   4. Integrate the CDF over each Kalshi bracket boundary.
 *   5. Apply lock-in logic from running high.
 *
 * Lock-in semantics:
 *   - dead:      upper bound ≤ running high → impossible
 *   - ambiguous: bracket contains running high boundary (±1°F METAR rounding)
 *   - live:      still possible
 */

import type { KalshiBracket } from "./kalshiApi.js";
import type { NbmPercentiles } from "./nwsApi.js";

/** Error function approximation (Abramowitz & Stegun, max error 1.5e-7). */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/** Normal CDF: P(X ≤ x) where X ~ N(mean, sigma). */
function normalCdf(x: number, mean: number, sigma: number): number {
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.sqrt(2))));
}

/**
 * Asymmetric two-sided half-normal CDF fitted to NBM P10/P50/P90.
 *
 * Below the median: sigma_left  = (p50 − p10) / 1.2816
 * Above the median: sigma_right = (p90 − p50) / 1.2816
 *
 * Each half integrates to exactly 0.5, so the combined CDF is monotone
 * and ranges from 0 to 1.
 */
function asymmetricNormalCdf(
  x: number,
  p10: number,
  p50: number,
  p90: number
): number {
  // Floor the sigmas so degenerate spreads (e.g. all percentiles equal) still
  // produce a reasonable CDF rather than a step function.
  const sigmaLeft = Math.max((p50 - p10) / 1.2816, 0.5);
  const sigmaRight = Math.max((p90 - p50) / 1.2816, 0.5);

  if (x <= p50) {
    return 0.5 * (1 + erf((x - p50) / (sigmaLeft * Math.SQRT2)));
  } else {
    return 0.5 * (1 + erf((x - p50) / (sigmaRight * Math.SQRT2)));
  }
}

/** P(lowerF < X ≤ upperF) under Normal(mean, sigma). */
function bracketMassNormal(
  lowerF: number | null,
  upperF: number | null,
  mean: number,
  sigma: number
): number {
  const lo = lowerF == null ? 0 : normalCdf(lowerF, mean, sigma);
  const hi = upperF == null ? 1 : normalCdf(upperF + 1, mean, sigma);
  // upperF is inclusive: integrate to upperF + 1 (next bracket starts at upperF + 1)
  return Math.max(0, Math.min(1, hi - lo));
}

/**
 * P(lowerF < X ≤ upperF) under the asymmetric distribution fitted to
 * bias-corrected NBM percentiles.
 */
function bracketMassAsymmetric(
  lowerF: number | null,
  upperF: number | null,
  p10: number,
  p50: number,
  p90: number
): number {
  const cdf = (x: number) => asymmetricNormalCdf(x, p10, p50, p90);
  const lo = lowerF == null ? 0 : cdf(lowerF);
  const hi = upperF == null ? 1 : cdf(upperF + 1);
  return Math.max(0, Math.min(1, hi - lo));
}

export type LockStatus = "live" | "dead" | "ambiguous";

export interface BracketResult {
  contractId: string | null;
  label: string;
  lowerBoundF: number | null;
  upperBoundF: number | null;
  modelPct: number;
  impliedPct: number;
  edgePts: number;
  lockStatus: LockStatus;
  bidCents: number | null;
  askCents: number | null;
}

function getLockStatus(
  lowerBoundF: number | null,
  upperBoundF: number | null,
  runningHighF: number
): LockStatus {
  // A bracket is DEAD if its upper bound has been passed by the running high
  if (upperBoundF != null && runningHighF > upperBoundF) return "dead";

  // A bracket is AMBIGUOUS if the running high is within 1°F of either boundary
  // (METAR rounds to nearest integer; CLI uses 1-min sensor so can differ by 1°)
  const METAR_ROUNDING = 1.0;
  if (
    upperBoundF != null &&
    Math.abs(runningHighF - upperBoundF) <= METAR_ROUNDING
  )
    return "ambiguous";
  if (
    lowerBoundF != null &&
    Math.abs(runningHighF - lowerBoundF) <= METAR_ROUNDING
  )
    return "ambiguous";

  return "live";
}

const FEE_PTS = 1; // 1 probability point round-trip fee assumption

export function buildBracketDistribution(
  kalshiBrackets: KalshiBracket[],
  nbmMedianF: number,
  biasF: number,
  rmse: number,
  runningHighF: number,
  percentiles?: NbmPercentiles | null
): BracketResult[] {
  const calibratedMedian = nbmMedianF + biasF;

  // Apply bias correction to all percentile values so the calibrated
  // distribution is shifted by the same mean-bias as the point forecast.
  const useAsymmetric = percentiles != null;
  const cp10 = useAsymmetric ? percentiles!.p10F + biasF : 0;
  const cp50 = useAsymmetric ? percentiles!.p50F + biasF : 0;
  const cp90 = useAsymmetric ? percentiles!.p90F + biasF : 0;

  // Raw model probabilities: asymmetric if NBM percentiles available, else Normal
  const rawProbs = kalshiBrackets.map((b) =>
    useAsymmetric
      ? bracketMassAsymmetric(b.lowerBoundF, b.upperBoundF, cp10, cp50, cp90)
      : bracketMassNormal(b.lowerBoundF, b.upperBoundF, calibratedMedian, rmse)
  );

  // Normalise so they sum to 100
  const total = rawProbs.reduce((s, p) => s + p, 0);
  const normFactor = total > 0 ? 1 / total : 1;

  return kalshiBrackets.map((b, i) => {
    const rawModelPct = Math.round(rawProbs[i] * normFactor * 100);
    const impliedPct = b.impliedPct;
    const edgePts = rawModelPct - impliedPct - FEE_PTS;
    const lockStatus = getLockStatus(b.lowerBoundF, b.upperBoundF, runningHighF);

    return {
      contractId: b.contractId,
      label: b.label,
      lowerBoundF: b.lowerBoundF,
      upperBoundF: b.upperBoundF,
      modelPct: rawModelPct,
      impliedPct,
      edgePts: parseFloat(edgePts.toFixed(1)),
      lockStatus,
      bidCents: b.bidCents,
      askCents: b.askCents,
    };
  });
}

export function bestEdge(brackets: BracketResult[]): BracketResult | null {
  const live = brackets.filter((b) => b.lockStatus !== "dead");
  if (live.length === 0) return null;
  return live.reduce((best, b) =>
    Math.abs(b.edgePts) > Math.abs(best.edgePts) ? b : best
  );
}

export function getMarketStatus(b: BracketResult): "actionable" | "settled_short" | "below_threshold" | "locked" {
  if (b.lockStatus === "dead") return "settled_short";
  if (b.lockStatus === "ambiguous") return "below_threshold";
  if (Math.abs(b.edgePts) >= 5) return "actionable";
  return "below_threshold";
}

/** Running high floor note for the "WHY" breakdown. */
export function runningHighFloorNote(
  lowerBoundF: number | null,
  upperBoundF: number | null,
  runningHighF: number,
  modelPct: number
): string | null {
  if (lowerBoundF != null && runningHighF >= lowerBoundF) {
    return `≥ ${modelPct}% conditional (${runningHighF}°F touched)`;
  }
  return null;
}

/** METAR-vs-CLI ambiguity note. */
export function lockinAmbiguityNote(lockStatus: LockStatus): string | null {
  if (lockStatus === "ambiguous") {
    return "METAR rounding: running high from hourly ASOS may differ from final CLI by 1°F. Treat as ambiguous rather than locked.";
  }
  return null;
}
