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
});
