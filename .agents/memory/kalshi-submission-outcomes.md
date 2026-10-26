---
name: Kalshi submission outcomes
description: Distinguishing explicit exchange rejection from an unknown submit outcome and safely recovering stranded intents.
---

An explicit HTTP 400 insufficient_balance response means no order was accepted; it must not leave a permanent portfolio-wide unresolved-submission block. Transport errors, timeouts, malformed success responses, database-recording failures, and unrecognized exchange errors remain ambiguous and must fail closed.

**Why:** An insufficient-balance rejection was previously treated like a lost response, stranding its local intent and blocking every subsequent approval.

**How to apply:** Keep rejection classification narrow. For a newly received rejection, release the local intent atomically while retaining its exchange response and correcting its approval audit note. Use the existing cancelled local state to release risk reservations; do not send an exchange cancellation for an order never accepted. Recovery of old intents requires verified rejection evidence and exact identity matching, never age-based clearing or blind resubmission. Preserve rows during reconciliation; historical recovery changes only the order status, leaving its other fields and related approval unchanged.

Recovery must not depend on a new trading opportunity. Never manufacture or approve a trade solely to trigger reconciliation.

**Why:** A quiet market can otherwise leave a confirmed rejected intent blocking the portfolio indefinitely.

**How to apply:** Run evidence-matched recovery independently of proposals, preserving the full production timestamp precision and leaving all unmatched intents blocked.