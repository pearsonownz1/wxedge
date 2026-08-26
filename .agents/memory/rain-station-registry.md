---
name: Rain settlement station registry
description: How KXRAIN settlement stations are resolved from Kalshi's own text, and the IEM lookup gotcha that trips this up.
---

Kalshi's `rules_primary` text on every KXRAIN market names the exact settlement station verbatim (e.g. "at CLIORD in Chicago"). The `CLIxxx` token is an NWS CLI (Climate report) station code — extract it with a regex instead of guessing a city-center coordinate or reusing the city's temperature-market station.

**Why:** a hardcoded city→coordinate table silently drifts from Kalshi's actual settlement source (missed newly-added cities, wrong airport — e.g. Chicago rain settles at O'Hare/KORD while the temperature market for Chicago uses Midway/KMDW, a different station entirely).

**How to apply:** when resolving a CLI code to a precise station, query IEM's NWSCLI network table specifically —
`https://mesonet.agron.iastate.edu/api/1/network/NWSCLI.json` — and match by code/name. Do NOT just hit `/api/1/station/K{id}.json`; that endpoint can return a different, imprecise network (e.g. RAOB upper-air, rounded coordinates) for the same 3-letter id instead of the surface CLI station.

**Where it lives:** `lib/db/src/rainStations.ts` (`@workspace/db`) — shared DB-backed registry (`rain_stations` table), not a static per-artifact map, since both the trader and api-server need the same live source of truth. `VERIFIED_STATIONS` there is the human-editable ground truth; unresolved cities are stored as `confidence='low_confidence'` (null station fields, never guessed) and both `rainSignalEngine.ts` (trader) and `routes/rain.ts` (api-server) reject them with eligibility reason `station_unresolved` — same fail-closed pattern as `unknown_city`. A daily auto-refresh (`resolveRainStationsFromKalshi`) runs from both artifacts using each cycle's live discovery data, so a newly added Kalshi city gets flagged automatically instead of silently missing.
