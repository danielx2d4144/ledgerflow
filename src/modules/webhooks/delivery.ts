import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.js';
import { outboxEvents, webhookDeliveries, webhookEndpoints } from '../../infra/schema.js';
import { decryptSecret } from './secret-crypto.js';
import {
  ATTEMPT_HEADER,
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signPayload,
} from './signature.js';
import { assertSafeResolution, assertSafeWebhookUrl, type UrlGuardOptions } from './url-guard.js';

export interface DeliveryConfig {
  secretKey: string;
  /** How long a claim is held before another worker may take the row (H5). */
  leaseMs: number;
  timeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  urlGuard: UrlGuardOptions;
}

export interface DeliveryDeps {
  db: Database;
  config: DeliveryConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Injectable for deterministic backoff in tests. */
  random?: () => number;
  /** Structured logging hook for failures that never reach the caller. */
  onError?: (error: unknown, message: string) => void;
}

export type DeliveryOutcome =
  | { result: 'skipped'; reason: string }
  | { result: 'succeeded'; deliveryId: string; attempt: number; status: number; durationMs: number }
  | {
      result: 'retry';
      deliveryId: string;
      attempt: number;
      delayMs: number;
      error: string;
      durationMs: number;
    }
  | { result: 'dead_letter'; deliveryId: string; attempt: number; error: string };

const SNIPPET_LIMIT = 512;

/**
 * Executes one delivery attempt and records the outcome.
 *
 * Delivery semantics are at-least-once: the HTTP request and the status write
 * cannot be atomic, so a crash between them replays the attempt. Every request
 * carries a stable event id for receiver-side deduplication.
 */
export async function executeDelivery(
  deps: DeliveryDeps,
  deliveryId: string,
): Promise<DeliveryOutcome> {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetchImpl ?? fetch;

  // Atomic claim (H5): exactly one worker can move a pending row to the next
  // attempt, and the claim carries a lease so a crashed worker's row is
  // recoverable. Every later write is conditional on this attempt number, so a
  // slow duplicate can never overwrite a newer outcome.
  const claimedAt = now();
  const [delivery] = await deps.db
    .update(webhookDeliveries)
    .set({
      attempt: sql`${webhookDeliveries.attempt} + 1`,
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + deps.config.leaseMs),
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.status, 'pending'),
        or(
          isNull(webhookDeliveries.leaseExpiresAt),
          lt(webhookDeliveries.leaseExpiresAt, claimedAt),
        ),
      ),
    )
    .returning();

  if (!delivery) {
    const existing = await deps.db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, deliveryId),
    });
    if (!existing) return { result: 'skipped', reason: 'delivery not found' };
    return {
      result: 'skipped',
      reason:
        existing.status === 'pending' ? 'delivery is leased' : `delivery is ${existing.status}`,
    };
  }

  const attempt = delivery.attempt;

  const [context] = await deps.db
    .select({ endpoint: webhookEndpoints, event: outboxEvents })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
    .innerJoin(outboxEvents, eq(webhookDeliveries.outboxEventId, outboxEvents.id))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);

  if (!context) {
    await releaseClaim(deps.db, delivery.id, attempt, now());
    return { result: 'skipped', reason: 'delivery context not found' };
  }
  const { endpoint, event } = context;

  if (endpoint.status !== 'active') {
    await markDeadLetter(deps.db, delivery.id, attempt, 'endpoint is disabled', now());
    return {
      result: 'dead_letter',
      deliveryId: delivery.id,
      attempt,
      error: 'endpoint is disabled',
    };
  }
  const body = JSON.stringify({
    id: event.id,
    type: event.eventType,
    organizationId: event.organizationId,
    createdAt: event.createdAt.toISOString(),
    data: event.payload,
  });

  // Re-validate the URL on every attempt: the stored value could predate a
  // policy change, and DNS answers change between attempts.
  let target: URL;
  try {
    target = assertSafeWebhookUrl(endpoint.url, deps.config.urlGuard);
    await assertSafeResolution(target, deps.config.urlGuard);
  } catch (error) {
    const message = errorMessage(error);
    await markDeadLetter(deps.db, delivery.id, attempt, `blocked: ${message}`, now());
    await bumpEndpointFailure(deps.db, endpoint.id, now());
    return { result: 'dead_letter', deliveryId: delivery.id, attempt, error: message };
  }

  const timestamp = Math.floor(now().getTime() / 1000);
  // A key mismatch between API and worker (M6) used to throw here, before any
  // status write: the job died and the delivery stayed `pending` forever. Now
  // it dead-letters with an operator-actionable message.
  let secret: string;
  try {
    secret = decryptSecret(endpoint.secretCiphertext, deps.config.secretKey);
  } catch (error) {
    const message =
      'endpoint secret could not be decrypted; WEBHOOK_SECRET_KEY does not match the key ' +
      'used to store it — rotate the endpoint secret or restore the original key';
    deps.onError?.(error, 'secret decryption failed');
    await markDeadLetter(deps.db, delivery.id, attempt, message, now());
    await bumpEndpointFailure(deps.db, endpoint.id, now());
    return { result: 'dead_letter', deliveryId: delivery.id, attempt, error: message };
  }
  const startedAt = Date.now();

  let status: number | null = null;
  let snippet: string | null = null;
  let failure: string | null = null;
  let retryable = true;

  try {
    const response = await doFetch(target.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'LedgerFlow-Webhooks/1',
        [EVENT_ID_HEADER]: event.id,
        [DELIVERY_ID_HEADER]: delivery.id,
        [ATTEMPT_HEADER]: String(attempt),
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
      },
      body,
      // Never follow redirects: a 302 into 169.254.169.254 is the classic
      // SSRF bypass, and the URL guard only vetted the original target.
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.config.timeoutMs),
    });
    status = response.status;
    snippet = (await safeText(response)).slice(0, SNIPPET_LIMIT);
    if (status < 200 || status >= 300) {
      const location = response.headers.get('location');
      failure =
        status >= 300 && status < 400
          ? `receiver returned a redirect (${status}${location ? ` to ${location}` : ''}); ` +
            'redirects are never followed — update the endpoint URL to the final target'
          : `receiver responded ${status}`;
      // 4xx (other than throttling/timeout) means the request itself is wrong;
      // retrying it just burns quota.
      retryable = status === 408 || status === 429 || status >= 500;
    }
  } catch (error) {
    failure = errorMessage(error);
  }

  const durationMs = Date.now() - startedAt;

  if (!failure) {
    await deps.db
      .update(webhookDeliveries)
      .set({
        status: 'succeeded',
        attempt,
        responseStatus: status,
        responseSnippet: snippet,
        error: null,
        durationMs,
        nextAttemptAt: null,
        deliveredAt: now(),
        updatedAt: now(),
        leaseExpiresAt: null,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.attempt, attempt)));
    await deps.db
      .update(webhookEndpoints)
      .set({ consecutiveFailures: 0, lastSuccessAt: now(), updatedAt: now() })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return {
      result: 'succeeded',
      deliveryId: delivery.id,
      attempt,
      status: status ?? 0,
      durationMs,
    };
  }

  await bumpEndpointFailure(deps.db, endpoint.id, now());
  const exhausted = attempt >= delivery.maxAttempts || !retryable;

  if (exhausted) {
    await deps.db
      .update(webhookDeliveries)
      .set({
        status: 'dead_letter',
        attempt,
        responseStatus: status,
        responseSnippet: snippet,
        error: failure,
        durationMs,
        nextAttemptAt: null,
        updatedAt: now(),
        leaseExpiresAt: null,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.attempt, attempt)));
    return { result: 'dead_letter', deliveryId: delivery.id, attempt, error: failure };
  }

  const delayMs = backoffDelayMs(attempt, deps.config, deps.random ?? Math.random);
  await deps.db
    .update(webhookDeliveries)
    .set({
      status: 'pending',
      attempt,
      responseStatus: status,
      responseSnippet: snippet,
      error: failure,
      durationMs,
      nextAttemptAt: new Date(now().getTime() + delayMs),
      updatedAt: now(),
      leaseExpiresAt: null,
    })
    .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.attempt, attempt)));

  return { result: 'retry', deliveryId: delivery.id, attempt, delayMs, error: failure, durationMs };
}

/** Exponential backoff with full jitter, capped. Attempt is 1-based. */
export function backoffDelayMs(
  attempt: number,
  config: Pick<DeliveryConfig, 'backoffBaseMs' | 'backoffMaxMs'>,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(config.backoffBaseMs * 2 ** (attempt - 1), config.backoffMaxMs);
  // Full jitter, floored at half the window so a hot loop cannot degenerate.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/** Gives a claimed row back untouched (attempt stays spent, lease cleared). */
async function releaseClaim(
  db: Database,
  deliveryId: string,
  attempt: number,
  now: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.attempt, attempt)));
}

async function markDeadLetter(
  db: Database,
  deliveryId: string,
  attempt: number,
  error: string,
  now: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'dead_letter',
      attempt,
      error,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.status, 'pending'),
        eq(webhookDeliveries.attempt, attempt),
      ),
    );
}

async function bumpEndpointFailure(db: Database, endpointId: string, now: Date): Promise<void> {
  await db
    .update(webhookEndpoints)
    .set({
      consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
      lastFailureAt: now,
      updatedAt: now,
    })
    .where(eq(webhookEndpoints.id, endpointId));
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}
