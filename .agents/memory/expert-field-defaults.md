---
name: Expert field defaults
description: Expert categories must preserve legacy records without a backfill.
---
Missing expert_field means Dentistry, including when filtering the pipeline and calculating summary counts. Existing records must not be migrated or backfilled just to implement this default.

**Why:** The user wants separate Dentists, Economists, Law Firms, and Chinese Law categories without changing or deleting existing records, stages, or categories. Chinese Law uses the same stages as Law Firms.

**How to apply:** Apply the Dentistry fallback on reads and in views, not through batch updates. New experts default to the selected category, except All defaults to Dentistry. Law Firms starts empty: do not reclassify or seed existing records into it. CSV values are case-insensitive; explicit blanks mean Dentistry. An omitted CSV field must preserve an existing record's field when upserting.
