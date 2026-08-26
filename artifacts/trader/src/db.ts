/**
 * Trader-side database layer.
 *
 * All reads and writes for the trading pipeline (signal engine, risk officer,
 * executor, auditor, approvals) live here.  Uses the shared @workspace/db
 * Drizzle client.
 *
 * Convention: raw SQL via db.execute() for complex joins/aggregations; Drizzle
 * ORM for simple inserts and point lookups.
 */

import { db } from "@workspace/db";
import {
  books,
  signals,
  riskDecisions,
  orders,
  approvals,
  settlements,
  dailyPnl,
  outcomes,
  snapshots,
} from "@workspace/db";
import { eq, and, sql, isNull } from "drizzle-orm";
import { existsSync } from "node:fs";

// ─── Re-exported types ────────────────────────────────────────────────────────

export interface BookRow {
  ts_utc:       string;
  station_id:   string;
  ticker:       string;
  bracket_lo:   number | null;
  bracket_hi:   number | null;
  yes_bid:      number | null;
  yes_ask:      number | null;
  no_bid:       number | null;
  no_ask:       number | null;
  coherent_flag: boolean;
}

export interface SnapshotSignalInput {
  ts_utc:         string;
  station_id:     string;
  ticker:         string;  // Kalshi contract ticker from books table
  settlement_date: string;
  hours_to_settle: number;
  running_high_f:  number;
  nbm_median_f:    number;
  bracket_lower_f: number | null;
  bracket_upper_f: number | null;
  bracket_label:   string;
  model_pct:       number;
  bid_cents:       number | null;
  ask_cents:       number | null;
  lock_status:     string;
  obs_age_s:       number | null;
  gap_flag:        boolean | null;
  coherent_flag:   boolean;
}

export interface SignalRow {
  id?:              number;
  ts_utc:           string;
  station_id:       string;
  ticker:           string;
  side:             "YES" | "NO";
  limit_price:      number;   // cents
  model_prob:       number;   // 0–1
  implied_prob:     number;   // 0–1
  edge_net:         number;
  inputs_hash:      string;
  suppressed_reason: string | null;
  status?:          string;
}

export interface RiskDecisionRow {
  signal_id: number;
  ts_utc:    string;
  approved:  boolean;
  reason:    string;
}

export interface OrderRow {
  id?:              number;
  signal_id:        number;
  approval_id?:     number | null;
  mode:             "shadow" | "live" | "approval";
  ts_placed:        string;
  ticker:           string;
  station_id:       string;
  side:             "YES" | "NO";
  price_cents:      number;
  count:            number;
  status:           "open" | "filled" | "cancelled" | "expired";
  ts_filled?:       string | null;
  fill_price_cents?: number | null;
  ts_cancelled?:    string | null;
  book_state_json?: string | null;
  kalshi_order_id?: string | null;
}

export type PnlMode = "shadow" | "approval" | "live";
export interface SettlementRow {
  settlement_date:        string;
  station_id:             string;
  cli_high_f:             number | null;
  app_high_f:             number | null;
  kalshi_settled_bracket: string | null;
  match_flag:             boolean | null;
  ts_utc:                 string;
}

export interface ApprovalRow {
  id?:         number;
  signal_id:   number;
  ticker:      string;
  side:        string;
  proposed_ts: string;
  expires_ts:  string;
  card_json:   string | null;
  decision?:   string | null;
}

// ─── Reads for signal engine ──────────────────────────────────────────────────

/**
 * For each live station, joins the most recent snapshot rows to the most recent
 * book row (by ticker) to produce a combined input for the signal engine.
 *
 * Stations with no book rows (e.g. KDFW) are excluded automatically.
 */
export async function getLatestSignalInputs(): Promise<SnapshotSignalInput[]> {
  const result = await db.execute(sql`
    WITH latest_snap AS (
      SELECT station_id, MAX(ts_utc) AS max_ts
      FROM   snapshots
      WHERE  gap_flag IS NOT TRUE
      GROUP BY station_id
    ),
    snap AS (
      SELECT s.*
      FROM   snapshots s
      JOIN   latest_snap ls ON ls.station_id = s.station_id AND ls.max_ts = s.ts_utc
    ),
    latest_book AS (
      SELECT ticker, MAX(ts_utc) AS max_ts
      FROM   books
      GROUP BY ticker
    ),
    bk AS (
      SELECT b.*
      FROM   books b
      JOIN   latest_book lb ON lb.ticker = b.ticker AND lb.max_ts = b.ts_utc
    )
    SELECT
      snap.ts_utc,
      snap.station_id,
      bk.ticker,
      snap.settlement_date,
      snap.hours_to_settle,
      snap.running_high_f,
      snap.nbm_median_f,
      snap.bracket_lower_f,
      snap.bracket_upper_f,
      snap.bracket_label,
      snap.model_pct,
      snap.bid_cents,
      snap.ask_cents,
      snap.lock_status,
      snap.obs_age_s,
      snap.gap_flag,
      bk.coherent_flag
    FROM snap
    JOIN bk ON bk.station_id = snap.station_id
           AND ABS(bk.bracket_lo - COALESCE(snap.bracket_lower_f, -9999)) < 0.01
           -- Same-day markets only: ticker date token (e.g. 26JUL27) must match the
           -- snapshot's settlement_date, otherwise today's model probabilities get
           -- paired with tomorrow's tickers (same bracket temps, different event).
           AND TO_DATE(split_part(bk.ticker, '-', 2), 'YYMONDD') = snap.settlement_date::date
    ORDER BY snap.station_id, snap.bracket_lower_f NULLS FIRST
  `);

  return (result.rows ?? []) as unknown as SnapshotSignalInput[];
}

/** Latest snapshot input for a specific ticker (for proposal card rendering). */
export async function getLatestInputByTicker(ticker: string): Promise<SnapshotSignalInput | null> {
  const inputs = await getLatestSignalInputs();
  return inputs.find((i) => i.ticker === ticker) ?? null;
}

/** Most recent obs_age_s for a station (to check feed freshness). */
export async function getDataAge(stationId: string): Promise<number | null> {
  const { rows } = await db.execute(sql`
    SELECT obs_age_s FROM snapshots
    WHERE  station_id = ${stationId} AND gap_flag IS NOT TRUE
    ORDER  BY ts_utc DESC LIMIT 1
  `);
  const row = rows[0] as { obs_age_s: number | null } | undefined;
  return row?.obs_age_s ?? null;
}

// ─── Reads for risk officer ───────────────────────────────────────────────────

export interface RiskState {
  openOrdersPerStation:          Record<string, number>;
  dailyExposurePerStation:       Record<string, number>;
  totalOpenExposure:             number;
  /** Conservative daily-loss proxy: total cost of all non-cancelled orders today. */
  dailyCostToday:                number;
  /** Recent PROPOSALS and ORDERS (ticker+side) for the cooldown duplicate guard. */
  recentSignals:                 Array<{ ticker: string; side: string; ts: Date }>;
  killSwitchActive:              boolean;
}

export async function buildRiskState(
  date: string,
  mode: "shadow" | "live" | "approval",
  cooldownMin: number
): Promise<RiskState> {
  const [
    { rows: openRows },
    { rows: dailyRows },
    { rows: totalOpenRows },
    { rows: dailyCostRows },
    { rows: recentSigRows },
  ] = await Promise.all([
    db.execute(sql`
      SELECT station_id, COUNT(*) AS cnt
      FROM   orders WHERE status = 'open'
      GROUP BY station_id
    `),
    db.execute(sql`
      SELECT station_id, COALESCE(SUM(price_cents * count),0)::int AS total
      FROM   orders
      WHERE  ts_placed::date = ${date}::date
        AND  status != 'cancelled'
      GROUP BY station_id
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(price_cents * count),0)::int AS total
      FROM   orders WHERE status = 'open'
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(price_cents * count),0)::int AS total
      FROM   orders
      WHERE  ts_placed::date = ${date}::date
        AND  status != 'cancelled'
    `),
    db.execute(sql`
      -- Cooldown dedupe source: things we actually ACTED on (proposals + orders),
      -- NOT the signals evaluation log. The signals table records every live
      -- evaluation each tick, so sourcing the cooldown from it deadlocks
      -- proposals permanently: each tick's logged signal blocks the next tick.
      SELECT ticker, side, proposed_ts AS ts_utc FROM approvals
      WHERE  proposed_ts > NOW() - (${cooldownMin} || ' minutes')::interval
      UNION ALL
      SELECT ticker, side, ts_placed AS ts_utc FROM orders
      WHERE  ts_placed > NOW() - (${cooldownMin} || ' minutes')::interval
    `),
  ]);

  const openOrdersPerStation: Record<string, number> = {};
  for (const r of openRows) {
    openOrdersPerStation[r.station_id as string] = Number(r.cnt);
  }

  const dailyExposurePerStation: Record<string, number> = {};
  for (const r of dailyRows) {
    dailyExposurePerStation[r.station_id as string] = Number(r.total);
  }

  return {
    openOrdersPerStation,
    dailyExposurePerStation,
    totalOpenExposure:  Number((totalOpenRows[0] as { total: number } | undefined)?.total ?? 0),
    dailyCostToday:     Number((dailyCostRows[0] as { total: number } | undefined)?.total ?? 0),
    recentSignals:      recentSigRows.map((r) => ({
      ticker: r.ticker as string,
      side:   r.side as string,
      ts:     new Date(r.ts_utc as string),
    })),
    killSwitchActive: existsSync("/tmp/trader_kill.flag"),
  };
}

// ─── Reads for executor / order management ───────────────────────────────────

/** All open orders (any mode). */
export async function getOpenOrders(mode: "shadow" | "live" | "approval"): Promise<OrderRow[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.mode, mode), eq(orders.status, "open")));

  return rows.map((r) => ({
    id:               r.id,
    signal_id:        r.signalId,
    approval_id:      r.approvalId ?? null,
    mode:             r.mode as "shadow" | "live" | "approval",
    ts_placed:        r.tsPlaced.toISOString(),
    ticker:           r.ticker,
    station_id:       r.stationId,
    side:             r.side as "YES" | "NO",
    price_cents:      r.priceCents,
    count:            r.count,
    status:           r.status as "open",
    ts_filled:        r.tsFilled?.toISOString() ?? null,
    fill_price_cents: r.fillPriceCents ?? null,
    ts_cancelled:     r.tsCancelled?.toISOString() ?? null,
    book_state_json:  r.bookStateJson ?? null,
    kalshi_order_id:  r.kalshiOrderId ?? null,
  }));
}

// ─── Reads for approvals ──────────────────────────────────────────────────────

/** Check if an open proposal already exists for this ticker+side. */
export async function getPendingApprovalForTicker(
  ticker: string,
  side: string
): Promise<{ id: number } | null> {
  const { rows } = await db.execute(sql`
    SELECT id FROM approvals
    WHERE ticker = ${ticker}
      AND side   = ${side}
      AND decision IS NULL
      AND expires_ts > NOW()
    LIMIT 1
  `);
  return (rows[0] as { id: number } | undefined) ?? null;
}

/** Insert a new approval proposal row. Returns the new id. */
export async function insertApproval(row: {
  signal_id:   number;
  ticker:      string;
  side:        string;
  proposed_ts: string;
  expires_ts:  string;
  card_json:   string | null;
}): Promise<number> {
  const { rows } = await db.execute(sql`
    INSERT INTO approvals (signal_id, ticker, side, proposed_ts, expires_ts, card_json)
    VALUES (
      ${row.signal_id}, ${row.ticker}, ${row.side},
      ${row.proposed_ts}::timestamptz, ${row.expires_ts}::timestamptz,
      ${row.card_json}
    )
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

/** Mark signal status as pending_approval. */
export async function markSignalPendingApproval(signalId: number): Promise<void> {
  await db.execute(sql`
    UPDATE signals SET status = 'pending_approval' WHERE id = ${signalId}
  `);
}

/**
 * Sweep all proposals whose expires_ts has passed and decision is still NULL.
 * Marks them as decision='expired'. Returns count of newly expired rows.
 */
export async function sweepExpiredApprovals(): Promise<number> {
  const { rows } = await db.execute(sql`
    UPDATE approvals
    SET decision    = 'expired',
        decision_ts = NOW()
    WHERE decision IS NULL
      AND expires_ts <= NOW()
    RETURNING id
  `);
  return rows.length;
}

// ─── Reads for auditor ────────────────────────────────────────────────────────

/** Settlement dates that have snapshots but no settlement row yet. */
export async function getUnsettledDates(): Promise<
  Array<{ station_id: string; settlement_date: string }>
> {
  const { rows } = await db.execute(sql`
    SELECT DISTINCT s.station_id, s.settlement_date
    FROM   snapshots s
    LEFT JOIN settlements st
      ON  st.station_id = s.station_id
      AND st.settlement_date = s.settlement_date
    WHERE st.id IS NULL OR st.cli_high_f IS NULL
    ORDER BY s.settlement_date
  `);
  return rows as Array<{ station_id: string; settlement_date: string }>;
}

/** Outcome row for a station+date, or null if not yet written by the collector. */
export async function getOutcome(
  stationId: string,
  settlementDate: string
): Promise<{ final_high_f: number } | null> {
  const [row] = await db
    .select({ final_high_f: outcomes.finalHighF })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.stationId, stationId),
        eq(outcomes.settlementDate, settlementDate)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Max running_high_f from snapshots for a station+date (app's final high). */
export async function getAppHigh(
  stationId: string,
  settlementDate: string
): Promise<number | null> {
  const { rows } = await db.execute(sql`
    SELECT MAX(running_high_f)::real AS app_high
    FROM   snapshots
    WHERE  station_id = ${stationId}
      AND  settlement_date = ${settlementDate}
      AND  gap_flag IS NOT TRUE
  `);
  const row = rows[0] as { app_high: number | null } | undefined;
  return row?.app_high ?? null;
}

/** All brackets seen for a station on a settlement date (for resolving which settled YES). */
export async function getBooksForDate(
  stationId: string,
  settlementDate: string
): Promise<Array<{ ticker: string; bracket_lo: number | null; bracket_hi: number | null }>> {
  const { rows } = await db.execute(sql`
    SELECT DISTINCT bk.ticker, bk.bracket_lo, bk.bracket_hi
    FROM   books bk
    JOIN   snapshots sn ON sn.station_id = bk.station_id
                       AND sn.ts_utc = bk.ts_utc
    WHERE  bk.station_id = ${stationId}
      AND  sn.settlement_date = ${settlementDate}
  `);
  return rows as Array<{ ticker: string; bracket_lo: number | null; bracket_hi: number | null }>;
}

/**
 * Filled rain orders whose contract result has not yet been recorded.
 * Read-only bookkeeping for the handful of already-placed rain positions
 * from before rain trading was rolled back — closes out their P&L
 * correctly without re-enabling any rain signal generation.
 */
export async function getUnsettledRainOrders(): Promise<
  Array<{ station_id: string; ticker: string; settlement_date: string }>
> {
  const { rows } = await db.execute(sql`
    SELECT DISTINCT
      o.station_id,
      o.ticker,
      TO_CHAR(TO_DATE(split_part(o.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD') AS settlement_date
    FROM orders o
    LEFT JOIN settlements st
      ON st.station_id = o.station_id
     AND st.settlement_date = TO_CHAR(TO_DATE(split_part(o.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD')
    WHERE o.status = 'filled'
      AND o.station_id LIKE 'RAIN_%'
      AND st.id IS NULL
  `);
  return rows as Array<{ station_id: string; ticker: string; settlement_date: string }>;
}

/** Shadow fills data for daily P&L computation (auditor 21:00 job). */
export async function getFilledOrdersForDate(
  date: string,
  mode: PnlMode
): Promise<Array<{
  id: number;
  ticker: string;
  side: "YES" | "NO";
  price_cents: number;
  fill_price_cents: number | null;
  count: number;
  station_id: string;
}>> {
  const { rows } = await db.execute(sql`
    SELECT id, ticker, side, price_cents, fill_price_cents, count, station_id
    FROM   orders
    WHERE  ts_placed::date = ${date}::date
      AND  status = 'filled'
      AND  mode = ${mode}
  `);
  return rows as ReturnType<typeof getFilledOrdersForDate> extends Promise<infer T> ? T : never;
}

/**
 * Filled order date/mode pairs whose every order has a resolved settlement.
 *
 * This intentionally scans all historical dates rather than only "today".
 * The auditor can therefore backfill dates missed while the trader was asleep
 * or while the settlement feed was delayed.
 */
/**
 * Each order's own settlement date: ticker-derived for legacy KXRAIN- fills
 * (their contract can settle on a different local date than the UTC
 * placement date), placement date for everything else. Must match the
 * per-order keying `computeDailyPnl`/`rainTickerSettlementDate` use, or a
 * legacy rain fill's digest bucket would never see its own settlement land.
 */
const ORDER_SETTLEMENT_DATE_SQL = sql`
  CASE
    WHEN o.ticker LIKE 'KXRAIN-%'
      THEN TO_CHAR(TO_DATE(split_part(o.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD')
    ELSE o.ts_placed::date::text
  END
`;

export async function getReadyDailyPnlKeys(): Promise<
  Array<{ date: string; mode: PnlMode }>
> {
  const { rows } = await db.execute(sql`
    SELECT
      o.ts_placed::date::text AS date,
      o.mode,
      BOOL_AND(EXISTS (
        SELECT 1
        FROM settlements st
        WHERE st.station_id = o.station_id
          AND st.settlement_date = ${ORDER_SETTLEMENT_DATE_SQL}
          AND st.kalshi_settled_bracket IS NOT NULL
      )) AS ready
    FROM orders o
    WHERE o.status = 'filled'
    GROUP BY o.ts_placed::date, o.mode
    HAVING BOOL_AND(EXISTS (
      SELECT 1
      FROM settlements st
      WHERE st.station_id = o.station_id
        AND st.settlement_date = ${ORDER_SETTLEMENT_DATE_SQL}
        AND st.kalshi_settled_bracket IS NOT NULL
    ))
    ORDER BY date, mode
  `);
  return rows.map((row) => ({
    date: String(row.date),
    mode: row.mode as PnlMode,
  }));
}
export async function insertSignal(row: SignalRow): Promise<number> {
  const [inserted] = await db
    .insert(signals)
    .values({
      tsUtc:            new Date(row.ts_utc),
      stationId:        row.station_id,
      ticker:           row.ticker,
      side:             row.side,
      limitPrice:       row.limit_price,
      modelProb:        row.model_prob,
      impliedProb:      row.implied_prob,
      edgeNet:          row.edge_net,
      inputsHash:       row.inputs_hash,
      suppressedReason: row.suppressed_reason,
      status:           row.status ?? "live",
    })
    .returning({ id: signals.id });
  return inserted!.id;
}

export async function insertRiskDecision(row: RiskDecisionRow): Promise<void> {
  await db.insert(riskDecisions).values({
    signalId: row.signal_id,
    tsUtc:    new Date(row.ts_utc),
    approved: row.approved,
    reason:   row.reason,
  });
}

export async function insertOrder(row: OrderRow): Promise<number> {
  const [inserted] = await db
    .insert(orders)
    .values({
      signalId:       row.signal_id,
      approvalId:     row.approval_id ?? null,
      mode:           row.mode,
      tsPlaced:       new Date(row.ts_placed),
      ticker:         row.ticker,
      stationId:      row.station_id,
      side:           row.side,
      priceCents:     row.price_cents,
      count:          row.count,
      status:         row.status,
      bookStateJson:  row.book_state_json ?? null,
    })
    .returning({ id: orders.id });
  return inserted!.id;
}

export async function updateOrderStatus(
  id: number,
  update: {
    status: "filled" | "cancelled" | "expired";
    ts_filled?: string;
    fill_price_cents?: number;
    ts_cancelled?: string;
    book_state_json?: string;
  }
): Promise<void> {
  await db
    .update(orders)
    .set({
      status:          update.status,
      tsFilled:        update.ts_filled ? new Date(update.ts_filled) : undefined,
      fillPriceCents:  update.fill_price_cents ?? undefined,
      tsCancelled:     update.ts_cancelled ? new Date(update.ts_cancelled) : undefined,
      bookStateJson:   update.book_state_json ?? undefined,
    })
    .where(eq(orders.id, id));
}

export async function insertSettlement(row: SettlementRow): Promise<void> {
  await db
    .insert(settlements)
    .values({
      settlementDate:       row.settlement_date,
      stationId:            row.station_id,
      cliHighF:             row.cli_high_f ?? null,
      appHighF:             row.app_high_f ?? null,
      kalshiSettledBracket: row.kalshi_settled_bracket ?? null,
      matchFlag:            row.match_flag ?? null,
      tsUtc:                new Date(row.ts_utc),
    })
    .onConflictDoUpdate({
      target: [settlements.stationId, settlements.settlementDate],
      set: {
        cliHighF:             row.cli_high_f ?? null,
        appHighF:             row.app_high_f ?? null,
        kalshiSettledBracket: row.kalshi_settled_bracket ?? null,
        matchFlag:            row.match_flag ?? null,
        tsUtc:                new Date(row.ts_utc),
      },
    });
}

export async function upsertDailyPnl(
  date: string,
  mode: string,
  gross: number,
  fees: number,
  net: number,
  tradeCount: number
): Promise<void> {
  await db.execute(sql`
    INSERT INTO daily_pnl (date, mode, gross_cents, fees_cents, net_cents, trade_count, ts_utc)
    VALUES (${date}, ${mode}, ${gross}, ${fees}, ${net}, ${tradeCount}, NOW())
    ON CONFLICT (date, mode)
    DO UPDATE SET
      gross_cents = EXCLUDED.gross_cents,
      fees_cents  = EXCLUDED.fees_cents,
      net_cents   = EXCLUDED.net_cents,
      trade_count = EXCLUDED.trade_count,
      ts_utc      = EXCLUDED.ts_utc
  `);
}

/**
 * Ready date/mode pairs without a daily P&L row.
 *
 * This is deliberately separate from getReadyDailyPnlKeys so the auditor can
 * run the upserts first and then emit an alert only for gaps that remain.
 */
export async function getMissingDailyPnlKeys(): Promise<
  Array<{ date: string; mode: PnlMode }>
> {
  const { rows } = await db.execute(sql`
    SELECT ready.date, ready.mode
    FROM (
      SELECT
        o.ts_placed::date::text AS date,
        o.mode
      FROM orders o
      WHERE o.status = 'filled'
      GROUP BY o.ts_placed::date, o.mode
      HAVING BOOL_AND(EXISTS (
        SELECT 1
        FROM settlements st
        WHERE st.station_id = o.station_id
          AND st.settlement_date = ${ORDER_SETTLEMENT_DATE_SQL}
          AND st.kalshi_settled_bracket IS NOT NULL
      ))
    ) ready
    LEFT JOIN daily_pnl dp
      ON dp.date = ready.date
     AND dp.mode = ready.mode
    WHERE dp.id IS NULL
    ORDER BY ready.date, ready.mode
  `);
  return rows.map((row) => ({
    date: String(row.date),
    mode: row.mode as PnlMode,
  }));
}
