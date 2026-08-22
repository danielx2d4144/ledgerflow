# Development

## Setup

Node 22 (the version in `engines`, the Docker image and CI) and Docker for the
optional local services.

```bash
cp .env.example .env
docker compose up -d postgres redis   # optional; only the app profile needs building
npm ci
npm run db:migrate
npm run dev                            # tsx watch, API on :3000
npm run worker:dev                     # outbox relay + webhook delivery
```

`docker compose --profile app up --build` runs the built image (API + worker)
against the same services, which is the closest local equivalent of production.

Swagger UI is served at `/docs`; the generated document is `openapi.json` at the
repo root and is regenerated with `npm run openapi`.

## Layout

```
src/
  server.ts            process entrypoint: listen, signal handling
  worker.ts            outbox poller + BullMQ delivery worker
  app.ts               Fastify factory (plugins, routes) — what tests build
  config/env.ts        Zod-validated environment, fails fast at boot
  infra/               pg pool, drizzle schema, migrator, redis, logger
  modules/
    auth/              API keys, roles, auth plugin, Redis principal cache
    ledger/            accounts, transactions, idempotency
    audit/             append-only audit writer
    outbox/            outbox writer + dispatcher (claim, fan out, enqueue)
    webhooks/          endpoints, signing, SSRF guard, delivery execution
    health/            liveness and readiness
  shared/              money helpers, error types, error handler
tests/                 vitest suite (see below)
scripts/               openapi generation, migration verification
drizzle/               SQL migrations + journal
load/                  k6 profile (docs/LOAD-TESTING.md)
```

Convention: routes validate and delegate; services own business rules and own
their database work through Drizzle; `shared/` is pure. Every route declares
`config.policy`, and `tests/auth.test.ts` fails if one is missing — a new
endpoint cannot ship unauthenticated by accident.

## Tests

```bash
npm test                       # whole suite
npm test -- tests/ledger.test.ts
npm run test:coverage          # with thresholds
```

| File(s)                                        | What it covers                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `money.test.ts`, `env.test.ts`, `redaction.test.ts` | Pure units: minor-unit parsing, env validation rules, log redaction         |
| `ledger.test.ts`                               | Accounts, balanced/unbalanced posting, idempotency replay and reuse, pagination |
| `ledger-properties.test.ts`                    | fast-check properties: trial balance stays zero, balances are derivable, unbalanced input never lands |
| `auth.test.ts`                                 | Key issuance/verification, role hierarchy, cross-organization isolation, cache and revocation, route-policy coverage |
| `bootstrap.test.ts`                            | Bootstrap route only exists when enabled; production refuses unsafe config     |
| `audit-append-only.test.ts`, `audit-outbox.test.ts` | Audit trigger rejects UPDATE/DELETE; outbox row commits with the money, and not without it |
| `webhooks-api.test.ts`, `webhook-delivery.test.ts` | Endpoint CRUD and secret rotation; signing, retries, timeouts, dead-lettering, SSRF refusals |
| `openapi-contract.test.ts`                     | Committed `openapi.json` matches generated output; every route is authenticated and documents errors |
| `redis-integration.test.ts`                    | Real ioredis + BullMQ wiring; **skipped** unless a Redis is reachable           |

**Databases in tests.** `tests/global-setup.ts` starts PGlite behind the
Postgres wire protocol, so the suite exercises the real `pg` driver, the real
SQL and the real triggers with no Docker requirement. Set `TEST_DATABASE_URL` to
run the identical suite against a real Postgres — CI does exactly that, with a
`postgres:17` service container. PGlite accepts one connection at a time, hence
`fileParallelism: false` and `DATABASE_POOL_MAX=1` in the test helpers.

**Redis in tests.** Most tests use an in-memory fake (`FakeRedis`,
`FakeDeliveryQueue`), which is enough for logic. `redis-integration.test.ts`
covers the wiring against a real server and prints a warning when it skips, so a
green run never silently means "not tested". Point it elsewhere with
`TEST_REDIS_URL`.

**Property tests** default to 25 runs per property to keep the suite fast; raise
with `PROPERTY_RUNS=200 npm test` when touching posting logic.

## Coverage

Thresholds in `vitest.config.ts` are a ratchet set just under the measured
baseline, not an aspiration. Measured on this tree (v8 provider, entrypoints and
thin adapters excluded — see the `exclude` list for exactly which):

| Metric     | Threshold |
| ---------- | --------- |
| Statements | 88%       |
| Branches   | 78%       |
| Functions  | 92%       |
| Lines      | 90%       |

Excluded files (`server.ts`, `worker.ts`, `infra/migrate.ts`, `infra/redis.ts`,
`infra/schema.ts`, the BullMQ adapters) are process wiring exercised by running
the app, not by the suite. Counting them would only produce a number that has to
be explained away.

If a change raises real coverage, raise the thresholds with it.

## Migrations

```bash
npm run db:generate     # drizzle-kit, after editing src/infra/schema.ts
npm run db:migrate      # apply to DATABASE_URL
npm run db:verify       # what CI runs
```

`npm run db:verify` checks journal/file parity, scans for destructive statements
(`DROP TABLE|COLUMN|CONSTRAINT|TYPE|INDEX`, `TRUNCATE`, `ALTER COLUMN … TYPE`)
that are not explicitly marked `-- allow-destructive`, applies every migration to
an empty database, applies them again to prove a retried deploy is safe, and then
asserts the expected tables, the deferred balance trigger and the append-only
audit guard all exist — finishing by trying to commit an unbalanced transaction
and requiring the database to refuse it.

Hand-written SQL (triggers, constraints, indexes) lives directly in the numbered
migration files; Drizzle only generates the table DDL.

## Security checks

```bash
npm run audit:prod        # runtime dependencies must be clean; CI blocks on this
npm audit                 # includes dev dependencies; advisory only
```

Dev-only advisories are reported but non-blocking in CI: they cannot reach a
deployed artifact, and forcing a fix can mean downgrading tooling for no real
gain. At the time of writing, `drizzle-kit` pulls an old `esbuild` with a
moderate dev-server advisory (GHSA-67mh-4wv8-2f99); it is dev-only and not
present in the runtime image.

Secrets never enter the repo: `.env` is ignored, `.env.example` holds only
placeholders, and the app refuses to boot in production with the built-in
default `API_KEY_PEPPER` or `WEBHOOK_SECRET_KEY`.
