---
name: Kalshi fee formula
description: Current fee model in distribution.ts; shape, rationale, and verification TODO.
---

**Current formula:** `kalshiFeePts(impliedPct) = 14 × (P/100) × (1 − P/100)` where P is the YES mid-price 0–100.

**Shape:** P×(1−P) — peaks at ~3.5 pts at the 50¢ level, falls toward 0 at extremes. This is correct: the interesting disagreements (40–60¢) are where the fee most matters.

**Why changed from flat 1pt:** A flat constant systematically flags phantom edges in the 40–60¢ zone where the true fee is 3–4×  higher.

**TODO:** The 14× multiplier is an approximation derived from "~7% per leg × 2 legs". Verify the exact rate from kalshi.com/trading/fees before using edge_pts for live position sizing. The ACTIONABLE threshold (currently 5 pts) may also need recalibration once you have ≥ 60 days of closed data.

**How to apply:** See `artifacts/api-server/src/lib/distribution.ts`, `kalshiFeePts()` function.
