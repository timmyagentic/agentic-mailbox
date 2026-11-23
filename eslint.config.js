import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'outputs/**', 'node_modules/**', '.wrangler/**', 'worker-configuration.d.ts', 'website/public/product-ui/**'] },
  { files: ['website/interface/build.mjs'], languageOptions: { globals: globals.node } },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
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
  {
    files: ['scripts/*.mjs', 'tests/**/*.{ts,mjs}', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
