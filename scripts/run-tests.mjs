#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm test` — runs the real `vscode-test` binary, wrapped in `xvfb-run -a` exactly when
// there is no DISPLAY to draw the Extension Development Host into (CI). On a desktop with a
// real or virtual X server already set (DISPLAY set), it runs directly (AC8).
//
// T-81: the run starts inside a temp folder of its own, as a process group of its own (xvfb-run,
// Xvfb, vscode-test, VS Code and its extension hosts), and this script removes that folder once
// every process of the group has ended. Everything the test hosts make in the temp folder goes in
// it: the tests' fixtures, and what VS Code makes there for itself. A SIGINT, SIGTERM or SIGHUP sent
// to this script goes to the whole group, not just to xvfb-run, which as a dash script dies of one
// without stopping its Xvfb (T-81 review F1). Then this script dies of the same signal.
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
