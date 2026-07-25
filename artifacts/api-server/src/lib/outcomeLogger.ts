/**
 * Outcome logger — closes the prediction loop.
 *
 * Runs opportunistically on every poll cycle.  For each station that has
 * snapshot rows from a past settlement date but no outcome row, it fetches
 * the NWS CLI (Climatological Local Indication) daily report, parses the
 * MAXIMUM TEMPERATURE, and writes the outcome to PostgreSQL.
 *
 * The CLI is issued once per day, typically 6–9 AM local time the following
 * morning.  Multiple poll cycles will attempt the fetch and retry silently
 * until the product appears.  The outcome table has a UNIQUE constraint so
 * concurrent writes are safe.
 *
 * NWS API:
 *   GET /products/types/CLI/locations/{CODE}   → list, newest first
 *   GET /products/{productId}                  → { productText: "..." }
 */

import { STATIONS } from "./stations.js";
import { getUnclosedDates, hasOutcome, insertOutcome } from "./db.js";
import { logger } from "./logger.js";

/** 3-letter NWS CLI location codes for each settlement station. */
const CLI_LOCATION: Record<string, string> = {
  KNYC: "NYC",
  KMDW: "MDW",
  KAUS: "AUS",
  KDFW: "DFW",
  KLAX: "LAX",
  KPHL: "PHL",
};

const NWS_BASE = "https://api.weather.gov";
const NWS_HEADERS = { "User-Agent": "wx-edge/1.0 (wx-edge-collector)" };

async function nwsFetch(path: string): Promise<unknown> {
  const res = await fetch(`${NWS_BASE}${path}`, { headers: NWS_HEADERS });
  if (!res.ok) throw new Error(`NWS CLI fetch ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Parse the daily maximum temperature (°F) from a NWS CLI product text.
 *
 * The product contains a line like:
 *   MAXIMUM TEMPERATURE (F)      88    83     102    1999
 * or (older/minimal format):
 *   MAXIMUM TEMPERATURE          88
 */
function parseCliMaxTemp(productText: string): number | null {
  const match = productText.match(
    /MAXIMUM\s+TEMPERATURE\s+(?:\([^)]+\)\s+)?(\d+)/i
  );
  if (!match) return null;
  const t = parseInt(match[1]!, 10);
  return isNaN(t) ? null : t;
}

/**
 * Fetch the final daily high for one station on one settlement date.
 * Returns null if the CLI has not yet been issued for that date.
 */
async function fetchCliHigh(
  stationId: string,
  settlementDate: string  // YYYY-MM-DD in station LST
): Promise<number | null> {
  const code = CLI_LOCATION[stationId];
  if (!code) return null;

  const listData = await nwsFetch(`/products/types/CLI/locations/${code}`) as {
    "@graph": Array<{ id: string; issuanceTime: string }>;
  };

  const products = listData["@graph"] ?? [];
  if (products.length === 0) return null;

  // Walk the 5 most recent products; the CLI for settlementDate is typically
  // issued 0–1 UTC days after that LST date.
  for (const product of products.slice(0, 5)) {
    const issuedDate = product.issuanceTime.slice(0, 10); // YYYY-MM-DD
    const settle = new Date(settlementDate + "T12:00:00Z");
    const issued  = new Date(issuedDate     + "T12:00:00Z");
    const diffDays = Math.round((issued.getTime() - settle.getTime()) / 86_400_000);

    // Accept products issued on the same LST calendar day or the following UTC day
    if (diffDays >= 0 && diffDays <= 1) {
      const detail = await nwsFetch(`/products/${product.id}`) as {
        productText: string;
      };
      const high = parseCliMaxTemp(detail.productText ?? "");
      if (high !== null) return high;
    }
  }

  return null;
}

/**
 * For each station with unclosed snapshot dates (past days with no outcome),
 * attempt to fetch the CLI final high and write the outcome row.
 * Idempotent — safe to call on every poll cycle.
 */
export async function checkAndWriteOutcomes(): Promise<void> {
  const unclosed = await getUnclosedDates();
  if (unclosed.length === 0) return;

  const now = new Date();

  // Filter to dates that are strictly before today in each station's LST,
  // and de-duplicate (the query may return the same pair many times).
  const seen = new Set<string>();
  const toProcess = unclosed.filter(({ station_id, settlement_date }) => {
    const key = `${station_id}:${settlement_date}`;
    if (seen.has(key)) return false;
    seen.add(key);

    const meta = STATIONS[station_id as keyof typeof STATIONS];
    if (!meta) return false;

    const todayLstMs = now.getTime() + meta.lstOffset * 3_600_000;
    const todayIso   = new Date(todayLstMs).toISOString().slice(0, 10);
    return settlement_date < todayIso;
  });

  if (toProcess.length === 0) return;
  logger.info({ count: toProcess.length }, "Checking CLI outcomes for unclosed dates");

  await Promise.allSettled(
    toProcess.map(async ({ station_id, settlement_date }) => {
      // Re-check in case a concurrent call already wrote it
      if (await hasOutcome(station_id, settlement_date)) return;

      try {
        const high = await fetchCliHigh(station_id, settlement_date);
        if (high === null) return; // CLI not yet available; retry next cycle

        await insertOutcome({
          ts_utc:          now.toISOString(),
          station_id,
          settlement_date,
          final_high_f:    high,
          source:          "cli",
        });

        logger.info(
          { station_id, settlement_date, final_high_f: high },
          "CLI outcome written"
        );
      } catch (err) {
        logger.warn(
          { err, station_id, settlement_date },
          "outcomeLogger: CLI fetch failed — will retry next poll"
        );
      }
    })
  );
}
