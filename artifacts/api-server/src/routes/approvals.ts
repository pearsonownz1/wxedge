/**
 * Approvals routes — human-in-the-loop trading queue.
 *
 * GET  /approvals          — pending queue + recent decision history
 * PATCH /approvals/:id     — approve or deny a proposal (with revalidation on approve)
 * GET  /approvals/report   — grant reporting endpoint
 */

import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import {
  getPendingApprovals,
  getApprovalHistory,
  getApprovalById,
  decideApproval,
  insertApprovalOrder,
  getCurrentMarketState,
  buildApprovalRiskState,
  getApprovalReport,
} from "../lib/approvalsDb.js";
import { placeKalshiOrder, kalshiLiveOrdersEnabled } from "../lib/kalshiOrderApi.js";

const router = Router();

// ─── Load risk config (shared with trader; read from filesystem) ──────────────

interface RiskConfig {
  execution_mode:                       string;
  mode:                                 string;
  max_cost_per_trade_cents:             number;
  cooldown_min:                         number;
  max_open_orders_per_station:          number;
  max_daily_exposure_per_station_cents: number;
  max_total_open_exposure_cents:        number;
  max_daily_loss_cents:                 number;
  min_edge:                             number;
  slippage_buffer:                      number;
  max_age_min:                          number;
  max_obs_age_min:                      number;
  fee_rate:                             number;
  ttl_min:                              number;
  cancel_edge:                          number;
  proposal_ttl_min:                     number;
}

function loadRiskConfig(): RiskConfig {
  const paths = [
    resolve(process.cwd(), "artifacts/trader/config/risk.json"),
    resolve(process.cwd(), "../trader/config/risk.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")) as RiskConfig;
    }
  }
  // Fallback defaults so the API doesn't crash if trader config is unavailable
  return {
    execution_mode: "approval", mode: "shadow",
    max_cost_per_trade_cents: 60, cooldown_min: 30,
    max_open_orders_per_station: 1, max_daily_exposure_per_station_cents: 200,
    max_total_open_exposure_cents: 500, max_daily_loss_cents: 300,
    min_edge: 0.05, slippage_buffer: 0.01, max_age_min: 10, max_obs_age_min: 75,
    fee_rate: 0.07, ttl_min: 15, cancel_edge: 0.01, proposal_ttl_min: 30,
  };
}

const riskConfig = loadRiskConfig();

// ─── Per-station approve mutex ────────────────────────────────────────────────
// Serializes risk re-check + order insert per station so two concurrent
// approvals cannot both pass the caps (read-then-write race). In-process only,
// which is sufficient while a single api-server instance handles approvals
// (dev and Reserved VM prod both run one instance). If approvals ever run
// multi-instance, replace with pg_advisory_xact_lock inside a transaction.
const stationLocks = new Map<string, Promise<unknown>>();
function withStationLock<T>(stationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = stationLocks.get(stationId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  stationLocks.set(stationId, run.then(() => undefined, () => undefined));
  return run;
}

// ─── GET /approvals ───────────────────────────────────────────────────────────

router.get("/approvals", async (_req: Request, res: Response) => {
  try {
    const [pending, history] = await Promise.all([
      getPendingApprovals(),
      getApprovalHistory(50),
    ]);
    res.json({ pending, history });
  } catch (err) {
    logger.error({ err }, "GET /approvals failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── PATCH /approvals/:id ─────────────────────────────────────────────────────

router.patch("/approvals/:id", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) return void res.status(400).json({ error: "invalid_id" });

  const { action, decider: rawDecider } = req.body as { action?: string; decider?: string };
  if (action !== "approve" && action !== "deny") {
    return void res.status(400).json({ error: "action must be approve or deny" });
  }
  const decider: "human" | "llm" = rawDecider === "llm" ? "llm" : "human";

  try {
    const approval = await getApprovalById(id);
    if (!approval) return void res.status(404).json({ error: "not_found" });

    // ── Idempotency / conflict check ──────────────────────────────────────────
    if (approval.decision !== null) {
      if (action === "approve" && approval.decision === "approved" && approval.recheck_ok) {
        // Already approved and order placed — return existing order idempotently
        const { rows } = await db.execute(sql`
          SELECT id, ticker, side, price_cents, count, status
          FROM orders WHERE approval_id = ${id} LIMIT 1
        `);
        const order = rows[0];
        return void res.json({ result: "order_placed", order });
      }
      return void res.status(409).json({
        result: "conflict",
        decision: approval.decision,
      });
    }

    // ── Deny path ─────────────────────────────────────────────────────────────
    if (action === "deny") {
      const now = new Date();
      const latencyMs = now.getTime() - new Date(approval.proposed_ts).getTime();
      await decideApproval(id, "denied", latencyMs, true, null, decider);
      logger.info({ approvalId: id, ticker: approval.ticker, latencyMs, decider }, "Proposal denied");
      return void res.json({ result: "denied" });
    }

    // ── Approve path: expiry + revalidation ───────────────────────────────────
    const now = new Date();

    // Check expiry (treat as 409 so UI can show the right state)
    if (now > new Date(approval.expires_ts)) {
      await decideApproval(id, "expired", null, null, null);
      return void res.status(409).json({ result: "conflict", decision: "expired" });
    }

    // Fetch current market state for this ticker
    const current = await getCurrentMarketState(approval.ticker);
    const card = approval.card_json ? JSON.parse(approval.card_json) as Record<string, number> : {};

    const diff: Record<string, { at_proposal: unknown; now: unknown }> = {};

    // 1. Freshness: book age
    if (current === null) {
      diff["book_available"] = { at_proposal: true, now: false };
    } else {
      const bookAgeMin = current.book_age_min;
      if (bookAgeMin > riskConfig.max_age_min) {
        diff["book_age_min"] = { at_proposal: 0, now: bookAgeMin };
      }

      // obs age — METARs are ~hourly, so this uses max_obs_age_min (75), NOT
      // max_age_min (10, which bounds book/snapshot age). Must stay consistent
      // with the trader's signal engine or approvals fail that signals passed.
      if (current.obs_age_s !== null && current.obs_age_s > riskConfig.max_obs_age_min * 60) {
        diff["obs_age_s"] = { at_proposal: 0, now: current.obs_age_s };
      }

      // 2. Bracket still alive
      if (current.lock_status === "dead") {
        diff["eliminated"] = { at_proposal: false, now: true };
      }

      // 3. Edge at current price
      if (current.ask_cents !== null || current.bid_cents !== null) {
        const currentEdge = computeCurrentEdge(
          approval.side as "YES" | "NO",
          current,
          card["model_pct"] as number ?? 0,
          riskConfig
        );
        if (currentEdge !== null && currentEdge < riskConfig.cancel_edge) {
          diff["edge_net"] = {
            at_proposal: (card["edge_pts"] as number ?? 0) / 100,
            now: Math.round(currentEdge * 1000) / 1000,
          };
        }

        // Price shift
        const currentPrice = approval.side === "YES"
          ? (current.ask_cents ?? null)
          : (current.bid_cents !== null ? 100 - current.bid_cents : null);
        if (currentPrice !== null && currentPrice !== approval.limit_price_cents) {
          diff["limit_price_cents"] = {
            at_proposal: approval.limit_price_cents,
            now: currentPrice,
          };
        }
      }
    }

    // 4. Kill switch
    if (existsSync("/tmp/trader_kill.flag")) {
      diff["kill_switch"] = { at_proposal: false, now: true };
    }

    // 5. Risk state re-check, decision, and order insert run under the
    //    per-station mutex — see withStationLock above.
    return void await withStationLock(approval.station_id, async () => {
    const today = now.toISOString().slice(0, 10);
    const riskState = await buildApprovalRiskState(today, riskConfig);
    const contracts = Math.max(1, Math.floor(
      riskConfig.max_cost_per_trade_cents / approval.limit_price_cents
    ));
    const orderCost = approval.limit_price_cents * contracts;
    if (riskState.dailyCostToday + orderCost > riskConfig.max_daily_loss_cents) {
      diff["daily_loss_cap"] = {
        at_proposal: "ok",
        now: `cost_today=${riskState.dailyCostToday} + this=${orderCost} > limit=${riskConfig.max_daily_loss_cents}`,
      };
    }
    if (orderCost > riskConfig.max_cost_per_trade_cents) {
      diff["max_cost_per_trade"] = {
        at_proposal: "ok",
        now: `cost=${orderCost} > limit=${riskConfig.max_cost_per_trade_cents}`,
      };
    }
    const stationOpen = riskState.openOrdersPerStation[approval.station_id] ?? 0;
    if (stationOpen >= riskConfig.max_open_orders_per_station) {
      diff["open_orders_per_station"] = {
        at_proposal: 0,
        now: stationOpen,
      };
    }
    const stationDaily = riskState.dailyExposurePerStation[approval.station_id] ?? 0;
    if (stationDaily + orderCost > riskConfig.max_daily_exposure_per_station_cents) {
      diff["daily_exposure_per_station"] = {
        at_proposal: "ok",
        now: `station_today=${stationDaily} + this=${orderCost} > limit=${riskConfig.max_daily_exposure_per_station_cents}`,
      };
    }
    if (riskState.totalOpenExposure + orderCost > riskConfig.max_total_open_exposure_cents) {
      diff["total_open_exposure"] = {
        at_proposal: "ok",
        now: `open=${riskState.totalOpenExposure} + this=${orderCost} > limit=${riskConfig.max_total_open_exposure_cents}`,
      };
    }

    // ── Stale: revalidation failed ────────────────────────────────────────────
    if (Object.keys(diff).length > 0) {
      const note = Object.keys(diff).join(", ");
      const latencyMs = now.getTime() - new Date(approval.proposed_ts).getTime();
      const updated = await decideApproval(id, "approved", latencyMs, false, note, decider);
      if (!updated) {
        return void res.status(409).json({ result: "conflict", decision: "approved" });
      }
      logger.warn({ approvalId: id, diff, decider }, "Approve: revalidation failed — no order placed");
      return void res.json({
        result: "stale",
        recheck_note: `Conditions changed: ${note}`,
        diff,
      });
    }

    // ── All checks pass: CAS update then place order ──────────────────────────
    const latencyMs = now.getTime() - new Date(approval.proposed_ts).getTime();
    const updated = await decideApproval(id, "approved", latencyMs, true, null, decider);
    if (!updated) {
      // Race condition: another request won the CAS — return existing order
      const { rows } = await db.execute(sql`
        SELECT id, ticker, side, price_cents, count, status
        FROM orders WHERE approval_id = ${id} LIMIT 1
      `);
      const order = rows[0];
      return void res.status(409).json({ result: "conflict", decision: "approved", order });
    }

    // ── Place order — real Kalshi call in production, simulation in dev ───────
    const execMode = riskConfig.execution_mode === "approval" ? "approval" : riskConfig.mode;
    const currentPrice = current
      ? (approval.side === "YES"
          ? (current.ask_cents ?? approval.limit_price_cents)
          : (current.bid_cents !== null ? 100 - current.bid_cents : approval.limit_price_cents))
      : approval.limit_price_cents;

    let kalshiOrderId: string | null = null;
    let kalshiStatus = "open";

    if (kalshiLiveOrdersEnabled()) {
      try {
        const kalshiResult = await placeKalshiOrder(
          approval.ticker,
          approval.side as "YES" | "NO",
          currentPrice,
          contracts,
        );
        kalshiOrderId = kalshiResult.order_id;
        kalshiStatus  = kalshiResult.status ?? "open";
        logger.info(
          { approvalId: id, kalshiOrderId, ticker: approval.ticker, side: approval.side, contracts, status: kalshiStatus },
          "Real Kalshi order placed"
        );
      } catch (kalshiErr) {
        // Log prominently but don't block — still record the approval in our DB
        // so the decision is auditable. The order will show kalshi_order_id = null.
        logger.error(
          { approvalId: id, ticker: approval.ticker, err: kalshiErr },
          "Kalshi order placement FAILED — recording approval without live fill"
        );
      }
    } else {
      logger.info(
        { approvalId: id, ticker: approval.ticker },
        "Development mode — skipping real Kalshi order (simulation only)"
      );
    }

    const orderId = await insertApprovalOrder({
      signal_id:      approval.signal_id,
      approval_id:    id,
      mode:           execMode as "shadow" | "approval" | "live",
      ticker:         approval.ticker,
      station_id:     approval.station_id,
      side:           approval.side as "YES" | "NO",
      price_cents:    currentPrice,
      count:          contracts,
      kalshi_order_id: kalshiOrderId,
      status:         kalshiOrderId ? kalshiStatus : "open",
    });

    logger.info(
      { approvalId: id, orderId, kalshiOrderId, ticker: approval.ticker, side: approval.side, priceCents: currentPrice, contracts, decider },
      "Proposal approved — order recorded"
    );

    return void res.json({
      result: "order_placed",
      order: {
        id:                orderId,
        ticker:            approval.ticker,
        side:              approval.side,
        limit_price_cents: currentPrice,
        contracts,
        status:            kalshiOrderId ? kalshiStatus : "open",
        kalshi_order_id:   kalshiOrderId,
      },
    });
    }); // end withStationLock
  } catch (err) {
    logger.error({ err, approvalId: id }, "PATCH /approvals/:id failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── GET /approvals/report ────────────────────────────────────────────────────

router.get("/approvals/report", async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as { from?: string; to?: string };
    const report = await getApprovalReport(from, to);
    res.json(report);
  } catch (err) {
    logger.error({ err }, "GET /approvals/report failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeCurrentEdge(
  side: "YES" | "NO",
  current: { ask_cents: number | null; bid_cents: number | null; model_pct: number },
  modelPct: number,
  config: RiskConfig
): number | null {
  const mp = modelPct / 100;
  if (side === "YES") {
    if (current.ask_cents === null) return null;
    const p = current.ask_cents / 100;
    const fee = Math.ceil(config.fee_rate * p * (1 - p) * 100) / 100;
    return mp - p - fee - config.slippage_buffer;
  } else {
    if (current.bid_cents === null) return null;
    const noAsk = (100 - current.bid_cents) / 100;
    const fee = Math.ceil(config.fee_rate * noAsk * (1 - noAsk) * 100) / 100;
    return (1 - mp) - noAsk - fee - config.slippage_buffer;
  }
}

export default router;
