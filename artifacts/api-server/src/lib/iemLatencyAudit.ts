/**
 * Phase 0 — IEM 1-minute ASOS latency audit.
 *
 * Called every 4 minutes (piggybacking on the warmCache() schedule).
 * Each poll queries the last 3 hours of IEM 1-min data per station,
 * finds the newest observation timestamp, and emits a structured log line:
 *
 *   { name:"iem-latency-audit", station, lagMin, newestObsTs, wallClockTs }
 *
 * After 24 h of samples the log file is parsed into docs/iem-latency-audit.md.
 *
 * IEM notes:
 *   - Station IDs are 3-letter ASOS codes (not 4-letter ICAO).
 *   - Identify with a real User-Agent + contact per IEM usage guidance.
 *   - Use incremental windows — don't re-pull the full day.
 */

import { logger } from "./logger.js";

const IEM_BASE = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py";

/** Map our 4-letter ICAO IDs → IEM 3-letter ASOS IDs. */
const IEM_STATION: Record<string, string> = {
  KNYC: "NYC",
  KMDW: "MDW",
  KAUS: "AUS",
  KLAX: "LAX",
  KPHL: "PHL",
  KDFW: "DFW",
};

const UA = "WxEdge/1.0 (sellinghighs.com; guy@gcs.org)";

/** Build the IEM asos1min URL for a station over [start, end] (UTC Date objects). */
function buildUrl(iemId: string, start: Date, end: Date): string {
  const p = (d: Date) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  });
  const s = p(start);
  const e = p(end);
  const params = new URLSearchParams({
    station: iemId,
    year1: String(s.year),  month1: String(s.month),  day1: String(s.day),
    hour1: String(s.hour),  minute1: String(s.minute),
    year2: String(e.year),  month2: String(e.month),  day2: String(e.day),
    hour2: String(e.hour),  minute2: String(e.minute),
    vars: "tmpf",           // Note: NOT "vars[]" — IEM uses plain "vars", not PHP array notation
    sample: "1min",
    what: "view",
    delim: "comma",
    gis: "no",
  });
  return `${IEM_BASE}?${params.toString()}`;
}

/**
 * Parse the newest valid timestamp from an IEM CSV response.
 * CSV header: station,station_name,valid(UTC),tmpf
 * Data rows:  NYC,NEW YORK/JFK,2026-07-25 08:51,72.0
 *
 * Returns null when the response has no data rows or can't be parsed.
 */
function parseNewestObsTs(csv: string): Date | null {
  const lines = csv.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  // Skip header row
  const dataLines = lines.filter((l) => !l.startsWith("station"));
  if (dataLines.length === 0) return null;

  // Parse valid(UTC) column (index 2) from each row; keep the newest.
  let newestMs = -Infinity;
  for (const line of dataLines) {
    const parts = line.split(",");
    const validStr = parts[2]?.trim(); // "2026-07-25 08:51"
    if (!validStr) continue;
    // IEM uses "YYYY-MM-DD HH:MM" UTC — convert to ISO for Date parsing
    const iso = validStr.replace(" ", "T") + ":00Z";
    const ms = Date.parse(iso);
    if (!isNaN(ms) && ms > newestMs) newestMs = ms;
  }

  return newestMs === -Infinity ? null : new Date(newestMs);
}

/**
 * Run one latency-audit poll cycle for all 6 stations.
 * Queries the last LOOKBACK_H hours of 1-min data and records the lag
 * between the newest observation timestamp and the current wall clock.
 *
 * Emits one log line per station:
 *   INFO  { name:"iem-latency-audit", station, lagMin, noData, newestObsTs, wallClockTs }
 */
const LOOKBACK_H = 6; // hours — wide enough to catch significantly lagged feeds (first poll showed >3h lag)

export async function runLatencyAuditPoll(): Promise<void> {
  const wallClock = new Date();
  const windowStart = new Date(wallClock.getTime() - LOOKBACK_H * 3_600_000);

  await Promise.allSettled(
    Object.entries(IEM_STATION).map(async ([icao, iemId]) => {
      const url = buildUrl(iemId, windowStart, wallClock);
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "text/plain" },
          signal: AbortSignal.timeout(15_000), // 15s timeout
        });
        if (!resp.ok) {
          logger.warn(
            { name: "iem-latency-audit", station: icao, status: resp.status },
            "IEM 1-min fetch returned non-200"
          );
          return;
        }
        const csv = await resp.text();
        const newestObsTs = parseNewestObsTs(csv);

        if (!newestObsTs) {
          logger.info(
            {
              name: "iem-latency-audit",
              station: icao,
              noData: true,
              lookbackH: LOOKBACK_H,
              wallClockTs: wallClock.toISOString(),
            },
            "IEM 1-min audit: no observations in lookback window"
          );
          return;
        }

        const lagMin = Math.round(
          (wallClock.getTime() - newestObsTs.getTime()) / 60_000
        );

        logger.info(
          {
            name: "iem-latency-audit",
            station: icao,
            lagMin,
            noData: false,
            newestObsTs: newestObsTs.toISOString(),
            wallClockTs: wallClock.toISOString(),
          },
          "IEM 1-min audit sample"
        );
      } catch (err) {
        logger.warn(
          { name: "iem-latency-audit", station: icao, err },
          "IEM 1-min audit fetch failed"
        );
      }
    })
  );
}
