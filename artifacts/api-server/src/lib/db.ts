/**
 * Database layer for the snapshot collector — thin wrappers over the shared
 * Drizzle/PostgreSQL instance from @workspace/db.
 *
 * All functions are async (PostgreSQL is network I/O, not local file I/O).
 *
 * Tables:
 *   snapshots — one row per bracket per station per 4-minute poll.
 *   outcomes  — one row per station per settlement date (NWS CLI final high).
 *
 * Deployment note: gap-free data requires an always-on process (Reserved VM
 * deployment on Replit).  A sleeping dev server will produce Swiss-cheese
 * snapshots.  Verify gap-freedom by checking that ts_utc rows are at most
 * ~5 min apart across a full overnight run.
 */

import { db, snapshots, outcomes } from "@workspace/db";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Shared types (snake_case to match the rest of the server codebase)
// ---------------------------------------------------------------------------

export interface SnapshotRow {
  ts_utc:          string;   // ISO-8601
  station_id:      string;
  settlement_date: string;   // YYYY-MM-DD in station LST
  hours_to_settle: number;
  running_high_f:  number;
  nbm_median_f:    number;
  bracket_lower_f: number | null;
  bracket_upper_f: number | null;
  bracket_label:   string;
  model_pct:       number;
  implied_pct:     number;
  bid_cents:       number | null;
  ask_cents:       number | null;
  edge_pts:        number;
  lock_status:     string;
}

export interface OutcomeRow {
  ts_utc:          string;
  station_id:      string;
  settlement_date: string;
  final_high_f:    number;
  source:          string;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Insert many snapshot rows in a single round-trip. */
export async function insertSnapshots(rows: SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(snapshots).values(
    rows.map((r) => ({
      tsUtc:          new Date(r.ts_utc),
      stationId:      r.station_id,
      settlementDate: r.settlement_date,
      hoursToSettle:  r.hours_to_settle,
      runningHighF:   r.running_high_f,
      nbmMedianF:     r.nbm_median_f,
      bracketLowerF:  r.bracket_lower_f,
      bracketUpperF:  r.bracket_upper_f,
      bracketLabel:   r.bracket_label,
      modelPct:       r.model_pct,
      impliedPct:     r.implied_pct,
      bidCents:       r.bid_cents,
      askCents:       r.ask_cents,
      edgePts:        r.edge_pts,
      lockStatus:     r.lock_status,
    }))
  );
}

/** Insert an outcome row; silently ignores duplicate (station, date) pairs. */
export async function insertOutcome(row: OutcomeRow): Promise<void> {
  await db
    .insert(outcomes)
    .values({
      tsUtc:          new Date(row.ts_utc),
      stationId:      row.station_id,
      settlementDate: row.settlement_date,
      finalHighF:     row.final_high_f,
      source:         row.source,
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Returns true if an outcome already exists for this station+date. */
export async function hasOutcome(
  stationId: string,
  settlementDate: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: outcomes.id })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.stationId, stationId),
        eq(outcomes.settlementDate, settlementDate)
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Returns distinct (station_id, settlement_date) pairs that have snapshots
 * but no outcome row.  The caller filters out today's date (still open).
 */
export async function getUnclosedDates(): Promise<
  Array<{ station_id: string; settlement_date: string }>
> {
  const rows = await db
    .selectDistinct({
      station_id:      snapshots.stationId,
      settlement_date: snapshots.settlementDate,
    })
    .from(snapshots)
    .leftJoin(
      outcomes,
      and(
        eq(outcomes.stationId, snapshots.stationId),
        eq(outcomes.settlementDate, snapshots.settlementDate)
      )
    )
    .where(isNull(outcomes.id))
    .orderBy(snapshots.settlementDate);
  return rows as Array<{ station_id: string; settlement_date: string }>;
}

/** Recent snapshots for one station, newest first (for the /snapshots route). */
export async function getRecentSnapshots(
  stationId: string,
  limit = 200
): Promise<SnapshotRow[]> {
  const rows = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.stationId, stationId))
    .orderBy(desc(snapshots.tsUtc))
    .limit(limit);

  return rows.map((r) => ({
    ts_utc:          r.tsUtc.toISOString(),
    station_id:      r.stationId,
    settlement_date: r.settlementDate,
    hours_to_settle: r.hoursToSettle,
    running_high_f:  r.runningHighF,
    nbm_median_f:    r.nbmMedianF,
    bracket_lower_f: r.bracketLowerF,
    bracket_upper_f: r.bracketUpperF,
    bracket_label:   r.bracketLabel,
    model_pct:       r.modelPct,
    implied_pct:     r.impliedPct,
    bid_cents:       r.bidCents,
    ask_cents:       r.askCents,
    edge_pts:        r.edgePts,
    lock_status:     r.lockStatus,
  }));
}

/**
 * Calibration data: per (station, bracket), return count, avg model/implied,
 * and actual resolve rate.  Only includes closed days (snapshot joined to
 * outcome) and non-dead brackets.
 */
export async function getCalibrationRows(): Promise<
  Array<{
    station_id:      string;
    bracket_label:   string;
    bracket_lower_f: number | null;
    bracket_upper_f: number | null;
    n:               number;
    avg_model_pct:   number;
    avg_implied_pct: number;
    resolved_yes:    number;
  }>
> {
  const result = await db.execute(sql`
    SELECT
      s.station_id,
      s.bracket_label,
      s.bracket_lower_f,
      s.bracket_upper_f,
      COUNT(*)                                  AS n,
      ROUND(AVG(s.model_pct)::numeric, 1)       AS avg_model_pct,
      ROUND(AVG(s.implied_pct)::numeric, 1)     AS avg_implied_pct,
      ROUND(AVG(
        CASE
          WHEN s.bracket_upper_f IS NULL
            THEN (o.final_high_f >= s.bracket_lower_f)::int::numeric
          WHEN s.bracket_lower_f IS NULL
            THEN (o.final_high_f <= s.bracket_upper_f)::int::numeric
          ELSE
            ((o.final_high_f >= s.bracket_lower_f
              AND o.final_high_f <= s.bracket_upper_f)::int)::numeric
        END
      )::numeric, 3)                            AS resolved_yes
    FROM snapshots s
    JOIN outcomes o
      ON o.station_id = s.station_id
     AND o.settlement_date = s.settlement_date
    WHERE s.lock_status != 'dead'
    GROUP BY s.station_id, s.bracket_label, s.bracket_lower_f, s.bracket_upper_f
    ORDER BY s.station_id, s.bracket_lower_f NULLS FIRST
  `);

  return (result.rows ?? []) as ReturnType<typeof getCalibrationRows> extends Promise<infer T> ? T : never;
}

// Log a one-time connection test so the operator can confirm DB is reachable.
db.execute(sql`SELECT 1`).then(() => {
  logger.info("Snapshot DB (PostgreSQL) reachable");
}).catch((err: unknown) => {
  logger.error({ err }, "Snapshot DB connection failed — snapshots will not be persisted");
});
