# ADR-0005: Transactional outbox + BullMQ for webhook delivery

- Status: Accepted
- Date: 2025-02-06

## Context

Webhooks must fire if and only if the transaction committed, be retried on
failure, and arrive in causal order per ledger. Options: enqueue directly from
the request handler; Postgres `LISTEN/NOTIFY`; transactional outbox polled by a
worker; pg-boss (queue inside Postgres); BullMQ on Redis.

## Decision

Transactional outbox table written in the ledger transaction, polled by a worker
with `FOR UPDATE SKIP LOCKED`, fanned out to one `webhook_deliveries` row per
`(endpoint, event)` and scheduled as BullMQ jobs on Redis.

## Rationale

- **Direct enqueue is a dual-write bug.** Commit-then-enqueue loses events if the
  process dies between; enqueue-then-commit emits events for rolled-back money.
  The outbox makes event emission part of the same commit. This is the single
  most important correctness property in the async path.
- **`LISTEN/NOTIFY` rejected**: notifications are lost if no listener is
  connected, and they do not survive pgbouncer/Neon's pooled endpoint in
  transaction mode. Polling every 250 ms with `SKIP LOCKED` is boring, survives
  worker restarts, and gives natural batching.
- **pg-boss rejected**: attractive (one datastore), but Redis is already required
  for idempotency locks, the auth cache, and rate limiting, so it isn't an extra
  dependency. pg-boss also puts high-churn queue writes on the same primary that
  serves the money path — the exact resource I want to protect.
- **BullMQ is a scheduler here, not the source of truth.** Jobs are added with
  `attempts: 1`; the attempt counter, backoff schedule and dead-letter state live
  in `webhook_deliveries`, so operators can see and replay them through the API
  and a Redis flush cannot lose the retry budget. A periodic sweep re-queues
  pending deliveries whose job disappeared.
- **Correction to an earlier draft of this ADR**: per-key ordering via BullMQ
  *groups* is a BullMQ Pro feature and is not available in the open-source
  package. Ordering is therefore **not** guaranteed across concurrent deliveries;
  each event carries `createdAt` and receivers that care about order must sort or
  reconcile. Reintroducing strict per-endpoint ordering would need either
  concurrency 1 per endpoint or BullMQ Pro, and is deliberately deferred.

## Delivery semantics

At-least-once. Every event carries a stable `event_id`; receivers deduplicate on
it, and this is stated in the docs. Exactly-once is not offered because it isn't
achievable across an HTTP boundary, and claiming it would be a lie a reviewer
would catch.

## Consequences

- Positive: no lost or phantom events; ordered per ledger; replayable from the
  delivery log; Redis outage degrades to delayed delivery, not lost delivery.
- Negative: up to 250 ms added latency before first attempt; an extra process to
  run and monitor; the outbox and delivery tables need a retention job
  (dispatched events and terminal deliveries pruned after 30 days; the
  append-only `audit_events` summary is what is kept long-term).
- Not guaranteed: ordering (see above) and exactly-once delivery.
