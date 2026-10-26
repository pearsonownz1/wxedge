---
name: Retirement and custom domains
description: Conflict between stopping a published app and preserving its custom-domain connection.
---

Do not claim that stopping development workflows or removing their code stops an already-published application. Do not unpublish silently when the user also requires the custom-domain setup to remain untouched.

**Why:** Replit's documentation consulted on 2026-10-07 says unpublishing stops the published app but removes its custom-domain connection; republishing requires relinking the domain. Published builds also retain their own environment snapshot.

**How to apply:** Check current Replit documentation before retiring a live deployment. Explain the domain consequence and obtain a decision when the constraints conflict. Notara's product and privacy rules are in replit.md; old weather memory entries are historical, not permission to restore trading.
