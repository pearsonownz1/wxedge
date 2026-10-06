import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import app from "./app";
import { logger } from "./lib/logger";
import { warmCache } from "./lib/warmup";
import { isKalshiPollingEnabled } from "./lib/kalshiApi";
import { hasUnresolvedOrderSubmission } from "./lib/approvalsDb";

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

// ─── Production trader subprocess ─────────────────────────────────────────────
//
// In development the trader runs as its own workflow. In production there is no
// separate workflow, so the API server spawns the trader as a child process.
// The trader's built-in health server runs on TRADER_HEALTH_PORT (8091) to
// avoid colliding with the API server's PORT.

const IS_PRODUCTION = process.env["NODE_ENV"] !== "development";

// Walk up from dist/index.mjs → artifacts/api-server/dist/ → workspace root
const WORKSPACE_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../.."
);

const TRADER_HEALTH_PORT = 8091;
const TRADER_RESTART_BASE_MS = 10_000;  // 10s initial restart delay
const TRADER_RESTART_MAX_MS  = 30_000;  // cap at 30 s — DB kills idle conns; fast restart is better than long backoff

function spawnTrader(restartDelayMs: number = TRADER_RESTART_BASE_MS): void {
  const traderEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(TRADER_HEALTH_PORT), // avoid collision with api-server PORT
  };

  const proc: ChildProcess = spawn(
    "pnpm",
    ["--filter", "@workspace/trader", "run", "start"],
    {
      cwd: WORKSPACE_ROOT,
      env: traderEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  logger.info(
    { pid: proc.pid, execution_mode: "approval", traderHealthPort: TRADER_HEALTH_PORT },
    "Production trader process spawned"
  );

  // Pipe trader logs through the parent logger prefix so they're visible in
  // the deployment log stream without needing a separate log tail.
  proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  proc.on("exit", (code, signal) => {
    const nextDelay = Math.min(restartDelayMs * 2, TRADER_RESTART_MAX_MS);
    logger.warn(
      { code, signal, restartInMs: nextDelay },
      "Trader process exited — restarting with backoff"
    );
    setTimeout(() => spawnTrader(nextDelay), nextDelay);
  });

  proc.on("error", (err) => {
    logger.error({ err }, "Failed to spawn trader process");
  });
}

// ─── Server startup ────────────────────────────────────────────────────────────

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Boot-time polling visibility — a silent POLLING_ENABLED=false in the
  // deployment env once blanked the prod board with zero log evidence.
  logger.info(
    {
      kalshiPollingEnabled: isKalshiPollingEnabled(),
      POLLING_ENABLED: process.env["POLLING_ENABLED"] ?? "(unset)",
      NODE_ENV: process.env["NODE_ENV"] ?? "(unset)",
    },
    "Kalshi polling state at boot"
  );

  // Pre-warm the cache after the port is bound so the first request hits
  // live data instead of waiting 2–4 s for cold NWS/Kalshi fetches.
  warmCache().catch((err) => {
    logger.warn({ err }, "Cache pre-warm encountered an unexpected error");
  });

  // Periodic background refresh — keeps all feeds alive even when the UI
  // is idle (e.g. overnight on Replit Reserved VM).
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

  // Spawn the trader subprocess only in production (dev uses its own workflow).
  if (IS_PRODUCTION) {
    // Release ONLY exactly matched, operator-confirmed rejection intents using
    // the existing status-only reconciliation. Do not depend on a new proposal
    // to reach this path: a quiet market must not strand the safety block.
    hasUnresolvedOrderSubmission().then((unresolved) => {
      logger.info({ unresolved }, "Confirmed-rejection startup reconciliation complete");
      spawnTrader();
    }).catch((err) => {
      // Never clear unknown intents or retry orders on a reconciliation error.
      // The approval endpoint retains its existing fail-closed check.
      logger.error({ err }, "Startup reconciliation failed — unresolved intents remain blocked");
      spawnTrader();
    });
  } else {
    logger.info("Development mode — skipping trader subprocess (use the Trader workflow)");
  }
});
