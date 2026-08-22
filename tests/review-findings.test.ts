import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/modules/webhooks/url-guard.js';
import { MAX_MINOR_UNITS, MIN_MINOR_UNITS, parseMinorUnits } from '../src/shared/money.js';
import { createTransactionBody } from '../src/modules/ledger/ledger.schemas.js';
import { canonicalizeRequest } from '../src/modules/ledger/ledger.service.js';

/**
 * Regression tests for the issues found in docs/SECURITY_REVIEW.md.
 * Kept dependency-free (no database) so they cannot perturb outbox fixtures.
 */
describe('security review regressions', () => {
  it('canonicalizes request object keys without changing array order', () => {
    expect(canonicalizeRequest({ b: { y: 2, x: 1 }, a: [3, 2, 1] })).toBe(
      canonicalizeRequest({ a: [3, 2, 1], b: { x: 1, y: 2 } }),
    );
    expect(canonicalizeRequest({ entries: [{ accountId: 'a' }, { accountId: 'b' }] })).not.toBe(
      canonicalizeRequest({ entries: [{ accountId: 'b' }, { accountId: 'a' }] }),
    );
  });

  it('rejects minor-unit amounts outside the int8 column range (was an opaque 500)', () => {
    expect(() => parseMinorUnits('9999999999999999999')).toThrow(/64-bit/);
    expect(parseMinorUnits(MAX_MINOR_UNITS.toString())).toBe(MAX_MINOR_UNITS);
    expect(parseMinorUnits(MIN_MINOR_UNITS.toString())).toBe(MIN_MINOR_UNITS);

    const oversized = createTransactionBody.safeParse({
      description: 'x',
      currency: 'USD',
      entries: [
        { accountId: '00000000-0000-4000-8000-000000000001', amount: '9999999999999999999' },
        { accountId: '00000000-0000-4000-8000-000000000002', amount: '-9999999999999999999' },
      ],
    });
    expect(oversized.success).toBe(false);
  });

  it('caps the number of entries in one transaction', () => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      accountId: '00000000-0000-4000-8000-000000000001',
      amount: index % 2 === 0 ? '1' : '-1',
    }));
    const parsed = createTransactionBody.safeParse({ description: 'x', currency: 'USD', entries });
    expect(parsed.success).toBe(false);
  });

  it('treats hex-form, NAT64 and expanded IPv6 loopback/private addresses as private', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateAddress('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });
});
