import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditEvents, outboxEvents } from '../src/infra/schema.js';
import { authHeaders, createTestContext, type TestContext } from './helpers.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});
afterAll(async () => {
  await context.close();
});

async function createAccount(reference: string) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: authHeaders(context.tokens.writerToken),
    payload: { name: reference, reference, type: 'asset', currency: 'USD' },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

describe('audit log', () => {
  it('records the acting api key, request id and resource for money movements', async () => {
    const cash = await createAccount(`cash-${Date.now()}`);
    const revenue = await createAccount(`revenue-${Date.now()}`);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { ...authHeaders(context.tokens.writerToken), 'x-request-id': 'req-audit-1' },
      payload: {
        description: 'sale',
        currency: 'USD',
        entries: [
          { accountId: cash, amount: '1000' },
          { accountId: revenue, amount: '-1000' },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const transactionId = response.json<{ id: string }>().id;

    const [row] = await context.database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'transaction.created'),
          eq(auditEvents.resourceId, transactionId),
        ),
      );

    expect(row).toBeDefined();
    expect(row?.organizationId).toBe(context.organizationId);
    expect(row?.actorType).toBe('api_key');
    expect(row?.actorId).toBeTruthy();
    expect(row?.requestId).toBe('req-audit-1');
  });

  it('never stores api key secrets in the audit metadata', async () => {
    const issued = await context.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: authHeaders(context.tokens.adminToken),
      payload: { name: 'audited key', role: 'reader' },
    });
    expect(issued.statusCode).toBe(201);
    const { token, apiKey } = issued.json<{ token: string; apiKey: { id: string } }>();

    const [row] = await context.database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, apiKey.id));
    expect(row?.action).toBe('api_key.issued');
    expect(JSON.stringify(row?.metadata)).not.toContain(token.split('.')[1]);
  });
});

describe('transactional outbox', () => {
  it('emits exactly one event per committed transaction', async () => {
    const cash = await createAccount(`cash-o-${Date.now()}`);
    const revenue = await createAccount(`rev-o-${Date.now()}`);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(context.tokens.writerToken, `idem-${Date.now()}`),
      payload: {
        description: 'sale',
        currency: 'USD',
        entries: [
          { accountId: cash, amount: '500' },
          { accountId: revenue, amount: '-500' },
        ],
      },
    });
    const transactionId = response.json<{ id: string }>().id;

    const events = await context.database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, transactionId));

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('transaction.created');
    expect(events[0]?.status).toBe('pending');
    expect(events[0]?.organizationId).toBe(context.organizationId);
    expect((events[0]?.payload as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('emits no event when the transaction is rejected', async () => {
    const before = await countEvents('transaction.created');

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(context.tokens.writerToken),
      payload: {
        description: 'unbalanced',
        currency: 'USD',
        entries: [
          { accountId: crypto.randomUUID(), amount: '100' },
          { accountId: crypto.randomUUID(), amount: '-100' },
        ],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(await countEvents('transaction.created')).toBe(before);
  });

  it('does not emit a second event when an idempotent request is replayed', async () => {
    const cash = await createAccount(`cash-i-${Date.now()}`);
    const revenue = await createAccount(`rev-i-${Date.now()}`);
    const key = `idem-replay-${Date.now()}`;
    const payload = {
      description: 'replayed',
      currency: 'USD',
      entries: [
        { accountId: cash, amount: '250' },
        { accountId: revenue, amount: '-250' },
      ],
    };

    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(context.tokens.writerToken, key),
      payload,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(context.tokens.writerToken, key),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const transactionId = first.json<{ id: string }>().id;
    const events = await context.database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, transactionId));
    expect(events).toHaveLength(1);
  });

  it('emits key lifecycle events', async () => {
    const issued = await context.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: authHeaders(context.tokens.adminToken),
      payload: { name: 'lifecycle', role: 'reader' },
    });
    const keyId = issued.json<{ apiKey: { id: string } }>().apiKey.id;

    const revoked = await context.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${keyId}`,
      headers: authHeaders(context.tokens.adminToken),
    });
    expect(revoked.statusCode).toBe(200);

    const events = await context.database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, keyId))
      .orderBy(desc(outboxEvents.createdAt));
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'api_key.issued',
      'api_key.revoked',
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});

async function countEvents(eventType: string): Promise<number> {
  const rows = await context.database.db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(eq(outboxEvents.eventType, eventType));
  return rows.length;
}
