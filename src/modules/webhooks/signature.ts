import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-ledgerflow-signature';
export const TIMESTAMP_HEADER = 'x-ledgerflow-timestamp';
export const EVENT_ID_HEADER = 'x-ledgerflow-event-id';
export const DELIVERY_ID_HEADER = 'x-ledgerflow-delivery-id';
export const ATTEMPT_HEADER = 'x-ledgerflow-attempt';

/**
 * Signs `<timestamp>.<body>` rather than the body alone so a captured request
 * cannot be replayed indefinitely: receivers reject stale timestamps. The
 * scheme is versioned (`v1=`) to leave room for algorithm changes.
 */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `v1=${mac}`;
}

/** Constant-time verification helper, also used by the tests and the docs. */
export function verifySignature(input: {
  secret: string;
  timestampSeconds: number;
  body: string;
  signature: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - input.timestampSeconds) > tolerance) return false;

  const expected = Buffer.from(signPayload(input.secret, input.timestampSeconds, input.body));
  const presented = Buffer.from(input.signature);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
