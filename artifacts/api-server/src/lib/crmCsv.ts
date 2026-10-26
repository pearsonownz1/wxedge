import { CrmError, FIELDS, activity, fieldError, upsert, type Client } from "./crmData";
import { normalizeStage, STAGES } from "./crmStages";
import type { Investor } from "@workspace/api-zod";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let endedQuote = false;
  const malformed = (reason: string) => {
    const field = rows[0]?.[row.length]?.trim() || `column ${row.length + 1}`;
    const error = fieldError(field, cell, reason);
    return new CrmError(`CSV row ${rows.length + 1}: ${error.message}`, 400, { ...error.details, row: rows.length + 1 });
  };
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; endedQuote = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || endedQuote) throw malformed("Malformed CSV quotes");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell); cell = ""; endedQuote = false;
      if (c !== ",") { if (row.some(v => v !== "")) rows.push(row); row = []; if (c === "\r" && text[i + 1] === "\n") i++; }
    } else {
      if (endedQuote) throw malformed("Unexpected text after a quoted CSV field");
      cell += c;
    }
  }
  if (quoted) throw malformed("Unclosed CSV quote");
  row.push(cell); if (row.some(v => v !== "")) rows.push(row);
  return rows;
}

export const EXPERT_FIELDS = ["Law Firms", "Chinese Law", "Indian Law"] as const;
export const EXPERT_FIELD_FILTERS = [
  { value: "Law Firms", label: "Law Firms" },
  { value: "Chinese Law", label: "Chinese Law" },
  { value: "Indian Law", label: "Indian Law" },
  { value: "All", label: "All" },
] as const;

export function csvExpertField(value: string): "Law Firms" | "Chinese Law" | "Indian Law" {
  const field = value.trim().toLowerCase();
  if (!field || field === "law firms") return "Law Firms";
  if (field === "chinese law") return "Chinese Law";
  if (field === "indian law") return "Indian Law";
  throw fieldError("expert_field", value, "expert_field must be Law Firms, Chinese Law or Indian Law");
}

export async function importCsv(client: Client, text: string) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new CrmError("CSV must contain headers and at least one investor");
  if (rows.length > 5001) throw new CrmError("Import at most 5,000 investors at once");
  const aliases: Record<string, string> = {
    linkedin: "linkedin_url",
    subject: "pitch_subject",
    body: "pitch_body",
    personalized_pitch_subject: "pitch_subject",
    personalized_pitch_body: "pitch_body",
    activity: "activity_log",
    type: "client_type",
  };
  const headers = rows[0].map(v => { const key = v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); return aliases[key] ?? key; });
  const duplicate = headers.find((header, index) => headers.indexOf(header) !== index);
  if (duplicate !== undefined) throw new CrmError(`CSV row 1: Duplicate CSV header ${JSON.stringify(duplicate)}`, 400, { row: 1, field: duplicate, value: duplicate });
  if (!headers.includes("name")) throw new CrmError("CSV row 1: CSV needs a name column", 400, { row: 1, field: "name" });
  const unknown = headers.filter(h => ![...FIELDS, "activity_log", "id", "created_at", "updated_at"].includes(h));
  if (unknown.length) throw new CrmError(`CSV row 1: Unknown CSV headers: ${unknown.join(", ")}`, 400, { row: 1, field: unknown[0], value: unknown[0] });
  let created = 0, updated = 0;
  for (let i = 1; i < rows.length; i++) {
    try {
      if (rows[i].length !== headers.length) throw new CrmError(`Column count does not match headers: expected ${headers.length}, got ${rows[i].length}. Quote values containing commas.`);
      const input: Record<string, unknown> = {};
      headers.forEach((key, j) => {
        if (FIELDS.includes(key)) {
          if (key === "fit_score") input[key] = Number(rows[i][j]);
          else if (key === "deal_value") input[key] = rows[i][j].trim() === "" ? undefined : Number(rows[i][j].replace(/[$,\s]/g, ""));
          else input[key] = rows[i][j];
        }
      });
      if (input.fit_score === 0) delete input.fit_score;
      if (input.deal_value === undefined) delete input.deal_value;
      if (input.client_type === "") delete input.client_type;
      const originalStage = input.status;
      if (typeof originalStage === "string") {
        if (!originalStage.trim()) delete input.status;
        else {
          const stage = normalizeStage(originalStage);
          if (!stage) throw fieldError("status", originalStage, `Expected ${STAGES.join(", ")} or a supported legacy stage`);
          input.status = stage;
        }
      }
      if (input.investor_type === "") delete input.investor_type;
      if (typeof input.expert_field === "string") input.expert_field = csvExpertField(input.expert_field);
      const result = await upsert(client, input);
      result.created ? created++ : updated++;
      if (typeof originalStage === "string" && originalStage.trim() && originalStage !== input.status) {
        await activity(client, result.investor.id, `Imported legacy stage: ${originalStage} → ${input.status}`, `stage_migration:${originalStage}`);
      }
      const rawActivity = headers.includes("activity_log") ? rows[i][headers.indexOf("activity_log")] : "";
      if (rawActivity) {
        let entries: unknown;
        try { entries = JSON.parse(rawActivity); }
        catch { throw fieldError("activity_log", rawActivity, "activity_log must be valid JSON"); }
        if (!Array.isArray(entries) || entries.length > 1000) throw fieldError("activity_log", rawActivity, "activity_log must be a JSON array of at most 1,000 entries");
        for (const entry of entries) {
          if (typeof entry?.message !== "string" || !entry.message.trim() || entry.message.length > 50000 || !entry.timestamp || Number.isNaN(Date.parse(entry.timestamp))) throw fieldError("activity_log", rawActivity, "Activity entries need message and valid timestamp");
          // Export/import round trips do not duplicate an existing activity.
          await client.query("INSERT INTO crm_activities(investor_id,message,kind,created_at) SELECT $1,$2,$3,$4::timestamptz WHERE NOT EXISTS (SELECT 1 FROM crm_activities WHERE investor_id=$1 AND message=$2 AND kind=$3 AND created_at=$4::timestamptz)", [result.investor.id, entry.message, typeof entry.kind === "string" ? entry.kind : "note", entry.timestamp]);
        }
      }
    } catch (err) {
      const details = err instanceof CrmError ? err.details : undefined;
      const column = details?.field ? headers.indexOf(details.field) : -1;
      const value = column >= 0 ? rows[i][column] : details?.value;
      const message = column >= 0
        ? fieldError(details!.field!, value, details?.reason ?? (err as Error).message).message
        : (err as Error).message;
      throw new CrmError(`CSV row ${i + 1}: ${message}`, err instanceof CrmError ? err.status : 400, { ...details, ...(column >= 0 ? { value } : {}), row: i + 1 });
    }
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
