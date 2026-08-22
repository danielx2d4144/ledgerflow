import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.js';
import {
  idempotencyKeys,
  outboxEvents,
  webhookDeliveries,
  webhookEndpoints,
} from '../../infra/schema.js';
import type { DeliveryQueue } from '../webhooks/queue.js';

export interface DispatcherOptions {
  db: Database;
  queue: DeliveryQueue;
  batchSize: number;
  maxAttempts: number;
  now?: () => Date;
}

export interface DispatchStats {
  claimedEvents: number;
  createdDeliveries: number;
  requeuedDeliveries: number;
}

/**
 * Moves committed outbox rows into per-endpoint deliveries and enqueues them.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so any number of workers can poll the
 * same table without coordination; the fan-out insert and the status flip share
 * the claim's transaction, and the unique `(endpoint, event)` index means a
 * crash mid-dispatch can only ever re-create the same rows.
 */
export async function dispatchOutboxBatch(options: DispatcherOptions): Promise<DispatchStats> {
  const now = options.now ?? (() => new Date());
  const stats: DispatchStats = { claimedEvents: 0, createdDeliveries: 0, requeuedDeliveries: 0 };

  const deliveryIds = await options.db.transaction(async (tx) => {
    const claimed = await tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.availableAt, now())))
      .orderBy(outboxEvents.createdAt)
      .limit(options.batchSize)
      .for('update', { skipLocked: true });

    if (claimed.length === 0) return [];
    stats.claimedEvents = claimed.length;

    const organizationIds = [...new Set(claimed.map((event) => event.organizationId))];
    const endpoints = await tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          inArray(webhookEndpoints.organizationId, organizationIds),
          eq(webhookEndpoints.status, 'active'),
        ),
      );

    const rows = claimed.flatMap((event) =>
      endpoints
        .filter(
          (endpoint) =>
            endpoint.organizationId === event.organizationId &&
            (endpoint.eventTypes.length === 0 || endpoint.eventTypes.includes(event.eventType)),
        )
        .map((endpoint) => ({
          organizationId: event.organizationId,
          endpointId: endpoint.id,
          outboxEventId: event.id,
          eventType: event.eventType,
          maxAttempts: options.maxAttempts,
          nextAttemptAt: now(),
        })),
    );

    const inserted =
      rows.length > 0
        ? await tx
            .insert(webhookDeliveries)
            .values(rows)
            .onConflictDoNothing({
              target: [webhookDeliveries.endpointId, webhookDeliveries.outboxEventId],
            })
            .returning({ id: webhookDeliveries.id })
        : [];

    await tx
      .update(outboxEvents)
      .set({
        status: 'dispatched',
        dispatchedAt: now(),
        attempts: sql`${outboxEvents.attempts} + 1`,
      })
      .where(
        inArray(
          outboxEvents.id,
          claimed.map((event) => event.id),
        ),
      );

    return inserted.map((delivery) => delivery.id);
  });

  stats.createdDeliveries = deliveryIds.length;
  for (const id of deliveryIds) {
    await options.queue.enqueue(id);
  }
  return stats;
}

/**
 * Safety net for deliveries whose Redis job was lost (Redis restart, flush, or
 * a worker killed between claiming and rescheduling). Postgres remains the
 * source of truth; the queue is only a scheduler.
 */
export async function requeueDueDeliveries(options: DispatcherOptions): Promise<number> {
  const now = options.now ?? (() => new Date());
  const due = await options.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, 'pending'),
        or(lte(webhookDeliveries.nextAttemptAt, now()), isNull(webhookDeliveries.nextAttemptAt)),
        // Never re-enqueue a row another worker currently holds (H5).
        or(isNull(webhookDeliveries.leaseExpiresAt), lt(webhookDeliveries.leaseExpiresAt, now())),
      ),
    )
    .limit(options.batchSize);

  for (const delivery of due) {
    await options.queue.enqueue(delivery.id);
  }
  return due.length;
}

/**
 * Returns rows whose worker died mid-attempt: the claim is still recorded but
 * the lease has expired, so nothing will ever write an outcome for it (H5).
 * Clearing the lease makes the row claimable again on the next sweep.
 */
export async function reclaimExpiredLeases(options: {
  db: Database;
  batchSize: number;
  now?: () => Date;
}): Promise<number> {
  const now = options.now ?? (() => new Date());
  const stale = await options.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.leaseExpiresAt, now())),
    )
    .limit(options.batchSize);
  if (stale.length === 0) return 0;

  await options.db
    .update(webhookDeliveries)
    .set({ leaseExpiresAt: null, updatedAt: now() })
    .where(
      and(
        inArray(
          webhookDeliveries.id,
          stale.map((row) => row.id),
        ),
        eq(webhookDeliveries.status, 'pending'),
        lt(webhookDeliveries.leaseExpiresAt, now()),
      ),
    );
  return stale.length;
}

/**
 * Deletes expired idempotency records in bounded batches (M2). The table is
 * written on every keyed POST /v1/transactions and nothing else removes rows.
 */
export async function reapExpiredIdempotencyKeys(options: {
  db: Database;
  batchSize: number;
  now?: () => Date;
}): Promise<number> {
  const now = options.now ?? (() => new Date());
  const expired = await options.db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, now()))
    .limit(options.batchSize);
  if (expired.length === 0) return 0;

  await options.db.delete(idempotencyKeys).where(
    and(
      inArray(
        idempotencyKeys.id,
        expired.map((row) => row.id),
      ),
      lt(idempotencyKeys.expiresAt, now()),
    ),
  );
  return expired.length;
}
