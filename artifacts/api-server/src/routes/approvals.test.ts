import { test } from "node:test";
import assert from "node:assert/strict";
import { capRainContractsByLiquidity, type RainDepthState } from "./approvals.js";

// capRainContractsByLiquidity — fail-closed liquidity cap for rain approvals.
// Covers the review finding that a rain approval must never execute at full
// max-cost sizing when the book or the relevant side's depth is unknown.

test("blocks when there is no current book at all (current === null)", () => {
  const result = capRainContractsByLiquidity(null, "YES", 5);
  assert.equal(result, null);
});

test("blocks a YES buy when ask_size is null (unknown depth on our side)", () => {
  const current: RainDepthState = { ask_size: null, bid_size: 10 };
  const result = capRainContractsByLiquidity(current, "YES", 5);
  assert.equal(result, null);
});

test("blocks a NO buy when bid_size is null (unknown depth on our side)", () => {
  const current: RainDepthState = { ask_size: 10, bid_size: null };
  const result = capRainContractsByLiquidity(current, "NO", 5);
  assert.equal(result, null);
});

test("blocks when the relevant side has zero resting depth", () => {
  const current: RainDepthState = { ask_size: 0, bid_size: 10 };
  const result = capRainContractsByLiquidity(current, "YES", 5);
  assert.equal(result, null);
});

test("caps requested contracts down to available depth", () => {
  const current: RainDepthState = { ask_size: 3, bid_size: 10 };
  const result = capRainContractsByLiquidity(current, "YES", 5);
  assert.equal(result, 3);
});

test("does not inflate requested contracts when depth exceeds the request", () => {
  const current: RainDepthState = { ask_size: 50, bid_size: 10 };
  const result = capRainContractsByLiquidity(current, "YES", 5);
  assert.equal(result, 5);
});

test("uses the bid side for a NO buy (NO lifts the yes-bid side)", () => {
  const current: RainDepthState = { ask_size: 1, bid_size: 8 };
  const result = capRainContractsByLiquidity(current, "NO", 5);
  assert.equal(result, 5);
});
