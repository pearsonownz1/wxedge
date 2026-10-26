---
name: IEM data sources
description: Iowa Environmental Mesonet API quirks — station IDs, METAR availability, 1-min lag audit result, NWS rawMessage.
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
`/stations/{id}/observations` returns `rawMessage: ""` for all stations tested. IEM must be the primary source for METAR text.

### IEM METAR archive — CONFIRMED, near-real-time
`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py` with `report_type=3&report_type=4` returns full METAR text including T-group. Confirmed for KNYC: `T01890144`. Available within minutes of issuance.

### IEM 1-minute ASOS — PHASE 0 RESULT: real but ~3-day lag
Endpoint: `https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py`

**Correct param:** `vars=tmpf` — NOT `vars[]=tmpf` (PHP array notation). Both return empty results for dates in the lag window, but use the correct form in production code.

**Lag:** NYC/MDW/LAX/PHL/DFW ~3 days behind wall clock. AUS ~7+ days. Data IS in the archive; it fails the intraday gate but is usable for nightly backfill and settlement verification.

**Do NOT mistake "no rows for today" for "station not in network."** The network listing API also requires a `station=` param; without it it returns a validation error (not an empty list). Always verify by querying known-good historical dates (7 days ago) before concluding absence.

**Gate decisions** (see docs/iem-latency-audit.md):
- Phase 1 intraday: **blocked** (lag too high)
- Phase 1 nightly backfill/settlement verification: **go**
- Phase 2 METAR: **go** (separate endpoint, near-real-time)
- Phase 3 running_high: **go**

### METAR T-group decoder
`T0sssdddd` — 9 chars, starts with T. `T01890144` → temp=18.9°C, dew=14.4°C.
- First digit after T: `0` = positive, `1` = negative
- `sss` = temp in tenths °C; `dddd` = dewpoint in tenths °C
1-group (6h max): `1xxxx` — 5 chars, only at synoptic hours (00/06/12/18Z).

### User-Agent
`WxEdge/1.0 (sellinghighs.com; guy@gcs.org)`

**Why:** Phase 0 audit 2026-07-25 confirmed lag pattern. CTO correctly challenged empty-result conclusion; re-query with historical dates revealed real but delayed data.

**How to apply:** For nightly backfill, query trailing 7-day window. For intraday, use IEM METAR (asos.py). For any IEM 1-min query, use `vars=tmpf` not `vars[]=tmpf`.
