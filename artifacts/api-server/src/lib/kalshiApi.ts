/**
 * Kalshi API client.
 *
 * NOTE ON WEATHER MARKETS: As of July 2026, daily high-temperature (KXHIGH)
 * contracts require an API key — they are not available on the unauthenticated
 * public API. Set the KALSHI_API_KEY environment secret to enable live data.
 *
 * Failure policy: FAIL LOUDLY. When Kalshi auth fails or the API is
 * unreachable, return empty brackets/book with usingStubData=true / isLive=false.
 * The route layer renders an empty board + error banner. NO synthetic prices,
 * NO stub rows, NO fake order books. A stub row in the approval queue is worse
 * than an empty queue.
 *
 * Date filter: only show events whose settlement date is today or in the future.
 * The Kalshi API occasionally returns stale closed events under status=open;
 * client-side filtering is the defensive backstop.
 */

import { cache, TTL } from "./cache.js";
import { logger } from "./logger.js";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const UA = "WxEdge/1.0 (kalshi-weather-edge)";

function getAuthHeaders(): Record<string, string> {
  const apiKey = process.env["KALSHI_API_KEY"];
  if (apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}

/** HTTP error from Kalshi — carries the status code for banner classification. */
class KalshiHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "KalshiHttpError";
  }
}

async function kalshiFetch(path: string): Promise<unknown> {
  const resp = await fetch(`${KALSHI_BASE}${path}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...getAuthHeaders(),
    },
  });
  if (!resp.ok) {
    // Log body to diagnose auth/permission errors in production.
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    throw new KalshiHttpError(
      resp.status,
      `Kalshi fetch ${path} → ${resp.status} ${resp.statusText}` +
      (body ? ` body=${body.slice(0, 200)}` : "")
    );
  }
  const text = await resp.text();
  if (text.startsWith("API has been moved")) {
    throw new KalshiHttpError(0, `Kalshi API moved: ${text.slice(0, 120)}`);
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

/** Why a Kalshi fetch cycle returned no live events, or null when data is live / no contracts yet. */
export type KalshiFailureReason = "auth_failed" | "rate_limited" | "network_error" | null;

export interface KalshiFetchResult {
  events: KalshiEvent[];
  /** True when no live events were available (API error, auth failure, or stale-filtered). */
  usingStubData: boolean;
  /**
   * True when Kalshi responded successfully but all events were rejected as stale.
   * Indicates "contracts not open yet today" — distinct from an auth/network failure.
   */
  allStaleFiltered: boolean;
  /** Classified failure reason. null when events are live or contracts just aren't open yet. */
  failureReason: KalshiFailureReason;
}

export interface OrderBookLevel {
  priceCents: number;
  size: number;
  side: "ask" | "bid";
  isBest: boolean;
}

export interface OrderBookResult {
  levels: OrderBookLevel[];
  /** True when the book was fetched live from the Kalshi API (not a stub). */
  isLive: boolean;
}

function marketToImpliedPct(bidCents: number | null, askCents: number | null): number {
  if (bidCents != null && askCents != null) {
    return Math.round((bidCents + askCents) / 2);
  }
  if (bidCents != null) return bidCents;
  if (askCents != null) return askCents;
  return 0;
}

/**
 * Parse the settlement date from a Kalshi event ticker.
 *
 * Kalshi's format is YYMMMDD — NOT DDMMMYY.
 * Example: "KXHIGHLAX-26JUL25" → year=2026, month=JUL, day=25 → 2026-07-25.
 *
 * Use only as a logged cross-check; prefer the API's own close_time field.
 */
function parseEventSettlementDate(eventTicker: string): Date | null {
  const match = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const [, yr, mon, day] = match; // YYMMMDD
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const m = months[mon!];
  if (m === undefined) return null;
  const d = new Date(Date.UTC(2000 + parseInt(yr!), m, parseInt(day!)));
  return d;
}

/**
 * Parse Kalshi market bracket boundaries from the structured `strike_type`,
 * `floor_strike`, and `cap_strike` fields (preferred over subtitle regex).
 */
function parseKalshiMarket(market: Record<string, unknown>): {
  label: string;
  lowerBoundF: number | null;
  upperBoundF: number | null;
  bidCents: number | null;
  askCents: number | null;
} {
  const subtitle = (market["subtitle"] ?? "") as string;
  const strikeType = (market["strike_type"] ?? "") as string;
  const floorStrike = market["floor_strike"] as number | undefined;
  const capStrike = market["cap_strike"] as number | undefined;

  let lowerBoundF: number | null = null;
  let upperBoundF: number | null = null;
  let label: string;

  if (strikeType === "less" && capStrike != null) {
    upperBoundF = capStrike - 1;
    label = `≤${upperBoundF}°`;
  } else if (strikeType === "between" && floorStrike != null && capStrike != null) {
    lowerBoundF = floorStrike;
    upperBoundF = capStrike;
    label = subtitle || `${lowerBoundF}–${upperBoundF}°`;
  } else if (strikeType === "greater" && floorStrike != null) {
    lowerBoundF = floorStrike + 1;
    label = `≥${lowerBoundF}°`;
  } else {
    label = subtitle;
  }

  const bidStr = market["yes_bid_dollars"] as string | null | undefined;
  const askStr = market["yes_ask_dollars"] as string | null | undefined;
  const bidCents = bidStr ? Math.round(parseFloat(bidStr) * 100) : null;
  const askCents = askStr ? Math.round(parseFloat(askStr) * 100) : null;

  return { label, lowerBoundF, upperBoundF, bidCents, askCents };
}

/**
 * Individual Kalshi series tickers — each city has its own series.
 * There is no unified "KXHIGH" series; fetches must be per-station.
 * KDFW is excluded: no events are currently listed for KXHIGHDFW.
 */
const STATION_SERIES: Record<string, string> = {
  KNYC: "KXHIGHNY",
  KMDW: "KXHIGHCHI",
  KAUS: "KXHIGHAUS",
  KLAX: "KXHIGHLAX",
  KPHL: "KXHIGHPHIL",
};

/** True when this process should actively poll Kalshi. Set POLLING_ENABLED=false in dev to avoid rate-limiting prod. */
function pollingEnabled(): boolean {
  const v = process.env["POLLING_ENABLED"];
  return v === undefined || v === "true" || v === "1";
}

export async function fetchKalshiEvents(): Promise<KalshiFetchResult> {
  if (!pollingEnabled()) {
    return { events: [], usingStubData: false, allStaleFiltered: false, failureReason: null };
  }

  const key = "kalshi:events";

  // Peek before get: save the stale entry BEFORE cache.get() deletes it on expiry.
  // Used as a fallback if the fresh fetch returns 429 or fails.
  const staleEntry = cache.peek<KalshiFetchResult>(key);

  const cached = cache.get<KalshiFetchResult>(key);
  if (cached) return cached.value;

  // Fan out one request per station series.
  const stationEntries = Object.entries(STATION_SERIES);

  // UTC midnight today — used to reject stale events that Kalshi hasn't
  // marked closed yet. Kalshi's weather markets for 26JUL25 continued to
  // appear as status=open well into 2026; client-side filtering is the
  // backstop. We use UTC midnight so the comparison is timezone-stable.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const perStationResults = await Promise.allSettled(
    stationEntries.map(async ([_stationId, series], i) => {
      if (i > 0) await new Promise((r) => setTimeout(r, i * 150));
      return (async () => {
        const data = (await kalshiFetch(
          `/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=1`
        )) as Record<string, unknown>;

        const events = (data["events"] as unknown[]) ?? [];
        if (events.length === 0) return null;

        const event = events[0] as Record<string, unknown>;
        const eventTicker = event["event_ticker"] as string;

        // Primary filter: use the API's own close_time timestamp if present.
        // Ticker format (YYMMMDD) is a convention that can change; close_time is the contract.
        const closeTimeRaw = event["close_time"] as string | undefined;
        const closeTime = closeTimeRaw ? new Date(closeTimeRaw) : null;

        if (closeTime && !isNaN(closeTime.getTime()) && closeTime < todayUtc) {
          logger.warn(
            { eventTicker, closeTime: closeTime.toISOString(), todayUtc: todayUtc.toISOString() },
            "Skipping event whose close_time is in the past"
          );
          return null;
        }

        // Cross-check: parsed ticker date vs close_time (or vs today if no close_time).
        // A disagreement is a format bug we want to catch early.
        const tickerDate = parseEventSettlementDate(eventTicker);
        if (tickerDate) {
          if (!closeTime) {
            // No close_time — fall back to ticker date as the stale guard.
            if (tickerDate < todayUtc) {
              logger.warn(
                { eventTicker, tickerDate: tickerDate.toISOString(), todayUtc: todayUtc.toISOString() },
                "Skipping stale event (no close_time; ticker date in the past)"
              );
              return null;
            }
          } else if (Math.abs(tickerDate.getTime() - closeTime.getTime()) > 2 * 24 * 3600 * 1000) {
            // Ticker date and close_time disagree by more than 2 days — log as invariant alarm.
            logger.warn(
              { eventTicker, tickerDate: tickerDate.toISOString(), closeTime: closeTime.toISOString() },
              "INVARIANT: parsed ticker date disagrees with API close_time by >2 days — check format"
            );
          }
        }

        const rawMarkets = (event["markets"] as unknown[]) ?? [];

        const brackets: KalshiBracket[] = rawMarkets
          .map((m) => {
            const market = m as Record<string, unknown>;
            const { label, lowerBoundF, upperBoundF, bidCents, askCents } =
              parseKalshiMarket(market);
            if (!label) return null;
            return {
              contractId: market["ticker"] as string,
              label,
              lowerBoundF,
              upperBoundF,
              bidCents,
              askCents,
              impliedPct: marketToImpliedPct(bidCents, askCents),
            } satisfies KalshiBracket;
          })
          .filter((b): b is KalshiBracket => b !== null && b.label !== "");

        brackets.sort(
          (a, b) => (a.lowerBoundF ?? -Infinity) - (b.lowerBoundF ?? -Infinity)
        );

        // Extract the settlement date string from the event ticker for logging/storage.
        const contractDate = eventTicker.replace(`${series}-`, "");

        return {
          stationPrefix: series,
          eventTicker,
          contractDate,
          brackets,
        } satisfies KalshiEvent;
      })();
    })
  );

  const result: KalshiEvent[] = [];
  let anyFailed = false;
  let anyStaleFiltered = false;
  let anyRateLimited = false;
  let anyAuthFailed = false;

  for (const r of perStationResults) {
    if (r.status === "fulfilled" && r.value != null) {
      result.push(r.value);
    } else if (r.status === "rejected") {
      const err = r.reason;
      const httpStatus = err instanceof KalshiHttpError ? err.status : null;
      logger.warn(
        { reason: String(err), httpStatus },
        "Kalshi per-station fetch failed"
      );
      if (httpStatus === 429) anyRateLimited = true;
      else if (httpStatus === 401 || httpStatus === 403) anyAuthFailed = true;
      else anyFailed = true;
    } else if (r.status === "fulfilled" && r.value === null) {
      // null means either no open events for the series, or the event was
      // stale-filtered. We set anyStaleFiltered speculatively; the warning
      // logs above will confirm which case it was.
      anyStaleFiltered = true;
    }
  }

  const usingStubData = result.length === 0;
  // allStaleFiltered = true when we got responses but every event was filtered
  // as past-dated (key is fine, today's contracts just haven't opened yet).
  const allStaleFiltered = usingStubData && anyStaleFiltered && !anyFailed && !anyRateLimited && !anyAuthFailed;

  // Classify why we got no live events. Priority: auth > rate limit > network > none.
  const failureReason: KalshiFailureReason = usingStubData
    ? anyAuthFailed   ? "auth_failed"
    : anyRateLimited  ? "rate_limited"
    : anyFailed       ? "network_error"
    : null
    : null;

  if (usingStubData) {
    // All stations returned empty (429s or no contracts). Before giving up,
    // serve the last-known-good stale entry so the board stays visible.
    if (staleEntry && !staleEntry.value.usingStubData) {
      logger.warn(
        { staleAgeMs: staleEntry.ageMs, anyFailed, allStaleFiltered },
        "Kalshi fetch returned no live events — serving stale cached data to avoid board blackout"
      );
      // Re-cache the stale value for a short window so the next request doesn't also hammer Kalshi.
      cache.set(key, staleEntry.value, Math.min(TTL.KALSHI_BOOK_MS / 4, 60_000));
      return staleEntry.value;
    }

    logger.warn(
      { hasApiKey: Boolean(process.env["KALSHI_API_KEY"]), anyFailed, allStaleFiltered },
      allStaleFiltered
        ? "All Kalshi events are stale (yesterday's contracts) — today's not open yet"
        : "Kalshi returned no live events for any station — board will be empty"
    );
  } else {
    logger.info(
      { stationsLive: result.length, anyFailed },
      "Kalshi events fetched live"
    );
  }

  const fetchResult: KalshiFetchResult = { events: result, usingStubData, allStaleFiltered, failureReason };
  // Only use the full 5-min TTL for live results. Failed results use a 30s retry window
  // so the system recovers quickly after a transient 429 or network error.
  cache.set(key, fetchResult, usingStubData ? 30_000 : TTL.KALSHI_BOOK_MS);
  return fetchResult;
}

/**
 * Fetch the live order book for a contract from Kalshi.
 * Returns empty levels (isLive: false) on any failure — NO synthetic prices.
 */
export async function fetchOrderBook(contractId: string): Promise<OrderBookResult> {
  if (!pollingEnabled()) {
    return { levels: [], isLive: false };
  }

  const key = `kalshi:book:${contractId}`;
  const cached = cache.get<OrderBookResult>(key);
  if (cached) return cached.value;

  try {
    const data = (await kalshiFetch(
      `/markets/${contractId}/orderbook`
    )) as Record<string, unknown>;

    const book = (data["orderbook_fp"] as Record<string, unknown>) ?? {};
    const yesBids = (book["yes_dollars"] as [number, number][]) ?? [];
    const noBids = (book["no_dollars"] as [number, number][]) ?? [];

    const bidLevels: OrderBookLevel[] = yesBids.map(([price, size], i) => ({
      priceCents: Math.round(price * 100),
      size,
      side: "bid" as const,
      isBest: i === 0,
    }));

    const askLevels: OrderBookLevel[] = noBids.map(([price, size], i) => ({
      priceCents: 100 - Math.round(price * 100),
      size,
      side: "ask" as const,
      isBest: i === 0,
    }));

    const levels = [...askLevels, ...bidLevels];

    if (levels.length === 0) {
      logger.warn(
        { contractId, hasApiKey: Boolean(process.env["KALSHI_API_KEY"]) },
        "Kalshi order book returned empty — no levels, not a live book"
      );
      const emptyResult: OrderBookResult = { levels: [], isLive: false };
      cache.set(key, emptyResult, TTL.KALSHI_BOOK_MS);
      return emptyResult;
    }

    logger.debug(
      { contractId, bidLevels: bidLevels.length, askLevels: askLevels.length },
      "Kalshi order book fetched live"
    );

    const liveResult: OrderBookResult = { levels, isLive: true };
    cache.set(key, liveResult, TTL.KALSHI_BOOK_MS);
    return liveResult;
  } catch (err) {
    logger.warn({ err, contractId }, "Kalshi order book fetch failed — no book available");
    return { levels: [], isLive: false };
  }
}

export interface BracketsResult {
  brackets: KalshiBracket[];
  /** True when brackets are hardcoded stubs, not from the live Kalshi API. */
  usingStubData: boolean;
}

/**
 * Enrich a bracket's bid/ask with the best levels from a live order book.
 * When `book.isLive` is false (empty/unavailable), returns the bracket unchanged.
 */
export function enrichBracketFromOrderBook(
  bracket: KalshiBracket,
  book: OrderBookResult
): KalshiBracket {
  if (!book.isLive) return bracket;

  const bestBid = book.levels.find((l) => l.side === "bid" && l.isBest);
  const bestAsk = book.levels.find((l) => l.side === "ask" && l.isBest);

  if (!bestBid && !bestAsk) return bracket;

  const bidCents = bestBid?.priceCents ?? null;
  const askCents = bestAsk?.priceCents ?? null;

  return {
    ...bracket,
    bidCents,
    askCents,
    impliedPct: marketToImpliedPct(bidCents, askCents),
  };
}

/**
 * Get bracket data for a specific station from live Kalshi data only.
 * Returns empty brackets (usingStubData: true) if the station is unknown
 * or no live event is available — never returns synthetic prices.
 */
export async function getBracketsForStation(
  stationId: string,
  _lstOffset: number
): Promise<BracketsResult> {
  const prefix = STATION_SERIES[stationId];
  if (!prefix) {
    // Station is intentionally excluded from Kalshi trading — not a data failure.
    // Do not set usingStubData; an absent series should not trigger the error banner.
    return { brackets: [], usingStubData: false };
  }

  const { events, usingStubData } = await fetchKalshiEvents();
  const event = events.find((e) => e.stationPrefix === prefix);
  if (!event || event.brackets.length === 0) {
    return { brackets: [], usingStubData: true };
  }

  return { brackets: event.brackets, usingStubData };
}
