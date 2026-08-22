import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors.js';
import type { AuthService, Principal } from './auth.service.js';
import { satisfiesRole, type Role } from './roles.js';

/**
 * Per-route access policy. Every route must declare one; the hook fails closed
 * with a 401 if a route somehow ships without a declaration, and a route-table
 * test fails CI if any route omits it.
 */
export type RoutePolicy = { public: true } | { role: Role };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
  interface FastifyInstance {
    auth: AuthService;
    /** Route policies observed at registration time, for the route-table test. */
    routePolicies: { method: string; url: string; policy: RoutePolicy | undefined }[];
  }
}

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const [scheme, ...rest] = header.split(' ');
    const value = rest.join(' ').trim();
    if (scheme?.toLowerCase() === 'bearer' && value.length > 0) return value;
    return null;
  }
  const apiKeyHeader = request.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }
  return null;
}

export interface AuthPluginOptions {
  service: AuthService;
}

/**
 * Registered directly on the root instance (not via `register`) so its
 * decorators and the global auth hook apply to every route without needing an
 * encapsulation escape hatch.
 */
export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorate('auth', options.service);
  app.decorate('routePolicies', []);
  app.decorateRequest('principal', null);

  app.addHook('onRoute', (route) => {
    if (route.method === 'HEAD') return;
    app.routePolicies.push({
      method: Array.isArray(route.method) ? route.method.join(',') : route.method,
      url: route.url,
      policy: route.config?.policy,
    });
  });

  app.addHook('onRequest', async (request) => {
    // No matched route: let the 404 handler answer rather than leaking that
    // auth is even required for a path that does not exist.
    if (request.routeOptions.url === undefined) return;

    const policy = request.routeOptions.config.policy;
    if (policy && 'public' in policy) return;

    const token = extractToken(request);
    if (!token) throw new UnauthorizedError();

    const result = await options.service.verify(token);
    if (!result.ok) {
      // The reason is logged (never returned) so operators can tell a revoked
      // key from a typo without handing that signal to the caller.
      request.log.warn({ authFailure: result.reason }, 'api key rejected');
      throw new UnauthorizedError();
    }

    request.principal = result.principal;
    request.log = request.log.child({
      organizationId: result.principal.organizationId,
      apiKeyId: result.principal.apiKeyId,
    });

    // Fail closed: an undeclared route is treated as admin-only.
    const requiredRole: Role = policy && 'role' in policy ? policy.role : 'admin';
    if (!satisfiesRole(result.principal.role, requiredRole)) {
      throw new ForbiddenError(requiredRole);
    }
  });
}

/** Narrowing helper for handlers running behind a non-public policy. */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw new UnauthorizedError();
  return request.principal;
}
