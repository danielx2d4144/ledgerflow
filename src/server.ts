import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDatabase } from './infra/db.js';
import { createLogger } from './infra/logger.js';
import { createRedis } from './infra/redis.js';
import { createBullDeliveryQueue } from './modules/webhooks/bullmq-queue.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const database = createDatabase(env);
  const redis = createRedis(env);

  // The API only enqueues (replay controls); consumption belongs to the worker.
  const deliveryQueue = createBullDeliveryQueue({
    url: env.REDIS_URL,
    maxRetriesPerRequest: null,
  });

  const app = await buildApp({
    env,
    logger,
    db: database.db,
    dbPing: database.ping,
    redisPing: redis.ping,
    cacheClient: redis.client,
    // Shared limiter counters across instances (H4).
    rateLimitRedis: redis.client,
    deliveryQueue,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'shutting down');
      const timer = setTimeout(() => {
        logger.error('graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, env.SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      try {
        await app.close();
        await Promise.allSettled([deliveryQueue.close(), database.close(), redis.close()]);
        logger.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
