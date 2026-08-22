import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

/**
 * Coarse, hierarchical roles. `admin` ⊃ `writer` ⊃ `reader`; the hierarchy is
 * enforced in code (see `src/modules/auth/roles.ts`), not in the database.
 */
export const apiKeyRoleEnum = pgEnum('api_key_role', ['admin', 'writer', 'reader']);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Human-facing stable reference, unique per organization.
    reference: text('reference').notNull(),
    type: accountTypeEnum('type').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('accounts_org_reference_key').on(table.organizationId, table.reference),
    index('accounts_org_idx').on(table.organizationId),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 }).notNull(),
    description: text('description').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('transactions_org_created_idx').on(table.organizationId, table.createdAt)],
);

/**
 * Double-entry postings. `amount` is signed minor units; the sum of all entries
 * belonging to a transaction is enforced to be zero by a deferred DB trigger.
 */
export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /**
     * Denormalised tenant id. Composite foreign keys to
     * `transactions(id, organization_id)` and `accounts(id, organization_id)`
     * make cross-tenant postings impossible at the database level (M9).
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('entries_account_idx').on(table.accountId),
    index('entries_transaction_idx').on(table.transactionId),
    index('entries_org_idx').on(table.organizationId),
  ],
);

/** Request-level idempotency records, scoped per organization. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseBody: jsonb('response_body').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (table) => [uniqueIndex('idempotency_org_key_key').on(table.organizationId, table.key)],
);

/**
 * Opaque API keys. Only the public `prefix` and a peppered HMAC of the secret
 * are stored, so a database dump cannot be replayed against the API.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Public, non-secret lookup handle embedded in the key. */
    prefix: text('prefix').notNull(),
    /** HMAC-SHA256(pepper, secret), hex. Never logged, never returned. */
    secretHash: text('secret_hash').notNull(),
    role: apiKeyRoleEnum('role').notNull().default('reader'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('api_keys_prefix_key').on(table.prefix),
    index('api_keys_org_idx').on(table.organizationId),
  ],
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  accounts: many(accounts),
  transactions: many(transactions),
  apiKeys: many(apiKeys),
}));

export const transactionsRelations = relations(transactions, ({ many, one }) => ({
  entries: many(entries),
  organization: one(organizations, {
    fields: [transactions.organizationId],
    references: [organizations.id],
  }),
}));

export const entriesRelations = relations(entries, ({ one }) => ({
  transaction: one(transactions, {
    fields: [entries.transactionId],
    references: [transactions.id],
  }),
  account: one(accounts, { fields: [entries.accountId], references: [accounts.id] }),
}));

/* ------------------------------------------------------------------ *
 * Audit log, transactional outbox and webhook delivery
 * ------------------------------------------------------------------ */

export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'dispatched', 'failed']);

export const webhookEndpointStatusEnum = pgEnum('webhook_endpoint_status', ['active', 'disabled']);

export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', [
  'pending',
  'succeeded',
  'failed',
  'dead_letter',
]);

/**
 * Append-only audit trail. Updates and deletes are rejected by a database
 * trigger (see `drizzle/0003_*.sql`), so the log cannot be rewritten by the
 * application role — only truncated by a superuser during retention work.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** `api_key` for authenticated callers, `system` for background work. */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    /** Correlates the audit row with the HTTP request and its logs. */
    requestId: text('request_id'),
    ip: text('ip'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_events_org_action_idx').on(table.organizationId, table.action),
  ],
);

/**
 * Transactional outbox. Rows are written inside the same database transaction
 * as the state change they describe, so an event exists if and only if the
 * change committed.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('outbox_pending_idx').on(table.status, table.availableAt),
    index('outbox_org_created_idx').on(table.organizationId, table.createdAt),
  ],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description'),
    /** Empty array means "every event type". */
    eventTypes: jsonb('event_types').$type<string[]>().notNull().default([]),
    /** AES-256-GCM ciphertext of the signing secret; see ADR-0008. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    /** Non-secret tail, shown in listings so operators can tell secrets apart. */
    secretLastFour: text('secret_last_four').notNull(),
    status: webhookEndpointStatusEnum('status').notNull().default('active'),
    disabledReason: text('disabled_reason'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('webhook_endpoints_org_idx').on(table.organizationId)],
);

/**
 * One row per (endpoint, event). The unique index is what makes fan-out
 * duplicate-safe: a retried dispatch cannot create a second delivery, and the
 * job id in Redis is the delivery id.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    outboxEventId: uuid('outbox_event_id')
      .notNull()
      .references(() => outboxEvents.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** Exclusive worker claim; NULL or in the past means claimable (H5). */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    responseSnippet: text('response_snippet'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_endpoint_event_key').on(table.endpointId, table.outboxEventId),
    index('webhook_deliveries_org_created_idx').on(table.organizationId, table.createdAt),
    index('webhook_deliveries_status_idx').on(table.status, table.nextAttemptAt),
    index('webhook_deliveries_lease_idx').on(table.status, table.leaseExpiresAt),
  ],
);

export const webhookEndpointsRelations = relations(webhookEndpoints, ({ many, one }) => ({
  deliveries: many(webhookDeliveries),
  organization: one(organizations, {
    fields: [webhookEndpoints.organizationId],
    references: [organizations.id],
  }),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  endpoint: one(webhookEndpoints, {
    fields: [webhookDeliveries.endpointId],
    references: [webhookEndpoints.id],
  }),
  event: one(outboxEvents, {
    fields: [webhookDeliveries.outboxEventId],
    references: [outboxEvents.id],
  }),
}));
