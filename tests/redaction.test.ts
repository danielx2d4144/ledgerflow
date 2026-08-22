import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import { generateApiKey, redactedKey } from '../src/modules/auth/api-key.js';
import { REDACT_PATHS } from '../src/infra/logger.js';

function captureLog(write: (logger: Logger) => void): string {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  write(pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream));
  return output;
}

describe('secret redaction', () => {
  it('never writes a presented key to the logs', () => {
    const key = generateApiKey('test');
    const output = captureLog((logger) => {
      logger.info({
        req: { headers: { authorization: `Bearer ${key.token}`, 'x-api-key': key.token } },
      });
    });
    expect(output).not.toContain(key.secret);
    expect(output).not.toContain(key.token);
    expect(output).toContain('[redacted]');
  });

  it('produces a display form that cannot be replayed', () => {
    const key = generateApiKey('test');
    const display = redactedKey('test', key.prefix);
    expect(display).toContain(key.prefix);
    expect(display).not.toContain(key.secret);
    expect(display.endsWith('*'.repeat(8))).toBe(true);
  });
});
