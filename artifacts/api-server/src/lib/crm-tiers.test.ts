import test from "node:test";
import assert from "node:assert/strict";
import { validateInput, type Client } from "./crmData";
import { importCsv, parseCsv } from "./crmCsv";
import { BrowserUpdateInvestorBody } from "@workspace/api-zod";

const legacy = ["angel", "pre-seed fund", "seed fund", "micro-VC", "strategic"];

test("Expert inputs and CSV fields accept only STANDARD and PREMIUM tiers", () => {
  for (const tier of ["STANDARD", "PREMIUM"]) {
    assert.equal(validateInput({ investor_type: tier }).investor_type, tier);
    assert.equal(BrowserUpdateInvestorBody.parse({ investor_type: tier }).investor_type, tier);
    const [headers, values] = parseCsv(`name,investor_type\nTest,${tier}`);
    assert.equal(validateInput(Object.fromEntries(headers.map((h, i) => [h, values[i]]))).investor_type, tier);
  }
  for (const tier of [...legacy, "standard", "premium"]) {
    assert.throws(() => validateInput({ investor_type: tier }), /investor_type/);
    assert.equal(BrowserUpdateInvestorBody.safeParse({ investor_type: tier }).success, false);
  }
});

test("CSV rejects legacy tiers before any database access", async () => {
  const client = { query: async () => { throw new Error("Unexpected database access"); } } as unknown as Client;
  for (const tier of legacy) {
    await assert.rejects(importCsv(client, `name,investor_type\nTest,${tier}`), /CSV row 2.*investor_type/);
  }
});
