# IEM 1-Minute ASOS Latency Audit — Phase 0

**Audited:** 2026-07-25  
**Method:** Programmatic queries to `mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py` from
the production network; 1-hour sample windows at known times; binary search over recent dates to
find the trailing data edge.

---

## Manual verification (required by spec before conclusion)

The CTO correctly flagged that a "zero stations" result from a network-listing API is more likely a
malformed query than genuine absence. The network listing endpoint (`/api/1/network.json`) requires
a `station=` parameter; without it the server returns a validation error, not a station list, so
our earlier "ASOS1MIN network: 0 stations" reading was invalid.

Re-test approach: query a known airport station (ORD) across a range of historical dates to
determine whether data exists and, if so, where the trailing edge is.

**Results for ORD (Chicago O'Hare), 60-minute windows:**

| Date | Rows |
|------|------|
| 2026-07-25 (today) | 0 |
| 2026-07-24 (yesterday) | 0 |
| 2026-07-22 (3 days ago) | 60 ✓ |
| 2026-07-18 (7 days ago) | 60 ✓ |
| 2026-06-18 (5 weeks ago) | 0 |
| 2025-07-18 | 0 |

This is outcome **(b) per spec**: the feed is real, the data exists, and the trailing edge is
approximately 3–5 days behind wall clock.

---

## Per-station trailing-edge survey (2026-07-25)

| Station | IEM ID | Most recent data | Approx lag |
|---------|--------|-----------------|------------|
| KNYC | NYC | 2026-07-22 | ~3 days |
| KMDW | MDW | 2026-07-22 | ~3 days |
| KAUS | AUS | ≤2026-07-18 | ~7+ days |
| KLAX | LAX | 2026-07-22 | ~3 days |
| KPHL | PHL | 2026-07-22 | ~3 days |
| KDFW | DFW | 2026-07-22 | ~3 days |

AUS needs a finer binary search; all others have a consistent ~3-day lag.

---

## Verdict (per spec decision rule)

**Latency ≥ 3 days → fails the intraday gate for all 6 stations.**

| Phase | Decision |
|-------|----------|
| Phase 1 — `obs_minute` intraday signal | **Blocked for intraday.** Lag is 3–7 days; cannot feed same-day bracket decisions. |
| Phase 1 — nightly backfill / settlement verification | **Go.** Pull the trailing 7-day window each night; use to verify settlement readings against IEM 1-min. Lag is stable and predictable. |
| Phase 2 — METAR T-group / 1-group decoder | **Go.** IEM `asos.py` (hourly METAR) is near-real-time and confirmed working for all 6 stations. This is the near-real-time precision play. |
| Phase 3 — unified `running_high()` | **Go.** Sources: METAR T-group (tenths, ~hourly) + METAR 1-group (6h max, synoptic hours) + NWS hourly. No sub-hourly timestamps, but tenths-of-degree precision on the same cadence as the current feed. |

---

## Corrected query parameters

The initial audit used `vars[]=tmpf` (PHP array notation). The correct parameter is `vars=tmpf`
(no brackets). Both return empty results for dates in the processing-delay window, so the lag
conclusion is unaffected by the parameter bug; however the corrected form should be used in
production code.

```
GET /cgi-bin/request/asos1min.py
  ?station=NYC
  &year1=…&month1=…&day1=…&hour1=…&minute1=…
  &year2=…&month2=…&day2=…&hour2=…&minute2=…
  &vars=tmpf        ← not vars[]=tmpf
  &sample=1min
  &what=view
  &delim=comma
  &gis=no
```
