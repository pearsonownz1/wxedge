---
name: Snapshot collector architecture
description: How the 4-minute snapshot logger and outcome logger are wired; deployment survival requirements.
---

**Tables:** `snapshots` and `outcomes` in the Replit PostgreSQL DB, schema in `lib/db/src/schema/snapshots.ts`, managed by Drizzle/drizzle-kit.

**Data flow:**
1. `warmCache()` in `warmup.ts` fires on startup + every 4 min via `setInterval`.
2. After `warmCache()` completes, `logSnapshots()` in `snapshotLogger.ts` reads from warm cache and bulk-inserts one row per live bracket per station.
3. `checkAndWriteOutcomes()` in `outcomeLogger.ts` runs on every poll; for past settlement dates with no outcome row it fetches the NWS CLI product and writes `final_high_f`.

**Skips:** Stations with `usingStubData = true` (KDFW, or any station if Kalshi is down) are not logged.

**NWS CLI location codes:** KNYC→NYC, KMDW→MDW, KAUS→AUS, KDFW→DFW, KLAX→LAX, KPHL→PHL. The CLI is issued ~6-9 AM local time the morning after settlement; the outcome logger retries on each subsequent poll until it appears.

**Deployment survival requirement:** `setInterval` only fires while the Node process is alive. A sleeping dev server or autoscaling deployment will produce gaps. Gap-free overnight data requires a Reserved VM deployment on Replit. Verify by checking that `ts_utc` rows in the snapshots table are ≤ 5 min apart across a full night.

**Why:** The purpose of the whole tool is the reliability curve — 60 days of (model %, outcome) pairs that prove whether the model's 70% means 70%. Every gap in the snapshot table is a lost data point.
