/**
 * Approval mode — proposal lifecycle for the human-in-the-loop flow.
 *
 * createProposal():
 *   Called instead of placeOrder when execution_mode='approval'.
 *   Checks for an existing open proposal for the same ticker+side (duplicate guard),
 *   renders a template trade card synchronously, and inserts the approvals row.
 *
 * sweepExpiredProposals():
 *   Marks any proposals past their expires_ts as decision='expired'.
 *   Called at trader startup and every 4-min tick.
 */

import {
  insertApproval,
  getPendingApprovalForTicker,
  sweepExpiredApprovals,
  getLatestInputByTicker,
} from "./db.js";
import type { SignalCandidate } from "./riskOfficer.js";
import type { RiskConfig } from "./config.js";
import pino from "pino";

const logger = pino({ name: "approvals" });

// ─── Template card ────────────────────────────────────────────────────────────

/** Station display names for the card headline. */
const STATION_NAMES: Record<string, string> = {
  KNYC: "NYC",
  KMDW: "CHI",
  KAUS: "AUS",
  KDFW: "DFW",
  KLAX: "LAX",
  KPHL: "PHL",
};

interface TradeCard {
  headline:         string;
  model_pct:        number;
  implied_pct:      number;
  edge_pts:         number;
  max_loss_cents:   number;
  running_high_f:   number | null;
  hours_to_settle:  number | null;
  bracket_label:    string;
  station_id:       string;
  ticker:           string;
  side:             "YES" | "NO";
  limit_price_cents: number;
  generated_at:     string;
  template_version: 1;
}

function renderCard(candidate: SignalCandidate, input: {
  model_pct:       number;
  bracket_label:   string;
  running_high_f:  number;
  hours_to_settle: number;
} | null): TradeCard {
  const city    = STATION_NAMES[candidate.station_id] ?? candidate.station_id;
  const label   = input?.bracket_label ?? "?";
  const price   = candidate.limit_price;
  const modelPct = input ? Math.round(input.model_pct) : null;

  const headline = modelPct !== null
    ? `Buy ${candidate.side} on ${city} ${label} at ${price}¢ — model sees ${modelPct}%`
    : `Buy ${candidate.side} on ${city} ${label} at ${price}¢`;

  return {
    headline,
    model_pct:        input?.model_pct ?? 0,
    implied_pct:      candidate.limit_price,
    edge_pts:         Math.round(candidate.edge_net * 100 * 10) / 10,
    max_loss_cents:   candidate.limit_price,
    running_high_f:   input?.running_high_f ?? null,
    hours_to_settle:  input?.hours_to_settle ?? null,
    nbm_median_f:     input?.nbm_median_f ?? null,
    bracket_label:    label,
    station_id:       candidate.station_id,
    ticker:           candidate.ticker,
    side:             candidate.side,
    limit_price_cents: candidate.limit_price,
    generated_at:     new Date().toISOString(),
    template_version: 1,
  };
}

// ─── Create proposal ──────────────────────────────────────────────────────────

/**
 * Create a pending approval proposal for a signal that passed risk checks.
 * Returns the approval row id, or null if a duplicate proposal already exists.
 */
export async function createProposal(
  signalId: number,
  candidate: SignalCandidate,
  config: RiskConfig
): Promise<number | null> {
  // Duplicate guard: one open proposal per ticker+side (enforced by partial unique index in DB;
  // this pre-check reduces noise in logs).
  const existing = await getPendingApprovalForTicker(candidate.ticker, candidate.side);
  if (existing) {
    logger.debug(
      { ticker: candidate.ticker, side: candidate.side, existingId: existing.id },
      "Duplicate proposal suppressed — open proposal already exists"
    );
    return null;
  }

  // Fetch snapshot data for the card (best-effort; card renders without it)
  const input = await getLatestInputByTicker(candidate.ticker).catch(() => null);

  const card = renderCard(candidate, input);

  const now      = new Date();
  const ttlMs    = (config.proposal_ttl_min ?? 30) * 60_000;
  const expiresTs = new Date(now.getTime() + ttlMs);

  try {
    const approvalId = await insertApproval({
      signal_id:   signalId,
      ticker:      candidate.ticker,
      side:        candidate.side,
      proposed_ts: now.toISOString(),
      expires_ts:  expiresTs.toISOString(),
      card_json:   JSON.stringify(card),
    });

    logger.info(
      {
        approvalId,
        signalId,
        ticker:    candidate.ticker,
        side:      candidate.side,
        expiresTs: expiresTs.toISOString(),
        headline:  card.headline,
      },
      "Proposal created — awaiting human decision"
    );

    return approvalId;
  } catch (err: unknown) {
    // Partial unique index violation: a concurrent insert beat us to it
    const msg = String(err);
    if (msg.includes("one_open_proposal") || msg.includes("unique")) {
      logger.debug(
        { ticker: candidate.ticker, side: candidate.side },
        "Proposal insert rejected by unique index — concurrent duplicate"
      );
      return null;
    }
    throw err;
  }
}

// ─── Expiry sweep ─────────────────────────────────────────────────────────────

/**
 * Mark all proposals past their expires_ts as decision='expired'.
 * Idempotent — safe to call at startup and every tick.
 * Returns the count of newly expired rows.
 */
export async function sweepExpiredProposals(): Promise<number> {
  const count = await sweepExpiredApprovals();
  if (count > 0) {
    logger.info({ count }, "Swept expired proposals");
  }
  return count;
}
