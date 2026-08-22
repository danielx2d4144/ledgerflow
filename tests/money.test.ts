import { describe, expect, it } from 'vitest';
import { formatMinorUnits, parseMinorUnits, sumMinorUnits } from '../src/shared/money.js';

describe('money', () => {
  it('round-trips amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const raw = '9007199254740993';
    expect(formatMinorUnits(parseMinorUnits(raw))).toBe(raw);
  });

  it('parses negative amounts', () => {
    expect(parseMinorUnits('-2500')).toBe(-2500n);
  });

  it('rejects decimal input', () => {
    expect(() => parseMinorUnits('25.00')).toThrow(TypeError);
  });

  it('sums to zero for a balanced set', () => {
    expect(sumMinorUnits([1000n, -400n, -600n])).toBe(0n);
  });
});
