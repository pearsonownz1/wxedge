import { test } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { rejectApprovalOrderSubmission } from "./approvalsDb.js";
import { KalshiOrderPlacementError, type ConfirmedRejectedSubmission } from "./kalshiOrderErrors.js";

test("historical recovery changes only status; new rejections retain evidence; unknown intents remain blocked", async () => {
  const responseBody = '{"error":{"code":"insufficient_balance","message":"insufficient balance"}}';
  const evidence: ConfirmedRejectedSubmission = {
    orderId: 1, approvalId: 2, ticker: "KXHIGHAUS-26OCT04-B82.5", side: "YES",
    priceCents: 11, contracts: 10, tsPlaced: "2026-10-04T06:06:15.498Z",
    httpStatus: 400, responseBody,
  };
  const rejection = new KalshiOrderPlacementError(400, responseBody);
  try {
    await db.transaction(async tx => {
      // Session-local tables shadow the real tables. No real records are touched.
      await tx.execute(sql`
        CREATE TEMP TABLE orders (
          id int PRIMARY KEY, approval_id int, ticker text, side text,
          price_cents int, count int, ts_placed timestamptz, status text,
          kalshi_order_id text, ts_cancelled timestamptz, book_state_json text
        ) ON COMMIT DROP
      `);
      await tx.execute(sql`
        CREATE TEMP TABLE approvals (
          id int PRIMARY KEY, recheck_ok boolean, recheck_note text
        ) ON COMMIT DROP
      `);
      await tx.execute(sql`INSERT INTO approvals VALUES (2, true, NULL), (4, true, NULL)`);
      await tx.execute(sql`
        INSERT INTO orders (id, approval_id, ticker, side, price_cents, count, ts_placed, status)
        VALUES (1, 2, ${evidence.ticker}, 'YES', 11, 10, ${evidence.tsPlaced}::timestamptz, 'submitting'),
               (3, 4, ${evidence.ticker}, 'YES', 11, 10, ${evidence.tsPlaced}::timestamptz, 'submitting')
      `);
      assert.equal(await rejectApprovalOrderSubmission(1, rejection, { ...evidence, contracts: 9 }, tx), false);
      assert.equal(await rejectApprovalOrderSubmission(1, rejection, { ...evidence, tsPlaced: "2026-10-04T06:06:16Z" }, tx), false);
      assert.equal(await rejectApprovalOrderSubmission(1, rejection, evidence, tx), true);
      assert.equal(await rejectApprovalOrderSubmission(1, rejection, evidence, tx), false);
      const { rows } = await tx.execute(sql`
        SELECT o.id, o.status, o.book_state_json, o.ts_cancelled, a.recheck_ok, a.recheck_note
        FROM orders o JOIN approvals a ON a.id = o.approval_id ORDER BY o.id
      `);
      assert.equal(rows[0]?.status, "cancelled");
      assert.equal(rows[0]?.recheck_ok, true);
      assert.equal(rows[0]?.recheck_note, null);
      assert.equal(rows[0]?.book_state_json, null);
      assert.equal(rows[0]?.ts_cancelled, null);
      assert.equal(rows[1]?.status, "submitting");
      await assert.rejects(rejectApprovalOrderSubmission(3, new KalshiOrderPlacementError(500, responseBody), undefined, tx));
      assert.equal(await rejectApprovalOrderSubmission(3, rejection, undefined, tx), true);
      const { rows: newlyRejected } = await tx.execute(sql`
        SELECT o.status, o.book_state_json, a.recheck_ok, a.recheck_note
        FROM orders o JOIN approvals a ON a.id = o.approval_id WHERE o.id = 3
      `);
      assert.equal(newlyRejected[0]?.status, "cancelled");
      assert.equal(newlyRejected[0]?.recheck_ok, false);
      assert.equal(newlyRejected[0]?.recheck_note, "kalshi_rejected:insufficient_balance");
      assert.equal(JSON.parse(String(newlyRejected[0]?.book_state_json)).submission_rejection.response_body, responseBody);
    });
  } finally {
    await pool.end();
  }
});