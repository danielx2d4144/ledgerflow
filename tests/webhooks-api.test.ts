import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { webhookEndpoints } from '../src/infra/schema.js';
import { encryptSecret, decryptSecret } from '../src/modules/webhooks/secret-crypto.js';
import { signPayload, verifySignature } from '../src/modules/webhooks/signature.js';
import { assertSafeWebhookUrl, isPrivateAddress } from '../src/modules/webhooks/url-guard.js';
import { backoffDelayMs } from '../src/modules/webhooks/delivery.js';
import {
  authHeaders,
  createTestContext,
  mustExist,
  TEST_WEBHOOK_SECRET_KEY,
  type TestContext,
} from './helpers.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});
afterAll(async () => {
  await context.close();
});

const STRICT_GUARD = { allowPrivateTargets: false, allowInsecureHttp: false };

async function createEndpoint(token: string, url = 'https://hooks.example.com/ledger') {
  return context.app.inject({
    method: 'POST',
    url: '/v1/webhook-endpoints',
    headers: authHeaders(token),
    payload: { url, eventTypes: ['transaction.created'] },
  });
}

describe('webhook endpoint management', () => {
  it('returns the signing secret once and never again', async () => {
    const created = await createEndpoint(context.tokens.adminToken);
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      secret: string;
      endpoint: { id: string; secretLastFour: string };
    }>();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.endpoint.secretLastFour).toBe(body.secret.slice(-4));

    const fetched = await context.app.inject({
      method: 'GET',
      url: `/v1/webhook-endpoints/${body.endpoint.id}`,
      headers: authHeaders(context.tokens.readerToken),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).not.toContain(body.secret);

    const listed = await context.app.inject({
      method: 'GET',
      url: '/v1/webhook-endpoints',
      headers: authHeaders(context.tokens.readerToken),
    });
    expect(listed.body).not.toContain(body.secret);
  });

  it('stores the secret encrypted, not in plaintext, and can recover it for signing', async () => {
    const created = await createEndpoint(context.tokens.adminToken);
    const { secret, endpoint } = created.json<{ secret: string; endpoint: { id: string } }>();

    const [row] = await context.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));

    expect(row?.secretCiphertext).toBeDefined();
    expect(row?.secretCiphertext).not.toContain(secret);
    expect(row?.secretCiphertext.startsWith('v1.')).toBe(true);
    expect(decryptSecret(mustExist(row).secretCiphertext, TEST_WEBHOOK_SECRET_KEY)).toBe(secret);
  });

  it('rotates the secret and issues a different one', async () => {
    const created = await createEndpoint(context.tokens.adminToken);
    const { secret, endpoint } = created.json<{ secret: string; endpoint: { id: string } }>();

    const rotated = await context.app.inject({
      method: 'POST',
      url: `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`,
      headers: authHeaders(context.tokens.adminToken),
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json<{ secret: string }>().secret).not.toBe(secret);
  });

  it('requires the admin role for mutations and reader for reads', async () => {
    const asWriter = await createEndpoint(context.tokens.writerToken);
    expect(asWriter.statusCode).toBe(403);

    const listed = await context.app.inject({
      method: 'GET',
      url: '/v1/webhook-endpoints',
      headers: authHeaders(context.tokens.readerToken),
    });
    expect(listed.statusCode).toBe(200);

    const anonymous = await context.app.inject({ method: 'GET', url: '/v1/webhook-endpoints' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('isolates endpoints between organizations', async () => {
    const created = await createEndpoint(context.tokens.adminToken);
    const endpointId = created.json<{ endpoint: { id: string } }>().endpoint.id;
    const other = await context.createOrganization();

    for (const [method, url] of [
      ['GET', `/v1/webhook-endpoints/${endpointId}`],
      ['PATCH', `/v1/webhook-endpoints/${endpointId}`],
      ['DELETE', `/v1/webhook-endpoints/${endpointId}`],
    ] as const) {
      const response = await context.app.inject({
        method,
        url,
        headers: authHeaders(other.adminToken),
        ...(method === 'PATCH' ? { payload: { status: 'disabled' } } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    const listed = await context.app.inject({
      method: 'GET',
      url: '/v1/webhook-endpoints',
      headers: authHeaders(other.adminToken),
    });
    expect(listed.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('deletes endpoints idempotently from the caller viewpoint', async () => {
    const created = await createEndpoint(context.tokens.adminToken);
    const endpointId = created.json<{ endpoint: { id: string } }>().endpoint.id;

    const first = await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: authHeaders(context.tokens.adminToken),
    });
    expect(first.statusCode).toBe(204);

    const second = await context.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: authHeaders(context.tokens.adminToken),
    });
    expect(second.statusCode).toBe(404);
  });
});

describe('SSRF protection', () => {
  const blocked = [
    'http://hooks.example.com/x', // plaintext
    'https://user:pass@hooks.example.com/x', // credentials
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/x',
    'https://192.168.1.10/x',
    'https://172.16.9.9/x',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://hooks.example.com:6379/x', // sensitive port
    'ftp://hooks.example.com/x',
    'not-a-url',
  ];

  it.each(blocked)('rejects %s at registration time', async (url) => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: authHeaders(context.tokens.adminToken),
      payload: { url },
    });
    expect(response.statusCode).toBe(422);
  });

  it('accepts a normal public https url', () => {
    expect(assertSafeWebhookUrl('https://hooks.example.com/x', STRICT_GUARD).hostname).toBe(
      'hooks.example.com',
    );
  });

  it('classifies address ranges', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('signature scheme', () => {
  it('verifies a well-formed signature and rejects tampering', () => {
    const secret = 'whsec_test';
    const timestamp = 1_700_000_000;
    const body = JSON.stringify({ id: 'evt_1' });
    const signature = signPayload(secret, timestamp, body);

    expect(
      verifySignature({
        secret,
        timestampSeconds: timestamp,
        body,
        signature,
        nowSeconds: timestamp,
      }),
    ).toBe(true);
    expect(
      verifySignature({
        secret,
        timestampSeconds: timestamp,
        body: `${body} `,
        signature,
        nowSeconds: timestamp,
      }),
    ).toBe(false);
    expect(
      verifySignature({
        secret: 'whsec_other',
        timestampSeconds: timestamp,
        body,
        signature,
        nowSeconds: timestamp,
      }),
    ).toBe(false);
  });

  it('rejects replayed timestamps outside the tolerance window', () => {
    const secret = 'whsec_test';
    const timestamp = 1_700_000_000;
    const body = '{}';
    const signature = signPayload(secret, timestamp, body);
    expect(
      verifySignature({
        secret,
        timestampSeconds: timestamp,
        body,
        signature,
        nowSeconds: timestamp + 3_600,
      }),
    ).toBe(false);
  });

  it('round-trips secrets through AES-256-GCM and detects tampering', () => {
    const envelope = encryptSecret('whsec_abc', TEST_WEBHOOK_SECRET_KEY);
    expect(decryptSecret(envelope, TEST_WEBHOOK_SECRET_KEY)).toBe('whsec_abc');

    const parts = envelope.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64url')].join(
      '.',
    );
    expect(() => decryptSecret(tampered, TEST_WEBHOOK_SECRET_KEY)).toThrow();
  });
});

describe('backoff', () => {
  it('grows exponentially, keeps jitter bounded and honours the cap', () => {
    const config = { backoffBaseMs: 1_000, backoffMaxMs: 10_000 };
    expect(backoffDelayMs(1, config, () => 0)).toBe(500);
    expect(backoffDelayMs(1, config, () => 1)).toBe(1_000);
    expect(backoffDelayMs(3, config, () => 0)).toBe(2_000);
    expect(backoffDelayMs(10, config, () => 1)).toBe(10_000);
  });
});
