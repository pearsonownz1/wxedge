---
name: Running-high vs official CLI
description: How to reproduce NWS CLI daily highs from METAR data; why NWS API obs run 1–6°F off; IEM asos.py rate limits.
---

## Rule
The official CLI daily high is reproduced (0–1°F, usually exact) by taking, over the 00:00–23:59 **LST day**, the max of METAR remark T-groups (tenths-°C) and 6-hr max 1-groups (synoptic hours), rounded to whole °F. NWS API hourly observations must never override this value.

**Why:** Verified Jul 2026 vs IEM cli.py for all 6 stations. NWS API obs fail three ways: integer-°C rounding runs 1–2°F hot (36°C → "97" when the tenths reading is 96.1); hourly cadence misses peaks that 6-hr max groups capture (MDW 88 vs CLI 91); and a rolling last-24h window leaks yesterday's high into today.

**How to apply:**
- Running-high source is `iemMetar.ts` (asos.py, report_type 3+4). NWS obs are fallback only, never combined via max().
- Only count a 6-hr 1-group when its full 6-hour lookback lies inside the current LST day, else it covers yesterday evening.
- IEM asos.py 429s on ~6 parallel requests — always fetch all stations in ONE request (repeated `station` params) with a shared in-flight promise.
- IEM cli.py (`/json/cli.py?station=K{XXX}&year=`) is the ground truth for settlement audits.
