import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const rawConnectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_PRISMA_URL ||
  "postgres://localhost:5432/postgres";

function cleanPgUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("supa");
    return u.toString();
  } catch {
    return raw;
  }
}

function interpolateSql(sql: string, params?: unknown[]): string {
  if (!params || params.length === 0) return sql;
  return sql.replace(/\$(\d+)/g, (_m, idxStr) => {
    const idx = Number(idxStr) - 1;
    const val = params[idx];
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number" && Number.isFinite(val)) return String(val);
    if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return "'" + str.replace(/'/g, "''") + "'";
  });
}

function hydrateDates(row: Record<string, any>): Record<string, any> {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const k of ["created_at", "updated_at"]) {
    if (typeof out[k] === "string") {
      const d = new Date(out[k]);
      if (!Number.isNaN(d.getTime())) out[k] = d;
    }
  }
  return out;
}

async function supabaseRpcQuery(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> {
  const supaUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const queryText = interpolateSql(sql, params);
  const resp = await fetch(`${supaUrl}/rest/v1/rpc/crm_exec_sql`, {
    method: "POST",
    headers: {
      apikey: supaKey,
      Authorization: `Bearer ${supaKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query_text: queryText }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`Supabase SQL error (${resp.status}): ${errText}`) as Error & { code?: string };
    if (errText.includes("23505") || errText.includes("duplicate key")) err.code = "23505";
    throw err;
  }
  const data = await resp.json();
  const rows = Array.isArray(data) ? data.map(hydrateDates) : [];
  return { rows, rowCount: rows.length };
}

const pgPool = new Pool({
  connectionString: cleanPgUrl(rawConnectionString),
  max: 10,
});

const useSupabaseRpc = () =>
  Boolean((process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY);

export const pool = new Proxy(pgPool, {
  get(target, prop, receiver) {
    if (prop === "query" && useSupabaseRpc()) {
      return (sql: string, params?: unknown[]) => supabaseRpcQuery(sql, params);
    }
    if (prop === "connect" && useSupabaseRpc()) {
      return async () => ({
        query: (sql: string, params?: unknown[]) => supabaseRpcQuery(sql, params),
        release: () => {},
      });
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const db = drizzle(pgPool, { schema });

export * from "./schema";
export * from "./pipelineHealth";
