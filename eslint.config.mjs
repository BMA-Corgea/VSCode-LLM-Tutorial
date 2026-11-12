// SPDX-License-Identifier: AGPL-3.0-or-later
// Flat ESLint config. repo-tour itself leans on `tsc --strict` alone and ships no eslint
// config; this extension adds one because `npm run lint` is one of T-2's named checks.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // .autodev/ and kb/days/ are the local factory ledger and day pages: untracked by design
    // (autodev/instructions/public-repo.md), so they exist only in the main checkout, never in a
    // worktree or a clone, and their working files are not this project's source.
    ignores: ['dist/**', 'out/**', '.vscode-test/**', '.scratch/**', 'node_modules/**', '*.vsix', '.autodev/**', 'kb/days/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    // `extends` here scopes the type-checked presets to THIS block's `files` glob only —
    // without it they apply eslint-wide and crash on the plain-JS config/script files, which
    // are not part of tsconfig.json's program.
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // noUncheckedIndexedAccess plus these already push toward correctness; the extra
      // any-flavoured type-checked rules mostly fire on `unknown` from dynamic import()
      // in src/core.ts, which is deliberate — that boundary is exactly where we do NOT
      // have static types for repo-tour's modules.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // `.mocharc.cjs` is CommonJS so that it can hand mocha an absolute path (T-81).
    files: ['*.mjs', 'scripts/**/*.mjs', '.mocharc.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
