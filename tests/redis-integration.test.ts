import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/infra/redis.js';
import { AuthCache } from '../src/modules/auth/auth.cache.js';
import {
  createBullDeliveryQueue,
  WEBHOOK_QUEUE_NAME,
} from '../src/modules/webhooks/bullmq-queue.js';

/**
 * Real-Redis smoke tests. The rest of the suite uses an in-memory fake, which
 * proves the *logic* but not that ioredis/BullMQ are wired correctly. This file
 * covers the wiring and is skipped unless a Redis is reachable — CI provides one
 * as a service container (see .github/workflows/ci.yml).
 *
 * Run locally with:  docker compose up -d redis && npm test
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    retryStrategy: () => null,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisReachable();

describe.skipIf(!available)('redis integration', () => {
  const namespace = `test:${randomUUID()}`;
  let handle: ReturnType<typeof createRedis>;

  beforeAll(() => {
    handle = createRedis({ REDIS_URL } as never);
  });

  afterAll(async () => {
    const keys = await handle.client.keys(`${namespace}*`);
    if (keys.length > 0) await handle.client.del(...keys);
    const bullKeys = await handle.client.keys(`bull:${WEBHOOK_QUEUE_NAME}:*`);
    if (bullKeys.length > 0) await handle.client.del(...bullKeys);
    await handle.close();
  });

  it('pings a real server through the production handle', async () => {
    await expect(handle.ping()).resolves.toBeUndefined();
  });

  it('round-trips a cached principal with a TTL', async () => {
    const cache = new AuthCache(handle.client, 60);
    const token = `lf_test_${randomUUID()}`;
    const principal = {
      apiKeyId: randomUUID(),
      organizationId: randomUUID(),
      role: 'writer' as const,
      prefix: 'lf_test_abc',
    };

    expect(await cache.get(token)).toBeNull();
    await cache.set(token, principal);
    expect(await cache.get(token)).toEqual(principal);

    await cache.revoke(principal.apiKeyId);
    expect(await cache.get(token)).toBeNull();
  });

  it('enqueues a delayed BullMQ job that lands in the delayed set', async () => {
    const queue = createBullDeliveryQueue({ url: REDIS_URL });
    try {
      const deliveryId = randomUUID();
      await queue.enqueue(deliveryId, 60_000);
      const delayed = await queue.queue.getDelayed();
      expect(delayed.some((job) => job.data.deliveryId === deliveryId)).toBe(true);
      await queue.queue.drain(true);
    } finally {
      await queue.close();
    }
  });
});

// Make the skip visible rather than silently green.
if (!available) {
  console.warn(`[redis-integration] skipped: no Redis at ${REDIS_URL}`);
}
