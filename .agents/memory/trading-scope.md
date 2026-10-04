---
name: Trading scope
description: User-defined temperature trading universe and fixed risk constraints.
---

Keep the highs allowlist at KLAX, KNYC, KAUS, KMDW, contracts_per_trade at 10, and the daily cap at $500. Philly and rain trading must be disabled; historical rain settlement bookkeeping may remain.

**Why:** The user explicitly required this scope and subsequently raised the daily cap to $500.

**How to apply:** Preserve these values during trading fixes. Distinguish workspace protections from verified production enforcement; do not claim rain is stopped based only on development code.