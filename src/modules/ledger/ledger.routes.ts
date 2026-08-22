import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requirePrincipal } from '../auth/auth.plugin.js';
import { LedgerService } from './ledger.service.js';
import {
  accountBalanceResponse,
  accountResponse,
  createAccountBody,
  createTransactionBody,
  errorResponse,
  listTransactionsQuery,
  listTransactionsResponse,
  transactionResponse,
} from './ledger.schemas.js';

/**
 * The organization is resolved from the authenticated API key, never from a
 * client-supplied header, so a caller cannot address another tenant's data.
 */
const requestHeaders = z.object({
  'idempotency-key': z.string().min(8).max(255).optional(),
});

export const ledgerRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new LedgerService(app.db);
  const commonErrors = {
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    422: errorResponse,
  };

  app.post(
    '/accounts',
    {
      config: { policy: { role: 'writer' } },
      schema: {
        tags: ['accounts'],
        summary: 'Create a ledger account',
        headers: requestHeaders,
        security: [{ apiKey: [] }],
        body: createAccountBody,
        response: { 201: accountResponse, ...commonErrors },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const account = await service.createAccount(principal.organizationId, request.body, {
        actor: { type: 'api_key', id: principal.apiKeyId },
        requestId: request.id,
        ip: request.ip,
      });
      return reply.code(201).send(account);
    },
  );

  app.get(
    '/accounts/:accountId',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['accounts'],
        summary: 'Fetch an account with its current balance',
        headers: requestHeaders,
        security: [{ apiKey: [] }],
        params: z.object({ accountId: z.uuid() }),
        response: { 200: accountBalanceResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.getAccountWithBalance(
        requirePrincipal(request).organizationId,
        request.params.accountId,
      ),
  );

  app.post(
    '/transactions',
    {
      config: { policy: { role: 'writer' } },
      schema: {
        tags: ['transactions'],
        summary: 'Post a balanced double-entry transaction',
        description:
          'Entries must sum to zero. Supply an `Idempotency-Key` header to make retries safe; ' +
          'replaying the same key with the same body returns the original transaction.',
        headers: requestHeaders,
        security: [{ apiKey: [] }],
        body: createTransactionBody,
        response: { 201: transactionResponse, 200: transactionResponse, ...commonErrors },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { transaction, replayed } = await service.createTransaction(
        principal.organizationId,
        request.body,
        request.headers['idempotency-key'],
        {
          actor: { type: 'api_key', id: principal.apiKeyId },
          requestId: request.id,
          ip: request.ip,
        },
      );
      return reply.code(replayed ? 200 : 201).send(transaction);
    },
  );

  app.get(
    '/transactions',
    {
      config: { policy: { role: 'reader' } },
      schema: {
        tags: ['transactions'],
        summary: 'List transactions newest-first with cursor pagination',
        headers: requestHeaders,
        security: [{ apiKey: [] }],
        querystring: listTransactionsQuery,
        response: { 200: listTransactionsResponse, ...commonErrors },
      },
    },
    async (request) =>
      service.listTransactions(
        requirePrincipal(request).organizationId,
        request.query.limit,
        request.query.cursor,
      ),
  );
};
