/**
 * Market routes
 *   GET /api/markets
 *   GET /api/markets/:contractId
 */

import { Router, type IRouter } from "express";
import { STATIONS, STATION_IDS, getSeason, isStation } from "../lib/stations.js";
import { computeSettlementWindow } from "../lib/settlementWindow.js";
import {
  fetchIntradayObs,
  fetchTodayMaxForecast,
  fetchNbmPercentiles,
} from "../lib/nwsApi.js";
import {
  getBracketsForStation,
  fetchKalshiEvents,
  fetchOrderBook,
  enrichBracketFromOrderBook,
  type OrderBookResult,
} from "../lib/kalshiApi.js";
import {
  buildBracketDistribution,
  getMarketStatus,
  runningHighFloorNote,
  lockinAmbiguityNote,
  MAX_SPREAD_CENTS,
} from "../lib/distribution.js";
import { cache, TTL } from "../lib/cache.js";

const router: IRouter = Router();

function bookSnapshotTime(): string {
  const d = new Date();
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s} UTC`;
}

function kalshiBookLatency(): number {
  const age = cache.ageSeconds("kalshi:events");
  return age === Infinity ? 0 : Math.round(age);
}

function runningHighFromObs(intradayObs: { tempF: number }[]): number {
  if (intradayObs.length === 0) return 72;
  return intradayObs.reduce((max, p) => Math.max(max, p.tempF), -Infinity);
}

/**
 * Book-quality gate — determines whether a bracket is actually ACTIONABLE.
 *
 * A bracket is NOT actionable if any of:
 *   - Data came from fallback (usingStubData)
 *   - Book is one-sided (missing bid or ask)
 *   - Spread > MAX_SPREAD_CENTS (≥ 20¢ indicates illiquid / stale book)
 *
 * On failure, downgrades "actionable" to "no_data" so the board and the
 * approval queue tell the same truth.
 */
function qualifiedStatus(
  rawStatus: "actionable" | "settled_short" | "below_threshold" | "locked" | "no_data",
  bidCents: number | null,
  askCents: number | null,
  usingStubData: boolean
): "actionable" | "settled_short" | "below_threshold" | "locked" | "no_data" {
  if (rawStatus !== "actionable") return rawStatus;

  if (usingStubData) return "no_data";
  if (bidCents === null || askCents === null) return "no_data";
  if (askCents - bidCents > MAX_SPREAD_CENTS) return "no_data";

  return "actionable";
}

// GET /markets
router.get("/markets", async (req, res): Promise<void> => {
  const now = new Date();
  const season = getSeason(now);

  let anyStubData = false;

  const allMarkets = await Promise.all(
    STATION_IDS.map(async (stationId) => {
      const meta = STATIONS[stationId];
      const bias = meta.biasF[season];

      const [intradayObs, forecast, bracketResult] = await Promise.all([
        fetchIntradayObs(stationId, meta.lstOffset),
        fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
        getBracketsForStation(stationId, meta.lstOffset),
      ]);

      if (bracketResult.usingStubData) {
        anyStubData = true;
        // No live data for this station — emit no rows rather than synthetic ones.
        return [];
      }

      const runningHighF = runningHighFromObs(intradayObs);
      const nbmMedianF = forecast?.maxTempF ?? runningHighF;

      const percentiles = await fetchNbmPercentiles(
        meta.lat,
        meta.lon,
        meta.lstOffset,
        nbmMedianF,
        meta.rmse
      );

      // Enrich with live order book bid/ask (parallelised, cached).
      const enrichedBrackets = await Promise.all(
        bracketResult.brackets.map(async (b) => {
          const book = await fetchOrderBook(b.contractId);
          return enrichBracketFromOrderBook(b, book);
        })
      );

      const brackets = buildBracketDistribution(
        enrichedBrackets,
        nbmMedianF,
        bias,
        meta.rmse,
        runningHighF,
        percentiles
      );

      return brackets.map((b) => ({
        contractId:  b.contractId ?? `${stationId}-UNKNOWN`,
        stationId,
        bracket:     b.label,
        modelPct:    b.modelPct,
        impliedPct:  b.impliedPct,
        bidCents:    b.bidCents,
        askCents:    b.askCents,
        edgeNetPts:  b.edgePts,
        status:      qualifiedStatus(getMarketStatus(b), b.bidCents, b.askCents, false),
        lockStatus:  b.lockStatus,
      }));
    })
  );

  // Flatten and sort: live rows by absolute edge first, then NO DATA rows
  // (junk books carry no ranking information), then settled/dead at the bottom.
  const flat = allMarkets.flat();
  const statusRank = (s: string): number =>
    s === "settled_short" ? 2 : s === "no_data" ? 1 : 0;
  flat.sort((a, b) => {
    const rankDiff = statusRank(a.status) - statusRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return Math.abs(b.edgeNetPts ?? 0) - Math.abs(a.edgeNetPts ?? 0);
  });

  const kalshiAge = cache.ageSeconds("kalshi:events");
  const feedFresh = !anyStubData && kalshiAge <= TTL.KALSHI_BOOK_MS / 1000;

  // fetchKalshiEvents is cached — this re-uses the in-memory result, no network call.
  const { allStaleFiltered, failureReason } = await fetchKalshiEvents();

  // Kalshi reads are fully public — no API key required. Drive feedStatusDetail
  // from the actual fetch outcome, not from whether an API key is present.
  const feedStatusDetail:
    | "live" | "auth_failed" | "rate_limited" | "network_error"
    | "polling_disabled" | "no_current_contracts" | "unavailable" =
    feedFresh
      ? "live"
      : failureReason === "polling_disabled"
        ? "polling_disabled"
        : failureReason === "auth_failed"
          ? "auth_failed"
          : failureReason === "rate_limited"
            ? "rate_limited"
            : failureReason === "network_error"
              ? "network_error"
              : (allStaleFiltered || (anyStubData && !failureReason))
                ? "no_current_contracts"  // 0 events with no error = markets not open yet
                : "unavailable";

  res.json({
    markets: flat,
    bookSnapshotTimeLst: bookSnapshotTime(),
    bookLatencySeconds:  kalshiBookLatency(),
    feedFresh,
    feedStatusDetail,
  });
});

// GET /markets/:contractId
router.get("/markets/:contractId", async (req, res): Promise<void> => {
  const contractId = Array.isArray(req.params.contractId)
    ? req.params.contractId[0]
    : req.params.contractId;

  if (!contractId) {
    res.status(400).json({ error: "Contract ID is required" });
    return;
  }

  const now = new Date();
  const season = getSeason(now);

  // Find which station owns this contract.
  let matchedStation: string | null = null;
  for (const id of STATION_IDS) {
    const meta = STATIONS[id];
    if (contractId.startsWith(meta.kalshiPrefix) || contractId.startsWith(id)) {
      matchedStation = id;
      break;
    }
  }

  if (!matchedStation || !isStation(matchedStation)) {
    res.status(404).json({ error: `Contract '${contractId}' not found` });
    return;
  }

  const meta = STATIONS[matchedStation];
  const bias = meta.biasF[season];

  const [intradayObs, forecast, bracketResult, orderBookResult] = await Promise.all([
    fetchIntradayObs(matchedStation, meta.lstOffset),
    fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
    getBracketsForStation(matchedStation, meta.lstOffset),
    fetchOrderBook(contractId),
  ]) as [
    Awaited<ReturnType<typeof fetchIntradayObs>>,
    Awaited<ReturnType<typeof fetchTodayMaxForecast>>,
    Awaited<ReturnType<typeof getBracketsForStation>>,
    OrderBookResult,
  ];

  if (bracketResult.usingStubData || bracketResult.brackets.length === 0) {
    // fetchKalshiEvents is cached — reuses the in-memory result, no extra network call.
    const { failureReason } = await fetchKalshiEvents();
    res.status(503).json({
      error: "Live Kalshi data unavailable for this station",
      feedStatusDetail: failureReason ?? "unavailable",
    });
    return;
  }

  const runningHighF = runningHighFromObs(intradayObs);
  const nbmMedianF = forecast?.maxTempF ?? runningHighF;
  const calibratedMedianF = parseFloat((nbmMedianF + bias).toFixed(1));

  const percentiles = await fetchNbmPercentiles(
    meta.lat,
    meta.lon,
    meta.lstOffset,
    nbmMedianF,
    meta.rmse
  );

  const enrichedBrackets = bracketResult.brackets.map((b) =>
    b.contractId === contractId
      ? enrichBracketFromOrderBook(b, orderBookResult)
      : b
  );

  const allBrackets = buildBracketDistribution(
    enrichedBrackets,
    nbmMedianF,
    bias,
    meta.rmse,
    runningHighF,
    percentiles
  );

  const targetBracket = allBrackets.find((b) => b.contractId === contractId);

  if (!targetBracket) {
    res.status(404).json({
      error: `Contract '${contractId}' not found in current bracket set`,
    });
    return;
  }

  const window = computeSettlementWindow(meta, now);
  const kalshiUrl = `https://kalshi.com/markets/${contractId.toLowerCase()}`;

  const kalshiAge = cache.ageSeconds("kalshi:events");
  const feedFresh =
    !bracketResult.usingStubData &&
    kalshiAge <= TTL.KALSHI_BOOK_MS / 1000 &&
    orderBookResult.isLive;

  // Kalshi reads are public — classify by the actual fetch outcome (cached, no network).
  const { failureReason } = await fetchKalshiEvents();
  const feedStatusDetail:
    | "live" | "auth_failed" | "rate_limited" | "network_error"
    | "polling_disabled" | "no_current_contracts" | "unavailable" =
    feedFresh
      ? "live"
      : failureReason === "polling_disabled"
        ? "polling_disabled"
        : failureReason === "auth_failed"
          ? "auth_failed"
          : failureReason === "rate_limited"
            ? "rate_limited"
            : failureReason === "network_error"
              ? "network_error"
              : !orderBookResult.isLive
                ? "unavailable"
                : "no_current_contracts";

  const rawStatus = getMarketStatus(targetBracket);
  const status = qualifiedStatus(
    rawStatus,
    targetBracket.bidCents,
    targetBracket.askCents,
    bracketResult.usingStubData
  );

  res.json({
    contractId,
    stationId:   matchedStation,
    stationName: meta.name,
    contractDate: window.contractDate,
    bracket:     targetBracket.label,
    modelPct:    targetBracket.modelPct,
    askCents:    targetBracket.askCents,
    edgeNetPts:  targetBracket.edgePts,
    status,
    disagreementBreakdown: {
      rawNbmMedianF:      nbmMedianF,
      biasLabel:          `${meta.name.split(",")[0]} ${season} bias correction`,
      biasAppliedF:       bias,
      calibratedMedianF,
      bracketMassPct:     targetBracket.modelPct,
      runningHighFloorNote: runningHighFloorNote(
        targetBracket.lowerBoundF,
        targetBracket.upperBoundF,
        runningHighF,
        targetBracket.modelPct
      ),
      lockinAmbiguityNote: lockinAmbiguityNote(targetBracket.lockStatus),
    },
    orderBook:       orderBookResult.levels,
    orderBookIsLive: orderBookResult.isLive,
    allBrackets,
    kalshiUrl,
    bookSnapshotTimeLst: bookSnapshotTime(),
    feedFresh,
    feedStatusDetail,
  });
});

export default router;
