/**
 * Rain market safety unit tests.
 *
 * Run with: node --import tsx/esm --test src/rainEligibility.test.ts
 *
 * Covers the fail-closed contract-eligibility gate (checkRainEligibility)
 * and the ticker-derived settlement-date parser (rainTickerSettlementDate)
 * that the auditor/dashboard/approvals queries rely on to join settlements
 * on a rain contract's true local date instead of its UTC placement date.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRainEligibility } from "./rainSignalEngine.js";
import { rainTickerSettlementDate } from "./auditor.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NYC = { name: "New York City", lat: 40.7831, lon: -73.9712, timeZone: "America/New_York" };

const BASE_MARKET = {
  ticker: "KXRAIN-26AUG26-NYC",
  cityCode: "NYC",
  status: "active",
  eventTicker: "KXRAIN-26AUG26",
  rawTitle: "Will it rain in NYC on Aug 26?" as string | null,
  rawSubtitle: "New York City" as string | null,
  rawRules: "Settles YES if measurable precipitation (rain) is recorded at the official station." as string | null,
};

// Fixed "now" so today/tomorrow/yesterday are deterministic relative to the fixture date.
const NOW = new Date("2026-08-26T15:00:00Z"); // ~10am NYC local — Aug 26 is "today"

// ─── checkRainEligibility ───────────────────────────────────────────────────────

describe("checkRainEligibility", () => {
  it("accepts a well-formed, active, in-range, precipitation-worded contract", () => {
    const result = checkRainEligibility(BASE_MARKET, "2026-08-26", NYC, NOW);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, null);
  });

  it("accepts a contract dated tomorrow (city-local)", () => {
    const result = checkRainEligibility(BASE_MARKET, "2026-08-27", NYC, NOW);
    assert.equal(result.eligible, true);
  });

  it("rejects a malformed ticker", () => {
    const result = checkRainEligibility(
      { ...BASE_MARKET, ticker: "KXRAIN-BADTICKER" },
      "2026-08-26",
      NYC,
      NOW
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "ticker_format_invalid");
  });

  it("rejects when the event ticker isn't a KXRAIN series", () => {
    const result = checkRainEligibility(
      { ...BASE_MARKET, eventTicker: "KXHIGH-26AUG26" },
      "2026-08-26",
      NYC,
      NOW
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "series_mismatch");
  });

  it("rejects an unknown city (undefined city lookup)", () => {
    const result = checkRainEligibility(BASE_MARKET, "2026-08-26", undefined, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "unknown_city");
  });

  it("rejects a market that isn't active", () => {
    const result = checkRainEligibility(
      { ...BASE_MARKET, status: "closed" },
      "2026-08-26",
      NYC,
      NOW
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "market_inactive");
  });

  it("rejects an unparseable contract date", () => {
    const result = checkRainEligibility(BASE_MARKET, "not-a-date", NYC, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "contract_date_unparseable");
  });

  it("rejects a contract date in the past (stale)", () => {
    const result = checkRainEligibility(BASE_MARKET, "2026-08-20", NYC, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "contract_date_stale");
  });

  it("rejects a contract date too far in the future", () => {
    const result = checkRainEligibility(BASE_MARKET, "2026-09-15", NYC, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "contract_date_out_of_range");
  });

  it("rejects settlement text mentioning a disallowed non-precipitation term", () => {
    const result = checkRainEligibility(
      { ...BASE_MARKET, rawTitle: "Will NYC set a new snow record?" },
      "2026-08-26",
      NYC,
      NOW
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "settlement_terms_mismatch");
  });

  it("rejects when none of the available text mentions rain/precip", () => {
    const result = checkRainEligibility(
      {
        ...BASE_MARKET,
        rawTitle: "New York City daily contract",
        rawSubtitle: "New York City",
        rawRules: "Settles based on the official daily report for the station.",
      },
      "2026-08-26",
      NYC,
      NOW
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "settlement_terms_unverified");
  });

  it("fails closed — rejects rather than accepts when settlement text is entirely absent", () => {
    const result = checkRainEligibility(
      { ...BASE_MARKET, rawRules: null, rawSubtitle: null, rawTitle: null },
      "2026-08-26",
      NYC,
      NOW
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "settlement_terms_unverified");
  });
});

// ─── rainTickerSettlementDate ───────────────────────────────────────────────────

describe("rainTickerSettlementDate", () => {
  it("derives the local settlement date embedded in a KXRAIN ticker", () => {
    assert.equal(rainTickerSettlementDate("KXRAIN-26AUG26-NYC"), "2026-08-26");
  });

  it("handles single-digit-looking days and different months", () => {
    assert.equal(rainTickerSettlementDate("KXRAIN-26JAN05-CHI"), "2026-01-05");
    assert.equal(rainTickerSettlementDate("KXRAIN-27DEC31-AUS"), "2027-12-31");
  });

  it("returns null for a non-rain ticker", () => {
    assert.equal(rainTickerSettlementDate("KXHIGHNY-26AUG26-B82.5"), null);
  });

  it("returns null for an unparseable month segment", () => {
    assert.equal(rainTickerSettlementDate("KXRAIN-26XXX26-NYC"), null);
  });
});
