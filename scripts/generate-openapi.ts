import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/infra/logger.js';
import { createDatabase } from '../src/infra/db.js';

/** Emits openapi.json without needing live dependencies (routes are never called). */
const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://localhost:5432/ledgerflow',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
});
const database = createDatabase(env);
const app = await buildApp({
  env,
  logger: createLogger(env),
  db: database.db,
  dbPing: () => Promise.resolve(),
  redisPing: () => Promise.resolve(),
});
await app.ready();
await writeFile('openapi.json', JSON.stringify(app.swagger(), null, 2));
await app.close();
await database.close();
console.log('wrote openapi.json');
