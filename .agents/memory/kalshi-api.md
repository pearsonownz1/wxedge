---
name: Kalshi API structure
description: Kalshi API auth, ticker format, price fields, per-station series, and known gaps
---

## Auth
Kalshi market reads are FULLY PUBLIC — no Authorization header needed or wanted.
Sending an invalid/expired bearer token causes 401/403 even on public endpoints.
RSA signing (KALSHI_KEY_ID / KALSHI_PRIVATE_KEY) is only needed for order execution (Phase B).

**Why:** Discovered when production was 401ing all day because the old KALSHI_API_KEY bearer
token was being sent. Removing the header immediately unblocked Kalshi data flow.

## Series tickers (per-station — no unified KXHIGH series)
- KNYC → KXHIGHNY
- KMDW → KXHIGHCHI
- KAUS → KXHIGHAUS
- KLAX → KXHIGHLAX
- KPHL → KXHIGHPHIL
- KDFW → NO SERIES (no Kalshi events; returns empty brackets, usingStubData=false)

## Event/ticker format
- Ticker: `KXHIGHNY-26JUL25` = year 2026, month JUL, day 25 (YYMMMDD, NOT DDMMMYY)
- `strike_date` field on event object (not `close_time`) is the settlement timestamp
- Two events open at once: today and tomorrow

## Price fields on nested markets
- `yes_bid_dollars` and `yes_ask_dollars` — dollar strings e.g. "0.3100"
- Multiply × 100 and round to get cents
- `strike_type`: "less" | "between" | "greater"
- `cap_strike` and `floor_strike` for bracket bounds
- `with_nested_markets=true&limit=1` in the fetch — returns today's event first

## POLLING_ENABLED env var
- `[userenv.development]` in .replit sets `POLLING_ENABLED=false` — dev only, not production
- Production defaults to enabled (undefined → true in pollingEnabled())
- Snapshots only get written when polling is enabled AND Kalshi returns usingStubData=false
