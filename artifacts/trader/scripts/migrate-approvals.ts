/**
 * One-time migration: add approvals table, signals.status, orders.approval_id.
 * Run with: pnpm --filter @workspace/trader run migrate
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function run() {
  await db.execute(sql`ALTER TABLE signals ADD COLUMN IF NOT EXISTS status text DEFAULT 'live'`);
  console.log("signals.status: ok");

  await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS approval_id integer`);
  console.log("orders.approval_id: ok");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id           serial PRIMARY KEY,
      signal_id    int NOT NULL REFERENCES signals(id) UNIQUE,
      ticker       text NOT NULL,
      side         text NOT NULL,
      proposed_ts  timestamptz NOT NULL,
      expires_ts   timestamptz NOT NULL,
      card_json    text,
      decision     text CHECK (decision IN ('approved','denied','expired')),
      decision_ts  timestamptz,
      latency_ms   bigint,
      recheck_ok   boolean,
      recheck_note text
    )
  `);
  console.log("approvals table: ok");

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_proposal
    ON approvals (ticker, side) WHERE decision IS NULL
  `);
  console.log("one_open_proposal index: ok");

  const { rows } = await db.execute(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_name IN ('signals','orders','approvals')
      AND column_name IN ('status','approval_id','id','signal_id','ticker','decision','latency_ms')
    ORDER BY table_name, column_name
  `);
  console.log("Verified columns:", JSON.stringify(rows));

  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
