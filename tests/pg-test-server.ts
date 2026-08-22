import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Boots an in-process Postgres (PGlite) exposed over the real wire protocol, so
 * tests exercise the same `pg` driver, SQL and triggers as production. Avoids
 * requiring Docker in CI sandboxes; a real Postgres container can be swapped in
 * by setting TEST_DATABASE_URL.
 */
export async function startTestPostgres(port = 55_432): Promise<TestPostgres> {
  const dataDir = await mkdtemp(join(tmpdir(), 'ledgerflow-pglite-'));
  const pglite = await PGlite.create({ dataDir });
  const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
  await server.start();

  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      await pglite.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
