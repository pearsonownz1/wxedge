---
name: Browser testing runtime isolation
description: Browser automation may use a different secret environment or browser context from the application.
---
Do not assume the isolated browser tester can access CRM_PIN just because the application and production Secrets have it.

**Why:** The browser tester's runtime reported the PIN absent while the application runtime had it configured. Treating those environments as identical would incorrectly diagnose a missing application secret.

**How to apply:** Confirm only secret existence through the supported secrets flow. For credential-based verification, use the application's runtime without printing credentials, cookies, or tokens; do not weaken login protection or rewrite secrets to accommodate a tester.

Local Chromium may expose an extension background context before the actual application page.

**Why:** Automation attached to that context produced misleading navigation and request failures unrelated to the CRM.

**How to apply:** Identify the actual page target by type and URL before interpreting browser failures; do not assume the first debugging target is the app.
