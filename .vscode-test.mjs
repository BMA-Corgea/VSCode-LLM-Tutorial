// SPDX-License-Identifier: AGPL-3.0-or-later
// @vscode/test-cli config. `npm test` (scripts/run-tests.mjs) invokes the `vscode-test` binary
// this drives; see that script for why it runs under xvfb-run in CI and directly on a desktop.
// With no `--label`, vscode-test runs BOTH configurations below, one test host after the other;
// `node scripts/run-tests.mjs --label screen` runs one.
import { defineConfig } from '@vscode/test-cli';

const mocha = {
  // Loading four tree-sitter grammars and shelling out to `claude --version` both take
  // real wall time; mocha's 2s default is tuned for pure-JS unit tests, not this.
  timeout: 60_000,
};

export default defineConfig([
  {
    label: 'host',
    // Non-recursive on purpose (T-3): dist/test/unit/ holds the plain-mocha bundle
    // (`npm run test:unit`, no `vscode` import anywhere in it), and dist/test/screen/ has a test
    // host of its own below — this one only ever picks up the files directly under dist/test/.
    files: 'dist/test/*.test.js',
    mocha,
  },
  {
    // T-15: the tests that read what is actually ON SCREEN in a webview (test/support/screen.ts).
    label: 'screen',
    files: 'dist/test/screen/*.test.js',
    // A DevTools port the OS picks, bound to 127.0.0.1, closed when this test host exits — and
    // only THIS host, for the seconds these tests run. While it is open, ANY local process can
    // drive this test host through it: read and write its webviews, open a terminal and type into
    // it. That is what a test browser's debugging port is; do not run the suite on a host shared
    // with other users. Never in anything that ships: this file is excluded from the .vsix
    // (.vscodeignore), and test/unit/screen-port.test.ts fails if the flag reaches what does ship.
    launchArgs: ['--remote-debugging-port=0'],
    mocha,
  },
]);
