# Notara — Investor Pipeline

Publicly viewable investor-pipeline interface for Notara, an AI-native notarization and eSign infrastructure startup. Fundraising records and activity history were cleared before making viewing public. The former Kalshi weather app is retired in this codebase.

## Product rules

- Viewing the dashboard requires no login. Record changes remain owner-only; public viewing must not grant anonymous write access.
- There are no investor-email sending or third-party email/CRM integrations. Do not reintroduce them unless requested.
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

Viewing does not require authentication. Replit Auth sessions remain only for owner-authorized changes. `CRM_OWNER_ID` binds write access to the owner; missing owner configuration denies changes. Mutating browser requests must be same-origin.

The dashboard routes live under `/api/crm`. Reads are public; writes require an owner session. The former external CRM bearer-token integration has been removed:
- `GET /api/investors?status=...`
- `POST /api/investors` — create or upsert on email or LinkedIn URL
- `PATCH /api/investors/:id`
- `POST /api/investors/:id/activity`
- `GET /api/summary`

No Gmail, Hunter, ActiveCampaign, or other email/CRM keys or connections were configured when checked. Kalshi and unrelated credentials are preserved. Never expose or log credentials, authorization headers, investor payloads, or OIDC callback query strings.

## Data and contracts

- `lib/api-spec/openapi.yaml` is the API contract; regenerate client hooks and server validators with Orval.
- `lib/db/src/schema/crm.ts` holds CRM tables, and `auth.ts` holds authentication tables. Keep legacy schema exports so schema updates cannot drop historical tables.
- `artifacts/api-server/src/lib/crmData.ts` handles validation, transactional upserts and summary metrics.
- `artifacts/api-server/src/lib/crmCsv.ts` handles CSV import/export. Import is atomic; conflicts between email and LinkedIn identities require review instead of silently merging distinct investors.
- `artifacts/notara/src` holds the dashboard and investor editor.
- Dates use `YYYY-MM-DD`. “This week” starts Monday; daily summary dates use Pacific time. Response rate is a fraction from 0 to 1.

Status order: New, Enriched, Pitch Drafted, Approved to Send, Contacted, Followed Up, Responded, Meeting Set, Passed, Committed.

CSV accepts snake_case or equivalent human-readable headers, with pitch subject and body as separate columns. Export includes activity history as JSON in `activity_log`; spreadsheet formula values are escaped.
