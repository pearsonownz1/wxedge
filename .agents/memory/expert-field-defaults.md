---
name: Expert field defaults
description: Expert categories must preserve legacy records without a backfill.
---
Missing expert_field means Dentistry, including when filtering the pipeline and calculating summary counts. Existing records must not be migrated or backfilled just to implement this default.

**Why:** The user wants separate Dentists, Economists, Law Firms, Chinese Law, and Indian Law categories without changing or deleting existing records, stages, or categories. Chinese Law and Indian Law use the same stages as Law Firms.

**How to apply:** Apply the Dentistry fallback on reads and in views, not through batch updates. New experts default to the selected category, except All defaults to Dentistry. Adding categories must not reclassify or seed existing records. CSV values are case-insensitive; explicit blanks mean Dentistry. An omitted CSV field must preserve an existing record's field when upserting.

The Law Firms tab displays **Brazil**, but its underlying expert_field value remains **Law Firms**. The separate empty Brazilian Law category was removed at the user's request.

**Why:** The user requested a tab-label-only rename while preserving all existing records and stored category values.

**How to apply:** Keep Law Firms in forms, CSV and API contracts; Brazil is only the tab label, not a new stored value. Do not migrate or rename record data to Brazil.
