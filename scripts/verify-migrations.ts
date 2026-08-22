/**
 * Migration verification. Runs in CI (and locally) without needing Docker:
 * it boots the same wire-protocol Postgres the test suite uses, or a real one
 * when DATABASE_URL is set.
 *
 * Checks:
 *  1. every migration in drizzle/ is listed in the journal and vice versa;
 *  2. no migration contains a destructive statement unless it is explicitly
 *     marked `-- allow-destructive` (expand/contract discipline: a release must
 *     stay compatible with the previous image, because migrations run before
 *     the new one takes traffic);
 *  3. migrations apply cleanly to an empty database;
 *  4. re-running the migrator is a no-op (idempotent, so a retried deploy is safe);
 *  5. the objects the application depends on actually exist afterwards:
 *     tables, the deferred balance trigger, and the append-only audit guard.
 */
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { runMigrations } from '../src/infra/migrate.js';

const DESTRUCTIVE =
  /\b(DROP\s+(TABLE|COLUMN|CONSTRAINT|TYPE|INDEX)|TRUNCATE|ALTER\s+COLUMN\s+\w+\s+TYPE)\b/i;

const EXPECTED_TABLES = [
  'organizations',
  'accounts',
  'transactions',
  'entries',
  'idempotency_keys',
  'api_keys',
  'audit_events',
  'outbox_events',
  'webhook_endpoints',
  'webhook_deliveries',
];

/** Ask the OS for an unused port so concurrent runs never collide. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) console.log(`  ok   ${message}`);
  else {
    console.error(`  FAIL ${message}`);
    failures.push(message);
  }
}

const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
  entries: { tag: string }[];
};
const sqlFiles = (await readdir('drizzle')).filter((file) => file.endsWith('.sql')).sort();

console.log('journal / file parity');
check(
  journal.entries.length === sqlFiles.length,
  `journal lists ${journal.entries.length} migrations, drizzle/ has ${sqlFiles.length} .sql files`,
);
for (const entry of journal.entries) {
  check(sqlFiles.includes(`${entry.tag}.sql`), `journal entry ${entry.tag} has a matching file`);
}

console.log('destructive-statement scan');
for (const file of sqlFiles) {
  const sql = await readFile(`drizzle/${file}`, 'utf8');
  const destructive = DESTRUCTIVE.test(sql);
  const allowed = sql.includes('-- allow-destructive');
  check(!destructive || allowed, `${file} contains no unmarked destructive statement`);
}

const external = process.env.VERIFY_DATABASE_URL;

if (external) {
  await verify(external, { idempotency: true });
} else {
  // PGlite's socket server serves one client at a time and does not survive a
  // disconnect, so each phase gets a fresh server over the *same* data
  // directory. The database contents persist; only the listener is recycled.
  process.env.DATABASE_POOL_MAX = '1';
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  const dataDir = await mkdtemp(join(tmpdir(), 'ledgerflow-verify-'));
  const withServer = async <T>(fn: (url: string) => Promise<T>): Promise<T> => {
    const port = await freePort();
    const pglite = await PGlite.create({ dataDir });
    const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
    await server.start();
    try {
      return await fn(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
    } finally {
      await server.stop();
      await pglite.close();
    }
  };

  try {
    console.log('applying migrations to an ephemeral Postgres');
    await withServer((url) => runMigrations(url));
    console.log('  ok   first run applied');
    await withServer((url) => runMigrations(url));
    console.log('  ok   second run is a no-op');
    await withServer((url) => verify(url, { idempotency: false }));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} migration check(s) failed`);
  process.exit(1);
}
console.log('\nall migration checks passed');

async function verify(url: string, options: { idempotency: boolean }): Promise<void> {
  if (options.idempotency) {
    console.log('applying migrations to the configured database');
    await runMigrations(url);
    console.log('  ok   first run applied');
    await runMigrations(url);
    console.log('  ok   second run is a no-op');
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const present = new Set(tables.rows.map((row) => row.table_name));
    console.log('schema objects');
    for (const table of EXPECTED_TABLES) check(present.has(table), `table ${table} exists`);

    const trigger = await client.query<{ tgname: string; tgdeferrable: boolean }>(
      `SELECT tgname, tgdeferrable FROM pg_trigger WHERE tgname = 'entries_balanced_check'`,
    );
    check(trigger.rowCount === 1, 'balance trigger entries_balanced_check exists');
    check(trigger.rows[0]?.tgdeferrable === true, 'balance trigger is DEFERRABLE');

    const auditGuard = await client.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal`,
    );
    check((auditGuard.rowCount ?? 0) > 0, 'audit_events has an append-only guard trigger');

    const leaseColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'webhook_deliveries' AND column_name = 'lease_expires_at'`,
    );
    check(
      leaseColumn.rowCount === 1,
      'webhook_deliveries.lease_expires_at exists (delivery lease)',
    );

    const entryTenantFks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'entries'::regclass AND contype = 'f'
          AND conname IN ('entries_transaction_org_fk', 'entries_account_org_fk')`,
    );
    check(
      entryTenantFks.rowCount === 2,
      'entries carry composite tenant foreign keys to transactions and accounts',
    );

    const fillTrigger = await client.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'entries_fill_organization_id_trg'`,
    );
    check(fillTrigger.rowCount === 1, 'entries organization_id backfill trigger exists');

    // The invariant itself, end to end: an unbalanced transaction must fail at COMMIT.
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ('verify', 'verify-' || gen_random_uuid()) RETURNING id`,
    );
    const orgId = org.rows[0]?.id;
    const debit = await client.query<{ id: string }>(
      `INSERT INTO accounts (organization_id, name, reference, type, currency)
       VALUES ($1, 'a', 'verify-a-' || gen_random_uuid(), 'asset', 'USD') RETURNING id`,
      [orgId],
    );
    const credit = await client.query<{ id: string }>(
      `INSERT INTO accounts (organization_id, name, reference, type, currency)
       VALUES ($1, 'b', 'verify-b-' || gen_random_uuid(), 'asset', 'USD') RETURNING id`,
      [orgId],
    );
    const txn = await client.query<{ id: string }>(
      `INSERT INTO transactions (organization_id, description, currency)
       VALUES ($1, 'verify', 'USD') RETURNING id`,
      [orgId],
    );
    await client.query(
      `INSERT INTO entries (transaction_id, account_id, amount) VALUES ($1, $2, 100), ($1, $3, -99)`,
      [txn.rows[0]?.id, debit.rows[0]?.id, credit.rows[0]?.id],
    );
    let rejected = false;
    try {
      await client.query('COMMIT');
    } catch {
      rejected = true;
    }
    if (!rejected) await client.query('ROLLBACK');
    check(rejected, 'unbalanced transaction is rejected at COMMIT by the database');
  } finally {
    await client.end();
  }
}
