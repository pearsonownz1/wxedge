# IEM 1-Minute ASOS Latency Audit — Phase 0

**Audited:** 2026-07-25  
**Method:** Queried IEM `asos1min.py` for all 6 trading stations, 3-hour lookback window (later extended to 6h and 24h), 4-minute poll cadence, from the production network position.

## Results

| Station | IEM ID | 1-Min Rows (24h) | Status |
|---------|--------|-------------------|--------|
| KNYC    | NYC    | 0                 | ❌ No data |
| KMDW    | MDW    | 0                 | ❌ No data |
| KAUS    | AUS    | 0                 | ❌ No data |
| KLAX    | LAX    | 0                 | ❌ No data |
| KPHL    | PHL    | 0                 | ❌ No data |
| KDFW    | DFW    | 0                 | ❌ No data |

**Verdict per spec decision rule:** Latency cannot be computed because no data is available.  
All 6 stations → **settlement-verification only** (no intraday use).

## Root Cause

The IEM `ASOS1MIN` network contains 0 stations. These 6 stations are major-airport and urban ASOS sites; the IEM 1-minute service appears to cover a different (likely rural/mesonet) station set. Cross-check: Chicago O'Hare (ORD) also returned 0 rows from the same endpoint.

The IEM METAR archive (`asos.py` with `report_type=3&4`) **does** return full METAR text for all 6 stations and is near-real-time, confirmed for KNYC at 08:51 UTC today. This is the source for Phase 2.

## Phase 1 Gate Decision

| Phase | Decision |
|-------|----------|
| Phase 1 (obs_minute from IEM 1-min) | **Blocked** — no 1-min data available for any trading station. Drop `obs_minute` from the pipeline; the table and poller have no input source. |
| Phase 2 (METAR remarks from IEM asos.py) | **Go** — confirmed working, near-real-time, full T-group and 1-group remarks available. |
| Phase 3 (unified running_high) | **Go** — sources: METAR T-group (tenths precision) + METAR 1-group (synoptic hours) + existing NWS hourly. Minute-by-minute timestamps are not achievable, but per-observation tenths precision is. |

## Implication for Phase 3 running_high

Without 1-min data, `running_high()` sources are:

1. **METAR T-group** (`T01890144` → 18.9°C) — every METAR report, ~hourly for standard ASOS, available within minutes of issuance via IEM.  
2. **METAR 1-group** (`1xxxx`) — 6-hour maximum, reported at 00/06/12/18Z synoptic hours.  
3. **NWS hourly** — existing `obs_hourly` source (whole-degree, current pipeline).

T-group data arrives at the same cadence as hourly ASOS (roughly 52/55/58 minutes past the hour for METAR issuance) but with tenths-of-degree precision instead of whole degrees. This is the precision gain the spec targets — it still delivers the bracket-boundary edge; the source is METAR, not a sub-hourly feed.

## Alternative 1-Min Sources (for future investigation)

If minute-level temperature data becomes important:
- **MADIS 1-min ASOS** (NOAA Meteorological Assimilation Data Ingest System) — federal, requires registration.
- **WeatherUnderground PWS** — not official NWS data, not suitable for settlement verification.
- **IEM HFMETAR archive** — higher-frequency METARs (SPECI reports) when conditions change rapidly; available via the same IEM METAR endpoint.
