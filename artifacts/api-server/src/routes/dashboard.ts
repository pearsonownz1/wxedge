/**
 * Dashboard route — trading performance summary for the WX Edge dashboard.
 *
 * GET /dashboard
 *   summary        — overall P&L, win/loss counts, today's spend vs cap
 *   pnl_by_day     — daily P&L + cost for charting
 *   by_station     — per-station win/loss/P&L leaderboard
 *   recent_feed    — last 30 decisions with settlement outcomes
 *   pnl_alerts     — settled date/mode pairs missing a daily_pnl record
 */

import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const router = Router();

function loadRiskSettings(): { dailyCap: number; feeRate: number } {
  const paths = [
    resolve(process.cwd(), "artifacts/trader/config/risk.json"),
    resolve(process.cwd(), "../trader/config/risk.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8")) as {
        max_daily_loss_cents?: number;
        llm_daily_cap_cents?: number;
        fee_rate?: number;
      };
      return {
        dailyCap: cfg.llm_daily_cap_cents ?? cfg.max_daily_loss_cents ?? 300,
        feeRate: cfg.fee_rate ?? 0.07,
      };
    }
  }
  return { dailyCap: 300, feeRate: 0.07 };
}

// Rain contracts settle on their own local contract date (embedded in the
// ticker), which can differ from the UTC placement date near midnight.
// Both fragments below derive the join date from the ticker for rain orders
// instead of assuming placement date == settlement date, while leaving the
// placement-date join unchanged for every other market type.
const ORDER_SETTLEMENT_DATE = sql`
  CASE
    WHEN o.ticker LIKE 'KXRAIN-%'
      THEN TO_CHAR(TO_DATE(split_part(o.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD')
    ELSE o.ts_placed::date::text
  END
`;

const APPROVAL_SETTLEMENT_DATE = sql`
  CASE
    WHEN a.ticker LIKE 'KXRAIN-%'
      THEN TO_CHAR(TO_DATE(split_part(a.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD')
    ELSE a.proposed_ts::date::text
  END
`;

const MARKET_TYPE_CASE = sql`
  CASE
    WHEN a.ticker LIKE 'KXRAIN-%' THEN 'rain'
    WHEN a.ticker LIKE 'KXMLBKS%' THEN 'sports'
    ELSE 'weather'
  END
`;

/**
 * Net P&L for an order, in cents. Mirrors the trader auditor: settlement
 * payout less the conservative, whole-cent Kalshi taker fee for every contract.
 */
function netPnlCase(feeRate: number) {
  const fillPrice = sql`COALESCE(o.fill_price_cents, o.price_cents)`;
  const feeCents = sql`
    CEIL(
      ${feeRate}
      * (${fillPrice} / 100.0)
      * (1 - ${fillPrice} / 100.0)
      * o.count
      * 100
    )::int
  `;
  return sql`
    CASE
      WHEN st.kalshi_settled_bracket IS NULL THEN 0
      WHEN o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker
        THEN (100 - ${fillPrice}) * o.count - ${feeCents}
      WHEN o.side = 'YES'
        THEN -${fillPrice} * o.count - ${feeCents}
      WHEN o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker
        THEN (100 - ${fillPrice}) * o.count - ${feeCents}
      ELSE -${fillPrice} * o.count - ${feeCents}
    END
  `;
}

router.get("/dashboard", async (_req: Request, res: Response) => {
  try {
    const { dailyCap, feeRate } = loadRiskSettings();
    const pnlCase = netPnlCase(feeRate);

    const [summaryRes, byDayRes, byStationRes, todayCostRes, feedRes, pnlAlertRes] = await Promise.all([

      // ── Overall summary ────────────────────────────────────────────────────
      // pnl_cents is sourced from daily_pnl (the reconciled source of truth);
      // settled/pending/win/loss are gated on the same (date, mode) daily_pnl
      // row existing so a partially-settled day can't count as settled here
      // while its total is still excluded from the daily_pnl sum above.
      db.execute(sql`
        SELECT
          COALESCE((SELECT SUM(net_cents) FROM daily_pnl), 0)::int AS pnl_cents,
          COUNT(o.id)::int AS total_placed,
          COUNT(*) FILTER (WHERE dp.id IS NOT NULL)::int AS settled_count,
          COUNT(*) FILTER (WHERE dp.id IS NULL)::int AS pending_count,
          COUNT(*) FILTER (WHERE
            dp.id IS NOT NULL AND (
              (o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker) OR
              (o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker)
            )
          )::int AS win_count,
          COUNT(*) FILTER (WHERE
            dp.id IS NOT NULL AND NOT (
              (o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker) OR
              (o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker)
            )
          )::int AS loss_count
        FROM orders o
        JOIN approvals a ON a.id = o.approval_id AND a.recheck_ok = true
        LEFT JOIN settlements st
          ON st.station_id = o.station_id
         AND st.settlement_date = ${ORDER_SETTLEMENT_DATE}
        LEFT JOIN daily_pnl dp
          ON dp.date = o.ts_placed::date::text
         AND dp.mode = o.mode
        WHERE o.status = 'filled'
      `),

      // ── P&L by calendar day ────────────────────────────────────────────────
      // Net P&L per day comes straight from daily_pnl; cost is recomputed from
      // orders (fee-exclusive) for the same (date, mode) rows so bars only
      // ever show fully-reconciled days.
      db.execute(sql`
        SELECT
          pnl.date AS trade_date,
          pnl.trade_count,
          pnl.pnl_cents,
          COALESCE(cost.cost_cents, 0)::int AS cost_cents
        FROM (
          SELECT
            date,
            SUM(trade_count)::int AS trade_count,
            SUM(net_cents)::int AS pnl_cents
          FROM daily_pnl
          GROUP BY date
        ) pnl
        LEFT JOIN (
          SELECT
            o.ts_placed::date::text AS date,
            SUM(COALESCE(o.fill_price_cents, o.price_cents) * o.count)::int AS cost_cents
          FROM orders o
          JOIN approvals a ON a.id = o.approval_id AND a.recheck_ok = true
          JOIN daily_pnl dp
            ON dp.date = o.ts_placed::date::text
           AND dp.mode = o.mode
          WHERE o.status = 'filled'
          GROUP BY o.ts_placed::date
        ) cost ON cost.date = pnl.date
        ORDER BY pnl.date ASC
      `),

      // ── Per-station leaderboard ────────────────────────────────────────────
      db.execute(sql`
        SELECT
          o.station_id,
          COUNT(o.id)::int AS total_placed,
          COUNT(*) FILTER (WHERE st.settlement_date IS NOT NULL)::int AS settled,
          COUNT(*) FILTER (WHERE
            (o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker) OR
            (o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker)
          )::int AS win_count,
          COUNT(*) FILTER (WHERE
            st.settlement_date IS NOT NULL AND NOT (
              (o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker) OR
              (o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker)
            )
          )::int AS loss_count,
          COALESCE(SUM(${pnlCase}), 0)::int AS pnl_cents
        FROM orders o
        JOIN approvals a ON a.id = o.approval_id AND a.recheck_ok = true
        JOIN daily_pnl dp
          ON dp.date = o.ts_placed::date::text
         AND dp.mode = o.mode
        LEFT JOIN settlements st
          ON st.station_id = o.station_id
         AND st.settlement_date = ${ORDER_SETTLEMENT_DATE}
        WHERE o.status = 'filled'
        GROUP BY o.station_id
        ORDER BY pnl_cents DESC
      `),

      // ── Today's total spend ────────────────────────────────────────────────
      db.execute(sql`
        SELECT COALESCE(SUM(price_cents * count), 0)::int AS cost_today_cents
        FROM orders
        WHERE ts_placed::date = CURRENT_DATE
          AND status != 'cancelled'
      `),

      // ── Recent feed — last 30 decided approvals with settlement outcome ────
      db.execute(sql`
        SELECT
          a.id,
          a.ticker,
          a.side,
          s.station_id,
          a.proposed_ts,
          a.decision,
          a.decision_ts,
          a.decider,
          a.llm_confidence,
          a.recheck_ok,
          s.limit_price AS limit_price_cents,
          ${MARKET_TYPE_CASE} AS market_type,
          CASE
            WHEN a.ticker LIKE 'KXRAIN-%'
              THEN TO_CHAR(TO_DATE(split_part(a.ticker, '-', 2), 'YYMONDD'), 'YYYY-MM-DD')
            ELSE NULL
          END AS contract_date,
          CASE
            WHEN a.decision != 'approved' OR a.recheck_ok IS NOT TRUE THEN NULL
            WHEN st.kalshi_settled_bracket IS NULL              THEN 'pending'
            WHEN a.side = 'YES' AND st.kalshi_settled_bracket = a.ticker  THEN 'won'
            WHEN a.side = 'YES'                                 THEN 'lost'
            WHEN a.side = 'NO'  AND st.kalshi_settled_bracket != a.ticker THEN 'won'
            ELSE 'lost'
          END AS settlement_outcome,
          CASE
            WHEN a.decision = 'approved' AND a.recheck_ok IS NOT DISTINCT FROM true
                 AND o.id IS NOT NULL
                 AND st.kalshi_settled_bracket IS NOT NULL
            THEN ${pnlCase}
            ELSE NULL
          END AS pnl_cents
        FROM approvals a
        JOIN signals s ON s.id = a.signal_id
        LEFT JOIN orders o ON o.approval_id = a.id AND o.status = 'filled'
        LEFT JOIN settlements st
          ON st.station_id = s.station_id
         AND st.settlement_date = ${APPROVAL_SETTLEMENT_DATE}
        WHERE a.decision IS NOT NULL
        ORDER BY a.proposed_ts DESC
        LIMIT 30
      `),

      // ── Reconciliation coverage alert ──────────────────────────────────────
      // A date/mode is "ready" once every filled order in it has a resolved
      // settlement; if it still has no daily_pnl row the trader's backfill
      // hasn't caught up (or is failing), so surface it explicitly.
      db.execute(sql`
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
              AND st.settlement_date = o.ts_placed::date::text
              AND st.kalshi_settled_bracket IS NOT NULL
          ))
        ) ready
        LEFT JOIN daily_pnl dp
          ON dp.date = ready.date
         AND dp.mode = ready.mode
        WHERE dp.id IS NULL
        ORDER BY ready.date, ready.mode
      `),
    ]);

    const s = (summaryRes.rows[0] ?? {}) as Record<string, unknown>;
    const winCount  = Number(s["win_count"]  ?? 0);
    const lossCount = Number(s["loss_count"] ?? 0);
    const todayCost = Number(
      ((todayCostRes.rows[0] ?? {}) as Record<string, unknown>)["cost_today_cents"] ?? 0
    );

    res.json({
      summary: {
        pnl_cents:        Number(s["pnl_cents"]     ?? 0),
        total_placed:     Number(s["total_placed"]   ?? 0),
        settled_count:    Number(s["settled_count"]  ?? 0),
        pending_count:    Number(s["pending_count"]  ?? 0),
        win_count:        winCount,
        loss_count:       lossCount,
        win_rate_pct:     (winCount + lossCount) > 0
          ? Math.round(winCount / (winCount + lossCount) * 100)
          : null,
        cost_today_cents: todayCost,
        daily_cap_cents:  dailyCap,
      },
      pnl_by_day: byDayRes.rows.map(r => {
        const row = r as Record<string, unknown>;
        return {
          date:        String(row["trade_date"] ?? "").slice(0, 10),
          pnl_cents:   Number(row["pnl_cents"]   ?? 0),
          cost_cents:  Number(row["cost_cents"]   ?? 0),
          trade_count: Number(row["trade_count"]  ?? 0),
        };
      }),
      pnl_alerts: pnlAlertRes.rows.map(r => {
        const row = r as Record<string, unknown>;
        return {
          date: String(row["date"] ?? "").slice(0, 10),
          mode: String(row["mode"] ?? ""),
          message: "Settled trading day is missing its daily P&L record",
        };
      }),
      by_station: byStationRes.rows.map(r => {
        const row = r as Record<string, unknown>;
        return {
          station_id:   String(row["station_id"]),
          total_placed: Number(row["total_placed"] ?? 0),
          settled:      Number(row["settled"]       ?? 0),
          win_count:    Number(row["win_count"]     ?? 0),
          loss_count:   Number(row["loss_count"]    ?? 0),
          pnl_cents:    Number(row["pnl_cents"]     ?? 0),
        };
      }),
      recent_feed: feedRes.rows.map(r => {
        const row = r as Record<string, unknown>;
        return {
          id:                 Number(row["id"]),
          ticker:             String(row["ticker"]),
          side:               String(row["side"]),
          station_id:         String(row["station_id"]),
          proposed_ts:        String(row["proposed_ts"]),
          decision:           row["decision"]   ? String(row["decision"])   : null,
          decision_ts:        row["decision_ts"] ? String(row["decision_ts"]) : null,
          decider:            row["decider"]    ? String(row["decider"])    : null,
          llm_confidence:     row["llm_confidence"] !== null ? Number(row["llm_confidence"]) : null,
          recheck_ok:         row["recheck_ok"] as boolean | null,
          settlement_outcome: row["settlement_outcome"] ? String(row["settlement_outcome"]) : null,
          pnl_cents:          row["pnl_cents"] !== null && row["pnl_cents"] !== undefined
            ? Number(row["pnl_cents"])
            : null,
          limit_price_cents:  Number(row["limit_price_cents"] ?? 0),
          market_type:        String(row["market_type"] ?? "weather"),
          contract_date:      row["contract_date"] ? String(row["contract_date"]) : null,
        };
      }),
    });
  } catch (err) {
    logger.error({ err }, "GET /dashboard failed");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
