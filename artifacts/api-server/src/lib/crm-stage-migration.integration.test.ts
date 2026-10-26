import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { migratePipelineStages } from "./crmStageMigration";
import type { Client } from "./crmData";

test("Stage migration changes only status, preserves history, is idempotent and rolls back on failure", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // pg_temp only: these names cannot resolve to any public CRM tables.
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query("CREATE TEMP TABLE crm_investors(id integer PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()) ON COMMIT DROP");
    await client.query("CREATE TEMP TABLE crm_activities(id serial PRIMARY KEY, investor_id integer, message text, kind text, created_at timestamptz DEFAULT now()) ON COMMIT DROP");
    const originals = ["New", "Enriched", "Pitch Drafted", "Approved to Send", "Contacted", "Followed Up", "Responded", "Meeting Set", "Passed", "Committed"];
    for (let index = 0; index < originals.length; index++) {
      await client.query("INSERT INTO crm_investors(id,data) VALUES($1,$2::jsonb)", [index + 1, JSON.stringify({
        name: `Temporary sample ${index}`, expert_field: ["Law Firms", "Chinese Law", "Indian Law"][index % 3],
        status: originals[index], pitch_body: "Preserved text", notes: "Preserved note",
        last_contacted_date: "2026-09-01", next_follow_up_date: "2026-10-09", custom: { preserved: true },
      })]);
      await client.query("INSERT INTO crm_activities(investor_id,message,kind) VALUES($1,$2,$3)", [index + 1, "Original history", `status:${originals[index]}`]);
    }
    const before = (await client.query("SELECT * FROM crm_investors ORDER BY id")).rows;
    const history = (await client.query("SELECT * FROM crm_activities ORDER BY id")).rows;
    await client.query("SAVEPOINT migration_check");
    const report = await migratePipelineStages(client);
    assert.equal(report.total, 10);
    assert.equal(report.changed, 8);
    assert.deepEqual(report.after, { New: 4, Contacted: 3, "Meeting set": 1, "Proposal sent": 0, "Contract review": 0, Closed: 2 });
    const after = (await client.query("SELECT * FROM crm_investors ORDER BY id")).rows;
    for (let index = 0; index < after.length; index++) {
      assert.deepEqual({ ...after[index], data: { ...after[index].data, status: before[index].data.status } }, before[index]);
    }
    assert.deepEqual((await client.query("SELECT * FROM crm_activities WHERE id <= 10 ORDER BY id")).rows, history);
    assert.equal((await migratePipelineStages(client)).changed, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM crm_activities")).rows[0].n, 18);
    await client.query("ROLLBACK TO SAVEPOINT migration_check");

    let updates = 0;
    const failing = { query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("UPDATE") && ++updates === 2) throw new Error("Simulated update failure");
      return client.query(sql, params);
    } } as unknown as Client;
    await assert.rejects(migratePipelineStages(failing), /Simulated update failure/);
    await client.query("ROLLBACK TO SAVEPOINT migration_check");
    assert.deepEqual((await client.query("SELECT * FROM crm_investors ORDER BY id")).rows, before);
    assert.deepEqual((await client.query("SELECT * FROM crm_activities ORDER BY id")).rows, history);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
