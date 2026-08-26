/**
 * Daily P&L digest unit tests.
 *
 * Run with: node --import tsx/esm --test src/auditorDigest.test.ts
 *
 * computeDailyPnl is the pure core of runDailyDigest's settlement matching.
 * These tests target the specific rain failure modes fixed here: a rain
 * contract that hasn't settled by digest time must not be scored as a loss,
 * and two contracts for the same station on adjacent local dates (a
 * same-day "today" contract and a next-day "tomorrow" contract, both filled
 * on the same UTC placement date) must not clobber each other's settlement.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDailyPnl } from "./auditor.js";
import type { FilledOrderForPnl } from "./auditor.js";

const FEE_RATE = 0.07;

function order(overrides: Partial<FilledOrderForPnl>): FilledOrderForPnl {
  return {
    ticker: "KXHIGHNY-26AUG26-B82.5",
    side: "YES",
    price_cents: 40,
    fill_price_cents: 40,
    count: 1,
    station_id: "KNYC",
    ...overrides,
  };
}

describe("computeDailyPnl — pending rain settlement is never scored as a loss", () => {
  it("excludes an unsettled rain order from totals instead of paying out 0", () => {
    const filled = [
      order({ ticker: "KXRAIN-26AUG26-NYC", side: "NO", station_id: "RAIN_NYC", price_cents: 43, fill_price_cents: 43 }),
    ];
    // No settlement row for RAIN_NYC on any date — contract hasn't resolved yet.
    const settledByKey = new Map<string, string | null>();

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 0, "pending order must not be counted as a completed trade");
    assert.equal(result.pendingCount, 1);
    assert.equal(result.grossCents, 0);
    assert.equal(result.feesCents, 0);
  });

  it("scores the order once its settlement is present", () => {
    const filled = [
      order({ ticker: "KXRAIN-26AUG26-NYC", side: "NO", station_id: "RAIN_NYC", price_cents: 43, fill_price_cents: 43 }),
    ];
    // Settles NO (kalshi_settled_bracket is the sentinel form for a NO market result).
    const settledByKey = new Map<string, string | null>([
      ["RAIN_NYC::2026-08-26", "KXRAIN-26AUG26-NYC:NO"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 1);
    assert.equal(result.pendingCount, 0);
    // NO buy wins when settled bracket !== own ticker -> payout 100c, fillCents 43c -> gross 57c.
    assert.equal(result.grossCents, 57);
  });
});

describe("computeDailyPnl — adjacent-date rain contracts for the same station", () => {
  it("does not let a tomorrow-contract settlement clobber a today-contract's result", () => {
    const filled: FilledOrderForPnl[] = [
      order({ ticker: "KXRAIN-26AUG26-NYC", side: "YES", station_id: "RAIN_NYC", price_cents: 30, fill_price_cents: 30 }),
      order({ ticker: "KXRAIN-26AUG27-NYC", side: "YES", station_id: "RAIN_NYC", price_cents: 35, fill_price_cents: 35 }),
    ];
    // Today's (Aug 26) contract settled YES; tomorrow's (Aug 27) contract is
    // still unsettled — both were filled on the same UTC placement date.
    const settledByKey = new Map<string, string | null>([
      ["RAIN_NYC::2026-08-26", "KXRAIN-26AUG26-NYC"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    // Only the Aug-26 contract should be counted; the Aug-27 one stays pending.
    assert.equal(result.tradeCount, 1);
    assert.equal(result.pendingCount, 1);
    // YES buy wins (settled bracket === own ticker) -> payout 100c, fillCents 30c -> gross 70c.
    assert.equal(result.grossCents, 70);
  });

  it("scores both adjacent-date contracts correctly once both have settled", () => {
    const filled: FilledOrderForPnl[] = [
      order({ ticker: "KXRAIN-26AUG26-NYC", side: "YES", station_id: "RAIN_NYC", price_cents: 30, fill_price_cents: 30 }),
      order({ ticker: "KXRAIN-26AUG27-NYC", side: "YES", station_id: "RAIN_NYC", price_cents: 35, fill_price_cents: 35 }),
    ];
    // Today's contract settled YES; tomorrow's settled NO (no rain) — a
    // buggy station-only key would let this second write stomp the first.
    const settledByKey = new Map<string, string | null>([
      ["RAIN_NYC::2026-08-26", "KXRAIN-26AUG26-NYC"],
      ["RAIN_NYC::2026-08-27", "KXRAIN-26AUG27-NYC:NO"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 2);
    assert.equal(result.pendingCount, 0);
    // Aug-26 YES win: payout 100 - 30 = 70. Aug-27 YES loses (settled !== own ticker): payout 0 - 35 = -35.
    assert.equal(result.grossCents, 70 + -35);
  });
});

describe("computeDailyPnl — a rain fill whose true settlement date precedes its placement date", () => {
  it("matches the order against its ticker-derived date, not the placement-date bucket", () => {
    // A contract for "yesterday" (relative to the digest's placement-date
    // bucket) that was filled late — its own settlement date is in the past
    // relative to `fallbackDate`, and must still be looked up correctly.
    const filled: FilledOrderForPnl[] = [
      order({ ticker: "KXRAIN-26AUG25-NYC", side: "YES", station_id: "RAIN_NYC", price_cents: 50, fill_price_cents: 50 }),
    ];
    const settledByKey = new Map<string, string | null>([
      ["RAIN_NYC::2026-08-25", "KXRAIN-26AUG25-NYC"],
    ]);

    // Placement-date bucket is Aug 26, but the ticker's own date (Aug 25) is used for the lookup.
    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 1);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.grossCents, 50); // YES win: 100 - 50
  });
});

describe("computeDailyPnl — non-rain orders are unaffected (keyed by the digest's own date)", () => {
  it("settles a temperature bracket order against the fallback (placement) date", () => {
    const filled = [order({ ticker: "KXHIGHNY-26AUG26-B82.5", side: "YES", station_id: "KNYC", price_cents: 40, fill_price_cents: 40 })];
    const settledByKey = new Map<string, string | null>([
      ["KNYC::2026-08-26", "KXHIGHNY-26AUG26-B82.5"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 1);
    assert.equal(result.grossCents, 60); // YES win: 100 - 40
  });
});
