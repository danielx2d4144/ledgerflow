# Architecture Decision Records

| ADR                                               | Decision                                           | Status   |
| ------------------------------------------------- | -------------------------------------------------- | -------- |
| [0001](0001-fastify-over-express-and-nest.md)     | Fastify as the HTTP framework                      | Accepted |
| [0002](0002-bigint-minor-units.md)                | Money as BIGINT minor units                        | Accepted |
| [0003](0003-drizzle-over-prisma.md)               | Drizzle ORM instead of Prisma                      | Accepted, amended |
| [0004](0004-balance-cache-with-reconciliation.md) | Synchronous balance cache + nightly reconciliation | Deferred — balances are recomputed today |
| [0005](0005-outbox-bullmq-webhooks.md)            | Transactional outbox + BullMQ for webhooks         | Accepted |
| [0006](0006-idempotency-key-semantics.md)         | Idempotency key semantics                          | Accepted, amended |
| [0007](0007-api-key-auth-and-tenant-isolation.md) | API-key auth and tenant isolation                  | Accepted, amended |
| [0008](0008-webhook-secret-encryption.md)         | Webhook secrets encrypted (not hashed), shown once | Accepted |

Format: context → decision → rationale (including rejected options) → consequences.
Superseded ADRs are kept and marked, never deleted. Where the code diverged from
a decision, the ADR carries an **Implementation status (correction)** section
rather than being quietly rewritten — the correction is the interesting part.
