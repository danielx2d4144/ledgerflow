# ADR-0004: Cached balances in the write transaction, reconciled nightly

- Status: Accepted
- Date: 2025-02-05

## Context

`GET /accounts/:id/balance` is the hottest read. Options:
(a) always `SUM(entries)`, (b) a cached `account_balances` row updated
synchronously, (c) an async projection updated from the outbox.

## Decision

(b), with the cache updated inside the same DB transaction as the entry insert,
plus a nightly reconciliation job that recomputes from `entries` and alerts on
drift. Historical reads (`?as_of=`) and the trial balance always aggregate
`entries` and never consult the cache.

## Rationale

- (a) is O(entries per account). At 10^6 entries a balance read is a
  hundred-millisecond seq/index scan; unacceptable for a hot path, and it's also
  the path used by `disallow_negative` checks during posting.
- (c) makes balances eventually consistent, which is the wrong tradeoff for a
  ledger: a client that posts a transaction and immediately reads the balance
  must see it. Read-your-writes is non-negotiable here.
- (b) keeps `entries` as the single source of truth — the cache is a
  _derivable_ artifact, so a corrupted cache is repairable and never destroys
  data. That property is what makes the optimization defensible.
- The nightly job turns "the cache might drift" from an unknown into a monitored,
  bounded risk with an alert and an automatic repair.

## Concurrency handling

Both `account_balances` rows in a transfer are updated in ascending `account_id`
order so crossing transfers cannot deadlock. Deadlock (40P01) and serialization
failure (40001) are retried up to 3× with exponential jitter at the service
boundary; because the whole operation is idempotency-key guarded, retrying is safe.

## Consequences

- Positive: O(1) hot reads, read-your-writes, repairable.
- Negative: every transaction takes row locks on the involved accounts, so a
  single very hot account serializes. Measured ceiling ~1.5k writes/sec on one
  account pair. If that ever binds, the fix is per-account balance sharding
  (N sub-rows summed on read), noted but not built.
- Negative: two places compute balances (SQL aggregate + incremental update).
  Mitigated by a property test asserting they agree after random sequences.

## Implementation status (correction)

**Deferred, not built.** The shipped code takes option (a): every balance read
aggregates `entries`, and there is no `account_balances` table, no synchronous
cache update and no reconciliation job.

Why the change: the cache only pays for itself once accounts accumulate large
entry counts, and it adds a class of bug (drift) that has to be monitored and
repaired. Building it before there is a measured read problem would be
optimising against an imagined load. The decision above stands as the design to
implement when a real workload justifies it — the important property, that
`entries` remains the single source of truth and any cache is derivable, is
preserved by not having a cache at all.

Consequence to be honest about: balance reads are O(entries per account) today,
and that is the first thing to fix under load.
