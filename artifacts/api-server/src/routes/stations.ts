/**
 * Station routes
 *   GET /api/stations
 *   GET /api/stations/:stationId
 *   GET /api/stations/:stationId/distribution
 */

import { Router, type IRouter } from "express";
import {
  STATIONS,
  STATION_IDS,
  isStation,
  getSeason,
} from "../lib/stations.js";
import { computeSettlementWindow } from "../lib/settlementWindow.js";
import {
  fetchIntradayObs,
  fetchTodayMaxForecast,
  fetchNbmPercentiles,
} from "../lib/nwsApi.js";
import { getBracketsForStation } from "../lib/kalshiApi.js";
import {
  buildBracketDistribution,
  bestEdge,
} from "../lib/distribution.js";
import { cache, TTL } from "../lib/cache.js";
import { resolveRunningHighF } from "../lib/iemMetar.js";

const router: IRouter = Router();

/**
 * Build feed status for a station.
 * NOTE: Forecast cache key uses lat:lon to match what fetchTodayMaxForecast writes.
 */
function buildFeedStatus(
  stationId: string,
  lat: number,
  lon: number,
  kalshiUsingStub: boolean
) {
  const nwsAge = cache.ageSeconds(`nws:obs:intraday:${stationId}`);
  const nbmAge = cache.ageSeconds(`nws:forecast:max:${lat.toFixed(4)}:${lon.toFixed(4)}`);
  const kalshiAge = cache.ageSeconds("kalshi:events");

  const nwsFresh = nwsAge <= TTL.NWS_OBS_MS / 1000;
  const nbmFresh = nbmAge <= TTL.NWS_FORECAST_MS / 1000;
  // Kalshi is "fresh" only if we have live data (not stubs) within TTL
  const kalshiFresh = !kalshiUsingStub && kalshiAge <= TTL.KALSHI_BOOK_MS / 1000;

  return {
    nwsObsAgeSeconds: Math.round(nwsAge === Infinity ? -1 : nwsAge),
    nbmAgeSeconds: Math.round(nbmAge === Infinity ? -1 : nbmAge),
    kalshiBookAgeSeconds: Math.round(kalshiAge === Infinity ? -1 : kalshiAge),
    calibrationAgeSeconds: 0, // hardcoded calibration is always "fresh"
    nwsFresh,
    nbmFresh,
    kalshiFresh,
    calibrationFresh: true,
    kalshiUsingStub,
  };
}

// GET /stations
router.get("/stations", async (req, res): Promise<void> => {
  const now = new Date();
  const season = getSeason(now);

  const stationSummaries = await Promise.all(
    STATION_IDS.map(async (id) => {
      const meta = STATIONS[id];
      const window = computeSettlementWindow(meta, now);
      const bias = meta.biasF[season];

      // Running high = true intraday max from all obs today, not just latest reading
      const [intradayObs, forecast, bracketResult] = await Promise.all([
        fetchIntradayObs(id, meta.lstOffset),
        fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
        getBracketsForStation(id, meta.lstOffset),
      ]);

      const runningHighF = await resolveRunningHighF(id, meta.lstOffset, intradayObs);
      const nbmMedianF = forecast?.maxTempF ?? runningHighF;

      // Fetch NBM percentile spread (falls back to Normal approx if unavailable)
      const percentiles = await fetchNbmPercentiles(
        meta.lat,
        meta.lon,
        meta.lstOffset,
        nbmMedianF,
        meta.rmse
      );

      const brackets = buildBracketDistribution(
        bracketResult.brackets,
        nbmMedianF,
        bias,
        meta.rmse,
        runningHighF,
        percentiles
      );

      const best = bestEdge(brackets);
      const feedStatus = buildFeedStatus(id, meta.lat, meta.lon, bracketResult.usingStubData);

      // Edge signals are only shown when ALL feeds are fresh (live data)
      const feedFresh = feedStatus.nwsFresh && feedStatus.kalshiFresh;
      const latestObs = intradayObs[intradayObs.length - 1];

      return {
        id,
        name: meta.name,
        runningHighF,
        bestBracket: best?.label ?? null,
        // bestEdge() only returns brackets with a non-null edge (quotable book),
        // so junk one-sided books can no longer pollute station divergence.
        bestEdgePts: feedFresh && best ? parseFloat(best.edgePts!.toFixed(1)) : null,
        isActionable: feedFresh && best ? Math.abs(best.edgePts!) >= 5 : false,
        settlementWindow: window,
        feedFresh,
        obsTimestampLst: latestObs?.timeLst ?? "–",
      };
    })
  );

  // Sort by absolute edge descending (stale stations sort to bottom)
  stationSummaries.sort((a, b) =>
    Math.abs(b.bestEdgePts ?? 0) - Math.abs(a.bestEdgePts ?? 0)
  );

  res.json(stationSummaries);
});

// GET /stations/:stationId
router.get("/stations/:stationId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.stationId)
    ? req.params.stationId[0]
    : req.params.stationId;
  const stationId = raw?.toUpperCase();

  if (!isStation(stationId)) {
    res.status(404).json({ error: `Station '${stationId}' not found` });
    return;
  }

  const meta = STATIONS[stationId];
  const now = new Date();
  const season = getSeason(now);
  const window = computeSettlementWindow(meta, now);
  const bias = meta.biasF[season];

  const [intradayObs, forecast] = await Promise.all([
    fetchIntradayObs(stationId, meta.lstOffset),
    fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
  ]);

  // Running high = IEM METAR (CLI-faithful) with NWS obs fallback
  const runningHighF = await resolveRunningHighF(stationId, meta.lstOffset, intradayObs);
  const nbmMedianF = forecast?.maxTempF ?? runningHighF;
  const calibratedMedianF = parseFloat((nbmMedianF + bias).toFixed(1));

  const feedStatus = buildFeedStatus(stationId, meta.lat, meta.lon, false);

  res.json({
    id: stationId,
    name: meta.name,
    lat: meta.lat,
    lon: meta.lon,
    runningHighF,
    nbmMedianF,
    calibratedMedianF,
    settlementWindow: window,
    calibration: {
      meanBias: bias,
      sigmaCalibrated: parseFloat((meta.rmse * 0.9).toFixed(2)),
      rmse: meta.rmse,
      pairCount: meta.pairCount,
      season,
      dataSource: "IEM/ACIS 90d rolling",
      lastUpdated: new Date().toISOString(),
    },
    intradayObs,
    feedFresh: feedStatus.nwsFresh && feedStatus.nbmFresh,
    feedStatus,
  });
});

// GET /stations/:stationId/distribution
router.get(
  "/stations/:stationId/distribution",
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.stationId)
      ? req.params.stationId[0]
      : req.params.stationId;
    const stationId = raw?.toUpperCase();

    if (!isStation(stationId)) {
      res.status(404).json({ error: `Station '${stationId}' not found` });
      return;
    }

    const meta = STATIONS[stationId];
    const now = new Date();
    const season = getSeason(now);
    const bias = meta.biasF[season];

    const [intradayObs, forecast, bracketResult] = await Promise.all([
      fetchIntradayObs(stationId, meta.lstOffset),
      fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
      getBracketsForStation(stationId, meta.lstOffset),
    ]);

    // True running high: IEM METAR (CLI-faithful) with NWS obs fallback
    const runningHighF = await resolveRunningHighF(stationId, meta.lstOffset, intradayObs);
    const nbmMedianF = forecast?.maxTempF ?? runningHighF;
    const calibratedMedianF = parseFloat((nbmMedianF + bias).toFixed(1));

    // Fetch NBM percentile spread (falls back to Normal approx if unavailable)
    const percentiles = await fetchNbmPercentiles(
      meta.lat,
      meta.lon,
      meta.lstOffset,
      nbmMedianF,
      meta.rmse
    );

    const brackets = buildBracketDistribution(
      bracketResult.brackets,
      nbmMedianF,
      bias,
      meta.rmse,
      runningHighF,
      percentiles
    );

    const best = bestEdge(brackets);
    const feedStatus = buildFeedStatus(
      stationId,
      meta.lat,
      meta.lon,
      bracketResult.usingStubData
    );
    const latestObs = intradayObs[intradayObs.length - 1];

    res.json({
      stationId,
      brackets,
      nbmMedianF,
      calibratedMedianF,
      biasAppliedF: bias,
      bestDivergencePts: best ? Math.abs(best.edgePts!) : 0,
      runningHighF,
      nbmSpread: percentiles,
      bookSnapshotTimeLst: latestObs?.timeLst ?? new Date().toISOString(),
      feedFresh: feedStatus.nwsFresh && feedStatus.kalshiFresh,
      feedStatus,
    });
  }
);

export default router;
