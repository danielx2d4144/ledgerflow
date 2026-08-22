import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/infra/migrate.js';
import { startTestPostgres } from './pg-test-server.js';

export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('databaseUrl', process.env.TEST_DATABASE_URL);
    await runMigrations(process.env.TEST_DATABASE_URL);
    return () => undefined;
  }

  const postgres = await startTestPostgres();
  await runMigrations(postgres.url);
  project.provide('databaseUrl', postgres.url);
  return async () => {
    await postgres.stop();
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}
