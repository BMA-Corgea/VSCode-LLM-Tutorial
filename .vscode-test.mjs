// SPDX-License-Identifier: AGPL-3.0-or-later
// @vscode/test-cli config. `npm test` (scripts/run-tests.mjs) invokes the `vscode-test` binary
// this drives; see that script for why it runs under xvfb-run in CI and directly on a desktop.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // Non-recursive on purpose (T-3): dist/test/unit/ holds the plain-mocha bundle
  // (`npm run test:unit`, no `vscode` import anywhere in it) — vscode-test only ever picks
  // up the files that need a real extension host, directly under dist/test/.
  // `BT_VSCODE_TEST_FILES` narrows a run to one file during development
  // (`BT_VSCODE_TEST_FILES=dist/test/start-screen.test.js xvfb-run -a node scripts/run-tests.mjs`);
  // unset, every vscode-test file runs, as before.
  files: process.env.BT_VSCODE_TEST_FILES || 'dist/test/*.test.js',
  // T-15: lets a test read what is actually ON SCREEN in a webview (test/support/screen.ts).
  // Port 0 = a port the OS picks; Chromium binds it to 127.0.0.1 and it closes when this test
  // host exits. TEST HOST ONLY: this file is excluded from the .vsix (.vscodeignore), and
  // test/unit/screen-port.test.ts fails if the flag ever appears in anything that ships.
  launchArgs: ['--remote-debugging-port=0'],
  mocha: {
    // Loading four tree-sitter grammars and shelling out to `claude --version` both take
    // real wall time; mocha's 2s default is tuned for pure-JS unit tests, not this.
    timeout: 60_000,
  },
});
