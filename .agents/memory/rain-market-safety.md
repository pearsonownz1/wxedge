---
name: Rain market safety patterns
description: Durable decisions behind bringing KXRAIN- contracts to safe live trading — settlement dating, eligibility gating, sizing, and digest correctness.
---

## Settlement date must be derived from the ticker, not placement timestamp
Rain contracts can be placed near UTC midnight while settling on a different local calendar date than the placement timestamp suggests. Any join or in-memory match between an order and its settlement must key on the order's own ticker-derived date, not its placement date.

**Why:** using placement date to look up settlement silently misattributes or drops rain fills, and — if a settlement lookup incorrectly reports "not found" as "resolved with no payout" — can permanently record an unresolved contract as a loss in a digest that never gets recomputed.

**How to apply:** derive the true date from the ticker (`YYMONDD` segment) at read time — in SQL for reporting queries, or via a shared in-process helper for daily digest matching — rather than adding a schema column, avoiding migration conflicts with other concurrently-merging work on the same tables. When aggregating multiple orders for one station in a single pass (e.g. a daily digest), key any settlement lookup map by `station+its own settlement date`, not station alone — a station can have both a today-contract and a tomorrow-contract filled on the same placement date, and a station-only key lets one clobber the other.

## A digest/reconciliation job must treat "not yet settled" as pending, not as a loss
Any job that computes P&L for a set of filled orders against a settlements table must distinguish "no settlement row found yet" (exclude from totals, revisit later) from "settlement row found with a null/no-match result" (a real zero-payout outcome). Conflating the two treats a same-day fill for a contract that resolves days later as a permanent loss.

**Why:** contracts don't all resolve on a fixed, predictable schedule relative to when the reconciliation job runs once per day — rain in particular can resolve well after the digest's usual run time.

**How to apply:** make the recompute idempotent (a full overwrite of the day's row, not an incremental add) so a lookback window of recent dates can be safely recomputed on a schedule until every order in that window is finally settled.

## Rain eligibility gate is fail-closed and duplicated by design
The rain contract eligibility check (ticker/series format, known city, active status, city-local contract date within range, settlement-terms evidence) is intentionally duplicated between the trader and the api-server rather than shared, matching this codebase's existing convention of duplicating small lookup/parsing logic across those two services so they can evolve independently. Every rejection still produces an explicit logged signal with a specific reason — matching the existing "always log, never silently drop" convention — while the public markets feed silently excludes ineligible contracts (consistent with its pre-existing active-only filtering).

Settlement-terms evidence must be a positive match, not merely the absence of a red flag: missing title/subtitle/rules text is treated the same as text that fails to confirm precipitation — both are rejected, never silently passed through.

**Why:** fail-closed protects real capital when contract metadata is ambiguous, absent, or a series is misidentified — treating "we don't know" as "this is fine" is exactly the failure mode this gate exists to prevent.

## Liquidity-bound sizing fails closed on unknown depth
Rain order sizing is capped by the live book's actual available size on the correct side (yes-ask for a YES buy, yes-bid for a NO buy). When that depth is unknown — no current book at all, or a book that doesn't report a size for the relevant side — the order is blocked entirely, never sized uncapped.

**Why:** sizing against an unknown depth is equivalent to no cap at all, defeating the purpose of a liquidity-bound safeguard; this must hold in every code path that sizes a rain order (trader signal generation and the approval-mode revalidation path both apply it independently).
