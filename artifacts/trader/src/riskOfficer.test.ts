/**
 * Risk Officer unit tests.
 *
 * Run with: node --experimental-strip-types --test src/riskOfficer.test.ts
 *
 * Tests cover every rejection reason plus the happy-path approval, the
 * duplicate-signal replay case (which must produce exactly one order), and
 * boundary conditions at the configured limits.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRisk } from "./riskOfficer.js";
import type { RiskConfig } from "./config.js";
import type { RiskState } from "./db.js";
import type { SignalCandidate } from "./riskOfficer.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RiskConfig = {
  execution_mode:                          "shadow",
  mode:                                    "shadow",
  max_cost_per_trade_cents:                60,
  cooldown_min:                            30,
  max_open_orders_per_station:             1,
  max_daily_exposure_per_station_cents:    200,
  max_total_open_exposure_cents:           500,
  max_daily_loss_cents:                    300,
  min_edge:                                0.05,
  slippage_buffer:                         0.01,
  max_age_min:                             10,
  max_obs_age_min:                         75,
  fee_rate:                                0.07,
  ttl_min:                                 15,
  cancel_edge:                             0.01,
  proposal_ttl_min:                        30,
};

const CLEAN_STATE: RiskState = {
  openOrdersPerStation:     {},
  dailyExposurePerStation:  {},
  totalOpenExposure:        0,
  dailyCostToday:           0,
  recentSignals:            [],
  killSwitchActive:         false,
};

const SIGNAL: SignalCandidate = {
  ticker:      "KXHIGHNY-26JUL25-B82",
  station_id:  "KNYC",
  side:        "YES",
  limit_price: 40,  // cents
  edge_net:    0.08,
  ts:          new Date("2026-07-25T10:00:00Z"),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("checkRisk — approval", () => {
  it("approves a clean signal with clean state", () => {
    const decision = checkRisk(SIGNAL, CLEAN_STATE, DEFAULT_CONFIG);
    assert.equal(decision.approved, true);
    assert.equal(decision.reason, "approved");
  });
});

describe("checkRisk — kill switch", () => {
  it("rejects when kill switch is active", () => {
    const state: RiskState = { ...CLEAN_STATE, killSwitchActive: true };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /kill_switch/);
  });
});

describe("checkRisk — max_daily_loss", () => {
  it("rejects when daily cost exactly equals limit", () => {
    const state: RiskState = { ...CLEAN_STATE, dailyCostToday: 300 };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /max_daily_loss/);
  });

  it("approves when the incoming order brings daily cost exactly to the limit", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      dailyCostToday: DEFAULT_CONFIG.max_daily_loss_cents - SIGNAL.limit_price,
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });
});

describe("checkRisk — max_cost_per_trade", () => {
  it("rejects a signal priced above the per-trade limit", () => {
    const sig: SignalCandidate = { ...SIGNAL, limit_price: 61 };
    const d = checkRisk(sig, CLEAN_STATE, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /max_cost_per_trade/);
  });

  it("approves at exactly the limit", () => {
    const sig: SignalCandidate = { ...SIGNAL, limit_price: 60 };
    const d = checkRisk(sig, CLEAN_STATE, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });
});

describe("checkRisk — max_open_orders_per_station", () => {
  it("rejects when station already has max open orders", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      openOrdersPerStation: { KNYC: 1 },
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /max_open_orders_per_station/);
  });

  it("approves when a different station is at max", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      openOrdersPerStation: { KMDW: 1 },
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });
});

describe("checkRisk — max_daily_exposure_per_station", () => {
  it("rejects when adding this order would exceed the station daily limit", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      dailyExposurePerStation: { KNYC: 180 },  // 180 + 40 = 220 > 200
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /max_daily_exposure_per_station/);
  });

  it("approves when station sum is exactly at limit after this order", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      dailyExposurePerStation: { KNYC: 160 }, // 160 + 40 = 200 = limit
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });
});

describe("checkRisk — max_total_open_exposure", () => {
  it("rejects when adding this order exceeds total open limit", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      totalOpenExposure: 480,  // 480 + 40 = 520 > 500
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /max_total_open_exposure/);
  });
});

describe("checkRisk — duplicate guard", () => {
  it("rejects same ticker+side within cooldown window", () => {
    const recent = new Date(SIGNAL.ts.getTime() - 20 * 60_000); // 20 min ago
    const state: RiskState = {
      ...CLEAN_STATE,
      recentSignals: [{ ticker: SIGNAL.ticker, side: "YES", ts: recent }],
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, false);
    assert.match(d.reason, /duplicate_within_cooldown/);
  });

  it("allows same ticker+side after cooldown has expired", () => {
    const old = new Date(SIGNAL.ts.getTime() - 31 * 60_000); // 31 min ago
    const state: RiskState = {
      ...CLEAN_STATE,
      recentSignals: [{ ticker: SIGNAL.ticker, side: "YES", ts: old }],
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });

  it("allows same ticker with different side within cooldown", () => {
    const recent = new Date(SIGNAL.ts.getTime() - 20 * 60_000);
    const state: RiskState = {
      ...CLEAN_STATE,
      recentSignals: [{ ticker: SIGNAL.ticker, side: "NO", ts: recent }],
    };
    const d = checkRisk(SIGNAL, state, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });

  it("duplicate replay: two identical signals produce only one approved order", () => {
    // First signal: approved (clean state).
    const d1 = checkRisk(SIGNAL, CLEAN_STATE, DEFAULT_CONFIG);
    assert.equal(d1.approved, true);

    // Simulate state after first order placed.
    const stateAfterFirst: RiskState = {
      ...CLEAN_STATE,
      openOrdersPerStation:    { KNYC: 1 },
      dailyExposurePerStation: { KNYC: 40 },
      totalOpenExposure:       40,
      recentSignals:           [{ ticker: SIGNAL.ticker, side: "YES", ts: SIGNAL.ts }],
    };

    // Second identical signal 5 minutes later: must be rejected.
    const sig2: SignalCandidate = {
      ...SIGNAL,
      ts: new Date(SIGNAL.ts.getTime() + 5 * 60_000),
    };
    const d2 = checkRisk(sig2, stateAfterFirst, DEFAULT_CONFIG);
    assert.equal(d2.approved, false);
    assert.match(d2.reason, /max_open_orders_per_station|duplicate_within_cooldown/);
  });
});

describe("checkRisk — incoherent book does not suppress other stations", () => {
  it("a signal from KMDW is approved even when KNYC is at max open orders", () => {
    const state: RiskState = {
      ...CLEAN_STATE,
      openOrdersPerStation: { KNYC: 1 },
    };
    const sig: SignalCandidate = { ...SIGNAL, station_id: "KMDW", ticker: "KXHIGHCHI-26JUL25-B78" };
    const d = checkRisk(sig, state, DEFAULT_CONFIG);
    assert.equal(d.approved, true);
  });
});
