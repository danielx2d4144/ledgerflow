/**
 * Real-concurrency suite (review M3).
 *
 * The default harness is PGlite, which serves one connection at a time
 * (`DATABASE_POOL_MAX=1`), so none of the concurrency properties this project
 * relies on — idempotency-key races, `FOR UPDATE SKIP LOCKED` claiming, webhook
 * delivery leases — can actually be exercised there. This file therefore runs
 * only when `TEST_DATABASE_URL` points at a real Postgres:
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/ledgerflow_test npm test
 *
 * It is skipped (not failed) otherwise, and CI should set the variable.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.js';
import { createDatabase, type DatabaseHandle } from '../src/infra/db.js';
import { createLogger } from '../src/infra/logger.js';
import { buildApp } from '../src/app.js';
import { webhookDeliveries } from '../src/infra/schema.js';
import { executeDelivery, type DeliveryConfig } from '../src/modules/webhooks/delivery.js';
import { encryptSecret } from '../src/modules/webhooks/secret-crypto.js';
import { outboxEvents, webhookEndpoints } from '../src/infra/schema.js';
import type { FastifyInstance } from 'fastify';
import {
  authHeaders,
  FakeDeliveryQueue,
  FakeRedis,
  mustExist,
  TEST_WEBHOOK_SECRET_KEY,
} from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfPostgres = databaseUrl ? describe : describe.skip;

if (!databaseUrl) {
  console.warn('[concurrency-postgres] skipped: set TEST_DATABASE_URL to a real Postgres to run');
}

describeIfPostgres('real Postgres concurrency', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let organizationId: string;
  let writerToken: string;
  let accountA: string;
  let accountB: string;

  const config: DeliveryConfig = {
    secretKey: TEST_WEBHOOK_SECRET_KEY,
    leaseMs: 60_000,
    timeoutMs: 200,
    backoffBaseMs: 100,
    backoffMaxMs: 1_000,
    urlGuard: { allowPrivateTargets: true, allowInsecureHttp: true },
  };

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://127.0.0.1:6379',
      // The whole point: a pool that can actually run statements in parallel.
      DATABASE_POOL_MAX: '8',
      RATE_LIMIT_MAX: '100000',
      RATE_LIMIT_IP_MAX: '100000',
      API_KEY_PEPPER: 'test-pepper-0123456789-0123456789-abc',
      WEBHOOK_SECRET_KEY: TEST_WEBHOOK_SECRET_KEY,
      WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
      WEBHOOK_ALLOW_INSECURE_HTTP: 'true',
    });
    database = createDatabase(env);
    app = await buildApp({
      env,
      logger: createLogger(env),
      db: database.db,
      dbPing: database.ping,
      redisPing: () => Promise.resolve(),
      cacheClient: new FakeRedis(),
      deliveryQueue: new FakeDeliveryQueue(),
    });
    await app.ready();

    const organization = await app.auth.createOrganization({
      name: 'Concurrency',
      slug: `conc-${randomUUID().slice(0, 8)}`,
    });
    organizationId = organization.id;
    writerToken = (await app.auth.issueKey({ organizationId, name: 'writer', role: 'writer' }))
      .token;

    const create = async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: authHeaders(writerToken),
        payload: {
          name: 'Cash',
          reference: `acct-${randomUUID().slice(0, 8)}`,
          type: 'asset',
          currency: 'USD',
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    accountA = await create();
    accountB = await create();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('creates exactly one transaction for concurrent requests sharing an idempotency key', async () => {
    const key = `idem-${randomUUID()}`;
    const payload = {
      description: 'concurrent',
      currency: 'USD',
      entries: [
        { accountId: accountA, amount: '250' },
        { accountId: accountB, amount: '-250' },
      ],
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: authHeaders(writerToken, key),
          payload,
        }),
      ),
    );

    const ok = responses.filter((response) => response.statusCode < 300);
    // Losers either replay the winner's response or get a 409 while the winner
    // is still in flight; what must never happen is two distinct transactions.
    const ids = new Set(ok.map((response) => response.json().id as string));
    expect(ids.size).toBe(1);
    for (const response of responses) {
      expect([200, 201, 409]).toContain(response.statusCode);
    }
  });

  it('lets exactly one concurrent worker claim a webhook delivery (H5)', async () => {
    const [endpoint] = await database.db
      .insert(webhookEndpoints)
      .values({
        organizationId,
        url: 'http://127.0.0.1:1/hook',
        eventTypes: [],
        secretCiphertext: encryptSecret('whsec_test', TEST_WEBHOOK_SECRET_KEY),
        secretLastFour: 'test',
      })
      .returning();
    const [event] = await database.db
      .insert(outboxEvents)
      .values({
        organizationId,
        eventType: 'transaction.created',
        aggregateType: 'transaction',
        aggregateId: randomUUID(),
        payload: {},
      })
      .returning();
    const [delivery] = await database.db
      .insert(webhookDeliveries)
      .values({
        organizationId,
        endpointId: mustExist(endpoint).id,
        outboxEventId: mustExist(event).id,
        eventType: 'transaction.created',
        maxAttempts: 5,
      })
      .returning();

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        executeDelivery({ db: database.db, config }, mustExist(delivery).id),
      ),
    );
    const claimed = outcomes.filter((outcome) => outcome.result !== 'skipped');
    expect(claimed).toHaveLength(1);

    const row = await database.db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, mustExist(delivery).id),
    });
    expect(row?.attempt).toBe(1);
  });

  it('keeps account balances exact under parallel writers', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountA}`,
      headers: authHeaders(writerToken),
    });
    const start = BigInt(before.json().balance as string);

    const writes = 20;
    const responses = await Promise.all(
      Array.from({ length: writes }, (_, index) =>
        app.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: authHeaders(writerToken),
          payload: {
            description: `parallel-${index}`,
            currency: 'USD',
            entries: [
              { accountId: accountA, amount: '7' },
              { accountId: accountB, amount: '-7' },
            ],
          },
        }),
      ),
    );
    for (const response of responses) expect(response.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountA}`,
      headers: authHeaders(writerToken),
    });
    expect(BigInt(after.json().balance as string)).toBe(start + BigInt(7 * writes));
  });
});
