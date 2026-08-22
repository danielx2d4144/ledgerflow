import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDatabase, type DatabaseHandle } from '../src/infra/db.js';
import { createLogger } from '../src/infra/logger.js';
import type { AuthCacheClient } from '../src/modules/auth/auth.cache.js';
import type { Role } from '../src/modules/auth/roles.js';
import type { DeliveryQueue } from '../src/modules/webhooks/queue.js';
import type { Env } from '../src/config/env.js';

/** In-memory stand-in for Redis, so cache behaviour is testable without a server. */
export class FakeRedis implements AuthCacheClient {
  readonly store = new Map<string, string>();
  failNext = false;
  gets = 0;
  sets = 0;

  private guard() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis unavailable');
    }
  }

  get(key: string): Promise<string | null> {
    this.guard();
    this.gets += 1;
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<unknown> {
    this.guard();
    this.sets += 1;
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<unknown> {
    for (const key of keys) this.store.delete(key);
    return Promise.resolve(keys.length);
  }
}

export interface TestOrganization {
  id: string;
  slug: string;
  adminToken: string;
  writerToken: string;
  readerToken: string;
}

export interface TestContext {
  app: FastifyInstance;
  env: Env;
  queue: FakeDeliveryQueue;
  database: DatabaseHandle;
  cache: FakeRedis;
  organizationId: string;
  tokens: TestOrganization;
  createOrganization: (slug?: string) => Promise<TestOrganization>;
  issueToken: (organizationId: string, role: Role) => Promise<string>;
  close: () => Promise<void>;
}

export interface TestContextOptions {
  bootstrap?: boolean;
  bootstrapToken?: string;
  authCacheTtlSeconds?: number;
  /** Relaxes the SSRF guard so tests can point endpoints at a local server. */
  allowLocalWebhooks?: boolean;
  webhookMaxAttempts?: number;
  /** Rate-limit overrides so the limiter can be exercised in a few requests. */
  rateLimitMax?: number;
  rateLimitIpMax?: number;
  rateLimitBootstrapMax?: number;
  trustProxy?: string;
}

/** Records enqueued delivery ids instead of talking to Redis. */
export class FakeDeliveryQueue implements DeliveryQueue {
  readonly enqueued: { deliveryId: string; delayMs: number }[] = [];

  enqueue(deliveryId: string, delayMs = 0): Promise<void> {
    this.enqueued.push({ deliveryId, delayMs });
    return Promise.resolve();
  }
}

export const TEST_WEBHOOK_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

export const BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789';

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: 'redis://127.0.0.1:6379',
    // PGlite serves a single connection at a time.
    DATABASE_POOL_MAX: '1',
    RATE_LIMIT_MAX: String(options.rateLimitMax ?? 10_000),
    RATE_LIMIT_IP_MAX: String(options.rateLimitIpMax ?? 100_000),
    RATE_LIMIT_BOOTSTRAP_MAX: String(options.rateLimitBootstrapMax ?? 10_000),
    ...(options.trustProxy ? { TRUST_PROXY: options.trustProxy } : {}),
    API_KEY_PEPPER: 'test-pepper-0123456789-0123456789-abc',
    AUTH_CACHE_TTL_SECONDS: String(options.authCacheTtlSeconds ?? 60),
    WEBHOOK_SECRET_KEY: TEST_WEBHOOK_SECRET_KEY,
    WEBHOOK_MAX_ATTEMPTS: String(options.webhookMaxAttempts ?? 3),
    ...(options.allowLocalWebhooks
      ? { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true', WEBHOOK_ALLOW_INSECURE_HTTP: 'true' }
      : {}),
    ...(options.bootstrap
      ? { BOOTSTRAP_ENABLED: 'true', BOOTSTRAP_TOKEN: options.bootstrapToken ?? BOOTSTRAP_TOKEN }
      : {}),
  });
  const database = createDatabase(env);
  const cache = new FakeRedis();
  const queue = new FakeDeliveryQueue();
  const app = await buildApp({
    env,
    logger: createLogger(env),
    db: database.db,
    dbPing: database.ping,
    redisPing: () => Promise.resolve(),
    cacheClient: cache,
    deliveryQueue: queue,
  });
  await app.ready();

  const issueToken = async (organizationId: string, role: Role) => {
    const issued = await app.auth.issueKey({ organizationId, name: `${role} key`, role });
    return issued.token;
  };

  const createOrganization = async (slug = `acme-${randomUUID()}`): Promise<TestOrganization> => {
    const organization = await app.auth.createOrganization({ name: 'Acme Test', slug });
    const [adminToken, writerToken, readerToken] = await Promise.all([
      issueToken(organization.id, 'admin'),
      issueToken(organization.id, 'writer'),
      issueToken(organization.id, 'reader'),
    ]);
    return {
      id: organization.id,
      slug,
      adminToken: adminToken,
      writerToken: writerToken,
      readerToken: readerToken,
    };
  };

  const tokens = await createOrganization();

  return {
    app,
    env,
    queue,
    database,
    cache,
    organizationId: tokens.id,
    tokens,
    createOrganization,
    issueToken,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

/**
 * Builds an extra Fastify app on top of an existing context's database and
 * tokens. Used for tests that need different env (e.g. tighter rate limits)
 * without opening a second PGlite connection, which the harness cannot serve.
 */
export async function buildAppWithEnv(
  ctx: TestContext,
  overrides: Record<string, string>,
): Promise<FastifyInstance> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_POOL_MAX: '1',
    RATE_LIMIT_MAX: '10000',
    RATE_LIMIT_IP_MAX: '100000',
    RATE_LIMIT_BOOTSTRAP_MAX: '10000',
    API_KEY_PEPPER: 'test-pepper-0123456789-0123456789-abc',
    WEBHOOK_SECRET_KEY: TEST_WEBHOOK_SECRET_KEY,
    ...overrides,
  });
  const app = await buildApp({
    env,
    logger: createLogger(env),
    db: ctx.database.db,
    dbPing: ctx.database.ping,
    redisPing: () => Promise.resolve(),
    cacheClient: new FakeRedis(),
    deliveryQueue: new FakeDeliveryQueue(),
  });
  await app.ready();
  return app;
}

/** Auth + optional idempotency headers for a request. */
export function authHeaders(token: string, idempotencyKey?: string) {
  return {
    authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

/** Narrows away `undefined` in tests without reaching for a non-null assertion. */
export function mustExist<T>(value: T | undefined | null, label = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${label} to exist`);
  return value;
}
