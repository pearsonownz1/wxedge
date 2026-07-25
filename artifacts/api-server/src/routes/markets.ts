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
} from "../lib/nwsApi.js";
import {
  getBracketsForStation,
  fetchOrderBook,
} from "../lib/kalshiApi.js";
import {
  buildBracketDistribution,
  getMarketStatus,
  runningHighFloorNote,
  lockinAmbiguityNote,
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

/**
 * Running high = monotonic max over today's observations.
 * This is correct even when temperatures peak mid-day and drop afterward.
 */
function runningHighFromObs(intradayObs: { tempF: number }[]): number {
  if (intradayObs.length === 0) return 72;
  return intradayObs.reduce((max, p) => Math.max(max, p.tempF), -Infinity);
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

      if (bracketResult.usingStubData) anyStubData = true;

      // True running high from intraday max (not latest obs which may have dropped)
      const runningHighF = runningHighFromObs(intradayObs);
      const nbmMedianF = forecast?.maxTempF ?? runningHighF;

      const brackets = buildBracketDistribution(
        bracketResult.brackets,
        nbmMedianF,
        bias,
        meta.rmse,
        runningHighF
      );

      return brackets.map((b) => ({
        contractId: b.contractId ?? `${stationId}-UNKNOWN`,
        stationId,
        bracket: b.label,
        modelPct: b.modelPct,
        impliedPct: b.impliedPct,
        bidCents: b.bidCents,
        askCents: b.askCents,
        edgeNetPts: b.edgePts,
        status: getMarketStatus(b),
        lockStatus: b.lockStatus,
      }));
    })
  );

  // Flatten and sort by absolute edge (settled/dead brackets go to bottom)
  const flat = allMarkets.flat();
  flat.sort((a, b) => {
    if (a.status === "settled_short" && b.status !== "settled_short") return 1;
    if (b.status === "settled_short" && a.status !== "settled_short") return -1;
    return Math.abs(b.edgeNetPts) - Math.abs(a.edgeNetPts);
  });

  // feedFresh is false if Kalshi brackets are stubs (edge signals unreliable)
  const kalshiAge = cache.ageSeconds("kalshi:events");
  const feedFresh = !anyStubData && kalshiAge <= TTL.KALSHI_BOOK_MS / 1000;

  res.json({
    markets: flat,
    bookSnapshotTimeLst: bookSnapshotTime(),
    bookLatencySeconds: kalshiBookLatency(),
    feedFresh,
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

  // Find which station this contract belongs to — check kalshiPrefix first, then station ID prefix
  let matchedStation: string | null = null;
  for (const id of STATION_IDS) {
    const meta = STATIONS[id];
    if (contractId.startsWith(meta.kalshiPrefix) || contractId.startsWith(id)) {
      matchedStation = id;
      break;
    }
  }

  // Second pass: scan all station bracket lists (handles stub IDs like "KNYC-STUB-3")
  if (!matchedStation) {
    for (const id of STATION_IDS) {
      const meta = STATIONS[id];
      const { brackets } = await getBracketsForStation(id, meta.lstOffset);
      if (brackets.some((b) => b.contractId === contractId)) {
        matchedStation = id;
        break;
      }
    }
  }

  if (!matchedStation || !isStation(matchedStation)) {
    res.status(404).json({ error: `Contract '${contractId}' not found` });
    return;
  }

  const meta = STATIONS[matchedStation];
  const bias = meta.biasF[season];

  const [intradayObs, forecast, bracketResult, orderBook] = await Promise.all([
    fetchIntradayObs(matchedStation, meta.lstOffset),
    fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
    getBracketsForStation(matchedStation, meta.lstOffset),
    fetchOrderBook(contractId),
  ]);

  // True running high: intraday max, not latest obs temp
  const runningHighF = runningHighFromObs(intradayObs);
  const nbmMedianF = forecast?.maxTempF ?? runningHighF;
  const calibratedMedianF = parseFloat((nbmMedianF + bias).toFixed(1));

  const allBrackets = buildBracketDistribution(
    bracketResult.brackets,
    nbmMedianF,
    bias,
    meta.rmse,
    runningHighF
  );

  // Find the specific bracket for this contract — exact match only; no fallback.
  // A prefixed-but-unknown contractId must return 404, not a substitute bracket.
  const targetBracket = allBrackets.find((b) => b.contractId === contractId);

  if (!targetBracket) {
    res.status(404).json({ error: `Contract '${contractId}' not found in current bracket set` });
    return;
  }

  const window = computeSettlementWindow(meta, now);
  const kalshiUrl = `https://kalshi.com/markets/${contractId.toLowerCase()}`;

  const kalshiAge = cache.ageSeconds("kalshi:events");
  const feedFresh = !bracketResult.usingStubData && kalshiAge <= TTL.KALSHI_BOOK_MS / 1000;

  res.json({
    contractId,
    stationId: matchedStation,
    stationName: meta.name,
    contractDate: window.contractDate,
    bracket: targetBracket.label,
    modelPct: targetBracket.modelPct,
    askCents: targetBracket.askCents,
    edgeNetPts: targetBracket.edgePts,
    status: getMarketStatus(targetBracket),
    disagreementBreakdown: {
      rawNbmMedianF: nbmMedianF,
      biasLabel: `${meta.name.split(",")[0]} ${season} bias correction`,
      biasAppliedF: bias,
      calibratedMedianF,
      bracketMassPct: targetBracket.modelPct,
      runningHighFloorNote: runningHighFloorNote(
        targetBracket.lowerBoundF,
        targetBracket.upperBoundF,
        runningHighF,
        targetBracket.modelPct
      ),
      lockinAmbiguityNote: lockinAmbiguityNote(targetBracket.lockStatus),
    },
    orderBook,
    allBrackets,
    kalshiUrl,
    bookSnapshotTimeLst: bookSnapshotTime(),
    feedFresh,
  });
});

export default router;
