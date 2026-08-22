import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/infra/logger.js';

/**
 * Contract checks on the generated OpenAPI document.
 *
 * The spec is generated from the same Zod schemas the runtime validates with,
 * so "spec drift" can only come from forgetting to regenerate the committed
 * file — which the first test catches. The remaining tests assert structural
 * properties an API consumer depends on.
 */
type SpecOperation = { responses?: Record<string, unknown>; security?: unknown[] };
type Spec = {
  paths: Record<string, Record<string, SpecOperation>>;
  components?: { securitySchemes?: Record<string, unknown> };
};

async function generateSpec(): Promise<Spec> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://localhost:5432/ledgerflow',
    REDIS_URL: 'redis://localhost:6379',
  });
  const app = await buildApp({
    env,
    logger: createLogger(env),
    db: {} as never,
    dbPing: () => Promise.resolve(),
    redisPing: () => Promise.resolve(),
  });
  await app.ready();
  const spec = app.swagger() as unknown as Spec;
  await app.close();
  return spec;
}

const spec = await generateSpec();

describe('openapi contract', () => {
  it('matches the committed openapi.json (run `npm run openapi` after changing routes)', async () => {
    const committed = JSON.parse(await readFile('openapi.json', 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(spec))).toEqual(committed);
  });

  it('documents every mutating endpoint with an error response shape', () => {
    const offenders: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!['post', 'patch', 'put', 'delete'].includes(method)) continue;
        const responses = Object.keys(operation.responses ?? {});
        if (!responses.some((code) => code.startsWith('4'))) {
          offenders.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('requires authentication on everything except the health probes', () => {
    const unauthenticated: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const security = operation.security;
        const isPublic = Array.isArray(security) && security.length === 0;
        if (isPublic && !path.startsWith('/health')) {
          unauthenticated.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    // /v1/bootstrap is only registered when BOOTSTRAP_ENABLED=true, so it is not
    // part of the default document.
    expect(unauthenticated).toEqual([]);
  });

  it('declares the bearer security scheme and a versioned path prefix', () => {
    expect(spec.components?.securitySchemes).toHaveProperty('apiKey');
    const nonHealth = Object.keys(spec.paths).filter((path) => !path.startsWith('/health'));
    expect(nonHealth.length).toBeGreaterThan(0);
    expect(nonHealth.every((path) => path.startsWith('/v1/'))).toBe(true);
  });
});
