import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents } from '../src/infra/schema.js';
import { recordAuditEvent } from '../src/modules/audit/audit.service.js';
import { createTestContext, type TestContext } from './helpers.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});
afterAll(async () => {
  await context.close();
});

/**
 * Isolated in its own file on purpose: the trigger aborts the statement, and
 * the single-connection PGlite test server can drop the pooled client with it,
 * which would otherwise leak failures into unrelated tests.
 */
describe('audit_events is append-only', () => {
  it('rejects updates and deletes at the database level', async () => {
    // Let any fire-and-forget `last_used_at` write drain first: PGlite serves a
    // single connection, so an overlapping background query looks like a
    // dropped connection rather than the trigger error we are asserting on.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const row = await recordAuditEvent(context.database.db, {
      organizationId: context.organizationId,
      actor: { type: 'system' },
      action: 'test.probe',
      resourceType: 'test',
    });

    await expectRejectedByTrigger(() =>
      context.database.db
        .update(auditEvents)
        .set({ action: 'tampered' })
        .where(eq(auditEvents.id, row.id)),
    );

    await expectRejectedByTrigger(() =>
      context.database.db.delete(auditEvents).where(eq(auditEvents.id, row.id)),
    );

    // The row is still there, unchanged.
    const [after] = await retryOnDroppedConnection(() =>
      context.database.db.select().from(auditEvents).where(eq(auditEvents.id, row.id)),
    );
    expect(after?.action).toBe('test.probe');
  });
});

/**
 * Asserts the statement is refused by the append-only trigger.
 *
 * drizzle wraps driver errors, so the trigger text lives on `cause`. PGlite
 * occasionally tears the pooled connection down instead of returning the error;
 * that is a test-server artefact, so those attempts are retried rather than
 * reported as a missing guard.
 */
async function expectRejectedByTrigger(run: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await run();
    } catch (error) {
      const message = messageOf(error);
      if (/append-only/i.test(message)) return;
      if (/connection terminated|connection ended|ECONNRESET/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw new Error(`unexpected error: ${message}`);
    }
    throw new Error('statement was not rejected by the append-only trigger');
  }
  throw new Error('append-only assertion never observed a usable connection');
}

/**
 * PGlite drops the pooled connection when a trigger aborts the statement; the
 * pool replaces the client on the next call, so one retry is enough.
 */
async function retryOnDroppedConnection<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!/connection terminated|connection ended|ECONNRESET/i.test(messageOf(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('database connection never recovered');
}

function messageOf(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return [error, cause].map((value) => (value instanceof Error ? value.message : '')).join(' | ');
}
