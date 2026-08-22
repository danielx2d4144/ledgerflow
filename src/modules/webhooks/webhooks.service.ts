import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../infra/db.js';
import { outboxEvents, webhookDeliveries, webhookEndpoints } from '../../infra/schema.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import { recordAuditEvent, type AuditActor } from '../audit/audit.service.js';
import type { DeliveryQueue } from './queue.js';
import { encryptSecret, generateWebhookSecret } from './secret-crypto.js';
import { assertSafeWebhookUrl, type UrlGuardOptions } from './url-guard.js';
import type {
  CreateEndpointBody,
  DeliveryResponse,
  EndpointResponse,
  UpdateEndpointBody,
} from './webhooks.schemas.js';

export interface AuditContext {
  actor: AuditActor;
  requestId?: string | null | undefined;
  ip?: string | null | undefined;
}

export interface WebhookServiceOptions {
  db: Database;
  secretKey: string;
  maxAttempts: number;
  urlGuard: UrlGuardOptions;
  queue: DeliveryQueue;
  now?: () => Date;
}

type EndpointRow = typeof webhookEndpoints.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/**
 * Endpoint administration and replay controls. Every query is filtered by
 * `organizationId` taken from the authenticated principal, and misses are 404
 * rather than 403 so ids of other tenants are not confirmed.
 */
export class WebhookService {
  private readonly db: Database;
  private readonly options: WebhookServiceOptions;
  private readonly now: () => Date;

  constructor(options: WebhookServiceOptions) {
    this.db = options.db;
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async createEndpoint(
    organizationId: string,
    input: CreateEndpointBody,
    context: AuditContext,
  ): Promise<{ endpoint: EndpointResponse; secret: string }> {
    const url = assertSafeWebhookUrl(input.url, this.options.urlGuard);
    const secret = generateWebhookSecret();

    const endpoint = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(webhookEndpoints)
        .values({
          organizationId,
          url: url.toString(),
          description: input.description ?? null,
          eventTypes: input.eventTypes,
          secretCiphertext: encryptSecret(secret, this.options.secretKey),
          secretLastFour: secret.slice(-4),
        })
        .returning();
      if (!row) throw new Error('failed to insert webhook endpoint');

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'webhook_endpoint.created',
        resourceType: 'webhook_endpoint',
        resourceId: row.id,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { url: row.url, eventTypes: row.eventTypes },
      });
      return row;
    });

    return { endpoint: toEndpointResponse(endpoint), secret };
  }

  async listEndpoints(organizationId: string): Promise<EndpointResponse[]> {
    const rows = await this.db.query.webhookEndpoints.findMany({
      where: eq(webhookEndpoints.organizationId, organizationId),
      orderBy: [desc(webhookEndpoints.createdAt)],
    });
    return rows.map(toEndpointResponse);
  }

  async getEndpoint(organizationId: string, endpointId: string): Promise<EndpointResponse> {
    return toEndpointResponse(await this.requireEndpoint(organizationId, endpointId));
  }

  async updateEndpoint(
    organizationId: string,
    endpointId: string,
    input: UpdateEndpointBody,
    context: AuditContext,
  ): Promise<EndpointResponse> {
    await this.requireEndpoint(organizationId, endpointId);
    const url = input.url ? assertSafeWebhookUrl(input.url, this.options.urlGuard) : undefined;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(webhookEndpoints)
        .set({
          ...(url ? { url: url.toString() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
          ...(input.status
            ? {
                status: input.status,
                disabledReason: input.status === 'disabled' ? 'disabled by operator' : null,
                ...(input.status === 'active' ? { consecutiveFailures: 0 } : {}),
              }
            : {}),
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(webhookEndpoints.id, endpointId),
            eq(webhookEndpoints.organizationId, organizationId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundError('webhook endpoint', endpointId);

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'webhook_endpoint.updated',
        resourceType: 'webhook_endpoint',
        resourceId: endpointId,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { changed: Object.keys(input) },
      });
      return toEndpointResponse(row);
    });
  }

  async rotateSecret(
    organizationId: string,
    endpointId: string,
    context: AuditContext,
  ): Promise<{ endpoint: EndpointResponse; secret: string }> {
    await this.requireEndpoint(organizationId, endpointId);
    const secret = generateWebhookSecret();

    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookEndpoints)
        .set({
          secretCiphertext: encryptSecret(secret, this.options.secretKey),
          secretLastFour: secret.slice(-4),
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(webhookEndpoints.id, endpointId),
            eq(webhookEndpoints.organizationId, organizationId),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundError('webhook endpoint', endpointId);

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'webhook_endpoint.secret_rotated',
        resourceType: 'webhook_endpoint',
        resourceId: endpointId,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { secretLastFour: updated.secretLastFour },
      });
      return updated;
    });

    return { endpoint: toEndpointResponse(row), secret };
  }

  async deleteEndpoint(
    organizationId: string,
    endpointId: string,
    context: AuditContext,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, endpointId),
            eq(webhookEndpoints.organizationId, organizationId),
          ),
        )
        .returning({ id: webhookEndpoints.id, url: webhookEndpoints.url });
      if (!deleted) throw new NotFoundError('webhook endpoint', endpointId);

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'webhook_endpoint.deleted',
        resourceType: 'webhook_endpoint',
        resourceId: endpointId,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { url: deleted.url },
      });
    });
  }

  async listDeliveries(
    organizationId: string,
    filters: {
      endpointId?: string;
      status?: DeliveryRow['status'];
      limit: number;
      cursor?: string;
    },
  ): Promise<{ data: DeliveryResponse[]; nextCursor: string | null }> {
    const conditions: SQL[] = [eq(webhookDeliveries.organizationId, organizationId)];
    if (filters.endpointId) conditions.push(eq(webhookDeliveries.endpointId, filters.endpointId));
    if (filters.status) conditions.push(eq(webhookDeliveries.status, filters.status));
    if (filters.cursor) {
      conditions.push(lt(webhookDeliveries.createdAt, new Date(filters.cursor)));
    }

    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(filters.limit + 1);

    const page = rows.slice(0, filters.limit);
    const last = page.at(-1);
    return {
      data: page.map(toDeliveryResponse),
      nextCursor: rows.length > filters.limit && last ? last.createdAt.toISOString() : null,
    };
  }

  async getDelivery(organizationId: string, deliveryId: string): Promise<DeliveryResponse> {
    return toDeliveryResponse(await this.requireDelivery(organizationId, deliveryId));
  }

  /**
   * Replays a single delivery. Attempts are *extended*, not reset, so the
   * attempt counter stays an honest record of how many requests the receiver
   * has seen; duplicates carry the same event id and are the receiver's job to
   * deduplicate.
   */
  async replayDelivery(
    organizationId: string,
    deliveryId: string,
    context: AuditContext,
  ): Promise<DeliveryResponse> {
    const existing = await this.requireDelivery(organizationId, deliveryId);
    if (existing.status === 'pending') {
      throw new ConflictError('delivery is already pending');
    }

    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'pending',
          maxAttempts: existing.attempt + this.options.maxAttempts,
          nextAttemptAt: this.now(),
          error: null,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(webhookDeliveries.id, deliveryId),
            eq(webhookDeliveries.organizationId, organizationId),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundError('webhook delivery', deliveryId);

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'webhook_delivery.replayed',
        resourceType: 'webhook_delivery',
        resourceId: deliveryId,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { previousStatus: existing.status, attempt: existing.attempt },
      });
      return updated;
    });

    await this.options.queue.enqueue(row.id);
    return toDeliveryResponse(row);
  }

  /**
   * Re-runs fan-out for an event: every currently-active endpoint that matches
   * gets a delivery. Endpoints that already have one keep it (the unique index
   * makes the re-dispatch idempotent), so this is safe to call repeatedly.
   */
  async replayEvent(
    organizationId: string,
    eventId: string,
    context: AuditContext,
  ): Promise<{ eventId: string; status: string }> {
    const event = await this.db.query.outboxEvents.findFirst({
      where: and(eq(outboxEvents.id, eventId), eq(outboxEvents.organizationId, organizationId)),
    });
    if (!event) throw new NotFoundError('event', eventId);

    const replayedDeliveryIds = await this.db.transaction(async (tx) => {
      await tx
        .update(outboxEvents)
        .set({ status: 'pending', availableAt: this.now(), lastError: null })
        .where(and(eq(outboxEvents.id, eventId), eq(outboxEvents.organizationId, organizationId)));

      const replayedDeliveries = await tx
        .update(webhookDeliveries)
        .set({
          status: 'pending',
          maxAttempts: sql`${webhookDeliveries.maxAttempts} + ${this.options.maxAttempts}`,
          nextAttemptAt: this.now(),
          error: null,
          leaseExpiresAt: null,
          claimedAt: null,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(webhookDeliveries.organizationId, organizationId),
            eq(webhookDeliveries.outboxEventId, eventId),
            eq(webhookDeliveries.status, 'dead_letter'),
          ),
        )
        .returning({ id: webhookDeliveries.id });

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'outbox_event.replayed',
        resourceType: 'outbox_event',
        resourceId: eventId,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { eventType: event.eventType, previousStatus: event.status },
      });

      return replayedDeliveries.map((delivery) => delivery.id);
    });

    for (const deliveryId of replayedDeliveryIds) {
      await this.options.queue.enqueue(deliveryId);
    }

    return { eventId, status: 'pending' };
  }

  private async requireEndpoint(organizationId: string, endpointId: string): Promise<EndpointRow> {
    const row = await this.db.query.webhookEndpoints.findFirst({
      where: and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.organizationId, organizationId),
      ),
    });
    if (!row) throw new NotFoundError('webhook endpoint', endpointId);
    return row;
  }

  private async requireDelivery(organizationId: string, deliveryId: string): Promise<DeliveryRow> {
    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('webhook delivery', deliveryId);
    return row;
  }
}

export function toEndpointResponse(row: EndpointRow): EndpointResponse {
  return {
    id: row.id,
    organizationId: row.organizationId,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes,
    status: row.status,
    disabledReason: row.disabledReason,
    secretLastFour: row.secretLastFour,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDeliveryResponse(row: DeliveryRow): DeliveryResponse {
  return {
    id: row.id,
    organizationId: row.organizationId,
    endpointId: row.endpointId,
    eventId: row.outboxEventId,
    eventType: row.eventType,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    responseStatus: row.responseStatus,
    responseSnippet: row.responseSnippet,
    error: row.error,
    durationMs: row.durationMs,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
