// Lint: `npm run lint` (development only, see package.json)
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

const CLI = 'bin/bundle-lockfile-from-metafile'; // (bin/node is a shell script)

export default [
  // fixture apps are built by the bundlers under test, not run as bundle-lockfile's code
  { ignores: ['**/node_modules/', 'test/apps/', 'dist/', 'dist-oracle/'] },
  {
    files: ['**/*.cjs', CLI],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022, globals: globals.node },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2022, globals: globals.node },
  },
  {
    files: ['**/*.cjs', '**/*.mjs', CLI],
    ...js.configs.recommended,
  },
  {
    files: ['**/*.cjs', '**/*.mjs', CLI],
    rules: {
      'no-shadow': 'error',
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  // the code that runs in builds: lines a reader can take in (messages stay whole, for grep; test data and expectations
  // may be longer)
  {
    files: ['src/**', CLI],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/max-len': ['error', { code: 160, ignoreUrls: true, ignoreRegExpLiterals: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  },
];
