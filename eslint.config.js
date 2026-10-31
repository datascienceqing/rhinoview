import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // .claude holds agent worktrees: full copies of the repo that the path rules below do not match.
  { ignores: ['dist', 'node_modules', 'public', 'coverage', '.claude'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['server/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The browser bundle must never reference process.env; the key lives server-side.
      'no-restricted-globals': ['error', { name: 'process', message: 'Server-only. Client code must not read process.env.' }],
    },
  },
  {
    files: ['server/**/*.ts', 'vite.config.ts', 'eslint.config.js', '**/*.test.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
