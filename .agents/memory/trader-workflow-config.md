---
name: Trader workflow config
description: How the trader background service is wired into Replit workflows.
---

## The rule
The trader (`artifacts/trader`) is NOT a registered artifact service. Its workflow must be created with `configureWorkflow`, not `WorkflowsRestart` against a managed artifact name.

**waitForPort:** Do NOT set `waitForPort` on the trader workflow. Replit only injects `PORT` for artifact-managed services; a plain `configureWorkflow` call does not inject `PORT`, so the process falls back to its default (8090). If `waitForPort` is set to any other value the workflow times out.

Config: `{ name: "artifacts/trader: Trader", command: "pnpm --filter @workspace/trader run dev", outputType: "console" }`

**Config file path:** `src/config.ts` resolves risk.json as `resolve(__dirname, "../config/risk.json")` — one level up from `src/`, landing at `artifacts/trader/config/risk.json`. Two levels up (`../../`) overshoots into `artifacts/`.

**Why:** The trader has a health HTTP endpoint on port 8090 (hardcoded default) for manual curl checks, but this is not the Replit workflow health mechanism. The workflow just needs to stay running.
