# ADR-0007: API-key authentication and tenant isolation strategy

- Status: Accepted (amended during implementation — see "Implementation notes")
- Date: 2025-02-08

## Context

LedgerFlow is machine-to-machine and multi-tenant. It needs credentials that are
revocable, cheap to verify on every request, and impossible to accidentally use
across tenants. Options for authn: API keys, OAuth2 client credentials, JWTs.
Options for isolation: application-level `tenant_id` filters, Postgres RLS, or a
database/schema per tenant.

## Decision

**Authn:** opaque API keys, format `lf_<env>_<prefix>.<secret>` (e.g.
`lf_live_7fa3c1d2....`). Only `prefix` and a keyed hash of `secret` are stored.
Verified keys are cached in Redis for 60 s keyed by SHA-256 of the whole key.

**Isolation:** application-level `tenant_id` filtering in every repo function,
plus Postgres RLS as a second, independent net on all tenant-scoped tables using
`current_setting('app.tenant_id')`, set per connection checkout.

## Rationale

- **API keys over JWTs**: revocation is instant and definitive. A stolen JWT is
  valid until expiry; a stolen API key dies the moment it's revoked (worst case
  60 s, the auth cache TTL). For a money API that asymmetry decides it.
- **OAuth2 client credentials rejected** for v1: it's JWTs plus a token endpoint
  plus rotation ceremony, for no gain in a server-to-server context with no
  third-party delegation. Noted as a v2 path if partner integrations appear.
- **A keyed hash, not bcrypt or plain SHA**: keys are high-entropy, so the
  password-KDF argument does not apply; what matters is that a stolen database
  cannot be replayed. See the implementation note below for why this landed as a
  peppered HMAC rather than Argon2id. The `prefix` column makes lookup an index
  hit rather than a scan-and-compare-every-hash.
- **Two isolation layers, deliberately.** App-level filtering is what actually
  runs; RLS is the thing that saves you when someone forgets. Relying only on RLS
  is fragile with connection pooling (a leaked `SET` on a pooled connection is a
  cross-tenant read), so RLS is the backstop, not the primary.
- **Schema/DB per tenant rejected**: migration fan-out and connection-count blowup
  on Neon; wrong shape for a portfolio project that should stay legible.

## Enforcement

- ESLint boundaries rule: no SQL outside `src/modules/*/repo.ts`.
- Every repo function's first parameter is `tenantId`; a type-level brand
  (`TenantId`) prevents passing a bare string or the wrong id.
- "Cross-tenant probe" integration suite: for every route, call it with another
  tenant's resource id and assert `404` (not `403` — no existence leak).
- A route-table test fails CI if any route omits a required-scope declaration.

## Consequences

- Positive: instant revocation, cheap verification, defense in depth, an
  `audit_log` trail per key.
- Negative: keys are shown once at creation and unrecoverable; the UX burden of
  rotation falls on the client. Mitigated by allowing multiple active keys per
  tenant so rotation is overlap-then-revoke.
- Negative: RLS adds a `SET LOCAL app.tenant_id` on every checkout and a small
  planner cost on tenant-scoped queries; measured at <3% and accepted.

## Implementation notes (amendments)

Three things changed between the decision and the code. All three make the
system stricter, not looser.

1. **Peppered HMAC-SHA256 instead of Argon2id.** Argon2id exists to slow down
   guessing of low-entropy human secrets. These secrets are 256 CSPRNG bits, so
   guessing is already off the table, and the realistic threat is a leaked
   database — which a *server-side pepper* defeats, because the pepper lives in
   the secret store and never in Postgres. In exchange, verification is
   sub-millisecond, which turns the Redis cache from a requirement into an
   optimisation: the API stays correct and fast with Redis down. Comparison is
   `timingSafeEqual`, and the hash comparison runs before the revoked/expired
   checks so response timing does not reveal key state. Rotating
   `API_KEY_PEPPER` invalidates every key at once — the intended break-glass.

2. **Revocation is immediate, not "within one TTL".** The original design
   accepted 60 s of exposure after revoking a leaked key. Instead, revoking
   writes a tombstone (`auth:revoked:<id>`, TTL 10× the cache TTL) that is
   checked on every cache hit, and the stale entry is deleted on sight. Only
   *successful* verifications are ever cached, so a failing key cannot be
   promoted by cache poisoning, and the cache holds no secret material — just
   `{apiKeyId, organizationId, role, prefix}` under a SHA-256 of the token. Any
   Redis error degrades to a direct database verification.

3. **RLS deferred, not adopted.** Application-level `organizationId` filtering
   plus route-level policies ship now; Postgres RLS is still the intended
   backstop but is not in this change, so the "two independent nets" claim above
   is aspirational until it lands. What compensates today: the organization is
   resolved *only* from the authenticated key (never from a request header, and
   an `x-organization-id` header is now ignored outright), and cross-tenant
   probes are tested per route. This is written down rather than quietly
   dropped, because the gap matters.

Also decided during implementation:

- **Roles, not scopes, for v1**: `admin ⊃ writer ⊃ reader`. Scopes are a v2 item.
- **Uniform 401s**: unknown, malformed, wrong-environment, expired and revoked
  keys all return the same body. The distinguishing reason is logged, never
  returned, so the API is not a key-state oracle. Cross-tenant key ids return
  404 for the same reason.
- **Bootstrap path**: `POST /v1/bootstrap` mints the first organization and admin
  key. Three independent guards keep it out of production — `loadEnv` refuses to
  boot when `BOOTSTRAP_ENABLED=true` and `NODE_ENV=production`, `buildApp` only
  registers the route outside production, and the route requires its own shared
  secret (`BOOTSTRAP_TOKEN`, compared in constant time). Production also refuses
  to boot on the default development pepper.

## Implementation status (correction)

Shipped: the key format, peppered HMAC verification, the prefix index, the
Redis principal cache with revocation tombstones, role hierarchy, the
`404`-not-`403` cross-organization behaviour, and the route-table test that
fails when a route omits its policy declaration.

Not shipped:

- **Postgres row-level security.** There is one isolation layer, not two: every
  service query filters on the `organization_id` taken from the verified
  principal. RLS remains the right backstop and is an additive migration, but
  claiming defense in depth that does not exist would be worse than the gap.
- **The ESLint boundaries rule and the `TenantId` brand.** Services hold their
  own SQL and take a plain `organizationId: string`. Isolation is enforced by
  tests (cross-organization probes) rather than by the type system.
