# Webhooks, the outbox and the audit log

## Event flow

```
POST /v1/transactions
  └─ one database transaction
       ├─ transactions + entries          (the money)
       ├─ audit_events                    (who did it, append-only)
       └─ outbox_events (status=pending)  (what to publish)
             ↓  worker poll, FOR UPDATE SKIP LOCKED, every OUTBOX_POLL_INTERVAL_MS
       webhook_deliveries, one row per (endpoint, event)   ← unique index
             ↓  BullMQ job (Redis), jobs carry only the delivery id
       HTTP POST to the endpoint, HMAC-signed
             ↓
       succeeded | pending (retry, backoff) | dead_letter
```

**The invariant**: the outbox row is written by the same transaction as the state
change. If the transaction rolls back there is no event; if it commits the event
is durable. Nothing enqueues to Redis before the commit, so there is no dual
write. `tests/audit-outbox.test.ts` asserts both directions.

## Delivery semantics

At-least-once. A crash between "receiver responded 200" and "row marked
succeeded" replays the attempt, and replay controls can deliberately re-send.
Every request carries a stable `X-LedgerFlow-Event-Id`; **receivers must
deduplicate on it**. Exactly-once is not offered — it is not achievable across an
HTTP boundary.

Ordering is **not** guaranteed (see ADR-0005). Sort by the payload's `createdAt`
if order matters.

## Signature verification

Headers on every attempt:

| Header | Meaning |
| --- | --- |
| `X-LedgerFlow-Event-Id` | Stable event id — deduplicate on this |
| `X-LedgerFlow-Delivery-Id` | This delivery row (stable across retries) |
| `X-LedgerFlow-Attempt` | 1-based attempt counter |
| `X-LedgerFlow-Timestamp` | Unix seconds, part of the signed string |
| `X-LedgerFlow-Signature` | `v1=<hex HMAC-SHA256>` |

The signed string is `` `${timestamp}.${rawBody}` `` — the timestamp is included
so a captured request cannot be replayed forever.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, headers, secret) {
  const timestamp = Number(headers['x-ledgerflow-timestamp']);
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false; // stale
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const presented = headers['x-ledgerflow-signature'];
  return (
    expected.length === presented.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
  );
}
```

Verify against the **raw** body, before JSON parsing.

## Secrets

Shown exactly once, at creation and on rotation. Stored AES-256-GCM encrypted
because signing needs the plaintext — see ADR-0008. Listings only expose
`secretLastFour`. Rotation is immediate: attempts that start after the rotation
use the new secret, so rotate during a quiet window or accept a few failures that
you can replay.

## Retries, backoff and the dead letter state

- `WEBHOOK_MAX_ATTEMPTS` (default 6) total attempts per delivery.
- Exponential backoff with full jitter: `min(base * 2^(n-1), max)`, halved and
  jittered, defaults 2 s → 1 h cap.
- Retryable: connection errors, timeouts, `5xx`, `408`, `429`.
- **Not** retryable: any other `4xx` (the request is wrong, retrying burns
  quota), a disabled endpoint, and a URL that fails the SSRF guard. These go
  straight to `dead_letter`.
- `dead_letter` deliveries are inert; the executor refuses to touch them until an
  operator replays.

## Replay controls

| Endpoint | Effect |
| --- | --- |
| `POST /v1/webhook-deliveries/{id}/replay` | Grants a fresh attempt budget (`maxAttempts += WEBHOOK_MAX_ATTEMPTS`) and re-queues. Attempt counter is **not** reset — it stays an honest record of what the receiver has seen. |
| `POST /v1/events/{id}/replay` | Re-runs fan-out for one event, e.g. after registering a new endpoint. Existing dead-letter rows are returned to `pending` with a fresh attempt budget; other existing `(endpoint, event)` rows are kept. |

Both are admin-only and write an append-only audit row.

## SSRF protections

At registration *and* before every attempt:

- scheme must be `https` (plain `http` only when `WEBHOOK_ALLOW_INSECURE_HTTP`,
  which production refuses);
- no embedded credentials;
- a deny-list of sensitive ports (22, 25, 5432, 6379, …);
- literal loopback/private/link-local/CGNAT/multicast addresses rejected,
  including IPv6 and IPv4-mapped forms, and `169.254.169.254` in particular;
- `localhost`, `*.localhost` and `*.internal` rejected;
- DNS is resolved immediately before the request and every answer must be
  public;
- `redirect: 'manual'` — a `302` into the metadata service is the classic bypass.

**Residual risk (accepted, documented):** the resolve-then-connect gap is a DNS
rebinding window. Closing it needs a connector pinned to the vetted IP (a custom
`undici` dispatcher). Egress should additionally be restricted at the network
layer in production.

## Observability

`webhook_deliveries` carries `attempt`, `maxAttempts`, `nextAttemptAt`,
`responseStatus`, `responseSnippet` (512 bytes), `error`, `durationMs`,
`deliveredAt`. `webhook_endpoints` carries `consecutiveFailures`, `lastSuccessAt`,
`lastFailureAt`. The worker logs one structured line per attempt with the
outcome, attempt number and duration. Alert on `status='dead_letter'` count and
  on endpoints with a high `consecutiveFailures`.

`responseSnippet` contains up to 512 bytes returned by the third-party receiver.
Treat it as untrusted content; it is stored for diagnostics and exposed through
the delivery API without being interpreted as LedgerFlow-generated text.

## Audit log

`audit_events` is append-only — a trigger raises on `UPDATE`/`DELETE`, so the
application role cannot rewrite history. Rows record actor (`api_key` id or
`system`), action, resource, `requestId` (the same id as the HTTP log line) and
IP. Secrets are never written to `metadata`. Actions currently emitted:
`account.created`, `transaction.created`, `api_key.issued`, `api_key.revoked`,
`webhook_endpoint.created|updated|deleted|secret_rotated`,
`webhook_delivery.replayed`, `outbox_event.replayed`.

## Running the worker

```bash
npm run build && node dist/worker.js     # or: npm run worker:dev
docker compose --profile app up worker   # alongside the API
```

The worker is horizontally scalable: claims use `FOR UPDATE SKIP LOCKED`, so
extra instances need no coordination. It is the only process that consumes the
queue; the API only enqueues replays.
