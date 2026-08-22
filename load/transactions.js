/**
 * k6 load profile for the money path: POST /v1/transactions with a unique
 * Idempotency-Key per request, interleaved with balance reads.
 *
 * Setup creates one organization's worth of accounts up front using an admin
 * key, so the measured phase only exercises the hot path.
 *
 * Usage (see docs/LOAD-TESTING.md for the full method):
 *   BASE_URL=http://localhost:3000 API_KEY=lf_test_... k6 run load/transactions.js
 *
 * No results are committed to this repo. Numbers depend entirely on the host,
 * the Postgres plan and the network, so a number without its environment is
 * marketing, not evidence.
 */
import http from 'k6/http';
import { check, group } from 'k6';
import { Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY;
const CURRENCY = __ENV.CURRENCY || 'USD';
const ACCOUNTS = Number(__ENV.ACCOUNTS || 8);

const postLatency = new Trend('transaction_post_duration', true);
const readLatency = new Trend('balance_read_duration', true);

export const options = {
  scenarios: {
    // Ramp to find the knee, then hold. Adjust to the machine under test.
    ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: __ENV.WARMUP || '30s', target: Number(__ENV.VUS || 20) },
        { duration: __ENV.DURATION || '2m', target: Number(__ENV.VUS || 20) },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  // Fail the run rather than reporting a "successful" test that was mostly errors.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // Deliberately loose: this is a smoke gate, the report is the p50/p95/p99.
    transaction_post_duration: ['p(99)<2000'],
  },
};

function headers(extra = {}) {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...extra };
}

export function setup() {
  if (!API_KEY) throw new Error('API_KEY is required (an admin or writer key)');
  const ids = [];
  for (let i = 0; i < ACCOUNTS; i += 1) {
    const reference = `load-${uuidv4().slice(0, 12)}`;
    const response = http.post(
      `${BASE_URL}/v1/accounts`,
      JSON.stringify({ name: `Load ${i}`, reference, type: 'asset', currency: CURRENCY }),
      { headers: headers() },
    );
    if (response.status !== 201) {
      throw new Error(`account setup failed: ${response.status} ${response.body}`);
    }
    ids.push(response.json('id'));
  }
  return { accountIds: ids };
}

export default function main(data) {
  const { accountIds } = data;
  const from = accountIds[Math.floor(Math.random() * accountIds.length)];
  let to = from;
  while (to === from) to = accountIds[Math.floor(Math.random() * accountIds.length)];
  const amount = String(1 + Math.floor(Math.random() * 10_000));

  group('post transaction', () => {
    const response = http.post(
      `${BASE_URL}/v1/transactions`,
      JSON.stringify({
        description: 'load test transfer',
        currency: CURRENCY,
        entries: [
          { accountId: from, amount: `-${amount}` },
          { accountId: to, amount },
        ],
      }),
      { headers: headers({ 'Idempotency-Key': uuidv4() }), tags: { endpoint: 'transactions' } },
    );
    postLatency.add(response.timings.duration);
    check(response, { 'transaction created': (r) => r.status === 201 });
  });

  // One read per four writes: reads are cheap but they are what dashboards hit.
  if (Math.random() < 0.25) {
    group('read balance', () => {
      const response = http.get(`${BASE_URL}/v1/accounts/${to}`, {
        headers: headers(),
        tags: { endpoint: 'account' },
      });
      readLatency.add(response.timings.duration);
      check(response, { 'balance read': (r) => r.status === 200 });
    });
  }
}
