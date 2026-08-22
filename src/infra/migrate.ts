import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from '../config/env.js';
import { createDatabase } from './db.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(databaseUrl?: string): Promise<void> {
  const env = loadEnv({
    // Migrations only need the database; other services are irrelevant here.
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...process.env,
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  });
  const database = createDatabase(env);
  try {
    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
