/**
 * Rain settlement station registry.
 *
 * Kalshi's rules_primary text for every KXRAIN market names the exact
 * settlement source, e.g.:
 *
 *   "If the total precipitation at CLIORD in Chicago in Aug 26, 2026 is
 *    strictly greater than 0 inches, then the market resolves to Yes."
 *
 * CLIORD is an NWS CLI (Climate) report station code. VERIFIED_STATIONS
 * below maps each CLI code we've confirmed to its exact ICAO station and
 * coordinates, cross-checked against IEM's NWSCLI network table:
 *
 *   curl 'https://mesonet.agron.iastate.edu/api/1/network/NWSCLI.json'
 *
 * (Some airport 3-letter IDs resolve to a different, imprecise network by
 * default — e.g. K{id}.json can return a rounded RAOB upper-air record
 * instead of the surface CLI station. Always cross-check against the
 * NWSCLI network list specifically, not just the bare station lookup.)
 *
 * --- How to add a new city or correct a station ---
 * 1. Run resolveRainStationsFromKalshi() (or wait for the trader's daily
 *    auto-run — see rainStationRegistryCycle in the trader) against live
 *    KXRAIN events. Any city whose CLI code isn't in VERIFIED_STATIONS
 *    below gets upserted as confidence='low_confidence' with the raw
 *    rules_primary text captured in rulesPrimarySample — that text tells
 *    you the CLI code and city name to resolve.
 * 2. Look up the exact station: query the NWSCLI network table above and
 *    find the K{code} entry (name should mention the same city/airport).
 * 3. Add an entry to VERIFIED_STATIONS keyed by the CLI code, with the
 *    station's id, name, lat/lon, and IANA time zone.
 * 4. Re-run resolveRainStationsFromKalshi() (or restart the trader) — the
 *    row is promoted to confidence='verified' automatically.
 * 5. To correct an existing station (e.g. Kalshi changes its settlement
 *    source/station), just update its VERIFIED_STATIONS entry and re-run
 *    step 4; the resolver overwrites the stored row on every run.
 */

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rainStations } from "./schema/trading.js";
import type * as schema from "./schema/index.js";

export interface VerifiedStation {
  stationId: string;
  stationName: string;
  lat: number;
  lon: number;
  timeZone: string;
}

/**
 * CLI code -> verified settlement station, confirmed against IEM's NWSCLI
 * network table (see module doc above). Add entries here as new cities
 * appear on Kalshi; never guess a coordinate that hasn't been verified.
 */
export const VERIFIED_STATIONS: Record<string, VerifiedStation> = {
  CLINYC: { stationId: "KNYC", stationName: "New York City (Central Park)", lat: 40.779, lon: -73.96925, timeZone: "America/New_York" },
  CLIORD: { stationId: "KORD", stationName: "Chicago O'Hare Intl", lat: 41.98769949, lon: -87.92879718, timeZone: "America/Chicago" },
  CLIAUS: { stationId: "KAUS", stationName: "Austin-Bergstrom Intl", lat: 30.1945278, lon: -97.6698889, timeZone: "America/Chicago" },
  CLIMIA: { stationId: "KMIA", stationName: "Miami Intl", lat: 25.78805, lon: -80.31693, timeZone: "America/New_York" },
  CLIDEN: { stationId: "KDEN", stationName: "Denver Intl", lat: 39.8328, lon: -104.6575, timeZone: "America/Denver" },
  CLIPHL: { stationId: "KPHL", stationName: "Philadelphia Intl", lat: 39.86833, lon: -75.23111, timeZone: "America/New_York" },
  CLILAX: { stationId: "KLAX", stationName: "Los Angeles Intl", lat: 33.93816, lon: -118.38653, timeZone: "America/Los_Angeles" },
  CLILAS: { stationId: "KLAS", stationName: "Las Vegas Harry Reid Intl (McCarran)", lat: 36.08006, lon: -115.15225, timeZone: "America/Los_Angeles" },
  CLIMSY: { stationId: "KMSY", stationName: "New Orleans (Louis Armstrong Intl)", lat: 29.9933, lon: -90.2511, timeZone: "America/Chicago" },
  CLISFO: { stationId: "KSFO", stationName: "San Francisco Intl", lat: 37.61897, lon: -122.37489, timeZone: "America/Los_Angeles" },
  CLIDCA: { stationId: "KDCA", stationName: "Washington/Reagan National", lat: 38.8472, lon: -77.03455, timeZone: "America/New_York" },
  CLISEA: { stationId: "KSEA", stationName: "Seattle-Tacoma Intl", lat: 47.44469, lon: -122.31437, timeZone: "America/Los_Angeles" },
  CLIBOS: { stationId: "KBOS", stationName: "Boston Logan Intl", lat: 42.36057, lon: -71.00973, timeZone: "America/New_York" },
  CLIPHX: { stationId: "KPHX", stationName: "Phoenix Sky Harbor", lat: 33.43428, lon: -112.01158, timeZone: "America/Phoenix" },
  CLIATL: { stationId: "KATL", stationName: "Atlanta Hartsfield-Jackson Intl", lat: 33.6301, lon: -84.4418, timeZone: "America/New_York" },
  CLIMSP: { stationId: "KMSP", stationName: "Minneapolis-St Paul Intl", lat: 44.88537, lon: -93.23131, timeZone: "America/Chicago" },
  CLIDFW: { stationId: "KDFW", stationName: "Dallas-Fort Worth Intl", lat: 32.89683, lon: -97.038, timeZone: "America/Chicago" },
  CLISAT: { stationId: "KSAT", stationName: "San Antonio Intl", lat: 29.53369, lon: -98.46978, timeZone: "America/Chicago" },
  CLIHOU: { stationId: "KHOU", stationName: "Houston Hobby", lat: 29.63747, lon: -95.28245, timeZone: "America/Chicago" },
  CLIOKC: { stationId: "KOKC", stationName: "Oklahoma City Will Rogers World (AWOS)", lat: 35.3889, lon: -97.6006, timeZone: "America/Chicago" },
  CLIEWR: { stationId: "KEWR", stationName: "Newark Liberty Intl", lat: 40.68272, lon: -74.16932, timeZone: "America/New_York" },
  CLITTN: { stationId: "KTTN", stationName: "Trenton-Mercer", lat: 40.27682, lon: -74.81588, timeZone: "America/New_York" },
};

export interface RainStationRecord {
  cityCode: string;
  cityName: string;
  climateStationCode: string | null;
  stationId: string | null;
  stationName: string | null;
  lat: number | null;
  lon: number | null;
  timeZone: string | null;
  settlementSource: string;
  confidence: "verified" | "low_confidence";
}

/**
 * Parse Kalshi's rules_primary text for the CLI settlement station code
 * and city name, e.g. "...at CLIORD in Chicago in Aug 26, 2026 is..." ->
 * { cliCode: "CLIORD", cityName: "Chicago" }. Returns null if the text
 * doesn't match the expected pattern (fail-closed — caller should treat
 * as unresolved, not guess).
 */
export function parseRulesPrimary(rulesPrimary: string): { cliCode: string; cityName: string } | null {
  const m = rulesPrimary.match(/\bat\s+(CLI[A-Z0-9]+)\s+in\s+(.+?)\s+in\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+is\b/);
  if (!m) return null;
  return { cliCode: m[1]!, cityName: m[2]!.trim() };
}

/** Build a registry record for one Kalshi city from its rules_primary text. */
export function buildRainStationRecord(
  cityCode: string,
  rulesPrimary: string,
  settlementSource = "The Weather Company"
): RainStationRecord | null {
  const parsed = parseRulesPrimary(rulesPrimary);
  if (!parsed) return null;
  const verified = VERIFIED_STATIONS[parsed.cliCode];
  return {
    cityCode,
    cityName: parsed.cityName,
    climateStationCode: parsed.cliCode,
    stationId: verified?.stationId ?? null,
    stationName: verified?.stationName ?? null,
    lat: verified?.lat ?? null,
    lon: verified?.lon ?? null,
    timeZone: verified?.timeZone ?? null,
    settlementSource,
    confidence: verified ? "verified" : "low_confidence",
  };
}

type Db = NodePgDatabase<typeof schema>;

/** Upsert one resolved (or low-confidence) station record, keyed by cityCode. */
export async function upsertRainStation(db: Db, record: RainStationRecord): Promise<void> {
  const now = new Date();
  await db
    .insert(rainStations)
    .values({
      cityCode: record.cityCode,
      cityName: record.cityName,
      climateStationCode: record.climateStationCode,
      stationId: record.stationId,
      stationName: record.stationName,
      lat: record.lat,
      lon: record.lon,
      timeZone: record.timeZone,
      settlementSource: record.settlementSource,
      confidence: record.confidence,
      rulesPrimarySample: null,
      resolvedAtUtc: record.confidence === "verified" ? now : null,
      updatedAtUtc: now,
    })
    .onConflictDoUpdate({
      target: rainStations.cityCode,
      set: {
        cityName: record.cityName,
        climateStationCode: record.climateStationCode,
        stationId: record.stationId,
        stationName: record.stationName,
        lat: record.lat,
        lon: record.lon,
        timeZone: record.timeZone,
        settlementSource: record.settlementSource,
        confidence: record.confidence,
        resolvedAtUtc: record.confidence === "verified" ? now : sql`${rainStations.resolvedAtUtc}`,
        updatedAtUtc: now,
      },
    });
}

/** Store the raw rules_primary sample separately (kept short, audit-only). */
export async function recordRulesPrimarySample(db: Db, cityCode: string, sample: string): Promise<void> {
  await db
    .update(rainStations)
    .set({ rulesPrimarySample: sample.slice(0, 500) })
    .where(eq(rainStations.cityCode, cityCode));
}

export interface KalshiRainMarketForResolution {
  cityCode: string;
  rulesPrimary: string | null;
}

/**
 * Resolve a batch of live KXRAIN markets against VERIFIED_STATIONS and
 * upsert the registry. Cities whose CLI code isn't yet verified are
 * stored as confidence='low_confidence' (station fields null) rather than
 * silently falling back to a guessed coordinate. Safe to call repeatedly
 * — e.g. once daily from the trader — to pick up new cities Kalshi adds.
 */
export async function resolveRainStationsFromKalshi(
  db: Db,
  markets: KalshiRainMarketForResolution[]
): Promise<{ resolved: number; lowConfidence: string[] }> {
  const byCityCode = new Map<string, KalshiRainMarketForResolution>();
  for (const m of markets) {
    if (!byCityCode.has(m.cityCode)) byCityCode.set(m.cityCode, m);
  }

  const lowConfidence: string[] = [];
  let resolved = 0;
  for (const [cityCode, market] of byCityCode) {
    if (!market.rulesPrimary) continue;
    const record = buildRainStationRecord(cityCode, market.rulesPrimary);
    if (!record) continue;
    await upsertRainStation(db, record);
    await recordRulesPrimarySample(db, cityCode, market.rulesPrimary);
    resolved += 1;
    if (record.confidence === "low_confidence") lowConfidence.push(cityCode);
  }
  return { resolved, lowConfidence };
}

export interface RainStationLookup {
  cityCode: string;
  cityName: string;
  stationId: string | null;
  stationName: string | null;
  lat: number | null;
  lon: number | null;
  timeZone: string | null;
  settlementSource: string;
  confidence: "verified" | "low_confidence";
}

const registryCache: { value: Map<string, RainStationLookup> | null; fetchedAtMs: number } = {
  value: null,
  fetchedAtMs: 0,
};
const REGISTRY_CACHE_TTL_MS = 5 * 60_000;

/** Fetch the full registry as a cityCode -> lookup map, cached for 5 minutes. */
export async function getRainStationsMap(db: Db, forceRefresh = false): Promise<Map<string, RainStationLookup>> {
  const fresh = Date.now() - registryCache.fetchedAtMs < REGISTRY_CACHE_TTL_MS;
  if (!forceRefresh && fresh && registryCache.value) return registryCache.value;

  const rows = await db.select().from(rainStations);
  const map = new Map<string, RainStationLookup>();
  for (const row of rows) {
    map.set(row.cityCode, {
      cityCode: row.cityCode,
      cityName: row.cityName,
      stationId: row.stationId,
      stationName: row.stationName,
      lat: row.lat,
      lon: row.lon,
      timeZone: row.timeZone,
      settlementSource: row.settlementSource,
      confidence: row.confidence === "verified" ? "verified" : "low_confidence",
    });
  }
  registryCache.value = map;
  registryCache.fetchedAtMs = Date.now();
  return map;
}

/** Test-only: reset the in-memory registry cache. */
export function __resetRainStationsCacheForTests(): void {
  registryCache.value = null;
  registryCache.fetchedAtMs = 0;
}
