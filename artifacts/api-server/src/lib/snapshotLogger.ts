/**
 * Snapshot logger — called after every cache refresh.
 *
 * Per poll cycle, for each live station (non-stub Kalshi data):
 *   1. Run the book-coherence invariant check.
 *   2. Write one books row per bracket (regardless of coherence).
 *   3. Detect collector gaps (last snapshot > max_age_min ago).
 *   4. Write one snapshots row per bracket with obs_age_s and gap_flag.
 *
 * The signal engine reads from both tables; suppression of incoherent stations
 * and gap-flagged rows is the signal engine's responsibility.
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
import {
  insertSnapshots,
  insertBooks,
  getLastSnapshotTsPerStation,
  type SnapshotRow,
  type BookRow,
} from "./db.js";
import { logger } from "./logger.js";

const MAX_AGE_MIN = 10;  // Gap detection threshold (matches signal engine config default)

/** Format a Date as YYYY-MM-DD in the given UTC offset (e.g. lstOffset = -5). */
function toIsoDate(utcNow: Date, lstOffset: number): string {
  const ms = utcNow.getTime() + lstOffset * 3_600_000;
  const d  = new Date(ms);
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

/**
 * Book-coherence invariant.
 *
 * In a well-formed exclusive binary market the YES prices must satisfy:
 *   sum(YES asks) ∈ [100, 115] cents  — below 100 is an arbitrage; above 115 is suspicious
 *   sum(YES bids) ≤ 100 cents         — above 100 would allow selling all for > $1
 *
 * Returns true when the book passes both checks.
 */
function isBookCoherent(
  brackets: Array<{ bidCents: number | null; askCents: number | null }>
): boolean {
  const sumAsk = brackets.reduce((s, b) => s + (b.askCents ?? 0), 0);
  const sumBid = brackets.reduce((s, b) => s + (b.bidCents ?? 0), 0);
  return sumAsk >= 100 && sumAsk <= 115 && sumBid <= 100;
}

export async function logSnapshots(): Promise<void> {
  const now    = new Date();
  const tsUtc  = now.toISOString();
  const season = getSeason(now);

  // Fetch last snapshot timestamps ONCE before the per-station loop.
  const lastSnapshotTs = await getLastSnapshotTsPerStation().catch(() => ({} as Record<string, Date>));

  const allSnapshotRows: SnapshotRow[] = [];
  const allBookRows: BookRow[]         = [];
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

        // Only log live Kalshi data
        if (bracketResult.usingStubData) {
          skipped++;
          return;
        }

        // ── Observation age ────────────────────────────────────────────────────
        let obsAgeS: number | null = null;
        if (intradayObs.length > 0) {
          const latestObs = intradayObs[intradayObs.length - 1]!;
          const obsMs = new Date(latestObs.tsUtc).getTime();
          if (!isNaN(obsMs)) {
            obsAgeS = Math.round((now.getTime() - obsMs) / 1000);
          }
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

        // ── Book coherence ────────────────────────────────────────────────────
        const coherent = isBookCoherent(bracketResult.brackets);
        if (!coherent) {
          const sumAsk = bracketResult.brackets.reduce((s, b) => s + (b.askCents ?? 0), 0);
          const sumBid = bracketResult.brackets.reduce((s, b) => s + (b.bidCents ?? 0), 0);
          logger.warn(
            { stationId: id, sumAsk, sumBid },
            "Book-coherence invariant FAILED — signals suppressed for this station"
          );
        }

        // ── Gap detection ─────────────────────────────────────────────────────
        const lastTs      = lastSnapshotTs[id];
        const gapMinutes  = lastTs
          ? (now.getTime() - lastTs.getTime()) / 60_000
          : null;
        const gapFlag     = gapMinutes !== null && gapMinutes > MAX_AGE_MIN;

        if (gapFlag) {
          logger.warn(
            { stationId: id, gapMinutes: gapMinutes?.toFixed(1) },
            "Collector gap detected — gap_flag=true on this batch"
          );
        }

        // ── Books rows ────────────────────────────────────────────────────────
        for (const b of bracketResult.brackets) {
          allBookRows.push({
            ts_utc:        tsUtc,
            station_id:    id,
            ticker:        b.contractId,
            bracket_lo:    b.lowerBoundF,
            bracket_hi:    b.upperBoundF,
            yes_bid:       b.bidCents,
            yes_ask:       b.askCents,
            no_bid:        b.askCents !== null ? 100 - b.askCents : null,
            no_ask:        b.bidCents !== null ? 100 - b.bidCents : null,
            coherent_flag: coherent,
          });
        }

        // ── Snapshot rows ─────────────────────────────────────────────────────
        const settlementDate    = toIsoDate(now, meta.lstOffset);
        const calibratedMedian  = nbmMedianF + meta.biasF[season];

        for (const b of brackets) {
          allSnapshotRows.push({
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
            obs_age_s:       obsAgeS,
            gap_flag:        gapFlag || null,
          });
        }
      } catch (err) {
        logger.warn({ err, stationId: id }, "snapshotLogger: failed to build station snapshot");
      }
    })
  );

  // Persist books first (signal engine reads them by ts_utc join)
  if (allBookRows.length > 0) {
    await insertBooks(allBookRows);
  }

  if (allSnapshotRows.length > 0) {
    await insertSnapshots(allSnapshotRows);
    logger.debug(
      { snapshotRows: allSnapshotRows.length, bookRows: allBookRows.length, skipped },
      "Snapshots and books persisted"
    );
  }
}
