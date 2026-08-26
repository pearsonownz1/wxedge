/**
 * Rain Signal Engine — daily Kalshi KXRAIN city contracts.
 *
 * The active KXRAIN contracts resolve YES when the named city records more than
 * 0 inches of precipitation on the contract date. The model uses the maximum
 * NWS hourly precipitation probability during that city's contract day.
 *
 * Safety (see .local/tasks/rain-markets-safe-live.md):
 *   - Every discovered market is run through checkRainEligibility() before it
 *     can produce a live signal. Ineligible markets are recorded as suppressed
 *     signals (never silently dropped) and never reach the risk officer.
 *   - Every live/suppressed signal carries reproducible evidence in
 *     rain_context: exactly which forecast/quote was used and when it was
 *     fetched, so a proposal or a suppression can be explained after the fact.
 *   - Kalshi book data served from the rate-limit fallback cache is
 *     staleness-bounded by config.max_age_min — old cached quotes never feed
 *     a live trade.
 *
 * Orders still go through the shared risk officer, approval queue, LLM, and
 * signed Kalshi order endpoint. This engine only discovers markets, calculates
 * probabilities, persists current books, and emits signal candidates.
 */

import { createHash } from "node:crypto";
import { db, books, getRainStationsMap, resolveRainStationsFromKalshi, type RainStationLookup } from "@workspace/db";
import { insertSignal, type SignalRow } from "./db.js";
import type { RiskConfig } from "./config.js";
import type { SignalCandidate } from "./riskOfficer.js";
import pino from "pino";

const logger = pino({ name: "rain-engine" });

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const NWS_BASE = "https://api.weather.gov";
const UA = "SellingHighs/1.0 (rain-market-model)";

/**
 * City metadata comes from the rain settlement station registry
 * (@workspace/db rainStations) — sourced from Kalshi's own rules_primary
 * settlement text, not a hardcoded city-center guess. A city with
 * confidence !== 'verified' has null lat/lon and is rejected by
 * checkRainEligibility with reason "station_unresolved" rather than
 * silently falling back to an approximate coordinate.
 */
type City = RainStationLookup;

interface RainMarket {
  ticker: string;
  cityCode: string;
  cityName: string;
  status: string;
  eventTicker: string;
  rawTitle: string | null;
  rawSubtitle: string | null;
  rawRules: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  yesBidSize: number | null;
  yesAskSize: number | null;
}

interface CachedDiscovery {
  date: string;
  markets: RainMarket[];
  fetchedAt: number; // epoch ms
}

let cachedDiscovery: CachedDiscovery | null = null;

// Auto-discovery: once a day, re-resolve the station registry against
// whatever KXRAIN markets are live right now, so a city Kalshi adds gets
// flagged low_confidence (and thus excluded, never silently guessed)
// without needing a human to notice and run the resolver script.
let lastRegistryResolveMs = 0;
const REGISTRY_RESOLVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function maybeRefreshStationRegistry(markets: RainMarket[], now: Date): Promise<void> {
  if (now.getTime() - lastRegistryResolveMs < REGISTRY_RESOLVE_INTERVAL_MS) return;
  lastRegistryResolveMs = now.getTime();
  try {
    const { lowConfidence } = await resolveRainStationsFromKalshi(
      db,
      markets.map((m) => ({ cityCode: m.cityCode, rulesPrimary: m.rawRules }))
    );
    if (lowConfidence.length > 0) {
      logger.warn({ lowConfidence }, "Rain engine: station registry has unresolved cities — see rain_stations.rules_primary_sample");
    }
    await getRainStationsMap(db, true); // bust the in-memory cache so this cycle sees new rows
  } catch (err) {
    logger.warn({ err }, "Rain engine: daily station registry refresh failed — keeping existing registry");
  }
}

/** Text that would indicate a market is NOT a daily-precipitation contract, even if it matched the KXRAIN ticker pattern. */
const DISALLOWED_SETTLEMENT_KEYWORDS = ["snow", "temperature", "wind speed", "hurricane", "high temp", "low temp"];

interface EligibilityResult {
  eligible: boolean;
  reason: string | null;
}

/**
 * Fail-closed contract validation, run before a market can produce a live
 * signal or appear in the public feed. Confirms: ticker/series structure,
 * known city, an active book, a local contract date that is actually
 * "current" for that city, and that any available settlement-terms text is
 * consistent with a daily-precipitation contract.
 */
export function checkRainEligibility(
  market: Pick<RainMarket, "ticker" | "cityCode" | "status" | "eventTicker" | "rawTitle" | "rawSubtitle" | "rawRules">,
  contractDateStr: string,
  city: City | undefined,
  now: Date
): EligibilityResult {
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
  // that the contract actually settles on precipitation, from whatever title/
  // subtitle/rules text Kalshi returns. Missing text is NOT treated as a pass
  // — a KXRAIN-ticker market with no title, subtitle, or rules text at all is
  // just as unverified as one with the wrong terms, so it's rejected too.
  const text = [market.rawTitle, market.rawSubtitle, market.rawRules].filter(Boolean).join(" ").toLowerCase();
  if (DISALLOWED_SETTLEMENT_KEYWORDS.some((kw) => text.includes(kw))) {
    return { eligible: false, reason: "settlement_terms_mismatch" };
  }
  if (!/rain|precip/i.test(text)) {
    return { eligible: false, reason: "settlement_terms_unverified" };
  }
  return { eligible: true, reason: null };
}

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

interface RainProbabilityEvidence {
  probability: number | null;
  /** When we made the NWS request (quote timing evidence). */
  fetchedAt: string;
  /** NWS's own `updateTime` for the forecast product, when present. */
  forecastUpdatedAt: string | null;
}

async function getAnyRainProbability(city: City, date: string): Promise<RainProbabilityEvidence> {
  // Only called for markets that already passed checkRainEligibility, which
  // requires confidence === "verified" (lat/lon/timeZone all non-null) —
  // this is defense-in-depth, not a real fallback path.
  if (city.lat === null || city.lon === null || city.timeZone === null) {
    return { probability: null, fetchedAt: new Date().toISOString(), forecastUpdatedAt: null };
  }
  const timeZone = city.timeZone;
  const fetchedAt = new Date().toISOString();
  const point = await fetch(`${NWS_BASE}/points/${city.lat},${city.lon}`, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!point.ok) return { probability: null, fetchedAt, forecastUpdatedAt: null };
  const pointData = await point.json() as { properties?: { forecastHourly?: string } };
  const forecastUrl = pointData.properties?.forecastHourly;
  if (!forecastUrl) return { probability: null, fetchedAt, forecastUpdatedAt: null };

  const forecast = await fetch(forecastUrl, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!forecast.ok) return { probability: null, fetchedAt, forecastUpdatedAt: null };
  const forecastData = await forecast.json() as {
    properties?: {
      updateTime?: string;
      periods?: Array<{
        startTime?: string;
        probabilityOfPrecipitation?: { value?: number | null };
      }>;
    };
  };

  const forecastUpdatedAt = forecastData.properties?.updateTime ?? null;
  const values = (forecastData.properties?.periods ?? [])
    .filter((period) => period.startTime && localIsoDate(new Date(period.startTime), timeZone) === date)
    .map((period) => period.probabilityOfPrecipitation?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => Math.max(0, Math.min(100, value)));

  if (values.length === 0) return { probability: null, fetchedAt, forecastUpdatedAt };
  return { probability: Math.max(...values) / 100, fetchedAt, forecastUpdatedAt };
}

async function fetchActiveRainMarkets(maxAgeMin: number): Promise<CachedDiscovery> {
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
      const eventTicker = String(event["event_ticker"] ?? "");
      const date = contractDate(eventTicker);
      if (!date) continue;
      const markets = ((event["markets"] as Array<Record<string, unknown>> | undefined) ?? [])
        .map((market) => {
          const ticker = String(market["ticker"] ?? "");
          const cityCode = ticker.split("-").at(-1) ?? "";
          return {
            ticker,
            cityCode,
            cityName: String(market["yes_sub_title"] ?? cityCode),
            status: String(market["status"] ?? ""),
            eventTicker,
            rawTitle: (market["title"] as string | undefined) ?? null,
            rawSubtitle: (market["yes_sub_title"] as string | undefined) ?? (market["subtitle"] as string | undefined) ?? null,
            rawRules: (market["rules_primary"] as string | undefined) ?? null,
            yesBid: toCents(market["yes_bid_dollars"]),
            yesAsk: toCents(market["yes_ask_dollars"]),
            yesBidSize: toSize(market["yes_bid_size_fp"]),
            yesAskSize: toSize(market["yes_ask_size_fp"]),
          };
        })
        .filter((market) => market.ticker);
      if (markets.length > 0) {
        cachedDiscovery = { date, markets, fetchedAt: Date.now() };
        return cachedDiscovery;
      }
    }
    return { date: "", markets: [], fetchedAt: Date.now() };
  }
  if (cachedDiscovery) {
    const ageMin = (Date.now() - cachedDiscovery.fetchedAt) / 60_000;
    if (ageMin > maxAgeMin) {
      throw new Error(`KXRAIN discovery failed and cached fallback is ${ageMin.toFixed(1)}min stale (limit ${maxAgeMin}min)`);
    }
    logger.warn(
      { markets: cachedDiscovery.markets.length, ageMin: ageMin.toFixed(1) },
      "Rain engine: using cached discovery after Kalshi rate limit"
    );
    return cachedDiscovery;
  }
  throw new Error("KXRAIN discovery failed after retry");
}

export async function runRainSignalEngine(
  config: RiskConfig,
  now: Date
): Promise<Array<{ candidate: SignalCandidate; signalId: number }>> {
  const discovery = await fetchActiveRainMarkets(config.max_age_min);
  if (discovery.markets.length === 0) {
    logger.info("Rain engine: no active KXRAIN markets");
    return [];
  }
  const kalshiQuoteFetchedAt = new Date(discovery.fetchedAt).toISOString();
  const kalshiQuoteStale = (Date.now() - discovery.fetchedAt) / 60_000 > 1; // used the rate-limit fallback cache, not this cycle's fetch
  await maybeRefreshStationRegistry(discovery.markets, now);
  const stations = await getRainStationsMap(db);

  // Step 1: fail-closed eligibility gate. Ineligible markets never reach the
  // risk officer and are excluded from probability lookups / book persistence.
  const eligibleMarkets: RainMarket[] = [];
  const nowIso = now.toISOString();
  for (const market of discovery.markets) {
    const city = stations.get(market.cityCode);
    const { eligible, reason } = checkRainEligibility(market, discovery.date, city, now);
    if (eligible) {
      eligibleMarkets.push(market);
      continue;
    }
    logger.warn({ ticker: market.ticker, reason }, "Rain engine: market failed eligibility check");
    // Record both sides as suppressed so the ineligibility is auditable, not silent.
    for (const side of ["YES", "NO"] as const) {
      await insertSignal({
        ts_utc: nowIso,
        station_id: `RAIN_${market.cityCode}`,
        ticker: market.ticker,
        side,
        limit_price: side === "YES" ? (market.yesAsk ?? 0) : (market.yesBid === null ? 0 : 100 - market.yesBid),
        model_prob: 0,
        implied_prob: 0,
        edge_net: -1,
        inputs_hash: inputsHash(market.ticker, side, 0, `ineligible:${reason}`),
        suppressed_reason: `ineligible_${reason}`,
      }).catch((err) => logger.warn({ err }, "Rain engine: failed to record ineligibility signal"));
    }
  }

  if (eligibleMarkets.length === 0) {
    logger.info("Rain engine: no eligible KXRAIN markets this cycle");
    return [];
  }

  const probabilityByCity = new Map<string, RainProbabilityEvidence>();
  await Promise.all(eligibleMarkets.map(async (market) => {
    const city = stations.get(market.cityCode)!;
    try {
      probabilityByCity.set(market.cityCode, await getAnyRainProbability(city, discovery.date));
    } catch (err) {
      logger.warn({ err, ticker: market.ticker }, "Rain engine: NWS forecast request failed");
      probabilityByCity.set(market.cityCode, { probability: null, fetchedAt: nowIso, forecastUpdatedAt: null });
    }
  }));

  await db.insert(books).values(
    eligibleMarkets.map((market) => ({
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

  for (const market of eligibleMarkets) {
    const stationId = `RAIN_${market.cityCode}`;
    const city = stations.get(market.cityCode)!;
    const evidence = probabilityByCity.get(market.cityCode);
    const modelYes = evidence?.probability ?? null;

    if (typeof modelYes !== "number" || market.yesBid === null || market.yesAsk === null) {
      const reason = typeof modelYes !== "number" ? "forecast_unavailable" : "no_price";
      for (const side of ["YES", "NO"] as const) {
        await insertSignal({
          ts_utc: nowIso,
          station_id: stationId,
          ticker: market.ticker,
          side,
          limit_price: side === "YES" ? (market.yesAsk ?? 0) : (market.yesBid === null ? 0 : 100 - market.yesBid),
          model_prob: 0,
          implied_prob: 0,
          edge_net: -1,
          inputs_hash: inputsHash(market.ticker, side, 0, `${reason}:${evidence?.fetchedAt ?? nowIso}`),
          suppressed_reason: reason,
        }).catch((err) => logger.warn({ err }, "Rain engine: failed to record suppressed signal"));
      }
      continue;
    }

    const modelPct = Math.round(modelYes * 100);
    const evidenceKey = `${evidence!.forecastUpdatedAt ?? "na"}:${evidence!.fetchedAt}:${kalshiQuoteFetchedAt}`;
    const sides: Array<{
      side: "YES" | "NO";
      probability: number;
      limitPrice: number;
      implied: number;
      // Contracts actually resting on the book at this price — bounds max-tilt sizing.
      availableSize: number | null;
    }> = [
      { side: "YES", probability: modelYes, limitPrice: market.yesAsk, implied: market.yesAsk / 100, availableSize: market.yesAskSize },
      { side: "NO", probability: 1 - modelYes, limitPrice: 100 - market.yesBid, implied: (100 - market.yesBid) / 100, availableSize: market.yesBidSize },
    ];

    for (const side of sides) {
      const edgeNet = side.probability
        - side.implied
        - feeCeil(side.implied, config.fee_rate)
        - config.slippage_buffer;
      let suppressedReason: string | null = edgeNet < config.min_edge ? "below_threshold" : null;
      if (!suppressedReason && kalshiQuoteStale) suppressedReason = "quote_stale";
      if (!suppressedReason && (side.availableSize === null || side.availableSize < 1)) suppressedReason = "no_liquidity";

      const signal: SignalRow = {
        ts_utc: nowIso,
        station_id: stationId,
        ticker: market.ticker,
        side: side.side,
        limit_price: side.limitPrice,
        model_prob: side.probability,
        implied_prob: side.implied,
        edge_net: edgeNet,
        inputs_hash: inputsHash(market.ticker, side.side, side.probability, evidenceKey),
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
          available_size: side.availableSize ?? undefined,
          settlement_date: discovery.date,
          rain_context: {
            city: city.cityName,
            contract_date: discovery.date,
            forecast_rain_pct: modelPct,
            settlement_source: city.settlementSource,
            settlement_station_id: city.stationId,
            settlement_station_name: city.stationName,
            station_confidence: city.confidence,
            probability_source: "NWS hourly probabilityOfPrecipitation (max over contract day)",
            probability_fetched_at: evidence!.fetchedAt,
            nws_forecast_updated_at: evidence!.forecastUpdatedAt,
            kalshi_quote_fetched_at: kalshiQuoteFetchedAt,
            kalshi_quote_stale: kalshiQuoteStale,
            settlement_terms_verified: true,
          },
        },
      });
    }
  }

  logger.info(
    { date: discovery.date, markets: discovery.markets.length, eligible: eligibleMarkets.length, live: live.length },
    "Rain signal cycle complete"
  );
  return live;
}