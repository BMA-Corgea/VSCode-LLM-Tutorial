// SPDX-License-Identifier: AGPL-3.0-or-later
// @vscode/test-cli config. `npm test` (scripts/run-tests.mjs) invokes the `vscode-test` binary
// this drives; see that script for why it runs under xvfb-run in CI and directly on a desktop.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/**/*.test.js',
  mocha: {
    // Loading four tree-sitter grammars and shelling out to `claude --version` both take
    // real wall time; mocha's 2s default is tuned for pure-JS unit tests, not this.
    timeout: 60_000,
  },
});
