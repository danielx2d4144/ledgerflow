/**
 * Amounts are handled as minor units (bigint) everywhere inside the domain.
 * JSON transport uses decimal strings so no precision is lost in JavaScript numbers.
 */
export const MIN_MINOR_UNITS = -(2n ** 63n);
export const MAX_MINOR_UNITS = 2n ** 63n - 1n;

export function parseMinorUnits(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new TypeError(`'${value}' is not an integer amount string`);
  const parsed = BigInt(value);
  // `entries.amount` is a Postgres bigint (int8). Values outside that range used
  // to reach the driver and surface as an opaque 500; reject them up front.
  if (parsed < MIN_MINOR_UNITS || parsed > MAX_MINOR_UNITS) {
    throw new TypeError(`'${value}' exceeds the 64-bit minor-unit range`);
  }
  return parsed;
}

export function formatMinorUnits(value: bigint): string {
  return value.toString();
}

export function sumMinorUnits(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
