/**
 * Trader main loop — Phase A + Approval Mode.
 *
 * Architecture:
 *   Startup:
 *     - Sweep expired proposals (clear anything that lapsed while process was down)
 *
 *   Every 4 minutes:
 *     1. runSignalEngine() — reads latest snapshots+books, emits signals
 *     2. For each live signal: placeOrder() — risk officer → shadow executor or proposal
 *     3. monitorOpenOrders() — simulate fills, expire TTLs, cancel on edge drop
 *     4. sweepExpiredProposals() — expire any proposals past their TTL
 *     5. runSettlementAudit() — write settlements rows for closed days
 *
 *   Scheduled:
 *     21:00 UTC daily  — runDailyDigest()
 *     21:00 UTC Sunday — runWeeklyGateReport()
 *
 * Health endpoint:
 *   GET /health → 200 { status: 'ok', mode, execution_mode, cycle_count, last_cycle_ts }
 *
 * Kill switch:
 *   touch /tmp/trader_kill.flag  →  risk officer rejects all signals;
 *                                   open orders are expired at next tick.
 */

import http from "node:http";
import { config } from "./config.js";
import { runSignalEngine } from "./signalEngine.js";
import { placeOrder, monitorOpenOrders } from "./executor.js";
import { sweepExpiredProposals } from "./approvals.js";
import { runSettlementAudit, runDailyDigest, runWeeklyGateReport } from "./auditor.js";
import { pool } from "@workspace/db";
import pino from "pino";

const logger = pino({ name: "trader", level: process.env["LOG_LEVEL"] ?? "info" });

// ─── Leader election via Postgres advisory lock ────────────────────────────────
//
// Autoscale can run multiple API-server instances, each of which spawns a trader
// child process.  Only one trader should run at a time — concurrent traders would
// triple Kalshi polling (more 429s), race on risk reads, and generate duplicate
// proposals.
//
// Fix: on startup each instance tries pg_try_advisory_lock(LOCK_KEY).  The one
// that gets it becomes the leader and runs normally; the others log "standby" and
// retry every 60 s.  The lock is a Postgres SESSION-level lock: it is released
// automatically when the holding connection closes (i.e. when the process exits),
// giving the next standby instance a clean failover path.
//
// The dedicated pool connection is NEVER released back to the pool while the
// process lives — that is intentional; releasing it would drop the lock.

const ADVISORY_LOCK_KEY = 7827369; // arbitrary constant — "WX-TRADER"

let _leaderConn: Awaited<ReturnType<typeof pool.connect>> | null = null;

async function tryAcquireLeaderLock(): Promise<boolean> {
  const client = await pool.connect();
  const { rows } = await client.query(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [ADVISORY_LOCK_KEY]
  );
  if (rows[0]?.acquired === true) {
    _leaderConn = client; // hold forever — lock lives with this session

    // If the DB forcibly closes this connection (admin shutdown, failover, etc.)
    // the advisory lock is released automatically by Postgres.  We exit cleanly
    // so the API server's restart-with-backoff loop can spawn a fresh trader,
    // which will then race standby instances for the lock.
    client.on("error", (err) => {
      logger.error({ err, lockKey: ADVISORY_LOCK_KEY },
        "Leader lock connection lost — exiting so restart can re-acquire the lock");
      process.exit(1);
    });

    logger.info(
      { lockKey: ADVISORY_LOCK_KEY, mode: config.mode, execution_mode: config.execution_mode },
      "Advisory lock acquired — this instance is the trader leader"
    );
    return true;
  }
  client.release();
  return false;
}

async function waitForLeaderLock(): Promise<void> {
  const RETRY_MS = 60_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const acquired = await tryAcquireLeaderLock();
    if (acquired) return;
    logger.info(
      { retryInMs: RETRY_MS },
      "Standby — another trader instance holds the leader lock; retrying in 60 s"
    );
    await sleep(RETRY_MS);
  }
}

const POLL_INTERVAL_MS = 4 * 60 * 1000;   // 4 minutes
const INITIAL_DELAY_MS = 60 * 1000;       // 60s startup grace for collector

// ─── State ────────────────────────────────────────────────────────────────────

let cycleCount      = 0;
let lastCycleTs     = "";
let lastDigestDate  = "";
let lastGateDate    = "";

// ─── Health server ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env["PORT"] ?? "8090", 10);

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status:         "ok",
        mode:           config.mode,
        execution_mode: config.execution_mode,
        cycle_count:    cycleCount,
        last_cycle_ts:  lastCycleTs || null,
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(PORT, () => {
  logger.info(
    { port: PORT, mode: config.mode, execution_mode: config.execution_mode },
    "Trader health endpoint listening"
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Signal + execution cycle ─────────────────────────────────────────────────

async function runTradingCycle(now: Date): Promise<void> {
  const date = now.toISOString().slice(0, 10);

  // 1. Signal engine
  const liveSignals = await runSignalEngine(config, now);

  // 2. Risk officer → executor (in series to keep risk state consistent)
  for (const { candidate, signalId } of liveSignals) {
    try {
      await placeOrder(signalId, candidate, config, date);
    } catch (err) {
      logger.error({ err, signalId, ticker: candidate.ticker }, "placeOrder failed");
    }
  }

  // 3. Monitor open orders (fill simulation, TTL expiry, cancel on edge drop)
  await monitorOpenOrders(config, now);
}

// ─── Scheduled job check ─────────────────────────────────────────────────────

async function runScheduledJobs(now: Date): Promise<void> {
  const date    = todayUtcDate();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();

  // Proposal expiry sweep — runs every tick (idempotent)
  await sweepExpiredProposals();

  // Settlement audit runs every tick (idempotent; handles all stations internally)
  await runSettlementAudit(now);

  // Daily digest at 21:00–21:05 UTC
  if (utcHour === 21 && utcMin < 5 && lastDigestDate !== date) {
    lastDigestDate = date;
    await runDailyDigest(date, config.mode, config);
  }

  // Weekly gate report at 21:00–21:05 UTC on Sundays (day 0)
  if (utcHour === 21 && utcMin < 5 && now.getUTCDay() === 0 && lastGateDate !== date) {
    lastGateDate = date;
    await runWeeklyGateReport(now);
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info(
    { mode: config.mode, execution_mode: config.execution_mode },
    "Trader starting — acquiring leader lock"
  );

  // Block until this instance wins the Postgres advisory lock.
  // On Autoscale deployments multiple instances can be alive simultaneously;
  // only the lock-holder runs the trading loop.
  await waitForLeaderLock();

  logger.info(
    { initialDelayMs: INITIAL_DELAY_MS },
    "Trader is leader — waiting for collector warmup"
  );

  // Startup expiry sweep: clear proposals that lapsed while the process was down
  try {
    const swept = await sweepExpiredProposals();
    logger.info({ swept }, "Startup proposal sweep complete");
  } catch (err) {
    logger.warn({ err }, "Startup proposal sweep failed (non-fatal)");
  }

  await sleep(INITIAL_DELAY_MS);

  logger.info({ execution_mode: config.execution_mode }, "Trader main loop starting");

  while (true) {
    const tickStart = Date.now();
    const now = new Date(tickStart);

    try {
      await runTradingCycle(now);
    } catch (err) {
      logger.error({ err }, "Trading cycle failed");
    }

    try {
      await runScheduledJobs(now);
    } catch (err) {
      logger.error({ err }, "Scheduled jobs failed");
    }

    cycleCount++;
    lastCycleTs = now.toISOString();

    const elapsed  = Date.now() - tickStart;
    const nextWait = Math.max(0, POLL_INTERVAL_MS - elapsed);

    logger.debug({ cycleCount, elapsedMs: elapsed, nextWaitMs: nextWait }, "Cycle complete");
    await sleep(nextWait);
  }
}

main().catch((err) => {
  logger.error({ err }, "Trader crashed — exiting");
  process.exit(1);
});
