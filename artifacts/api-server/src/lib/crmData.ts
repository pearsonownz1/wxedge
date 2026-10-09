import { pool } from "@workspace/db";
import { BrowserUpsertInvestorBody, type Investor } from "@workspace/api-zod";

import { STAGES } from "./crmStages";
export const STATUSES: string[] = [...STAGES];
export const FIELDS = ["name", "firm", "title", "email", "linkedin_url", "website", "location", "investor_type", "expert_field", "typical_check_size", "stage_focus", "thesis_notes", "warm_intro_path", "source_url", "fit_score", "status", "pitch_subject", "pitch_body", "last_contacted_date", "next_follow_up_date", "notes"];
export class CrmError extends Error {
  constructor(message: string, public status = 400, public details?: { field?: string; value?: unknown; row?: number; reason?: string }) { super(message); }
}
export function fieldError(field: string, value: unknown, reason: string) {
  const shown = JSON.stringify(value) ?? "missing";
  return new CrmError(`${field}=${shown.length > 200 ? shown.slice(0, 200) + "…" : shown}: ${reason}`, 400, { field, value, reason });
}
export type Client = { query: typeof pool.query };
export function businessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const p = (key: string) => parts.find(x => x.type === key)!.value;
  return `${p("year")}-${p("month")}-${p("day")}`;
}
export function normalizeLinkedIn(value: string): string | null {
  if (!value.trim()) return null;
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `https://${value}`); }
  catch { throw fieldError("linkedin_url", value, "Invalid LinkedIn URL"); }
  if (!["https:", "http:"].includes(url.protocol) || !/^(www\.)?linkedin\.com$/i.test(url.hostname) || !url.pathname.replace(/\/+$/, "")) throw fieldError("linkedin_url", value, "Use a linkedin.com profile URL");
  return `https://www.linkedin.com${url.pathname.toLowerCase().replace(/\/+$/, "")}`;
}
export function validateInput(raw: unknown) {
  const parsed = BrowserUpsertInvestorBody.strict().safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".") || "record";
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[String(issue.path[0])] : raw;
    throw fieldError(field, value, issue.message);
  }
  const data = parsed.data;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > 50000) throw fieldError(key, value, `${key} is too long`);
  }
  if (data.name !== undefined) data.name = data.name.trim();
  if (data.email !== undefined) {
    data.email = data.email.trim().toLowerCase();
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw fieldError("email", data.email, "Invalid email");
  }
  if (data.linkedin_url !== undefined) data.linkedin_url = normalizeLinkedIn(data.linkedin_url) ?? "";
  for (const key of ["website", "source_url"] as const) {
    if (data[key]) {
      try { if (!["http:", "https:"].includes(new URL(data[key]).protocol)) throw Error(); }
      catch { throw fieldError(key, data[key], `${key} must be an http or https URL`); }
    }
  }
  for (const key of ["last_contacted_date", "next_follow_up_date"] as const) {
    const date = data[key];
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw fieldError(key, date, `${key} must be YYYY-MM-DD`);
  }
  return data;
}
export async function transaction<T>(action: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(941673)");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
export async function activity(client: Client, id: number, message: string, kind = "note") {
  await client.query("INSERT INTO crm_activities(investor_id,message,kind) VALUES($1,$2,$3)", [id, message, kind]);
}
export async function getInvestor(client: Client, id: number): Promise<Investor> {
  const r = await client.query("SELECT id,data,created_at,updated_at FROM crm_investors WHERE id=$1", [id]);
  if (!r.rows[0]) throw new CrmError("Investor not found", 404);
  const row = r.rows[0];
  const a = await client.query(`SELECT id::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,message,kind FROM crm_activities WHERE investor_id=$1 ORDER BY created_at,id`, [id]);
  return { ...row.data, expert_field: row.data.expert_field || "Dentistry", id: row.id, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(), activity_log: a.rows } as Investor;
}
export async function listInvestors(client: Client, status?: string) {
  const rows = await client.query("SELECT id FROM crm_investors WHERE ($1::text IS NULL OR data->>'status'=$1) ORDER BY updated_at DESC,id DESC", [status ?? null]);
  return Promise.all(rows.rows.map(row => getInvestor(client, row.id)));
}
export async function upsert(client: Client, raw: unknown, id?: number) {
  const input = validateInput(raw);
  const email = input.email || null;
  const linkedin = input.linkedin_url || null;
  const matches = await client.query("SELECT id,data FROM crm_investors WHERE ($1::text IS NOT NULL AND email_key=$1) OR ($2::text IS NOT NULL AND linkedin_key=$2) ORDER BY id", [email, linkedin]);
  if (matches.rows.length > 1 || (id !== undefined && matches.rows.some(x => x.id !== id))) throw new CrmError("Email and LinkedIn match different records; review before merging", 409);
  if (id === undefined && matches.rows[0]) id = matches.rows[0].id;
  const old = id === undefined ? null : (await client.query("SELECT data FROM crm_investors WHERE id=$1 FOR UPDATE", [id])).rows[0]?.data;
  if (id !== undefined && !old) throw new CrmError("Investor not found", 404);
  const defaults = { ...Object.fromEntries(FIELDS.map(key => [key, ""])), investor_type: "STANDARD", expert_field: "Dentistry", fit_score: 3, status: "New" };
  const data = { ...defaults, ...old, ...input };
  if (!data.name.trim()) throw fieldError("name", data.name, "Investor name is required");
  if (input.status && ["Contacted", "Followed Up"].includes(input.status) && !input.last_contacted_date && old?.status !== input.status) data.last_contacted_date = businessDate();
  const payload = [data.email || null, normalizeLinkedIn(data.linkedin_url), JSON.stringify(data)];
  const created = id === undefined;
  if (created) {
    const r = await client.query("INSERT INTO crm_investors(email_key,linkedin_key,data) VALUES($1,$2,$3::jsonb) RETURNING id", payload);
    id = r.rows[0].id;
  } else await client.query("UPDATE crm_investors SET email_key=$1,linkedin_key=$2,data=$3::jsonb,updated_at=NOW() WHERE id=$4", [...payload, id]);
  await activity(client, id!, created ? "Investor created" : `Updated: ${Object.keys(input).join(", ")}`, created ? "created" : "updated");
  if (old?.status !== data.status) await activity(client, id!, `${old?.status ?? "New record"} → ${data.status}`, `status:${data.status}`);
  return { investor: await getInvestor(client, id!), created };
}
export function summary(investors: Awaited<ReturnType<typeof listInvestors>>, now = new Date(), expertField?: Investor["expert_field"]) {
  if (expertField) investors = investors.filter(i => (i.expert_field || "Dentistry") === expertField);
  const today = businessDate(now);
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  const monday = day.toISOString().slice(0, 10);
  const counts = Object.fromEntries(STATUSES.map(status => [status, investors.filter(i => i.status === status).length]));
  const hasStatus = (i: typeof investors[number], statuses: string[]) => statuses.includes(i.status) || i.activity_log.some(a => statuses.some(s => a.kind === `status:${s}` || a.kind === `stage_migration:${s}`));
  const contacted = investors.filter(i => !!i.last_contacted_date || hasStatus(i, ["Contacted", "Followed Up", "Responded", "Meeting Set", "Committed"])).length;
  const responses = investors.filter(i => hasStatus(i, ["Responded", "Meeting Set", "Committed"])).length;
  return {
    total: investors.length, counts,
    contacted_this_week: investors.filter(i => i.last_contacted_date >= monday && i.last_contacted_date <= today).length,
    responses, response_rate: contacted ? responses / contacted : 0,
    meetings_set: investors.filter(i => hasStatus(i, ["Meeting Set", "Committed"])).length,
    followups_due_today: investors.filter(i => i.next_follow_up_date === today && i.status !== "Closed").length,
  };
}
