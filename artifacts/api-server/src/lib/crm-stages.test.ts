import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStage, STAGES } from "./crmStages";
import { migratePipelineStages } from "./crmStageMigration";
import { STATUSES, summary, validateInput, type Client } from "./crmData";
import type { Investor } from "@workspace/api-zod";

const mappings: [string, string][] = [
  ["New", "New"], ["Enriched", "New"], ["Pitch Drafted", "New"], ["Approved to Send", "New"],
  ["Contacted", "Contacted"], ["Sent", "Contacted"], ["Email Sent", "Contacted"],
  ["Followed Up", "Contacted"], ["Follow-up", "Contacted"], ["Follow-up 2", "Contacted"],
  ["Responded", "Contacted"], ["Replied", "Contacted"],
  ["Meeting Set", "Meeting set"], ["Meeting set", "Meeting set"], ["Meeting", "Meeting set"],
  ["Proposal sent", "Proposal sent"], ["Proposal", "Proposal sent"],
  ["Contract review", "Contract review"], ["Contract", "Contract review"],
  ["Passed", "Closed"], ["Committed", "Closed"], ["Won", "Closed"], ["Lost", "Closed"],
  ["Closed Won", "Closed"], ["Closed Lost", "Closed"], ["Closed", "Closed"],
];
test("API offers exactly six stages; legacy aliases normalize consistently", () => {
  assert.deepEqual(STAGES, ["New", "Contacted", "Meeting set", "Proposal sent", "Contract review", "Closed"]);
  assert.deepEqual(STATUSES, STAGES);
  for (const [old, expected] of mappings) {
    assert.equal(normalizeStage(old), expected);
    assert.equal(normalizeStage(` ${old.toLowerCase()} `), expected);
  }
  for (const stage of STAGES) assert.equal(validateInput({ status: stage }).status, stage);
  assert.throws(() => validateInput({ status: "Enriched" }), /status/);
  assert.equal(normalizeStage("Something unknown"), undefined);
  assert.equal(normalizeStage("__proto__"), undefined);
});

test("Production-shaped migration plans preserve 180 records and change only 169 stages, once", async () => {
  const originals = [...Array(11).fill("New"), ...Array(20).fill("Enriched"), ...Array(149).fill("Pitch Drafted")];
  const rows = originals.map((status, index) => ({ id: index + 1, status }));
  const activities: unknown[][] = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT id,data")) return { rows: rows.map(row => ({ ...row })) };
    if (sql.startsWith("UPDATE crm_investors")) {
      const row = rows.find(row => row.id === args[1])!;
      assert.equal(row.status, args[2]);
      row.status = args[0] as string;
      return { rows: [{ id: row.id }] };
    }
    if (sql.startsWith("INSERT INTO crm_activities")) { activities.push(args); return { rows: [] }; }
    throw new Error(`Unexpected query ${sql}`);
  } } as unknown as Client;
  const report = await migratePipelineStages(client);
  assert.deepEqual(report.before, { New: 11, Enriched: 20, "Pitch Drafted": 149 });
  assert.deepEqual(report.after, { New: 180, Contacted: 0, "Meeting set": 0, "Proposal sent": 0, "Contract review": 0, Closed: 0 });
  assert.equal(report.changed, 169);
  assert.equal(report.total, 180);
  assert.equal(activities.length, 169);
  assert.equal((await migratePipelineStages(client)).changed, 0);
  assert.equal(activities.length, 169);
  rows.push({ id: 999, status: "Unknown stage" });
  const before = JSON.stringify(rows);
  await assert.rejects(migratePipelineStages(client), /stopped without changes/);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(activities.length, 169);
});

test("Closed stages exclude follow-ups without inventing successful responses; old won history remains", () => {
  const experts = [1, 2].map(id => ({
    id, name: `Example ${id}`, status: "Closed", expert_field: "Law Firms",
    next_follow_up_date: "2026-10-09", last_contacted_date: "", activity_log: id === 1
      ? [{ id: "1", timestamp: "2026-10-09T12:00:00Z", message: "Preserved history", kind: "stage_migration:Committed" }]
      : [],
  } as Investor));
  const result = summary(experts, new Date("2026-10-09T18:00:00Z"));
  assert.equal(result.counts.Closed, 2);
  assert.equal(result.followups_due_today, 0);
  assert.equal(result.responses, 1);
  assert.equal(result.meetings_set, 1);
});
