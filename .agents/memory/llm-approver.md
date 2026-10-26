---
name: LLM Approver
description: Automated LLM decision layer for the approval queue — architecture, config, and implementation notes.
---

## Operating modes (APPROVER env var)

- `human` (default) — loop does nothing; human decides via UI
- `llm` — LLM decides immediately after `LLM_MIN_AGE_S` (default 60s) settling delay
- `llm_with_veto` — LLM stages intent after `LLM_MIN_AGE_S`; human can override during `LLM_VETO_WINDOW_S` (default 180s); executor fires after window on next tick

## DB schema additions (in production via migrate-llm script)

### New columns on `approvals`
- `decider text` — 'human' | 'llm', set when decision finalizes
- `llm_decision text` — 'approve' | 'deny', LLM's staged intent for veto mode (NULL until LLM runs)
- `llm_decided_ts timestamptz` — when LLM expressed intent (start of veto window)
- `llm_rationale text` — 2-4 sentence rationale from LLM
- `llm_confidence real` — confidence 0-1

### New table: `llm_decisions`
Full audit trail: approval_id, ts, model_name, prompt_version, payload_json (jsonb), response_json (jsonb), decision, latency_ms.

Migration: `pnpm --filter @workspace/trader run migrate-llm`

## Key implementation files

- `artifacts/trader/src/llm-approver.ts` — main loop: `startLlmApprover(config)` + `runLlmApproverTick(config)`
- `artifacts/trader/src/index.ts` — calls `startLlmApprover(config)` after leader lock acquired
- `artifacts/api-server/src/routes/approvals.ts` — PATCH body accepts `decider?: 'human' | 'llm'`
- `artifacts/api-server/src/lib/approvalsDb.ts` — `decideApproval()` has `decider` param (default 'human')
- `artifacts/wx-edge/src/pages/approvals.tsx` — DecisionBadge shows 🤖/👤; LLM rationale expandable row in history

## OpenAI client (trader-side)

Direct `openai` package (not @workspace/integrations-openai-ai-server to avoid cross-package project reference).
Reads: `AI_INTEGRATIONS_OPENAI_API_KEY` (set by Replit integration) + `AI_INTEGRATIONS_OPENAI_BASE_URL`.
Default model: `gpt-5.6-luna` (cost-effective; overridable via `LLM_MODEL` env var).
Structured output via `response_format: { type: "json_schema", ... }`.
Note: gpt-5+ models don't accept `temperature` — omit it.

## LLM execution path (spec §10 invariant)

LLM decisions execute through `PATCH /api/approvals/:id` with `{action, decider: 'llm'}`.
This gives the LLM ZERO extra powers — same revalidation, CAS guard, and risk caps as human.
OpenAI outage → no action (deny-by-default); proposal stays pending and expires naturally.
409 conflict on PATCH → another decider won the CAS, log and move on.

## Config knobs (all in config.ts with env overrides)

| Env var | Default | Meaning |
|---|---|---|
| APPROVER | 'human' | human \| llm \| llm_with_veto |
| LLM_MIN_AGE_S | 60 | Settling delay before LLM decides |
| LLM_VETO_WINDOW_S | 180 | Veto window before execution |
| LLM_DAILY_CAP_CENTS | = max_daily_loss_cents | Separate LLM spend ceiling |
| LLM_MODEL | 'gpt-5.6-luna' | OpenAI model id |
| API_BASE_URL | 'http://localhost:8080' | API server for LLM PATCH calls |

## P&L split

`approvals.decider` field enables "human-approved vs AI-approved P&L" in the grant report.
Query: `WHERE decider = 'llm' AND recheck_ok = true AND decision = 'approved'`.
