# LedgerFlow — Product Brief

**One line:** A double-entry ledger API that fintech teams can drop in behind their product to hold balances, move money between accounts, and emit auditable, signed events — without rebuilding accounting primitives for the fourth time.

**Status:** Portfolio flagship. Single-developer scope. Production-minded, not production-scaled.

This document is the product intent. Where intent and code differ, the code
wins and it is marked **[not shipped]** below; `docs/ARCHITECTURE.md` describes
only what exists. The README has the same split in table form.

---

## 1. Problem

Every product that touches money (marketplaces, wallets, BNPL, payroll, creator payouts) ends up building the same thing badly:

- Balances stored as a mutable `users.balance` column, updated with `UPDATE ... SET balance = balance + x`. No history, no audit trail, no way to answer "why is this number 37 cents off?"
- Money movement implemented as two separate writes that are not atomic, or that are atomic in the DB but not idempotent against a retrying payment provider.
- Webhooks that are unsigned, unordered, and delivered exactly zero-or-many times.
- No separation between "the money moved" and "the money is available" (pending/settled).

LedgerFlow is the boring, correct core: an immutable double-entry ledger with an HTTP API, strong idempotency, and reliable signed webhooks.

## 2. Who it's for

| Persona                                    | Need                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Backend engineer at a seed-stage fintech   | Correct balances and an audit trail on day one, without hiring an accountant-engineer |
| Platform/marketplace team                  | Track per-seller balances, holds, payouts, fees as first-class entries                |
| Ops / finance analyst (read-only consumer) | Export a trial balance and reconcile against the PSP statement                        |

Not for: general ERP accounting, tax, invoicing, or being a bank. LedgerFlow records movement; it does not touch rails.

## 3. Core concepts

- **Organization** — the tenant. Everything below belongs to exactly one, derived from the API key and never from a request field. (A separate `Ledger` grouping inside an organization is **[not shipped]**: accounts hang directly off the organization and currency is enforced per account.)
- **Account** — `asset | liability | equity | revenue | expense`, one currency, plus a caller-owned `reference` (`user:1042:wallet`) unique within the organization.
- **Transaction** — an atomic, immutable set of ≥2 **entries** in one currency whose amounts sum to zero. Once posted, never mutated; corrections are new transactions.
- **Entry** — `(transaction_id, account_id, amount)`. Amounts are **signed** `BIGINT` minor units: the sign is the direction, so "balanced" is `SUM(amount) = 0`. No floats anywhere.
- **Balance** — derived on read as the sum of an account's entries. There is no cached balance.
- **Hold** — reserved amount that reduces available balance without moving posted balance. **[not shipped]**

## 4. What v1 does (scope)

**In:**

1. Multi-tenant organizations, accounts, transactions, entries. ✅
2. Atomic transaction posting with balance-invariant enforcement in the DB. ✅
3. Idempotency keys on transaction creation, with stored, replayable responses. ✅ (other mutating endpoints are naturally idempotent or admin-only)
4. Balance reads derived from entries. ✅ — as-of-timestamp reads and trial balance are **[not shipped]**
5. API keys with hierarchical RBAC roles (`admin`, `writer`, `reader`), instant revocation. ✅ Scoped permissions are a v2 item.
6. Signed outbound webhooks (`account.created`, `transaction.created`, `api_key.issued`, and `api_key.revoked`) from a transactional outbox, with retries, exponential backoff, dead-lettering and replay. ✅
7. Append-only audit log for money movement, key lifecycle and webhook changes. ✅
8. Cursor-paginated transaction listing with stable ordering. ✅
9. OpenAPI 3.1 generated from the same Zod schemas used at runtime; Swagger UI at `/docs` outside production. ✅
10. Docker Compose for local dev; Render blueprint for deploy (API + worker + Postgres + Redis). ✅
11. Holds: create, capture, release, TTL expiry. **[not shipped]**
12. Reversal endpoint. **[not shipped]** — post the inverse entries instead.

**Explicitly out of v1** (documented as such, which is itself a signal of judgment):

- Multi-currency transactions and FX. One currency per ledger, hard-enforced.
- Payment rails, KYC, card issuing.
- A UI beyond the API docs page.
- Streaming/CDC exports, GraphQL, gRPC.
- Horizontal sharding. One Postgres primary is the design assumption.

## 5. Differentiators for a portfolio reader

The interesting parts a reviewer should notice in 90 seconds:

- **Correctness enforced by the database, not by hope.** A deferred constraint trigger rejects any transaction whose entries do not net to zero. Application bugs cannot create imbalanced money.
- **Idempotency done properly.** Key scoped to the organization plus a request-body fingerprint. A replay returns the stored response body; the same key with a different body is a `409`; a concurrent duplicate loses a unique-index race and replays instead of double-posting — one mechanism, in Postgres, committed with the effect (ADR-0006 records where this deviates from the original plan).
- **Events that cannot lie.** The outbox row is written in the same commit as the money, so an event exists exactly when the state change does — no dual write, no lost notification.
- **Webhooks you'd actually trust.** HMAC-SHA256 over `timestamp.body`, `v1=` scheme with a timestamp header and a 5-minute recommended skew window, secrets encrypted at rest and shown once, per-endpoint rotation, at-least-once delivery with dead-lettering and replay. (Ordering guarantees and dual-secret overlap during rotation: **[not shipped]**.)
- **Observable.** Request IDs propagated to logs and error bodies, structured `pino` logs with redaction, `/health/live` + `/health/ready`. A `/metrics` endpoint is **[not shipped]**.

## 6. API surface (v1)

As implemented (the generated `openapi.json` is authoritative):

```
GET    /health/live   /health/ready   /docs        # /docs outside production only
GET    /v1/me
POST   /v1/api-keys
GET    /v1/api-keys
DELETE /v1/api-keys/{apiKeyId}
POST   /v1/accounts
GET    /v1/accounts/{accountId}                    # includes the derived balance
POST   /v1/transactions                            # Idempotency-Key honoured
GET    /v1/transactions?cursor=&limit=
POST   /v1/webhook-endpoints
GET    /v1/webhook-endpoints
GET    /v1/webhook-endpoints/{endpointId}
PATCH  /v1/webhook-endpoints/{endpointId}
DELETE /v1/webhook-endpoints/{endpointId}
POST   /v1/webhook-endpoints/{endpointId}/rotate-secret
GET    /v1/webhook-deliveries?status=
GET    /v1/webhook-deliveries/{deliveryId}
POST   /v1/webhook-deliveries/{deliveryId}/replay
POST   /v1/events/{eventId}/replay
POST   /v1/bootstrap                               # non-production only
```

Errors are a single JSON envelope — `{"error": {"code", "message", "details?", "requestId"}}` —
with a stable `code` and field-level `details` for validation failures. (RFC 9457
`application/problem+json` was the plan; the simpler envelope shipped, and
changing it now would be a breaking API change for no user benefit.)

## 7. Success criteria (what "done" means)

| Criterion   | Target                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Correctness | Property-based tests over random transaction sequences: trial balance nets to 0, every balance equals the sum of its entries. ✅ (`tests/ledger-properties.test.ts`) |
| Idempotency | Replaying a transaction request returns the stored response and produces one effect; mismatched reuse is rejected. ✅              |
| Coverage    | Thresholds enforced in CI, set just under the measured baseline (see docs/DEVELOPMENT.md). ✅                                      |
| Docs        | A reader can post their first transaction from the README with Docker Compose. ✅                                                  |
| CI          | Lint + typecheck + format + tests on real Postgres/Redis + migration verification + OpenAPI drift + audit + Docker build. ✅        |
| Concurrency | A dedicated N-parallel-transfer stress test is **[not shipped]**; concurrency safety currently rests on `FOR UPDATE`, the unique idempotency index and the deferred trigger, each covered by tests. |
| Latency     | No published target. Method for measuring your own is in docs/LOAD-TESTING.md; no numbers are claimed here.                        |

## 8. Demo narrative (the README walkthrough)

A marketplace scenario, runnable from the README:

1. Bootstrap the organization `acme` and take the admin key.
2. Create accounts `platform:cash` (asset), `seller:42:payable` (liability), `platform:fees` (revenue).
3. Buyer pays $100 → one transaction: `platform:cash` +10000, `seller:42:payable` −9000, `platform:fees` −1000.
4. Register a webhook endpoint; the worker delivers `transaction.created`, signed, and the delivery log shows the attempt and response status.
5. Refund by posting the inverse entries; the trial balance still nets to zero.

Steps 4 and 5 are covered by `tests/webhook-delivery.test.ts` and
`tests/ledger-properties.test.ts`. The hold/capture leg of the original
narrative is **[not shipped]**.

## 9. Non-goals as guardrails

The project is deliberately narrow. Any feature that does not serve "record money movement correctly and tell you about it" is out. This keeps the codebase readable end-to-end in one sitting, which is the actual point of a portfolio flagship.
