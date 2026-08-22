import { z } from 'zod';

/** Signed 64-bit range: the column is int8, so anything wider is a 400, not a 500. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const amountString = z
  .string()
  .regex(/^-?\d{1,19}$/, 'amount must be an integer string in minor units')
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= INT64_MIN && parsed <= INT64_MAX;
  }, 'amount is outside the signed 64-bit minor-unit range');

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code');

export const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export const createAccountBody = z.object({
  name: z.string().min(1).max(200),
  reference: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9:_-]*$/, 'reference must be lowercase slug-like'),
  type: z.enum(accountTypes),
  currency: currencyCode,
});

export const accountResponse = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  reference: z.string(),
  type: z.enum(accountTypes),
  currency: currencyCode,
  createdAt: z.iso.datetime(),
});

/**
 * Aggregate balances are summed as `numeric`, so they can legitimately exceed
 * the int8 range that individual entry amounts are constrained to (C1
 * residual): the response type must be wider than `amountString` or a large
 * account would fail response serialisation with a 500.
 */
export const balanceString = z
  .string()
  .regex(/^-?\d{1,39}$/, 'balance must be an integer string in minor units');

export const accountBalanceResponse = accountResponse.extend({
  balance: balanceString,
  entryCount: z.int().nonnegative(),
});

export const entryInput = z.object({
  accountId: z.uuid(),
  amount: amountString,
});

export const createTransactionBody = z.object({
  description: z.string().min(1).max(500),
  currency: currencyCode,
  occurredAt: z.iso.datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  entries: z
    .array(entryInput)
    // Upper bound keeps one request from locking thousands of accounts inside a
    // single write transaction.
    .min(2, 'a transaction needs at least two entries')
    .max(1000, 'a transaction may not exceed 1000 entries'),
});

export const transactionResponse = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  description: z.string(),
  currency: currencyCode,
  metadata: z.record(z.string(), z.unknown()),
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  entries: z.array(z.object({ id: z.uuid(), accountId: z.uuid(), amount: amountString })),
});

/**
 * Opaque keyset cursor, `<createdAt ISO>_<transaction id>` (M8). Clients should
 * echo `nextCursor` verbatim; the timestamp-only form is still accepted.
 */
export const transactionCursor = z
  .string()
  .min(20)
  .max(100)
  .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z(_[0-9a-fA-F-]{36})?$/, 'invalid pagination cursor');

export const listTransactionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: transactionCursor.optional(),
});

export const listTransactionsResponse = z.object({
  data: z.array(transactionResponse),
  nextCursor: transactionCursor.nullable(),
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

export type CreateAccountBody = z.infer<typeof createAccountBody>;
export type CreateTransactionBody = z.infer<typeof createTransactionBody>;
export type TransactionResponse = z.infer<typeof transactionResponse>;
