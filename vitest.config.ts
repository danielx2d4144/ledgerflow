import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entrypoints and thin infrastructure adapters are exercised by
      // running the app (compose / deploy), not by the test suite. Counting
      // them would only produce a number that has to be argued down later.
      exclude: [
        'src/server.ts',
        'src/worker.ts',
        'src/infra/migrate.ts',
        'src/infra/redis.ts',
        'src/infra/schema.ts',
        'src/modules/webhooks/bullmq-queue.ts',
        'src/modules/webhooks/queue.ts',
      ],
      reporter: ['text', 'lcov'],
      // Thresholds sit just under the measured baseline (see docs/DEVELOPMENT.md
      // "Coverage"). They are a ratchet against regression, not a target.
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 92,
        lines: 90,
      },
    },
  },
});
