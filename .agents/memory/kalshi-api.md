---
name: Kalshi API structure
description: Per-station series tickers, correct field names, bracket boundary parsing, rate-limit mitigation.
---

**Why:** The unified `/events?series_ticker=KXHIGH` endpoint does not exist and returns 403. Each city has its own series.

**Station → series ticker:**
- KNYC → KXHIGHNY, KMDW → KXHIGHCHI, KAUS → KXHIGHAUS, KLAX → KXHIGHLAX, KPHL → KXHIGHPHIL
- KDFW → KXHIGHDFW but has **no open events** as of Jul 2026; falls back to stubs.

**Price fields:** `yes_bid_dollars` and `yes_ask_dollars` are **strings** like `"0.1900"`. Use `parseFloat * 100` for cents. NOT `yes_bid`/`yes_ask` (those are absent or 0).

**Bracket boundaries** (verified against live KXHIGHNY response):
- `strike_type: "less"`, cap=80 → YES if high < 80 → upperBound = cap−1 = 79
- `strike_type: "between"`, floor=80, cap=81 → YES if 80 ≤ high ≤ 81 → lowerBound=80, upperBound=81 (cap, not cap−1)
- `strike_type: "greater"`, floor=87 → YES if high > 87 → lowerBound = floor+1 = 88

**Rate limits:** 5 parallel requests in one burst can trigger HTTP 429. Stagger with 150 ms delay per station index (total < 1 s).

**How to apply:** See `artifacts/api-server/src/lib/kalshiApi.ts`, `fetchKalshiEvents()` and `parseKalshiMarket()`.
