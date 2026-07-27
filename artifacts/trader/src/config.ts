/**
 * Config loader.
 *
 * Reads config/risk.json relative to the trader package root.
 * Values can be overridden by environment variables:
 *
 *   TRADING_MODE=live          — switches from shadow to live mode
 *   EXECUTION_MODE=approval    — approval | auto | shadow
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RiskConfig {
  /** Execution flow: 'approval' (human-in-loop) | 'auto' (shadow) | 'shadow' */
  execution_mode: "approval" | "auto" | "shadow";
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
  /** Max SNAPSHOT age (collector cadence is ~4 min). */
  max_age_min:     number;
  /** Max METAR OBSERVATION age — METARs are ~hourly, so this is a separate, looser bound. */
  max_obs_age_min: number;
  fee_rate:        number;

  // Order lifecycle
  ttl_min:     number;
  cancel_edge: number;

  /** Minutes a proposal is valid before auto-expiring. */
  proposal_ttl_min: number;

  // ── LLM approver knobs (all optional; ignored when approver = 'human') ──────
  /** Who decides proposals: 'human' | 'llm' | 'llm_with_veto'. Default: 'human'. */
  approver?: "human" | "llm" | "llm_with_veto";
  /** Proposal must be this many seconds old before the LLM will decide it. Default: 60. */
  llm_min_age_s?: number;
  /** In llm_with_veto mode: executor waits this many seconds for human override. Default: 180. */
  llm_veto_window_s?: number;
  /** Max LLM-approved spend today (cents). Defaults to max_daily_loss_cents. */
  llm_daily_cap_cents?: number;
  /** OpenAI model for approval decisions. Default: 'gpt-5.6-luna'. */
  llm_model?: string;
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
    "execution_mode",
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
    "max_obs_age_min",
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

  // Default proposal_ttl_min if absent in older configs
  if (config.proposal_ttl_min === undefined) {
    config.proposal_ttl_min = 30;
  }

  // Env overrides
  const envExec = process.env["EXECUTION_MODE"];
  if (envExec === "approval" || envExec === "auto" || envExec === "shadow") {
    config.execution_mode = envExec;
  }

  const envMode = process.env["TRADING_MODE"];
  if (envMode === "live" || envMode === "shadow") {
    config.mode = envMode;
  }

  // LLM approver env overrides
  const envApprover = process.env["APPROVER"];
  if (envApprover === "human" || envApprover === "llm" || envApprover === "llm_with_veto") {
    config.approver = envApprover;
  }
  if (!config.approver) config.approver = "human";

  if (process.env["LLM_MIN_AGE_S"])       config.llm_min_age_s       = parseInt(process.env["LLM_MIN_AGE_S"]!, 10);
  if (process.env["LLM_VETO_WINDOW_S"])   config.llm_veto_window_s   = parseInt(process.env["LLM_VETO_WINDOW_S"]!, 10);
  if (process.env["LLM_DAILY_CAP_CENTS"]) config.llm_daily_cap_cents = parseInt(process.env["LLM_DAILY_CAP_CENTS"]!, 10);
  if (process.env["LLM_MODEL"])           config.llm_model           = process.env["LLM_MODEL"]!;

  if (config.llm_min_age_s     === undefined) config.llm_min_age_s     = 60;
  if (config.llm_veto_window_s === undefined) config.llm_veto_window_s = 180;
  if (config.llm_model         === undefined) config.llm_model         = "gpt-5.6-luna";
  if (config.llm_daily_cap_cents === undefined) config.llm_daily_cap_cents = config.max_daily_loss_cents;

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
