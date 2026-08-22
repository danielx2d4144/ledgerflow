import { z } from 'zod';

export const eventTypeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'event types look like `transaction.created`');

export const createEndpointBody = z.object({
  url: z.string().min(8).max(2_048),
  description: z.string().max(200).optional(),
  /** Empty (or omitted) subscribes the endpoint to every event type. */
  eventTypes: z.array(eventTypeSchema).max(32).default([]),
});

export const updateEndpointBody = z
  .object({
    url: z.string().min(8).max(2_048).optional(),
    description: z.string().max(200).nullable().optional(),
    eventTypes: z.array(eventTypeSchema).max(32).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });

export const endpointResponse = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
  disabledReason: z.string().nullable(),
  secretLastFour: z.string(),
  consecutiveFailures: z.number().int(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const endpointWithSecretResponse = z.object({
  endpoint: endpointResponse,
  /** Returned exactly once, at creation and on rotation. Store it now. */
  secret: z.string(),
});

export const listEndpointsResponse = z.object({ data: z.array(endpointResponse) });

export const deliveryResponse = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  endpointId: z.uuid(),
  eventId: z.uuid(),
  eventType: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed', 'dead_letter']),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  responseStatus: z.number().int().nullable(),
  responseSnippet: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listDeliveriesQuery = z.object({
  endpointId: z.uuid().optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'dead_letter']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.iso.datetime().optional(),
});

export const listDeliveriesResponse = z.object({
  data: z.array(deliveryResponse),
  nextCursor: z.string().nullable(),
});

export type CreateEndpointBody = z.infer<typeof createEndpointBody>;
export type UpdateEndpointBody = z.infer<typeof updateEndpointBody>;
export type EndpointResponse = z.infer<typeof endpointResponse>;
export type DeliveryResponse = z.infer<typeof deliveryResponse>;
