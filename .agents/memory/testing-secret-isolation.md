---
name: Browser testing secret isolation
description: Browser-test automation may not share the application's custom secret environment.
---
Do not assume the isolated browser tester can access CRM_PIN just because the application and production Secrets have it.

**Why:** The browser tester's runtime reported the PIN absent while the application runtime had it configured. Treating those environments as identical would incorrectly diagnose a missing application secret.

**How to apply:** Confirm only secret existence through the supported secrets flow. For credential-based verification, use the application's runtime without printing credentials, cookies, or tokens; do not weaken login protection or rewrite secrets to accommodate a tester.
