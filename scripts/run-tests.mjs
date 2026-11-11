#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm test` — runs the real `vscode-test` binary, wrapped in `xvfb-run -a` exactly when
// there is no DISPLAY to draw the Extension Development Host into (CI). On a desktop with a
// real or virtual X server already set (DISPLAY set), it runs directly (AC8).
//
// T-81: the run starts inside a temp folder of its own, and this script removes that folder when
// the run ends. Everything the test hosts make goes in it: the tests' fixtures, and what VS Code
// makes for itself. A SIGINT, SIGTERM or SIGHUP sent to this script is passed on to the run, which
// then stops; this script cleans up after it and dies of the same signal (scripts/test-tmp.mjs).
import { exitLike, spawnInTestTmp } from './test-tmp.mjs';

const needsXvfb = !process.env.DISPLAY;
const command = needsXvfb ? 'xvfb-run' : 'npx';
// Anything after the script's name goes to vscode-test as it is: `--label screen` runs one host.
const extra = process.argv.slice(2);
const args = needsXvfb ? ['-a', 'npx', 'vscode-test', ...extra] : ['vscode-test', ...extra];

console.log(`[run-tests] DISPLAY=${process.env.DISPLAY ?? '(unset)'} -> ${command} ${args.join(' ')}`);
const result = await spawnInTestTmp(command, args, 'vscode', { startsVsCode: true });

if (result.error) {
  console.error(`[run-tests] failed to launch "${command}": ${result.error.message}`);
  process.exit(1);
}
exitLike(result);
