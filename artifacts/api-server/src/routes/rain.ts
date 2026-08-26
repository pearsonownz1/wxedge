/**
 * Daily rain market routes.
 *
 * GET /api/rain/markets — active KXRAIN contracts with public Kalshi quotes
 * and the NWS hourly precipitation probability for each city/date.
 */

import { Router, type IRouter } from "express";
import { cache } from "../lib/cache.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const NWS_BASE = "https://api.weather.gov";
const USER_AGENT = "SellingHighs/1.0 (rain-markets)";
const CACHE_KEY = "rain:markets";
const CACHE_TTL_MS = 60_000;
const NWS_TTL_MS = 30 * 60_000;

interface City {
  name: string;
  lat: number;
  lon: number;
  timeZone: string;
}

const CITIES: Record<string, City> = {
  NYC: { name: "New York City", lat: 40.7831, lon: -73.9712, timeZone: "America/New_York" },
  CHI: { name: "Chicago", lat: 41.8781, lon: -87.6298, timeZone: "America/Chicago" },
  AUS: { name: "Austin", lat: 30.2672, lon: -97.7431, timeZone: "America/Chicago" },
  MIA: { name: "Miami", lat: 25.7617, lon: -80.1918, timeZone: "America/New_York" },
  DEN: { name: "Denver", lat: 39.7392, lon: -104.9903, timeZone: "America/Denver" },
  PHIL: { name: "Philadelphia", lat: 39.9526, lon: -75.1652, timeZone: "America/New_York" },
  LAX: { name: "Los Angeles", lat: 34.0522, lon: -118.2437, timeZone: "America/Los_Angeles" },
  LV: { name: "Las Vegas", lat: 36.1699, lon: -115.1398, timeZone: "America/Los_Angeles" },
  NOLA: { name: "New Orleans", lat: 29.9511, lon: -90.0715, timeZone: "America/Chicago" },
  SFO: { name: "San Francisco", lat: 37.7749, lon: -122.4194, timeZone: "America/Los_Angeles" },
  DC: { name: "Washington DC", lat: 38.9072, lon: -77.0369, timeZone: "America/New_York" },
  SEA: { name: "Seattle", lat: 47.6062, lon: -122.3321, timeZone: "America/Los_Angeles" },
  BOS: { name: "Boston", lat: 42.3601, lon: -71.0589, timeZone: "America/New_York" },
  PHX: { name: "Phoenix", lat: 33.4484, lon: -112.074, timeZone: "America/Phoenix" },
  ATL: { name: "Atlanta", lat: 33.749, lon: -84.388, timeZone: "America/New_York" },
  MIN: { name: "Minneapolis", lat: 44.9778, lon: -93.265, timeZone: "America/Chicago" },
  DAL: { name: "Dallas", lat: 32.7767, lon: -96.797, timeZone: "America/Chicago" },
  SATX: { name: "San Antonio", lat: 29.4241, lon: -98.4936, timeZone: "America/Chicago" },
  HOU: { name: "Houston", lat: 29.7604, lon: -95.3698, timeZone: "America/Chicago" },
  OKC: { name: "Oklahoma City", lat: 35.4676, lon: -97.5164, timeZone: "America/Chicago" },
};

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
  const key = `rain:nws:${city.name}:${date}`;
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
    .filter((period) => period.startTime && localIsoDate(new Date(period.startTime), city.timeZone) === date)
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
  for (const event of data.events ?? []) {
    const date = contractDate(String(event["event_ticker"] ?? ""));
    if (!date) continue;
    const rawMarkets = (event["markets"] as Array<Record<string, unknown>> | undefined) ?? [];
    const markets = rawMarkets
      .filter((market) => market["status"] === "active")
      .map((market): RainMarket | null => {
        const ticker = String(market["ticker"] ?? "");
        const cityCode = ticker.split("-").at(-1) ?? "";
        if (!ticker || !CITIES[cityCode]) return null;
        return {
          ticker,
          cityCode,
          cityName: CITIES[cityCode]!.name,
          contractDate: date,
          yesBidCents: toCents(market["yes_bid_dollars"]),
          yesAskCents: toCents(market["yes_ask_dollars"]),
          yesBidSize: toSize(market["yes_bid_size_fp"]),
          yesAskSize: toSize(market["yes_ask_size_fp"]),
          rainProbabilityPct: null,
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

      const probabilityByCity = new Map<string, number | null>();
      await Promise.all(discovery.markets.map(async (market) => {
        try {
          probabilityByCity.set(
            market.cityCode,
            await fetchRainProbability(CITIES[market.cityCode]!, discovery.date)
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