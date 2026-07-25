/**
 * Snapshot logger — called after every cache refresh.
 *
 * Computes the bracket distribution for each station from warm cached NWS/Kalshi
 * data and bulk-inserts one row per bracket into the PostgreSQL snapshots table.
 * Skips stations using stub Kalshi data (no live price = nothing useful to log).
 *
 * All external fetches hit the in-memory cache so this adds < 5 ms per poll.
 */

import { STATION_IDS, STATIONS, getSeason } from "./stations.js";
import {
  fetchIntradayObs,
  fetchTodayMaxForecast,
  fetchNbmPercentiles,
} from "./nwsApi.js";
import { getBracketsForStation } from "./kalshiApi.js";
import { buildBracketDistribution } from "./distribution.js";
import { computeSettlementWindow } from "./settlementWindow.js";
import { insertSnapshots, type SnapshotRow } from "./db.js";
import { logger } from "./logger.js";

/** Format a Date as YYYY-MM-DD in the given UTC offset (e.g. lstOffset = -5). */
function toIsoDate(utcNow: Date, lstOffset: number): string {
  const ms = utcNow.getTime() + lstOffset * 3_600_000;
  const d  = new Date(ms);
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

export async function logSnapshots(): Promise<void> {
  const now    = new Date();
  const tsUtc  = now.toISOString();
  const season = getSeason(now);

  const allRows: SnapshotRow[] = [];
  let skipped = 0;

  await Promise.allSettled(
    STATION_IDS.map(async (id) => {
      try {
        const meta   = STATIONS[id];
        const window = computeSettlementWindow(meta, now);

        const [intradayObs, forecast, bracketResult] = await Promise.all([
          fetchIntradayObs(id, meta.lstOffset),
          fetchTodayMaxForecast(meta.lat, meta.lon, meta.lstOffset),
          getBracketsForStation(id, meta.lstOffset),
        ]);

        // Only log live Kalshi data — stubs don't contribute to the reliability curve
        if (bracketResult.usingStubData) {
          skipped++;
          return;
        }

        const runningHighF = intradayObs.length > 0
          ? intradayObs.reduce((m, p) => Math.max(m, p.tempF), -Infinity)
          : 72;
        const nbmMedianF = forecast?.maxTempF ?? runningHighF;

        const percentiles = await fetchNbmPercentiles(
          meta.lat, meta.lon, meta.lstOffset, nbmMedianF, meta.rmse
        );

        const brackets = buildBracketDistribution(
          bracketResult.brackets,
          nbmMedianF,
          meta.biasF[season],
          meta.rmse,
          runningHighF,
          percentiles
        );

        const settlementDate = toIsoDate(now, meta.lstOffset);
        const calibratedMedian = nbmMedianF + meta.biasF[season];

        for (const b of brackets) {
          allRows.push({
            ts_utc:          tsUtc,
            station_id:      id,
            settlement_date: settlementDate,
            hours_to_settle: window.hoursRemaining,
            running_high_f:  runningHighF,
            nbm_median_f:    calibratedMedian,
            bracket_lower_f: b.lowerBoundF,
            bracket_upper_f: b.upperBoundF,
            bracket_label:   b.label,
            model_pct:       b.modelPct,
            implied_pct:     b.impliedPct,
            bid_cents:       b.bidCents,
            ask_cents:       b.askCents,
            edge_pts:        b.edgePts,
            lock_status:     b.lockStatus,
          });
        }
      } catch (err) {
        logger.warn({ err, stationId: id }, "snapshotLogger: failed to build station snapshot");
      }
    })
  );

  if (allRows.length > 0) {
    await insertSnapshots(allRows);
    logger.debug({ written: allRows.length, skipped }, "Snapshots persisted");
  }
}
