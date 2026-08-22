# ADR-0003: Drizzle ORM instead of Prisma

- Status: Accepted
- Date: 2025-02-04

## Context

The data layer needs: explicit transactions, row-level locking (`FOR UPDATE`,
`SKIP LOCKED`), bulk inserts, CTEs, raw SQL for the trial balance, checked-in
readable migrations, and deferred constraint triggers. Candidates: Prisma,
Drizzle, Kysely, raw `pg` + custom migrator.

## Decision

Drizzle ORM with `drizzle-kit` migrations, over the `pg` driver.

## Rationale

- **`SKIP LOCKED` and `FOR UPDATE` are load-bearing** in the outbox relay and
  hold-expiry jobs. Prisma requires `$queryRaw` for both, which discards the
  type safety that was the reason to use Prisma.
- **Migrations must be SQL I can read and hand-edit.** The balance trigger, the
  deferred constraint, partial indexes, and generated columns are all things
  drizzle-kit emits as plain SQL files that I then extend. Prisma's schema DSL
  cannot express them; they'd live in escape-hatch migrations anyway.
- **No query engine binary.** Prisma's Rust engine complicates the Docker image
  and cold starts on Render's free tier.
- **Kysely rejected** narrowly: comparable SQL fidelity, but no first-class
  migration tooling, so I'd assemble one. Drizzle bundles it.
- Raw `pg` rejected: the type-safety loss across ~25 repo functions is not worth
  the purity.

## Consequences

- Positive: SQL semantics are visible in code; locking and CTEs are ergonomic;
  small image.
- Negative: Drizzle's relational query API is less mature than Prisma's; nested
  reads are hand-written joins. Smaller community for edge cases.
- Mitigation: all SQL is confined to `src/modules/*/repo.ts`, enforced by an ESLint
  boundaries rule, so swapping the layer later is a contained change.

## Implementation status (correction)

Drizzle shipped as decided. The mitigation did not: there is no `repo.ts` layer
and no `eslint-plugin-boundaries` rule. Services own their own queries
(`src/modules/*/*.service.ts`), which at this size keeps a money-path read in
one file instead of three. The tradeoff accepted: swapping the data layer later
would touch every service rather than a repo directory.
