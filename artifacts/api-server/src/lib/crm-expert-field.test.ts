import test from "node:test";
import assert from "node:assert/strict";
import type { Investor } from "@workspace/api-zod";
import { CrmError, FIELDS, getInvestor, summary, upsert, validateInput, type Client } from "./crmData";
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
  assert.equal((await getInvestor(memory.client, 1)).expert_field, "Law Firms");
  assert.equal(JSON.stringify(memory.rows), before);
  assert.ok(memory.calls.every(sql => sql.startsWith("SELECT")));
});

test("API persists field choices, defaults new records to Dentistry, and preserves Economics on unrelated edits", async () => {
  const memory = memoryClient();
  assert.equal((await upsert(memory.client, { name: "Dentist" })).investor.expert_field, "Law Firms");
  const created = await upsert(memory.client, { name: "Economist", expert_field: "Chinese Law" });
  assert.equal(created.investor.expert_field, "Chinese Law");
  const edited = await upsert(memory.client, { notes: "Changed note" }, created.investor.id);
  assert.equal(edited.investor.expert_field, "Chinese Law");
  assert.equal(edited.investor.notes, "Changed note");
  assert.equal((await upsert(memory.client, { expert_field: "Law Firms" }, created.investor.id)).investor.expert_field, "Law Firms");
  assert.equal(validateInput({ notes: "No field change" }).expert_field, undefined);
  assert.throws(() => validateInput({ expert_field: "Medicine" }), /expert_field/);
});

test("CSV field is optional, case-insensitive, defaults blanks, rejects invalid values, and round-trips", async () => {
  assert.equal(csvExpertField(" LAW FIRMS "), "Law Firms");
  assert.equal(csvExpertField(" cHiNeSe LaW "), "Chinese Law");
  assert.equal(csvExpertField("  "), "Law Firms");
  const memory = memoryClient();
  await importCsv(memory.client, "name,email,expert_field\nEconomist,e@example.test,cHiNeSe LaW\nDentist,d@example.test,\n");
  await importCsv(memory.client, "name,email\nRenamed,e@example.test\nLegacy CSV,l@example.test");
  assert.equal(memory.rows[0].data.expert_field, "Chinese Law");
  assert.equal(memory.rows[1].data.expert_field, "Law Firms");
  assert.equal(memory.rows[2].data.expert_field, "Law Firms");
  const before = JSON.stringify(memory.rows);
  await assert.rejects(importCsv(memory.client, "name,expert_field\nInvalid,Medicine"), /CSV row 2.*expert_field/);
  assert.equal(JSON.stringify(memory.rows), before);
  const experts = await Promise.all(memory.rows.map(r => getInvestor(memory.client, r.id)));
  const [headers, ...values] = parseCsv(exportCsv(experts));
  assert.deepEqual(values.map(row => row[headers.indexOf("expert_field")]), ["Chinese Law", "Law Firms", "Law Firms"]);
});

test("CSV matches shuffled headers including expert_field, without modifying unrelated records", async () => {
  const existing = { id: 1, data: { name: "Existing", notes: "Keep" }, created_at: now, updated_at: now };
  const headers = ["expert_field", "notes", "email", "fit_score", "status", "name", "investor_type"];
  const values = ["lAw FiRmS", "A note, with commas", "law@example.test", "4", "Meeting set", "Law example", "PREMIUM"];
  for (let offset = 0; offset < headers.length; offset++) {
    const row = { ...existing, data: { ...existing.data } };
    const memory = memoryClient([row]);
    const before = JSON.stringify(row);
    const rotate = (items: string[]) => [...items.slice(offset), ...items.slice(0, offset)];
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    assert.deepEqual(await importCsv(memory.client, `${rotate(headers).join(",")}\n${rotate(values).map(quote).join(",")}`), { created: 1, updated: 0 });
    const imported = memory.rows[1].data;
    assert.equal(imported.expert_field, "Law Firms");
    assert.equal(imported.name, "Law example");
    assert.equal(imported.email, "law@example.test");
    assert.equal(imported.fit_score, 4);
    assert.equal(imported.status, "Meeting set");
    assert.equal(imported.notes, "A note, with commas");
    assert.equal(imported.investor_type, "PREMIUM");
    assert.equal(JSON.stringify(row), before);
  }
});

test("CSV accepts legacy stage names across all expert categories and exports only canonical stages", async () => {
  const mappings: [string, string][] = [
    ["New", "New"], ["Enriched", "New"], ["Pitch Drafted", "New"], ["Approved to Send", "New"],
    ["Sent", "Contacted"], ["Contacted", "Contacted"], ["Follow-up", "Contacted"],
    ["Follow-up 2", "Contacted"], ["Followed Up", "Contacted"], ["Replied", "Contacted"],
    ["Responded", "Contacted"], ["Meeting", "Meeting set"], ["Meeting set", "Meeting set"],
    ["Won", "Closed"], ["Lost", "Closed"], ["Closed", "Closed"], ["Passed", "Closed"], ["Committed", "Closed"],
  ];
  const memory = memoryClient();
  for (const category of ["Law Firms", "Chinese Law", "Law Firms", "Chinese Law", "Indian Law"]) {
    const csv = "expert_field,status,name\n" + mappings.map(([stage], index) => `${category},${stage},Sample ${index}`).join("\n");
    await importCsv(memory.client, csv);
  }
  assert.deepEqual(memory.rows.map(row => row.data.status), [...mappings, ...mappings, ...mappings, ...mappings, ...mappings].map(([, stage]) => stage));
  const experts = await Promise.all(memory.rows.map(row => getInvestor(memory.client, row.id)));
  const [headers, ...values] = parseCsv(exportCsv(experts));
  assert.deepEqual(values.map(row => row[headers.indexOf("status")]), memory.rows.map(row => row.data.status));
});

test("CSV errors identify the row, field and original rejected value", async () => {
  const cases = [
    ["expert_field", "Law_Firms", /Law Firms, Chinese Law or Indian Law/],
    ["investor_type", "Law Firms", /STANDARD/],
    ["fit_score", "excellent", /number/],
    ["fit_score", "6", /5/],
    ["status", "Interested", /New/],
    ["email", "not-an-email", /Invalid email/],
    ["linkedin_url", "https://example.test/profile", /linkedin.com/],
    ["website", "https://", /http or https/],
    ["source_url", "example.test", /http or https/],
    ["last_contacted_date", "10/09/2026", /YYYY-MM-DD/],
    ["next_follow_up_date", "2026-02-30", /YYYY-MM-DD/],
  ] as const;
  for (const [field, value, expected] of cases) {
    const memory = memoryClient();
    await assert.rejects(importCsv(memory.client, `name,${field}\nExample,${value}`), err => {
      assert.ok(err instanceof CrmError);
      assert.equal(err.details?.row, 2);
      assert.equal(err.details?.field, field);
      assert.equal(err.details?.value, value);
      assert.match(err.message, /CSV row 2:/);
      assert.ok(err.message.includes(`${field}=${JSON.stringify(value)}`));
      assert.match(err.message, expected);
      return true;
    });
    assert.equal(memory.rows.length, 0);
    assert.equal(memory.calls.length, 0);
  }
  const memory = memoryClient();
  await assert.rejects(importCsv(memory.client, 'name,expert_field\nValid,Law Firms\nInvalid,Law_Firms'), err => {
    assert.ok(err instanceof CrmError);
    assert.equal(err.details?.row, 3);
    assert.equal(err.details?.field, "expert_field");
    return true;
  });
});

test("A 60-row Law Firms CSV with the reported headers is supported", async () => {
  const headers = "name,firm,title,email,linkedin_url,website,location,investor_type,typical_check_size,stage_focus,thesis_notes,warm_intro_path,source_url,fit_score,status,pitch_subject,pitch_body,last_contacted_date,next_follow_up_date,notes,expert_field";
  const defaults: Record<string, string> = {
    name: "Test firm", investor_type: "STANDARD", fit_score: "3", status: "New", expert_field: "Law Firms",
  };
  const values = headers.split(",").map(field => defaults[field] ?? "");
  const memory = memoryClient();
  const csv = [headers, ...Array.from({ length: 60 }, (_, i) => values.map((value, column) => column === 0 ? `${value} ${i + 1}` : value).join(","))].join("\n");
  assert.deepEqual(await importCsv(memory.client, csv), { created: 60, updated: 0 });
  assert.equal(memory.rows.length, 60);
  assert.ok(memory.rows.every(row => row.data.expert_field === "Law Firms"));
});

test("Removed Brazilian Law and the Brazil display label are not stored field values; Law Firms remains unchanged", async () => {
  const original = { id: 1, data: { name: "Existing law expert", expert_field: "Law Firms", status: "New", notes: "Keep" }, created_at: now, updated_at: now };
  const memory = memoryClient([original]);
  const before = JSON.stringify(original);
  for (const value of ["Brazilian Law", "Brazil"]) {
    assert.throws(() => csvExpertField(value), /expert_field/);
    await assert.rejects(upsert(memory.client, { name: "Invalid category", expert_field: value }), /expert_field/);
    await assert.rejects(importCsv(memory.client, `name,expert_field\nInvalid category,${value}`), /CSV row 2.*expert_field/);
  }
  assert.equal(memory.calls.length, 0);
  assert.equal(csvExpertField(" law firms "), "Law Firms");
  assert.equal(JSON.stringify(original), before);
  const experts = [await getInvestor(memory.client, 1)];
  assert.equal(summary(experts, now, "Law Firms").total, 1);
  const [headers, ...rows] = parseCsv(exportCsv(experts));
  assert.deepEqual(rows.map(row => row[headers.indexOf("expert_field")]), ["Law Firms"]);
});

test("Indian Law supports creation, editing, CSV import and scoped counts without changing existing experts", async () => {
  const original = { id: 1, data: { name: "Existing Chinese law expert", expert_field: "Chinese Law", status: "New", notes: "Keep" }, created_at: now, updated_at: now };
  const memory = memoryClient([original]);
  const before = JSON.stringify(original);
  assert.equal(summary([await getInvestor(memory.client, 1)], now, "Indian Law").total, 0);
  const created = await upsert(memory.client, { name: "Indian law example", expert_field: "Indian Law" });
  assert.equal(created.investor.expert_field, "Indian Law");
  assert.equal(created.investor.status, "New");
  const edited = await upsert(memory.client, { notes: "New note" }, created.investor.id);
  assert.equal(edited.investor.expert_field, "Indian Law");
  assert.equal(csvExpertField(" iNdIaN LaW "), "Indian Law");
  await importCsv(memory.client, "expert_field,status,name\n indian LAW ,Meeting,Imported example");
  const experts = await Promise.all(memory.rows.map(row => getInvestor(memory.client, row.id)));
  const result = summary(experts, now, "Indian Law");
  assert.equal(result.total, 2);
  assert.equal(result.counts.New, 1);
  assert.equal(result.counts["Meeting set"], 1);
  assert.equal(summary(experts, now, "Chinese Law").total, 1);
  assert.equal(JSON.stringify(original), before);
  const [headers, ...rows] = parseCsv(exportCsv(experts));
  assert.deepEqual(rows.map(row => row[headers.indexOf("expert_field")]), ["Chinese Law", "Indian Law", "Indian Law"]);
});

test("Chinese Law supports creation, editing, CSV import and scoped counts without changing existing experts", async () => {
  const original = { id: 1, data: { name: "Existing law firm", expert_field: "Law Firms", status: "New", notes: "Keep" }, created_at: now, updated_at: now };
  const memory = memoryClient([original]);
  const before = JSON.stringify(original);
  assert.equal(summary([await getInvestor(memory.client, 1)], now, "Chinese Law").total, 0);
  const created = await upsert(memory.client, { name: "Chinese law example", expert_field: "Chinese Law" });
  assert.equal(created.investor.expert_field, "Chinese Law");
  assert.equal(created.investor.status, "New");
  const edited = await upsert(memory.client, { notes: "New note" }, created.investor.id);
  assert.equal(edited.investor.expert_field, "Chinese Law");
  assert.equal(csvExpertField(" cHiNeSe LaW "), "Chinese Law");
  await importCsv(memory.client, "expert_field,status,name\n chinese LAW ,Meeting,Imported example");
  const experts = await Promise.all(memory.rows.map(row => getInvestor(memory.client, row.id)));
  const result = summary(experts, now, "Chinese Law");
  assert.equal(result.total, 2);
  assert.equal(result.counts.New, 1);
  assert.equal(result.counts["Meeting set"], 1);
  assert.equal(summary(experts, now, "Law Firms").total, 1);
  assert.equal(JSON.stringify(original), before);
  const [headers, ...rows] = parseCsv(exportCsv(experts));
  assert.deepEqual(rows.map(row => row[headers.indexOf("expert_field")]), ["Law Firms", "Chinese Law", "Chinese Law"]);
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
  assert.equal(summary(experts, now, "Law Firms").total, 1);
  assert.equal(summary(experts, now, "Chinese Law").total, 0);
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
    make(2, "Law Firms", { status: "Proposal sent", last_contacted_date: "2026-10-06", next_follow_up_date: "2026-10-07" }),
    make(3, "Chinese Law", { status: "Meeting set", last_contacted_date: "2026-10-05" }),
  ];
  const dentists = summary(records, now, "Law Firms");
  const economists = summary(records, now, "Chinese Law");
  const all = summary(records, now);
  assert.deepEqual([dentists.total, dentists.contacted_this_week, dentists.responses, dentists.response_rate, dentists.meetings_set, dentists.followups_due_today], [2, 1, 1, 1, 0, 1]);
  assert.deepEqual([economists.total, economists.contacted_this_week, economists.responses, economists.response_rate, economists.meetings_set, economists.followups_due_today], [1, 1, 1, 1, 1, 0]);
  assert.deepEqual([all.total, all.contacted_this_week, all.responses, all.meetings_set, all.followups_due_today], [3, 2, 2, 1, 1]);
  assert.equal(dentists.counts.New, 1);
  assert.equal(dentists.counts["Meeting set"], 0);
  assert.equal(economists.counts.New, 0);
  assert.equal(economists.counts["Meeting set"], 1);
  assert.equal(all.counts.New, 1);
  assert.equal(all.counts["Meeting set"], 1);
});
