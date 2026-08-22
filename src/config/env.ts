import { z } from 'zod';

const DEFAULT_PEPPER = 'development-only-api-key-pepper-000000';
/** 32 zero bytes, base64. Refused in production, same as the pepper. */
const DEFAULT_WEBHOOK_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Per-API-key budget per window (the primary limit for authenticated routes). */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(200),
  /**
   * Per-client-IP budget per window. Applies to every request before
   * authentication, so unauthenticated/invalid-key traffic is bounded too.
   */
  RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).default(600),
  /** Budget per window for the unauthenticated bootstrap route, keyed by IP. */
  RATE_LIMIT_BOOTSTRAP_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  /**
   * Fastify `trustProxy`. `false` (default) means `X-Forwarded-For` is ignored,
   * so the limiter key cannot be spoofed. Set to the number of trusted proxy
   * hops (Render: `1`) or a comma-separated list of proxy IPs/CIDRs.
   */
  TRUST_PROXY: z.string().default('false'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),

  /**
   * Server-side pepper mixed into every API-key hash. Rotating it invalidates
   * every issued key, so it lives in the secret store, never in the database.
   */
  API_KEY_PEPPER: z.string().min(32).default(DEFAULT_PEPPER),
  /** How long a successful key verification may be served from Redis. */
  AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  /**
   * Enables the unauthenticated bootstrap route that mints the first
   * organization and admin key. Refused outright in production (see below).
   */
  BOOTSTRAP_ENABLED: booleanish.default(false),
  BOOTSTRAP_TOKEN: z.string().min(16).optional(),

  /**
   * AES-256-GCM key (base64, 32 bytes) protecting webhook signing secrets at
   * rest. Signing needs the plaintext, so secrets are encrypted, not hashed
   * (ADR-0008). Rotating it invalidates every stored secret.
   */
  WEBHOOK_SECRET_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must be 32 bytes encoded as base64',
    })
    .default(DEFAULT_WEBHOOK_KEY),
  /** Total attempts per delivery before it is parked in `dead_letter`. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(2_000),
  WEBHOOK_BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).default(3_600_000),
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(10),
  /** SSRF escape hatches; both are refused when NODE_ENV=production. */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: booleanish.default(false),
  WEBHOOK_ALLOW_INSECURE_HTTP: booleanish.default(false),
  /**
   * How long a worker may hold an exclusive claim on a delivery row. A crashed
   * worker's delivery becomes claimable again once the lease expires.
   */
  WEBHOOK_LEASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  /** Deletes idempotency rows past `expires_at`; 0 disables the reaper. */
  IDEMPOTENCY_REAP_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(300_000),
  IDEMPOTENCY_REAP_BATCH_SIZE: z.coerce.number().int().min(1).max(100_000).default(1_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
});

const envSchemaChecked = envSchema.superRefine((env, ctx) => {
  if (env.BOOTSTRAP_ENABLED && !env.BOOTSTRAP_TOKEN) {
    ctx.addIssue({
      code: 'custom',
      path: ['BOOTSTRAP_TOKEN'],
      message: 'BOOTSTRAP_TOKEN is required when BOOTSTRAP_ENABLED=true',
    });
  }
  if (env.NODE_ENV !== 'production') return;
  if (env.BOOTSTRAP_ENABLED) {
    ctx.addIssue({
      code: 'custom',
      path: ['BOOTSTRAP_ENABLED'],
      message: 'bootstrap mode cannot be enabled when NODE_ENV=production',
    });
  }
  if (env.WEBHOOK_SECRET_KEY === DEFAULT_WEBHOOK_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEBHOOK_SECRET_KEY'],
      message: 'WEBHOOK_SECRET_KEY must be set to a unique secret in production',
    });
  }
  for (const flag of ['WEBHOOK_ALLOW_PRIVATE_TARGETS', 'WEBHOOK_ALLOW_INSECURE_HTTP'] as const) {
    if (env[flag]) {
      ctx.addIssue({
        code: 'custom',
        path: [flag],
        message: `${flag} cannot be enabled when NODE_ENV=production`,
      });
    }
  }
  if (env.API_KEY_PEPPER === DEFAULT_PEPPER) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_KEY_PEPPER'],
      message: 'API_KEY_PEPPER must be set to a unique secret in production',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Translates `TRUST_PROXY` into the value Fastify expects. Anything other than
 * `true`/a hop count/an address list is treated as "do not trust", because
 * trusting a proxy that is not there hands the client control of `request.ip`.
 */
export function parseTrustProxy(value: string): boolean | number | string[] {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'false') return false;
  if (trimmed.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parses and validates process environment. Throws a readable aggregate error on
 * misconfiguration so the process fails fast at boot instead of at first request.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchemaChecked.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
