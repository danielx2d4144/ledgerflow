import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ValidationError } from '../../shared/errors.js';

export interface UrlGuardOptions {
  allowPrivateTargets: boolean;
  allowInsecureHttp: boolean;
}

const BLOCKED_PORTS = new Set([22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

/**
 * Syntactic SSRF checks, cheap enough to run on every write.
 * Rejects non-HTTP schemes, embedded credentials, sensitive ports and literal
 * addresses inside private/link-local/loopback ranges (including IPv6-mapped
 * IPv4 and the cloud metadata address).
 */
export function assertSafeWebhookUrl(rawUrl: string, options: UrlGuardOptions): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('webhook url is not a valid absolute URL');
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowInsecureHttp)) {
    throw new ValidationError('webhook url must use https');
  }
  if (url.username || url.password) {
    throw new ValidationError('webhook url must not contain credentials');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new ValidationError(`webhook url port ${port} is not allowed`);
  }
  if (!options.allowPrivateTargets) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host)) {
      throw new ValidationError('webhook url must not point at a private address');
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw new ValidationError('webhook url must not point at a private address');
    }
  }
  return url;
}

/**
 * Resolution-time check, run immediately before each delivery so a hostname
 * that later resolves into a private range is refused.
 *
 * Residual risk: this is a check-then-connect race (DNS rebinding). Closing it
 * fully needs a pinned-IP connector; documented in docs/WEBHOOKS.md.
 */
export async function assertSafeResolution(
  url: URL,
  options: UrlGuardOptions,
  resolver: (hostname: string) => Promise<string[]> = defaultResolver,
): Promise<void> {
  if (options.allowPrivateTargets) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolver(host);
  if (addresses.length === 0) {
    throw new ValidationError(`webhook host '${host}' did not resolve`);
  }
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw new ValidationError(`webhook host '${host}' resolves to a private address`);
  }
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address.toLowerCase());
  return true; // not an address at all: fail closed
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = expandIPv6(address);
  if (normalized === null) return true; // unparseable: fail closed
  if (/^(0000:){7}0{0,4}[01]$/.test(normalized)) return true; // :: and ::1
  const first = normalized.slice(0, 4);
  // fe80::/10 link-local, fc00::/7 unique-local.
  if (/^fe[89ab]/.test(first) || /^f[cd]/.test(first)) return true;
  // 64:ff9b::/96 NAT64 wraps an embedded IPv4 address.
  if (normalized.startsWith('0064:ff9b:')) {
    return isPrivateIPv4(embeddedIPv4(normalized));
  }
  // ::ffff:a.b.c.d and its hex form ::ffff:7f00:1 are the same address.
  if (/^(0000:){5}ffff:/.test(normalized)) {
    return isPrivateIPv4(embeddedIPv4(normalized));
  }
  return false;
}

/** Lower-case, fully expanded 8x4 hex form, or null if the input is not IPv6. */
function expandIPv6(address: string): string | null {
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  let value = address;
  if (mapped?.[1] && mapped[2]) {
    const octets = mapped[2].split('.').map(Number);
    if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    value = `${mapped[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((part) => part !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((p) => p !== '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }
  const groups =
    halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.padStart(4, '0')).join(':');
}

/** Reads the last 32 bits of an expanded IPv6 address as dotted-quad IPv4. */
function embeddedIPv4(normalized: string): string {
  const groups = normalized.split(':');
  const high = Number.parseInt(groups[6] ?? '0', 16);
  const low = Number.parseInt(groups[7] ?? '0', 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
