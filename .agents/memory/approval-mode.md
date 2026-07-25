---
name: Approval Mode (Phase B)
description: Human-in-the-loop approval queue — schema, lifecycle, and implementation notes.
---

## Schema (live in DB as of 2026-07-25)

- `approvals` table: `id, signal_id (UNIQUE FK), ticker, side, proposed_ts, expires_ts, card_json (text), decision, decision_ts, latency_ms (bigint), recheck_ok, recheck_note`
- Partial unique index: `one_open_proposal ON approvals (ticker, side) WHERE decision IS NULL`
- `signals.status` column added: `DEFAULT 'live'`, set to `'pending_approval'` in approval mode
- `orders.approval_id` column added: integer FK to approvals.id, set when placed via human approval
- Orders placed via approval use `mode = 'approval'` (distinct from `'shadow'`)

## Key implementation files

- `lib/db/src/schema/trading.ts` — Drizzle schema (all 6 trading tables + approvals)
- `artifacts/trader/src/approvals.ts` — `createProposal()`, `sweepExpiredProposals()`, `renderTemplateCard()`
- `artifacts/trader/src/db.ts` — `insertApproval()`, `getPendingApprovalForTicker()`, `sweepExpiredApprovals()`, `markSignalPendingApproval()`, `getLatestInputByTicker()`
- `artifacts/trader/src/executor.ts` — routes to `createProposal()` when `execution_mode === 'approval'`
- `artifacts/trader/src/index.ts` — startup sweep + per-tick sweep in `runScheduledJobs()`
- `artifacts/api-server/src/routes/approvals.ts` — GET/PATCH/report endpoints
- `artifacts/api-server/src/lib/approvalsDb.ts` — all approval DB reads/writes for API server
- `artifacts/wx-edge/src/pages/approvals.tsx` — approval queue UI page

## Critical gotchas

**snapshots table has no ticker column.** The ticker lives on `books`. All queries joining books → snapshots must use: `books.station_id = snapshots.station_id AND ABS(books.bracket_lo - COALESCE(snapshots.bracket_lower_f, -9999)) < 0.01`. The `getCurrentMarketState()` function in `approvalsDb.ts` uses this join.

**buildRiskState mode filter removed.** The trader's `buildRiskState` previously filtered `WHERE mode = ${mode}`. Updated to count ALL orders (shadow + approval) so risk limits apply across modes — the conservative direction.

**Execution mode config.** `risk.json` has `execution_mode: "approval"` (default). Overridable via `EXECUTION_MODE` env var. The trader logs it at startup and stamps it in the health endpoint.

**Migration script.** `artifacts/trader/scripts/migrate-approvals.ts`, runnable via `pnpm --filter @workspace/trader run migrate`. The drizzle-kit silent-skip issue still applies — always use raw SQL for new tables.

## CAS / concurrency

PATCH /api/approvals/:id uses `UPDATE approvals SET decision=... WHERE id=? AND decision IS NULL RETURNING id` as the compare-and-set. If 0 rows returned → 409. Idempotent approve on already-approved row returns existing order from `orders WHERE approval_id = ?`.

## Counterfactual P&L (grant report)

Denied trades: join `approvals (denied) → signals → settlements → books (at proposal time)`. Fill assumption: `fill_certain` only when book showed ask ≤ limit at proposal time. Report labels everything `"estimated, assumes fill"`. Never blend certain + uncertain into one number.
