import { CrmError, FIELDS, upsert, type Client } from "./crmData";
import type { Investor } from "@workspace/api-zod";
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let endedQuote = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; endedQuote = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || endedQuote) throw new CrmError("Malformed CSV quotes");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell); cell = ""; endedQuote = false;
      if (c !== ",") { if (row.some(v => v !== "")) rows.push(row); row = []; if (c === "\r" && text[i + 1] === "\n") i++; }
    } else {
      if (endedQuote) throw new CrmError("Unexpected text after a quoted CSV field");
      cell += c;
    }
  }
  if (quoted) throw new CrmError("Unclosed CSV quote");
  row.push(cell); if (row.some(v => v !== "")) rows.push(row);
  return rows;
}
export function csvExpertField(value: string): "Dentistry" | "Economics" | "Law Firms" {
  const field = value.trim().toLowerCase();
  if (!field || field === "dentistry") return "Dentistry";
  if (field === "economics") return "Economics";
  if (field === "law firms") return "Law Firms";
  throw new CrmError("expert_field must be Dentistry, Economics or Law Firms");
}
export async function importCsv(client: Client, text: string) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new CrmError("CSV must contain headers and at least one investor");
  if (rows.length > 5001) throw new CrmError("Import at most 5,000 investors at once");
  const aliases: Record<string, string> = { linkedin: "linkedin_url", subject: "pitch_subject", body: "pitch_body", personalized_pitch_subject: "pitch_subject", personalized_pitch_body: "pitch_body", activity: "activity_log" };
  const headers = rows[0].map(v => { const key = v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); return aliases[key] ?? key; });
  if (new Set(headers).size !== headers.length) throw new CrmError("Duplicate CSV header");
  if (!headers.includes("name")) throw new CrmError("CSV needs a name column");
  const unknown = headers.filter(h => ![...FIELDS, "activity_log", "id", "created_at", "updated_at"].includes(h));
  if (unknown.length) throw new CrmError(`Unknown CSV headers: ${unknown.join(", ")}`);
  let created = 0, updated = 0;
  for (let i = 1; i < rows.length; i++) {
    try {
      if (rows[i].length !== headers.length) throw new CrmError("Column count does not match headers");
      const input: Record<string, unknown> = {};
      headers.forEach((key, j) => { if (FIELDS.includes(key)) input[key] = key === "fit_score" ? Number(rows[i][j]) : rows[i][j]; });
      if (input.fit_score === 0) delete input.fit_score;
      if (input.status === "") delete input.status;
      if (input.investor_type === "") delete input.investor_type;
      if (typeof input.expert_field === "string") input.expert_field = csvExpertField(input.expert_field);
      const result = await upsert(client, input);
      result.created ? created++ : updated++;
      const rawActivity = headers.includes("activity_log") ? rows[i][headers.indexOf("activity_log")] : "";
      if (rawActivity) {
        const entries = JSON.parse(rawActivity) as unknown;
        if (!Array.isArray(entries) || entries.length > 1000) throw new CrmError("activity_log must be a JSON array of at most 1,000 entries");
        for (const entry of entries) {
          if (typeof entry?.message !== "string" || !entry.message.trim() || entry.message.length > 50000 || !entry.timestamp || Number.isNaN(Date.parse(entry.timestamp))) throw new CrmError("Activity entries need message and valid timestamp");
          // Export/import round trips do not duplicate an existing activity.
          await client.query("INSERT INTO crm_activities(investor_id,message,kind,created_at) SELECT $1,$2,$3,$4::timestamptz WHERE NOT EXISTS (SELECT 1 FROM crm_activities WHERE investor_id=$1 AND message=$2 AND kind=$3 AND created_at=$4::timestamptz)", [result.investor.id, entry.message, typeof entry.kind === "string" ? entry.kind : "note", entry.timestamp]);
        }
      }
    } catch (err) { throw new CrmError(`CSV row ${i + 1}: ${(err as Error).message}`, err instanceof CrmError ? err.status : 400); }
  }
  return { created, updated };
}
export function exportCsv(investors: Investor[]) {
  const headers = [...FIELDS, "activity_log"];
  const quote = (v: unknown) => {
    let value = typeof v === "string" ? v : v == null ? "" : String(v);
    // Neutralize spreadsheet formula injection while preserving normal text.
    if (/^[\t\r ]*[=+\-@]/.test(value)) value = "'" + value;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [headers.join(","), ...investors.map(i => headers.map(h => quote(h === "activity_log" ? JSON.stringify(i.activity_log) : i[h as keyof Investor])).join(","))].join("\r\n") + "\r\n";
}
