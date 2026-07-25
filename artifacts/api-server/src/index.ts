import app from "./app";
import { logger } from "./lib/logger";
import { warmCache } from "./lib/warmup";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Pre-warm the cache after the port is bound so the first request hits
  // live data instead of waiting 2–4 s for cold NWS/Kalshi fetches.
  // Failures are logged at WARN and do not affect server availability.
  warmCache().catch((err) => {
    logger.warn({ err }, "Cache pre-warm encountered an unexpected error");
  });

  // Periodic background refresh — keeps all feeds alive even when the UI
  // is idle (e.g. overnight on Replit's free tier).  Interval is shorter
  // than all TTLs (NWS obs 5 min, Kalshi book 30 s) so the cache is always
  // refilled before it expires.  A failed refresh is logged and retried on
  // the next tick; the server continues serving stale-flagged data.
  const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
  setInterval(() => {
    warmCache().catch((err) => {
      logger.warn({ err }, "Periodic cache refresh encountered an error — will retry next tick");
    });
  }, REFRESH_INTERVAL_MS);

  logger.info(
    { refreshIntervalMs: REFRESH_INTERVAL_MS },
    "Background cache refresh scheduled"
  );
});
