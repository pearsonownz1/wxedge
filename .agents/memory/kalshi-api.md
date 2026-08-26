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

## KXRAIN daily markets
- Rain events use the same `YYMMMDD` token: `KXRAIN-26AUG25` is Aug. 25, 2026. An active event can still represent a city’s local calendar day after UTC has advanced, so do not discard it solely because its date is before the UTC day.
- Kalshi can return a temporary 429 on rain discovery; make one bounded retry and retain the latest valid discovery for the next cycle rather than blanking the rain pipeline.

**Why:** The first rain cycle misread the date token and then encountered a rate limit, which suppressed all rain discovery despite active contracts.

**How to apply:** Parse the first two digits as the year and the last two as the day; trust `status=active` for eligibility, and fail over to a recent valid discovery only after the retry fails.

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

## orderbook_fp endpoint format (learned 2026-07-25)
- `orderbook_fp.yes_dollars` / `no_dollars` are `[price, size]` tuples where BOTH values are **strings** (`"0.4000"`), sorted **ascending** by price — index 0 is the WORST level, not the best. Best yes bid = highest yes price; best ask = 100¢ − highest no price. Treating index 0 as best renders every book as a fictitious 1¢/99¢ shell.
- Event-endpoint sentinels: `yes_bid_dollars "0.0000"` = no resting bids (not a 0¢ price); `yes_ask_dollars "1.0000"` = no resting asks. Both must map to null, or one-sided books masquerade as 0%/100% probabilities.
