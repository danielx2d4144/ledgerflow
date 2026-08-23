import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { outboxEvents, webhookDeliveries, webhookEndpoints } from '../src/infra/schema.js';
import { dispatchOutboxBatch, requeueDueDeliveries } from '../src/modules/outbox/dispatcher.js';
import { executeDelivery, type DeliveryConfig } from '../src/modules/webhooks/delivery.js';
import { verifySignature } from '../src/modules/webhooks/signature.js';
import {
  authHeaders,
  createTestContext,
  mustExist,
  TEST_WEBHOOK_SECRET_KEY,
  type TestContext,
} from './helpers.js';

interface Received {
  body: string;
  headers: IncomingMessage['headers'];
}

/** Deterministic local receiver: no network, no timing games. */
class TestReceiver {
  readonly received: Received[] = [];
  respondWith: { status: number; body?: string } | 'hang' = { status: 200, body: 'ok' };
  private server!: Server;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.received.push({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers,
        });
        if (this.respondWith === 'hang') return; // never answers: exercises the timeout
        response.writeHead(this.respondWith.status, { 'content-type': 'text/plain' });
        response.end(this.respondWith.body ?? '');
      });
    });
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}/hook`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => {
        resolve();
      });
    });
  }
}

let context: TestContext;
let receiver: TestReceiver;
let config: DeliveryConfig;

beforeAll(async () => {
  context = await createTestContext({ allowLocalWebhooks: true, webhookMaxAttempts: 2 });
  receiver = new TestReceiver();
  await receiver.start();
  config = {
    secretKey: TEST_WEBHOOK_SECRET_KEY,
    leaseMs: 60_000,
    timeoutMs: 500,
    backoffBaseMs: 100,
    backoffMaxMs: 1_000,
    urlGuard: { allowPrivateTargets: true, allowInsecureHttp: true },
  };
});

afterAll(async () => {
  await receiver.stop();
  await context.close();
});

async function registerEndpoint(eventTypes: string[] = []) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/webhook-endpoints',
    headers: authHeaders(context.tokens.adminToken),
    payload: { url: receiver.url, eventTypes },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ secret: string; endpoint: { id: string } }>();
}

async function postTransaction(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const accountIds: string[] = [];
  for (const reference of [`a-${suffix}`, `b-${suffix}`]) {
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(context.tokens.writerToken),
      payload: { name: reference, reference, type: 'asset', currency: 'USD' },
    });
    accountIds.push(created.json<{ id: string }>().id);
  }
  const transaction = await context.app.inject({
    method: 'POST',
    url: '/v1/transactions',
    headers: authHeaders(context.tokens.writerToken),
    payload: {
      description: 'webhook test',
      currency: 'USD',
      entries: [
        { accountId: accountIds[0], amount: '100' },
        { accountId: accountIds[1], amount: '-100' },
      ],
    },
  });
  expect(transaction.statusCode).toBe(201);
  return transaction.json<{ id: string }>().id;
}

function dispatch() {
  return dispatchOutboxBatch({
    db: context.database.db,
    queue: context.queue,
    batchSize: 100,
    maxAttempts: 2,
  });
}

async function deliveryRow(id: string) {
  const [row] = await context.database.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id));
  return mustExist(row, 'delivery row');
}

describe('outbox dispatch and HMAC delivery', () => {
  it('gives each organization a dispatch slot before serving backlog depth', async () => {
    const noisy = await context.createOrganization();
    const quiet = await context.createOrganization();
    const fairnessEpoch = new Date('2020-01-01T00:00:00.000Z');
    const noisyEvents = await context.database.db
      .insert(outboxEvents)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          organizationId: noisy.id,
          eventType: `noisy.${index}`,
          aggregateType: 'test',
          aggregateId: `noisy-${index}`,
          payload: {},
          createdAt: fairnessEpoch,
        })),
      )
      .returning({ id: outboxEvents.id });
    const [quietEvent] = await context.database.db
      .insert(outboxEvents)
      .values({
        organizationId: quiet.id,
        eventType: 'quiet.0',
        aggregateType: 'test',
        aggregateId: 'quiet-0',
        payload: {},
        createdAt: fairnessEpoch,
      })
      .returning({ id: outboxEvents.id });

    const stats = await dispatchOutboxBatch({
      db: context.database.db,
      queue: context.queue,
      batchSize: 2,
      maxAttempts: 2,
    });
    expect(stats.claimedEvents).toBe(2);

    const claimed = await context.database.db
      .select({ id: outboxEvents.id, organizationId: outboxEvents.organizationId })
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'dispatched'));
    const claimedIds = new Set(claimed.map((event) => event.id));
    expect(claimedIds.has(mustExist(quietEvent).id)).toBe(true);
    expect(noisyEvents.filter((event) => claimedIds.has(event.id))).toHaveLength(1);
  });

  it('delivers a signed, verifiable payload to a live receiver', async () => {
    const { secret, endpoint } = await registerEndpoint(['transaction.created']);
    const transactionId = await postTransaction();

    const stats = await dispatch();
    expect(stats.createdDeliveries).toBeGreaterThan(0);
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;

    const outcome = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(outcome.result).toBe('succeeded');

    const request = mustExist(receiver.received.at(-1));
    const payload = JSON.parse(request.body) as { id: string; type: string; data: { id: string } };
    expect(payload.type).toBe('transaction.created');
    expect(payload.data.id).toBe(transactionId);
    expect(request.headers['x-ledgerflow-event-id']).toBe(payload.id);
    expect(request.headers['x-ledgerflow-attempt']).toBe('1');

    expect(
      verifySignature({
        secret,
        timestampSeconds: Number(request.headers['x-ledgerflow-timestamp']),
        body: request.body,
        signature: String(request.headers['x-ledgerflow-signature']),
      }),
    ).toBe(true);

    const row = await deliveryRow(deliveryId);
    expect(row.status).toBe('succeeded');
    expect(row.responseStatus).toBe(200);
    expect(row.attempt).toBe(1);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.deliveredAt).not.toBeNull();

    const [endpointRow] = await context.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(endpointRow?.consecutiveFailures).toBe(0);
    expect(endpointRow?.lastSuccessAt).not.toBeNull();

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('respects event type subscriptions', async () => {
    const { endpoint } = await registerEndpoint(['account.created']);
    await postTransaction();
    await dispatch();

    const rows = await context.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(rows.every((row) => row.eventType === 'account.created')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('is duplicate-safe: re-dispatching an event creates no second delivery', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    await postTransaction();
    await dispatch();

    const before = await context.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(before).toHaveLength(1);
    const eventId = mustExist(before[0]).outboxEventId;

    // Replay the event twice; fan-out must stay idempotent per (endpoint, event).
    for (let index = 0; index < 2; index += 1) {
      const replay = await context.app.inject({
        method: 'POST',
        url: `/v1/events/${eventId}/replay`,
        headers: authHeaders(context.tokens.adminToken),
      });
      expect(replay.statusCode).toBe(202);
      await dispatch();
    }

    const after = await context.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(after).toHaveLength(1);

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('retries 5xx with backoff and dead-letters once the budget is spent', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    receiver.respondWith = { status: 503, body: 'unavailable' };
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;

    const first = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(first.result).toBe('retry');
    expect(first).toMatchObject({ attempt: 1 });
    let row = await deliveryRow(deliveryId);
    expect(row.status).toBe('pending');
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.responseStatus).toBe(503);

    const second = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(second.result).toBe('dead_letter');
    row = await deliveryRow(deliveryId);
    expect(row.status).toBe('dead_letter');
    expect(row.attempt).toBe(2);
    expect(row.error).toContain('503');

    // A dead-lettered delivery is inert until an operator replays it.
    const third = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(third).toEqual({ result: 'skipped', reason: 'delivery is dead_letter' });

    const [endpointRow] = await context.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(endpointRow?.consecutiveFailures).toBe(2);

    receiver.respondWith = { status: 200, body: 'ok' };
    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('does not retry a 4xx: the request itself is wrong', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    receiver.respondWith = { status: 400, body: 'bad request' };
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;

    const outcome = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(outcome.result).toBe('dead_letter');
    const row = await deliveryRow(deliveryId);
    expect(row.attempt).toBe(1);
    expect(row.responseSnippet).toBe('bad request');

    receiver.respondWith = { status: 200, body: 'ok' };
    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('treats a hung receiver as a retryable timeout', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    receiver.respondWith = 'hang';
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;

    const outcome = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(outcome.result).toBe('retry');
    const row = await deliveryRow(deliveryId);
    expect(row.error).toMatch(/TimeoutError|abort/i);

    receiver.respondWith = { status: 200, body: 'ok' };
    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('replays a dead-lettered delivery through the API and succeeds', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    receiver.respondWith = { status: 400 };
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;
    await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect((await deliveryRow(deliveryId)).status).toBe('dead_letter');

    const listed = await context.app.inject({
      method: 'GET',
      url: '/v1/webhook-deliveries?status=dead_letter',
      headers: authHeaders(context.tokens.readerToken),
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json<{ data: { id: string }[] }>().data.some((row) => row.id === deliveryId),
    ).toBe(true);

    receiver.respondWith = { status: 200, body: 'ok' };
    const replay = await context.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryId}/replay`,
      headers: authHeaders(context.tokens.adminToken),
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json<{ status: string; maxAttempts: number }>().status).toBe('pending');
    expect(context.queue.enqueued.at(-1)?.deliveryId).toBe(deliveryId);

    const outcome = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(outcome.result).toBe('succeeded');
    expect((await deliveryRow(deliveryId)).attempt).toBe(2);

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('refuses to replay a delivery from another organization', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;
    const other = await context.createOrganization();

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryId}/replay`,
      headers: authHeaders(other.adminToken),
    });
    expect(response.statusCode).toBe(404);

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('dead-letters deliveries for a disabled endpoint instead of calling it', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;

    await context.app.inject({
      method: 'PATCH',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
      payload: { status: 'disabled' },
    });

    const before = receiver.received.length;
    const outcome = await executeDelivery({ db: context.database.db, config }, deliveryId);
    expect(outcome.result).toBe('dead_letter');
    expect(receiver.received).toHaveLength(before);

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('blocks a delivery whose stored url no longer passes the SSRF guard', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    await postTransaction();
    await dispatch();
    const deliveryId = mustExist(context.queue.enqueued.at(-1)).deliveryId;

    const strict: DeliveryConfig = {
      ...config,
      urlGuard: { allowPrivateTargets: false, allowInsecureHttp: false },
    };
    const before = receiver.received.length;
    const outcome = await executeDelivery({ db: context.database.db, config: strict }, deliveryId);

    expect(outcome.result).toBe('dead_letter');
    expect(receiver.received).toHaveLength(before);
    expect((await deliveryRow(deliveryId)).error).toContain('blocked:');

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });

  it('re-queues pending deliveries whose queue job was lost', async () => {
    const { endpoint } = await registerEndpoint(['transaction.created']);
    await postTransaction();
    await dispatch();
    context.queue.enqueued.length = 0;

    const requeued = await requeueDueDeliveries({
      db: context.database.db,
      queue: context.queue,
      batchSize: 100,
      maxAttempts: 2,
    });
    expect(requeued).toBeGreaterThan(0);
    expect(context.queue.enqueued.length).toBe(requeued);

    await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: authHeaders(context.tokens.adminToken),
    });
  });
});
