import { test } from "node:test";
import assert from "node:assert/strict";
import { bookPriceSums, isBookCoherent, isStationTradingDate, stationTradingDate } from "./weatherMarketGuards.js";

test("empty 100-cent ask preserves coherence without becoming an executable quote", () => {
  const brackets = [
    { bidCents: 99, askCents: null },
    ...Array.from({ length: 5 }, () => ({ bidCents: null, askCents: 1 })),
  ];
  assert.deepEqual(bookPriceSums(brackets), { sumAsk: 105, sumBid: 99 });
  assert.equal(isBookCoherent(brackets), true);
  assert.equal(brackets[0]!.askCents, null);
});

test("incoherent, wide, empty and bid-arbitrage books remain blocked", () => {
  assert.equal(isBookCoherent([]), false);
  assert.equal(isBookCoherent([{ bidCents: null, askCents: null }]), false);
  assert.equal(isBookCoherent([{ bidCents: 30, askCents: 40 }, { bidCents: 30, askCents: 40 }]), false);
  assert.equal(isBookCoherent([{ bidCents: 40, askCents: 60 }, { bidCents: 40, askCents: 60 }]), false);
  assert.equal(isBookCoherent([{ bidCents: 53, askCents: 55 }, { bidCents: 53, askCents: 55 }]), false);
  assert.equal(isBookCoherent([{ bidCents: 45, askCents: 50 }, { bidCents: 45, askCents: 50 }]), true);
});

test("NYC and LA markets switch on their own standard-time day, not UTC or API ordering", () => {
  const oct5 = new Date("2026-10-05T00:00:00Z");
  const oct6 = new Date("2026-10-06T00:00:00Z");
  const evening = new Date("2026-10-06T03:30:00Z");
  assert.equal(isStationTradingDate(oct5, evening, -5), true);
  assert.equal(isStationTradingDate(oct6, evening, -5), false);
  assert.equal(isStationTradingDate(oct5, evening, -8), true);
  const nyMidnight = new Date("2026-10-06T05:00:00Z");
  assert.equal(isStationTradingDate(oct5, nyMidnight, -5), false);
  assert.equal(isStationTradingDate(oct6, nyMidnight, -5), true);
  assert.equal(stationTradingDate(evening, -5), "2026-10-05");
  assert.equal(stationTradingDate(nyMidnight, -5), "2026-10-06");
  assert.equal(stationTradingDate(nyMidnight, -8), "2026-10-05");
  assert.equal(isStationTradingDate(oct6, nyMidnight, -8), false);
  assert.equal(isStationTradingDate(oct6, new Date("2026-10-06T08:00:00Z"), -8), true);
  assert.equal(isStationTradingDate(null, evening, -5), false);
});
