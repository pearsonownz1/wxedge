---
name: Artifact build environment
description: Build-time versus runtime environment variables for artifact publishing
---

Static artifact build commands cannot depend on runtime-only service environment variables such as `PORT` or `BASE_PATH`.

**Why:** The web publish build runs before the service environment is injected. Requiring runtime variables in the Vite configuration made the build fail before compilation.

**How to apply:** Give Vite safe defaults for build-only configuration, while still allowing the deployed service environment to override values at runtime.