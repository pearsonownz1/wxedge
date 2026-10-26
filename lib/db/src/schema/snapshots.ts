/**
 * Snapshot collector schema.
 *
 * snapshots — one row per bracket per station per 4-minute poll.
 *             This is the primary reliability-curve dataset; it should never
 *             be deleted or altered retroactively.
 *
 * outcomes  — one row per station per settlement date, written the morning
 *             after by the CLI outcome logger.  Joining snapshots to outcomes
 *             produces the closed-loop calibration data.
 */

import {
  pgTable,
  serial,
  text,
  real,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const snapshots = pgTable(
  "snapshots",
  {
    id:             serial("id").primaryKey(),
    /** UTC wall-clock time of the poll that produced this row. */
    tsUtc:          timestamp("ts_utc", { withTimezone: true }).notNull(),
    stationId:      text("station_id").notNull(),
    /** Calendar date in the station's Local Standard Time (YYYY-MM-DD). */
    settlementDate: text("settlement_date").notNull(),
    /** Decimal hours remaining until midnight LST (end of the settlement day). */
    hoursToSettle:  real("hours_to_settle").notNull(),
    /** Highest temperature observed so far today (°F). */
    runningHighF:   real("running_high_f").notNull(),
    /** Bias-corrected NBM median forecast (°F). */
    nbmMedianF:     real("nbm_median_f").notNull(),
    /** Bracket lower bound in °F; NULL means unbounded below. */
    bracketLowerF:  real("bracket_lower_f"),
    /** Bracket upper bound in °F; NULL means unbounded above. */
    bracketUpperF:  real("bracket_upper_f"),
    bracketLabel:   text("bracket_label").notNull(),
    /** Model probability 0–100 (conditioned on running-high floor). */
    modelPct:       integer("model_pct").notNull(),
    /**
     * Kalshi YES mid-price as implied probability 0–100.
     * NULL = book not quotable (one-sided or spread > 20¢) — junk books are
     * recorded as absent, never as fictitious probabilities.
     */
    impliedPct:     integer("implied_pct"),
    bidCents:       integer("bid_cents"),
    askCents:       integer("ask_cents"),
    /** model_pct − implied_pct − kalshi_fee_pts. NULL when implied_pct is NULL. */
    edgePts:        real("edge_pts"),
    lockStatus:     text("lock_status").notNull(),
    /** Age of the most recent NWS observation at poll time (seconds). NULL if unknown. */
    obsAgeS:        real("obs_age_s"),
    /** True when this batch follows an unexplained gap (> max_age_min since last poll). */
    gapFlag:        boolean("gap_flag"),
  },
  (table) => [
    index("snapshots_station_date_idx").on(table.stationId, table.settlementDate),
    index("snapshots_ts_idx").on(table.tsUtc),
  ]
);

export const outcomes = pgTable(
  "outcomes",
  {
    id:             serial("id").primaryKey(),
    tsUtc:          timestamp("ts_utc", { withTimezone: true }).notNull(),
    stationId:      text("station_id").notNull(),
    settlementDate: text("settlement_date").notNull(),
    /** NWS CLI final daily maximum temperature (°F). */
    finalHighF:     real("final_high_f").notNull(),
    /** Data source — always "cli" for NWS Climatological Local Indication. */
    source:         text("source").notNull().default("cli"),
  },
  (table) => [
    uniqueIndex("outcomes_station_date_idx").on(table.stationId, table.settlementDate),
  ]
);
