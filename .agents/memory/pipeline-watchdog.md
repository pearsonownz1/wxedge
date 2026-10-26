---
name: Pipeline watchdog
description: How the "pipeline gone dark" detection works and its thresholds
---

# Pipeline watchdog

One shared function (`computePipelineHealth` in @workspace/db) drives both the trader's hourly log alert and the dashboard banner via `GET /api/pipeline-health`. Keep the two consumers on this single implementation — divergent thresholds would make the banner and the logs disagree.

**Statuses:** `dark` (0 signals evaluated in 24h), `blocked` (0 live signals and ≥50% of suppressions are systemic gates — staleness/obs_stale/book_incoherent/gap_data/no_price), `quiet` (0 live but dominated by below_threshold/lock_dead — legit), `stalled` (live signals but 0 proposals in 24h), `ok`.

**Why:** a week-long 100%-suppressed outage looked identical to "no good trades today"; the distinguishing evidence is the suppressed_reason mix, not the proposal count alone.

**How to apply:** any new suppressed_reason value must be classified as systemic or benign in the shared function, or `blocked` detection silently degrades (unknown reasons count as systemic by default). Banner hides for ok/quiet; red for dark/blocked, amber for stalled.
