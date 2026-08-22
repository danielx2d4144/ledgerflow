import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/** Header paths scrubbed from every log line. Exported so tests can assert them. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export function createLogger(env: Env): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'ledgerflow', env: env.NODE_ENV },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (env.NODE_ENV === 'development') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    });
  }
  return pino(options);
}
