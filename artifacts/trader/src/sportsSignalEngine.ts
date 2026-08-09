/**
 * Sports Signal Engine — MLB pitcher strikeout props (KXMLBKS series).
 *
 * ── How the model works (education) ──────────────────────────────────────────
 *
 * The same edge framework used for weather applies here:
 *   edge = (model probability) − (market implied probability)
 *
 * For weather, our "model" is the US government's NBM temperature forecast.
 * For sports, our model is the Poisson distribution applied to strikeout counts.
 *
 * Why Poisson?
 *   Strikeouts are rare discrete events that happen at a roughly constant rate
 *   per inning. That's exactly the Poisson setting. If a pitcher gets 9 Ks per
 *   9 innings (K/9 = 9.0) and throws 6 innings today, the expected number of
 *   Ks is λ = (9/9) × 6 = 6.0. The probability of getting 7 or more is:
 *     P(K ≥ 7) = 1 − P(K ≤ 6) = 1 − Σ(e^−λ × λ^k / k!, k=0..6)
 *
 * Edge source:
 *   Kalshi's KXMLBKS series has markets like "Brady Singer: 6+ strikeouts?".
 *   If the market prices it at 30¢ (30% implied) but our Poisson model says 42%,
 *   we have a 12-point edge and buy YES at 30¢.
 *
 * Data sources (both free, no API key required):
 *   - MLB Stats API (statsapi.mlb.com) — pitcher K/9, innings per start
 *   - Kalshi KXMLBKS series — strikeout prop markets + orderbooks
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import { db, books } from "@workspace/db";
import { insertSignal, type SignalRow } from "./db.js";
import type { RiskConfig } from "./config.js";
import type { SignalCandidate } from "./riskOfficer.js";
import pino from "pino";

const logger = pino({ name: "sports-engine" });

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const MLB_API     = "https://statsapi.mlb.com/api/v1";
const UA          = "WxEdge/1.0";

// ─── Poisson math ─────────────────────────────────────────────────────────────

/**
 * Compute P(X ≥ n) for X ~ Poisson(lambda).
 *
 * Uses the complement: P(X ≥ n) = 1 − P(X ≤ n−1).
 * P(X ≤ n−1) is the cumulative sum of the Poisson PMF up to k = n−1.
 *
 * Recurrence relation used for efficiency:
 *   P(X = 0)   = e^(−λ)
 *   P(X = k+1) = P(X = k) × λ / (k+1)
 */
export function poissonAtLeast(n: number, lambda: number): number {
  if (lambda <= 0) return n <= 0 ? 1 : 0;
  let cumProb = 0;
  let term = Math.exp(-lambda);   // P(X = 0) = e^(−λ)
  for (let k = 0; k < n; k++) {
    cumProb += term;
    term *= lambda / (k + 1);     // P(X = k+1) from P(X = k)
  }
  return Math.max(0, Math.min(1, 1 - cumProb));
}

function feeCeil(price01: number, feeRate: number): number {
  return Math.ceil(feeRate * price01 * (1 - price01) * 100) / 100;
}

function inputsHash(ticker: string, side: string, ts: string): string {
  return createHash("sha256")
    .update(`sports:${ticker}:${side}:${ts}`)
    .digest("hex")
    .slice(0, 16);
}

// ─── MLB Stats API ─────────────────────────────────────────────────────────────

export interface PitcherStats {
  playerId:      number;
  fullName:      string;
  /** Strikeouts per 9 innings (season average). */
  k9:            number;
  /** Average innings per start — capped at 7 to avoid distortion from long outings. */
  avgIpPerStart: number;
  gamesStarted:  number;
}

/**
 * Search for a pitcher by full name in the MLB Stats API and return their
 * current-season pitching stats.
 *
 * Returns null if the pitcher has fewer than 3 starts or 15 IP (not enough
 * data to trust the K/9 rate estimate).
 */
async function fetchPitcherByName(name: string): Promise<PitcherStats | null> {
  try {
    const searchR = await fetch(
      `${MLB_API}/people/search?names=${encodeURIComponent(name)}&sportId=1`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) }
    );
    if (!searchR.ok) return null;
    const searchD = await searchR.json() as { people?: Array<{ id: number; fullName: string }> };
    const player = searchD.people?.[0];
    if (!player) return null;

    const statsR = await fetch(
      `${MLB_API}/people/${player.id}/stats?stats=season&group=pitching&season=2026`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) }
    );
    if (!statsR.ok) return null;
    const statsD = await statsR.json() as Record<string, unknown>;
    const stat = ((statsD.stats as Array<{ splits?: Array<{ stat: Record<string, unknown> }> }>)?.[0]?.splits?.[0]?.stat) ?? null;
    if (!stat) return null;

    const ks = Number(stat["strikeOuts"] ?? 0);
    const ip = parseFloat(String(stat["inningsPitched"] ?? "0"));
    const gs = Number(stat["gamesStarted"] ?? 0);

    // Require at least 3 starts / 15 IP to have a stable K/9 estimate
    if (ip < 15 || gs < 3) return null;

    const k9           = (ks / ip) * 9;
    const avgIpPerStart = Math.min(ip / gs, 7.0);

    return { playerId: player.id, fullName: name, k9, avgIpPerStart, gamesStarted: gs };
  } catch {
    return null;
  }
}

// ─── Kalshi KXMLBKS ───────────────────────────────────────────────────────────

interface KsMarket {
  ticker:      string;
  pitcherName: string;
  threshold:   number;  // e.g. 6 for "6+ strikeouts"
  yesBid:      number | null;
  yesAsk:      number | null;
}

interface KsEvent {
  eventTicker: string;
  title:       string;
  closeTime:   string;
  markets:     KsMarket[];
}

async function fetchKsEvents(): Promise<KsEvent[]> {
  const r = await fetch(
    `${KALSHI_BASE}/events?series_ticker=KXMLBKS&status=open&with_nested_markets=true&limit=30`,
    { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
  );
  if (!r.ok) {
    logger.warn({ status: r.status }, "KXMLBKS fetch failed");
    return [];
  }
  const d = await r.json() as { events?: Array<Record<string, unknown>> };
  const events: KsEvent[] = [];

  for (const e of d.events ?? []) {
    const markets: KsMarket[] = [];
    for (const m of (e["markets"] as Array<Record<string, unknown>> | undefined) ?? []) {
      // Title format: "Brady Singer: 6+ strikeouts?"
      const titleMatch = String(m["title"] ?? "").match(/^(.+?):\s*(\d+)\+\s*strikeouts?/i);
      if (!titleMatch) continue;

      markets.push({
        ticker:      String(m["ticker"]),
        pitcherName: titleMatch[1]!.trim(),
        threshold:   parseInt(titleMatch[2]!, 10),
        yesBid:      m["yes_bid"]  != null ? Number(m["yes_bid"])  : null,
        yesAsk:      m["yes_ask"]  != null ? Number(m["yes_ask"])  : null,
      });
    }

    if (markets.length > 0) {
      events.push({
        eventTicker: String(e["event_ticker"]),
        title:       String(e["title"] ?? ""),
        closeTime:   String(e["close_time"] ?? ""),
        markets,
      });
    }
  }

  return events;
}

/**
 * Fetch orderbook for a market and return best YES bid/ask in cents.
 *
 * Kalshi orderbook format:
 *   ob.yes = [[price_cents, size], ...] sorted best-to-worst YES bid
 *   ob.no  = [[price_cents, size], ...] sorted best-to-worst NO bid
 *   YES ask = 100 − best NO bid  (the best price you can buy YES at)
 */
async function fetchBook(ticker: string): Promise<{ bid: number | null; ask: number | null }> {
  try {
    const r = await fetch(`${KALSHI_BASE}/markets/${ticker}/orderbook`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { bid: null, ask: null };
    const d  = await r.json() as { orderbook?: { yes?: number[][]; no?: number[][] } };
    const ob = d.orderbook;
    const yesBid = (ob?.yes?.length ?? 0) > 0 ? ob!.yes![0]![0]! : null;
    const noBid  = (ob?.no?.length  ?? 0) > 0 ? ob!.no![0]![0]!  : null;
    const yesAsk = noBid !== null ? 100 - noBid : null;
    return { bid: yesBid, ask: yesAsk };
  } catch {
    return { bid: null, ask: null };
  }
}

// ─── Main engine ──────────────────────────────────────────────────────────────

/**
 * Run one sports signal cycle.
 *
 * Walk-through (educational):
 *  1. Fetch all open KXMLBKS events — these are today's + tomorrow's games.
 *  2. Parse pitcher names from market titles ("Brady Singer: 6+ strikeouts?").
 *  3. Look up each pitcher's K/9 and avg innings in MLB's free stats API.
 *  4. Compute Poisson lambda = (K/9 ÷ 9) × avg_innings_per_start.
 *  5. For each bracket (threshold n), compute P(K ≥ n).
 *  6. Compare to Kalshi's implied probability (bid/ask midpoint).
 *  7. If edge ≥ min_edge, emit a signal for the same approval pipeline.
 */
export async function runSportsSignalEngine(
  config: RiskConfig,
  now: Date,
): Promise<Array<{ candidate: SignalCandidate; signalId: number }>> {

  // Step 1: fetch Kalshi events
  let events: KsEvent[];
  try {
    events = await fetchKsEvents();
  } catch (err) {
    logger.warn({ err }, "Sports engine: Kalshi fetch failed — skipping cycle");
    return [];
  }

  if (events.length === 0) {
    logger.debug("Sports engine: no open KXMLBKS events");
    return [];
  }

  // Step 2: collect unique pitcher names and fetch stats in parallel
  const pitcherNames = [...new Set(events.flatMap((e) => e.markets.map((m) => m.pitcherName)))];

  const statsList = await Promise.all(pitcherNames.map(fetchPitcherByName));
  const pitcherMap = new Map<string, PitcherStats>();
  for (const s of statsList) {
    if (s) pitcherMap.set(s.fullName, s);
  }

  logger.info(
    { pitchersFound: pitcherMap.size, pitchersSearched: pitcherNames.length, events: events.length },
    "Sports engine: pitcher stats loaded"
  );

  const live: Array<{ candidate: SignalCandidate; signalId: number }> = [];

  // Step 3: generate signals per event
  for (const ev of events) {
    // Group markets by pitcher within this event
    const byPitcher = new Map<string, KsMarket[]>();
    for (const m of ev.markets) {
      const list = byPitcher.get(m.pitcherName) ?? [];
      list.push(m);
      byPitcher.set(m.pitcherName, list);
    }

    for (const [pitcherName, markets] of byPitcher.entries()) {
      const stats = pitcherMap.get(pitcherName);
      if (!stats) {
        logger.debug({ pitcherName }, "Sports engine: no stats — skipping pitcher");
        continue;
      }

      // Step 4: compute Poisson lambda
      //
      // lambda = strikeouts per inning × expected innings today
      //        = (K/9 ÷ 9) × avgIpPerStart
      //
      // Example: K/9 = 9.76 (Gerrit Cole), avgIp = 6.1
      //   lambda = (9.76/9) × 6.1 = 6.61
      //   P(K ≥ 7) ≈ 42%   — if Kalshi prices it at 30¢, buy YES
      //   P(K ≥ 9) ≈ 12%   — if Kalshi prices it at 20¢, buy NO
      const lambda = (stats.k9 / 9) * stats.avgIpPerStart;

      logger.debug({
        pitcher: pitcherName,
        k9:      stats.k9.toFixed(2),
        avgIp:   stats.avgIpPerStart.toFixed(1),
        lambda:  lambda.toFixed(2),
      }, "Sports engine: Poisson lambda");

      // Step 5: fetch books for markets missing inline quotes
      const sorted = [...markets].sort((a, b) => a.threshold - b.threshold);
      const withBooks = await Promise.all(sorted.map(async (m) => {
        if (m.yesBid !== null && m.yesAsk !== null) return m;
        const book = await fetchBook(m.ticker);
        return { ...m, yesBid: book.bid, yesAsk: book.ask };
      }));

      // Step 5b: write books to DB so the LLM approver payload builder can read them
      const pitcherKey = pitcherName.replace(/\s+/g, "_").toUpperCase(); // e.g. "BRADY_SINGER"
      const bookRows = withBooks
        .filter((m) => m.yesBid !== null && m.yesAsk !== null)
        .map((m) => ({
          tsUtc:        now,
          stationId:    pitcherKey,
          ticker:       m.ticker,
          bracketLo:    m.threshold,
          bracketHi:    null as number | null,
          yesBid:       m.yesBid!,
          yesAsk:       m.yesAsk!,
          noBid:        m.yesAsk !== null ? 100 - m.yesAsk : null,
          noAsk:        m.yesBid !== null ? 100 - m.yesBid : null,
          bidSize:      null as number | null,
          askSize:      null as number | null,
          coherentFlag: true,
        }));

      if (bookRows.length > 0) {
        try {
          await db.insert(books).values(bookRows);
        } catch (err) {
          logger.debug({ err }, "Sports engine: book insert failed (non-fatal, may be duplicate)");
        }
      }

      // Step 6: compute signals per bracket
      for (const m of withBooks) {
        if (m.yesBid === null || m.yesAsk === null) continue;

        const spread = m.yesAsk - m.yesBid;
        if (spread > 25) {
          logger.debug({ ticker: m.ticker, spread }, "Sports engine: spread too wide — skipping");
          continue;
        }

        // Model probability for P(K ≥ threshold)
        const modelProb = poissonAtLeast(m.threshold, lambda);

        // ── YES side: buy YES at ask (model says pitcher WILL reach threshold) ─
        {
          const execPrice  = m.yesAsk / 100;
          const fee        = feeCeil(execPrice, config.fee_rate ?? 0.07);
          const edgeNet    = modelProb - execPrice - fee - (config.slippage_buffer ?? 0.01);
          const suppressed = edgeNet < config.min_edge ? "below_threshold" : null;

          const row: SignalRow = {
            ts_utc:           now.toISOString(),
            station_id:       pitcherKey,
            ticker:           m.ticker,
            side:             "YES",
            limit_price:      m.yesAsk,
            model_prob:       modelProb,
            implied_prob:     m.yesAsk / 100,
            edge_net:         edgeNet,
            inputs_hash:      inputsHash(m.ticker, "YES", now.toISOString()),
            suppressed_reason: suppressed,
          };

          const signalId = await insertSignal(row);
          if (!suppressed) {
            live.push({
              signalId,
              candidate: {
                ticker:      m.ticker,
                station_id:  pitcherKey,
                side:        "YES",
                limit_price: m.yesAsk,
                edge_net:    edgeNet,
                ts:          now,
                headline:    `Buy YES: ${pitcherName} ${m.threshold}+ Ks at ${m.yesAsk}¢ — model sees ${Math.round(modelProb * 100)}%`,
                model_pct:   Math.round(modelProb * 100),
                market_type: "sports",
                sports_context: {
                  pitcher_name: pitcherName,
                  threshold:    m.threshold,
                  lambda:       Math.round(lambda * 100) / 100,
                  k9:           Math.round(stats.k9 * 100) / 100,
                  avg_ip:       Math.round(stats.avgIpPerStart * 10) / 10,
                },
              },
            });
          }
        }

        // ── NO side: buy NO at (100 − yesBid) — model says pitcher WON'T reach ─
        {
          const noAskCents  = 100 - m.yesBid;
          const execPrice   = noAskCents / 100;
          const fee         = feeCeil(execPrice, config.fee_rate ?? 0.07);
          const modelProbNo = 1 - modelProb;
          const edgeNet     = modelProbNo - execPrice - fee - (config.slippage_buffer ?? 0.01);
          const suppressed  = edgeNet < config.min_edge ? "below_threshold" : null;

          const row: SignalRow = {
            ts_utc:           now.toISOString(),
            station_id:       pitcherKey,
            ticker:           m.ticker,
            side:             "NO",
            limit_price:      noAskCents,
            model_prob:       modelProbNo,
            implied_prob:     noAskCents / 100,
            edge_net:         edgeNet,
            inputs_hash:      inputsHash(m.ticker, "NO", now.toISOString()),
            suppressed_reason: suppressed,
          };

          const signalId = await insertSignal(row);
          if (!suppressed) {
            live.push({
              signalId,
              candidate: {
                ticker:      m.ticker,
                station_id:  pitcherKey,
                side:        "NO",
                limit_price: noAskCents,
                edge_net:    edgeNet,
                ts:          now,
                headline:    `Buy NO: ${pitcherName} under ${m.threshold} Ks at ${noAskCents}¢ — model sees ${Math.round(modelProbNo * 100)}%`,
                model_pct:   Math.round(modelProbNo * 100),
                market_type: "sports",
                sports_context: {
                  pitcher_name: pitcherName,
                  threshold:    m.threshold,
                  lambda:       Math.round(lambda * 100) / 100,
                  k9:           Math.round(stats.k9 * 100) / 100,
                  avg_ip:       Math.round(stats.avgIpPerStart * 10) / 10,
                },
              },
            });
          }
        }
      }
    }
  }

  logger.info({ live: live.length, events: events.length }, "Sports signal cycle complete");
  return live;
}
