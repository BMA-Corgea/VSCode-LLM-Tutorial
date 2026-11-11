#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `node scripts/check-tmp.mjs -- <command> [args...]`: T-81's outcome check, run the way CI runs it.
//
// It runs the command in a FRESH, private temp folder (TMPDIR, TMP and TEMP all point at it),
// counts what is in that folder before and after, and FAILS naming every entry the command left
// behind that is not on the short list below. CI's Test step runs `npm test` through it, so a test
// that leaks a temp folder fails the build with that folder's name, instead of filling a disk a
// week later. scripts/test-tmp.mjs is what keeps the suites clean; this is how we know it does.
//
// Exit status: the command's own status when the command failed. Otherwise 1 when anything was
// left behind and 0 when nothing was. The command runs as a process group of its own, and the count
// is taken once every process of it has ended. When this script is stopped by a signal, the whole
// group is too, and this script dies by the same signal. Afterwards the fresh folder is removed,
// leftovers and all, unless BUILD_TUTORIALS_KEEP_TMP asks to keep it.
//
// What it does not see (review F3): anything written outside TMPDIR. That is Xvfb's lock in /tmp,
// the sockets VS Code keeps in XDG_RUNTIME_DIR, and a host's run folder on the rare machine where it
// has to fall back to /tmp (scripts/test-tmp.mjs, `vscodeRunFolderBase`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exitLike, KEEP_ENV, keepWanted, removeTree, ROOT_PREFIX, runForwardingSignals } from './test-tmp.mjs';

/** What a run may leave in a fresh temp folder, and why each one is acceptable. */
const ALLOWED = new Map([
  [
    'node-compile-cache',
    "Node's compile cache. npm turns it on in its own CLI (npm/lib/cli.js calls module.enableCompileCache()) " +
      'before any test process starts. It is one folder reused by every run, not one per run.',
  ],
]);

const sep = process.argv.indexOf('--');
const [command, ...args] = sep === -1 ? [] : process.argv.slice(sep + 1);
if (command === undefined) {
  console.error('usage: node scripts/check-tmp.mjs -- <command> [args...]');
  process.exit(2);
}

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-tmp-check-'));
const before = new Set(fs.readdirSync(fresh));
console.log(`[check-tmp] fresh TMPDIR ${fresh} (${before.size} entries) -> ${[command, ...args].join(' ')}`);

const result = await runForwardingSignals(command, args, {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, TMPDIR: fresh, TMP: fresh, TEMP: fresh },
});

const added = fs.readdirSync(fresh).filter((name) => !before.has(name)).sort();
const left = added.filter((name) => !ALLOWED.has(name));
const kindOf = (name) => {
  const st = fs.lstatSync(path.join(fresh, name), { throwIfNoEntry: false });
  if (st === undefined) return 'gone';
  return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'folder' : 'file';
};

for (const name of added.filter((n) => ALLOWED.has(n))) console.log(`[check-tmp] allowed: ${name} (${ALLOWED.get(name)})`);
if (left.length === 0) {
  const extra = added.length === 0 ? 'nothing added' : added.length === 1 ? '1 entry added, allowed above' : `${added.length} entries added, each allowed above`;
  console.log(`[check-tmp] the temp folder is as it was: ${extra}`);
} else {
  console.error(`[check-tmp] FAIL: the command left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temp folder:`);
  for (const name of left) console.error(`  ${name}  (${kindOf(name)})`);
  if (left.some((name) => name.startsWith(ROOT_PREFIX)) && keepWanted(process.env[KEEP_ENV], true)) {
    console.error(`[check-tmp] (${KEEP_ENV}=${process.env[KEEP_ENV]} asks to keep run folders, so the bt-test-* ones among these may be kept on purpose)`);
  }
}

const failed = result.error !== undefined || result.code !== 0 || result.caught !== undefined || left.length > 0;
if (keepWanted(process.env[KEEP_ENV], failed)) {
  console.error(`[check-tmp] kept the checked folder (${KEEP_ENV}): ${fresh}`);
} else {
  try {
    removeTree(fresh);
  } catch (err) {
    console.error(`[check-tmp] could not remove ${fresh}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (result.error !== undefined) {
  console.error(`[check-tmp] could not start "${command}": ${result.error.message}`);
  process.exit(1);
}
if (result.caught !== undefined) exitLike(result);
else if (result.code !== 0) process.exit(result.code ?? 1);
else process.exit(left.length > 0 ? 1 : 0);
