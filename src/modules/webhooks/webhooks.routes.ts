import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { errorResponse } from '../ledger/ledger.schemas.js';
import { requirePrincipal } from '../auth/auth.plugin.js';
import type { AuditContext, WebhookService } from './webhooks.service.js';
import {
  createEndpointBody,
  deliveryResponse,
  endpointResponse,
  endpointWithSecretResponse,
  listDeliveriesQuery,
  listDeliveriesResponse,
  listEndpointsResponse,
  updateEndpointBody,
} from './webhooks.schemas.js';

const commonErrors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
};

function auditContext(request: FastifyRequest): AuditContext {
  const principal = requirePrincipal(request);
  return {
    actor: { type: 'api_key', id: principal.apiKeyId },
    requestId: request.id,
    ip: request.ip,
  };
}

export interface WebhookRoutesOptions {
  service: WebhookService;
}

/**
 * Webhook administration. Mutations are admin-only; reads require `reader`.
 * The organization always comes from the API key, never from the payload.
 */
export const webhookRoutes: FastifyPluginAsyncZod<WebhookRoutesOptions> = async (app, options) => {
  const service = options.service;

  app.post(
    '/webhook-endpoints',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Register a webhook endpoint',
        description:
          'The signing `secret` is returned exactly once. It is stored encrypted (never in ' +
          'plaintext) because HMAC signing needs the original value; see ADR-0008.',
        security: [{ apiKey: [] }],
        body: createEndpointBody,
        response: { 201: endpointWithSecretResponse, ...commonErrors },
      },
    },
    async (request, reply) => {
      const created = await service.createEndpoint(
        requirePrincipal(request).organizationId,
        request.body,
        auditContext(request),
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/webhook-endpoints',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['webhooks'],
        summary: 'List webhook endpoints',
        security: [{ apiKey: [] }],
        response: { 200: listEndpointsResponse, ...commonErrors },
      },
    },
    async (request) => ({
      data: await service.listEndpoints(requirePrincipal(request).organizationId),
    }),
  );

  app.get(
    '/webhook-endpoints/:endpointId',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Fetch a webhook endpoint',
        security: [{ apiKey: [] }],
        params: z.object({ endpointId: z.uuid() }),
        response: { 200: endpointResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.getEndpoint(requirePrincipal(request).organizationId, request.params.endpointId),
  );

  app.patch(
    '/webhook-endpoints/:endpointId',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Update or disable a webhook endpoint',
        security: [{ apiKey: [] }],
        params: z.object({ endpointId: z.uuid() }),
        body: updateEndpointBody,
        response: { 200: endpointResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.updateEndpoint(
        requirePrincipal(request).organizationId,
        request.params.endpointId,
        request.body,
        auditContext(request),
      ),
  );

  app.post(
    '/webhook-endpoints/:endpointId/rotate-secret',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Rotate the signing secret',
        description:
          'Returns the new secret once. In-flight deliveries are signed with whichever ' +
          'secret is current when the attempt runs, so rotate during a quiet window.',
        security: [{ apiKey: [] }],
        params: z.object({ endpointId: z.uuid() }),
        response: { 200: endpointWithSecretResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.rotateSecret(
        requirePrincipal(request).organizationId,
        request.params.endpointId,
        auditContext(request),
      ),
  );

  app.delete(
    '/webhook-endpoints/:endpointId',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Delete a webhook endpoint and its delivery history',
        security: [{ apiKey: [] }],
        params: z.object({ endpointId: z.uuid() }),
        response: { 204: z.null(), ...commonErrors },
      },
    },
    async (request, reply) => {
      await service.deleteEndpoint(
        requirePrincipal(request).organizationId,
        request.params.endpointId,
        auditContext(request),
      );
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/webhook-deliveries',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['webhooks'],
        summary: 'List delivery attempts, newest first',
        description:
          'Filter by `status=dead_letter` to inspect deliveries that exhausted their retries.',
        security: [{ apiKey: [] }],
        querystring: listDeliveriesQuery,
        response: { 200: listDeliveriesResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.listDeliveries(requirePrincipal(request).organizationId, {
        ...(request.query.endpointId ? { endpointId: request.query.endpointId } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
  );

  app.get(
    '/webhook-deliveries/:deliveryId',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Fetch one delivery',
        security: [{ apiKey: [] }],
        params: z.object({ deliveryId: z.uuid() }),
        response: { 200: deliveryResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.getDelivery(requirePrincipal(request).organizationId, request.params.deliveryId),
  );

  app.post(
    '/webhook-deliveries/:deliveryId/replay',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Replay a failed or dead-lettered delivery',
        description:
          'Grants a fresh attempt budget and re-queues the delivery. The event id is unchanged, ' +
          'so a receiver that already processed it must deduplicate.',
        security: [{ apiKey: [] }],
        params: z.object({ deliveryId: z.uuid() }),
        response: { 202: deliveryResponse, ...commonErrors },
      },
    },
    async (request, reply) => {
      const replayed = await service.replayDelivery(
        requirePrincipal(request).organizationId,
        request.params.deliveryId,
        auditContext(request),
      );
      return reply.code(202).send(replayed);
    },
  );

  app.post(
    '/events/:eventId/replay',
    {
      config: { policy: { role: 'admin' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Re-fan-out an event to all matching endpoints',
        description:
          'Useful after registering a new endpoint. Endpoints that already have a delivery for ' +
          'the event keep it — fan-out is idempotent per (endpoint, event).',
        security: [{ apiKey: [] }],
        params: z.object({ eventId: z.uuid() }),
        response: {
          202: z.object({ eventId: z.uuid(), status: z.string() }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const result = await service.replayEvent(
        requirePrincipal(request).organizationId,
        request.params.eventId,
        auditContext(request),
      );
      return reply.code(202).send(result);
    },
  );
};
