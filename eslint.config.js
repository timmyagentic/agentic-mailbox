import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'outputs/**', 'node_modules/**', 'mobile/node_modules/**', 'mobile/android/**', 'mobile/ios/**', 'mobile/.expo/**', '.wrangler/**', 'worker-configuration.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/client/**/*.{ts,tsx}', 'mobile/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, process: 'readonly', __DEV__: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['src/worker/**/*.ts'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  { files: ['mobile/*.cjs'], languageOptions: { globals: globals.node }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  {
    files: ['scripts/*.mjs', 'tests/**/*.{ts,mjs}', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
