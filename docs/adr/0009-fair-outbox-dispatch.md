# ADR-0009: Fair Outbox Dispatch

## Status

Accepted

## Context

The outbox is shared by every organization. A dispatcher batch ordered only by
`created_at` lets one organization with a large backlog occupy every slot, which
delays webhook delivery for unrelated organizations.

## Decision

Each dispatch batch first selects the oldest pending event for each organization,
then orders those candidates globally by creation time and applies the batch
limit. The existing row lock and `SKIP LOCKED` claim remain in place. Therefore,
an organization receives at most one first-round slot, while older events still
retain priority among organizations.

If fewer organizations have pending work than the batch size, the current
implementation dispatches only the fair first-round candidates. The next poll
round advances each organization's backlog without allowing a single tenant to
starve the others.

## Consequences

- A noisy organization cannot monopolize a dispatch batch.
- Dispatch ordering is fair across organizations, not strictly global FIFO.
- One additional candidate-selection query runs per dispatch batch.
- Delivery fan-out, idempotency, and concurrent-worker locking semantics are
  unchanged.

## Alternatives considered

- Strict global FIFO: rejected because it permits noisy-neighbour starvation.
- Per-organization queues: rejected because it adds queue lifecycle and fairness
  coordination outside the database that already owns the outbox state.
- Weighted tenant quotas: deferred until operational traffic data justifies a
  configurable policy.