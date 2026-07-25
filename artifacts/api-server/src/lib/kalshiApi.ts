/**
 * Kalshi API client.
 *
 * The trading-api.kalshi.com endpoint has been discontinued; the current
 * public base is https://api.elections.kalshi.com/trade-api/v2.
 *
 * NOTE ON WEATHER MARKETS: As of July 2026, daily high-temperature (KXHIGH)
 * contracts are not returned by the public unauthenticated API — they likely
 * require an API key or have been discontinued publicly. When live data cannot
 * be fetched, we fall back to deterministic stubs and set `usingStubData: true`
 * so callers can suppress edge signals and surface a clear warning to users.
 *
 * Bracket-ID drift risk (HIGH): always derive brackets from the live API, never
 * hardcode them. The stub brackets below are fallback only.
 */

import { cache, TTL } from "./cache.js";
import { logger } from "./logger.js";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const UA = "WxEdge/1.0 (kalshi-weather-edge)";

async function kalshiFetch(path: string): Promise<unknown> {
  const resp = await fetch(`${KALSHI_BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Kalshi fetch ${path} → ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  // Guard against migration-message plain-text responses
  if (text.startsWith("API has been moved")) {
    throw new Error(`Kalshi API moved: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text);
}

export interface KalshiBracket {
  contractId: string;   // market ticker, e.g. "KXHIGHNY-25JUL26-T91"
  label: string;        // "91–92°"
  lowerBoundF: number | null;
  upperBoundF: number | null;
  bidCents: number | null;
  askCents: number | null;
  /** mid-price as 0–100 */
  impliedPct: number;
}

export interface KalshiEvent {
  stationPrefix: string; // e.g. "KXHIGHNY"
  eventTicker: string;
  contractDate: string;
  brackets: KalshiBracket[];
}

export interface KalshiFetchResult {
  events: KalshiEvent[];
  /** True when the response is built from hardcoded stubs rather than live API data. */
  usingStubData: boolean;
}

export interface OrderBookLevel {
  priceCents: number;
  size: number;
  side: "ask" | "bid";
  isBest: boolean;
}

/** Parse Kalshi market ticker to extract bracket info.
 * Ticker format example: KXHIGHNY-25JUL26-T91 (above 91)
 * or KXHIGHNY-25JUL26-B8788 (between 87-88)
 */
function parseBracketLabel(
  ticker: string,
  subtitle: string
): { label: string; lowerBoundF: number | null; upperBoundF: number | null } {
  // Try to parse from subtitle first (more reliable)
  // e.g. "High of 91 to 92" or "High above 97" or "High at most 86"
  const subtitleLower = subtitle.toLowerCase();

  const aboveMatch = subtitleLower.match(/above\s+(\d+)/);
  if (aboveMatch) {
    return {
      label: `≥${aboveMatch[1]}°`,
      lowerBoundF: parseInt(aboveMatch[1], 10),
      upperBoundF: null,
    };
  }

  const mostMatch = subtitleLower.match(/at most\s+(\d+)/);
  if (mostMatch) {
    return {
      label: `≤${mostMatch[1]}°`,
      lowerBoundF: null,
      upperBoundF: parseInt(mostMatch[1], 10),
    };
  }

  const rangeMatch = subtitleLower.match(/(\d+)\s+to\s+(\d+)/);
  if (rangeMatch) {
    return {
      label: `${rangeMatch[1]}–${rangeMatch[2]}°`,
      lowerBoundF: parseInt(rangeMatch[1], 10),
      upperBoundF: parseInt(rangeMatch[2], 10),
    };
  }

  // Fall back: parse ticker suffix
  if (ticker.includes("-T")) {
    const m = ticker.match(/-T(\d+)$/);
    if (m) return { label: `≥${m[1]}°`, lowerBoundF: parseInt(m[1], 10), upperBoundF: null };
  }

  return { label: subtitle, lowerBoundF: null, upperBoundF: null };
}

function marketToImpliedPct(bidCents: number | null, askCents: number | null): number {
  if (bidCents != null && askCents != null) {
    return Math.round((bidCents + askCents) / 2);
  }
  if (bidCents != null) return bidCents;
  if (askCents != null) return askCents;
  return 0;
}

/** Map station ID to Kalshi event ticker prefix */
const STATION_TO_PREFIX: Record<string, string> = {
  KNYC: "KXHIGHNY",
  KMDW: "KXHIGHCHI",
  KAUS: "KXHIGHAUS",
  KDFW: "KXHIGHDFW",
  KLAX: "KXHIGHLAX",
  KPHL: "KXHIGHPHIL",
};

export async function fetchKalshiEvents(): Promise<KalshiFetchResult> {
  const key = "kalshi:events";
  const cached = cache.get<KalshiFetchResult>(key);
  if (cached) return cached.value;

  try {
    const data = (await kalshiFetch(
      "/events?series_ticker=KXHIGH&with_nested_markets=true&status=open"
    )) as Record<string, unknown>;

    const rawEvents = (data["events"] as unknown[]) ?? [];
    const result: KalshiEvent[] = [];

    for (const ev of rawEvents) {
      const event = ev as Record<string, unknown>;
      const eventTicker = event["event_ticker"] as string;
      const markets = (event["markets"] as unknown[]) ?? [];

      // Find which station prefix this event belongs to
      const stationPrefix = Object.values(STATION_TO_PREFIX).find((p) =>
        eventTicker.startsWith(p)
      );
      if (!stationPrefix) continue;

      const brackets: KalshiBracket[] = markets
        .map((m) => {
          const market = m as Record<string, unknown>;
          const ticker = market["ticker"] as string;
          const subtitle = (market["subtitle"] ?? market["title"] ?? "") as string;
          const { label, lowerBoundF, upperBoundF } = parseBracketLabel(ticker, subtitle);

          const yesAsk = market["yes_ask"] as number | null;
          const yesBid = market["yes_bid"] as number | null;
          const askCents = yesAsk != null ? Math.round(yesAsk * 100) : null;
          const bidCents = yesBid != null ? Math.round(yesBid * 100) : null;

          return {
            contractId: ticker,
            label,
            lowerBoundF,
            upperBoundF,
            bidCents,
            askCents,
            impliedPct: marketToImpliedPct(bidCents, askCents),
          };
        })
        .filter((b) => b.label !== "");

      // Sort brackets by lower bound (ascending, nulls first)
      brackets.sort((a, b) => {
        const aLow = a.lowerBoundF ?? -Infinity;
        const bLow = b.lowerBoundF ?? -Infinity;
        return aLow - bLow;
      });

      result.push({
        stationPrefix,
        eventTicker,
        contractDate: event["series_ticker"] as string,
        brackets,
      });
    }

    // If the API returned no KXHIGH events, weather markets likely require auth.
    // Use stubs and surface this explicitly so edge signals can be suppressed.
    const usingStubData = result.length === 0;
    if (usingStubData) {
      logger.warn(
        "Kalshi returned no KXHIGH events (may require auth). Using stub brackets — edge signals will be suppressed."
      );
    }

    const fetchResult: KalshiFetchResult = { events: result, usingStubData };
    cache.set(key, fetchResult, TTL.KALSHI_BOOK_MS);
    return fetchResult;
  } catch (err) {
    logger.warn({ err }, "Kalshi events fetch failed — using stub data");
    return { events: [], usingStubData: true };
  }
}

export async function fetchOrderBook(contractId: string): Promise<OrderBookLevel[]> {
  const key = `kalshi:book:${contractId}`;
  const cached = cache.get<OrderBookLevel[]>(key);
  if (cached) return cached.value;

  try {
    const data = (await kalshiFetch(
      `/markets/${contractId}/orderbook`
    )) as Record<string, unknown>;

    const book = (data["orderbook"] as Record<string, unknown>) ?? {};
    const asks = (book["asks"] as [number, number][]) ?? [];
    const bids = (book["bids"] as [number, number][]) ?? [];

    const levels: OrderBookLevel[] = [
      ...asks.map(([price, size], i) => ({
        priceCents: Math.round(price * 100),
        size,
        side: "ask" as const,
        isBest: i === asks.length - 1, // lowest ask is best
      })),
      ...bids.map(([price, size], i) => ({
        priceCents: Math.round(price * 100),
        size,
        side: "bid" as const,
        isBest: i === 0, // highest bid is best
      })),
    ];

    cache.set(key, levels, TTL.KALSHI_BOOK_MS);
    return levels;
  } catch (err) {
    logger.warn({ err, contractId }, "Kalshi order book fetch failed");
    return generateStubOrderBook(contractId);
  }
}

/** Realistic stub order book for when Kalshi API is unavailable */
function generateStubOrderBook(contractId: string): OrderBookLevel[] {
  // Hash the contractId to get a stable mid-price
  let hash = 0;
  for (const c of contractId) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  const mid = 20 + (Math.abs(hash) % 50);

  return [
    { priceCents: mid + 4, size: 180, side: "ask", isBest: false },
    { priceCents: mid + 2, size: 420, side: "ask", isBest: false },
    { priceCents: mid + 1, size: 1150, side: "ask", isBest: true },
    { priceCents: mid - 1, size: 960, side: "bid", isBest: true },
    { priceCents: mid - 2, size: 640, side: "bid", isBest: false },
    { priceCents: mid - 4, size: 310, side: "bid", isBest: false },
  ];
}

export interface BracketsResult {
  brackets: KalshiBracket[];
  /** True when brackets are hardcoded stubs, not from the live Kalshi API. */
  usingStubData: boolean;
}

/** Get bracket data for a specific station, using live Kalshi data or stubs. */
export async function getBracketsForStation(
  stationId: string,
  _lstOffset: number
): Promise<BracketsResult> {
  const prefix = STATION_TO_PREFIX[stationId];
  if (!prefix) return { brackets: getStubBrackets(stationId), usingStubData: true };

  const { events, usingStubData } = await fetchKalshiEvents();
  const event = events.find((e) => e.stationPrefix === prefix);
  if (!event || event.brackets.length === 0) {
    return { brackets: getStubBrackets(stationId), usingStubData: true };
  }

  return { brackets: event.brackets, usingStubData };
}

/** Hardcoded bracket fallbacks (used when Kalshi API is unavailable).
 * These reflect typical summer brackets per station.
 * WARNING: Bracket-ID drift means these may be stale. Always prefer live API data.
 */
function getStubBrackets(stationId: string): KalshiBracket[] {
  const bracketSets: Record<string, [number | null, number | null, string][]> = {
    KNYC: [
      [null, 86, "≤86°"], [87, 88, "87–88°"], [89, 90, "89–90°"],
      [91, 92, "91–92°"], [93, 94, "93–94°"], [95, 96, "95–96°"], [97, null, "≥97°"],
    ],
    KMDW: [
      [null, 78, "≤78°"], [79, 80, "79–80°"], [81, 82, "81–82°"],
      [83, 84, "83–84°"], [85, 86, "85–86°"], [87, 88, "87–88°"], [89, null, "≥89°"],
    ],
    KAUS: [
      [null, 96, "≤96°"], [97, 98, "97–98°"], [99, 100, "99–100°"],
      [101, 102, "101–102°"], [103, 104, "103–104°"], [105, 106, "105–106°"], [107, null, "≥107°"],
    ],
    KDFW: [
      [null, 96, "≤96°"], [97, 98, "97–98°"], [99, 100, "99–100°"],
      [101, 102, "101–102°"], [103, 104, "103–104°"], [105, 106, "105–106°"], [107, null, "≥107°"],
    ],
    KLAX: [
      [null, 78, "≤78°"], [79, 80, "79–80°"], [81, 82, "81–82°"],
      [83, 84, "83–84°"], [85, 86, "85–86°"], [87, 88, "87–88°"], [89, null, "≥89°"],
    ],
    KPHL: [
      [null, 84, "≤84°"], [85, 86, "85–86°"], [87, 88, "87–88°"],
      [89, 90, "89–90°"], [91, 92, "91–92°"], [93, 94, "93–94°"], [95, null, "≥95°"],
    ],
  };

  const defs = bracketSets[stationId] ?? bracketSets.KNYC;
  let hash = 0;
  for (const c of stationId) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  const baseMid = 20 + (Math.abs(hash) % 40);

  return defs.map(([lower, upper, label], i) => {
    const mid = baseMid + (i % 5) * 3;
    const bidCents = Math.max(1, mid - 2);
    const askCents = Math.min(99, mid + 2);
    return {
      contractId: `${stationId}-STUB-${i}`,
      label,
      lowerBoundF: lower,
      upperBoundF: upper,
      bidCents,
      askCents,
      impliedPct: mid,
    };
  });
}
