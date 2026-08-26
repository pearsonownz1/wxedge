/**
 * Risk Officer — pure function, no I/O.
 *
 * Takes a signal candidate, the current risk state (built from the DB by the
 * caller), and the config.  Returns { approved: boolean, reason: string }.
 *
 * Design principles:
 *   - Stateless: the function is a pure transform of its arguments.
 *   - Fail-closed: any unexpected condition returns approved=false.
 *   - Logged by caller: the returned decision is written to risk_decisions by
 *     the caller; the function itself does no I/O.
 *   - Config-driven: every numeric limit is a config parameter.
 *
 * The executor MUST call this before placing any order (shadow or live).
 * Bypassing it is a code defect, not a policy violation.
 */

import type { RiskConfig } from "./config.js";
import type { RiskState } from "./db.js";

export interface SignalCandidate {
  ticker:     string;
  station_id: string;
  side:       "YES" | "NO";
  limit_price: number;  // cents
  /** Contract count after maximum-tilt sizing; defaults to one for direct callers. */
  contracts?: number;
  edge_net:   number;
  ts:         Date;
  // Optional: pre-computed metadata set by sports signals
  headline?:       string;
  model_pct?:      number;
  market_type?:    "weather" | "sports" | "rain";
  sports_context?: {
    pitcher_name: string;
    threshold:    number;
    lambda:       number;  // expected strikeouts (Poisson λ)
    k9:           number;  // pitcher's K/9 this season
    avg_ip:       number;  // avg innings per start this season
  };
  rain_context?: {
    city:              string;
    contract_date:     string;
    forecast_rain_pct: number;
    settlement_source: string;
  };
}

export interface RiskDecision {
  approved: boolean;
  reason:   string;
}

/**
 * Evaluate a signal candidate against all risk limits.
 * Returns on the FIRST failing check.
 */
export function checkRisk(
  signal: SignalCandidate,
  state: RiskState,
  config: RiskConfig
): RiskDecision {
  const contracts = signal.contracts ?? 1;
  const orderCost = signal.limit_price * contracts;

  if (!Number.isInteger(contracts) || contracts < 1) {
    return { approved: false, reason: `invalid_contract_count: ${contracts}` };
  }

  // 1. Kill switch — always checked first.
  if (state.killSwitchActive) {
    return { approved: false, reason: "kill_switch" };
  }

  // 2. Daily loss cap — stops all trading when realised losses hit the limit.
  if (state.dailyCostToday + orderCost > config.max_daily_loss_cents) {
    return {
      approved: false,
      reason: `max_daily_loss: today_cost=${state.dailyCostToday} + this=${orderCost} > limit=${config.max_daily_loss_cents}`,
    };
  }

  // 3. Per-trade cost limit.
  if (orderCost > config.max_cost_per_trade_cents) {
    return {
      approved: false,
      reason: `max_cost_per_trade: cost=${orderCost} > limit=${config.max_cost_per_trade_cents}`,
    };
  }

  // 4. Max open orders per station.
  const stationOpen = state.openOrdersPerStation[signal.station_id] ?? 0;
  if (stationOpen >= config.max_open_orders_per_station) {
    return {
      approved: false,
      reason: `max_open_orders_per_station: open=${stationOpen} >= limit=${config.max_open_orders_per_station}`,
    };
  }

  // 5. Max daily exposure per station.
  const stationDaily = state.dailyExposurePerStation[signal.station_id] ?? 0;
  if (stationDaily + orderCost > config.max_daily_exposure_per_station_cents) {
    return {
      approved: false,
      reason:
        `max_daily_exposure_per_station: station_today=${stationDaily}` +
        ` + this=${orderCost}` +
        ` > limit=${config.max_daily_exposure_per_station_cents}`,
    };
  }

  // 6. Max total open exposure.
  if (state.totalOpenExposure + orderCost > config.max_total_open_exposure_cents) {
    return {
      approved: false,
      reason:
        `max_total_open_exposure: open=${state.totalOpenExposure}` +
        ` + this=${orderCost}` +
        ` > limit=${config.max_total_open_exposure_cents}`,
    };
  }

  // 7. Duplicate guard: same ticker+side proposed/ordered within the cooldown
  //    window (state.recentSignals is sourced from approvals + orders).
  //    Only STRICTLY EARLIER rows count, as defense in depth: anything sharing
  //    this signal's exact timestamp originated in the same trading cycle and
  //    is not a prior action.
  const cooldownMs = config.cooldown_min * 60_000;
  const cutoff = new Date(signal.ts.getTime() - cooldownMs);
  const duplicate = state.recentSignals.find(
    (r) =>
      r.ticker === signal.ticker &&
      r.side === signal.side &&
      r.ts > cutoff &&
      r.ts.getTime() < signal.ts.getTime()
  );
  if (duplicate) {
    return {
      approved: false,
      reason:
        `duplicate_within_cooldown: ${signal.ticker}/${signal.side}` +
        ` last_seen=${duplicate.ts.toISOString()}` +
        ` cooldown=${config.cooldown_min}min`,
    };
  }

  return { approved: true, reason: "approved" };
}
