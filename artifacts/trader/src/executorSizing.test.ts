import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configuredContractCount } from "./executor.js";
import type { RiskConfig } from "./config.js";

const CONFIG: RiskConfig = {
  execution_mode: "approval",
  mode: "live",
  active_station_ids: ["KNYC", "KLAX"],
  contracts_per_trade: 10,
  max_cost_per_trade_cents: 1000,
  cooldown_min: 10,
  max_open_orders_per_station: 5,
  max_daily_exposure_per_station_cents: 5000,
  max_total_open_exposure_cents: 10000,
  max_daily_loss_cents: 10000,
  min_edge: 0.02,
  slippage_buffer: 0.01,
  max_age_min: 10,
  max_obs_age_min: 75,
  fee_rate: 0.07,
  ttl_min: 15,
  cancel_edge: 0.01,
  proposal_ttl_min: 30,
};

describe("configuredContractCount", () => {
  it("uses the explicit 10-contract target rather than deriving size from price", () => {
    assert.equal(configuredContractCount(CONFIG), 10);
  });
});