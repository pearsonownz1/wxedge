/**
 * Auditor — scheduled jobs.
 *
 * 07:30 station-local (≈ 12:30–15:30 UTC depending on station):
 *   Fetch CLI final high from NWS, write settlements row, reconcile vs. app
 *   running high.  Alert (log.error) on any mismatch.
 *
 * 21:00 UTC:
 *   Daily digest — filled orders, estimated P&L, write daily_pnl row.
 *   (LLM summary is out-of-scope for Phase A; the structured data is ready.)
 *
 * Weekly (Sunday 21:00 UTC):
 *   Gate stats report — shadow trade count, calibration curve summary,
 *   bootstrap P&L lower bound, data-quality metrics.
 *   (Full bootstrap is Phase B; Phase A writes the summary stats.)
 *
 * All jobs are idempotent: safe to call multiple times per day.
 */

import {
  getUnsettledDates,
  getOutcome,
  getAppHigh,
  getBooksForDate,
  getUnsettledRainOrders,
  insertSettlement,
  getFilledOrdersForDate,
  getReadyDailyPnlKeys,
  getMissingDailyPnlKeys,
  upsertDailyPnl,
  type PnlMode,
} from "./db.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { RiskConfig } from "./config.js";
import pino from "pino";

const logger = pino({ name: "auditor" });
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ─── Settlement job (07:30 station-local) ────────────────────────────────────

const STATION_LST_OFFSETS: Record<string, number> = {
  KNYC: -5,
  KMDW: -6,
  KAUS: -6,
  KDFW: -6,
  KLAX: -8,
  KPHL: -5,
};

/** UTC hour (0–23) at which the 07:30 settlement job should run for each station. */
function settlementJobUtcHour(stationId: string): number {
  const lstOffset = STATION_LST_OFFSETS[stationId] ?? -5;
  // 07:30 LST = 07:30 - lstOffset in UTC (lstOffset is negative so UTC = 07:30 + |offset|)
  return (7 - lstOffset + 24) % 24;
}

/**
 * Determine which bracket resolved YES given a final high temperature.
 * Returns the ticker of the resolved bracket, or null if none match.
 */
function resolvedBracket(
  finalHighF: number,
  brackets: Array<{ ticker: string; bracket_lo: number | null; bracket_hi: number | null }>
): string | null {
  for (const b of brackets) {
    const lo = b.bracket_lo ?? -Infinity;
    const hi = b.bracket_hi ?? Infinity;
    if (finalHighF >= lo && finalHighF <= hi) return b.ticker;
  }
  return null;
}

/**
 * Run the settlement audit for all stations with unclosed dates.
 * Called every tick; idempotent.
 */
export async function runSettlementAudit(now: Date): Promise<void> {
  const unsettled = await getUnsettledDates();
  if (unsettled.length === 0) return;

  const todayIso = now.toISOString().slice(0, 10);

  for (const { station_id, settlement_date } of unsettled) {
    // Don't try to settle today's date — it's still open
    if (settlement_date >= todayIso) continue;

    // Only run the settlement job after 07:30 station-local
    const utcHour = settlementJobUtcHour(station_id);
    if (now.getUTCHours() < utcHour) continue;

    try {
      const outcome  = await getOutcome(station_id, settlement_date);
      const appHigh  = await getAppHigh(station_id, settlement_date);
      const brackets = await getBooksForDate(station_id, settlement_date);

      const cliHighF = outcome?.final_high_f ?? null;
      const settled  = cliHighF !== null ? resolvedBracket(cliHighF, brackets) : null;

      // Do not create a placeholder settlement row before the official outcome
      // exists.  If an older run already created one, insertSettlement's
      // conflict update will replace it once the outcome appears.
      if (cliHighF === null) {
        continue;
      }

      // Match: does cli_high_f fall within the resolved bracket's bounds?
      let matchFlag: boolean | null = null;
      if (cliHighF !== null && appHigh !== null) {
        // Allow 2°F tolerance for rounding in app running-high vs CLI
        matchFlag = Math.abs(cliHighF - appHigh) <= 2;
      }

      if (matchFlag === false) {
        logger.error(
          {
            station_id,
            settlement_date,
            cliHighF,
            appHighF: appHigh,
            diff: cliHighF !== null && appHigh !== null
              ? Math.abs(cliHighF - appHigh)
              : null,
          },
          "⚠ SETTLEMENT MISMATCH — CLI high does not match app running high"
        );
      }

      await insertSettlement({
        settlement_date,
        station_id,
        cli_high_f:             cliHighF,
        app_high_f:             appHigh,
        kalshi_settled_bracket: settled,
        match_flag:             matchFlag,
        ts_utc:                 now.toISOString(),
      });

      if (cliHighF !== null) {
        logger.info(
          { station_id, settlement_date, cliHighF, appHighF: appHigh, matchFlag },
          "Settlement written"
        );
      }
    } catch (err) {
      logger.warn(
        { err, station_id, settlement_date },
        "Settlement audit failed — will retry next cycle"
      );
    }
  }
}

/** Fetch Kalshi's final binary outcome for a resolved rain contract. */
async function getRainResult(ticker: string): Promise<"yes" | "no" | null> {
  const response = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`, {
    headers: { Accept: "application/json", "User-Agent": "SellingHighs/1.0 (settlement-audit)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Rain settlement lookup failed: ${response.status}`);
  const payload = await response.json() as { market?: { result?: unknown } };
  const result = String(payload.market?.result ?? "").toLowerCase();
  return result === "yes" || result === "no" ? result : null;
}

/**
 * Records resolved KXRAIN contracts using Kalshi's final market result.
 * Rain trading itself has been rolled back (no new rain signals/orders are
 * generated), but a handful of already-placed rain fills predate the
 * rollback and still need their real-money outcome recorded so daily P&L
 * and audit history stay correct instead of sitting pending forever.
 * A NO outcome deliberately uses a non-ticker sentinel so the shared binary
 * YES/NO P&L calculation remains valid without a second settlement schema.
 */
export async function runRainSettlementAudit(now: Date): Promise<void> {
  const unsettled = await getUnsettledRainOrders();
  for (const order of unsettled) {
    try {
      const result = await getRainResult(order.ticker);
      if (!result) continue;

      await insertSettlement({
        settlement_date: order.settlement_date,
        station_id: order.station_id,
        cli_high_f: null,
        app_high_f: null,
        kalshi_settled_bracket: result === "yes" ? order.ticker : `${order.ticker}:NO`,
        match_flag: null,
        ts_utc: now.toISOString(),
      });
      logger.info(
        { ticker: order.ticker, station_id: order.station_id, settlement_date: order.settlement_date, result },
        "Rain settlement written"
      );
    } catch (err) {
      logger.warn({ err, ticker: order.ticker }, "Rain settlement audit failed — will retry next cycle");
    }
  }
}

// ─── Daily P&L digest (21:00 UTC) ────────────────────────────────────────────

/**
 * Given a KXRAIN ticker, returns its true local settlement date (YYYY-MM-DD)
 * as embedded in the ticker itself — e.g. "KXRAIN-26AUG26-NYC" -> "2026-08-26".
 * Returns null for non-rain tickers or an unparseable date segment. Rain
 * trading is rolled back (no new rain orders are placed), but this keeps the
 * handful of pre-rollback rain fills reconciling against their correct
 * settlement date instead of the UTC placement date, which can differ near
 * midnight.
 */
export function rainTickerSettlementDate(ticker: string): string | null {
  const match = /^KXRAIN-(\d{2})([A-Z]{3})(\d{2})-/.exec(ticker);
  if (!match) return null;
  const months: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const month = months[match[2]!];
  if (!month) return null;
  return `${2000 + Number(match[1])}-${String(month).padStart(2, "0")}-${match[3]}`;
}

export interface FilledOrderForPnl {
  ticker: string;
  side: "YES" | "NO";
  price_cents: number;
  fill_price_cents: number | null;
  count: number;
  station_id: string;
}

/**
 * Pure P&L computation for a digest run. Each order is settled against the
 * key `${station_id}::${its own true settlement date}` (ticker-derived for
 * rain, otherwise `fallbackDate` — the placement-date bucket this digest run
 * covers). This per-order-date keying is required because a rain station can
 * have a fill whose ticker-derived settlement date differs from the UTC
 * placement date near midnight; collapsing them onto placement date would
 * misattribute or permanently strand that fill as pending.
 *
 * An order whose key is absent from `settledByKey` has not settled yet —
 * it is excluded from this run's totals (not scored as a loss) and counted
 * in `pendingCount` so the caller can log it and this date can be safely
 * recomputed later once the settlement lands (recomputation is idempotent:
 * `upsertDailyPnl` fully overwrites the row for `(date, mode)`).
 */
export function computeDailyPnl(
  filled: FilledOrderForPnl[],
  settledByKey: Map<string, string | null>,
  fallbackDate: string,
  feeRate: number
): { grossCents: number; feesCents: number; netCents: number; tradeCount: number; pendingCount: number } {
  let grossCents = 0;
  let feesCents  = 0;
  let tradeCount = 0;
  let pendingCount = 0;

  for (const order of filled) {
    const settlementDate = rainTickerSettlementDate(order.ticker) ?? fallbackDate;
    const key = `${order.station_id}::${settlementDate}`;

    if (!settledByKey.has(key)) {
      pendingCount += 1;
      continue;
    }

    const settledBracket = settledByKey.get(key) ?? null;
    const fillCents      = order.fill_price_cents ?? order.price_cents;

    // YES buy: win if ticker === settled bracket
    // NO buy:  win if ticker !== settled bracket
    let payout = 0;
    if (settledBracket !== null) {
      if (order.side === "YES") {
        payout = settledBracket === order.ticker ? 100 : 0;
      } else {
        payout = settledBracket !== order.ticker ? 100 : 0;
      }
    }

    const gross = payout - fillCents;  // cents
    const fee   = Math.ceil(feeRate * (fillCents / 100) * (1 - fillCents / 100) * 100);
    grossCents += gross * order.count;
    feesCents  += fee * order.count;
    tradeCount += 1;
  }

  return { grossCents, feesCents, netCents: grossCents - feesCents, tradeCount, pendingCount };
}

/**
 * Compute and write the daily P&L row for a given placement date and mode.
 * Idempotent and safe to re-run for a past date: it always recomputes the
 * full row from current settlement data, so calling it again after a
 * previously-pending contract settles corrects that date's numbers
 * in place (see runDailyReconciliation).
 *
 * The whole row is deferred (not written) until every filled order for this
 * (date, mode) has a resolved settlement. A partial write would let the
 * dashboard's daily_pnl-gated aggregates disagree with its per-order
 * breakdowns for the trades still pending on this date.
 */
export async function runDailyDigest(
  date: string,
  mode: PnlMode,
  config: RiskConfig
): Promise<void> {
  const filled = await getFilledOrdersForDate(date, mode);
  if (filled.length === 0) {
    logger.info({ date, mode }, "Daily digest: no filled orders");
    return;
  }

  // Each order settles against its own true date: rain contracts settle on
  // their ticker-derived local contract date (which can differ from this
  // placement-date bucket near UTC midnight); everything else settles on
  // this digest's placement date. Collect the distinct dates we need.
  const neededDates = new Set<string>();
  for (const order of filled) {
    neededDates.add(rainTickerSettlementDate(order.ticker) ?? date);
  }

  const settledByKey = new Map<string, string | null>();
  for (const settlementDate of neededDates) {
    const { rows } = await db.execute(sql`
      SELECT station_id, kalshi_settled_bracket
      FROM   settlements
      WHERE  settlement_date = ${settlementDate}
    `);
    for (const r of rows) {
      settledByKey.set(
        `${r.station_id as string}::${settlementDate}`,
        r.kalshi_settled_bracket as string | null
      );
    }
  }

  const { grossCents, feesCents, netCents, tradeCount, pendingCount } =
    computeDailyPnl(filled, settledByKey, date, config.fee_rate);

  if (pendingCount > 0) {
    logger.info(
      { date, mode, pendingCount, settledCount: tradeCount },
      "Daily digest deferred — some filled orders are still awaiting settlement"
    );
    return;
  }

  await upsertDailyPnl(date, mode, grossCents, feesCents, netCents, tradeCount);

  logger.info(
    { date, mode, grossCents, feesCents, netCents, trades: tradeCount },
    "Daily P&L digest written"
  );

  if (netCents < 0) {
    logger.warn(
      { date, mode, netCents },
      "Negative daily P&L — review reliability curve before sizing up"
    );
  }
}

/**
 * Reconcile every ready date/mode on every trader tick.
 *
 * Settlement usually arrives the morning after the 21:00 digest, so a
 * once-per-day job is inherently too early.  Re-running these small upserts
 * on every tick also makes historical backfill automatic and idempotent.
 */
export async function runDailyReconciliation(config: RiskConfig): Promise<void> {
  const readyKeys = await getReadyDailyPnlKeys();
  for (const { date, mode } of readyKeys) {
    await runDailyDigest(date, mode, config);
  }

  const missingKeys = await getMissingDailyPnlKeys();
  if (missingKeys.length > 0) {
    logger.error(
      { missingPnl: missingKeys },
      "P&L ALERT — settled trading day has no daily P&L record"
    );
  }
}
/** Brief weekly summary of shadow-trade accumulation and calibration metrics. */
export async function runWeeklyGateReport(now: Date): Promise<void> {
  const { rows: statsRows } = await db.execute(sql`
    SELECT
      COUNT(DISTINCT o.id)::int                    AS shadow_fills,
      COUNT(DISTINCT CASE WHEN st.id IS NOT NULL THEN o.id END)::int AS settled_trades,
      ROUND(AVG(s.edge_net)::numeric, 3)            AS avg_edge_net,
      ROUND(AVG(
        CASE WHEN s.side = 'YES'
          THEN (
            CASE WHEN st.kalshi_settled_bracket = o.ticker THEN 1.0 ELSE 0.0 END
            - o.price_cents::real / 100.0
          )
          ELSE (
            CASE WHEN st.kalshi_settled_bracket != o.ticker THEN 1.0 ELSE 0.0 END
            - (100 - o.price_cents)::real / 100.0
          )
        END
      )::numeric, 3)                               AS avg_realized_edge
    FROM orders o
    JOIN signals s ON s.id = o.signal_id
    LEFT JOIN settlements st
      ON  st.station_id = o.station_id
      AND st.settlement_date = CASE
        WHEN o.ticker LIKE 'KXRAIN-%'
          THEN TO_CHAR(TO_DATE(split_part(o.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD')
        ELSE (o.ts_placed::date)::text
      END
    WHERE o.mode = 'shadow' AND o.status = 'filled'
  `);

  const stats = statsRows[0] as {
    shadow_fills: number;
    settled_trades: number;
    avg_edge_net: number;
    avg_realized_edge: number;
  } | undefined;

  logger.info(
    {
      ...stats,
      go_live_gate_200_shadow_trades: (stats?.settled_trades ?? 0) >= 200,
      ts: now.toISOString(),
    },
    "Weekly gate report"
  );

  if ((stats?.settled_trades ?? 0) >= 200) {
    logger.info(
      "✓ Shadow trade count gate passed (≥200). Run full can_go_live() check before enabling live mode."
    );
  } else {
    logger.info(
      { need: 200 - (stats?.settled_trades ?? 0) },
      "Shadow accumulation in progress"
    );
  }
}
