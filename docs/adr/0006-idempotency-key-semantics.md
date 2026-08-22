# ADR-0006: Idempotency key semantics

- Status: Accepted
- Date: 2025-02-07

## Context

Clients retry. A retried `POST /v1/transactions` must not move money twice. The
industry reference is Stripe's `Idempotency-Key`; the details (scope, body
fingerprint, concurrent replays, TTL) are where implementations get it wrong.

## Decision

`Idempotency-Key` is **required** on all mutating endpoints. The stored key is
scoped `(tenant_id, key, endpoint)` and carries a SHA-256 fingerprint of the
canonicalized request body.

| Situation                             | Response                                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| New key                               | Execute; persist status + body in the same DB transaction as the effect |
| Same key, same fingerprint, completed | Replay stored status and body, header `Idempotent-Replay: true`         |
| Same key, different fingerprint       | `409 idempotency_key_reuse`                                             |
| Same key, still in flight             | `409 request_in_progress`, `Retry-After: 1`                             |
| Key older than 24 h                   | Treated as new (row expired and swept)                                  |

## Rationale

- **Required, not optional.** Optional idempotency means the default path is the
  unsafe one. Requiring the header costs clients one line and removes an entire
  class of production incident. This is a deliberate deviation from Stripe.
- **Body fingerprint** catches the real bug: a client reusing a key for a
  different payload and silently getting the old result. Failing loudly is safer.
- **Scoped by endpoint** so the same key on `/transactions` and `/holds` doesn't
  collide; scoped by tenant so keys are never a cross-tenant oracle.
- **Persisted in the same DB transaction as the effect.** Storing the response in
  Redis after commit leaves a window where the effect exists and the record
  doesn't, and a retry would double-post. Postgres is the authority; Redis holds
  only a short advisory lock to convert the common concurrent-retry case from a
  constraint error into a clean `409`.
- **24 h TTL** matches Stripe, bounds table growth, and exceeds any sane client
  retry window. Swept hourly.

## Consequences

- Positive: double-posting is structurally prevented, including under concurrent
  retries and Redis outage (the Postgres primary key still holds).
- Negative: an extra row write per mutation and a `jsonb` response copy; the
  table is the second-highest-churn table in the system. Bounded by the TTL sweep.
- Negative: required-header is non-standard and will surprise some clients; the
  400 error body includes a copy-pasteable example and a link to the docs section.

## Implementation status (correction)

Shipped, with three deviations from the decision above:

1. **Optional, not required.** `Idempotency-Key` is honoured on
   `POST /v1/transactions` and omitted requests are accepted. Making it
   mandatory is still the better default, but it is a breaking change to the
   published API and is queued as a v2 change rather than done quietly.
2. **Scope is `(organization_id, key)`, not `(tenant, key, endpoint)`,** because
   transaction creation is the only endpoint that consumes the header today. An
   endpoint column is an additive migration when a second one appears.
3. **No Redis advisory lock.** Concurrency is resolved by inserting the
   idempotency row first inside the write transaction: the loser of the unique
   index race replays the winner's stored response, or gets
   `409 "idempotency key is being processed concurrently"` if the winner has not
   committed a response yet. One mechanism instead of two, and Postgres stays
   the only authority.

The observable semantics that matter are unchanged: same key + same body replays
the stored response (`200` instead of the original `201`), same key + different
body is a `409`, and the record commits with the effect. Rows carry
`expires_at`, indexed for sweeping; the sweep job itself is not implemented.
