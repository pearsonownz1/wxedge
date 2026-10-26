---
name: Generated API declarations
description: TypeScript project-reference behavior for the generated API schema package
---

When `@workspace/api-zod` reports that a generated schema export is missing even though the source file exports it, rebuild the package's composite TypeScript declarations before changing imports or weakening the typecheck.

**Why:** The package keeps generated declaration output and project-reference metadata; stale output can make the consuming API server see an incomplete module surface while the source is correct.

**How to apply:** Run the package's TypeScript build directly, then rerun the consuming package typecheck. Keep the source package boundary unchanged.