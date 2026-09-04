#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm test` — runs the real `vscode-test` binary, wrapped in `xvfb-run -a` exactly when
// there is no DISPLAY to draw the Extension Development Host into (CI). On a desktop with a
// real or virtual X server already set (DISPLAY set), it runs directly (AC8).
import { spawnSync } from 'node:child_process';

const needsXvfb = !process.env.DISPLAY;
const command = needsXvfb ? 'xvfb-run' : 'npx';
const args = needsXvfb ? ['-a', 'npx', 'vscode-test'] : ['vscode-test'];

console.log(`[run-tests] DISPLAY=${process.env.DISPLAY ?? '(unset)'} -> ${command} ${args.join(' ')}`);
const result = spawnSync(command, args, { stdio: 'inherit' });

if (result.error) {
  console.error(`[run-tests] failed to launch "${command}": ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
