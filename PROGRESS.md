# LedgerFlow Progress

## Phase 0 - Repository init

- Local source is present and `.gitignore` excludes `.env`, `node_modules`, `dist`, and `coverage`.
- Not complete: this directory is not initialized as Git, and the configured identity is not Daniel's identity.

## Phase 1 - CI

- CI workflow exists with static, real-service test, migration, contract, audit, and Docker jobs.
- Not verified: no GitHub run has been executed from this workspace.

## Phase 2 - Deployment

- Render blueprint, pre-deploy migration, health checks, and shared API/worker secrets are configured.
- Not complete: no Render deployment or live signed webhook has been verified.

## Phase 3 - Close security gaps

Completed locally:

- Canonical recursive request serialization for idempotency hashes.
- Strict stored API-key digest validation.
- Cache revocation respects the enabled guard.
- Event replay returns existing dead-letter deliveries to pending and enqueues them with an extended attempt budget.
- Webhook response snippets, event names, migration coverage, and the migration 0004 backfill are documented.
- Append-only test handling tolerates the PGlite `ECONNRESET` connection-reset artifact.

Still open:

- Per-tenant outbox fairness and its ADR/test.
- DNS-rebinding protection with a pinned-IP connector and regression test.
- Auth `last_used_at` debounce.
- Per-organization transaction amount policy cap.
- Missing Drizzle snapshots for migrations 0001 and 0004.

Verified locally on 2026-08-21:

- `npm run check`: 134 passed, 6 skipped; coverage 90.71% statements, 80.80% branches, 94.58% functions, 94.19% lines.
- `npm run db:verify`: all migration checks passed.
- `npm run audit:prod`: 0 vulnerabilities.

## Phase 4 - Measure performance

- Not started. No load-test numbers are published.

## Phase 5 - Balance cache

- Not started.

## Phase 6 - Portfolio finish

- Not started.
