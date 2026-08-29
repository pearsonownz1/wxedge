/**
 * Pipeline health watchdog — shared between the trader (log-level alert) and
 * the api-server (dashboard banner).
 *
 * Answers one question: has the trading pipeline gone dark, and if so why?
 *
 * The failure mode this guards against: every signal suppressed for days by a
 * systemic gate (stale feed, incoherent books, over-eager safety check), which
 * looks identical to "no good trades today" unless you inspect the
 * suppressed_reason mix in the signals table.
 *
 * Statuses (windowHours defaults to 24):
 *   ok      — live (unsuppressed) signals were produced within the window.
 *   quiet   — no live signals, but the suppression mix is dominated by
 *             below_threshold / lock_dead: the engine is evaluating fine,
 *             there is simply no edge. Legitimate.
 *   blocked — no live signals AND systemic gates (staleness, obs_stale,
 *             book_incoherent, gap_data, no_price) dominate the mix.
 *             Something upstream is broken.
 *   stalled — live signals exist but zero proposals reached the approval
 *             queue in the window: the risk officer / cooldown is eating
 *             everything.
 *   dark    — zero signal rows at all in the window: the engine is not even
 *             evaluating (trader down, collector dead, no snapshots).
 */

import { sql } from "drizzle-orm";
import { db } from "./index";

/** Reasons that indicate a broken input, not a legitimate lack of edge. */
const SYSTEMIC_REASONS = new Set([
  "staleness",
  "obs_stale",
  "book_incoherent",
  "gap_data",
  "no_price",
]);

/** Benign reasons: the engine evaluated and correctly found nothing. */
const BENIGN_REASONS = new Set(["below_threshold", "lock_dead", "station_not_active"]);

/** Fraction of suppressed rows that must be systemic to call it "blocked". */
const SYSTEMIC_DOMINANCE = 0.5;

export type PipelineStatus = "ok" | "quiet" | "blocked" | "stalled" | "dark";

export interface PipelineHealth {
  status: PipelineStatus;
  windowHours: number;
  /** All signal rows evaluated in the window (suppressed + live). */
  evaluatedCount: number;
  /** Rows with suppressed_reason IS NULL (actionable candidates). */
  liveCount: number;
  /** Proposals created (approvals rows) in the window. */
  proposalCount: number;
  /** Most common suppression reason in the window, if any. */
  dominantReason: string | null;
  /** Share (0–1) of suppressed rows carrying dominantReason. */
  dominantShare: number | null;
  /** Full reason → count mix for the window. */
  reasonMix: Record<string, number>;
  /** ISO timestamps of last activity, null if never. */
  lastSignalTs: string | null;
  lastLiveSignalTs: string | null;
  lastProposalTs: string | null;
  /** Human-readable one-liner suitable for a banner or log line. */
  summary: string;
}

export async function computePipelineHealth(
  windowHours = 24
): Promise<PipelineHealth> {
  const hours = Math.max(1, Math.floor(windowHours));

  const mixQ = db.execute(sql`
    SELECT COALESCE(suppressed_reason, '__live__') AS reason, COUNT(*)::int AS n
    FROM signals
    WHERE ts_utc > now() - make_interval(hours => ${hours})
    GROUP BY 1
  `);
  const lastQ = db.execute(sql`
    SELECT
      (SELECT max(ts_utc) FROM signals)                                    AS last_signal,
      (SELECT max(ts_utc) FROM signals WHERE suppressed_reason IS NULL)    AS last_live,
      (SELECT max(proposed_ts) FROM approvals)                             AS last_proposal,
      (SELECT COUNT(*)::int FROM approvals
        WHERE proposed_ts > now() - make_interval(hours => ${hours}))      AS proposals_in_window
  `);
  const [mixRes, lastRes] = await Promise.all([mixQ, lastQ]);

  const reasonMix: Record<string, number> = {};
  let liveCount = 0;
  let evaluatedCount = 0;
  for (const row of mixRes.rows as { reason: string; n: number }[]) {
    evaluatedCount += row.n;
    if (row.reason === "__live__") liveCount = row.n;
    else reasonMix[row.reason] = row.n;
  }

  const last = (lastRes.rows[0] ?? {}) as {
    last_signal: Date | string | null;
    last_live: Date | string | null;
    last_proposal: Date | string | null;
    proposals_in_window: number;
  };
  const iso = (v: Date | string | null | undefined): string | null =>
    v == null ? null : new Date(v).toISOString();

  const suppressedCount = evaluatedCount - liveCount;
  let dominantReason: string | null = null;
  let dominantShare: number | null = null;
  if (suppressedCount > 0) {
    const sorted = Object.entries(reasonMix).sort((a, b) => b[1] - a[1]);
    dominantReason = sorted[0]?.[0] ?? null;
    dominantShare = sorted[0] ? sorted[0][1] / suppressedCount : null;
  }

  const systemicCount = Object.entries(reasonMix)
    .filter(([r]) => SYSTEMIC_REASONS.has(r) || !BENIGN_REASONS.has(r))
    .reduce((acc, [, n]) => acc + n, 0);

  const proposalCount = last.proposals_in_window ?? 0;

  let status: PipelineStatus;
  let summary: string;
  if (evaluatedCount === 0) {
    status = "dark";
    summary = `Signal engine has evaluated ZERO signals in the last ${hours}h — trader down, collector dead, or no snapshots. Last signal: ${iso(last.last_signal) ?? "never"}.`;
  } else if (liveCount === 0) {
    const systemicShare = suppressedCount > 0 ? systemicCount / suppressedCount : 0;
    if (systemicShare >= SYSTEMIC_DOMINANCE) {
      status = "blocked";
      summary = `100% of ${evaluatedCount} signals suppressed in the last ${hours}h and systemic gates dominate — dominant reason: ${dominantReason} (${Math.round((dominantShare ?? 0) * 100)}% of suppressions). This is a broken input, not a quiet market.`;
    } else {
      status = "quiet";
      summary = `No live signals in the last ${hours}h, but suppressions are dominated by ${dominantReason} — engine is evaluating normally; no edge to trade.`;
    }
  } else if (proposalCount === 0) {
    status = "stalled";
    summary = `${liveCount} live signals in the last ${hours}h but ZERO proposals reached the approval queue — risk officer or cooldown may be rejecting everything. Last proposal: ${iso(last.last_proposal) ?? "never"}.`;
  } else {
    status = "ok";
    summary = `Pipeline healthy: ${liveCount} live signals and ${proposalCount} proposals in the last ${hours}h.`;
  }

  return {
    status,
    windowHours: hours,
    evaluatedCount,
    liveCount,
    proposalCount,
    dominantReason,
    dominantShare,
    reasonMix,
    lastSignalTs: iso(last.last_signal),
    lastLiveSignalTs: iso(last.last_live),
    lastProposalTs: iso(last.last_proposal),
    summary,
  };
}
