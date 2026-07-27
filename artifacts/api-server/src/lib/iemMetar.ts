/**
 * IEM METAR running-high source — mesonet.agron.iastate.edu asos.py
 *
 * Official NWS CLI daily highs are measured from 1-minute sensor data over the
 * 00:00–23:59 LST day. NWS API hourly observations (integer °C, hourly cadence)
 * routinely miss the true peak by 1–6°F. The METAR remarks carry two higher-
 * fidelity signals that together reproduce the CLI high to within 0–1°F
 * (verified Jul 2026 vs IEM cli.py for all 6 stations):
 *
 *   - T-group  (T0sssdddd): temp in tenths °C, every routine/special report
 *   - 1-group  (1snnn):     6-hour max temp in tenths °C, synoptic hours
 *                           (00/06/12/18Z) — captures peaks between reports
 *
 * runningHighF = round(max(T-groups, 1-groups, tmpf) over the LST day so far).
 *
 * The 1-group at the synoptic hour after the day rolls over can cover the
 * previous LST day's evening; we only count 1-groups whose 6-hour lookback
 * window is fully inside the current LST day (obs ts - 6h >= LST day start).
 */

import { cache, TTL } from "./cache.js";
import { logger } from "./logger.js";

const IEM_ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const UA = "WxEdge/1.0 (sellinghighs.com; guy@gcs.org)";

/** Our 4-letter ICAO IDs → IEM 3-letter ASOS IDs (IEM rejects ICAO). */
const IEM_STATION: Record<string, string> = {
  KNYC: "NYC",
  KMDW: "MDW",
  KAUS: "AUS",
  KLAX: "LAX",
  KPHL: "PHL",
  KDFW: "DFW",
};

function cToF(tenthsC: number): number {
  return (tenthsC / 10) * 1.8 + 32;
}

/** Start of the current LST day as a UTC ms timestamp. */
export function lstDayStartUtcMs(nowUtc: Date, lstOffset: number): number {
  const lst = new Date(nowUtc.getTime() + lstOffset * 3_600_000);
  return (
    Date.UTC(lst.getUTCFullYear(), lst.getUTCMonth(), lst.getUTCDate()) -
    lstOffset * 3_600_000
  );
}

export interface IemRunningHigh {
  /** Whole-°F running high over the LST day so far (CLI convention). */
  runningHighF: number;
  /** ISO UTC timestamp of the newest METAR used. */
  latestObsTsUtc: string;
  /** Number of METAR reports inside the LST-day window. */
  reportCount: number;
}

/** Parse a METAR line's remarks for T-group / 6-hr max group temps in °F. */
function parseMetarMaxF(
  metar: string,
  obsTsMs: number,
  dayStartMs: number
): number | null {
  let max: number | null = null;
  const rmk = metar.includes("RMK") ? metar.slice(metar.indexOf("RMK")) : metar;

  // T-group: T + sign digit + 3 temp tenths-°C digits + sign + 3 dewpoint digits
  const tg = rmk.match(/\bT([01])(\d{3})[01]\d{3}\b/);
  if (tg) {
    const f = cToF((tg[1] === "1" ? -1 : 1) * parseInt(tg[2]!, 10));
    max = max === null ? f : Math.max(max, f);
  }

  // 6-hr max group (synoptic hours). Only trust it when its whole 6-hour
  // lookback window is inside the current LST day.
  if (obsTsMs - 6 * 3_600_000 >= dayStartMs) {
    const og = rmk.match(/(?:^|\s)1([01])(\d{3})(?=\s|$)/);
    if (og) {
      const f = cToF((og[1] === "1" ? -1 : 1) * parseInt(og[2]!, 10));
      max = max === null ? f : Math.max(max, f);
    }
  }

  return max;
}

/**
 * Fetch raw METAR lines for ALL configured stations in ONE asos.py request.
 * IEM rate-limits parallel requests (429 observed with 6 concurrent calls),
 * so per-station fetches are forbidden — asos.py accepts repeated `station`
 * params. A single in-flight promise is shared across concurrent callers.
 */
let inflightFetch: Promise<Map<string, Array<{ tsMs: number; tmpf: number | null; metar: string }>> | null> | null = null;

async function fetchAllStationLines(): Promise<Map<
  string,
  Array<{ tsMs: number; tmpf: number | null; metar: string }>
> | null> {
  const key = "iem:metar:lines:all";
  const cached = cache.get<Map<string, Array<{ tsMs: number; tmpf: number | null; metar: string }>>>(key);
  if (cached) return cached.value;
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    try {
      const now = new Date();
      // Widest LST day start across our stations (KLAX, UTC-8) — request the
      // whole covering UTC span; per-station windows are applied at parse time.
      const startUtc = new Date(lstDayStartUtcMs(now, -8));
      const endUtc = new Date(now.getTime() + 24 * 3_600_000); // inclusive day granularity
      const params = new URLSearchParams({
        tz: "Etc/UTC",
        format: "onlycomma",
        latlon: "no",
        year1: String(startUtc.getUTCFullYear()),
        month1: String(startUtc.getUTCMonth() + 1),
        day1: String(startUtc.getUTCDate()),
        year2: String(endUtc.getUTCFullYear()),
        month2: String(endUtc.getUTCMonth() + 1),
        day2: String(endUtc.getUTCDate()),
      });
      for (const iemId of Object.values(IEM_STATION)) params.append("station", iemId);
      params.append("data", "tmpf");
      params.append("data", "metar");
      params.append("report_type", "3");
      params.append("report_type", "4");

      const resp = await fetch(`${IEM_ASOS}?${params.toString()}`, {
        headers: { "User-Agent": UA },
      });
      if (!resp.ok) {
        throw new Error(`IEM asos.py → ${resp.status} ${resp.statusText}`);
      }
      const text = await resp.text();
      const lines = text.trim().split("\n").slice(1); // drop header

      const byStation = new Map<string, Array<{ tsMs: number; tmpf: number | null; metar: string }>>();
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length < 4) continue;
        const iemId = parts[0]!;
        const tsMs = Date.parse(parts[1]!.replace(" ", "T") + "Z");
        if (isNaN(tsMs)) continue;
        const tmpf = parseFloat(parts[2]!);
        const entry = {
          tsMs,
          tmpf: isNaN(tmpf) ? null : tmpf,
          metar: parts.slice(3).join(","),
        };
        const arr = byStation.get(iemId);
        if (arr) arr.push(entry);
        else byStation.set(iemId, [entry]);
      }

      if (byStation.size === 0) {
        logger.warn("IEM METAR bulk fetch returned no reports");
        return null; // do NOT cache a miss — retry next cycle
      }

      cache.set(key, byStation, TTL.NWS_OBS_MS);
      return byStation;
    } catch (err) {
      logger.warn({ err }, "IEM METAR bulk fetch failed");
      return null;
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

/**
 * Fetch the CLI-faithful running high for the current LST day.
 * Returns null when IEM is unreachable or has no reports for the station
 * (callers fall back to NWS hourly observations).
 */
export async function fetchIemRunningHigh(
  stationId: string,
  lstOffset: number
): Promise<IemRunningHigh | null> {
  const iemId = IEM_STATION[stationId];
  if (!iemId) return null;

  const byStation = await fetchAllStationLines();
  const entries = byStation?.get(iemId);
  if (!entries || entries.length === 0) return null;

  const now = Date.now();
  const dayStartMs = lstDayStartUtcMs(new Date(now), lstOffset);

  let maxF = -Infinity;
  let latestTsMs = -Infinity;
  let count = 0;

  for (const e of entries) {
    if (e.tsMs < dayStartMs || e.tsMs > now) continue;
    count++;
    latestTsMs = Math.max(latestTsMs, e.tsMs);
    if (e.tmpf !== null) maxF = Math.max(maxF, e.tmpf);
    const metarMax = parseMetarMaxF(e.metar, e.tsMs, dayStartMs);
    if (metarMax !== null) maxF = Math.max(maxF, metarMax);
  }

  if (count === 0 || maxF === -Infinity) {
    logger.warn({ stationId }, "IEM METAR has no reports inside the LST day yet");
    return null;
  }

  return {
    runningHighF: Math.round(maxF),
    latestObsTsUtc: new Date(latestTsMs).toISOString(),
    reportCount: count,
  };
}

/**
 * Resolve the running high for a station: IEM METAR (CLI-faithful, tenths-°C
 * T-groups + 6-hr max groups) is authoritative when available. NWS hourly obs
 * are only a fallback — their integer-°C rounding runs 1–2°F hot vs CLI
 * (36°C → 96.8 → "97" when the true tenths reading is 96.1), so they must
 * never override the IEM value. Falls back to 72°F when neither has data.
 */
export async function resolveRunningHighF(
  stationId: string,
  lstOffset: number,
  nwsIntradayObs: Array<{ tempF: number }>
): Promise<number> {
  const iem = await fetchIemRunningHigh(stationId, lstOffset);
  if (iem !== null) return iem.runningHighF;

  if (nwsIntradayObs.length > 0) {
    return nwsIntradayObs.reduce((m, p) => Math.max(m, p.tempF), -Infinity);
  }
  return 72;
}
