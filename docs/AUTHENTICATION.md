# Authentication and tenancy

Machine-to-machine only. Every request outside `/health/*` carries an opaque API
key, and the organization is derived from that key — never from a header the
caller controls. Design rationale lives in [ADR-0007](adr/0007-api-key-auth-and-tenant-isolation.md).

## Key format

```
lf_test_9f21c0b4a7d3e5f8.k3Qk...43-chars...
│  │    │                 └── secret: 256 CSPRNG bits, base64url, shown once
│  │    └── prefix: public, unique, indexed lookup handle
│  └── environment tag: live in production, test everywhere else
└── product prefix (greppable in leaked-secret scanners)
```

Storage keeps `prefix` and `HMAC-SHA256(API_KEY_PEPPER, secret)`. The plaintext
key exists in exactly one response body and is never recoverable afterwards.

## Sending a key

```bash
curl -H "Authorization: Bearer lf_test_9f21…" https://api.example.com/v1/me
# X-Api-Key: lf_test_9f21…  also accepted
```

Every rejection — missing, malformed, unknown, expired, revoked, or the wrong
environment tag — returns the same `401 unauthorized` body. The specific reason
is logged server-side.

## Roles

| Role     | Ledger reads | Ledger writes | Key management |
| -------- | ------------ | ------------- | -------------- |
| `reader` | ✅           | —             | —              |
| `writer` | ✅           | ✅            | —              |
| `admin`  | ✅           | ✅            | ✅             |

Roles are hierarchical. Each route declares the minimum role it needs; a route
that forgets to declare one is treated as admin-only, and a test fails CI.

## Endpoints

| Method   | Path                    | Role     | Notes                                    |
| -------- | ----------------------- | -------- | ---------------------------------------- |
| `GET`    | `/v1/me`                | `reader` | Identity of the calling key              |
| `POST`   | `/v1/api-keys`          | `admin`  | Returns the plaintext token once         |
| `GET`    | `/v1/api-keys`          | `admin`  | Redacted; secrets are never listed       |
| `DELETE` | `/v1/api-keys/{id}`     | `admin`  | Idempotent; `?reason=` is recorded       |
| `POST`   | `/v1/bootstrap`         | public   | Non-production only, see below           |

## Rotation

Overlap, then revoke:

1. `POST /v1/api-keys` for the replacement.
2. Deploy it.
3. Confirm the old key has stopped being used (`lastUsedAt` in the key list).
4. `DELETE /v1/api-keys/{old}` — effective immediately, including for requests
   that would otherwise have been served from the auth cache.

Multiple active keys per organization are allowed precisely so rotation never
needs a downtime window.

## Bootstrap (development only)

The first admin key has to come from somewhere. In development:

```bash
export BOOTSTRAP_ENABLED=true BOOTSTRAP_TOKEN=$(openssl rand -hex 24)
npm run dev

curl -X POST localhost:3000/v1/bootstrap \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"organizationName":"Acme","organizationSlug":"acme"}'
```

It cannot be turned on by accident in production: the process refuses to start
when `BOOTSTRAP_ENABLED=true` and `NODE_ENV=production`, the route is not
registered in production even if that check were bypassed, and it still demands
its own shared secret. Production also refuses to boot on the default
development value of `API_KEY_PEPPER`.

## Configuration

| Variable                 | Default        | Purpose                                            |
| ------------------------ | -------------- | -------------------------------------------------- |
| `API_KEY_PEPPER`         | dev-only value | Server-side pepper; rotating it invalidates all keys |
| `AUTH_CACHE_TTL_SECONDS` | `60`           | Verification cache TTL; `0` disables the cache      |
| `BOOTSTRAP_ENABLED`      | `false`        | Enables `POST /v1/bootstrap` (non-production only)  |
| `BOOTSTRAP_TOKEN`        | —              | Required when bootstrap is enabled                  |
