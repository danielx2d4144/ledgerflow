// @ts-check
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  // `load/` is k6 scripts: they run in the k6 runtime (remote imports, `__ENV`),
  // not in Node, so type-aware linting cannot resolve them.
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**', 'load/**']),
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Fastify plugins must be async by contract even when they never await.
    files: ['src/**/*.routes.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Tests deliberately assert on loosely typed HTTP JSON payloads.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettier,
);
