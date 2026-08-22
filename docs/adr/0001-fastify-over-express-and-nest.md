# ADR-0001: Fastify as the HTTP framework

- Status: Accepted
- Date: 2025-02-03
- Deciders: LedgerFlow maintainer

## Context

The API is schema-heavy: every endpoint validates a body, emits a documented
response, and must appear in an OpenAPI 3.1 spec that cannot drift from the code.
Throughput matters less than a portfolio reader believing the choice was reasoned.
Candidates: Express 5, Fastify 5, NestJS, Hono.

## Decision

Fastify 5, with `fastify-type-provider-zod` so a single Zod schema per route is
simultaneously runtime validation, TypeScript types, and the OpenAPI fragment.

## Rationale

- **One source of truth for schemas.** Express needs a hand-maintained spec or a
  decorator layer; Fastify's `schema` field is already the contract. CI regenerates
  the spec and fails on a diff, which only works if the spec is derived, not written.
- **Plugin encapsulation.** Auth, idempotency, and rate limiting are per-scope
  plugins with their own lifecycle. In Express these become ordering-sensitive
  middleware; a route registered in the wrong place is silently unauthenticated.
  Fastify's encapsulation makes "this subtree requires an API key" structural.
- **NestJS rejected**: DI container + decorators + modules is a lot of ceremony
  for ~20 endpoints, and it obscures the request lifecycle that is the most
  interesting part of this project to a reviewer.
- **Hono rejected**: excellent, but the plugin ecosystem I need (rate-limit,
  under-pressure, metrics) is thinner, and edge-runtime portability is worthless
  here because the app needs a long-lived Postgres pool.

## Consequences

- Positive: no spec drift; auth-by-omission is hard; ~2× Express throughput free.
- Negative: smaller hiring-manager familiarity than Express; Fastify v5 typings
  around type providers are fiddly and cost a day of setup.
- Follow-up: a route-table test asserts every route declares required scopes.
