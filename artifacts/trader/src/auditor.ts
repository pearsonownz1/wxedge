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
  insertSettlement,
  getFilledOrdersForDate,
  upsertDailyPnl,
} from "./db.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { RiskConfig } from "./config.js";
import pino from "pino";

const logger = pino({ name: "auditor" });

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

// ─── Daily P&L digest (21:00 UTC) ────────────────────────────────────────────

/** Compute and write the daily P&L row for a given date and mode. */
export async function runDailyDigest(
  date: string,
  mode: "shadow" | "live",
  config: RiskConfig
): Promise<void> {
  const filled = await getFilledOrdersForDate(date, mode);
  if (filled.length === 0) {
    logger.info({ date, mode }, "Daily digest: no filled orders");
    return;
  }

  // For P&L, we need to know if the bracket resolved YES.
  // Join against settlements table.
  const { rows: settlementRows } = await db.execute(sql`
    SELECT station_id, kalshi_settled_bracket
    FROM   settlements
    WHERE  settlement_date = ${date}
  `);

  const settledByStation = new Map<string, string | null>();
  for (const r of settlementRows) {
    settledByStation.set(
      r.station_id as string,
      r.kalshi_settled_bracket as string | null
    );
  }

  let grossCents = 0;
  let feesCents  = 0;

  for (const order of filled) {
    const settledBracket = settledByStation.get(order.station_id) ?? null;
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

    const gross       = payout - fillCents;  // cents
    const fee         = Math.ceil(config.fee_rate * (fillCents / 100) * (1 - fillCents / 100) * 100);
    grossCents       += gross;
    feesCents        += fee;
  }

  const netCents = grossCents - feesCents;

  await upsertDailyPnl(date, mode, grossCents, feesCents, netCents, filled.length);

  logger.info(
    { date, mode, grossCents, feesCents, netCents, trades: filled.length },
    "Daily P&L digest written"
  );

  if (netCents < 0) {
    logger.warn(
      { date, mode, netCents },
      "Negative daily P&L — review reliability curve before sizing up"
    );
  }
}

// ─── Weekly gate stats ────────────────────────────────────────────────────────

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
      AND st.settlement_date = (o.ts_placed::date)::text
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
