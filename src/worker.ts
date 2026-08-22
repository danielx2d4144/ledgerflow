import { loadEnv, type Env } from './config/env.js';
import { createDatabase } from './infra/db.js';
import { createLogger } from './infra/logger.js';
import {
  dispatchOutboxBatch,
  reapExpiredIdempotencyKeys,
  reclaimExpiredLeases,
  requeueDueDeliveries,
} from './modules/outbox/dispatcher.js';
import { createBullDeliveryQueue, createDeliveryWorker } from './modules/webhooks/bullmq-queue.js';
import { executeDelivery, type DeliveryConfig } from './modules/webhooks/delivery.js';

export function deliveryConfigFromEnv(env: Env): DeliveryConfig {
  return {
    secretKey: env.WEBHOOK_SECRET_KEY,
    leaseMs: env.WEBHOOK_LEASE_MS,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
    backoffBaseMs: env.WEBHOOK_BACKOFF_BASE_MS,
    backoffMaxMs: env.WEBHOOK_BACKOFF_MAX_MS,
    urlGuard: {
      allowPrivateTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
      allowInsecureHttp: env.WEBHOOK_ALLOW_INSECURE_HTTP,
    },
  };
}

/**
 * Webhook worker process: polls the outbox, fans out deliveries and executes
 * queued attempts. Runs separately from the API so a slow receiver can never
 * consume request-path resources.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env).child({ component: 'webhook-worker' });
  const database = createDatabase(env);
  // BullMQ requires blocking connections with retries disabled.
  const queue = createBullDeliveryQueue({
    url: env.REDIS_URL,
    maxRetriesPerRequest: null,
  });
  const config = deliveryConfigFromEnv(env);

  const worker = createDeliveryWorker(
    { url: env.REDIS_URL, maxRetriesPerRequest: null },
    env.WEBHOOK_CONCURRENCY,
    async (deliveryId) => {
      const outcome = await executeDelivery(
        {
          db: database.db,
          config,
          onError: (error, message) => {
            logger.error({ err: error, deliveryId }, message);
          },
        },
        deliveryId,
      );
      if (outcome.result === 'retry') {
        await queue.enqueue(outcome.deliveryId, outcome.delayMs);
      }
      logger.info({ ...outcome }, 'webhook delivery attempt');
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id }, 'delivery job failed');
  });

  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      try {
        const stats = await dispatchOutboxBatch({
          db: database.db,
          queue,
          batchSize: env.OUTBOX_BATCH_SIZE,
          maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
        });
        if (stats.claimedEvents > 0) logger.info(stats, 'outbox batch dispatched');
      } catch (error) {
        logger.error({ err: error }, 'outbox dispatch failed');
      }
      await sleep(env.OUTBOX_POLL_INTERVAL_MS);
    }
  };

  const sweep = async () => {
    while (!stopped) {
      await sleep(30_000);
      try {
        const requeued = await requeueDueDeliveries({
          db: database.db,
          queue,
          batchSize: env.OUTBOX_BATCH_SIZE,
          maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
        });
        if (requeued > 0) logger.warn({ requeued }, 'requeued deliveries missing from the queue');
        const reclaimed = await reclaimExpiredLeases({
          db: database.db,
          batchSize: env.OUTBOX_BATCH_SIZE,
        });
        if (reclaimed > 0) logger.warn({ reclaimed }, 'reclaimed expired delivery leases');
      } catch (error) {
        logger.error({ err: error }, 'delivery sweep failed');
      }
    }
  };

  // M2: the idempotency table is on the write hot path and nothing deleted it.
  const reap = async () => {
    if (env.IDEMPOTENCY_REAP_INTERVAL_MS === 0) return;
    while (!stopped) {
      await sleep(env.IDEMPOTENCY_REAP_INTERVAL_MS);
      try {
        const deleted = await reapExpiredIdempotencyKeys({
          db: database.db,
          batchSize: env.IDEMPOTENCY_REAP_BATCH_SIZE,
        });
        if (deleted > 0) logger.info({ deleted }, 'reaped expired idempotency keys');
      } catch (error) {
        logger.error({ err: error }, 'idempotency reaper failed');
      }
    }
  };

  const shutdown = (signal: string) => {
    void (async () => {
      if (stopped) return;
      stopped = true;
      logger.info({ signal }, 'worker shutting down');
      const timer = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      await worker.close();
      await queue.close();
      await database.close();
      process.exit(0);
    })();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  logger.info({ concurrency: env.WEBHOOK_CONCURRENCY }, 'webhook worker started');
  await Promise.all([poll(), sweep(), reap()]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
