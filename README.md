# LedgerFlow

A double-entry ledger API. Accounts, immutable balanced transactions, idempotent
writes, an append-only audit log, and HMAC-signed webhooks delivered from a
transactional outbox.

Written to be read: the interesting parts are the database-level balance
invariant, the outbox that makes "the money moved" and "the event was published"
the same commit, and the API-key auth with instant revocation. Decisions and
their rejected alternatives are in [`docs/adr/`](docs/adr/).

Two processes from one image: `dist/server.js` (HTTP API) and `dist/worker.js`
(outbox relay + webhook delivery). State lives in Postgres and Redis.

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres redis
npm ci
npm run db:migrate
npm run dev            # API on :3000, docs at /docs
npm run worker:dev     # in a second shell, for webhook delivery
```

Mint the first organization and admin key (development only — the route refuses
to load when `NODE_ENV=production`):

```bash
BOOTSTRAP_ENABLED=true BOOTSTRAP_TOKEN=a-long-local-token npm run dev

curl -sX POST localhost:3000/v1/bootstrap \
  -H 'x-bootstrap-token: a-long-local-token' -H 'content-type: application/json' \
  -d '{"organizationName":"Acme","organizationSlug":"acme"}'
```

Then move some money:

```bash
KEY=lf_test_…            # from the bootstrap response, shown once

curl -sX POST localhost:3000/v1/accounts -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Cash","reference":"cash","type":"asset","currency":"USD"}'

curl -sX POST localhost:3000/v1/transactions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"description":"top-up","currency":"USD","entries":[
        {"accountId":"<cash-id>","amount":"5000"},
        {"accountId":"<revenue-id>","amount":"-5000"}]}'
```

Entries are signed minor units and must sum to zero. Repeating the request with
the same `Idempotency-Key` replays the original response instead of moving money
twice.

## What is implemented

| Area           | Status                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ledger         | Organizations, accounts (`asset`/`liability`/`equity`/`revenue`/`expense`), immutable transactions and entries, cursor-paginated listing.                                |
| Invariant      | A deferred constraint trigger rejects any transaction whose entries do not sum to zero or that has fewer than two entries — at `COMMIT`, in the database.                |
| Balances       | Derived by aggregating `entries`. There is no balance cache; see [Limits](#deliberate-limits).                                                                           |
| Idempotency    | `Idempotency-Key` on transaction creation, fingerprinted by request hash, stored response replayed, mismatched reuse rejected with `409`.                                |
| Auth           | API keys (`lf_<env>_<prefix>.<secret>`), peppered HMAC-SHA256 at rest, hierarchical `admin` > `writer` > `reader`, Redis-cached verification with revocation tombstones. |
| Audit          | `audit_events`, append-only via trigger, records actor, action, resource, request id and IP.                                                                             |
| Events         | Transactional outbox → `webhook_deliveries` → BullMQ → signed HTTP POST, with backoff, dead-lettering and replay endpoints.                                              |
| Webhook safety | AES-256-GCM secrets at rest, `v1=` HMAC signature with timestamp, SSRF guard re-checked before every attempt, redirects not followed.                                    |
| Ops            | `/health/live` and `/health/ready`, structured pino logs with redaction, graceful shutdown, OpenAPI 3.1 generated from the runtime Zod schemas.                          |

Not implemented (and not pretended to be): holds/pending balances, multi-ledger
books, FX, reversal endpoints, scoped permissions beyond the three roles,
`as_of` historical balance reads, endpoint auto-disabling. `docs/PRODUCT.md`
marks these as out of scope or future work.

## Documentation

| Document                                         | What it covers                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| [docs/PRODUCT.md](docs/PRODUCT.md)               | Problem, scope, what is deliberately excluded                           |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | System shape, data model, request lifecycle, failure modes              |
| [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) | Key format, roles, tenancy rules                                        |
| [docs/WEBHOOKS.md](docs/WEBHOOKS.md)             | Event flow, signature verification, retry and replay semantics          |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)       | Local setup, the test strategy, coverage policy, how to run every check |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)         | Render blueprint, secrets, migration and rollback discipline            |
| [docs/LOAD-TESTING.md](docs/LOAD-TESTING.md)     | Reproducible load-test method (no numbers are published here)           |
| [docs/adr/](docs/adr/)                           | Decision records, including the ones that were later corrected          |
| [CONTRIBUTING.md](CONTRIBUTING.md)               | Workflow, commit and PR expectations                                    |

## Checks

```bash
npm run lint          # eslint (typed rules)
npm run typecheck     # tsc --noEmit, strict
npm test              # vitest, against a real Postgres wire protocol
                      #   (real-Redis tests skip when no Redis is reachable)
npm run test:coverage # the above, with coverage thresholds enforced
npm run db:verify     # migrations apply, re-apply cleanly, and produce the expected schema
npm run audit:prod    # runtime dependency audit
npm run check         # all of the above, in order
```

## Troubleshooting

If the API does not start locally:

1. Confirm PostgreSQL and Redis are running.
2. Confirm `.env` exists and matches `.env.example`.
3. Run `npm run db:migrate`.
4. Run `npm run check` to verify the installation.

## Contributor validation checklist

Before opening a pull request, verify the branch is ready:

1. Run `npm run lint`.
2. Run `npm run typecheck`.
3. Run `npm run format:check`.
4. Run `npm test` for the targeted behavior or `npm run test:coverage` for the full suite.
5. Run `npm run db:verify` when schema or migration files changed.
6. Run `npm run audit:prod` when dependency changes are part of the PR.
7. Confirm the diff is small, focused, and documented.

Tests boot an in-process Postgres (PGlite over the real wire protocol) so a
plain `npm test` needs no Docker; setting `TEST_DATABASE_URL` points the same
suite at a real server, which is what CI does. Redis-specific tests skip
themselves unless a Redis is reachable.

## Deliberate limits

- **Balances are computed, not cached.** Every balance read aggregates that
  account's entries. Correct and auditable at any size, but read cost grows with
  history; a materialized cache with reconciliation is the documented next step
  ([ADR-0004](docs/adr/0004-balance-cache-with-reconciliation.md)).
- **Single Postgres primary.** No partitioning, no sharding.
- **One currency per account and per transaction,** enforced; no FX.
- **Webhook ordering is not guaranteed.** Receivers must deduplicate on
  `X-LedgerFlow-Event-Id` and may reorder using the event's `createdAt`.
- **Delivery is at-least-once.** Exactly-once is not offered across HTTP.

License: MIT.
