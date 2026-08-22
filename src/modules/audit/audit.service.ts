import type { Executor } from '../../infra/executor.js';
import { auditEvents } from '../../infra/schema.js';

export interface AuditActor {
  type: 'api_key' | 'system';
  id?: string | null | undefined;
}

export interface AuditEventInput {
  organizationId: string;
  actor: AuditActor;
  /** Dotted, past-tense verb: `webhook_endpoint.created`. */
  action: string;
  resourceType: string;
  resourceId?: string | null | undefined;
  requestId?: string | null | undefined;
  ip?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Appends an audit row. Pass the surrounding transaction when the audited
 * change is transactional so the record shares its fate; the table itself is
 * append-only (a trigger rejects UPDATE and DELETE).
 *
 * Never put secrets in `metadata`: audit rows cannot be edited afterwards.
 */
export async function recordAuditEvent(
  executor: Executor,
  input: AuditEventInput,
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(auditEvents)
    .values({
      organizationId: input.organizationId,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: auditEvents.id });
  if (!row) throw new Error('failed to append audit event');
  return row;
}
