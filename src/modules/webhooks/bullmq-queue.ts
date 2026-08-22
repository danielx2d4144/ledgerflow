import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { DeliveryQueue } from './queue.js';

export const WEBHOOK_QUEUE_NAME = 'webhook-deliveries';

export interface DeliveryJobData {
  deliveryId: string;
}

/**
 * BullMQ-backed scheduler. Retries and the attempt budget are owned by
 * Postgres, not BullMQ (`attempts: 1`): the delivery row must stay the single
 * source of truth for operators, and BullMQ's own retry state is invisible to
 * the API. BullMQ is used purely for distribution and delayed re-execution.
 */
export interface BullDeliveryQueue extends DeliveryQueue {
  queue: Queue<DeliveryJobData>;
  close(): Promise<void>;
}

export function createBullDeliveryQueue(connection: ConnectionOptions): BullDeliveryQueue {
  const queue = new Queue<DeliveryJobData>(WEBHOOK_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 3_600, count: 5_000 },
      removeOnFail: { age: 86_400, count: 5_000 },
    },
  });

  return {
    queue,
    enqueue: async (deliveryId, delayMs = 0) => {
      await queue.add(
        'deliver',
        { deliveryId },
        {
          // Attempt-scoped job id: re-enqueueing the same delivery is
          // idempotent within an attempt, and the executor re-checks status in
          // the database before doing anything.
          jobId: `${deliveryId}:${Math.floor(delayMs)}:${Date.now() % 1_000}`,
          ...(delayMs > 0 ? { delay: delayMs } : {}),
        },
      );
    },
    close: async () => {
      await queue.close();
    },
  };
}

export function createDeliveryWorker(
  connection: ConnectionOptions,
  concurrency: number,
  handler: (deliveryId: string) => Promise<void>,
): Worker<DeliveryJobData> {
  return new Worker<DeliveryJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job: Job<DeliveryJobData>) => {
      await handler(job.data.deliveryId);
    },
    { connection, concurrency },
  );
}
