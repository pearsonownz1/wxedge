---
name: Deployment env snapshot trap
description: Deployments freeze env vars at publish; dev-only switches leak into prod and silently disable features unless code defends itself
---

# Deployment env snapshot trap

**Rule:** Never let a dev-only env switch silently disable a core production behavior. Production must ignore such switches (with a loud warning), and every disabled/short-circuit path must emit a log line and a distinct machine-readable failure reason.

**Why:** 2026-07-25 incident — production showed zero markets all day across multiple redeploys. The deployment's own env store had retained `POLLING_ENABLED=false` from an earlier publish (deployments snapshot env at publish time and do NOT auto-sync with workspace env). The polling kill-switch short-circuited every Kalshi fetch with no log line and `failureReason: null`, which the UI rendered as a misleading "no current contracts" banner. Diagnosis took hours because there was zero log evidence — the smoking gun was 1ms "cache pre-warm complete" times (impossible with real network fetches).

**How to apply:**
- Kill-switches like `POLLING_ENABLED` are honored only when `NODE_ENV === "development"`. Production detection must match index.ts's `IS_PRODUCTION` heuristic (`NODE_ENV !== "development"`), NOT `=== "production"` — deployments may leave NODE_ENV unset.
- Boot log must print the effective state of any such switch (see "Kalshi polling state at boot").
- When adding a new env-gated behavior: give the disabled path its own failureReason value, propagate it to the UI status banner, and warn-once at runtime.
- Redeploying does NOT fix stale deployment env vars — they ride along. Fix in workspace prod env (flows in at next publish) and/or delete from the deployment's env pane.
- Debug heuristic: response times too fast to be real network calls = something is short-circuiting silently.
