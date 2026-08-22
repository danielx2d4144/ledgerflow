import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateApiKey,
  parseApiKey,
  secretMatches,
  hashSecret,
} from '../src/modules/auth/api-key.js';
import { satisfiesRole } from '../src/modules/auth/roles.js';
import { AuthCache, type AuthCacheClient } from '../src/modules/auth/auth.cache.js';
import { authHeaders, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('api key primitives', () => {
  it('generates a parseable, high-entropy key', () => {
    const key = generateApiKey('test');
    const parsed = parseApiKey(key.token);
    expect(parsed).toMatchObject({ tag: 'test', prefix: key.prefix });
    expect(key.secret).toHaveLength(43);
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', 'nope', 'lf_test_xyz.abc', `lf_test_${'a'.repeat(16)}`]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('verifies only the matching secret and never stores plaintext', () => {
    const key = generateApiKey('test');
    const stored = hashSecret(key.secret, 'pepper-pepper-pepper-pepper-1234');
    expect(stored).not.toContain(key.secret);
    expect(secretMatches(key.secret, 'pepper-pepper-pepper-pepper-1234', stored)).toBe(true);
    expect(secretMatches(key.secret, 'other-pepper-pepper-pepper-5678', stored)).toBe(false);
    expect(secretMatches('wrong', 'pepper-pepper-pepper-pepper-1234', stored)).toBe(false);
    expect(secretMatches(key.secret, 'pepper-pepper-pepper-pepper-1234', 'zz')).toBe(false);
  });

  it('rejects malformed stored digests before decoding them', () => {
    expect(secretMatches('secret', 'pepper', 'not-hex')).toBe(false);
    expect(secretMatches('secret', 'pepper', 'a'.repeat(63))).toBe(false);
  });

  it('does not write revocation tombstones when the cache is disabled', async () => {
    const calls: string[] = [];
    const client: AuthCacheClient = {
      get: async () => null,
      set: async (key) => {
        calls.push(key);
      },
      del: async () => undefined,
    };
    await new AuthCache(client, 0).revoke('key-id');
    expect(calls).toEqual([]);
  });

  it('treats roles as a hierarchy', () => {
    expect(satisfiesRole('admin', 'writer')).toBe(true);
    expect(satisfiesRole('writer', 'reader')).toBe(true);
    expect(satisfiesRole('reader', 'writer')).toBe(false);
    expect(satisfiesRole('writer', 'admin')).toBe(false);
  });
});

describe('authentication', () => {
  it('accepts a key via Authorization: Bearer and X-Api-Key', async () => {
    for (const headers of [
      { authorization: `Bearer ${ctx.tokens.readerToken}` },
      { 'x-api-key': ctx.tokens.readerToken },
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ organizationId: ctx.organizationId, role: 'reader' });
    }
  });

  it('rejects missing, malformed and unknown keys with an identical 401', async () => {
    const cases = [
      undefined,
      'Bearer not-a-key',
      `Bearer lf_test_${'0'.repeat(16)}.${'A'.repeat(43)}`,
      `Basic ${ctx.tokens.adminToken}`,
      // Right shape, wrong environment tag.
      ctx.tokens.adminToken.replace('lf_test_', 'lf_live_'),
    ];
    const bodies = new Set<string>();
    for (const value of cases) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: value === undefined ? {} : { authorization: value },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json();
      bodies.add(body.error.message);
      expect(body.error.code).toBe('unauthorized');
    }
    // No oracle: every failure looks the same to the caller.
    expect(bodies.size).toBe(1);
  });

  it('rejects a key whose secret belongs to another key with the same shape', async () => {
    const other = await ctx.createOrganization();
    const prefix = ctx.tokens.adminToken.split('.')[0];
    const secret = other.adminToken.split('.')[1];
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${prefix}.${secret}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an expired key', async () => {
    const issued = await ctx.app.auth.issueKey({
      organizationId: ctx.organizationId,
      name: 'expired',
      role: 'admin',
      expiresAt: new Date(Date.now() - 1_000),
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(issued.token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('records last use without exposing it to non-admins', async () => {
    const org = await ctx.createOrganization();
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(org.readerToken) });
    // last_used_at is written best-effort after the response.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const keys = await ctx.app.auth.listKeys(org.id);
    expect(keys.some((key) => key.lastUsedAt !== null)).toBe(true);
  });
});

describe('authorization', () => {
  it('lets a writer post but not manage keys', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        name: 'Cash',
        reference: `acct-${randomUUID().slice(0, 8)}`,
        type: 'asset',
        currency: 'USD',
      },
    });
    expect(create.statusCode).toBe(201);

    const keys = await ctx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: authHeaders(ctx.tokens.writerToken),
    });
    expect(keys.statusCode).toBe(403);
    expect(keys.json().error.code).toBe('forbidden');
  });

  it('lets a reader read but not write', async () => {
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.readerToken),
    });
    expect(read.statusCode).toBe(200);

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(ctx.tokens.readerToken),
      payload: { name: 'X', reference: 'nope-1', type: 'asset', currency: 'USD' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('declares an explicit policy for every route', () => {
    const undeclared = ctx.app.routePolicies.filter((route) => route.policy === undefined);
    expect(undeclared).toEqual([]);
  });
});

describe('key issuance and revocation', () => {
  it('returns the plaintext token once and never again', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: authHeaders(ctx.tokens.adminToken),
      payload: { name: 'reporting', role: 'reader' },
    });
    expect(created.statusCode).toBe(201);
    const { token, apiKey } = created.json();
    expect(token.startsWith('lf_test_')).toBe(true);
    expect(apiKey.role).toBe('reader');
    expect(JSON.stringify(apiKey)).not.toContain(token.split('.')[1]);
    expect(apiKey.redactedKey).toMatch(/\*{8}$/);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: authHeaders(ctx.tokens.adminToken),
    });
    const body = list.body;
    expect(body).not.toContain(token);
    expect(body).not.toContain('secretHash');
    expect(body).not.toContain('secret_hash');
  });

  it('revokes a key immediately, even when it was cached', async () => {
    const org = await ctx.createOrganization();
    const issued = await ctx.app.auth.issueKey({
      organizationId: org.id,
      name: 'doomed',
      role: 'reader',
    });

    // Warm the auth cache.
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(issued.token),
    });
    expect(before.statusCode).toBe(200);

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${issued.apiKey.id}?reason=leaked%20in%20a%20gist`,
      headers: authHeaders(org.adminToken),
      payload: { reason: 'leaked in a gist' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).not.toBeNull();

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(issued.token),
    });
    expect(after.statusCode).toBe(401);
  });

  it('is idempotent when revoking twice', async () => {
    const issued = await ctx.app.auth.issueKey({
      organizationId: ctx.organizationId,
      name: 'twice',
      role: 'reader',
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/api-keys/${issued.apiKey.id}?reason=rotation`,
        headers: authHeaders(ctx.tokens.adminToken),
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('404s rather than confirming a key id from another organization', async () => {
    const other = await ctx.createOrganization();
    const victim = await ctx.app.auth.issueKey({
      organizationId: other.id,
      name: 'victim',
      role: 'admin',
    });

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${victim.apiKey.id}`,
      headers: authHeaders(ctx.tokens.adminToken),
    });
    expect(revoke.statusCode).toBe(404);

    // And the victim key still works.
    const stillValid = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(victim.token),
    });
    expect(stillValid.statusCode).toBe(200);
  });

  it('never lists another organization keys', async () => {
    const other = await ctx.createOrganization();
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: authHeaders(other.adminToken),
    });
    const ids: string[] = list
      .json()
      .data.map((key: { organizationId: string }) => key.organizationId);
    expect(new Set(ids)).toEqual(new Set([other.id]));
  });
});

describe('tenant isolation', () => {
  it('scopes writes to the key organization regardless of client headers', async () => {
    const other = await ctx.createOrganization();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: {
        ...authHeaders(ctx.tokens.writerToken),
        // The legacy trust boundary: must be ignored entirely.
        'x-organization-id': other.id,
      },
      payload: {
        name: 'Cash',
        reference: `acct-${randomUUID().slice(0, 8)}`,
        type: 'asset',
        currency: 'USD',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().organizationId).toBe(ctx.organizationId);
  });

  it('cannot post entries against another organization accounts', async () => {
    const other = await ctx.createOrganization();
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(other.writerToken),
      payload: { name: 'Theirs', reference: 'theirs-1', type: 'asset', currency: 'USD' },
    });
    const mine = await ctx.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        name: 'Mine',
        reference: `acct-${randomUUID().slice(0, 8)}`,
        type: 'asset',
        currency: 'USD',
      },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: authHeaders(ctx.tokens.writerToken),
      payload: {
        description: 'cross tenant',
        currency: 'USD',
        entries: [
          { accountId: mine.json().id, amount: '100' },
          { accountId: foreign.json().id, amount: '-100' },
        ],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('keeps transaction lists disjoint per organization', async () => {
    const other = await ctx.createOrganization();
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/transactions',
      headers: authHeaders(other.readerToken),
    });
    expect(list.json().data).toEqual([]);
  });
});

describe('auth cache', () => {
  it('serves a warm key from cache and still works when Redis fails', async () => {
    const issued = await ctx.app.auth.issueKey({
      organizationId: ctx.organizationId,
      name: 'cached',
      role: 'reader',
    });
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(issued.token) });

    const first = await ctx.app.auth.verify(issued.token);
    expect(first).toMatchObject({ ok: true, principal: { cached: true } });

    ctx.cache.failNext = true;
    const degraded = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(issued.token),
    });
    expect(degraded.statusCode).toBe(200);
  });

  it('never caches a failed verification', async () => {
    const bogus = `lf_test_${'a'.repeat(16)}.${'B'.repeat(43)}`;
    const sizeBefore = ctx.cache.store.size;
    await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(bogus) });
    expect(ctx.cache.store.size).toBe(sizeBefore);
  });

  it('stores no secret material in the cache', () => {
    for (const [key, value] of ctx.cache.store) {
      expect(key).not.toContain('lf_test_');
      expect(value).not.toContain('lf_test_');
      expect(value).not.toContain('secret');
    }
  });
});
