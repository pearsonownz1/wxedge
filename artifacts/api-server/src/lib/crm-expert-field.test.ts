import test from "node:test";
import assert from "node:assert/strict";
import type { Investor } from "@workspace/api-zod";
import { FIELDS, getInvestor, summary, upsert, validateInput, type Client } from "./crmData";
import { csvExpertField, exportCsv, importCsv, parseCsv } from "./crmCsv";

type Row = { id: number; data: Record<string, unknown>; created_at: Date; updated_at: Date };
const now = new Date("2026-10-07T18:00:00Z");

// All storage operations below are in-memory fakes; never connect to a database.
function memoryClient(rows: Row[] = []) {
  const calls: string[] = [];
  const client = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push(sql);
      if (sql.startsWith("SELECT id,data FROM")) return { rows: rows.filter(r =>
        (args[0] && r.data.email === args[0]) || (args[1] && r.data.linkedin_url === args[1])) };
      if (sql.startsWith("SELECT data FROM") || sql.startsWith("SELECT id,data,created_at")) return { rows: rows.filter(r => r.id === args[0]) };
      if (sql.startsWith("SELECT id::text") || sql.startsWith("INSERT INTO crm_activities")) return { rows: [] };
      if (sql.startsWith("INSERT INTO crm_investors")) {
        const row = { id: rows.length + 1, data: JSON.parse(args[2] as string), created_at: now, updated_at: now };
        rows.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.startsWith("UPDATE crm_investors SET email_key")) {
        const row = rows.find(r => r.id === args[3])!;
        row.data = JSON.parse(args[2] as string);
        return { rows: [] };
      }
      throw new Error(`Unexpected mock query: ${sql}`);
    },
  } as unknown as Client;
  return { client, rows, calls };
}

test("Legacy reads return Dentistry without updating or backfilling stored data", async () => {
  const memory = memoryClient([{ id: 1, data: { name: "Legacy", notes: "Keep" }, created_at: now, updated_at: now }]);
  const before = JSON.stringify(memory.rows);
  assert.equal((await getInvestor(memory.client, 1)).expert_field, "Dentistry");
  assert.equal(JSON.stringify(memory.rows), before);
  assert.ok(memory.calls.every(sql => sql.startsWith("SELECT")));
});

test("API persists field choices, defaults new records to Dentistry, and preserves Economics on unrelated edits", async () => {
  const memory = memoryClient();
  assert.equal((await upsert(memory.client, { name: "Dentist" })).investor.expert_field, "Dentistry");
  const created = await upsert(memory.client, { name: "Economist", expert_field: "Economics" });
  assert.equal(created.investor.expert_field, "Economics");
  const edited = await upsert(memory.client, { notes: "Changed note" }, created.investor.id);
  assert.equal(edited.investor.expert_field, "Economics");
  assert.equal(edited.investor.notes, "Changed note");
  assert.equal((await upsert(memory.client, { expert_field: "Dentistry" }, created.investor.id)).investor.expert_field, "Dentistry");
  assert.equal(validateInput({ notes: "No field change" }).expert_field, undefined);
  assert.throws(() => validateInput({ expert_field: "Medicine" }), /expert_field/);
});

test("CSV field is optional, case-insensitive, defaults blanks, rejects invalid values, and round-trips", async () => {
  assert.equal(csvExpertField(" DENTISTRY "), "Dentistry");
  assert.equal(csvExpertField(" eConOMics "), "Economics");
  assert.equal(csvExpertField("  "), "Dentistry");
  const memory = memoryClient();
  await importCsv(memory.client, "name,email,expert_field\nEconomist,e@example.test,eCONOMics\nDentist,d@example.test,\n");
  await importCsv(memory.client, "name,email\nRenamed,e@example.test\nLegacy CSV,l@example.test");
  assert.equal(memory.rows[0].data.expert_field, "Economics");
  assert.equal(memory.rows[1].data.expert_field, "Dentistry");
  assert.equal(memory.rows[2].data.expert_field, "Dentistry");
  const before = JSON.stringify(memory.rows);
  await assert.rejects(importCsv(memory.client, "name,expert_field\nInvalid,Medicine"), /CSV row 2.*expert_field/);
  assert.equal(JSON.stringify(memory.rows), before);
  const experts = await Promise.all(memory.rows.map(r => getInvestor(memory.client, r.id)));
  const [headers, ...values] = parseCsv(exportCsv(experts));
  assert.deepEqual(values.map(row => row[headers.indexOf("expert_field")]), ["Economics", "Dentistry", "Dentistry"]);
});

test("Law Firms starts empty, accepts creation and CSV import, and preserves existing records", async () => {
  const existing = { id: 1, data: { name: "Existing dentist", notes: "Keep" }, created_at: now, updated_at: now };
  const memory = memoryClient([existing]);
  const before = JSON.stringify(existing);
  const original = await getInvestor(memory.client, 1);
  assert.equal(summary([original], now, "Law Firms").total, 0);
  const lawFirm = await upsert(memory.client, { name: "New law firm", expert_field: "Law Firms" });
  assert.equal(lawFirm.investor.expert_field, "Law Firms");
  assert.equal(csvExpertField(" lAw FiRmS "), "Law Firms");
  await importCsv(memory.client, "name,expert_field\nImported law firm,lAW FIRms");
  assert.equal(memory.rows[2].data.expert_field, "Law Firms");
  const experts = await Promise.all(memory.rows.map(r => getInvestor(memory.client, r.id)));
  assert.equal(summary(experts, now, "Law Firms").total, 2);
  assert.equal(summary(experts, now, "Law Firms").counts.New, 2);
  assert.equal(summary(experts, now, "Dentistry").total, 1);
  assert.equal(summary(experts, now, "Economics").total, 0);
  assert.equal(summary(experts, now).total, 3);
  assert.equal(JSON.stringify(existing), before);
});

test("Every summary metric and status count uses the selected field, including legacy records", () => {
  const make = (id: number, field: string | undefined, overrides: Partial<Investor>): Investor => {
    const data: Record<string, unknown> = {
      ...Object.fromEntries(FIELDS.map(k => [k, ""])),
      id, name: `Expert ${id}`, investor_type: "STANDARD", fit_score: 3, status: "New",
      activity_log: [], created_at: now.toISOString(), updated_at: now.toISOString(), ...overrides,
    };
    if (field) data.expert_field = field;
    else delete data.expert_field;
    return data as unknown as Investor;
  };
  const records = [
    make(1, undefined, {}),
    make(2, "Dentistry", { status: "Responded", last_contacted_date: "2026-10-06", next_follow_up_date: "2026-10-07" }),
    make(3, "Economics", { status: "Meeting Set", last_contacted_date: "2026-10-05" }),
  ];
  const dentists = summary(records, now, "Dentistry");
  const economists = summary(records, now, "Economics");
  const all = summary(records, now);
  assert.deepEqual([dentists.total, dentists.contacted_this_week, dentists.responses, dentists.response_rate, dentists.meetings_set, dentists.followups_due_today], [2, 1, 1, 1, 0, 1]);
  assert.deepEqual([economists.total, economists.contacted_this_week, economists.responses, economists.response_rate, economists.meetings_set, economists.followups_due_today], [1, 1, 1, 1, 1, 0]);
  assert.deepEqual([all.total, all.contacted_this_week, all.responses, all.meetings_set, all.followups_due_today], [3, 2, 2, 1, 1]);
  assert.equal(dentists.counts.New, 1);
  assert.equal(dentists.counts["Meeting Set"], 0);
  assert.equal(economists.counts.New, 0);
  assert.equal(economists.counts["Meeting Set"], 1);
  assert.equal(all.counts.New, 1);
  assert.equal(all.counts["Meeting Set"], 1);
});
