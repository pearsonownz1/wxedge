# Notara — Investor Pipeline

Private seed-round fundraising CRM for Notara, an AI-native notarization and eSign infrastructure startup. The former Kalshi weather app is retired in this codebase.

## Product rules

- Only the project owner may use the signed-in dashboard. Enforce identity on the server, not just in the UI.
- The CRM never sends email. The founder approves pitches and sends them outside the app from Gmail.
- Keep all historical weather/trading tables and data. Do not expose them through routes or UI, or restore trading/schedulers/order submission.
- Preserve custom-domain configuration. Publishing is a separate, explicitly approved action.
- Real investor data only: do not seed fabricated leads.

## Recovery

The Git tag `notara-pre-retirement` preserves the old published weather application source. Restoring it must be an explicit user decision. The retained historical tables are not part of the CRM.

## Development

Managed workflows:
- `artifacts/api-server: API Server` — Express API at `/api`.
- `artifacts/notara: web` — investor dashboard at `/notara/`.
- `artifacts/wx-edge: web` — existing root entry, now redirects to `/notara/`.

No trader workflow or trading background worker is registered. The former trader entry point fails immediately.

Useful checks:
- `pnpm run typecheck:libs`
- `pnpm --filter @workspace/api-server run typecheck`
- `pnpm --filter @workspace/notara run typecheck`
- `pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/lib/crm.test.ts`
- `pnpm --filter @workspace/notara run build`
- `pnpm --filter @workspace/api-spec run codegen`

## Authentication and API

Browser authentication uses Replit Auth (OIDC + PKCE), with PostgreSQL sessions and secure HTTP-only cookies. `CRM_OWNER_ID` binds access to the project owner. Missing owner configuration denies access. Mutating browser requests must be same-origin.

The session-authenticated browser routes live under `/api/crm`. The separate assistant routes require an exact bearer token matching `process.env.CRM_API_TOKEN`:
- `GET /api/investors?status=...`
- `POST /api/investors` — create or upsert on email or LinkedIn URL
- `PATCH /api/investors/:id`
- `POST /api/investors/:id/activity`
- `GET /api/summary`

The user will add `CRM_API_TOKEN` through Secrets. Missing token configuration rejects all assistant requests, even when the caller has an owner browser session. Never expose or log credentials, authorization headers, investor payloads, or OIDC callback query strings.

## Data and contracts

- `lib/api-spec/openapi.yaml` is the API contract; regenerate client hooks and server validators with Orval.
- `lib/db/src/schema/crm.ts` holds CRM tables, and `auth.ts` holds authentication tables. Keep legacy schema exports so schema updates cannot drop historical tables.
- `artifacts/api-server/src/lib/crmData.ts` handles validation, transactional upserts and summary metrics.
- `artifacts/api-server/src/lib/crmCsv.ts` handles CSV import/export. Import is atomic; conflicts between email and LinkedIn identities require review instead of silently merging distinct investors.
- `artifacts/notara/src` holds the dashboard and investor editor.
- Dates use `YYYY-MM-DD`. “This week” starts Monday; daily summary dates use Pacific time. Response rate is a fraction from 0 to 1.

Status order: New, Enriched, Pitch Drafted, Approved to Send, Contacted, Followed Up, Responded, Meeting Set, Passed, Committed.

CSV accepts snake_case or equivalent human-readable headers, with pitch subject and body as separate columns. Export includes activity history as JSON in `activity_log`; spreadsheet formula values are escaped.
