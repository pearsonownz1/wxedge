/**
 * Cache pre-warmer — called once after the server starts listening.
 *
 * Fans out NWS and Kalshi fetch calls for all configured stations so the
 * first user request hits warm cache instead of waiting 2–4 s for cold fetches.
 *
 * Failures are logged at WARN and do not prevent the server from serving requests.
 */

import { STATION_IDS, STATIONS } from "./stations.js";
import {
  fetchLatestObservation,
  fetchIntradayObs,
  fetchTodayMaxForecast,
  fetchNbmPercentiles,
  type IntradayPoint,
} from "./nwsApi.js";
import { fetchKalshiEvents } from "./kalshiApi.js";
import { logSnapshots } from "./snapshotLogger.js";
import { checkAndWriteOutcomes } from "./outcomeLogger.js";
import { logger } from "./logger.js";

async function warmStation(id: string): Promise<void> {
  const meta = STATIONS[id as keyof typeof STATIONS];

  // Fetch obs and forecast concurrently; each already catches internally,
  // but we add a safety net here too to keep warmStation from ever rejecting.
  const [latestObs, intradayObs, forecast] = await Promise.all([
    fetchLatestObservation(id, meta.lstOffset).catch((err) => {
      logger.warn({ err, stationId: id }, "warmup: fetchLatestObservation failed");
      return null;
    }),
    fetchIntradayObs(id, meta.lstOffset).catch((err) => {
      logger.warn({ err, stationId: id }, "warmup: fetchIntradayObs failed");
      return [] as IntradayPoint[];
    }),
    fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset).catch((err) => {
      logger.warn({ err, stationId: id }, "warmup: fetchTodayMaxForecast failed");
      return null;
    }),
  ]);

  // Derive nbmMedianF from forecast, falling back to running high, then 72°F.
  const runningHighF = intradayObs.reduce<number>(
    (max, p) => Math.max(max, p.tempF),
    latestObs?.tempF ?? 72
  );
  const nbmMedianF = forecast?.maxTempF ?? runningHighF;

  await fetchNbmPercentiles(
    meta.lat,
    meta.lon,
    meta.lstOffset,
    nbmMedianF,
    meta.rmse
  ).catch((err) => {
    logger.warn({ err, stationId: id }, "warmup: fetchNbmPercentiles failed");
  });
}

export async function warmCache(): Promise<void> {
  logger.info("Cache pre-warm starting");
  const start = Date.now();

  // Fetch Kalshi events once (shared across all stations) and all stations in parallel
  const results = await Promise.allSettled([
    fetchKalshiEvents().catch((err) => {
      logger.warn({ err }, "warmup: fetchKalshiEvents failed");
    }),
    ...STATION_IDS.map((id) => warmStation(id)),
  ]);

  const failures = results.filter((r) => r.status === "rejected").length;
  const elapsed = Date.now() - start;

  if (failures > 0) {
    logger.warn(
      { failures, totalMs: elapsed },
      "Cache pre-warm completed with errors"
    );
  } else {
    logger.info(
      { stations: STATION_IDS.length, totalMs: elapsed },
      "Cache pre-warm complete"
    );
  }

  // Persist bracket snapshots for the reliability curve (skips stubs).
  // Run in the background so a slow DB write never delays a request.
  logSnapshots().catch((err) => {
    logger.warn({ err }, "Snapshot logger encountered an error");
  });

  // Opportunistically close out prior days — fetches NWS CLI when available.
  checkAndWriteOutcomes().catch((err) => {
    logger.warn({ err }, "Outcome logger encountered an error");
  });
}
