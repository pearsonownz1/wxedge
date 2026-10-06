/**
 * NWS API client — api.weather.gov
 * No API key required. User-Agent header is required by NWS policy.
 *
 * Key endpoints used:
 *   - /stations/{stationId}/observations/latest   — current observation
 *   - /stations/{stationId}/observations?limit=N  — recent obs for sparkline
 *   - /points/{lat},{lon}                         — grid metadata
 *   - /gridpoints/{office}/{x},{y}/forecast       — daily max temp forecast
 *   - /gridpoints/{office}/{x},{y}/forecast/hourly — hourly temps
 */

import { cache, TTL } from "./cache.js";
import { stationTradingDate } from "./weatherMarketGuards.js";
import { logger } from "./logger.js";
import { lstDayStartUtcMs } from "./iemMetar.js";

const NWS_BASE = "https://api.weather.gov";
const UA = "WxEdge/1.0 (kalshi-weather-edge; contact@example.com)";

async function nwsFetch(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
  });
  if (!resp.ok) {
    throw new Error(`NWS fetch ${url} → ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

export interface NwsObservation {
  tempF: number;
  timestampIso: string;
  /** LST-formatted time string, e.g. "14:07 LST" */
  timeLst: string;
}

function celsiusToF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function parseObservationTemp(obs: Record<string, unknown>): number | null {
  const props = obs["properties"] as Record<string, unknown> | undefined;
  if (!props) return null;
  const tempC = props["temperature"] as Record<string, unknown> | undefined;
  if (!tempC || tempC["value"] == null) return null;
  return celsiusToF(tempC["value"] as number);
}

function toTimeLst(isoTimestamp: string, lstOffsetHours: number): string {
  const d = new Date(isoTimestamp);
  const lstMs = d.getTime() + lstOffsetHours * 3600_000;
  const lstDate = new Date(lstMs);
  const h = String(lstDate.getUTCHours()).padStart(2, "0");
  const m = String(lstDate.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m} LST`;
}

export async function fetchLatestObservation(
  stationId: string,
  lstOffset: number
): Promise<NwsObservation | null> {
  const key = `nws:obs:latest:${stationId}`;
  const cached = cache.get<NwsObservation>(key);
  if (cached) return cached.value;

  try {
    const data = (await nwsFetch(
      `${NWS_BASE}/stations/${stationId}/observations/latest`
    )) as Record<string, unknown>;
    const tempF = parseObservationTemp(data);
    if (tempF == null) return null;
    const props = data["properties"] as Record<string, unknown>;
    const timestamp = props["timestamp"] as string;
    const obs: NwsObservation = {
      tempF,
      timestampIso: timestamp,
      timeLst: toTimeLst(timestamp, lstOffset),
    };
    cache.set(key, obs, TTL.NWS_OBS_MS);
    return obs;
  } catch (err) {
    logger.warn({ err, stationId }, "NWS latest obs fetch failed");
    return null;
  }
}

export interface IntradayPoint {
  timeLst: string;
  tempF: number;
  isRunningHigh: boolean;
  /** ISO-8601 UTC timestamp of this observation; used to compute obs_age_s for the snapshot logger. */
  tsUtc: string;
}

export async function fetchIntradayObs(
  stationId: string,
  lstOffset: number,
  count = 72
): Promise<IntradayPoint[]> {
  const key = `nws:obs:intraday:${stationId}:${stationTradingDate(new Date(), lstOffset)}`;
  const cached = cache.get<IntradayPoint[]>(key);
  if (cached) return cached.value;

  try {
    const data = (await nwsFetch(
      `${NWS_BASE}/stations/${stationId}/observations?limit=${count}`
    )) as Record<string, unknown>;
    const features = (data["features"] as unknown[]) ?? [];

    interface RawPoint { timeLst: string; tempF: number; timestamp: string }

    const points: RawPoint[] = features
      .map((f) => {
        const obs = f as Record<string, unknown>;
        const tempF = parseObservationTemp(obs);
        const props = obs["properties"] as Record<string, unknown>;
        const timestamp = props?.["timestamp"] as string | undefined;
        if (tempF == null || !timestamp) return null;
        return { timeLst: toTimeLst(timestamp, lstOffset), tempF, timestamp };
      })
      .filter((p): p is RawPoint => p !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Filter to the current LST settlement day (00:00–23:59 LST), matching
    // the official CLI measurement window. A rolling "last 24h" window leaked
    // yesterday's high into today's running high.
    const dayStartMs = lstDayStartUtcMs(new Date(), lstOffset);
    const todayPoints = points.filter(
      (p) => new Date(p.timestamp).getTime() >= dayStartMs
    );

    // Compute running high (monotonic max)
    let runningMax = -Infinity;
    const result: IntradayPoint[] = todayPoints.map((p) => {
      if (p.tempF > runningMax) runningMax = p.tempF;
      return {
        timeLst:       p.timeLst,
        tempF:         p.tempF,
        isRunningHigh: p.tempF === runningMax,
        tsUtc:         p.timestamp,
      };
    });

    cache.set(key, result, TTL.NWS_OBS_MS);
    return result;
  } catch (err) {
    logger.warn({ err, stationId }, "NWS intraday obs fetch failed");
    return [];
  }
}

/** Returns the NWS grid metadata for a lat/lon (cached). */
async function fetchGridMeta(
  lat: number,
  lon: number
): Promise<{ office: string; gridX: number; gridY: number } | null> {
  const key = `nws:gridmeta:${lat}:${lon}`;
  const cached = cache.get<{ office: string; gridX: number; gridY: number }>(key);
  if (cached) return cached.value;

  try {
    const data = (await nwsFetch(
      `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`
    )) as Record<string, unknown>;
    const props = data["properties"] as Record<string, unknown>;
    const meta = {
      office: props["cwa"] as string,
      gridX: props["gridX"] as number,
      gridY: props["gridY"] as number,
    };
    // Grid meta is stable — cache 24h
    cache.set(key, meta, 24 * 60 * 60 * 1000);
    return meta;
  } catch (err) {
    logger.warn({ err, lat, lon }, "NWS grid meta fetch failed");
    return null;
  }
}

export interface NwsForecast {
  /** Forecasted high temperature for today in °F */
  maxTempF: number;
  /** Period name, e.g. "This Afternoon" */
  periodName: string;
}

// ── NBM Percentile Fetching ──────────────────────────────────────────────────

export interface NbmPercentiles {
  p10F: number;
  p25F: number;
  p50F: number;
  p75F: number;
  p90F: number;
  /** 'nbm' = came from real NWS quantile fields; 'normal_approx' = derived from RMSE */
  source: "nbm" | "normal_approx";
}

/** Parse ISO 8601 interval start: "2026-07-25T12:00:00+00:00/PT1H" → Date */
function parseIntervalStart(validTime: string): Date | null {
  const slash = validTime.indexOf("/");
  const start = slash >= 0 ? validTime.slice(0, slash) : validTime;
  const d = new Date(start);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the maximum temperature-in-°F for today's daytime window from a
 * NWS time-series property object { uom, values: [{ validTime, value }] }.
 */
function extractDaytimeMaxF(
  prop: unknown,
  todayLstDate: number,
  lstOffsetHours: number
): number | null {
  if (!prop || typeof prop !== "object") return null;
  const obj = prop as Record<string, unknown>;
  const values = obj["values"] as
    | Array<{ validTime: string; value: number | null }>
    | undefined;
  if (!Array.isArray(values)) return null;

  let maxF: number | null = null;
  for (const entry of values) {
    if (entry.value == null) continue;
    const start = parseIntervalStart(entry.validTime);
    if (!start) continue;

    // Convert UTC → LST to check the date
    const lstMs = start.getTime() + lstOffsetHours * 3600_000;
    const lstDate = new Date(lstMs);
    if (lstDate.getUTCDate() !== todayLstDate) continue;

    // Restrict to daytime hours in LST (06:00–22:00)
    const lstHour = lstDate.getUTCHours();
    if (lstHour < 6 || lstHour > 22) continue;

    const tempF = celsiusToF(entry.value);
    if (maxF === null || tempF > maxF) maxF = tempF;
  }
  return maxF;
}

/** Compute symmetric Normal-approximation percentiles from median + RMSE. */
function normalApproxPercentiles(medianF: number, rmse: number): NbmPercentiles {
  return {
    p10F: parseFloat((medianF - 1.2816 * rmse).toFixed(1)),
    p25F: parseFloat((medianF - 0.6745 * rmse).toFixed(1)),
    p50F: parseFloat(medianF.toFixed(1)),
    p75F: parseFloat((medianF + 0.6745 * rmse).toFixed(1)),
    p90F: parseFloat((medianF + 1.2816 * rmse).toFixed(1)),
    source: "normal_approx",
  };
}

/**
 * Fetch NBM-derived temperature percentiles for today's forecast high.
 *
 * Tries the NWS raw gridpoints endpoint for `temperatureQuantile{N}Pct` fields
 * (available from some NWS Weather Forecast Offices that ingest NBM output).
 * Falls back to Normal(forecastMedianF, rmse) approximation when unavailable.
 */
export async function fetchNbmPercentiles(
  lat: number,
  lon: number,
  lstOffset: number,
  forecastMedianF: number,
  rmse: number
): Promise<NbmPercentiles> {
  const key = `nws:nbm:percentiles:${lat.toFixed(4)}:${lon.toFixed(4)}:${stationTradingDate(new Date(), lstOffset)}`;
  const cached = cache.get<NbmPercentiles>(key);
  if (cached) return cached.value;

  try {
    const grid = await fetchGridMeta(lat, lon);
    if (!grid) throw new Error("No grid meta");

    const data = (await nwsFetch(
      `${NWS_BASE}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}`
    )) as Record<string, unknown>;

    const props = data["properties"] as Record<string, unknown> | undefined;
    if (!props) throw new Error("No gridpoints properties");

    // Known quantile field naming convention in NWS gridpoints responses.
    // P50 falls back to the standard temperature field (which IS the NBM median).
    const p10Prop = props["temperatureQuantile10Pct"];
    const p25Prop = props["temperatureQuantile25Pct"];
    const p50Prop = props["temperatureQuantile50Pct"] ?? props["temperature"];
    const p75Prop = props["temperatureQuantile75Pct"];
    const p90Prop = props["temperatureQuantile90Pct"];

    const lstNow = new Date(Date.now() + lstOffset * 3600_000);
    const todayLstDate = lstNow.getUTCDate();

    const p10F = p10Prop ? extractDaytimeMaxF(p10Prop, todayLstDate, lstOffset) : null;
    const p25F = p25Prop ? extractDaytimeMaxF(p25Prop, todayLstDate, lstOffset) : null;
    const p50F = p50Prop ? extractDaytimeMaxF(p50Prop, todayLstDate, lstOffset) : null;
    const p75F = p75Prop ? extractDaytimeMaxF(p75Prop, todayLstDate, lstOffset) : null;
    const p90F = p90Prop ? extractDaytimeMaxF(p90Prop, todayLstDate, lstOffset) : null;

    // Require P10, P50, P90 at minimum to fit the asymmetric distribution
    if (p10F == null || p50F == null || p90F == null) {
      throw new Error(
        `NBM quantile fields incomplete (p10=${p10F}, p50=${p50F}, p90=${p90F})`
      );
    }

    const result: NbmPercentiles = {
      p10F,
      p25F: p25F ?? parseFloat(((p10F + p50F) / 2).toFixed(1)),
      p50F,
      p75F: p75F ?? parseFloat(((p50F + p90F) / 2).toFixed(1)),
      p90F,
      source: "nbm",
    };

    logger.info({ result, lat, lon }, "NBM percentiles fetched from gridpoints");
    cache.set(key, result, TTL.NWS_FORECAST_MS);
    return result;
  } catch (err) {
    logger.info(
      { err, lat, lon },
      "NBM quantile fields unavailable — using normal approximation"
    );
    const approx = normalApproxPercentiles(forecastMedianF, rmse);
    cache.set(key, approx, TTL.NWS_FORECAST_MS);
    return approx;
  }
}

// ── Daily Max Forecast ────────────────────────────────────────────────────────

export async function fetchTodayMaxForecast(
  lat: number,
  lon: number,
  lstOffset: number
): Promise<NwsForecast | null> {
  const key = `nws:forecast:max:${lat}:${lon}:${stationTradingDate(new Date(), lstOffset)}`;
  const cached = cache.get<NwsForecast>(key);
  if (cached) return cached.value;

  try {
    const grid = await fetchGridMeta(lat, lon);
    if (!grid) return null;

    const data = (await nwsFetch(
      `${NWS_BASE}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`
    )) as Record<string, unknown>;

    const periods = (
      (data["properties"] as Record<string, unknown>)?.["periods"] as unknown[]
    ) ?? [];

    // Find the daytime high period for today in LST
    const lstNow = new Date(Date.now() + lstOffset * 3600_000);
    const todayLst = lstNow.getUTCDate();

    let bestTemp: number | null = null;
    let periodName = "Today";

    for (const p of periods) {
      const period = p as Record<string, unknown>;
      if (!period["isDaytime"]) continue;
      const startTime = period["startTime"] as string;
      const periodDate = new Date(new Date(startTime).getTime() + lstOffset * 3600_000);
      if (periodDate.getUTCDate() !== todayLst) continue;
      const tempC = period["temperature"] as number;
      const tempUnit = period["temperatureUnit"] as string;
      const tempF = tempUnit === "F" ? tempC : celsiusToF(tempC);
      bestTemp = tempF;
      periodName = period["name"] as string;
      break;
    }

    if (bestTemp == null) {
      // Fall back: take first period's temp
      const first = periods[0] as Record<string, unknown> | undefined;
      if (first) {
        const tempC = first["temperature"] as number;
        const tempUnit = first["temperatureUnit"] as string;
        bestTemp = tempUnit === "F" ? tempC : celsiusToF(tempC);
        periodName = first["name"] as string ?? "Forecast";
      }
    }

    if (bestTemp == null) return null;

    const forecast: NwsForecast = { maxTempF: bestTemp, periodName };
    cache.set(key, forecast, TTL.NWS_FORECAST_MS);
    return forecast;
  } catch (err) {
    logger.warn({ err, lat, lon }, "NWS forecast fetch failed");
    return null;
  }
}
