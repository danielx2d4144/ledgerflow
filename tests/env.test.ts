import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/ledgerflow',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('coerces numeric strings', () => {
    expect(loadEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a missing database url with a readable message', () => {
    expect(() => loadEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv({ ...base, PORT: '99999' })).toThrow(/PORT/);
  });

  const production = {
    ...base,
    NODE_ENV: 'production',
    API_KEY_PEPPER: 'production-pepper-0123456789-0123456789',
    WEBHOOK_SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
  };

  it('accepts a fully configured production environment', () => {
    expect(loadEnv(production).WEBHOOK_MAX_ATTEMPTS).toBe(6);
  });

  it('refuses the built-in webhook encryption key in production', () => {
    const withoutKey: Record<string, string> = { ...production };
    delete withoutKey.WEBHOOK_SECRET_KEY;
    expect(() => loadEnv(withoutKey)).toThrow(/WEBHOOK_SECRET_KEY/);
  });

  it('rejects a webhook encryption key of the wrong length', () => {
    expect(() =>
      loadEnv({ ...production, WEBHOOK_SECRET_KEY: Buffer.alloc(16, 3).toString('base64') }),
    ).toThrow(/WEBHOOK_SECRET_KEY/);
  });

  it('refuses the SSRF escape hatches in production', () => {
    expect(() => loadEnv({ ...production, WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' })).toThrow(
      /WEBHOOK_ALLOW_PRIVATE_TARGETS/,
    );
    expect(() => loadEnv({ ...production, WEBHOOK_ALLOW_INSECURE_HTTP: 'true' })).toThrow(
      /WEBHOOK_ALLOW_INSECURE_HTTP/,
    );
  });

  it('allows the escape hatches outside production', () => {
    const env = loadEnv({ ...base, WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' });
    expect(env.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(true);
  });
});
