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
import { logger } from "./logger.js";

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
}

export async function fetchIntradayObs(
  stationId: string,
  lstOffset: number,
  count = 24
): Promise<IntradayPoint[]> {
  const key = `nws:obs:intraday:${stationId}`;
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

    // Filter to only today's LST observations (rough: last 24h)
    const now = Date.now();
    const oneDayAgo = now - 24 * 3600_000;
    const todayPoints = points.filter(
      (p) => new Date(p.timestamp).getTime() > oneDayAgo
    );

    // Compute running high (monotonic max)
    let runningMax = -Infinity;
    const result: IntradayPoint[] = todayPoints.map((p) => {
      if (p.tempF > runningMax) runningMax = p.tempF;
      return {
        timeLst: p.timeLst,
        tempF: p.tempF,
        isRunningHigh: p.tempF === runningMax,
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

export async function fetchTodayMaxForecast(
  lat: number,
  lon: number,
  lstOffset: number
): Promise<NwsForecast | null> {
  const key = `nws:forecast:max:${lat}:${lon}`;
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
