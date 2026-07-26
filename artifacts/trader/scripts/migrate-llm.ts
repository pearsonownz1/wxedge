/**
 * Migration: LLM approver schema additions.
 *
 * Adds columns to `approvals` and creates the `llm_decisions` audit table.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/trader run migrate-llm
 */

import { pool } from "@workspace/db";

const client = await pool.connect();

try {
  console.log("Running LLM approver migration…");

  await client.query("BEGIN");

  // ── New columns on approvals ──────────────────────────────────────────────
  await client.query(`
    ALTER TABLE approvals
      ADD COLUMN IF NOT EXISTS decider        text,
      ADD COLUMN IF NOT EXISTS llm_decision   text,
      ADD COLUMN IF NOT EXISTS llm_decided_ts timestamptz,
      ADD COLUMN IF NOT EXISTS llm_rationale  text,
      ADD COLUMN IF NOT EXISTS llm_confidence real;
  `);
  console.log("  ✓ approvals columns added");

  // ── llm_decisions audit table ─────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id             bigserial   PRIMARY KEY,
      approval_id    int         NOT NULL REFERENCES approvals(id),
      ts             timestamptz NOT NULL DEFAULT NOW(),
      model_name     text        NOT NULL,
      prompt_version text        NOT NULL,
      payload_json   jsonb       NOT NULL,
      response_json  jsonb,
      decision       text,
      latency_ms     int
    );

    CREATE INDEX IF NOT EXISTS llm_decisions_approval_idx ON llm_decisions (approval_id);
    CREATE INDEX IF NOT EXISTS llm_decisions_ts_idx       ON llm_decisions (ts);
  `);
  console.log("  ✓ llm_decisions table ready");

  await client.query("COMMIT");
  console.log("Migration complete.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("Migration failed:", err);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
