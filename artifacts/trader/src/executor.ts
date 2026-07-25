/**
 * Executor — handles order placement across all execution modes.
 *
 * approval: signal passes risk officer → createProposal() → human decides
 * shadow:   identical code path to live; writes shadow_order to orders table
 * live:     Phase C — signed Kalshi REST call (not yet implemented)
 *
 * Fill simulation (shadow/approval modes, run every poll via monitorOpenOrders):
 *   A YES limit buy at price P is filled if the latest YES ask ≤ P.
 *   A NO limit buy at P_no is filled if the latest NO ask (= 100 − YES bid) ≤ P_no.
 *   Fill price = limit_price (conservative; post-only semantics).
 *
 * Order lifecycle:
 *   open → filled          : fill condition met at next book check
 *          cancelled       : edge_net dropped below cancel_edge threshold
 *          expired         : TTL elapsed with no fill
 */

import {
  insertOrder,
  updateOrderStatus,
  getOpenOrders,
  getLatestSignalInputs,
  insertRiskDecision,
  markSignalPendingApproval,
  type OrderRow,
} from "./db.js";
import { checkRisk, type SignalCandidate } from "./riskOfficer.js";
import { buildRiskState } from "./db.js";
import { createProposal } from "./approvals.js";
import type { RiskConfig } from "./config.js";
import pino from "pino";

const logger = pino({ name: "executor" });

// ─── Place ────────────────────────────────────────────────────────────────────

/**
 * Evaluate signal through risk officer.
 * In approval mode: create a pending proposal awaiting human decision.
 * In shadow mode:   place a shadow order immediately.
 * Returns the order/proposal id, or null if rejected or duplicate proposal.
 */
export async function placeOrder(
  signalId: number,
  candidate: SignalCandidate,
  config: RiskConfig,
  todayDate: string
): Promise<number | null> {
  const riskState = await buildRiskState(todayDate, config.mode, config.cooldown_min);
  const decision  = checkRisk(candidate, riskState, config);

  // Always log the risk decision.
  await insertRiskDecision({
    signal_id: signalId,
    ts_utc:    new Date().toISOString(),
    approved:  decision.approved,
    reason:    decision.reason,
  });

  if (!decision.approved) {
    logger.debug(
      { signalId, reason: decision.reason },
      "Risk officer rejected signal"
    );
    return null;
  }

  if (config.execution_mode === "approval") {
    // Mark signal as pending_approval, then create the proposal card.
    await markSignalPendingApproval(signalId);
    const approvalId = await createProposal(signalId, candidate, config);
    return approvalId;
  }

  if (config.mode === "shadow" || config.execution_mode === "auto") {
    return placeShadowOrder(signalId, candidate, config);
  }

  // Phase C: implement live Kalshi order placement here.
  throw new Error("Live mode not implemented in Phase A/B");
}

async function placeShadowOrder(
  signalId: number,
  candidate: SignalCandidate,
  config: RiskConfig
): Promise<number> {
  const orderId = await insertOrder({
    signal_id:   signalId,
    mode:        "shadow",
    ts_placed:   new Date().toISOString(),
    ticker:      candidate.ticker,
    station_id:  candidate.station_id,
    side:        candidate.side,
    price_cents: candidate.limit_price,
    count:       1,
    status:      "open",
  });

  logger.info(
    {
      orderId,
      ticker:     candidate.ticker,
      side:       candidate.side,
      priceCents: candidate.limit_price,
      edgeNet:    candidate.edge_net.toFixed(3),
    },
    "Shadow order placed"
  );

  return orderId;
}

// ─── Monitor open orders ──────────────────────────────────────────────────────

/**
 * Called every poll cycle.  For each open order (shadow or approval mode):
 *   1. Check if it should be cancelled (edge dropped below cancel_edge or TTL exceeded).
 *   2. Check if it should be filled (fill condition from current book).
 */
export async function monitorOpenOrders(
  config: RiskConfig,
  now: Date
): Promise<void> {
  // Monitor both shadow and approval-placed orders
  const [shadowOrders, approvalOrders] = await Promise.all([
    getOpenOrders("shadow"),
    getOpenOrders("approval"),
  ]);
  const openOrders = [...shadowOrders, ...approvalOrders];
  if (openOrders.length === 0) return;

  // Latest book data keyed by ticker
  const latestInputs = await getLatestSignalInputs();
  const bookByTicker = new Map<string, typeof latestInputs[0]>();
  for (const row of latestInputs) {
    bookByTicker.set(row.ticker, row);
  }

  for (const order of openOrders) {
    const ageMin = (now.getTime() - new Date(order.ts_placed).getTime()) / 60_000;
    const book   = bookByTicker.get(order.ticker);

    // ── TTL expiry ────────────────────────────────────────────────────────────
    if (ageMin >= config.ttl_min) {
      await updateOrderStatus(order.id!, {
        status:          "expired",
        ts_cancelled:    now.toISOString(),
        book_state_json: book ? JSON.stringify(bookSnapshot(book)) : null,
      });
      logger.info({ orderId: order.id, ticker: order.ticker }, "Order expired (TTL)");
      continue;
    }

    if (!book) continue;  // No book data yet; leave open

    // ── Cancel if edge has dropped ────────────────────────────────────────────
    const currentEdge = computeCurrentEdge(order, book, config);
    if (currentEdge !== null && currentEdge < config.cancel_edge) {
      await updateOrderStatus(order.id!, {
        status:          "cancelled",
        ts_cancelled:    now.toISOString(),
        book_state_json: JSON.stringify(bookSnapshot(book)),
      });
      logger.info(
        { orderId: order.id, ticker: order.ticker, currentEdge: currentEdge.toFixed(3) },
        "Order cancelled (edge below cancel threshold)"
      );
      continue;
    }

    // ── Fill simulation ───────────────────────────────────────────────────────
    const filled = isFilled(order, book);
    if (filled) {
      await updateOrderStatus(order.id!, {
        status:           "filled",
        ts_filled:        now.toISOString(),
        fill_price_cents: order.price_cents, // post-only: filled at limit price
        book_state_json:  JSON.stringify(bookSnapshot(book)),
      });
      logger.info(
        {
          orderId:   order.id,
          ticker:    order.ticker,
          side:      order.side,
          fillCents: order.price_cents,
          mode:      order.mode,
        },
        "Order filled"
      );
    }
  }
}

// ─── Fill condition ───────────────────────────────────────────────────────────

export function isFilled(
  order: OrderRow,
  book: ReturnType<typeof getLatestSignalInputs> extends Promise<Array<infer T>> ? T : never
): boolean {
  if (order.side === "YES") {
    return book.ask_cents !== null && book.ask_cents <= order.price_cents;
  } else {
    // NO ask = 100 − YES bid
    if (book.bid_cents === null) return false;
    const noAsk = 100 - book.bid_cents;
    return noAsk <= order.price_cents;
  }
}

/** Recompute edge at the current book prices (for cancel check). */
function computeCurrentEdge(
  order: OrderRow,
  book: ReturnType<typeof getLatestSignalInputs> extends Promise<Array<infer T>> ? T : never,
  config: RiskConfig
): number | null {
  if (order.side === "YES") {
    if (book.ask_cents === null) return null;
    const execPrice = book.ask_cents / 100;
    const fee = Math.ceil(config.fee_rate * execPrice * (1 - execPrice) * 100) / 100;
    return (book.model_pct / 100) - execPrice - fee - config.slippage_buffer;
  } else {
    if (book.bid_cents === null) return null;
    const noAsk = (100 - book.bid_cents) / 100;
    const fee = Math.ceil(config.fee_rate * noAsk * (1 - noAsk) * 100) / 100;
    return (1 - book.model_pct / 100) - noAsk - fee - config.slippage_buffer;
  }
}

function bookSnapshot(
  book: ReturnType<typeof getLatestSignalInputs> extends Promise<Array<infer T>> ? T : never
): Record<string, unknown> {
  return {
    ts_utc:    book.ts_utc,
    ticker:    book.ticker,
    bid_cents: book.bid_cents,
    ask_cents: book.ask_cents,
    coherent:  book.coherent_flag,
  };
}
