import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { UnauthorizedError } from '../../shared/errors.js';
import { errorResponse } from '../ledger/ledger.schemas.js';
import { requirePrincipal } from './auth.plugin.js';
import {
  apiKeyResponse,
  bootstrapBody,
  bootstrapResponse,
  createApiKeyBody,
  createApiKeyResponse,
  listApiKeysResponse,
  whoamiResponse,
} from './auth.schemas.js';

const commonErrors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};

/** Key management. Every route here is admin-only and organization-scoped. */
export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['auth'],
        summary: 'Describe the calling API key',
        security: [{ apiKey: [] }],
        response: { 200: whoamiResponse, ...commonErrors },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return {
        organizationId: principal.organizationId,
        apiKeyId: principal.apiKeyId,
        role: principal.role,
        prefix: principal.prefix,
      };
    },
  );

  app.post(
    '/api-keys',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['auth'],
        summary: 'Issue an API key for the calling organization',
        description:
          'The plaintext `token` is returned once and never stored. Rotate by issuing a ' +
          'second key, migrating traffic, then revoking the old one.',
        security: [{ apiKey: [] }],
        body: createApiKeyBody,
        response: { 201: createApiKeyResponse, ...commonErrors },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const created = await app.auth.issueKey({
        organizationId: principal.organizationId,
        name: request.body.name,
        role: request.body.role,
        expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null,
        context: {
          actor: { type: 'api_key', id: principal.apiKeyId },
          requestId: request.id,
          ip: request.ip,
        },
      });
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/api-keys',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['auth'],
        summary: 'List API keys for the calling organization',
        security: [{ apiKey: [] }],
        response: { 200: listApiKeysResponse, ...commonErrors },
      },
    },
    async (request) => ({
      data: await app.auth.listKeys(requirePrincipal(request).organizationId),
    }),
  );

  app.delete(
    '/api-keys/:apiKeyId',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['auth'],
        summary: 'Revoke an API key',
        description: 'Idempotent. Revocation takes effect immediately, including cached sessions.',
        security: [{ apiKey: [] }],
        params: z.object({ apiKeyId: z.uuid() }),
        querystring: z.object({ reason: z.string().min(1).max(200).optional() }),
        response: { 200: apiKeyResponse, ...commonErrors },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return app.auth.revokeKey(
        principal.organizationId,
        request.params.apiKeyId,
        request.query.reason,
        {
          actor: { type: 'api_key', id: principal.apiKeyId },
          requestId: request.id,
          ip: request.ip,
        },
      );
    },
  );
};

export interface BootstrapRoutesOptions {
  token: string;
  /** Applied before the token check so guessing is rate limited (H4). */
  limiter?: (request: FastifyRequest) => Promise<void>;
}

/**
 * Compares SHA-256 digests rather than the raw buffers: digests are always the
 * same length, so neither the comparison nor its length pre-check leaks the
 * secret's length (L2).
 */
function tokenMatches(presented: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(createHash('sha256').update(presented).digest(), expectedDigest);
}

/**
 * Development-only escape hatch that mints the very first organization and admin
 * key. Three independent guards keep it out of production: `loadEnv` refuses
 * `BOOTSTRAP_ENABLED=true` when `NODE_ENV=production`, `buildApp` only registers
 * these routes for non-production environments, and the route itself demands a
 * shared secret of its own.
 */
export const bootstrapRoutes: FastifyPluginAsyncZod<BootstrapRoutesOptions> = async (
  app,
  options,
) => {
  const expectedDigest = createHash('sha256').update(options.token).digest();

  app.post(
    '/bootstrap',
    {
      config: { policy: { public: true } },
      schema: {
        tags: ['auth'],
        summary: 'Create the first organization and admin key (non-production only)',
        headers: z.object({ 'x-bootstrap-token': z.string().min(16) }),
        body: bootstrapBody,
        response: { 201: bootstrapResponse, ...commonErrors },
      },
    },
    async (request, reply) => {
      if (options.limiter) await options.limiter(request);
      if (!tokenMatches(request.headers['x-bootstrap-token'], expectedDigest)) {
        throw new UnauthorizedError('invalid bootstrap token');
      }

      const organization = await app.auth.createOrganization({
        name: request.body.organizationName,
        slug: request.body.organizationSlug,
      });
      const { apiKey, token } = await app.auth.issueKey({
        organizationId: organization.id,
        name: request.body.keyName,
        role: 'admin',
      });

      return reply.code(201).send({
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt.toISOString(),
        },
        apiKey,
        token,
      });
    },
  );
};
