---
name: IEM data sources
description: Iowa Environmental Mesonet API quirks — station IDs, METAR availability, 1-min latency audit result, and NWS rawMessage.
---

## Key facts

### Station IDs
IEM uses **3-letter ASOS codes**, not 4-letter ICAO. Strip the leading K:
```
KNYC → NYC,  KMDW → MDW,  KAUS → AUS,
KLAX → LAX,  KPHL → PHL,  KDFW → DFW
```
Sending "KNYC" to IEM returns "Unknown station provided."

### NWS rawMessage is always empty
The NWS API `/stations/{id}/observations` returns `rawMessage: ""` for all stations (KNYC, KMDW, KAUS confirmed). Temperature comes through processed but not raw METAR string. **IEM must be the primary source for METAR text, not NWS.**

### IEM METAR archive — CONFIRMED WORKING
`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py` with `report_type=3&report_type=4` returns full METAR text including T-group. Confirmed for KNYC: `KNYC 250851Z AUTO … RMK AO2 SLP203 T01890144 56013 $`. Near-real-time (minutes after issuance).

### IEM 1-minute ASOS — PHASE 0 RESULT: NOT AVAILABLE
**Endpoint:** `https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py`

**Audit date:** 2026-07-25. All 6 stations returned 0 rows over a 24-hour window. The ASOS1MIN network query also returned 0 stations total. ORD also returned 0 rows — this is not specific to our stations; the IEM 1-min service does not cover major-airport ASOS sites.

**Gate decision (per spec):** Phase 1 (`obs_minute` table) is **blocked** — no input source exists. Phase 2 (METAR) and Phase 3 (unified running_high) proceed. See `docs/iem-latency-audit.md`.

### METAR T-group decoder
T-group: `T0sssdddd` — 9 chars, starts with T. `T01890144` → temp=18.9°C, dew=14.4°C.
- First digit after T: `0` = positive, `1` = negative
- `sss` = temp in tenths °C; `dddd` = dewpoint in tenths °C
1-group (6h max): `1xxxx` — 5 chars, only at synoptic hours (00/06/12/18Z).

### User-Agent
IEM is a free university service. Always use: `WxEdge/1.0 (sellinghighs.com; guy@gcs.org)`

**Why:** Phase 0 spec gate executed 2026-07-25; result changes Phase 1 design entirely.

**How to apply:** Skip `obs_minute` table and IEM 1-min poller. Phase 2 uses IEM `asos.py` METAR archive. Phase 3 `running_high()` sources: METAR T-group + METAR 1-group + NWS hourly (no minute-level data available).
