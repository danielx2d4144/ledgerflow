import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('health endpoints', () => {
  it('reports liveness without touching dependencies', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness with per-dependency checks', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks.postgres.status).toBe('up');
    expect(body.checks.redis.status).toBe('up');
  });

  it('exposes an OpenAPI document covering the ledger routes', () => {
    const spec = ctx.app.swagger() as { paths: Record<string, unknown>; openapi: string };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/accounts', '/v1/transactions', '/health/ready']),
    );
  });

  it('returns a structured 404 for unknown routes', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});
