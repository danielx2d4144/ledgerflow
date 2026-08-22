import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, type TestContext } from './helpers.js';

/**
 * Property tests for the ledger invariants that the whole product rests on:
 *
 *  1. every accepted transaction sums to zero;
 *  2. the sum of all entry amounts across the organization is zero (trial balance);
 *  3. a reported account balance always equals the sum of that account's entries;
 *  4. any generated set of entries that does not sum to zero is rejected, and
 *     leaves no partial state behind.
 *
 * Runs against the same Postgres (wire protocol) as the rest of the suite, so
 * the database-level deferred constraint trigger is part of what is being tested.
 */

let ctx: TestContext;
const RUNS = Number(process.env.PROPERTY_RUNS ?? 25);

beforeAll(async () => {
  ctx = await createTestContext();
}, 60_000);
afterAll(async () => {
  await ctx.close();
});

async function createAccount(): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: authHeaders(ctx.tokens.writerToken),
    payload: {
      name: 'Property account',
      reference: `prop-${randomUUID().slice(0, 12)}`,
      type: 'asset',
      currency: 'USD',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

async function postTransaction(entries: { accountId: string; amount: string }[]) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/transactions',
    headers: authHeaders(ctx.tokens.writerToken),
    payload: { description: 'property', currency: 'USD', entries },
  });
}

async function accountBalance(accountId: string): Promise<bigint> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/v1/accounts/${accountId}`,
    headers: authHeaders(ctx.tokens.readerToken),
  });
  expect(response.statusCode).toBe(200);
  return BigInt(response.json().balance);
}

/** Map lookup that fails loudly instead of silently defaulting to zero. */
function mustGet(map: Map<string, bigint>, key: string): bigint {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing balance for ${key}`);
  return value;
}

/** Amounts small enough to stay readable, large enough to cross the int32 line. */
const amount = fc.bigInt({ min: 1n, max: 5_000_000_000n });

describe('ledger invariants (property-based)', () => {
  it('keeps the trial balance at zero and every account balance derivable', async () => {
    const accountIds = await Promise.all([createAccount(), createAccount(), createAccount()]);
    const expected = new Map<string, bigint>(accountIds.map((id) => [id, 0n]));

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          from: fc.integer({ min: 0, max: 2 }),
          shift: fc.integer({ min: 1, max: 2 }),
          value: amount,
        }),
        async ({ from, shift, value }) => {
          const source = accountIds[from] as string;
          const destination = accountIds[(from + shift) % accountIds.length] as string;

          const response = await postTransaction([
            { accountId: source, amount: (-value).toString() },
            { accountId: destination, amount: value.toString() },
          ]);
          expect(response.statusCode).toBe(201);

          // The response itself must be balanced.
          const body = response.json();
          const sum = (body.entries as { amount: string }[]).reduce(
            (total, entry) => total + BigInt(entry.amount),
            0n,
          );
          expect(sum).toBe(0n);

          expected.set(source, mustGet(expected, source) - value);
          expected.set(destination, mustGet(expected, destination) + value);
        },
      ),
      { numRuns: RUNS, endOnFailure: true },
    );

    let trialBalance = 0n;
    for (const accountId of accountIds) {
      const balance = await accountBalance(accountId);
      expect(balance).toBe(expected.get(accountId));
      trialBalance += balance;
    }
    expect(trialBalance).toBe(0n);
  });

  it('rejects any unbalanced entry set without leaving partial state', async () => {
    const [a, b] = await Promise.all([createAccount(), createAccount()]);

    await fc.assert(
      fc.asyncProperty(
        fc.tuple(amount, amount).filter(([left, right]) => left !== right),
        async ([left, right]) => {
          const response = await postTransaction([
            { accountId: a, amount: (-left).toString() },
            { accountId: b, amount: right.toString() },
          ]);
          expect(response.statusCode).toBe(422);
          expect(response.json().error.code).toBe('unprocessable_entity');
        },
      ),
      { numRuns: RUNS, endOnFailure: true },
    );

    expect(await accountBalance(a)).toBe(0n);
    expect(await accountBalance(b)).toBe(0n);
  });

  it('never accepts a zero-amount entry', async () => {
    const [a, b] = await Promise.all([createAccount(), createAccount()]);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(0n), async (zero) => {
        const response = await postTransaction([
          { accountId: a, amount: zero.toString() },
          { accountId: b, amount: zero.toString() },
        ]);
        expect(response.statusCode).toBe(422);
      }),
      { numRuns: 1 },
    );
    expect(await accountBalance(a)).toBe(0n);
  });
});
