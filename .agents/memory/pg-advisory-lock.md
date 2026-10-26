---
name: Postgres advisory lock keep-alive
description: Replit managed Postgres kills idle connections with 57P01; the advisory lock held connection needs a keep-alive ping
---

## The crash loop problem
Replit's managed Postgres terminates idle connections every ~30 seconds with error code 57P01
("terminating connection due to administrator command"). The trader holds a dedicated connection
for the session-level advisory lock (pg_try_advisory_lock). If that connection goes idle, Postgres
kills it, the error handler fires process.exit(1), and the API server restarts the trader.

**Why this matters:** The restart backoff doubles (10s → 20s → 40s → ... → 30s cap after fix).
During the crash loop the trader ran 3–8 min, crashed, waited for backoff, repeat.
No signals could accumulate because snapshots required a running trader AND fresh Kalshi data.

## The fix
Add a `setInterval` keep-alive on the held `_leaderConn` that sends `SELECT 1` every 25 seconds.
This resets Postgres's idle timer and prevents the 57P01 kill.

```typescript
const keepAlive = setInterval(async () => {
  try { await client.query("SELECT 1"); } catch { /* error handler fires */ }
}, 25_000);
keepAlive.unref(); // don't hold the process open for pings alone
```

## Restart backoff
Changed TRADER_RESTART_MAX_MS from 5 minutes to 30 seconds in api-server/src/index.ts.
Fast restart is better than long backoff when the DB kill is transient.

**How to apply:** Any new held-connection pattern in the trader needs this same keep-alive.
Check that the interval is .unref()'d so it doesn't block graceful shutdown.
