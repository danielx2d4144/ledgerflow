# Load testing

There are **no benchmark numbers in this repository**. Throughput and latency of
a ledger are dominated by the Postgres instance, the disk behind it and the
network between the API and the database; a number quoted without that context
would be decoration. What is committed is a reproducible method, so anyone can
produce numbers for their own environment and compare like with like.

## What the profile measures

`load/transactions.js` (k6) drives the money path:

- `POST /v1/transactions` — two-entry transfers between a small pool of
  accounts, each with a unique `Idempotency-Key`, so every request does the full
  work: idempotency insert, `SELECT … FOR UPDATE` on the accounts, transaction +
  entries insert, audit row, outbox row, deferred balance-trigger check at commit.
- `GET /v1/accounts/{id}` on ~25% of iterations — balances are derived by
  aggregating `entries`, so read cost grows with entry count and is worth watching.

Account contention is deliberate: a small pool (`ACCOUNTS`, default 8) makes row
locks and deadlock behaviour visible. Raise it to measure the uncontended ceiling.

## Method

1. **Isolate the database.** Run Postgres on the same machine (`docker compose up -d postgres redis`)
   for a floor measurement, or against the target managed instance for a real
   one. Record the plan/instance size, region and whether a pooler is in front.
2. **Run the API as it is deployed:** built output, `NODE_ENV=production`, one
   process, `DATABASE_POOL_MAX` at the deployed value.

   ```bash
   npm run build
   NODE_ENV=production DATABASE_URL=... REDIS_URL=... API_KEY_PEPPER=... \
     WEBHOOK_SECRET_KEY=$(openssl rand -base64 32) node dist/server.js
   ```

3. **Create a writer key** (bootstrap once, then issue a key):

   ```bash
   BOOTSTRAP_ENABLED=true BOOTSTRAP_TOKEN=… node dist/server.js   # first run only
   curl -sX POST localhost:3000/v1/bootstrap -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
     -d '{"organizationName":"Load","organizationSlug":"load"}' -H 'content-type: application/json'
   ```

4. **Warm up, then measure.** The profile ramps for 30 s before the measured
   hold; discard anything shorter. JIT, pool fill and page cache all move the
   first seconds by a lot.

   ```bash
   BASE_URL=http://localhost:3000 API_KEY=lf_live_… VUS=20 DURATION=2m \
     k6 run --summary-export=load/results/$(date +%F-%H%M).json load/transactions.js
   ```

5. **Find the knee, don't cherry-pick a peak.** Repeat at increasing `VUS`
   (5, 10, 20, 40, 80) and plot p95 against throughput. The useful number is the
   highest arrival rate where p99 stays inside your budget and
   `http_req_failed` stays at 0 — not the largest requests/second the tool prints.
6. **Record the environment with the numbers.** Node version, host CPU/RAM,
   Postgres version and plan, pooler, region, `DATABASE_POOL_MAX`, and whether
   the webhook worker was running (it competes for the same database).

Results belong in a run log or a PR comment, next to that environment
description. `load/results/` is git-ignored on purpose.

## Interpreting failures

| Symptom                                    | Usual cause                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `429` responses                            | Rate limiter, not capacity. Raise `RATE_LIMIT_MAX` for the run or it is all you measure. |
| p99 spikes with flat throughput            | Row-lock contention on the account pool. Increase `ACCOUNTS`.                    |
| `503` from `/health/ready`                 | Pool exhaustion — `DATABASE_POOL_MAX` too low for the VU count.                  |
| Rising latency after minutes at steady load| Entry table growth affecting balance reads, or outbox backlog if the worker is off. |

## Without k6

`autocannon` can hammer a single prepared request and is enough for a rough
read-side number, but it cannot generate a unique `Idempotency-Key` per request,
so it cannot exercise the write path honestly — repeated keys are served from
the idempotency replay cache and measure the wrong thing. Use it for
`GET /v1/accounts/{id}` only:

```bash
npx autocannon -c 20 -d 30 -H "Authorization: Bearer $API_KEY" \
  http://localhost:3000/v1/accounts/$ACCOUNT_ID
```
