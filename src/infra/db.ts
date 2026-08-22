import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Env } from '../config/env.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createDatabase(env: Env): DatabaseHandle {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    application_name: 'ledgerflow',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // A pool-level error handler is required; otherwise an idle client error
  // crashes the process.
  pool.on('error', () => undefined);

  return {
    db: drizzle(pool, { schema }),
    pool,
    ping: async () => {
      await pool.query('select 1');
    },
    close: async () => {
      await pool.end();
    },
  };
}
