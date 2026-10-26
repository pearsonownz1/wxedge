---
name: Trader workflow config
description: How the trader background process is configured, deployed, and protected against multi-instance races.
---

## Dev vs production

- **Dev**: trader runs as its own Replit workflow (`artifacts/trader: Trader`). The API server detects `NODE_ENV=development` and skips spawning a child trader.
- **Production**: trader is spawned as a child process from `artifacts/api-server/src/index.ts` on startup, with `PORT=8091` (avoids collision with API server's 8080). Auto-restarts with exponential backoff (10s → 20s → ... → 5 min cap).

There is NO separate trader artifact or artifact.toml for the trader — it is not a registered production artifact.

## Leader election advisory lock

Autoscale can run multiple API server instances, each of which spawns a trader child. To prevent simultaneous traders (which would cause triple Kalshi polling, racing risk reads, and duplicate proposals), the trader uses a Postgres session advisory lock at startup.

**Implementation** (in `artifacts/trader/src/index.ts`):
- Lock key: `7827369` (constant "WX-TRADER")
- On startup: `SELECT pg_try_advisory_lock(7827369)` on a dedicated pool connection
- If acquired: proceed as leader; hold the connection indefinitely (lock tied to session)
- If not acquired: log "Standby — another trader instance holds the leader lock", retry every 60s
- On process exit: connection closes automatically, lock released, next standby takes over

The dedicated connection is intentionally never released back to the pool. This is correct — releasing it would drop the lock.

**Why:** Autoscale deployment (3 max instances) means multiple traders can run simultaneously without the lock. DB constraints (partial unique index on proposals, CAS on approve) absorb some duplicate blast, but concurrent traders would still triple Kalshi 429s and produce confusing duplicate-rejection log noise.

**How to apply:** The lock is session-level (`pg_try_advisory_lock`, not xact-level). Never use `pg_try_advisory_xact_lock` here — xact-level locks are released at transaction end, not process exit.

## Instance pin recommendation

The CTO recommends also pinning the deployment to max=1 instance (Autoscale setting) as a belt-and-suspenders measure. This is a UI setting in the Replit publishing settings — not configurable via artifact.toml. The advisory lock is the primary fix; the pin eliminates standby overhead entirely.

**Open question**: Does Replit Autoscale with min=1 ever idle the instance overnight? The snapshot continuity depends on the API server (and thus the trader child) staying alive. The overnight snapshot record tomorrow morning will answer this empirically.

## Trader config path

Config file: `../config/risk.json` (one level up from `src/`), i.e. `artifacts/trader/config/risk.json`.

## Health endpoint

Trader exposes `GET /health` on its health port. Returns `{ status, mode, execution_mode, cycle_count, last_cycle_ts }`. In production: port 8091. In dev workflow: port 8090.
