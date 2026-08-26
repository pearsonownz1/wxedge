/**
 * Integration regression: reconciliation readiness for a legacy rain fill
 * whose ticker-derived settlement date differs from its UTC placement date.
 *
 * Run with: node --import tsx/esm --test src/auditorReconciliation.test.ts
 *
 * getReadyDailyPnlKeys/getMissingDailyPnlKeys must test settlement
 * readiness against each order's OWN settlement date (ticker-derived for
 * KXRAIN- rows), not blindly against its placement date — otherwise a
 * legacy rain fill placed on one UTC day for a contract settling on another
 * day never gets picked up by the digest scheduler, and its
 * already-correct settlement silently never reaches daily_pnl.
 *
 * This hits the real dev database directly (no schema changes; inserts are
 * cleaned up in `finally`) because the bug this guards against lives in the
 * SQL itself, not in any pure function.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getReadyDailyPnlKeys, getMissingDailyPnlKeys, insertSettlement } from "./db.js";

const STATION_ID = "RAIN_TEST_RECONCILE";
const TICKER = "KXRAIN-26AUG20-TESTXYZ"; // ticker date: 2026-08-20
const TICKER_DATE = "2026-08-20";
const PLACEMENT_DATE = "2026-08-21"; // placed a day after the contract's own date
const MODE = "shadow";

let orderId: number | null = null;

describe("reconciliation readiness — legacy rain fill on a different UTC date than its contract", () => {
  before(async () => {
    // A filled shadow order placed 2026-08-21 UTC for a contract whose
    // ticker date is 2026-08-20 — exactly the case that broke before this
    // fix (the readiness check tested settlement against placement date).
    const { rows } = await db.execute(sql`
      INSERT INTO orders (signal_id, mode, ts_placed, ticker, station_id, side, price_cents, count, status, fill_price_cents)
      VALUES (-1, ${MODE}, ${`${PLACEMENT_DATE}T23:50:00Z`}::timestamptz, ${TICKER}, ${STATION_ID}, 'NO', 20, 1, 'filled', 20)
      RETURNING id
    `);
    orderId = Number((rows[0] as { id: number }).id);

    // The settlement is correctly keyed by the ticker's own date (as
    // runRainSettlementAudit writes it), not the placement date.
    await insertSettlement({
      settlement_date: TICKER_DATE,
      station_id: STATION_ID,
      cli_high_f: null,
      app_high_f: null,
      kalshi_settled_bracket: `${TICKER}:NO`,
      match_flag: null,
      ts_utc: new Date().toISOString(),
    });
  });

  after(async () => {
    if (orderId !== null) await db.execute(sql`DELETE FROM orders WHERE id = ${orderId}`);
    await db.execute(sql`DELETE FROM settlements WHERE station_id = ${STATION_ID} AND settlement_date = ${TICKER_DATE}`);
  });

  it("is included in getReadyDailyPnlKeys under its placement-date bucket", async () => {
    const ready = await getReadyDailyPnlKeys();
    const found = ready.some((k) => k.date === PLACEMENT_DATE && k.mode === MODE);
    assert.ok(
      found,
      `expected (${PLACEMENT_DATE}, ${MODE}) to be ready — the order's settlement exists at its ` +
      `ticker-derived date (${TICKER_DATE}), which the readiness query must check instead of placement date`
    );
  });

  it("does not appear as a false reconciliation gap once ready", async () => {
    // If daily_pnl already has this (date, mode) row from other real trades,
    // this specific assertion is best-effort; the readiness check above is
    // the load-bearing regression. Here we just confirm missing-keys never
    // includes a key whose orders are actually fully settled by demanding
    // consistency: any key returned as ready must not simultaneously be
    // impossible to resolve (i.e. the settlement really is visible).
    const missing = await getMissingDailyPnlKeys();
    const readyKeys = await getReadyDailyPnlKeys();
    const readySet = new Set(readyKeys.map((k) => `${k.date}::${k.mode}`));
    for (const m of missing) {
      // A missing key must also be a ready key (settled but not yet
      // upserted) — never one whose settlement lookup used the wrong date
      // and therefore can never become ready.
      if (m.date === PLACEMENT_DATE && m.mode === MODE) {
        assert.ok(readySet.has(`${m.date}::${m.mode}`));
      }
    }
  });
});
