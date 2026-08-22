import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { DatabaseError } from 'pg';
import { AppError, RateLimitedError } from './errors.js';

/**
 * Curated, caller-safe explanations for the check constraints this service
 * owns. Unknown constraints fall back to a generic string.
 */
const CHECK_VIOLATION_MESSAGES: Record<string, string> = {
  entries_amount_nonzero: 'entry amounts must be non-zero',
  transactions_balanced: 'transaction entries must sum to zero',
  accounts_currency_format: 'currency must be a three-letter ISO 4217 code',
};

function checkViolationDetail(error: DatabaseError): string {
  const constraint = error.constraint ?? '';
  if (constraint in CHECK_VIOLATION_MESSAGES) return CHECK_VIOLATION_MESSAGES[constraint] as string;
  // The balance trigger raises without a constraint name; match its own code.
  if (/sum to zero/i.test(error.message)) return 'transaction entries must sum to zero';
  return 'a ledger invariant was violated by this request';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'not_found',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    }),
  );

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: 'Request validation failed',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
          requestId,
        },
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, requestId }, 'response serialization failed');
      return reply.code(500).send({
        error: { code: 'internal_error', message: 'Internal server error', requestId },
      });
    }

    if (error instanceof RateLimitedError) {
      request.log.warn({ scope: error.scope, requestId }, 'rate limit exceeded');
      return reply
        .code(429)
        .header('retry-after', String(error.retryAfterSeconds))
        .send({ error: { code: error.code, message: error.message, requestId } });
    }

    if (error instanceof AppError) {
      request.log.warn({ err: error, requestId }, 'handled application error');
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
      });
    }

    // 23514 = check_violation. Only constraints we own get a curated message;
    // the raw Postgres text is logged, never returned, because it can embed
    // column names, values and constraint bodies (M5).
    if (error instanceof DatabaseError && error.code === '23514') {
      request.log.warn({ err: error, constraint: error.constraint, requestId }, 'check violation');
      return reply.code(422).send({
        error: {
          code: 'unprocessable_entity',
          message: 'Ledger invariant violated',
          details: checkViolationDetail(error),
          requestId,
        },
      });
    }

    const httpError = error as { statusCode?: number; code?: string; message?: string };
    if (typeof httpError.statusCode === 'number' && httpError.statusCode < 500) {
      return reply.code(httpError.statusCode).send({
        error: {
          code: httpError.code ?? 'bad_request',
          message: httpError.message ?? 'Request failed',
          requestId,
        },
      });
    }

    request.log.error({ err: error, requestId }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal server error', requestId },
    });
  });
}
