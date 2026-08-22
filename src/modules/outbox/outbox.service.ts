import type { Executor } from '../../infra/executor.js';
import { outboxEvents } from '../../infra/schema.js';

export interface OutboxEventInput {
  organizationId: string;
  /** Dotted event name published to subscribers, e.g. `transaction.created`. */
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/**
 * Writes an outbox row. Callers MUST pass the same transaction that performs
 * the state change: that is the whole point of the pattern — the event commits
 * with the change or not at all. Dispatch happens later, in the worker.
 */
export async function enqueueOutboxEvent(
  executor: Executor,
  input: OutboxEventInput,
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(outboxEvents)
    .values({
      organizationId: input.organizationId,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
    })
    .returning({ id: outboxEvents.id });
  if (!row) throw new Error('failed to enqueue outbox event');
  return row;
}
