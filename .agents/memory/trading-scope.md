---
name: Trading scope
description: User-defined temperature trading universe and fixed risk constraints.
---

Keep the highs allowlist at KLAX, KNYC, KAUS, KMDW and contracts_per_trade at 10. The requested LLM daily cap, daily loss cap, dashboard daily cap, and total open exposure cap must not exceed 9000 cents ($90). Philly and rain trading must be disabled; historical rain settlement bookkeeping may remain. Preserve database rows.

**Why:** The user explicitly required this scope and lowered only the named caps above 9000 cents to exactly 9000, superseding the prior $500 daily cap.

**How to apply:** Preserve these values during trading fixes. Distinguish workspace protections from verified production enforcement; do not claim rain is stopped based only on development code.