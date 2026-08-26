/**
 * Daily rain market routes.
 *
 * GET /api/rain/markets — active KXRAIN contracts with public Kalshi quotes
 * and the NWS hourly precipitation probability for each city/date.
 */

import { Router, type IRouter } from "express";
import { cache } from "../lib/cache.js";
import { logger } from "../lib/logger.js";
import { db, getRainStationsMap, resolveRainStationsFromKalshi, type RainStationLookup } from "@workspace/db";

const router: IRouter = Router();
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const NWS_BASE = "https://api.weather.gov";
const USER_AGENT = "SellingHighs/1.0 (rain-markets)";
const CACHE_KEY = "rain:markets";
const CACHE_TTL_MS = 60_000;
const NWS_TTL_MS = 30 * 60_000;

/**
 * City metadata comes from the rain settlement station registry
 * (@workspace/db rainStations) — sourced from Kalshi's own rules_primary
 * settlement text, not a hardcoded city-center guess. A city with
 * confidence !== 'verified' has null lat/lon and is rejected by
 * checkRainEligibility with reason "station_unresolved".
 */
type City = RainStationLookup;

// Auto-discovery: once a day, re-resolve the registry against whatever
// KXRAIN markets are live right now, mirroring the trader's own daily
// refresh (see rainSignalEngine.ts) so a newly added Kalshi city is
// flagged low_confidence here too, not just in the trader.
let lastRegistryResolveMs = 0;
const REGISTRY_RESOLVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function maybeRefreshStationRegistry(
  markets: Array<{ cityCode: string; rawRules: string | null }>
): Promise<void> {
  if (Date.now() - lastRegistryResolveMs < REGISTRY_RESOLVE_INTERVAL_MS) return;
  lastRegistryResolveMs = Date.now();
  try {
    const { lowConfidence } = await resolveRainStationsFromKalshi(
      db,
      markets.map((m) => ({ cityCode: m.cityCode, rulesPrimary: m.rawRules }))
    );
    if (lowConfidence.length > 0) {
      logger.warn({ lowConfidence }, "Rain page: station registry has unresolved cities — see rain_stations.rules_primary_sample");
    }
    await getRainStationsMap(db, true);
  } catch (err) {
    logger.warn({ err }, "Rain page: daily station registry refresh failed — keeping existing registry");
  }
}

interface RainMarket {
  ticker: string;
  cityCode: string;
  cityName: string;
  contractDate: string;
  yesBidCents: number | null;
  yesAskCents: number | null;
  yesBidSize: number | null;
  yesAskSize: number | null;
  rainProbabilityPct: number | null;
  settlementStationId: string | null;
  settlementStationName: string | null;
  stationConfidence: "verified" | "low_confidence";
}

/** Text that would indicate a market is NOT a daily-precipitation contract, even if it matched the KXRAIN ticker pattern. */
const DISALLOWED_SETTLEMENT_KEYWORDS = ["snow", "temperature", "wind speed", "hurricane", "high temp", "low temp"];

/**
 * Fail-closed eligibility gate for the public feed — mirrors
 * artifacts/trader/src/rainSignalEngine.ts's checkRainEligibility() so the
 * public /api/rain/markets list never shows a contract the trader itself
 * wouldn't be willing to trade. Kept as a duplicate (not a shared import)
 * consistent with this file's existing pattern of duplicating contract-date
 * parsing rather than adding a cross-artifact dependency between the trader
 * and the api-server. City/station data itself IS shared (via the
 * @workspace/db rain_stations registry), since that's the DB-backed source
 * of truth both artifacts must read live, not a static compile-time map.
 */
function checkRainEligibility(
  market: { ticker: string; cityCode: string; status: string; eventTicker: string; rawTitle: string | null; rawSubtitle: string | null; rawRules: string | null },
  contractDateStr: string,
  city: City | undefined,
  now: Date
): { eligible: boolean; reason: string | null } {
  if (!/^KXRAIN-\d{2}[A-Z]{3}\d{2}-[A-Z]+$/.test(market.ticker)) {
    return { eligible: false, reason: "ticker_format_invalid" };
  }
  if (!market.eventTicker.startsWith("KXRAIN-")) {
    return { eligible: false, reason: "series_mismatch" };
  }
  if (!city) {
    return { eligible: false, reason: "unknown_city" };
  }
  if (city.confidence !== "verified" || city.lat === null || city.lon === null || city.timeZone === null) {
    return { eligible: false, reason: "station_unresolved" };
  }
  if (market.status !== "active") {
    return { eligible: false, reason: "market_inactive" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contractDateStr)) {
    return { eligible: false, reason: "contract_date_unparseable" };
  }
  const today = localIsoDate(now, city.timeZone);
  const tomorrow = localIsoDate(new Date(now.getTime() + 86_400_000), city.timeZone);
  const yesterday = localIsoDate(new Date(now.getTime() - 86_400_000), city.timeZone);
  if (contractDateStr !== today && contractDateStr !== tomorrow) {
    return { eligible: false, reason: contractDateStr <= yesterday ? "contract_date_stale" : "contract_date_out_of_range" };
  }
  // Fail closed on settlement-terms evidence: require positive confirmation
  // that the contract actually settles on precipitation. Missing text is NOT
  // treated as a pass — a KXRAIN-ticker market with no title, subtitle, or
  // rules text at all is just as unverified as one with the wrong terms.
  const text = [market.rawTitle, market.rawSubtitle, market.rawRules].filter(Boolean).join(" ").toLowerCase();
  if (DISALLOWED_SETTLEMENT_KEYWORDS.some((kw) => text.includes(kw))) {
    return { eligible: false, reason: "settlement_terms_mismatch" };
  }
  if (!/rain|precip/i.test(text)) {
    return { eligible: false, reason: "settlement_terms_unverified" };
  }
  return { eligible: true, reason: null };
}

interface RainMarketsPayload {
  contractDate: string | null;
  markets: RainMarket[];
  fetchedAt: string;
  feedFresh: boolean;
  feedStatus: "live" | "stale" | "rate_limited" | "network_error" | "no_current_contracts" | "unavailable";
  kalshiAgeSeconds: number | null;
  probabilitySource: string;
  settlementSource: string;
}

interface CachedRainMarkets {
  date: string;
  markets: RainMarket[];
  fetchedAt: string;
}

let refreshInFlight: Promise<CachedRainMarkets> | null = null;

function toCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) && cents >= 1 && cents <= 99 ? cents : null;
}

function toSize(value: unknown): number | null {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : null;
}

function contractDate(eventTicker: string): string | null {
  const match = /^KXRAIN-(\d{2})([A-Z]{3})(\d{2})$/.exec(eventTicker);
  if (!match) return null;
  const month = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  }[match[2]!];
  if (!month) return null;
  return `${2000 + Number(match[1])}-${String(month).padStart(2, "0")}-${match[3]}`;
}

function localIsoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function fetchRainProbability(city: City, date: string): Promise<number | null> {
  // Only called for markets that already passed checkRainEligibility, which
  // requires confidence === "verified" (lat/lon/timeZone all non-null) —
  // this is defense-in-depth, not a real fallback path.
  if (city.lat === null || city.lon === null || city.timeZone === null) return null;
  const timeZone = city.timeZone;
  const key = `rain:nws:${city.cityCode}:${date}`;
  const cached = cache.get<number | null>(key);
  if (cached) return cached.value;

  const point = await fetch(`${NWS_BASE}/points/${city.lat},${city.lon}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!point.ok) return null;
  const pointData = await point.json() as { properties?: { forecastHourly?: string } };
  const forecastUrl = pointData.properties?.forecastHourly;
  if (!forecastUrl) return null;

  const forecast = await fetch(forecastUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!forecast.ok) return null;
  const forecastData = await forecast.json() as {
    properties?: {
      periods?: Array<{
        startTime?: string;
        probabilityOfPrecipitation?: { value?: number | null };
      }>;
    };
  };
  const values = (forecastData.properties?.periods ?? [])
    .filter((period) => period.startTime && localIsoDate(new Date(period.startTime), timeZone) === date)
    .map((period) => period.probabilityOfPrecipitation?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => Math.max(0, Math.min(100, value)));
  const probability = values.length > 0 ? Math.max(...values) : null;
  cache.set(key, probability, NWS_TTL_MS);
  return probability;
}

async function discoverRainMarkets(): Promise<{ date: string; markets: RainMarket[] }> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(
      `${KALSHI_BASE}/events?series_ticker=KXRAIN&status=open&with_nested_markets=true&limit=5`,
      {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (response.status !== 429 || attempt === 1) break;
    const retryAfter = Number(response.headers.get("retry-after") ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 5) * 1_000));
  }
  if (!response?.ok) {
    throw new Error(`KXRAIN discovery failed: ${response?.status ?? "no response"}`);
  }

  const data = await response.json() as { events?: Array<Record<string, unknown>> };
  const now = new Date();

  // Flatten all markets across events up front so we can run the daily
  // registry auto-discovery against everything Kalshi is currently
  // offering, not just the first event with a parseable date.
  const allRawMarkets: Array<{ eventTicker: string; date: string; market: Record<string, unknown> }> = [];
  for (const event of data.events ?? []) {
    const eventTicker = String(event["event_ticker"] ?? "");
    const date = contractDate(eventTicker);
    if (!date) continue;
    for (const market of (event["markets"] as Array<Record<string, unknown>> | undefined) ?? []) {
      allRawMarkets.push({ eventTicker, date, market });
    }
  }
  await maybeRefreshStationRegistry(
    allRawMarkets.map(({ market }) => ({
      cityCode: String(market["ticker"] ?? "").split("-").at(-1) ?? "",
      rawRules: (market["rules_primary"] as string | undefined) ?? null,
    }))
  );
  const stations = await getRainStationsMap(db);

  for (const event of data.events ?? []) {
    const eventTicker = String(event["event_ticker"] ?? "");
    const date = contractDate(eventTicker);
    if (!date) continue;
    const rawMarkets = (event["markets"] as Array<Record<string, unknown>> | undefined) ?? [];
    const markets = rawMarkets
      .map((market): RainMarket | null => {
        const ticker = String(market["ticker"] ?? "");
        const cityCode = ticker.split("-").at(-1) ?? "";
        const city = stations.get(cityCode);
        if (!ticker || !city) return null;
        const status = String(market["status"] ?? "");
        const rawTitle = (market["title"] as string | undefined) ?? null;
        const rawSubtitle = (market["yes_sub_title"] as string | undefined) ?? (market["subtitle"] as string | undefined) ?? null;
        const rawRules = (market["rules_primary"] as string | undefined) ?? null;
        const { eligible, reason } = checkRainEligibility(
          { ticker, cityCode, status, eventTicker, rawTitle, rawSubtitle, rawRules },
          date,
          city,
          now
        );
        if (!eligible) {
          logger.warn({ ticker, reason }, "Rain page: market excluded from public feed — failed eligibility check");
          return null;
        }
        return {
          ticker,
          cityCode,
          cityName: city.cityName,
          contractDate: date,
          yesBidCents: toCents(market["yes_bid_dollars"]),
          yesAskCents: toCents(market["yes_ask_dollars"]),
          yesBidSize: toSize(market["yes_bid_size_fp"]),
          yesAskSize: toSize(market["yes_ask_size_fp"]),
          rainProbabilityPct: null,
          settlementStationId: city.stationId,
          settlementStationName: city.stationName,
          stationConfidence: city.confidence,
        };
      })
      .filter((market): market is RainMarket => market !== null);
    if (markets.length > 0) return { date, markets };
  }
  return { date: "", markets: [] };
}

function responseFor(
  discovery: CachedRainMarkets,
  feedFresh: boolean,
  feedStatus: RainMarketsPayload["feedStatus"]
): RainMarketsPayload {
  return {
    contractDate: discovery.date || null,
    markets: discovery.markets,
    fetchedAt: discovery.fetchedAt,
    feedFresh,
    feedStatus,
    kalshiAgeSeconds: Math.max(0, Math.round((Date.now() - new Date(discovery.fetchedAt).getTime()) / 1_000)),
    probabilitySource: "NWS hourly precipitation probability",
    settlementSource: "The Weather Company",
  };
}

async function refreshRainMarkets(): Promise<CachedRainMarkets> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const discovery = await discoverRainMarkets();
      if (discovery.markets.length === 0) {
        const empty: CachedRainMarkets = { ...discovery, fetchedAt: new Date().toISOString() };
        cache.set(CACHE_KEY, empty, CACHE_TTL_MS);
        return empty;
      }

      const stations = await getRainStationsMap(db);
      const probabilityByCity = new Map<string, number | null>();
      await Promise.all(discovery.markets.map(async (market) => {
        try {
          probabilityByCity.set(
            market.cityCode,
            await fetchRainProbability(stations.get(market.cityCode)!, discovery.date)
          );
        } catch (err) {
          logger.warn({ err, ticker: market.ticker }, "Rain page: NWS probability request failed");
          probabilityByCity.set(market.cityCode, null);
        }
      }));
      const enriched: CachedRainMarkets = {
        date: discovery.date,
        markets: discovery.markets.map((market) => ({
          ...market,
          rainProbabilityPct: probabilityByCity.get(market.cityCode) ?? null,
        })),
        fetchedAt: new Date().toISOString(),
      };
      cache.set(CACHE_KEY, enriched, CACHE_TTL_MS);
      return enriched;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

router.get("/rain/markets", async (_req, res): Promise<void> => {
  const cached = cache.peek<CachedRainMarkets>(CACHE_KEY);
  if (cached?.fresh) {
    res.json(responseFor(cached.value, true, cached.value.markets.length > 0 ? "live" : "no_current_contracts"));
    return;
  }

  try {
    const refreshed = await refreshRainMarkets();
    res.json(responseFor(refreshed, true, refreshed.markets.length > 0 ? "live" : "no_current_contracts"));
  } catch (err) {
    const message = String(err);
    const feedStatus: RainMarketsPayload["feedStatus"] =
      message.includes("429") ? "rate_limited" : "network_error";
    logger.warn({ err }, "Rain page: market discovery failed");
    if (cached) {
      res.json(responseFor(cached.value, false, feedStatus));
      return;
    }
    res.json({
      contractDate: null,
      markets: [],
      fetchedAt: new Date().toISOString(),
      feedFresh: false,
      feedStatus: feedStatus === "rate_limited" ? "rate_limited" : "unavailable",
      kalshiAgeSeconds: null,
      probabilitySource: "NWS hourly precipitation probability",
      settlementSource: "The Weather Company",
    } satisfies RainMarketsPayload);
  }
});

export default router;