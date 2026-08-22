import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.js';
import { accounts, entries, idempotencyKeys, transactions } from '../../infra/schema.js';
import { recordAuditEvent, type AuditActor } from '../audit/audit.service.js';
import { enqueueOutboxEvent } from '../outbox/outbox.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { parseMinorUnits, sumMinorUnits } from '../../shared/money.js';
import type {
  CreateAccountBody,
  CreateTransactionBody,
  TransactionResponse,
} from './ledger.schemas.js';

export function canonicalizeRequest(payload: unknown): string {
  if (Array.isArray(payload)) {
    return `[${payload.map((value) => canonicalizeRequest(value)).join(',')}]`;
  }
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeRequest(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(payload);
}

function hashRequest(payload: unknown): string {
  return createHash('sha256').update(canonicalizeRequest(payload)).digest('hex');
}

export interface LedgerAuditContext {
  actor: AuditActor;
  requestId?: string | null | undefined;
  ip?: string | null | undefined;
}

const SYSTEM_CONTEXT: LedgerAuditContext = { actor: { type: 'system' } };

export interface TransactionCursor {
  createdAt: Date;
  id: string;
}

export function encodeTransactionCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}

/** Tolerates the legacy timestamp-only cursor so in-flight clients keep working. */
export function decodeTransactionCursor(cursor: string): TransactionCursor {
  const separator = cursor.indexOf('_');
  const timestamp = separator === -1 ? cursor : cursor.slice(0, separator);
  const id =
    separator === -1 ? 'ffffffff-ffff-ffff-ffff-ffffffffffff' : cursor.slice(separator + 1);
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) {
    throw new ValidationError('cursor is not a valid pagination cursor', { cursor });
  }
  return { createdAt, id };
}

export class LedgerService {
  constructor(private readonly db: Database) {}

  async createAccount(
    organizationId: string,
    input: CreateAccountBody,
    context: LedgerAuditContext = SYSTEM_CONTEXT,
  ) {
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({ organizationId, ...input })
        .onConflictDoNothing({ target: [accounts.organizationId, accounts.reference] })
        .returning();
      if (!row) return null;

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'account.created',
        resourceType: 'account',
        resourceId: row.id,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { reference: row.reference, type: row.type, currency: row.currency },
      });
      await enqueueOutboxEvent(tx, {
        organizationId,
        eventType: 'account.created',
        aggregateType: 'account',
        aggregateId: row.id,
        payload: {
          id: row.id,
          reference: row.reference,
          name: row.name,
          type: row.type,
          currency: row.currency,
          createdAt: row.createdAt.toISOString(),
        },
      });
      return row;
    });

    if (!created) {
      throw new ConflictError(`account reference '${input.reference}' already exists`, {
        reference: input.reference,
      });
    }
    return { ...created, createdAt: created.createdAt.toISOString() };
  }

  async getAccountWithBalance(organizationId: string, accountId: string) {
    const account = await this.db.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)),
    });
    if (!account) throw new NotFoundError('account', accountId);

    const [totals] = await this.db
      .select({
        // `sum(bigint)` is already numeric in Postgres, but the cast is
        // explicit so the aggregate can never overflow int8 (C1 residual).
        balance: sql<string>`coalesce(sum(${entries.amount})::numeric, 0)::text`,
        entryCount: sql<number>`count(*)::int`,
      })
      .from(entries)
      .where(eq(entries.accountId, accountId));

    return {
      ...account,
      createdAt: account.createdAt.toISOString(),
      balance: totals?.balance ?? '0',
      entryCount: totals?.entryCount ?? 0,
    };
  }

  /**
   * Creates a balanced double-entry transaction.
   *
   * Concurrency & safety properties:
   *  - all writes happen in one transaction at the pool's default isolation
   *    level (`read committed`); that is *not* serializable, so any future
   *    invariant that depends on reading other rows (e.g. "an account may not
   *    go negative") needs `repeatable read`/`serializable` plus a retry
   *    wrapper, or write skew becomes possible (M3);
   *  - the idempotency row is inserted first, so two concurrent requests with the
   *    same key contend on a unique index rather than both writing entries;
   *  - referenced accounts are locked with `for update` to prevent them being
   *    deleted/mutated mid-write;
   *  - the ledger balance invariant is additionally enforced in the database.
   */
  async createTransaction(
    organizationId: string,
    input: CreateTransactionBody,
    idempotencyKey: string | undefined,
    context: LedgerAuditContext = SYSTEM_CONTEXT,
  ): Promise<{ transaction: TransactionResponse; replayed: boolean }> {
    const requestHash = hashRequest(input);
    const amounts = input.entries.map((entry) => parseMinorUnits(entry.amount));

    if (sumMinorUnits(amounts) !== 0n) {
      throw new ValidationError('transaction entries must sum to zero', {
        sum: sumMinorUnits(amounts).toString(),
      });
    }
    if (amounts.some((amount) => amount === 0n)) {
      throw new ValidationError('entry amounts must be non-zero');
    }

    if (idempotencyKey) {
      // Expired rows must not replay: the documented window is 24h (ADR-0006),
      // and the reaper only deletes lazily (M2).
      const existing = await this.db.query.idempotencyKeys.findFirst({
        where: and(
          eq(idempotencyKeys.organizationId, organizationId),
          eq(idempotencyKeys.key, idempotencyKey),
          gt(idempotencyKeys.expiresAt, new Date()),
        ),
      });
      if (existing) return this.replay(existing.requestHash, requestHash, existing.responseBody);
    }

    return this.db.transaction(async (tx) => {
      if (idempotencyKey) {
        const [reserved] = await tx
          .insert(idempotencyKeys)
          .values({ organizationId, key: idempotencyKey, requestHash })
          .onConflictDoUpdate({
            target: [idempotencyKeys.organizationId, idempotencyKeys.key],
            // Take over an expired row instead of colliding with it forever.
            set: { requestHash, responseBody: null, createdAt: new Date() },
            setWhere: lt(idempotencyKeys.expiresAt, new Date()),
          })
          .returning({ id: idempotencyKeys.id });

        if (!reserved) {
          const winner = await tx.query.idempotencyKeys.findFirst({
            where: and(
              eq(idempotencyKeys.organizationId, organizationId),
              eq(idempotencyKeys.key, idempotencyKey),
              gt(idempotencyKeys.expiresAt, new Date()),
            ),
          });
          if (!winner) throw new ConflictError('idempotency key is being processed concurrently');
          return this.replay(winner.requestHash, requestHash, winner.responseBody);
        }
      }

      const accountIds = [...new Set(input.entries.map((entry) => entry.accountId))];
      const locked = await tx
        .select({ id: accounts.id, currency: accounts.currency })
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)))
        .for('update');

      if (locked.length !== accountIds.length) {
        const found = new Set(locked.map((account) => account.id));
        const missing = accountIds.filter((id) => !found.has(id));
        throw new NotFoundError('account', missing.join(', '));
      }
      const mismatched = locked.filter((account) => account.currency !== input.currency);
      if (mismatched.length > 0) {
        throw new ValidationError('all accounts must match the transaction currency', {
          currency: input.currency,
          accounts: mismatched.map((account) => account.id),
        });
      }

      const [transaction] = await tx
        .insert(transactions)
        .values({
          organizationId,
          description: input.description,
          currency: input.currency,
          metadata: input.metadata,
          ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
        })
        .returning();
      if (!transaction) throw new Error('failed to insert transaction');

      const insertedEntries = await tx
        .insert(entries)
        .values(
          input.entries.map((entry, index) => ({
            transactionId: transaction.id,
            accountId: entry.accountId,
            organizationId,
            amount: amounts[index] as bigint,
          })),
        )
        .returning({ id: entries.id, accountId: entries.accountId, amount: entries.amount });

      const response: TransactionResponse = {
        id: transaction.id,
        organizationId: transaction.organizationId,
        description: transaction.description,
        currency: transaction.currency,
        metadata: transaction.metadata,
        occurredAt: transaction.occurredAt.toISOString(),
        createdAt: transaction.createdAt.toISOString(),
        entries: insertedEntries.map((entry) => ({
          id: entry.id,
          accountId: entry.accountId,
          amount: entry.amount.toString(),
        })),
      };

      // Audit row and outbox event share this transaction: the event exists if
      // and only if the money moved. This is the outbox invariant.
      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'transaction.created',
        resourceType: 'transaction',
        resourceId: transaction.id,
        requestId: context.requestId,
        ip: context.ip,
        metadata: {
          currency: response.currency,
          entryCount: response.entries.length,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
      await enqueueOutboxEvent(tx, {
        organizationId,
        eventType: 'transaction.created',
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        payload: { ...response },
      });

      if (idempotencyKey) {
        await tx
          .update(idempotencyKeys)
          .set({ responseBody: response })
          .where(
            and(
              eq(idempotencyKeys.organizationId, organizationId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          );
      }

      return { transaction: response, replayed: false };
    });
  }

  private replay(storedHash: string, requestHash: string, body: unknown) {
    if (storedHash !== requestHash) {
      throw new ConflictError('idempotency key was reused with a different request body');
    }
    if (body === null || body === undefined) {
      throw new ConflictError('idempotency key is being processed concurrently');
    }
    return { transaction: body as TransactionResponse, replayed: true };
  }

  /**
   * Newest-first keyset pagination on `(created_at, id)`. `created_at` alone is
   * ambiguous — every transaction committed in the same statement shares it —
   * so a page boundary inside such a group used to skip rows (M8).
   */
  async listTransactions(organizationId: string, limit: number, cursor?: string) {
    const decoded = cursor ? decodeTransactionCursor(cursor) : null;
    const rows = await this.db.query.transactions.findMany({
      where: decoded
        ? and(
            eq(transactions.organizationId, organizationId),
            or(
              lt(transactions.createdAt, decoded.createdAt),
              and(eq(transactions.createdAt, decoded.createdAt), lt(transactions.id, decoded.id)),
            ),
          )
        : eq(transactions.organizationId, organizationId),
      orderBy: [desc(transactions.createdAt), desc(transactions.id)],
      limit: limit + 1,
      with: { entries: true },
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        description: row.description,
        currency: row.currency,
        metadata: row.metadata,
        occurredAt: row.occurredAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        entries: row.entries.map((entry) => ({
          id: entry.id,
          accountId: entry.accountId,
          amount: entry.amount.toString(),
        })),
      })),
      nextCursor: rows.length > limit && last ? encodeTransactionCursor(last) : null,
    };
  }
}
