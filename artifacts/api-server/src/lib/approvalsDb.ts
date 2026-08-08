/**
 * Database layer for the approvals system — API server side.
 *
 * The trader writes approval rows; the API server reads them and writes
 * decisions + orders when the human taps Approve/Deny.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  id:               number;
  signal_id:        number;
  ticker:           string;
  side:             string;
  station_id:       string;
  proposed_ts:      string;
  expires_ts:       string;
  card_json:        string | null;
  decision:         string | null;
  decision_ts:      string | null;
  latency_ms:       number | null;
  recheck_ok:       boolean | null;
  recheck_note:     string | null;
  limit_price_cents: number;
  /** Who made the decision: 'human' | 'llm'. null until decided. */
  decider:          string | null;
  /** 2-4 sentence rationale from the LLM (null for human decisions). */
  llm_rationale:    string | null;
  /** LLM confidence 0-1 (null for human decisions). */
  llm_confidence:   number | null;
  /** Settlement outcome for approved+placed trades: 'won' | 'lost' | 'pending' | null */
  settlement_outcome: string | null;
  /** Net P&L in cents once settled; null if not settled or not an actual placed trade. */
  pnl_cents:        number | null;
}

export interface CurrentMarketState {
  ticker:       string;
  ask_cents:    number | null;
  bid_cents:    number | null;
  model_pct:    number;
  obs_age_s:    number | null;
  lock_status:  string;
  book_age_min: number;
}

export interface ApprovalRiskState {
  openOrdersPerStation:    Record<string, number>;
  dailyExposurePerStation: Record<string, number>;
  totalOpenExposure:       number;
  dailyCostToday:          number;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

// Common SELECT fragment shared across all approval queries
const APPROVAL_SELECT = sql`
  a.id, a.signal_id, a.ticker, a.side,
  s.station_id,
  a.proposed_ts, a.expires_ts, a.card_json,
  a.decision, a.decision_ts, a.latency_ms, a.recheck_ok, a.recheck_note,
  s.limit_price AS limit_price_cents,
  a.decider, a.llm_rationale, a.llm_confidence
`;

// Settlement outcome + P&L fragment — requires LEFT JOINs on orders o and settlements st
const SETTLEMENT_SELECT = sql`
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
`;

/** Pending (undecided, not yet expired) proposals, newest first. */
export async function getPendingApprovals(): Promise<ApprovalRecord[]> {
  const { rows } = await db.execute(sql`
    SELECT ${APPROVAL_SELECT}
    FROM approvals a
    JOIN signals s ON s.id = a.signal_id
    WHERE a.decision IS NULL
      AND a.expires_ts > NOW()
    ORDER BY a.proposed_ts DESC
  `);
  return rows as ApprovalRecord[];
}

/** Last N decided proposals (approved, denied, expired), newest first. Includes settlement outcome. */
export async function getApprovalHistory(limit = 50): Promise<ApprovalRecord[]> {
  const { rows } = await db.execute(sql`
    SELECT ${APPROVAL_SELECT}, ${SETTLEMENT_SELECT}
    FROM approvals a
    JOIN signals s ON s.id = a.signal_id
    LEFT JOIN orders o ON o.approval_id = a.id AND o.status = 'filled'
    LEFT JOIN settlements st
      ON st.station_id = s.station_id
     AND st.settlement_date = a.proposed_ts::date::text
    WHERE a.decision IS NOT NULL
    ORDER BY a.proposed_ts DESC
    LIMIT ${limit}
  `);
  return rows as ApprovalRecord[];
}

/** Single approval row by id, including derived fields. */
export async function getApprovalById(id: number): Promise<ApprovalRecord | null> {
  const { rows } = await db.execute(sql`
    SELECT ${APPROVAL_SELECT}
    FROM approvals a
    JOIN signals s ON s.id = a.signal_id
    WHERE a.id = ${id}
  `);
  return (rows[0] as ApprovalRecord | undefined) ?? null;
}

/**
 * Latest snapshot data for a ticker — used for approve-time revalidation.
 * Joins books → snapshots via station_id + bracket_lo ≈ bracket_lower_f
 * (the same join used by the signal engine). Returns null if no recent data.
 */
export async function getCurrentMarketState(ticker: string): Promise<CurrentMarketState | null> {
  const { rows } = await db.execute(sql`
    WITH latest_book AS (
      SELECT b.ticker, b.station_id, b.yes_ask, b.yes_bid,
             b.bracket_lo,
             EXTRACT(EPOCH FROM (NOW() - b.ts_utc)) / 60.0 AS book_age_min
      FROM books b
      WHERE b.ticker = ${ticker}
      ORDER BY b.ts_utc DESC
      LIMIT 1
    ),
    latest_snap AS (
      SELECT sn.station_id, sn.model_pct, sn.obs_age_s, sn.lock_status,
             sn.bracket_lower_f
      FROM snapshots sn
      JOIN latest_book lb
        ON lb.station_id = sn.station_id
       AND ABS(lb.bracket_lo - COALESCE(sn.bracket_lower_f, -9999)) < 0.01
      WHERE sn.gap_flag IS NOT TRUE
      ORDER BY sn.ts_utc DESC
      LIMIT 1
    )
    SELECT
      lb.ticker,
      lb.yes_ask     AS ask_cents,
      lb.yes_bid     AS bid_cents,
      ls.model_pct,
      ls.obs_age_s,
      ls.lock_status,
      lb.book_age_min
    FROM latest_book lb
    LEFT JOIN latest_snap ls ON true
  `);

  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    ticker:       r["ticker"] as string,
    ask_cents:    r["ask_cents"] !== null ? Number(r["ask_cents"]) : null,
    bid_cents:    r["bid_cents"] !== null ? Number(r["bid_cents"]) : null,
    model_pct:    r["model_pct"] !== null ? Number(r["model_pct"]) : 0,
    obs_age_s:    r["obs_age_s"] !== null ? Number(r["obs_age_s"]) : null,
    lock_status:  (r["lock_status"] as string | null) ?? "live",
    book_age_min: Number(r["book_age_min"] ?? 999),
  };
}

/** Lightweight risk state for approve-time re-check (approval mode only). */
export async function buildApprovalRiskState(
  date: string,
  config: { cooldown_min: number }
): Promise<ApprovalRiskState> {
  const [{ rows: openRows }, { rows: dailyRows }, { rows: totalRows }, { rows: costRows }] =
    await Promise.all([
      db.execute(sql`
        SELECT station_id, COUNT(*) AS cnt
        FROM orders WHERE status = 'open'
        GROUP BY station_id
      `),
      db.execute(sql`
        SELECT station_id, COALESCE(SUM(price_cents), 0)::int AS total
        FROM orders
        WHERE ts_placed::date = ${date}::date AND status != 'cancelled'
        GROUP BY station_id
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(price_cents), 0)::int AS total
        FROM orders WHERE status = 'open'
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(price_cents), 0)::int AS total
        FROM orders
        WHERE ts_placed::date = ${date}::date AND status != 'cancelled'
      `),
    ]);

  const openOrdersPerStation: Record<string, number> = {};
  for (const r of openRows) {
    openOrdersPerStation[r["station_id"] as string] = Number(r["cnt"]);
  }
  const dailyExposurePerStation: Record<string, number> = {};
  for (const r of dailyRows) {
    dailyExposurePerStation[r["station_id"] as string] = Number(r["total"]);
  }

  return {
    openOrdersPerStation,
    dailyExposurePerStation,
    totalOpenExposure: Number((totalRows[0] as { total: number } | undefined)?.total ?? 0),
    dailyCostToday:    Number((costRows[0] as { total: number } | undefined)?.total ?? 0),
  };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * CAS decision update: only succeeds if decision IS NULL.
 * Returns true if the update landed, false if someone else got there first.
 */
export async function decideApproval(
  id: number,
  decision: "approved" | "denied" | "expired",
  latencyMs: number | null,
  recheckOk: boolean | null,
  recheckNote: string | null,
  decider: "human" | "llm" = "human"
): Promise<boolean> {
  const { rows } = await db.execute(sql`
    UPDATE approvals
    SET
      decision     = ${decision},
      decision_ts  = NOW(),
      latency_ms   = ${latencyMs},
      recheck_ok   = ${recheckOk},
      recheck_note = ${recheckNote},
      decider      = ${decider}
    WHERE id = ${id}
      AND decision IS NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/** Insert an order placed via human/LLM approval. Returns the order id. */
export async function insertApprovalOrder(row: {
  signal_id:      number;
  approval_id:    number;
  mode:           string;
  ticker:         string;
  station_id:     string;
  side:           string;
  price_cents:    number;
  count:          number;
  /** Kalshi order ID when a real order was placed; null for simulated/shadow orders. */
  kalshi_order_id?: string | null;
}): Promise<number> {
  const { rows } = await db.execute(sql`
    INSERT INTO orders
      (signal_id, approval_id, mode, ts_placed, ticker, station_id, side, price_cents, count, status, kalshi_order_id)
    VALUES
      (${row.signal_id}, ${row.approval_id}, ${row.mode}, NOW(),
       ${row.ticker}, ${row.station_id}, ${row.side}, ${row.price_cents}, ${row.count}, 'open',
       ${row.kalshi_order_id ?? null})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

// ─── Report ───────────────────────────────────────────────────────────────────

export async function getApprovalReport(from?: string, to?: string): Promise<unknown> {
  const fromClause = from ? `AND a.proposed_ts >= ${JSON.stringify(from)}::timestamptz` : "";
  const toClause   = to   ? `AND a.proposed_ts <= ${JSON.stringify(to)}::timestamptz`   : "";

  const { rows: summary } = await db.execute(sql`
    SELECT
      COUNT(*)                                               AS total_proposals,
      COUNT(*) FILTER (WHERE decision = 'approved')          AS approved,
      COUNT(*) FILTER (WHERE decision = 'denied')            AS denied,
      COUNT(*) FILTER (WHERE decision = 'expired')           AS expired,
      COUNT(*) FILTER (WHERE decision IS NULL)               AS pending,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP
        (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL))
                                                             AS median_latency_ms,
      COUNT(*) FILTER (WHERE decision = 'approved' AND recheck_ok = true) AS orders_placed,
      COUNT(*) FILTER (WHERE decision = 'approved' AND recheck_ok = false) AS approved_stale
    FROM approvals a
    WHERE 1=1
  `);

  // P&L of approved+filled trades
  const { rows: pnlRows } = await db.execute(sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN o.side = 'YES'
            THEN (CASE WHEN st.kalshi_settled_bracket = o.ticker THEN 100 - o.fill_price_cents ELSE -o.fill_price_cents END)
          ELSE (CASE WHEN st.kalshi_settled_bracket != o.ticker THEN 100 - o.fill_price_cents ELSE -o.fill_price_cents END)
        END
      ), 0)::int AS approved_pnl_cents,
      COUNT(o.id) AS settled_trade_count
    FROM orders o
    JOIN approvals a ON a.id = o.approval_id
    JOIN settlements st ON st.station_id = o.station_id
                       AND st.settlement_date = o.ts_placed::date::text
    WHERE o.approval_id IS NOT NULL
      AND o.status = 'filled'
      AND o.fill_price_cents IS NOT NULL
  `);

  // Counterfactual P&L of denied trades (fill_uncertain clearly labelled)
  const { rows: cfRows } = await db.execute(sql`
    SELECT
      COUNT(*)::int AS denied_with_outcome,
      COUNT(*) FILTER (WHERE
        a.side = 'YES' AND s.lock_status != 'dead'
        AND bk.yes_ask IS NOT NULL AND bk.yes_ask <= s.limit_price
      )::int AS fill_certain_count,
      COALESCE(SUM(
        CASE
          WHEN a.side = 'YES' AND st.kalshi_settled_bracket = a.ticker
            THEN 100 - s.limit_price
          WHEN a.side = 'YES'
            THEN -s.limit_price
          WHEN a.side = 'NO' AND st.kalshi_settled_bracket != a.ticker
            THEN 100 - s.limit_price
          ELSE -s.limit_price
        END
      ) FILTER (WHERE
        (a.side = 'YES' AND bk.yes_ask IS NOT NULL AND bk.yes_ask <= s.limit_price)
        OR (a.side = 'NO' AND bk.yes_bid IS NOT NULL AND (100 - bk.yes_bid) <= s.limit_price)
      ), 0)::int AS counterfactual_pnl_certain_cents,
      COALESCE(SUM(
        CASE
          WHEN a.side = 'YES' AND st.kalshi_settled_bracket = a.ticker
            THEN 100 - s.limit_price
          WHEN a.side = 'YES'
            THEN -s.limit_price
          WHEN a.side = 'NO' AND st.kalshi_settled_bracket != a.ticker
            THEN 100 - s.limit_price
          ELSE -s.limit_price
        END
      ) FILTER (WHERE
        NOT (
          (a.side = 'YES' AND bk.yes_ask IS NOT NULL AND bk.yes_ask <= s.limit_price)
          OR (a.side = 'NO' AND bk.yes_bid IS NOT NULL AND (100 - bk.yes_bid) <= s.limit_price)
        )
      ), 0)::int AS counterfactual_pnl_uncertain_cents
    FROM approvals a
    JOIN signals s ON s.id = a.signal_id
    JOIN settlements st ON st.station_id = s.station_id
    JOIN (
      SELECT DISTINCT ON (ticker) ticker, yes_ask, yes_bid
      FROM books ORDER BY ticker, ts_utc ASC
    ) bk ON bk.ticker = a.ticker
    WHERE a.decision = 'denied'
  `);

  const s = (summary[0] ?? {}) as Record<string, unknown>;
  const p = (pnlRows[0] ?? {}) as Record<string, unknown>;
  const c = (cfRows[0] ?? {}) as Record<string, unknown>;

  return {
    window:                { from: from ?? null, to: to ?? null },
    proposals: {
      total:    Number(s["total_proposals"] ?? 0),
      approved: Number(s["approved"] ?? 0),
      denied:   Number(s["denied"] ?? 0),
      expired:  Number(s["expired"] ?? 0),
      pending:  Number(s["pending"] ?? 0),
      approved_stale: Number(s["approved_stale"] ?? 0),
    },
    decision_latency: {
      median_ms: s["median_latency_ms"] !== null ? Number(s["median_latency_ms"]) : null,
    },
    orders_placed:       Number(s["orders_placed"] ?? 0),
    approved_pnl_cents:  Number(p["approved_pnl_cents"] ?? 0),
    settled_trade_count: Number(p["settled_trade_count"] ?? 0),
    counterfactual_denied: {
      _note:                   "estimated, assumes fill — see fill_certain_count vs total",
      denied_with_outcome:     Number(c["denied_with_outcome"] ?? 0),
      fill_certain_count:      Number(c["fill_certain_count"] ?? 0),
      pnl_certain_cents:       Number(c["counterfactual_pnl_certain_cents"] ?? 0),
      pnl_uncertain_cents:     Number(c["counterfactual_pnl_uncertain_cents"] ?? 0),
    },
  };
}
