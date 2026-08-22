import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const dependency = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative(),
});

const readinessResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
  checks: z.object({ postgres: dependency, redis: dependency }),
});

/**
 * Probes a dependency. The driver's error message is logged, never returned:
 * `pg`/`ioredis` messages embed host, port, database, role and auth detail, and
 * this route is unauthenticated (M4).
 */
async function probe(check: () => Promise<void>, log: (error: unknown) => void) {
  const startedAt = performance.now();
  try {
    await check();
    return { status: 'up' as const, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    log(error);
    return { status: 'down' as const, latencyMs: Math.round(performance.now() - startedAt) };
  }
}

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness: process is running. Must never touch dependencies.
  app.get(
    '/live',
    {
      config: { policy: { public: true } },
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        security: [],
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' }) as const,
  );

  // Readiness: dependencies reachable. Returns 503 when degraded so orchestrators
  // pull the instance out of rotation without killing it.
  app.get(
    '/ready',
    {
      config: { policy: { public: true } },
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        security: [],
        response: { 200: readinessResponse, 503: readinessResponse },
      },
    },
    async (request, reply) => {
      const [postgres, redis] = await Promise.all([
        probe(app.dbPing, (error) => {
          request.log.error({ err: error, dependency: 'postgres' }, 'readiness probe failed');
        }),
        probe(app.redisPing, (error) => {
          request.log.error({ err: error, dependency: 'redis' }, 'readiness probe failed');
        }),
      ]);
      const healthy = postgres.status === 'up' && redis.status === 'up';
      return reply.code(healthy ? 200 : 503).send({
        status: healthy ? ('ok' as const) : ('degraded' as const),
        uptimeSeconds: Math.round(process.uptime()),
        version: app.appVersion,
        checks: { postgres, redis },
      });
    },
  );
};
