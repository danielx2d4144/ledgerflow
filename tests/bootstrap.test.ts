import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { authHeaders, BOOTSTRAP_TOKEN, createTestContext, type TestContext } from './helpers.js';

const baseEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/ledgerflow',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_PEPPER: 'a-production-pepper-that-is-long-enough',
};

describe('bootstrap safety', () => {
  // PGlite serves one connection at a time, so contexts are created serially.
  let disabled: TestContext;
  beforeAll(async () => {
    disabled = await createTestContext();
  });
  afterAll(async () => {
    await disabled.close();
  });

  it('refuses to boot with bootstrap enabled in production', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        BOOTSTRAP_ENABLED: 'true',
        BOOTSTRAP_TOKEN: 'a-token-long-enough-here',
      }),
    ).toThrow(/BOOTSTRAP_ENABLED/);
  });

  it('refuses the default pepper in production', () => {
    expect(() =>
      loadEnv({ ...baseEnv, NODE_ENV: 'production', API_KEY_PEPPER: undefined }),
    ).toThrow(/API_KEY_PEPPER/);
  });

  it('requires a bootstrap token whenever bootstrap is enabled', () => {
    expect(() => loadEnv({ ...baseEnv, BOOTSTRAP_ENABLED: 'true' })).toThrow(/BOOTSTRAP_TOKEN/);
  });

  it('does not register the route unless explicitly enabled', async () => {
    const response = await disabled.app.inject({
      method: 'POST',
      url: '/v1/bootstrap',
      headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN },
      payload: { organizationName: 'Acme', organizationSlug: 'acme-nope' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('bootstrap route', () => {
  let enabled: TestContext;
  beforeAll(async () => {
    enabled = await createTestContext({ bootstrap: true });
  });
  afterAll(async () => {
    await enabled.close();
  });

  it('mints an organization and an admin key usable straight away', async () => {
    const slug = `boot-${randomUUID().slice(0, 8)}`;
    const response = await enabled.app.inject({
      method: 'POST',
      url: '/v1/bootstrap',
      headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN },
      payload: { organizationName: 'Acme Bootstrapped', organizationSlug: slug },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.apiKey.role).toBe('admin');

    const me = await enabled.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(body.token),
    });
    expect(me.json()).toMatchObject({ organizationId: body.organization.id, role: 'admin' });
  });

  it('rejects a wrong bootstrap token', async () => {
    const response = await enabled.app.inject({
      method: 'POST',
      url: '/v1/bootstrap',
      headers: { 'x-bootstrap-token': 'wrong-token-but-long-enough' },
      payload: { organizationName: 'Acme', organizationSlug: `boot-${randomUUID().slice(0, 8)}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a duplicate organization slug', async () => {
    const slug = `boot-${randomUUID().slice(0, 8)}`;
    const payload = { organizationName: 'Acme', organizationSlug: slug };
    const headers = { 'x-bootstrap-token': BOOTSTRAP_TOKEN };
    await enabled.app.inject({ method: 'POST', url: '/v1/bootstrap', headers, payload });
    const second = await enabled.app.inject({
      method: 'POST',
      url: '/v1/bootstrap',
      headers,
      payload,
    });
    expect(second.statusCode).toBe(409);
  });
});
