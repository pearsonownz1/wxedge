---
name: Kalshi API structure
description: How Kalshi weather market data is structured and accessed; auth, date formats, field names.
---

## Key facts

- Per-station series tickers: KXHIGHNY, KXHIGHCHI, KXHIGHAUS, KXHIGHLAX, KXHIGHPHIL. No unified KXHIGH series. KDFW has no Kalshi series (excluded from trading).
- Bid/ask prices are string dollars in the API (`yes_bid_dollars: "0.1400"`), not integers. Parse with `parseFloat * 100` → cents.
- Bracket bounds come from `strike_type` + `floor_strike`/`cap_strike` fields (not subtitle regex).
- Ticker date format is **YYMMMDD** (e.g. `26JUL25` = 2026-Jul-25). NOT DDMMMYY.
- The event object has `strike_date` (settlement timestamp) — NOT `close_time`. The `close_time` field only exists on individual market objects, not the event object.
- The events API is **fully public** — no authentication required. Even a fake bearer token returns 200. The `KALSHI_API_KEY` secret is not needed for reading market data.
- Auth header format is `Authorization: Bearer <key>` — but since the API is public, this is irrelevant for reads.
- Orderbook endpoint (`/markets/{ticker}/orderbook`) is also public, returns `orderbook_fp.yes_dollars` and `no_dollars` as `[price, size]` arrays. Empty arrays = no resting orders (common for thin markets).
- The `with_nested_markets=true` parameter on the events endpoint includes `yes_bid_dollars`/`yes_ask_dollars` per market — these are the primary bid/ask source, more reliable than the separate orderbook endpoint for thin markets.

**Why:** The auth requirement and field name issues caused multiple failed deploys and banner misclassification bugs.

**How to apply:** Always use `event["strike_date"]` not `event["close_time"]` for stale filtering. Never hard-depend on auth being required. For bid/ask, prefer event-embedded prices over orderbook when the book is empty.
