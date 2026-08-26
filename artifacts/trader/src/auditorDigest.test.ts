/**
 * Daily P&L digest unit tests.
 *
 * Run with: node --import tsx/esm --test src/auditorDigest.test.ts
 *
 * computeDailyPnl is the pure core of runDailyDigest's settlement matching:
 * every filled order for a placement-date digest run is settled against
 * `${station_id}::${its own true settlement date}` in the settlements table
 * — ticker-derived for legacy KXRAIN- rows (rain trading itself is rolled
 * back, but a handful of pre-rollback fills remain and must keep reconciling
 * correctly), otherwise the digest's placement-date bucket. An order whose
 * key isn't present yet is excluded from totals (not scored as a loss) and
 * counted as pending so a later re-run can pick it up once it settles.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDailyPnl, rainTickerSettlementDate } from "./auditor.js";
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

describe("computeDailyPnl — pending settlement is never scored as a loss", () => {
  it("excludes an unsettled order from totals instead of paying out 0", () => {
    const filled = [order({})];
    // No settlement row for KNYC on this date — contract hasn't resolved yet.
    const settledByKey = new Map<string, string | null>();

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 0, "pending order must not be counted as a completed trade");
    assert.equal(result.pendingCount, 1);
    assert.equal(result.grossCents, 0);
    assert.equal(result.feesCents, 0);
  });

  it("scores the order once its settlement is present", () => {
    const filled = [order({})];
    const settledByKey = new Map<string, string | null>([
      ["KNYC::2026-08-26", "KXHIGHNY-26AUG26-B82.5"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 1);
    assert.equal(result.pendingCount, 0);
    // YES buy wins (settled bracket === own ticker) -> payout 100c, fillCents 40c -> gross 60c.
    assert.equal(result.grossCents, 60);
  });
});

describe("computeDailyPnl — multiple stations on the same digest date", () => {
  it("settles each station independently against its own key", () => {
    const filled: FilledOrderForPnl[] = [
      order({ ticker: "KXHIGHNY-26AUG26-B82.5", side: "YES", station_id: "KNYC", price_cents: 30, fill_price_cents: 30 }),
      order({ ticker: "KXHIGHCHI-26AUG26-B75.5", side: "NO", station_id: "KMDW", price_cents: 35, fill_price_cents: 35 }),
    ];
    const settledByKey = new Map<string, string | null>([
      ["KNYC::2026-08-26", "KXHIGHNY-26AUG26-B82.5"],
      // KMDW still unsettled.
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    // Only the NYC order should be counted; the CHI one stays pending.
    assert.equal(result.tradeCount, 1);
    assert.equal(result.pendingCount, 1);
    // YES buy wins (settled bracket === own ticker) -> payout 100c, fillCents 30c -> gross 70c.
    assert.equal(result.grossCents, 70);
  });

  it("scores both stations correctly once both have settled", () => {
    const filled: FilledOrderForPnl[] = [
      order({ ticker: "KXHIGHNY-26AUG26-B82.5", side: "YES", station_id: "KNYC", price_cents: 30, fill_price_cents: 30 }),
      order({ ticker: "KXHIGHCHI-26AUG26-B75.5", side: "NO", station_id: "KMDW", price_cents: 35, fill_price_cents: 35 }),
    ];
    const settledByKey = new Map<string, string | null>([
      ["KNYC::2026-08-26", "KXHIGHNY-26AUG26-B82.5"],
      ["KMDW::2026-08-26", "KXHIGHCHI-26AUG26-B75.5"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 2);
    assert.equal(result.pendingCount, 0);
    // NYC YES win: payout 100 - 30 = 70. CHI NO loses (settled === own ticker -> NO loses): payout 0 - 35 = -35.
    assert.equal(result.grossCents, 70 + -35);
  });
});

describe("computeDailyPnl — non-temperature orders are unaffected (sports keyed the same way)", () => {
  it("settles a sports order against the fallback (placement) date", () => {
    const filled = [order({ ticker: "KXMLBKS-26AUG26-DEGROM5", side: "YES", station_id: "SPORTS_DEGROM", price_cents: 40, fill_price_cents: 40 })];
    const settledByKey = new Map<string, string | null>([
      ["SPORTS_DEGROM::2026-08-26", "KXMLBKS-26AUG26-DEGROM5"],
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 1);
    assert.equal(result.grossCents, 60); // YES win: 100 - 40
  });
});

describe("rainTickerSettlementDate — legacy rain fills", () => {
  it("extracts the contract's true local date from the ticker", () => {
    assert.equal(rainTickerSettlementDate("KXRAIN-26AUG25-MIA"), "2026-08-25");
    assert.equal(rainTickerSettlementDate("KXRAIN-26AUG26-NOLA"), "2026-08-26");
  });

  it("returns null for non-rain tickers", () => {
    assert.equal(rainTickerSettlementDate("KXHIGHNY-26AUG26-B82.5"), null);
    assert.equal(rainTickerSettlementDate("KXMLBKS-26AUG26-DEGROM5"), null);
  });
});

describe("computeDailyPnl — legacy rain fill placed on a different UTC date than its contract settles", () => {
  it("is excluded from this digest's totals when only the placement-date bucket has settled", () => {
    // Rain trading is rolled back, but a fill like this — placed 08/26 UTC
    // for a contract whose ticker date is 08/25 — is real pre-rollback
    // history. Only a same-day (fallback-keyed) settlement exists here, so
    // the order must stay pending rather than being silently dropped or
    // scored against the wrong day.
    const filled = [order({
      ticker: "KXRAIN-26AUG25-MIA",
      side: "NO",
      station_id: "RAIN_MIA",
      price_cents: 20,
      fill_price_cents: 20,
    })];
    const settledByKey = new Map<string, string | null>([
      ["RAIN_MIA::2026-08-26", "some-other-bracket"], // wrong-date bucket only
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 0);
    assert.equal(result.pendingCount, 1, "must key off the ticker's true date, not the placement date");
  });

  it("settles correctly once its true ticker-derived date has a settlement row", () => {
    const filled = [order({
      ticker: "KXRAIN-26AUG25-MIA",
      side: "NO",
      station_id: "RAIN_MIA",
      price_cents: 20,
      fill_price_cents: 20,
    })];
    const settledByKey = new Map<string, string | null>([
      ["RAIN_MIA::2026-08-25", "KXRAIN-26AUG25-MIA:NO"], // correct ticker-derived date, NO won
    ]);

    const result = computeDailyPnl(filled, settledByKey, "2026-08-26", FEE_RATE);

    assert.equal(result.tradeCount, 1);
    assert.equal(result.pendingCount, 0);
    // NO buy wins (settled bracket !== own ticker) -> payout 100c, fillCents 20c -> gross 80c.
    assert.equal(result.grossCents, 80);
  });
});
