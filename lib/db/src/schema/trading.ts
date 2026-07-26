/**
 * Trading layer schema — Phase A + Approval Mode.
 *
 * books          — per-bracket order book snapshot, one row per ticker per poll.
 * signals        — signal engine output (ALL signals, suppressed or live).
 * risk_decisions — risk officer approve/reject log keyed to each signal.
 * orders         — append-only order lifecycle (shadow, approval, and live).
 * settlements    — daily reconciliation: CLI final high vs. Kalshi settlement.
 * daily_pnl      — rolled-up P&L per day per mode (written by auditor).
 * approvals      — human-in-the-loop approval queue (Phase B).
 */

import {
  pgTable,
  serial,
  text,
  real,
  integer,
  bigint,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/** Per-bracket order book snapshot from the Kalshi events list. */
export const books = pgTable(
  "books",
  {
    id:           serial("id").primaryKey(),
    tsUtc:        timestamp("ts_utc", { withTimezone: true }).notNull(),
    stationId:    text("station_id").notNull(),
    ticker:       text("ticker").notNull(),
    bracketLo:    real("bracket_lo"),
    bracketHi:    real("bracket_hi"),
    yesBid:       integer("yes_bid"),
    yesAsk:       integer("yes_ask"),
    noBid:        integer("no_bid"),
    noAsk:        integer("no_ask"),
    bidSize:      integer("bid_size"),
    askSize:      integer("ask_size"),
    coherentFlag: boolean("coherent_flag").notNull().default(true),
  },
  (table) => [
    index("books_station_ts_idx").on(table.stationId, table.tsUtc),
    index("books_ticker_ts_idx").on(table.ticker, table.tsUtc),
  ]
);

/**
 * Signal engine output. Every candidate signal is written here, whether it
 * passes the risk officer or not. suppressed_reason is NULL for live signals.
 * status: 'live' | 'pending_approval' — set to pending_approval in approval mode.
 */
export const signals = pgTable(
  "signals",
  {
    id:               serial("id").primaryKey(),
    tsUtc:            timestamp("ts_utc", { withTimezone: true }).notNull(),
    stationId:        text("station_id").notNull(),
    ticker:           text("ticker").notNull(),
    side:             text("side").notNull(),
    limitPrice:       integer("limit_price").notNull(),
    modelProb:        real("model_prob").notNull(),
    impliedProb:      real("implied_prob").notNull(),
    edgeNet:          real("edge_net").notNull(),
    inputsHash:       text("inputs_hash").notNull(),
    suppressedReason: text("suppressed_reason"),
    /** 'live' (default) or 'pending_approval' in approval mode. */
    status:           text("status").default("live"),
  },
  (table) => [
    index("signals_station_ts_idx").on(table.stationId, table.tsUtc),
    index("signals_ticker_ts_idx").on(table.ticker, table.tsUtc),
  ]
);

/** Risk officer decision, one row per signal that reached the officer. */
export const riskDecisions = pgTable(
  "risk_decisions",
  {
    id:       serial("id").primaryKey(),
    signalId: integer("signal_id").notNull(),
    tsUtc:    timestamp("ts_utc", { withTimezone: true }).notNull(),
    approved: boolean("approved").notNull(),
    reason:   text("reason").notNull(),
  },
  (table) => [
    index("risk_decisions_signal_idx").on(table.signalId),
  ]
);

/**
 * Order lifecycle. Append-only.
 * mode: 'shadow' | 'approval' | 'live'
 * status transitions: open → filled | cancelled | expired
 */
export const orders = pgTable(
  "orders",
  {
    id:             serial("id").primaryKey(),
    signalId:       integer("signal_id").notNull(),
    approvalId:     integer("approval_id"),   // set when placed via human approval
    mode:           text("mode").notNull(),
    tsPlaced:       timestamp("ts_placed", { withTimezone: true }).notNull(),
    ticker:         text("ticker").notNull(),
    stationId:      text("station_id").notNull(),
    side:           text("side").notNull(),
    priceCents:     integer("price_cents").notNull(),
    count:          integer("count").notNull().default(1),
    status:         text("status").notNull().default("open"),
    tsFilled:       timestamp("ts_filled", { withTimezone: true }),
    fillPriceCents: integer("fill_price_cents"),
    tsCancelled:    timestamp("ts_cancelled", { withTimezone: true }),
    bookStateJson:  text("book_state_json"),
    kalshiOrderId:  text("kalshi_order_id"),
  },
  (table) => [
    index("orders_signal_idx").on(table.signalId),
    index("orders_station_status_idx").on(table.stationId, table.status),
    index("orders_ts_placed_idx").on(table.tsPlaced),
    index("orders_approval_idx").on(table.approvalId),
  ]
);

/**
 * Human-in-the-loop approval queue.
 *
 * Partial unique index (enforced via raw SQL, not Drizzle):
 *   CREATE UNIQUE INDEX one_open_proposal ON approvals (ticker, side)
 *   WHERE decision IS NULL;
 *
 * Idempotency on approve: check decision IS NULL via CAS UPDATE before placing order.
 */
export const approvals = pgTable(
  "approvals",
  {
    id:             serial("id").primaryKey(),
    signalId:       integer("signal_id").notNull().unique(),
    ticker:         text("ticker").notNull(),
    side:           text("side").notNull(),
    proposedTs:     timestamp("proposed_ts", { withTimezone: true }).notNull(),
    expiresTs:      timestamp("expires_ts", { withTimezone: true }).notNull(),
    /** Template trade card JSON; GPT enrichment is async/deferred. */
    cardJson:       text("card_json"),
    decision:       text("decision"),       // 'approved' | 'denied' | 'expired' | null (pending)
    decisionTs:     timestamp("decision_ts", { withTimezone: true }),
    latencyMs:      bigint("latency_ms", { mode: "number" }),
    recheckOk:      boolean("recheck_ok"),
    recheckNote:    text("recheck_note"),
    /** Who made the decision: 'human' | 'llm'. NULL until decided. */
    decider:        text("decider"),
    /** LLM's staged intent in llm_with_veto mode: 'approve' | 'deny'. NULL until LLM runs. */
    llmDecision:    text("llm_decision"),
    /** When the LLM expressed its intent (start of veto window). */
    llmDecidedTs:   timestamp("llm_decided_ts", { withTimezone: true }),
    /** 2-4 sentence rationale from the LLM. */
    llmRationale:   text("llm_rationale"),
    /** LLM decision confidence 0–1. */
    llmConfidence:  real("llm_confidence"),
  },
  (table) => [
    index("approvals_signal_idx").on(table.signalId),
    index("approvals_ticker_side_idx").on(table.ticker, table.side),
    index("approvals_proposed_ts_idx").on(table.proposedTs),
  ]
);

/**
 * Full audit trail for every LLM approval decision.
 * One row per LLM call: stores exactly what the LLM saw and what it returned.
 * Allows "human vs LLM P&L" grant report and prompt debugging.
 */
export const llmDecisions = pgTable(
  "llm_decisions",
  {
    id:            bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    approvalId:    integer("approval_id").notNull(),
    ts:            timestamp("ts", { withTimezone: true }).notNull(),
    modelName:     text("model_name").notNull(),
    promptVersion: text("prompt_version").notNull(),
    payloadJson:   text("payload_json").notNull(),  // jsonb stored as text for simplicity
    responseJson:  text("response_json"),
    decision:      text("decision"),    // 'approve' | 'deny' | 'error'
    latencyMs:     integer("latency_ms"),
  },
  (table) => [
    index("llm_decisions_approval_idx").on(table.approvalId),
    index("llm_decisions_ts_idx").on(table.ts),
  ]
);

/** One row per station per settlement date, written by the auditor. */
export const settlements = pgTable(
  "settlements",
  {
    id:                   serial("id").primaryKey(),
    settlementDate:       text("settlement_date").notNull(),
    stationId:            text("station_id").notNull(),
    cliHighF:             real("cli_high_f"),
    appHighF:             real("app_high_f"),
    kalshiSettledBracket: text("kalshi_settled_bracket"),
    matchFlag:            boolean("match_flag"),
    tsUtc:                timestamp("ts_utc", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("settlements_station_date_idx").on(table.stationId, table.settlementDate),
  ]
);

/** Rolled-up daily P&L written by the auditor at 21:00 UTC. */
export const dailyPnl = pgTable(
  "daily_pnl",
  {
    id:         serial("id").primaryKey(),
    date:       text("date").notNull(),
    mode:       text("mode").notNull(),
    grossCents: integer("gross_cents").notNull(),
    feesCents:  integer("fees_cents").notNull(),
    netCents:   integer("net_cents").notNull(),
    tradeCount: integer("trade_count").notNull(),
    tsUtc:      timestamp("ts_utc", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("daily_pnl_date_mode_idx").on(table.date, table.mode),
  ]
);
