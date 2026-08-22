import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Redis } from 'ioredis';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { parseTrustProxy, type Env } from './config/env.js';
import type { Database } from './infra/db.js';
import { apiKeyRoutes, bootstrapRoutes } from './modules/auth/auth.routes.js';
import { AuthCache, type AuthCacheClient } from './modules/auth/auth.cache.js';
import { registerAuth } from './modules/auth/auth.plugin.js';
import { AuthService } from './modules/auth/auth.service.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { ledgerRoutes } from './modules/ledger/ledger.routes.js';
import { noopDeliveryQueue, type DeliveryQueue } from './modules/webhooks/queue.js';
import { webhookRoutes } from './modules/webhooks/webhooks.routes.js';
import { WebhookService } from './modules/webhooks/webhooks.service.js';
import { registerErrorHandler } from './shared/error-handler.js';
import { RateLimitedError } from './shared/errors.js';

export const APP_VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    dbPing: () => Promise<void>;
    redisPing: () => Promise<void>;
    appVersion: string;
  }
}

export interface BuildAppOptions {
  env: Env;
  logger: FastifyBaseLogger;
  db: Database;
  dbPing: () => Promise<void>;
  redisPing: () => Promise<void>;
  /** Optional Redis client used only for the auth cache; omit to disable it. */
  cacheClient?: AuthCacheClient | null;
  /**
   * Where replay requests are published. Defaults to a no-op: the worker's
   * poller still picks the work up, replay is just less immediate.
   */
  deliveryQueue?: DeliveryQueue;
  /**
   * Redis client backing the rate limiter. Without it the limiter is
   * per-instance memory, so N instances allow N× the configured budget and the
   * counters reset on every deploy.
   */
  rateLimitRedis?: Redis | null;
}

type LimitResult = { isAllowed: boolean; key: string } & Partial<{
  ttlInSeconds: number;
  isExceeded: boolean;
  isBanned: boolean;
}>;

function ttlSeconds(result: LimitResult): number {
  return result.ttlInSeconds ?? 60;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, logger, db } = options;

  const serverOptions: FastifyServerOptions = {
    loggerInstance: logger,
    // Never blanket-trust `X-Forwarded-For`: it is the rate-limit key (H4).
    // A hop count is a valid runtime value that the published types omit.
    trustProxy: parseTrustProxy(env.TRUST_PROXY) as NonNullable<FastifyServerOptions['trustProxy']>,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  };
  const app = Fastify(serverOptions);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', db);
  app.decorate('dbPing', options.dbPing);
  app.decorate('redisPing', options.redisPing);
  app.decorate('appVersion', APP_VERSION);

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: env.NODE_ENV === 'production' });
  // Rate limiting (H4). Two dimensions, because they defend different things:
  //  - an IP bucket applied in `onRequest`, before authentication, so anonymous
  //    and invalid-key traffic (credential stuffing, bootstrap guessing) is
  //    bounded;
  //  - an API-key bucket applied in `preHandler`, after the auth hook has
  //    resolved `request.principal`, so one tenant cannot spend another's
  //    budget and a shared NAT egress is not one bucket.
  // `global: false` keeps the plugin from installing its own IP-only hook.
  await app.register(rateLimit, {
    global: false,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    nameSpace: 'ledgerflow-rl:',
    ...(options.rateLimitRedis ? { redis: options.rateLimitRedis } : {}),
  });

  /**
   * `createRateLimit` reports `isAllowed: false` on every call in this plugin
   * version; `isExceeded`/`isBanned` are the fields that actually change, so the
   * decision is taken from those.
   */
  const exceeded = (result: LimitResult) => result.isExceeded === true || result.isBanned === true;

  const ipLimiter = app.createRateLimit({
    max: env.RATE_LIMIT_IP_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => `ip:${request.ip}`,
  });
  const keyLimiter = app.createRateLimit({
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => `key:${request.principal?.apiKeyId ?? `ip:${request.ip}`}`,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'LedgerFlow API',
        version: APP_VERSION,
        description:
          'Double-entry ledger API. Amounts are integer strings in minor units; ' +
          'entries of a transaction always sum to zero.',
      },
      servers: [{ url: `http://localhost:${env.PORT}`, description: 'local' }],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Opaque API key, `lf_<env>_<prefix>.<secret>`. Send as ' +
              '`Authorization: Bearer <key>` (or `X-Api-Key: <key>`).',
          },
        },
      },
      security: [{ apiKey: [] }],
      tags: [
        { name: 'health', description: 'Liveness and readiness probes' },
        { name: 'auth', description: 'API keys, roles and tenant identity' },
        { name: 'accounts', description: 'Ledger accounts' },
        { name: 'transactions', description: 'Double-entry transactions' },
        { name: 'webhooks', description: 'Webhook endpoints, deliveries and replay' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  if (env.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  registerErrorHandler(app);

  // Registered before `registerAuth` so it runs first in the onRequest chain:
  // rejected credentials must still consume IP quota.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === undefined) return;
    const result = await ipLimiter(request);
    if (exceeded(result)) throw new RateLimitedError(ttlSeconds(result), 'ip');
  });

  const authService = new AuthService({
    db,
    pepper: env.API_KEY_PEPPER,
    nodeEnv: env.NODE_ENV,
    cache: new AuthCache(options.cacheClient ?? null, env.AUTH_CACHE_TTL_SECONDS, (error) => {
      logger.warn({ err: error }, 'auth cache unavailable, falling back to database');
    }),
  });
  registerAuth(app, { service: authService });

  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url === undefined) return;
    // Public routes (health, bootstrap) have no key; the IP bucket covers them.
    if (!request.principal) return;
    const result = await keyLimiter(request);
    if (exceeded(result)) throw new RateLimitedError(ttlSeconds(result), 'api_key');
  });

  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(apiKeyRoutes, { prefix: '/v1' });
  await app.register(ledgerRoutes, { prefix: '/v1' });
  await app.register(webhookRoutes, {
    prefix: '/v1',
    service: new WebhookService({
      db,
      secretKey: env.WEBHOOK_SECRET_KEY,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      urlGuard: {
        allowPrivateTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
        allowInsecureHttp: env.WEBHOOK_ALLOW_INSECURE_HTTP,
      },
      queue: options.deliveryQueue ?? noopDeliveryQueue,
    }),
  });

  // Second guard on top of the env-level refusal in `loadEnv`.
  if (env.BOOTSTRAP_ENABLED && env.NODE_ENV !== 'production' && env.BOOTSTRAP_TOKEN) {
    logger.warn('bootstrap route enabled at POST /v1/bootstrap — never enable in production');
    const bootstrapLimiter = app.createRateLimit({
      max: env.RATE_LIMIT_BOOTSTRAP_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW_MS,
      keyGenerator: (request) => `bootstrap:${request.ip}`,
    });
    await app.register(bootstrapRoutes, {
      prefix: '/v1',
      token: env.BOOTSTRAP_TOKEN,
      limiter: async (request) => {
        const result = await bootstrapLimiter(request);
        if (exceeded(result)) throw new RateLimitedError(ttlSeconds(result), 'bootstrap');
      },
    });
  }

  return app;
}
