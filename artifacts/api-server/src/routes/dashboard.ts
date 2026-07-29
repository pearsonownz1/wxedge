/**
 * Dashboard route — trading performance summary for the WX Edge dashboard.
 *
 * GET /dashboard
 *   summary        — overall P&L, win/loss counts, today's spend vs cap
 *   pnl_by_day     — daily P&L + cost for charting
 *   by_station     — per-station win/loss/P&L leaderboard
 *   recent_feed    — last 30 decisions with settlement outcomes
 */

import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const router = Router();

function loadDailyCap(): number {
  const paths = [
    resolve(process.cwd(), "artifacts/trader/config/risk.json"),
    resolve(process.cwd(), "../trader/config/risk.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8")) as { max_daily_loss_cents?: number; llm_daily_cap_cents?: number };
      return cfg.llm_daily_cap_cents ?? cfg.max_daily_loss_cents ?? 300;
    }
  }
  return 300;
}

// Reusable P&L CASE fragment — YES wins when settled bracket = ticker; NO wins when it doesn't.
// Uses COALESCE(fill_price_cents, price_cents) because fill_price_cents isn't always populated.
const PNL_CASE = sql`
  CASE
    WHEN st.kalshi_settled_bracket IS NULL THEN 0
    WHEN o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker
      THEN 100 - COALESCE(o.fill_price_cents, o.price_cents)
    WHEN o.side = 'YES'
      THEN -COALESCE(o.fill_price_cents, o.price_cents)
    WHEN o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker
      THEN 100 - COALESCE(o.fill_price_cents, o.price_cents)
    ELSE -COALESCE(o.fill_price_cents, o.price_cents)
  END
`;

router.get("/dashboard", async (_req: Request, res: Response) => {
  try {
    const dailyCap = loadDailyCap();

    const [summaryRes, byDayRes, byStationRes, todayCostRes, feedRes] = await Promise.all([

      // ── Overall summary ────────────────────────────────────────────────────
      db.execute(sql`
        SELECT
          COALESCE(SUM(${PNL_CASE}), 0)::int AS pnl_cents,
          COUNT(o.id)::int AS total_placed,
          COUNT(*) FILTER (WHERE st.settlement_date IS NOT NULL)::int AS settled_count,
          COUNT(*) FILTER (WHERE st.settlement_date IS NULL)::int AS pending_count,
          COUNT(*) FILTER (WHERE
            (o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker) OR
            (o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker)
          )::int AS win_count,
          COUNT(*) FILTER (WHERE
            st.settlement_date IS NOT NULL AND NOT (
              (o.side = 'YES' AND st.kalshi_settled_bracket = o.ticker) OR
              (o.side = 'NO' AND st.kalshi_settled_bracket != o.ticker)
            )
          )::int AS loss_count
        FROM orders o
        JOIN approvals a ON a.id = o.approval_id AND a.recheck_ok = true
        LEFT JOIN settlements st
          ON st.station_id = o.station_id
         AND st.settlement_date = o.ts_placed::date::text
        WHERE o.status = 'filled'
      `),

      // ── P&L by calendar day ────────────────────────────────────────────────
      db.execute(sql`
        SELECT
          o.ts_placed::date AS trade_date,
          COUNT(o.id)::int AS trade_count,
          COALESCE(SUM(${PNL_CASE}), 0)::int AS pnl_cents,
          COALESCE(SUM(COALESCE(o.fill_price_cents, o.price_cents)), 0)::int AS cost_cents
        FROM orders o
        JOIN approvals a ON a.id = o.approval_id AND a.recheck_ok = true
        LEFT JOIN settlements st
          ON st.station_id = o.station_id
         AND st.settlement_date = o.ts_placed::date::text
        WHERE o.status = 'filled'
        GROUP BY o.ts_placed::date
        ORDER BY trade_date ASC
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
          COALESCE(SUM(${PNL_CASE}), 0)::int AS pnl_cents
        FROM orders o
        JOIN approvals a ON a.id = o.approval_id AND a.recheck_ok = true
        LEFT JOIN settlements st
          ON st.station_id = o.station_id
         AND st.settlement_date = o.ts_placed::date::text
        WHERE o.status = 'filled'
        GROUP BY o.station_id
        ORDER BY pnl_cents DESC
      `),

      // ── Today's total spend ────────────────────────────────────────────────
      db.execute(sql`
        SELECT COALESCE(SUM(price_cents), 0)::int AS cost_today_cents
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
                 AND st.kalshi_settled_bracket IS NOT NULL
            THEN CASE
              WHEN a.side = 'YES' AND st.kalshi_settled_bracket = a.ticker
                THEN 100 - COALESCE(o.fill_price_cents, o.price_cents)
              WHEN a.side = 'YES'
                THEN -COALESCE(o.fill_price_cents, o.price_cents)
              WHEN a.side = 'NO' AND st.kalshi_settled_bracket != a.ticker
                THEN 100 - COALESCE(o.fill_price_cents, o.price_cents)
              ELSE -COALESCE(o.fill_price_cents, o.price_cents)
            END
            ELSE NULL
          END AS pnl_cents
        FROM approvals a
        JOIN signals s ON s.id = a.signal_id
        LEFT JOIN orders o ON o.approval_id = a.id AND o.status = 'filled'
        LEFT JOIN settlements st
          ON st.station_id = s.station_id
         AND st.settlement_date = a.proposed_ts::date::text
        WHERE a.decision IS NOT NULL
        ORDER BY a.proposed_ts DESC
        LIMIT 30
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
        };
      }),
    });
  } catch (err) {
    logger.error({ err }, "GET /dashboard failed");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
