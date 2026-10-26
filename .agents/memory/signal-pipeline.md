---
name: Signal pipeline suppression & unblocking rules
description: Durable rules for diagnosing zero-proposal periods and keeping the signal→risk→approval→order pipeline unblocked
---

# Signal pipeline — durable rules

**Debugging order when "no AI bets":** check the `suppressed_reason` mix in `signals` FIRST. Thousands of signal rows/day is normal (every bracket×side×tick is logged); only `suppressed_reason IS NULL` rows are live candidates. A 100%-suppressed mix means a systemic gate, not "no edge today". Then follow the pipeline stage by stage: signals → risk_decisions → approvals → llm_decisions → orders; each stage can silently block the next, and a fixed blocker often reveals another one downstream.

1. **Two freshness clocks, two bounds.** METAR observations are ~hourly → obs age is bounded by `max_obs_age_min` (75). Books/snapshots refresh every ~4 min → bounded by `max_age_min` (10). Applying the tight bound to obs age blocks trading ~50 min of every hour.
   **How to apply:** any freshness check must name which clock it reads. Approve-time revalidation (api-server) must mirror the trader's signal-time bounds exactly, or approvals fail checks the signal already passed.

2. **Book-coherence bound is 105¢, not 100¢.** Live YES-bid sums legitimately print 101–103¢ because fees make small overrounds non-arbitrageable. A 100¢ bound darkens whole stations for hours.

3. **Ticker↔snapshot joins need the date, not just station+bracket.** Ticker dates parse via `TO_DATE(split_part(ticker,'-',2),'YYMONDD')`; `settlement_date` is TEXT → cast `::date`. Without the date constraint, today's model probs pair with tomorrow's tickers (fanout + wrong-day proposals).

4. **Cooldown must dedupe against actions, not evaluations.** Source the duplicate guard from `approvals` + `orders`, never from the `signals` log — signals logs every live evaluation each tick, so sourcing cooldown there permanently deadlocks proposals (each tick blocks the next; originally each tick even blocked itself). Risk officer additionally requires strictly-earlier timestamps as defense in depth.

5. **Only advertise LLM payload fields that are actually persisted.** The LLM approver denies everything if the payload contains permanently-null "critical" model inputs (e.g. a sigma that only exists inside the api-server model). Feed it what exists: forecast median, running high, hours to peak.

6. **Approve-time cap races.** Approval PATCH risk re-check + order insert are serialized per station via an in-process mutex (single api-server instance). Multi-instance would need `pg_advisory_xact_lock`. The per-station daily exposure cap must be enforced at approve time too, not just in the trader's risk officer.

7. **First post-wake tick reads pre-sleep data** (trader query excludes `gap_flag=TRUE` snapshots); self-heals in one ~4-min collector cycle — don't chase it.
