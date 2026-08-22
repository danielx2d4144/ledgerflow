import { createHash } from 'node:crypto';
import type { Role } from './roles.js';

/** The slice of an ioredis client this cache needs. Keeps tests dependency-free. */
export interface AuthCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface CachedPrincipal {
  apiKeyId: string;
  organizationId: string;
  role: Role;
  prefix: string;
  /** Key expiry (ISO) carried in the entry so a cache hit cannot outlive it. */
  expiresAt?: string | null;
}

const PRINCIPAL_PREFIX = 'auth:key:';
const REVOKED_PREFIX = 'auth:revoked:';

/**
 * Redis is used only where a stale answer is bounded and safe:
 *
 *  - only *successful* verifications are cached, so a failing key can never be
 *    promoted by cache poisoning and negative lookups always hit Postgres;
 *  - the cache stores no secret material, only the key id, org and role, under a
 *    SHA-256 of the presented token (the token itself never reaches Redis);
 *  - revocation writes a tombstone that is checked on every cache hit and lives
 *    longer than the entry TTL, so revoking is effective immediately rather than
 *    "within one TTL";
 *  - every Redis error degrades to a direct database verification.
 */
export class AuthCache {
  constructor(
    private readonly client: AuthCacheClient | null,
    private readonly ttlSeconds: number,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  get enabled(): boolean {
    return this.client !== null && this.ttlSeconds > 0;
  }

  private static tokenKey(token: string): string {
    return PRINCIPAL_PREFIX + createHash('sha256').update(token).digest('hex');
  }

  async get(token: string): Promise<CachedPrincipal | null> {
    if (!this.client || !this.enabled) return null;
    try {
      const raw = await this.client.get(AuthCache.tokenKey(token));
      if (!raw) return null;
      const principal = JSON.parse(raw) as CachedPrincipal;
      const tombstone = await this.client.get(REVOKED_PREFIX + principal.apiKeyId);
      if (tombstone) {
        await this.client.del(AuthCache.tokenKey(token));
        return null;
      }
      // A key can expire inside the cache TTL; expiry is re-checked on read so a
      // cached entry never keeps an expired key alive.
      if (principal.expiresAt && Date.parse(principal.expiresAt) <= Date.now()) {
        await this.client.del(AuthCache.tokenKey(token));
        return null;
      }
      return principal;
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  async set(token: string, principal: CachedPrincipal): Promise<void> {
    if (!this.client || !this.enabled) return;
    try {
      await this.client.set(
        AuthCache.tokenKey(token),
        JSON.stringify(principal),
        'EX',
        this.ttlSeconds,
      );
    } catch (error) {
      this.onError(error);
    }
  }

  /** Tombstone lives well past the entry TTL so no cached copy can outlive it. */
  async revoke(apiKeyId: string): Promise<void> {
    if (!this.client || !this.enabled) return;
    try {
      await this.client.set(
        REVOKED_PREFIX + apiKeyId,
        '1',
        'EX',
        Math.max(this.ttlSeconds * 10, 600),
      );
    } catch (error) {
      this.onError(error);
    }
  }
}
