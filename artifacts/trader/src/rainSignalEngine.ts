/**
 * Rain Signal Engine — daily Kalshi KXRAIN city contracts.
 *
 * The active KXRAIN contracts resolve YES when the named city records more than
 * 0 inches of precipitation on the contract date. The model uses the maximum
 * NWS hourly precipitation probability during that city's contract day.
 *
 * Orders still go through the shared risk officer, approval queue, LLM, and
 * signed Kalshi order endpoint. This engine only discovers markets, calculates
 * probabilities, persists current books, and emits signal candidates.
 */

import { createHash } from "node:crypto";
import { db, books } from "@workspace/db";
import { insertSignal, type SignalRow } from "./db.js";
import type { RiskConfig } from "./config.js";
import type { SignalCandidate } from "./riskOfficer.js";
import pino from "pino";

const logger = pino({ name: "rain-engine" });

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const NWS_BASE = "https://api.weather.gov";
const UA = "SellingHighs/1.0 (rain-market-model)";

interface City {
  name: string;
  lat: number;
  lon: number;
  timeZone: string;
}

const CITIES: Record<string, City> = {
  NYC:  { name: "New York City", lat: 40.7831, lon: -73.9712, timeZone: "America/New_York" },
  CHI:  { name: "Chicago", lat: 41.8781, lon: -87.6298, timeZone: "America/Chicago" },
  AUS:  { name: "Austin", lat: 30.2672, lon: -97.7431, timeZone: "America/Chicago" },
  MIA:  { name: "Miami", lat: 25.7617, lon: -80.1918, timeZone: "America/New_York" },
  DEN:  { name: "Denver", lat: 39.7392, lon: -104.9903, timeZone: "America/Denver" },
  PHIL: { name: "Philadelphia", lat: 39.9526, lon: -75.1652, timeZone: "America/New_York" },
  LAX:  { name: "Los Angeles", lat: 34.0522, lon: -118.2437, timeZone: "America/Los_Angeles" },
  LV:   { name: "Las Vegas", lat: 36.1699, lon: -115.1398, timeZone: "America/Los_Angeles" },
  NOLA: { name: "New Orleans", lat: 29.9511, lon: -90.0715, timeZone: "America/Chicago" },
  SFO:  { name: "San Francisco", lat: 37.7749, lon: -122.4194, timeZone: "America/Los_Angeles" },
  DC:   { name: "Washington DC", lat: 38.9072, lon: -77.0369, timeZone: "America/New_York" },
  SEA:  { name: "Seattle", lat: 47.6062, lon: -122.3321, timeZone: "America/Los_Angeles" },
  BOS:  { name: "Boston", lat: 42.3601, lon: -71.0589, timeZone: "America/New_York" },
  PHX:  { name: "Phoenix", lat: 33.4484, lon: -112.0740, timeZone: "America/Phoenix" },
  ATL:  { name: "Atlanta", lat: 33.7490, lon: -84.3880, timeZone: "America/New_York" },
  MIN:  { name: "Minneapolis", lat: 44.9778, lon: -93.2650, timeZone: "America/Chicago" },
  DAL:  { name: "Dallas", lat: 32.7767, lon: -96.7970, timeZone: "America/Chicago" },
  SATX: { name: "San Antonio", lat: 29.4241, lon: -98.4936, timeZone: "America/Chicago" },
  HOU:  { name: "Houston", lat: 29.7604, lon: -95.3698, timeZone: "America/Chicago" },
  OKC:  { name: "Oklahoma City", lat: 35.4676, lon: -97.5164, timeZone: "America/Chicago" },
};

interface RainMarket {
  ticker: string;
  cityCode: string;
  cityName: string;
  yesBid: number | null;
  yesAsk: number | null;
  yesBidSize: number | null;
  yesAskSize: number | null;
}

let cachedDiscovery: { date: string; markets: RainMarket[] } | null = null;

function toCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) && cents >= 1 && cents <= 99 ? cents : null;
}

function toSize(value: unknown): number | null {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : null;
}

function feeCeil(price01: number, feeRate: number): number {
  return Math.ceil(feeRate * price01 * (1 - price01) * 100) / 100;
}

function inputsHash(ticker: string, side: string, modelProbability: number, now: string): string {
  return createHash("sha256")
    .update(`rain:${ticker}:${side}:${modelProbability.toFixed(4)}:${now}`)
    .digest("hex")
    .slice(0, 16);
}

function contractDate(eventTicker: string): string | null {
  const match = /^KXRAIN-(\d{2})([A-Z]{3})(\d{2})$/.exec(eventTicker);
  if (!match) return null;
  const months: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const month = months[match[2]!];
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
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function getAnyRainProbability(city: City, date: string): Promise<number | null> {
  const point = await fetch(`${NWS_BASE}/points/${city.lat},${city.lon}`, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!point.ok) return null;
  const pointData = await point.json() as { properties?: { forecastHourly?: string } };
  const forecastUrl = pointData.properties?.forecastHourly;
  if (!forecastUrl) return null;

  const forecast = await fetch(forecastUrl, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
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

  if (values.length === 0) return null;
  return Math.max(...values) / 100;
}

async function fetchActiveRainMarkets(): Promise<{ date: string; markets: RainMarket[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(
      `${KALSHI_BASE}/events?series_ticker=KXRAIN&status=open&with_nested_markets=true&limit=5`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
    );
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 2);
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 10) * 1_000));
      continue;
    }
    if (!response.ok) break;

    const data = await response.json() as { events?: Array<Record<string, unknown>> };
    for (const event of data.events ?? []) {
      const date = contractDate(String(event["event_ticker"] ?? ""));
      if (!date) continue;
      const markets = ((event["markets"] as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((market) => market["status"] === "active")
        .map((market) => {
          const ticker = String(market["ticker"] ?? "");
          const cityCode = ticker.split("-").at(-1) ?? "";
          return {
            ticker,
            cityCode,
            cityName: String(market["yes_sub_title"] ?? CITIES[cityCode]?.name ?? cityCode),
            yesBid: toCents(market["yes_bid_dollars"]),
            yesAsk: toCents(market["yes_ask_dollars"]),
            yesBidSize: toSize(market["yes_bid_size_fp"]),
            yesAskSize: toSize(market["yes_ask_size_fp"]),
          };
        })
        .filter((market) => market.ticker && CITIES[market.cityCode] !== undefined);
      if (markets.length > 0) {
        cachedDiscovery = { date, markets };
        return cachedDiscovery;
      }
    }
    return { date: "", markets: [] };
  }
  if (cachedDiscovery) {
    logger.warn({ markets: cachedDiscovery.markets.length }, "Rain engine: using cached discovery after Kalshi rate limit");
    return cachedDiscovery;
  }
  throw new Error("KXRAIN discovery failed after retry");
}

export async function runRainSignalEngine(
  config: RiskConfig,
  now: Date
): Promise<Array<{ candidate: SignalCandidate; signalId: number }>> {
  const discovery = await fetchActiveRainMarkets();
  if (discovery.markets.length === 0) {
    logger.info("Rain engine: no active KXRAIN markets");
    return [];
  }

  const probabilityByCity = new Map<string, number | null>();
  await Promise.all(discovery.markets.map(async (market) => {
    const city = CITIES[market.cityCode]!;
    try {
      probabilityByCity.set(market.cityCode, await getAnyRainProbability(city, discovery.date));
    } catch (err) {
      logger.warn({ err, ticker: market.ticker }, "Rain engine: NWS forecast request failed");
      probabilityByCity.set(market.cityCode, null);
    }
  }));

  await db.insert(books).values(
    discovery.markets.map((market) => ({
      tsUtc: now,
      stationId: `RAIN_${market.cityCode}`,
      ticker: market.ticker,
      bracketLo: null,
      bracketHi: null,
      yesBid: market.yesBid,
      yesAsk: market.yesAsk,
      noBid: market.yesAsk === null ? null : 100 - market.yesAsk,
      noAsk: market.yesBid === null ? null : 100 - market.yesBid,
      bidSize: market.yesBidSize,
      askSize: market.yesAskSize,
      coherentFlag: true,
    }))
  ).catch((err) => logger.warn({ err }, "Rain engine: failed to persist current books"));

  const live: Array<{ candidate: SignalCandidate; signalId: number }> = [];
  const nowIso = now.toISOString();

  for (const market of discovery.markets) {
    const modelYes = probabilityByCity.get(market.cityCode);
    if (typeof modelYes !== "number" || market.yesBid === null || market.yesAsk === null) continue;

    const stationId = `RAIN_${market.cityCode}`;
    const city = CITIES[market.cityCode]!;
    const modelPct = Math.round(modelYes * 100);
    const sides: Array<{
      side: "YES" | "NO";
      probability: number;
      limitPrice: number;
      implied: number;
    }> = [
      { side: "YES", probability: modelYes, limitPrice: market.yesAsk, implied: market.yesAsk / 100 },
      { side: "NO", probability: 1 - modelYes, limitPrice: 100 - market.yesBid, implied: (100 - market.yesBid) / 100 },
    ];

    for (const side of sides) {
      const edgeNet = side.probability
        - side.implied
        - feeCeil(side.implied, config.fee_rate)
        - config.slippage_buffer;
      const suppressedReason = edgeNet < config.min_edge ? "below_threshold" : null;
      const signal: SignalRow = {
        ts_utc: nowIso,
        station_id: stationId,
        ticker: market.ticker,
        side: side.side,
        limit_price: side.limitPrice,
        model_prob: side.probability,
        implied_prob: side.implied,
        edge_net: edgeNet,
        inputs_hash: inputsHash(market.ticker, side.side, side.probability, nowIso),
        suppressed_reason: suppressedReason,
      };
      const signalId = await insertSignal(signal);
      if (suppressedReason) continue;

      live.push({
        signalId,
        candidate: {
          ticker: market.ticker,
          station_id: stationId,
          side: side.side,
          limit_price: side.limitPrice,
          edge_net: edgeNet,
          ts: now,
          headline: `Buy ${side.side}: rain in ${market.cityName} on ${discovery.date} at ${side.limitPrice}¢ — NWS sees ${Math.round(side.probability * 100)}%`,
          model_pct: Math.round(side.probability * 100),
          market_type: "rain",
          rain_context: {
            city: city.name,
            contract_date: discovery.date,
            forecast_rain_pct: modelPct,
            settlement_source: "The Weather Company",
          },
        },
      });
    }
  }

  logger.info(
    { date: discovery.date, markets: discovery.markets.length, live: live.length },
    "Rain signal cycle complete"
  );
  return live;
}