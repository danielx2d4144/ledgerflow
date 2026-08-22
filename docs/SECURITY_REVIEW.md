# LedgerFlow — independent backend/security review

Reviewer: senior backend/security engineer (independent pass, no GitHub interaction).
Scope: ledger correctness, transaction isolation, idempotency, tenant isolation, API-key
handling, webhook SSRF/signing, migrations, worker reliability, money precision, error
leakage, deployment defaults.

Method: full source read of `src/**`, `drizzle/**`, `Dockerfile`, `docker-compose.yml`,
`render.yaml`; the existing suite was run green as a baseline (114 tests), then targeted
probe tests were written against a live PGlite instance to confirm or refute each
hypothesis. Confirmed issues are marked **verified**; everything else is reasoned from
code and marked as such.

Four issues (C1, H1, H2, H3) were fixed in this pass because the fixes are small and
isolated; regressions live in `tests/review-findings.test.ts`. Everything else is
documented, not changed.

---

## Critical

### C1 — Amount strings up to 19 digits overflow the `int8` column and return a 500 *(verified, fixed)*

`ledger.schemas.ts` accepted `/^-?\d{1,19}$/`, but `entries.amount` is a Postgres `bigint`
(max `9223372036854775807`). `parseMinorUnits` happily produced the oversized `BigInt`,
the balance check passed (`+x` and `-x` still sum to zero), and the failure only surfaced
in the driver, after the transaction had already inserted `transactions` and audit rows.

Probe (before fix):

```
POST /v1/transactions entries [{amount:"9999999999999999999"},{amount:"-9999999999999999999"}]
-> 500 {"error":{"code":"internal_error", ...}}
```

Worse than the 500: on the pooled connection this aborts the surrounding transaction and,
in the test harness (`DATABASE_POOL_MAX=1`), poisoned every subsequent request in the
process — an unauthenticated-adjacent (writer-role) availability hazard on a hot pool.

Fix applied: range check in `src/shared/money.ts` (`MIN_MINOR_UNITS`/`MAX_MINOR_UNITS`)
plus a `.refine()` on `amountString` in `src/modules/ledger/ledger.schemas.ts`, so the
request is rejected with a 400 and a field-level message before any write.

Residual: aggregate balance (`sum(entries.amount)`) can still overflow int8 for an account
with enough large entries. Recommend `sum(amount)::numeric` in
`LedgerService.getAccountWithBalance` and a per-org amount policy cap well below 2^63.

---

## High

### H1 — Cached principals ignored key expiry *(verified, fixed)*

`AuthCache` stored `{apiKeyId, organizationId, role, prefix}` only. `expiresAt` was checked
in `AuthService.verify` on the database path but never re-checked on a cache hit, so a key
that expired inside the TTL window kept authenticating for up to `AUTH_CACHE_TTL_SECONDS`
(default 60, max 300). Revocation had a tombstone; expiry had nothing.

Probe (before fix): key issued with `expiresAt = now + 1s`, warmed the cache, slept 1.2s →
`GET /v1/me` still returned `200`. After the fix the same probe returns `401`.

Fix applied: `CachedPrincipal.expiresAt` is persisted with the entry and re-checked (and
the entry deleted) on read in `src/modules/auth/auth.cache.ts`; `auth.service.ts` now
builds `Principal` explicitly instead of spreading the cached record.

### H2 — SSRF guard missed hex-form IPv4-mapped and NAT64 IPv6 addresses *(verified, fixed)*

`isPrivateIPv6` only recognised `::`, `::1`, `fe80*`, `fc*`, `fd*` and the *dotted* mapped
form `::ffff:127.0.0.1`. It returned `false` for:

- `::ffff:7f00:1` — the hex spelling of `::ffff:127.0.0.1` (loopback)
- `::ffff:a9fe:a9fe` — cloud metadata `169.254.169.254`
- `64:ff9b::7f00:1` — NAT64 embedding of loopback

`assertSafeResolution` feeds it raw resolver output, so a hostname resolving to any of
those forms passed the guard and the worker would POST the signed event there.

Fix applied: `src/modules/webhooks/url-guard.ts` now fully expands the address
(`expandIPv6`), matches `fe80::/10` and `fc00::/7` correctly, and decodes the embedded
IPv4 for both `::ffff:/96` and `64:ff9b::/96` before re-running the IPv4 rules.

Residual (unchanged, and correctly documented in `docs/WEBHOOKS.md`): the DNS check is
check-then-connect, so rebinding is still possible. Closing it needs a pinned-IP
connector (custom `dispatcher`/`lookup` in undici) — recommended before GA.

### H3 — Unbounded `entries[]` per transaction *(verified, fixed)*

`createTransactionBody.entries` had `.min(2)` and no upper bound. A single 1 MB request
(the configured `bodyLimit`) fits roughly 17k entries; a probe with 4,000 entries returned
`201`. Each such request takes `FOR UPDATE` locks on every referenced account, holds one
pool connection for the whole insert, and makes the deferred balance trigger scan the full
entry set at commit. That is a cheap, authenticated write-amplification/lock-contention
lever against other tenants sharing the pool.

Fix applied: `.max(1000)` on `entries` (400 with a field-level message beyond that);
`openapi.json` regenerated so the contract test stays green.

### H4 — Rate limiting is keyed on a spoofable client IP *(verified, not fixed)*

> **Status: fixed in remediation pass 2** — see [§ Remediation pass 2](#remediation-pass-2-h4-h5-m2-m9-and-residuals).

`app.ts` sets `trustProxy: true` unconditionally and registers `@fastify/rate-limit` with
no `keyGenerator`, so the bucket key is `request.ip` = the left-most `X-Forwarded-For`
value. Probe: two requests with `X-Forwarded-For: 203.0.113.9` and `203.0.113.10` each
reported `x-ratelimit-remaining: 9999` — i.e. a fresh quota per spoofed address. Any
client bypasses the limit by rotating a header, and, worse, can *evict/poison* buckets for
real IPs. It is also the wrong dimension for a multi-tenant money API: one tenant's key
should have its own budget.

Recommended fix (small, but touches `app.ts` which was being edited concurrently, so left
to the owner):

```ts
await app.register(rateLimit, {
  max: env.RATE_LIMIT_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
  keyGenerator: (req) => req.principal?.apiKeyId ?? req.ip,
  redis: cacheClientForRateLimit,     // otherwise the limit is per-instance only
});
```

and replace `trustProxy: true` with the concrete proxy CIDR/hop count of the deployment
(`trustProxy: 1` on Render). Note the limiter is currently in-process memory, so with two
web instances the effective limit is 2×`RATE_LIMIT_MAX`, and it resets on every deploy.

### H5 — Webhook delivery has no claim/lease; concurrent workers can double-send and clobber state *(code reasoning)*

> **Status: fixed in remediation pass 2** (atomic claim + lease + conditional writes).

`executeDelivery` reads the delivery row with a plain `SELECT`, checks
`status === 'pending'`, performs the HTTP request, then writes the outcome. There is no
`FOR UPDATE`, no `status='in_flight'` transition, and no optimistic `WHERE attempt = $n`
on the success/retry updates. Two triggers make this reachable, not theoretical:

1. `requeueDueDeliveries` (worker sweep, every 30 s) enqueues *every* pending, due
   delivery, and `bullmq-queue.ts` deliberately makes `jobId` unique per enqueue
   (`${deliveryId}:${delayMs}:${Date.now()%1000}`), so BullMQ does not dedupe.
2. `POST /v1/webhooks/deliveries/:id/replay` enqueues directly while a sweep job for the
   same row may already be in flight.

Result: the same event can be POSTed twice concurrently (receivers are told to dedupe, so
this is tolerable), but the two attempts then race on the same row — `attempt` can go
backwards, a `succeeded` row can be overwritten with `pending`+`nextAttemptAt`, and
`consecutiveFailures` is double-counted, which can auto-disable a healthy endpoint.

Fix: claim inside a transaction —

```sql
update webhook_deliveries
   set status = 'in_flight', attempt = attempt + 1, updated_at = now()
 where id = $1 and status = 'pending'
returning *;
```

plus a lease timeout sweep that returns `in_flight` rows older than N minutes to
`pending`, and make the final writes conditional on `attempt = <claimed attempt>`.

---

## Medium

### M1 — Outbox dispatch has no per-tenant fairness (noisy-neighbour starvation) *(observed)*

> **Status: still open.** Deliberately not changed in pass 2: per-tenant round-robin
> claiming changes dispatch ordering semantics and deserves its own ADR + load test.

`dispatchOutboxBatch` claims `ORDER BY created_at LIMIT batch_size` across *all*
organizations. During this review a probe test that generated a few thousand ledger events
starved an unrelated tenant's webhook test of its dispatch slot entirely
(`createdDeliveries === 0`) until the backlog drained. In production a single tenant
bulk-loading transactions delays every other tenant's webhooks by backlog/throughput.
Recommend claiming round-robin per `organization_id` (e.g. `DISTINCT ON (organization_id)`
in the claim CTE) or a per-tenant token budget per batch.

### M2 — Idempotency keys are never reaped, and `expires_at` is decorative

> **Status: fixed in remediation pass 2** (expiry-filtered lookups + worker reaper).

`idempotency_keys.expires_at` defaults to `now() + 24h` and has an index
(`idempotency_keys_expires_idx`), but nothing deletes expired rows and no read filters on
it (`ledger.service.ts:130-137`). Consequences: the table grows without bound on the write
hot path (every POST /v1/transactions with a key), and the documented 24-hour idempotency
window is not actually enforced — a key replays forever. Add a reaper to the worker loop
(`delete from idempotency_keys where expires_at < now()` in batches) and add
`gt(idempotencyKeys.expiresAt, now)` to the lookup so semantics match ADR-0006.

### M3 — Postgres `read committed` + `FOR UPDATE` does not give the isolation the comment claims

> **Status: addressed in remediation pass 2** (comment corrected to what is actually
> guaranteed; a real-Postgres concurrency suite added, gated on `TEST_DATABASE_URL`).

`ledger.service.ts:103-109` says "all writes happen in a single serializable-safe
transaction". `db.transaction()` uses the pool default (`read committed`); the row locks on
`accounts` serialise writers that touch the *same accounts*, which is enough for the
current invariants (the balance trigger is per-transaction, not per-account), but the
comment will license a future balance-constraint feature ("account may not go negative")
that this isolation level cannot support — the classic write-skew case. Either set
`isolation level repeatable read`/`serializable` with a retry wrapper, or correct the
comment to state exactly what is guaranteed today.

Note on verification: the test harness is PGlite, which serialises connections
(`DATABASE_POOL_MAX=1`), so **no concurrency property in this repo is actually tested**.
Idempotency races, `SKIP LOCKED` claiming and the account locks are all asserted only by
single-threaded tests. Recommend a `TEST_DATABASE_URL`-gated concurrency suite against
real Postgres in CI (the harness already supports the env var).

### M4 — `/health/ready` is public and returns raw dependency error strings

> **Status: fixed in remediation pass 2** (driver message logged, removed from the body
> and from the response schema).

`health.routes.ts:270-282` returns `error: error.message` from the Postgres/Redis probes to
unauthenticated callers. `pg`/`ioredis` messages routinely embed host, port, database name,
role name and TLS/auth failure detail (`password authentication failed for user
"ledgerflow"`, `getaddrinfo ENOTFOUND ledgerflow-postgres`). Keep the 200/503 status and
the latency, log the message, and drop it from the body (or gate the detailed variant
behind an admin key).

### M5 — 422 handler echoes raw Postgres exception text

> **Status: fixed in remediation pass 2** (curated per-constraint messages).

`error-handler.ts:174-183` returns `details: error.message` for `23514`. Today that is the
ledger trigger's own message (fine), but *any* future check constraint, including ones
naming columns or values, is exposed verbatim. Map known constraint names to curated
messages instead.

### M6 — `WEBHOOK_SECRET_KEY` is configured twice in `render.yaml`, with no binding between the two

> **Status: fixed in remediation pass 2** (`fromService` binding + decrypt failure
> dead-letters instead of stalling).

The web service and the worker each declare `WEBHOOK_SECRET_KEY: sync: false`
(`render.yaml:24, 40`), i.e. two independently entered secrets. `API_KEY_PEPPER` is bound
correctly (`fromService`), which highlights the omission. If the values ever diverge, the
API encrypts endpoint secrets the worker cannot decrypt: `decryptSecret` throws inside
`executeDelivery` *before* any status write, so the job fails, BullMQ (`attempts: 1`) drops
it, and deliveries silently stall as `pending` forever — no dead-letter, no endpoint
failure counter, only a worker log line. Bind the worker's key with
`fromService: {type: web, name: ledgerflow-api, envVarKey: WEBHOOK_SECRET_KEY}` and wrap
the `decryptSecret` call in the same try/catch that dead-letters blocked URLs.

### M7 — `redirect: 'manual'` is correct, but a 3xx is treated as a permanent failure without saying so

> **Status: fixed in remediation pass 2** (explicit, actionable redirect diagnostic).

`delivery.ts:139-143` marks any non-2xx as failure and only retries 408/429/5xx, so a
receiver behind a redirect (very common: `http→https`, trailing-slash) dead-letters with
`receiver responded 301` after one attempt. That is safe, but it should be an explicit,
actionable error (`endpoint returned a redirect; update the endpoint URL to the final
target`) surfaced on the endpoint, not a generic status string.

### M8 — Transaction list pagination can silently drop rows

> **Status: fixed in remediation pass 2** (composite `(created_at, id)` keyset cursor).

`listTransactions` pages on `createdAt` alone (`lt(transactions.createdAt, cursor)`).
`created_at` is `now()` (transaction timestamp), so a batch of transactions committed in
one statement/transaction shares the exact value; a page boundary landing inside that group
skips the remainder. Use a composite `(created_at, id)` keyset cursor.

### M9 — No DB-level guarantee that an entry's account belongs to the transaction's org

> **Status: fixed in remediation pass 2** (`entries.organization_id` + composite FKs in
> migration `0004`).

`entries` has no `organization_id`, and there is no constraint tying
`entries.account_id → accounts.organization_id` to `transactions.organization_id`. Tenant
isolation here rests entirely on the service filtering `accounts` by org before insert
(which it does correctly today, `ledger.service.ts:162-172`). Given the DB-level rigour
elsewhere (balance trigger, append-only audit), add a composite FK
(`transactions(id, organization_id)` / `accounts(id, organization_id)` referenced from a
denormalised `entries.organization_id`) so a future code path cannot cross tenants.

---

## Low

- **L1 — `requestHash` is `JSON.stringify` of the parsed body.** Verified *not* exploitable
  today: zod re-serialises in schema order, so key order in the request does not change the
  hash (probe replayed a reordered body and correctly got `200` + the original transaction).
  It is still fragile — adding an optional field with a default changes hashes of all
  in-flight keys on deploy. Prefer a canonical (sorted-key) serialisation.
- **L2 — Bootstrap route registration is well guarded** (env refusal + registration guard +
  timing-safe token) but `timingSafeEqual` is only reached when lengths match; length is
  leaked. Compare digests instead of raw buffers.
- **L3 — `secretMatches` catches nothing useful**: `Buffer.from(x, 'hex')` does not throw on
  invalid hex, it truncates. The length check saves it, but the `try/catch` is misleading.
- **L4 — `touch()` writes `last_used_at` per cache miss with no debounce.** With the auth
  cache disabled (`AUTH_CACHE_TTL_SECONDS=0`, allowed by the schema) this is one UPDATE per
  request on a single row per key — row-level lock contention and WAL churn under load.
- **L5 — `AuthCache.revoke` no-ops when the client exists but TTL is 0.** `enabled` is false,
  yet `revoke` only checks `this.client`; harmless today, but the two guards disagree.
- **L6 — `replayEvent` resets an outbox event to `pending` but existing `dead_letter`
  deliveries for that event are never re-created** (the unique `(endpoint, event)` index
  suppresses the insert), so "replay event" silently does nothing for the endpoints that
  actually failed. Either delete/replay the existing delivery rows or document it.
- **L7 — Response snippets from receivers (512 bytes) are stored and returned via the API.**
  Same-tenant data, so not a leak, but it is unvalidated third-party content echoed into a
  JSON API; ensure consumers treat it as untrusted.
- **L8 — Docker/compose:** the image is lean and runs as `node`, but there is no
  `HEALTHCHECK` in the Dockerfile and compose pins `redis:7-alpine`/`postgres:17-alpine` by
  tag only. `docker-compose.yml` ships a real-looking default pepper/webhook key for the
  `app` profile; they are local-only and production refuses the built-in defaults, but the
  compose defaults are *not* the built-in defaults, so `NODE_ENV=production` in compose
  boots with a publicly known pepper. Make those variables required (`${API_KEY_PEPPER:?}`).
- **L9 — Migrations are additive and safe to run before traffic** (`preDeployCommand`), and
  `0001` correctly uses a `DEFERRABLE INITIALLY DEFERRED` constraint trigger. Two nits:
  `drizzle/meta` has no `0001_snapshot.json` (the journal lists it), so a future
  `drizzle-kit generate` may reintroduce dropped objects; and none of the migrations take a
  `lock_timeout`/`statement_timeout`, so a later `ALTER TABLE` on a busy table can queue
  behind long transactions and block writers.

---

<a id="remediation-pass-2-h4-h5-m2-m9-and-residuals"></a>

## Remediation pass 2 — H4, H5, M2–M9 and residuals

Second pass by the maintaining engineer. Every item below was implemented and is covered
by a test that fails without the change (`tests/security-hardening.test.ts`, plus
`tests/concurrency-postgres.test.ts` for the properties PGlite cannot express). The full
suite, `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build`,
`npm run db:verify` and `npm run audit:prod` were run; results are in the table at the end
of this section.

### H4 — rate limiting *(fixed)*

`src/app.ts` no longer sets `trustProxy: true`. It reads `TRUST_PROXY`
(`false` | `true` | hop count | comma-separated CIDR/IP list, default `false`, `1` on
Render via `render.yaml`), so `request.ip` is the socket peer unless a proxy is explicitly
trusted, and `X-Forwarded-For` can no longer choose a bucket.

`@fastify/rate-limit` is registered with `global: false` and two limiters are attached by
hand, which is what makes the Fastify lifecycle correct:

| Bucket | Hook | Key | Budget | Purpose |
|---|---|---|---|---|
| IP | `onRequest`, registered *before* the auth hook | `ip:<request.ip>` | `RATE_LIMIT_IP_MAX` (600/min) | bounds anonymous and invalid-key traffic, which never reaches `preHandler` |
| API key | `preHandler`, after auth resolved the principal | `key:<apiKeyId>` | `RATE_LIMIT_MAX` (200/min) | per-tenant budget; a shared NAT egress is not one bucket |
| Bootstrap | route-level, before the token comparison | `bootstrap:<ip>` | `RATE_LIMIT_BOOTSTRAP_MAX` (10/min) | token guessing on the unauthenticated route |

`src/server.ts` passes the ioredis client as the limiter store (`rateLimitRedis`), so the
budget is shared across web instances and survives deploys; tests and any deployment
without Redis fall back to the in-process store. Rejections are a `RateLimitedError`
(429, `code: "rate_limited"`, `Retry-After`) handled centrally in `error-handler.ts`.

Evidence: `tests/security-hardening.test.ts` — a rotating `X-Forwarded-For` no longer buys
quota (3×200 then 429/429 on one key while a second key of the same tenant still gets 200);
five invalid-key requests give 401×3 then 429×2 with `Retry-After`; the bootstrap route
429s on the third bad token. `parseTrustProxy` is unit-tested for every accepted form.

### H5 — delivery claim/lease *(fixed)*

Migration `0004` adds `webhook_deliveries.lease_expires_at` / `claimed_at` and an index on
`(status, lease_expires_at)`. `executeDelivery` now starts with a single atomic statement:

```sql
update webhook_deliveries
   set attempt = attempt + 1, claimed_at = now(),
       lease_expires_at = now() + WEBHOOK_LEASE_MS, updated_at = now()
 where id = $1 and status = 'pending'
   and (lease_expires_at is null or lease_expires_at < now())
returning *;
```

Zero rows means another worker owns it (`{result: 'skipped', reason: 'delivery is leased'}`).
Every terminal write (`succeeded`, `dead_letter`, retry-`pending`) is conditional on
`attempt = <claimed attempt>` and clears the lease, so a slow duplicate cannot move
`attempt` backwards, resurrect a succeeded row, or double-count `consecutive_failures`.
`requeueDueDeliveries` skips rows with a live lease, and the worker's 30-second sweep calls
the new `reclaimExpiredLeases` so a crashed worker's row becomes claimable again.

Evidence: `tests/security-hardening.test.ts` (a pre-leased row is skipped with attempt and
status untouched; two concurrent `executeDelivery` calls produce exactly one attempt and
one skip; an expired lease is reclaimed) and `tests/concurrency-postgres.test.ts` (six
truly parallel workers against real Postgres → exactly one claim).

### M2 — idempotency expiry and reaping *(fixed)*

Lookups now filter `expires_at > now()` (both the pre-transaction read and the
conflict-loser read), and the reservation upsert takes over an expired row
(`onConflictDoUpdate … setWhere expires_at < now()`) instead of colliding with it forever.
`reapExpiredIdempotencyKeys` deletes expired rows in bounded batches and runs in the worker
on `IDEMPOTENCY_REAP_INTERVAL_MS` (default 5 min, `0` disables).

Evidence: a key whose `expires_at` is pushed into the past produces a *new* transaction on
replay (not the stored response), and the reaper deletes it.

### M3 — isolation claim and untested concurrency *(addressed)*

The docstring in `ledger.service.ts` no longer claims "serializable-safe"; it states the
actual guarantee (read committed + row locks on the referenced accounts) and records that a
future balance constraint needs `repeatable read`/`serializable` plus a retry wrapper.

`tests/concurrency-postgres.test.ts` is a new suite that runs **only** when
`TEST_DATABASE_URL` points at a real Postgres (`DATABASE_POOL_MAX=8`), covering: 8 parallel
requests sharing one idempotency key → exactly one transaction id, no duplicates;
6 parallel delivery executions → one claim; 20 parallel transfers → exact final balance.
It is `describe.skip`ped with a console warning otherwise.

**Not verified in this environment:** the sandbox has no Postgres and no Redis binary, so
this suite and `tests/redis-integration.test.ts` are skipped here. Everything else runs
against PGlite. CI must set `TEST_DATABASE_URL` (and a Redis URL) for these to mean
anything.

### M4/M5 — error leakage *(fixed)*

`/health/ready` keeps 200/503 and the latency but no longer carries `error`; the field is
gone from the response schema and the driver message is logged at `error` with a
`dependency` tag. The 23514 handler maps known constraint names to curated text and falls
back to `"a ledger invariant was violated by this request"`; the raw message is logged.

### M6 — webhook key wiring and decrypt failure *(fixed)*

`render.yaml` binds the worker's `WEBHOOK_SECRET_KEY` with
`fromService: {type: web, name: ledgerflow-api, envVarKey: WEBHOOK_SECRET_KEY}`, matching
`API_KEY_PEPPER`. `decryptSecret` is wrapped: a failure dead-letters the delivery with
"endpoint secret could not be decrypted; WEBHOOK_SECRET_KEY does not match …", bumps the
endpoint failure counter and logs the cause, instead of throwing before any status write
and stalling the row as `pending` forever.

### M7 — redirect diagnostic *(fixed)*

A 3xx now fails with `receiver returned a redirect (301 to https://…); redirects are never
followed — update the endpoint URL to the final target`, still non-retryable.

### M8 — composite cursor *(fixed)*

`listTransactions` orders by `(created_at desc, id desc)` and pages on the tuple. The cursor
is the opaque string `<createdAt ISO>_<id>`; the legacy timestamp-only cursor is still
accepted (it degrades to the old behaviour rather than 400-ing in-flight clients).
`openapi.json` was regenerated for the new cursor pattern.

Evidence: five transactions forced to share one `created_at` are all returned exactly once
across `limit=2` pages; before the change the tail of the group was skipped.

### M9 — DB-level tenant isolation for entries *(fixed, migration `0004`)*

`entries.organization_id` is added, backfilled from `transactions`, made `NOT NULL`, and
tied to both parents by composite foreign keys against new unique keys
`accounts(id, organization_id)` and `transactions(id, organization_id)`.

Migration risk was judged acceptable and mitigated: the migration takes `lock_timeout=5s`
(so an `ALTER TABLE` cannot queue behind a long transaction and block writers), and a
`BEFORE INSERT` trigger derives `organization_id` when it is NULL — which is what keeps the
`NOT NULL` column compatible with the *previous* release still serving traffic while
`preDeployCommand` runs (expand/contract). The backfill `UPDATE` is a full table scan; on a
large `entries` table it should be run in batches ahead of the release instead.

Evidence: inserting an entry that points at another tenant's account is rejected by the
database; `npm run db:verify` asserts both FKs, the fill trigger and the lease column exist.

### Residuals and low-risk deployment defaults

- **C1 residual (int8 aggregate overflow)** — `getAccountWithBalance` now sums
  `sum(amount)::numeric`, and the balance field of `accountBalanceResponse` uses a wider
  `balanceString` (up to 39 digits) so a large account cannot fail response serialisation
  with a 500. Individual entry amounts stay int64-bounded. Test: three entries of
  `4611686018427387903` return `13835058055282163709`. A per-org amount policy cap is still
  recommended and still not implemented.
- **L2** — the bootstrap token is compared as SHA-256 digests, so the length pre-check no
  longer leaks the secret length.
- **L8** — `docker-compose.yml` now uses `${API_KEY_PEPPER:?}` / `${WEBHOOK_SECRET_KEY:?}`
  (no publicly-known default under `NODE_ENV=production`) and the Dockerfile has a
  `HEALTHCHECK` against `/health/live`.
- **L9** — migration `0004` sets `lock_timeout`/`statement_timeout`. The missing
  `0001_snapshot.json` is unchanged.
- Still open, unchanged: **M1** (per-tenant dispatch fairness), DNS-rebinding
  (check-then-connect) in the URL guard, **L1**, **L3–L7**.

### Verification run

| Command | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run format:check` (via `npm run format`) | clean |
| `npm run build` | clean |
| `npm test` / `npm run test:coverage` | 131 passed, 6 skipped (Redis + real-Postgres suites); coverage 90.68% stmts / 80.46% branch / 94.97% fn / 94.11% lines, all above thresholds |
| `npm run db:verify` | all migration checks pass, including the three new object checks |
| `npm run audit:prod` | 0 vulnerabilities |
| `npm run openapi` | regenerated; `tests/openapi-contract.test.ts` green |

---

## What was verified vs. reasoned

| ID | Verified by probe | Fixed here |
|----|-------------------|-----------|
| C1 | yes (500 reproduced, now 400) | yes |
| H1 | yes (200 after expiry, now 401) | yes |
| H2 | yes (`isPrivateAddress` returned false) | yes |
| H3 | yes (4,000 entries → 201, now 400) | yes |
| H4 | yes (per-XFF quota) | yes, in pass 2 (IP + API-key buckets, `TRUST_PROXY`, Redis store) |
| H5 | code reasoning | yes, in pass 2 (atomic claim + lease + conditional writes) |
| M1 | observed as test starvation | no (open, needs an ADR) |
| M2–M9 | code reasoning | yes, in pass 2 |
| L2, L8, L9 (partial) | code reasoning | yes, in pass 2 |
| L1, L3–L7 | code reasoning (L1 refuted by probe) | no |

## Files changed in pass 1

- `src/shared/money.ts` — int64 range enforcement, exported bounds.
- `src/modules/ledger/ledger.schemas.ts` — amount range refinement, `entries` max 1000.
- `src/modules/webhooks/url-guard.ts` — correct IPv6 expansion, mapped/NAT64 handling.
- `src/modules/auth/auth.cache.ts`, `src/modules/auth/auth.service.ts` — expiry-aware cache.
- `openapi.json` — regenerated (`npm run openapi`) for the `maxItems` change.
- `tests/review-findings.test.ts` — regression tests (dependency-free by design).
- `docs/SECURITY_REVIEW.md` — this document.

## Files changed in pass 2

- `src/config/env.ts` — `TRUST_PROXY`, `RATE_LIMIT_IP_MAX`, `RATE_LIMIT_BOOTSTRAP_MAX`,
  `WEBHOOK_LEASE_MS`, `IDEMPOTENCY_REAP_*`, `parseTrustProxy`.
- `src/app.ts` — trust-proxy policy, two-dimension rate limiting on the correct hooks.
- `src/server.ts` — Redis-backed limiter store.
- `src/shared/errors.ts`, `src/shared/error-handler.ts` — `RateLimitedError` (429 +
  `Retry-After`), curated check-constraint messages.
- `src/modules/auth/auth.routes.ts` — digest comparison, bootstrap limiter hook.
- `src/modules/health/health.routes.ts` — dependency errors logged, not returned.
- `src/modules/webhooks/delivery.ts` — atomic claim/lease, conditional writes, decrypt
  failure dead-letter, redirect diagnostic.
- `src/modules/outbox/dispatcher.ts` — lease-aware requeue, `reclaimExpiredLeases`,
  `reapExpiredIdempotencyKeys`.
- `src/worker.ts` — lease sweep and idempotency reaper loops, delivery error logging.
- `src/modules/ledger/ledger.service.ts` — numeric balance aggregate, expiry-aware
  idempotency, composite cursor, corrected isolation docstring, `entries.organization_id`.
- `src/modules/ledger/ledger.schemas.ts` — `transactionCursor`, `balanceString`.
- `src/infra/schema.ts` — lease columns, `entries.organization_id` and its index.
- `drizzle/0004_delivery_leases_tenant_guards.sql`, `drizzle/meta/_journal.json` — migration.
- `scripts/verify-migrations.ts` — checks for the new objects.
- `render.yaml`, `docker-compose.yml`, `Dockerfile`, `.env.example` — secret binding,
  `TRUST_PROXY`, required secrets, container healthcheck.
- `tests/security-hardening.test.ts` (new), `tests/concurrency-postgres.test.ts` (new),
  `tests/helpers.ts`, `tests/webhook-delivery.test.ts`.
- `openapi.json`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, this document.
