import type { Database } from './db.js';

/** The transaction handle drizzle hands to `db.transaction(...)` callbacks. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything that can run a statement: the pool-backed database or an open
 * transaction. Services take this so callers decide the transaction boundary —
 * which is what makes the outbox invariant expressible in types.
 */
export type Executor = Database | Transaction;
