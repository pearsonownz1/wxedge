import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_PRISMA_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL or POSTGRES_URL must be set. Did you forget to provision a database?",
  );
}

const useSsl =
  connectionString.includes("supabase.co") ||
  connectionString.includes("pooler.supabase.com") ||
  connectionString.includes("sslmode=require");

export const pool = new Pool({
  connectionString: connectionString.replace(/[?&]sslmode=require/g, ""),
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 10,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./pipelineHealth";
