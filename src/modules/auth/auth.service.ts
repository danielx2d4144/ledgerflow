import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../infra/db.js';
import { apiKeys, organizations } from '../../infra/schema.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import {
  generateApiKey,
  keyTagFor,
  parseApiKey,
  hashSecret,
  redactedKey,
  secretMatches,
} from './api-key.js';
import type { AuthCache } from './auth.cache.js';
import { type CachedPrincipal } from './auth.cache.js';
import type { Role } from './roles.js';
import { recordAuditEvent, type AuditActor } from '../audit/audit.service.js';
import { enqueueOutboxEvent } from '../outbox/outbox.service.js';

export interface KeyAuditContext {
  actor: AuditActor;
  requestId?: string | null | undefined;
  ip?: string | null | undefined;
}

const SYSTEM_CONTEXT: KeyAuditContext = { actor: { type: 'system' } };

export interface Principal {
  apiKeyId: string;
  organizationId: string;
  role: Role;
  prefix: string;
  /** True when the principal was served from the auth cache. */
  cached: boolean;
}

export type VerifyFailure =
  'malformed' | 'wrong_environment' | 'unknown_key' | 'revoked' | 'expired';

export type VerifyResult =
  { ok: true; principal: Principal } | { ok: false; reason: VerifyFailure };

export interface ApiKeySummary {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  role: Role;
  redactedKey: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AuthServiceOptions {
  db: Database;
  pepper: string;
  nodeEnv: string;
  cache: AuthCache;
  now?: () => Date;
}

export class AuthService {
  private readonly db: Database;
  private readonly pepper: string;
  private readonly tag: 'live' | 'test';
  private readonly cache: AuthCache;
  private readonly now: () => Date;

  constructor(options: AuthServiceOptions) {
    this.db = options.db;
    this.pepper = options.pepper;
    this.tag = keyTagFor(options.nodeEnv);
    this.cache = options.cache;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Verifies a presented token. Failure reasons are for logs and metrics only —
   * the HTTP layer collapses them all into one opaque 401 so a caller cannot
   * distinguish "unknown key" from "revoked key".
   */
  async verify(token: string): Promise<VerifyResult> {
    const parsed = parseApiKey(token);
    if (!parsed) return { ok: false, reason: 'malformed' };
    if (parsed.tag !== this.tag) return { ok: false, reason: 'wrong_environment' };

    const cached = await this.cache.get(token);
    if (cached) {
      return {
        ok: true,
        principal: {
          apiKeyId: cached.apiKeyId,
          organizationId: cached.organizationId,
          role: cached.role,
          prefix: cached.prefix,
          cached: true,
        },
      };
    }

    const record = await this.db.query.apiKeys.findFirst({
      where: eq(apiKeys.prefix, parsed.prefix),
    });
    if (!record) return { ok: false, reason: 'unknown_key' };
    // Compare before any status check so timing does not reveal key state.
    const matches = secretMatches(parsed.secret, this.pepper, record.secretHash);
    if (!matches) return { ok: false, reason: 'unknown_key' };
    if (record.revokedAt) return { ok: false, reason: 'revoked' };
    if (record.expiresAt && record.expiresAt.getTime() <= this.now().getTime()) {
      return { ok: false, reason: 'expired' };
    }

    const principal: CachedPrincipal = {
      apiKeyId: record.id,
      organizationId: record.organizationId,
      role: record.role,
      prefix: record.prefix,
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };
    await this.cache.set(token, principal);
    // Best-effort last-use tracking; throttled to cache misses so a hot key does
    // not turn every request into a write.
    void this.touch(record.id);

    return {
      ok: true,
      principal: {
        apiKeyId: principal.apiKeyId,
        organizationId: principal.organizationId,
        role: principal.role,
        prefix: principal.prefix,
        cached: false,
      },
    };
  }

  private async touch(apiKeyId: string): Promise<void> {
    try {
      await this.db.update(apiKeys).set({ lastUsedAt: this.now() }).where(eq(apiKeys.id, apiKeyId));
    } catch {
      // Never fail a request because usage telemetry could not be written.
    }
  }

  async createOrganization(input: { name: string; slug: string }) {
    const [organization] = await this.db
      .insert(organizations)
      .values(input)
      .onConflictDoNothing({ target: organizations.slug })
      .returning();
    if (!organization) {
      throw new ConflictError(`organization slug '${input.slug}' already exists`);
    }
    return organization;
  }

  /** Issues a key and returns the plaintext token exactly once. */
  async issueKey(input: {
    organizationId: string;
    name: string;
    role: Role;
    expiresAt?: Date | null;
    context?: KeyAuditContext;
  }): Promise<{ apiKey: ApiKeySummary; token: string }> {
    const context = input.context ?? SYSTEM_CONTEXT;
    const organization = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, input.organizationId),
    });
    if (!organization) throw new NotFoundError('organization', input.organizationId);

    const generated = generateApiKey(this.tag);
    // Key material, its audit record and the lifecycle event commit together.
    const record = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          role: input.role,
          prefix: generated.prefix,
          secretHash: hashSecret(generated.secret, this.pepper),
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) throw new Error('failed to insert api key');

      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: context.actor,
        action: 'api_key.issued',
        resourceType: 'api_key',
        resourceId: row.id,
        requestId: context.requestId,
        ip: context.ip,
        // Prefix only: the secret is never written anywhere but the hash.
        metadata: { role: row.role, prefix: row.prefix, name: row.name },
      });
      await enqueueOutboxEvent(tx, {
        organizationId: input.organizationId,
        eventType: 'api_key.issued',
        aggregateType: 'api_key',
        aggregateId: row.id,
        payload: {
          id: row.id,
          name: row.name,
          role: row.role,
          prefix: row.prefix,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        },
      });
      return row;
    });

    return { apiKey: this.toSummary(record), token: generated.token };
  }

  async listKeys(organizationId: string): Promise<ApiKeySummary[]> {
    const rows = await this.db.query.apiKeys.findMany({
      where: eq(apiKeys.organizationId, organizationId),
      orderBy: [desc(apiKeys.createdAt)],
    });
    return rows.map((row) => this.toSummary(row));
  }

  /**
   * Revokes a key within the caller's organization. Scoping the update by
   * organization is what stops an admin of tenant A revoking tenant B's keys;
   * a miss is reported as 404 so key ids of other tenants are not confirmed.
   */
  async revokeKey(
    organizationId: string,
    apiKeyId: string,
    reason?: string,
    context: KeyAuditContext = SYSTEM_CONTEXT,
  ): Promise<ApiKeySummary> {
    const revoked = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(apiKeys)
        .set({ revokedAt: this.now(), revokedReason: reason ?? null })
        .where(
          and(
            eq(apiKeys.id, apiKeyId),
            eq(apiKeys.organizationId, organizationId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning();
      if (!row) return null;

      await recordAuditEvent(tx, {
        organizationId,
        actor: context.actor,
        action: 'api_key.revoked',
        resourceType: 'api_key',
        resourceId: row.id,
        requestId: context.requestId,
        ip: context.ip,
        metadata: { reason: reason ?? null, prefix: row.prefix },
      });
      await enqueueOutboxEvent(tx, {
        organizationId,
        eventType: 'api_key.revoked',
        aggregateType: 'api_key',
        aggregateId: row.id,
        payload: {
          id: row.id,
          prefix: row.prefix,
          role: row.role,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          reason: reason ?? null,
        },
      });
      return row;
    });

    if (!revoked) {
      const existing = await this.db.query.apiKeys.findFirst({
        where: and(eq(apiKeys.id, apiKeyId), eq(apiKeys.organizationId, organizationId)),
      });
      if (!existing) throw new NotFoundError('api key', apiKeyId);
      await this.cache.revoke(existing.id);
      return this.toSummary(existing);
    }

    await this.cache.revoke(revoked.id);
    return this.toSummary(revoked);
  }

  private toSummary(record: typeof apiKeys.$inferSelect): ApiKeySummary {
    return {
      id: record.id,
      organizationId: record.organizationId,
      name: record.name,
      prefix: record.prefix,
      role: record.role,
      redactedKey: redactedKey(this.tag, record.prefix),
      createdAt: record.createdAt.toISOString(),
      lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      revokedAt: record.revokedAt?.toISOString() ?? null,
    };
  }
}
