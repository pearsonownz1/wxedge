---
name: Expert field defaults
description: Dentistry/Economics classification must preserve legacy records without a backfill.
---
Missing expert_field means Dentistry, including when filtering the pipeline and calculating summary counts. Existing records must not be migrated or backfilled just to implement this default.

**Why:** The user wants to separate dentists from economists while leaving existing records and the production database untouched.

**How to apply:** Apply the Dentistry fallback on reads and in views, not through batch updates. New experts added through the Economists toggle default to Economics. CSV values are case-insensitive; explicit blanks mean Dentistry. An omitted CSV field must preserve an existing record's field when upserting.
