import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { businessDate, normalizeLinkedIn, summary, upsert, listInvestors, validateInput } from "./crmData";
import { importCsv, parseCsv, exportCsv } from "./crmCsv";
import { isOwner } from "../middlewares/crmAccess";

test("Owner identity is exact and missing identity is rejected", () => {
  assert.equal(isOwner(undefined), false);
  assert.equal(isOwner("someone-else"), false);
});
test("field validation, date boundaries and LinkedIn canonical identity", () => {
  assert.equal(businessDate(new Date("2026-10-07T01:00:00Z")), "2026-10-06");
  assert.equal(normalizeLinkedIn("https://linkedin.com/in/Investor/?trk=source"), "https://www.linkedin.com/in/investor");
  assert.throws(() => normalizeLinkedIn("https://evil.com/in/name"));
  assert.throws(() => validateInput({ fit_score: 6 }));
  assert.throws(() => validateInput({ next_follow_up_date: "2026-02-30" }));
  assert.throws(() => validateInput({ website: "javascript:alert(1)" }));
  assert.throws(() => validateInput({ status: "Send Email" }));
  assert.throws(() => validateInput({ id: 1 }));
});
test("CSV handles multiline quotes, BOM, reordered headers and invalid input", () => {
  assert.deepEqual(parseCsv('\uFEFFname,notes\r\nInvestor,"Line one,\nLine ""two"""\r\n'), [["name", "notes"], ["Investor", 'Line one,\nLine "two"']]);
  assert.throws(() => parseCsv('name,notes\nTest,"unclosed'));
});
test("upsert, activity, partial updates, conflicts, CSV and summary preserve data; test rows roll back", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(941673)");
    await client.query("CREATE TEMP TABLE crm_investors (LIKE public.crm_investors INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE crm_activities (LIKE public.crm_activities INCLUDING ALL)");
    const first = await upsert(client, { name: "Test investor", email: "Investor@Example.COM", linkedin_url: "https://linkedin.com/in/TestInvestor/", notes: 'Hello,\n"Notara"', pitch_subject: "Seed round", fit_score: 5 });
    assert.equal(first.created, true);
    const duplicate = await upsert(client, { email: "investor@example.com", firm: "Test fund" });
    assert.equal(duplicate.investor.id, first.investor.id);
    assert.equal(duplicate.investor.notes, 'Hello,\n"Notara"');
    const linked = await upsert(client, { linkedin_url: "https://www.linkedin.com/in/testinvestor/?source=x", title: "Partner" });
    assert.equal(linked.investor.id, first.investor.id);
    const contact = await upsert(client, { status: "Contacted", next_follow_up_date: businessDate() }, first.investor.id);
    assert.equal(contact.investor.last_contacted_date, businessDate());
    assert.ok(contact.investor.activity_log.some(a => a.kind === "status:Contacted"));
    const responded = await upsert(client, { status: "Proposal sent" }, first.investor.id);
    const totals = summary([responded.investor]);
    assert.equal(totals.response_rate, 1);
    assert.equal(totals.responses, 1);
    assert.equal(totals.contacted_this_week, 1);
    assert.equal(totals.followups_due_today, 1);
    const csv = exportCsv([responded.investor]);
    const imported = await importCsv(client, csv);
    assert.deepEqual(imported, { created: 0, updated: 1 });
    const rows = await listInvestors(client);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pitch_subject, "Seed round");
    assert.equal(rows[0].notes, 'Hello,\n"Notara"');
    await importCsv(client, 'fit score,email,name\n4,new@example.com,Second investor');
    assert.equal((await listInvestors(client)).length, 2);
    await assert.rejects(upsert(client, { email: "new@example.com" }, first.investor.id), /different records/);
    await assert.rejects(importCsv(client, 'name,fit_score\nBad,9'), /CSV row 2/);
  } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
});
