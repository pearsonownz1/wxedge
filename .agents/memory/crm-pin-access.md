---
name: CRM PIN access
description: The whole CRM is private behind a persistent PIN browser session.
---
The whole expert CRM requires a PIN for reads and all writes, including import, add, edit, stage moves, and activity notes. The PIN belongs only in the server-side CRM_PIN secret, never in frontend code.

**Why:** The user reversed the public-write plan and requested a simple persistent browser PIN login instead. This replaces both anonymous access and owner-only Replit login for CRM operations.

**How to apply:** Protect browser and legacy CRM API aliases alike. Keep header-name CSV mapping, including expert_field, and do not modify existing records as part of access-policy changes. Preserve unrelated authentication and services.
