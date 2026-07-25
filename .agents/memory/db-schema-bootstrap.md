---
name: DB schema bootstrap
description: How to recover when drizzle-kit push silently skips new tables in this monorepo.
---

## The rule
When `lib/db/src/schema/index.ts` re-exports from a module that didn't exist on disk when `drizzle-kit push` last ran, drizzle-kit marks the schema "in sync" and will say "No changes detected" on every subsequent push — even after the missing file is restored.

**Why:** drizzle-kit's push resolves the schema at the time of the run. If a re-exported module is absent, the module loader silently skips it (no fatal error). The resulting partial schema is stored as the baseline; later pushes diff against that partial baseline.

**How to apply:** After restoring missing schema files, run `drizzle-kit push` once. If it still says "No changes detected" but the tables are absent, create them directly with raw SQL using `CREATE TABLE IF NOT EXISTS` — this is safe to run repeatedly. The PostgreSQL tables are the authoritative source of truth; the drizzle baseline only controls migration diffs.

Recovery query pattern (run via node --input-type=module from lib/db):
```javascript
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`CREATE TABLE IF NOT EXISTS <name> ( ... )`);
await pool.end();
```
