---
name: Generated validator compatibility
description: Orval URI formats and copied authentication templates require care in this workspace.
---

Do not assume that authentication template schemas and the project's generated validation library use compatible Zod APIs. Explicit URL validation at the server boundary is necessary when format annotations are omitted.

**Why:** Orval emitted zod.url() for URI formats, but the project's existing Zod 3 dependency did not provide it. Upgrading a whole validation stack solely to install authentication would be a broader change than needed.

**How to apply:** When adding format annotations or upgrading code generation, verify the generated library before changing callers. Align the versions or retain explicit boundary validation; never “fix” this by editing generated code.
