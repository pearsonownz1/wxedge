/**
 * Trader main loop — Phase A (shadow mode).
 *
 * Architecture:
 *   Every 4 minutes:
 *     1. runSignalEngine() — reads latest snapshots+books, emits signals
 *     2. For each live signal: placeOrder() — risk officer → shadow executor
 *     3. monitorOpenOrders() — simulate fills, expire TTLs, cancel on edge drop
 *     4. runSettlementAudit() — write settlements rows for closed days
 *
 *   Scheduled:
 *     21:00 UTC daily  — runDailyDigest()
 *     21:00 UTC Sunday — runWeeklyGateReport()
 *
 * Health endpoint:
 *   GET /health → 200 { status: 'ok', mode, cycle_count, last_cycle_ts }
 *   Required for Replit workflow health check.
 *
 * Kill switch:
 *   touch /tmp/trader_kill.flag  →  risk officer rejects all signals;
 *                                   open orders are expired at next tick.
 */

import http from "node:http";
import { config } from "./config.js";
import { runSignalEngine } from "./signalEngine.js";
import { placeOrder, monitorOpenOrders } from "./executor.js";
import { runSettlementAudit, runDailyDigest, runWeeklyGateReport } from "./auditor.js";
import pino from "pino";

const logger = pino({ name: "trader", level: process.env["LOG_LEVEL"] ?? "info" });

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
        status:          "ok",
        mode:            config.mode,
        cycle_count:     cycleCount,
        last_cycle_ts:   lastCycleTs || null,
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(PORT, () => {
  logger.info({ port: PORT, mode: config.mode }, "Trader health endpoint listening");
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

  // 3. Monitor open orders
  await monitorOpenOrders(config, now);
}

// ─── Scheduled job check ─────────────────────────────────────────────────────

async function runScheduledJobs(now: Date): Promise<void> {
  const date    = todayUtcDate();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();

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
    { mode: config.mode, initialDelayMs: INITIAL_DELAY_MS },
    "Trader starting — waiting for collector warmup"
  );

  await sleep(INITIAL_DELAY_MS);

  logger.info("Trader main loop starting");

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
