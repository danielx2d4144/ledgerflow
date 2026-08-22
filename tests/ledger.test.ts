import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

async function createAccount(overrides: Record<string, unknown> = {}) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: authHeaders(ctx.tokens.writerToken),
    payload: {
      name: 'Cash',
      reference: `acct-${randomUUID().slice(0, 8)}`,
      type: 'asset',
      currency: 'USD',
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('accounts', () => {
  it('creates an account and starts at a zero balance', async () => {
    const account = await createAccount({ name: 'Operating cash' });
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/accounts/${account.id}`,
      headers: authHeaders(ctx.tokens.writerToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balance: '0', entryCount: 0 });
  });

  it('rejects a duplicate reference within an organization', async () => {
    const account = await createAccount();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: { name: 'Dup', reference: account.reference, type: 'asset', currency: 'USD' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('conflict');
  });

  it('rejects an invalid payload with field-level details', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: { name: '', reference: 'Bad Ref', type: 'nope', currency: 'usd' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.length).toBeGreaterThan(0);
  });

  it('requires an API key', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/transactions' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('does not leak accounts across organizations', async () => {
    const account = await createAccount();
    const other = await ctx.createOrganization();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/accounts/${account.id}`,
      headers: authHeaders(other.readerToken),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('transactions', () => {
  it('posts a balanced transaction and updates both balances', async () => {
    const cash = await createAccount();
    const revenue = await createAccount({ type: 'revenue', name: 'Revenue' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        description: 'Invoice 1001 paid',
        currency: 'USD',
        entries: [
          { accountId: cash.id, amount: '150000' },
          { accountId: revenue.id, amount: '-150000' },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().entries).toHaveLength(2);

    const cashBalance = await ctx.app.inject({
      method: 'GET',
      url: `/v1/accounts/${cash.id}`,
      headers: authHeaders(ctx.tokens.writerToken),
    });
    expect(cashBalance.json()).toMatchObject({ balance: '150000', entryCount: 1 });
  });

  it('rejects an unbalanced transaction', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        description: 'Broken',
        currency: 'USD',
        entries: [
          { accountId: a.id, amount: '100' },
          { accountId: b.id, amount: '-99' },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toMatch(/sum to zero/);
  });

  it('rejects entries whose account currency differs', async () => {
    const usd = await createAccount();
    const eur = await createAccount({ currency: 'EUR' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        description: 'Mixed currency',
        currency: 'USD',
        entries: [
          { accountId: usd.id, amount: '100' },
          { accountId: eur.id, amount: '-100' },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it('404s when an entry references an unknown account', async () => {
    const account = await createAccount();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        description: 'Ghost account',
        currency: 'USD',
        entries: [
          { accountId: account.id, amount: '100' },
          { accountId: randomUUID(), amount: '-100' },
        ],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const big = '9007199254740993';
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        description: 'Large posting',
        currency: 'USD',
        entries: [
          { accountId: a.id, amount: big },
          { accountId: b.id, amount: `-${big}` },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().entries[0].amount).toBe(big);
  });

  it('replays an idempotent retry instead of double-posting', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const key = `idem-${randomUUID()}`;
    const payload = {
      description: 'Retryable payment',
      currency: 'USD',
      entries: [
        { accountId: a.id, amount: '2500' },
        { accountId: b.id, amount: '-2500' },
      ],
    };

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken, key),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken, key),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const balance = await ctx.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a.id}`,
      headers: authHeaders(ctx.tokens.writerToken),
    });
    expect(balance.json()).toMatchObject({ balance: '2500', entryCount: 1 });
  });

  it('rejects reuse of an idempotency key with a different body', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const key = `idem-${randomUUID()}`;
    const base = {
      description: 'First',
      currency: 'USD',
      entries: [
        { accountId: a.id, amount: '100' },
        { accountId: b.id, amount: '-100' },
      ],
    };
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken, key),
      payload: base,
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken, key),
      payload: { ...base, description: 'Changed' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('paginates transactions newest-first with a cursor', async () => {
    const a = await createAccount();
    const b = await createAccount();
    for (let i = 0; i < 3; i += 1) {
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers: authHeaders(ctx.tokens.writerToken),
        payload: {
          description: `Page test ${i}`,
          currency: 'USD',
          entries: [
            { accountId: a.id, amount: '10' },
            { accountId: b.id, amount: '-10' },
          ],
        },
      });
    }

    const first = await ctx.app.inject({
      method: 'GET',
      url: '/v1/transactions?limit=2',
      headers: authHeaders(ctx.tokens.writerToken),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toHaveLength(2);
    expect(first.json().nextCursor).toBeTruthy();

    const next = await ctx.app.inject({
      method: 'GET',
      url: `/v1/transactions?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: authHeaders(ctx.tokens.writerToken),
    });
    expect(next.statusCode).toBe(200);
    const firstIds = first.json().data.map((t: { id: string }) => t.id);
    const nextIds = next.json().data.map((t: { id: string }) => t.id);
    expect(nextIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });
});

describe('database invariants', () => {
  it('blocks an unbalanced write made directly against the database', async () => {
    const account = await createAccount();
    await expect(
      ctx.database.pool.query(
        `with t as (
           insert into transactions (organization_id, currency, description)
           values ($1, 'USD', 'direct sql') returning id
         )
         insert into entries (transaction_id, account_id, amount)
         select t.id, $2, 500 from t`,
        [ctx.organizationId, account.id],
      ),
    ).rejects.toThrow(/unbalanced|requires at least 2/);
  });
});
