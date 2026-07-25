/**
 * Config loader.
 *
 * Reads config/risk.json relative to the trader package root.
 * Values can be overridden by environment variables:
 *
 *   TRADING_MODE=live  — switches from shadow to live mode
 *
 * Crashes fast with a clear message if required keys are missing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RiskConfig {
  mode: "shadow" | "live";

  // Per-trade limits
  max_cost_per_trade_cents:             number;
  cooldown_min:                         number;

  // Per-station daily limits
  max_open_orders_per_station:          number;
  max_daily_exposure_per_station_cents: number;

  // Portfolio-level limits
  max_total_open_exposure_cents:        number;
  max_daily_loss_cents:                 number;

  // Signal engine
  min_edge:        number;
  slippage_buffer: number;
  max_age_min:     number;
  fee_rate:        number;

  // Order lifecycle
  ttl_min:     number;
  cancel_edge: number;
}

function loadConfig(): RiskConfig {
  const configPath = resolve(__dirname, "../config/risk.json");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load risk.json from ${configPath}: ${String(err)}`);
  }

  const required: Array<keyof RiskConfig> = [
    "mode",
    "max_cost_per_trade_cents",
    "cooldown_min",
    "max_open_orders_per_station",
    "max_daily_exposure_per_station_cents",
    "max_total_open_exposure_cents",
    "max_daily_loss_cents",
    "min_edge",
    "slippage_buffer",
    "max_age_min",
    "fee_rate",
    "ttl_min",
    "cancel_edge",
  ];

  for (const key of required) {
    if (raw[key] === undefined) {
      throw new Error(`risk.json missing required key: "${key}"`);
    }
  }

  const config = raw as unknown as RiskConfig;

  // Env override for mode (credentials never go in the config file)
  const envMode = process.env["TRADING_MODE"];
  if (envMode === "live" || envMode === "shadow") {
    config.mode = envMode;
  }

  if (config.mode === "live") {
    if (!process.env["KALSHI_KEY_ID"] || !process.env["KALSHI_PRIVATE_KEY"]) {
      throw new Error(
        "TRADING_MODE=live requires KALSHI_KEY_ID and KALSHI_PRIVATE_KEY env vars"
      );
    }
  }

  return config;
}

export const config = loadConfig();
