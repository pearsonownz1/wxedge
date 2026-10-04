import { test } from "node:test";
import assert from "node:assert/strict";
import { KalshiOrderPlacementError, readConfirmedRejectedSubmissions } from "./kalshiOrderErrors.js";

const body = '{"error":{"code":"insufficient_balance","message":"insufficient balance"}}';
const evidence = {
  orderId: 1, approvalId: 2, ticker: "KXHIGHAUS-26OCT04-B82.5",
  side: "YES", priceCents: 11, contracts: 10,
  tsPlaced: "2026-10-04T06:06:15.498Z", httpStatus: 400, responseBody: body,
};

test("explicit HTTP 400 insufficient_balance is a confirmed rejection, with original message preserved", () => {
  const error = new KalshiOrderPlacementError(400, body);
  assert.equal(error.isConfirmedRejection, true);
  assert.equal(error.code, "insufficient_balance");
  assert.equal(error.message, `Kalshi order placement failed: HTTP 400 — ${body}`);
});

test("unknown codes, HTTP 5xx, malformed bodies and rate limits remain ambiguous", () => {
  for (const [status, response] of [
    [500, body], [429, body], [408, body], [400, "not JSON"],
    [400, '{"error":{"code":"unknown"}}'], [400, '{"error":{"code":123}}'],
  ] as const) {
    assert.equal(new KalshiOrderPlacementError(status, response).isConfirmedRejection, false);
  }
});

test("no operator recovery configuration does not clear any intent", () => {
  assert.deepEqual(readConfirmedRejectedSubmissions(undefined), []);
});

test("recovery requires exact identity and explicit rejection evidence", () => {
  assert.deepEqual(readConfirmedRejectedSubmissions(JSON.stringify([evidence])), [evidence]);
  for (const invalid of [
    { ...evidence, httpStatus: 500 }, { ...evidence, responseBody: "timeout" },
    { ...evidence, orderId: -1 }, { ...evidence, approvalId: undefined },
    { ...evidence, tsPlaced: "invalid" }, { ...evidence, side: "BID" },
    { ...evidence, contracts: 0 }, { ...evidence, priceCents: 100 },
  ]) {
    assert.throws(() => readConfirmedRejectedSubmissions(JSON.stringify([invalid])));
  }
  assert.throws(() => readConfirmedRejectedSubmissions("{}"));
  assert.throws(() => readConfirmedRejectedSubmissions(JSON.stringify([null])));
});