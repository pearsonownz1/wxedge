/**
 * Signal Engine — reads the latest snapshot+book data from the DB and emits
 * zero or more signal candidates for the risk officer.
 *
 * Edge formula (from the spec):
 *   edge_net = model_prob − executable_price − fee_ceil(price, 1) − slippage_buffer
 *
 * Where:
 *   model_prob        = model_pct / 100
 *   executable_price  = ask_cents / 100  (YES buy)  or  (100 − bid_cents) / 100  (NO buy)
 *   fee_ceil(p, n)    = Math.ceil(fee_rate × p × (1−p) × n × 100) / 100  (dollars on a $1 contract)
 *   slippage_buffer   = config.slippage_buffer
 *
 * Only signals with edge_net ≥ min_edge are emitted as live.  All computed
 * signals (including suppressed ones) are written to the signals table so the
 * calibration curve can be built across all market conditions.
 *
 * Suppression reasons:
 *   - 'staleness'       — any input ts_utc older than max_age_min
 *   - 'book_incoherent' — station failed sum-of-asks invariant check
 *   - 'lock_dead'       — bracket is mathematically eliminated
 *   - 'gap_data'        — snapshot follows a collector gap
 *   - 'no_price'        — no YES bid/ask in book (KDFW or stub)
 *   - 'below_threshold' — edge_net < min_edge (computed but not actionable)
 */

import { createHash } from "node:crypto";
import { getLatestSignalInputs, insertSignal, type SignalRow, type SnapshotSignalInput } from "./db.js";
import type { RiskConfig } from "./config.js";
import type { SignalCandidate } from "./riskOfficer.js";
import pino from "pino";

const logger = pino({ name: "signal-engine" });

// ─── Fee calculation ──────────────────────────────────────────────────────────

/**
 * Kalshi fee for one contract at price p (0–1 scale).
 *
 * Formula: ceil(fee_rate × p × (1−p) × 1 contract × 100) / 100
 * Returns the fee in dollars (same scale as model_prob / executable_price).
 *
 * ⚑ fee_rate is read from config/risk.json.  Verify against kalshi.com/trading/fees.
 */
function feeCeil(price01: number, feeRate: number): number {
  return Math.ceil(feeRate * price01 * (1 - price01) * 100) / 100;
}

// ─── Input hash ──────────────────────────────────────────────────────────────

function buildInputsHash(row: SnapshotSignalInput, side: "YES" | "NO"): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ts:         row.ts_utc,
        station:    row.station_id,
        ticker:     row.ticker,
        modelPct:   row.model_pct,
        bidCents:   row.bid_cents,
        askCents:   row.ask_cents,
        side,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

// ─── Core signal computation ──────────────────────────────────────────────────

interface EmittedSignal {
  row: SignalRow;
  candidate: SignalCandidate | null;  // null if suppressed
  signalId: number;
}

/**
 * Run one full signal-engine cycle:
 * 1. Read latest snapshot+book inputs from DB.
 * 2. For each live bracket, compute YES and NO signal edges.
 * 3. Write ALL signals to DB (suppressed_reason = null for live signals).
 * 4. Return live (non-suppressed) signal candidates for the risk officer.
 */
export async function runSignalEngine(
  config: RiskConfig,
  now: Date
): Promise<Array<{ candidate: SignalCandidate; signalId: number }>> {
  const inputs = await getLatestSignalInputs();

  if (inputs.length === 0) {
    logger.debug("No snapshot inputs available — skipping signal cycle");
    return [];
  }

  const nowMs = now.getTime();
  const maxAgeMs = config.max_age_min * 60_000;

  // Group by station to check coherence across all brackets
  const byStation = new Map<string, SnapshotSignalInput[]>();
  for (const row of inputs) {
    const list = byStation.get(row.station_id) ?? [];
    list.push(row);
    byStation.set(row.station_id, list);
  }

  const live: Array<{ candidate: SignalCandidate; signalId: number }> = [];

  for (const [stationId, rows] of byStation.entries()) {
    // Station-level staleness check (snapshot ts_utc)
    const snapshotAgeMs = nowMs - new Date(rows[0]!.ts_utc).getTime();
    const stale = snapshotAgeMs > maxAgeMs;

    if (stale) {
      logger.warn(
        { stationId, ageMin: Math.round(snapshotAgeMs / 60_000) },
        "Snapshot stale — suppressing station signals"
      );
    }

    for (const row of rows) {
      // Per-bracket suppression checks
      const suppressed = (() => {
        if (row.gap_flag)       return "gap_data";
        if (!row.coherent_flag) return "book_incoherent";
        if (row.lock_status === "dead") return "lock_dead";
        if (stale)              return "staleness";
        if (!row.ask_cents || !row.bid_cents) return "no_price";
        // obs_age_s staleness (if available)
        if (row.obs_age_s !== null && row.obs_age_s > config.max_age_min * 60) {
          return "staleness";
        }
        return null;
      })();

      const modelProb = row.model_pct / 100;

      // ── YES side ────────────────────────────────────────────────────────────
      {
        const execPrice = (row.ask_cents ?? 0) / 100;
        const fee       = feeCeil(execPrice, config.fee_rate);
        const edgeNet   = modelProb - execPrice - fee - config.slippage_buffer;
        const impliedProb = execPrice;

        const signalReason =
          suppressed ?? (edgeNet < config.min_edge ? "below_threshold" : null);

        const signalRow: SignalRow = {
          ts_utc:           now.toISOString(),
          station_id:       stationId,
          ticker:           row.ticker,
          side:             "YES",
          limit_price:      row.ask_cents ?? 0,
          model_prob:       modelProb,
          implied_prob:     impliedProb,
          edge_net:         edgeNet,
          inputs_hash:      buildInputsHash(row, "YES"),
          suppressed_reason: signalReason,
        };

        const signalId = await insertSignal(signalRow);

        if (!signalReason) {
          live.push({
            signalId,
            candidate: {
              ticker:      row.ticker,
              station_id:  stationId,
              side:        "YES",
              limit_price: row.ask_cents!,
              edge_net:    edgeNet,
              ts:          now,
            },
          });
        }
      }

      // ── NO side ─────────────────────────────────────────────────────────────
      // Only emit NO signals when YES bid is available (to price the NO ask)
      if (row.bid_cents !== null) {
        const noAskCents = 100 - row.bid_cents;  // NO ask = 100 − YES bid
        const execPriceNo = noAskCents / 100;
        const fee         = feeCeil(execPriceNo, config.fee_rate);
        const edgeNetNo   = (1 - modelProb) - execPriceNo - fee - config.slippage_buffer;
        const impliedProbNo = execPriceNo;

        const signalReasonNo =
          suppressed ?? (edgeNetNo < config.min_edge ? "below_threshold" : null);

        const signalRowNo: SignalRow = {
          ts_utc:           now.toISOString(),
          station_id:       stationId,
          ticker:           row.ticker,
          side:             "NO",
          limit_price:      noAskCents,
          model_prob:       1 - modelProb,
          implied_prob:     impliedProbNo,
          edge_net:         edgeNetNo,
          inputs_hash:      buildInputsHash(row, "NO"),
          suppressed_reason: signalReasonNo,
        };

        const signalIdNo = await insertSignal(signalRowNo);

        if (!signalReasonNo) {
          live.push({
            signalId:  signalIdNo,
            candidate: {
              ticker:      row.ticker,
              station_id:  stationId,
              side:        "NO",
              limit_price: noAskCents,
              edge_net:    edgeNetNo,
              ts:          now,
            },
          });
        }
      }
    }
  }

  if (live.length > 0) {
    logger.info({ count: live.length }, "Live signals emitted");
  }

  return live;
}
