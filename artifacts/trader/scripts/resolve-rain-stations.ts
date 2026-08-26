/**
 * Rain settlement station registry resolver.
 *
 * Fetches live KXRAIN events from Kalshi, parses each market's
 * rules_primary text for its settlement station (CLI code), and upserts
 * the registry (see @workspace/db rainStations module for the full
 * "add a new city" process).
 *
 * Safe to run repeatedly — it's also run automatically once a day by the
 * trader (see rainStationRegistryCycle in src/index.ts) so newly added
 * Kalshi cities get flagged low-confidence without manual intervention.
 *
 * Run with: pnpm --filter @workspace/trader run resolve-rain-stations
 */
import { db, resolveRainStationsFromKalshi, type KalshiRainMarketForResolution } from "@workspace/db";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const USER_AGENT = "SellingHighs/1.0 (rain-station-registry)";

interface KalshiMarket {
  ticker: string;
  rules_primary?: string;
}
interface KalshiEvent {
  event_ticker: string;
  markets?: KalshiMarket[];
}

export async function fetchLiveKxrainMarkets(): Promise<KalshiRainMarketForResolution[]> {
  const res = await fetch(
    `${KALSHI_BASE}/events?series_ticker=KXRAIN&status=open&with_nested_markets=true&limit=50`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`Kalshi events fetch failed: ${res.status}`);
  const body = (await res.json()) as { events?: KalshiEvent[] };

  const out: KalshiRainMarketForResolution[] = [];
  for (const event of body.events ?? []) {
    for (const market of event.markets ?? []) {
      const m = market.ticker.match(/^KXRAIN-\d{2}[A-Z]{3}\d{2}-([A-Z]+)$/);
      if (!m) continue;
      out.push({ cityCode: m[1]!, rulesPrimary: market.rules_primary ?? null });
    }
  }
  return out;
}

async function run() {
  const markets = await fetchLiveKxrainMarkets();
  console.log(`Fetched ${markets.length} live KXRAIN market rows across all open events.`);
  const { resolved, lowConfidence } = await resolveRainStationsFromKalshi(db, markets);
  console.log(`Resolved ${resolved} distinct cities.`);
  if (lowConfidence.length > 0) {
    console.log(`Low-confidence (station not yet verified — see rulesPrimarySample in rain_stations): ${lowConfidence.join(", ")}`);
  } else {
    console.log("All cities resolved to verified stations.");
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("resolve-rain-stations failed:", err);
    process.exit(1);
  });
