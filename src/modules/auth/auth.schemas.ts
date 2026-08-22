import { z } from 'zod';
import { ROLES } from './roles.js';

export const roleSchema = z.enum(ROLES);

export const apiKeyResponse = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  role: roleSchema,
  /** Safe-to-display form, e.g. `lf_test_ab12….********`. */
  redactedKey: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const createApiKeyBody = z.object({
  name: z.string().min(1).max(120),
  role: roleSchema.default('reader'),
  expiresAt: z.iso.datetime().optional(),
});

export const createApiKeyResponse = z.object({
  apiKey: apiKeyResponse,
  /** Shown once. LedgerFlow cannot recover it later. */
  token: z.string(),
});

export const listApiKeysResponse = z.object({ data: z.array(apiKeyResponse) });

export const bootstrapBody = z.object({
  organizationName: z.string().min(1).max(200),
  organizationSlug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase and dash-separated'),
  keyName: z.string().min(1).max(120).default('bootstrap admin key'),
});

export const bootstrapResponse = z.object({
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.iso.datetime(),
  }),
  apiKey: apiKeyResponse,
  token: z.string(),
});

export const whoamiResponse = z.object({
  organizationId: z.uuid(),
  apiKeyId: z.uuid(),
  role: roleSchema,
  prefix: z.string(),
});

export type CreateApiKeyBody = z.infer<typeof createApiKeyBody>;
export type BootstrapBody = z.infer<typeof bootstrapBody>;
