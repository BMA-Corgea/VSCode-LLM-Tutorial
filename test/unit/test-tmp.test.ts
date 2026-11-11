// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-81: a test run owns its temp folders, and the check proves it.
 *
 * Before T-81, a unit run left 390 folders in the machine's temp folder and a screen run left 34,
 * every time; three seats filled a shared root disk in one afternoon. `scripts/test-tmp.mjs` now
 * gives each run one private folder, points `os.tmpdir()` inside it for the whole run, and removes
 * it when the run ends.
 *
 * Every test here runs a REAL nested process, gives it a fresh temp folder of its own, and looks
 * at that folder afterwards:
 *   - a nested mocha run, through the door `.mocharc.cjs` loads into every mocha run here;
 *   - `scripts/run-tests.mjs`, the vscode-test door, with stand-ins for `xvfb-run` and `npx` first
 *     on PATH, so no VS Code starts;
 *   - `scripts/check-tmp.mjs`, the check CI runs the suites through.
 * The fresh folders are made inside THIS run's temp folder, so they go with it whatever happens here.
 */
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const MOCHA = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
const RUN_TESTS = path.join(ROOT, 'scripts', 'run-tests.mjs');
const CHECK = path.join(ROOT, 'scripts', 'check-tmp.mjs');
const KEEP = 'BUILD_TUTORIALS_KEEP_TMP';

/** A folder made at load, in a passing test, by a child process, by a worker, one left unwritable, and in a failing test. */
const MAKES = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const made = (where) => fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-' + where + '-'));
const AS = (where) => "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'fixture-" + where + "-'))";
made('load');
suite('a fixture that makes temp folders', function () {
  test('a passing test', function () { made('passing'); });
  test('a child process', function () { execFileSync(process.execPath, ['-e', AS('child')]); });
  test('a worker thread', function () {
    return new Promise((resolve, reject) => {
      const worker = new Worker(AS('worker'), { eval: true });
      worker.once('error', reject);
      worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('the worker exited ' + code))));
    });
  });
  test('a folder left unwritable', function () {
    const parent = made('unwritable');
    fs.mkdirSync(path.join(parent, 'inner'));
    fs.writeFileSync(path.join(parent, 'inner', 'file'), 'x');
    fs.chmodSync(path.join(parent, 'inner'), 0o500);
    fs.chmodSync(parent, 0o500);
  });
  test('a failing test', function () { made('failing'); throw new Error('this fixture fails on purpose'); });
});
`;
const MADE = ['fixture-load-', 'fixture-passing-', 'fixture-child-', 'fixture-worker-', 'fixture-unwritable-', 'fixture-failing-'];

/** Makes a folder, says READY, and waits to be stopped from outside. */
const WAITS = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
suite('a fixture that is stopped from outside', function () {
  test('waits', function () {
    this.timeout(0);
    fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-stopped-'));
    process.stdout.write('READY\\n');
    return new Promise(() => { setInterval(() => {}, 1000); });
  });
});
`;

/**
 * What \`run-tests.mjs\` finds first on PATH as \`xvfb-run\` and as \`npx\`: makes a folder, says where
 * its temp folder is, then exits with T81_FAKE_EXIT, or says READY and waits. It never outlives 30 s,
 * so a run-tests.mjs that fails to stop it cannot leave it running; a stop that arrives takes it
 * down at once, which is how the tests below tell the two apart.
 */
const FAKE = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
fs.mkdtempSync(path.join(os.tmpdir(), 'fake-vscode-'));
process.stdout.write('TMP ' + os.tmpdir() + '\\n');
setTimeout(() => process.exit(9), 30000);
if (process.env.T81_FAKE_MODE === 'wait') process.stdout.write('READY\\n');
else process.exit(Number(process.env.T81_FAKE_EXIT));
`;

let fixtures: string;
let fakeBin: string;

/** A fresh, empty folder to be one nested run's whole temp folder. */
function freshTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't81-fresh-'));
}

/** A nested run's environment: its temp folder is `tmp`, and it keeps nothing unless `extra` asks. */
function envFor(tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...extra };
  if (!(KEEP in extra)) delete env[KEEP];
  return env;
}

function left(tmp: string): string[] {
  return fs.readdirSync(tmp).sort();
}

interface Ran { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; afterSignalMs?: number }

function run(args: string[], env: NodeJS.ProcessEnv, cwd = ROOT): Ran {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  if (r.error) throw r.error;
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function mocha(spec: string, env: NodeJS.ProcessEnv, extra: string[] = [], cwd = ROOT): Ran {
  return run([MOCHA, '--ui', 'tdd', ...extra, path.join(fixtures, spec)], env, cwd);
}

/** Start `args`, wait until it prints READY, send it `signal`, and resolve how it ended and how long after the signal. */
function stopWhenReady(args: string[], env: NodeJS.ProcessEnv, signal: NodeJS.Signals): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let sentAt: number | undefined;
    const bound = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no READY, or no exit after ${signal}, within 45 s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (sentAt === undefined && stdout.includes('READY')) {
        sentAt = Date.now();
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (status, sig) => {
      clearTimeout(bound);
      resolve({ status, signal: sig, stdout, stderr, afterSignalMs: sentAt === undefined ? undefined : Date.now() - sentAt });
    });
  });
}

function said(r: Ran): string {
  return `\nexit ${r.status} signal ${r.signal}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
}

suite('T-81: a test run owns its temp folders', function () {
  // Each test starts real processes, and three foremen share this machine: load of 10-20 is ordinary.
  this.timeout(90_000);

  suiteSetup(() => {
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 't81-fixtures-'));
    fs.writeFileSync(path.join(fixtures, 'makes.cjs'), MAKES);
    fs.writeFileSync(path.join(fixtures, 'waits.cjs'), WAITS);
    fs.writeFileSync(path.join(fixtures, 'fake.cjs'), FAKE);
    fakeBin = path.join(fixtures, 'bin');
    fs.mkdirSync(fakeBin);
    for (const name of ['xvfb-run', 'npx']) {
      const stand = path.join(fakeBin, name);
      fs.writeFileSync(stand, `#!/bin/sh\nexec "${process.execPath}" "${path.join(fixtures, 'fake.cjs')}" "$@"\n`);
      fs.chmodSync(stand, 0o755);
    }
  });

  suite('the mocha door: every mocha run started here', () => {
    test('a run that FAILS leaves its temp folder as it was: what a test, a load, a child, a worker made, and a folder left unwritable, all gone', () => {
      const tmp = freshTmp();
      const r = mocha('makes.cjs', envFor(tmp));
      assert.equal(r.status, 1, `the fixture's one failing test should fail the run${said(r)}`);
      assert.match(r.stdout, /4 passing/, `the fixture did not run all its tests${said(r)}`);
      assert.deepEqual(left(tmp), [], `the run left these in its temp folder${said(r)}`);
    });

    test(`${KEEP}=1 keeps the run's folder, says where on stderr, and everything the run made is in it`, () => {
      const tmp = freshTmp();
      const r = mocha('makes.cjs', envFor(tmp, { [KEEP]: '1' }));
      const kept = /kept this run's temp folder \(BUILD_TUTORIALS_KEEP_TMP=1\): (\S+)/.exec(r.stderr)?.[1];
      assert.ok(kept !== undefined, `nothing said where the kept folder is${said(r)}`);
      assert.deepEqual(left(tmp), [path.basename(kept)], `the kept folder is not the one thing in the temp folder${said(r)}`);
      assert.equal(path.dirname(kept), tmp);
      assert.match(path.basename(kept), /^bt-test-unit-/);
      const inside = fs.readdirSync(kept);
      for (const prefix of MADE) {
        assert.ok(inside.some((name) => name.startsWith(prefix)), `${prefix}* was not made inside the run's folder: ${inside.join(', ')}`);
      }
    });

    test(`${KEEP}=failed keeps the folder of a run that fails, and nothing of one that passes`, () => {
      const passing = freshTmp();
      const p = mocha('makes.cjs', envFor(passing, { [KEEP]: 'failed' }), ['--grep', 'a passing test']);
      assert.equal(p.status, 0, `the passing half should pass${said(p)}`);
      assert.deepEqual(left(passing), [], `a passing run kept something${said(p)}`);

      const failing = freshTmp();
      const f = mocha('makes.cjs', envFor(failing, { [KEEP]: 'failed' }));
      assert.equal(f.status, 1, said(f));
      assert.equal(left(failing).length, 1, `a failing run should keep exactly its own folder${said(f)}`);
      assert.match(left(failing)[0] ?? '', /^bt-test-unit-/);
      assert.match(f.stderr, /kept this run's temp folder/);
    });

    test('a mocha run started in a folder BELOW the repository goes through the same door', () => {
      // Mocha finds its config by looking upward from where it was started, and resolves a relative
      // `require` against that folder: the door's path must not depend on where mocha starts.
      const tmp = freshTmp();
      const r = mocha('makes.cjs', envFor(tmp), [], path.join(ROOT, 'test', 'unit'));
      assert.match(r.stdout, /4 passing/, `the fixture did not run${said(r)}`);
      assert.equal(r.status, 1, said(r));
      assert.deepEqual(left(tmp), [], `a run started in test/unit left these${said(r)}`);
    });

    test("with mocha's --exit (the run ends by process.exit, so no 'beforeExit'), a failing run still leaves nothing, and KEEP=failed still keeps it", () => {
      const tmp = freshTmp();
      const r = mocha('makes.cjs', envFor(tmp), ['--exit']);
      assert.equal(r.status, 1, said(r));
      assert.deepEqual(left(tmp), [], `a failing --exit run left these${said(r)}`);

      const kept = freshTmp();
      const k = mocha('makes.cjs', envFor(kept, { [KEEP]: 'failed' }), ['--exit']);
      assert.equal(k.status, 1, said(k));
      assert.equal(left(kept).length, 1, `a failing --exit run under KEEP=failed should keep exactly its own folder${said(k)}`);
      assert.match(left(kept)[0] ?? '', /^bt-test-unit-/);
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      test(`a run stopped by ${signal} leaves nothing behind, and still dies of ${signal}`, async () => {
        const tmp = freshTmp();
        const r = await stopWhenReady([MOCHA, '--ui', 'tdd', path.join(fixtures, 'waits.cjs')], envFor(tmp), signal);
        assert.equal(r.signal, signal, `the run should die of the signal it was sent${said(r)}`);
        assert.ok((r.afterSignalMs ?? Infinity) < 15_000, `the run went on for ${r.afterSignalMs} ms after ${signal}${said(r)}`);
        assert.deepEqual(left(tmp), [], `the stopped run left these${said(r)}`);
      });
    }
  });

  suite('the vscode-test door: scripts/run-tests.mjs', () => {
    /** run-tests.mjs with the stand-ins first on PATH and no DISPLAY, as CI runs it. */
    function hostEnv(tmp: string, extra: Record<string, string>): NodeJS.ProcessEnv {
      const env = envFor(tmp, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, ...extra });
      delete env.DISPLAY;
      return env;
    }

    test("the host runs inside a folder of its own, which goes when it ends, and run-tests.mjs exits with the host's status", () => {
      const tmp = freshTmp();
      const r = run([RUN_TESTS, '--label', 'screen'], hostEnv(tmp, { T81_FAKE_EXIT: '3' }));
      assert.equal(r.status, 3, `run-tests.mjs should exit with what the host exited with${said(r)}`);
      const where = /TMP (\S+)/.exec(r.stdout)?.[1];
      assert.ok(where !== undefined, `the stand-in did not run${said(r)}`);
      assert.equal(path.dirname(where), tmp, `the host's temp folder should be a folder of its own in ${tmp}${said(r)}`);
      assert.match(path.basename(where), /^bt-test-vscode-/);
      assert.deepEqual(left(tmp), [], `the host run left these${said(r)}`);
    });

    test('a SIGTERM to run-tests.mjs alone stops the host too, removes its folder, and run-tests.mjs dies of SIGTERM', async () => {
      const tmp = freshTmp();
      const r = await stopWhenReady([RUN_TESTS, '--label', 'screen'], hostEnv(tmp, { T81_FAKE_MODE: 'wait' }), 'SIGTERM');
      assert.equal(r.signal, 'SIGTERM', `run-tests.mjs should die of SIGTERM${said(r)}`);
      // The stand-in host only stops by itself after 30 s: a run that ends well before that was stopped.
      assert.ok((r.afterSignalMs ?? Infinity) < 15_000, `the host was left running: the run ended ${r.afterSignalMs} ms after SIGTERM${said(r)}`);
      assert.deepEqual(left(tmp), [], `the stopped host run left these${said(r)}`);
    });
  });

  test("a run that starts VS Code nests its folder in TMPDIR unless VS Code's sockets would not fit there; on macOS's own TMPDIR they never fit", () => {
    const LIB = path.join(ROOT, 'scripts', 'test-tmp.mjs');
    const MAC_TMPDIR = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T';
    const SHORT = '/tmp/ci-runner-7/job'; // 20 characters: room for a run folder and a socket
    const LONG = '/tmp/a/rather/deeply/nested/private/temp/folder'; // 47: no room on Linux either
    const cases: [string, string, Record<string, string>, string][] = [
      // [tmpdir, platform, env, where the folder goes]
      [LONG, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, LONG], // VS Code's sockets go to XDG_RUNTIME_DIR
      [SHORT, 'linux', {}, SHORT], // short enough for the sockets
      [LONG, 'linux', {}, '/tmp'], // sockets in TMPDIR, and too long for them
      [MAC_TMPDIR, 'darwin', {}, '/tmp'], // macOS: always TMPDIR, and its own is too long already
      [MAC_TMPDIR, 'darwin', { XDG_RUNTIME_DIR: '/run/user/501' }, '/tmp'], // macOS ignores XDG_RUNTIME_DIR
      ['/tmp', 'darwin', {}, '/tmp'],
      [LONG, 'win32', {}, LONG], // named pipes: no path limit
    ];
    const script = `import { vscodeRunFolderBase } from ${JSON.stringify(LIB)};
      const cases = ${JSON.stringify(cases)};
      console.log(JSON.stringify(cases.map(([t, p, e]) => vscodeRunFolderBase(t, 'vscode', p, e))));`;
    const r = run(['--input-type=module', '-e', script], envFor(freshTmp()));
    assert.equal(r.status, 0, said(r));
    assert.deepEqual(JSON.parse(r.stdout), cases.map((c) => c[3]));
  });

  suite('the check: scripts/check-tmp.mjs', () => {
    const MAKE = (names: string[]): string =>
      names.map((n) => `require('fs').mkdirSync(require('path').join(require('os').tmpdir(), '${n}'));`).join('');

    test('it fails naming every entry a command leaves, allows only what is on its list, and removes its own folder', () => {
      const tmp = freshTmp();
      const r = run([CHECK, '--', process.execPath, '-e', MAKE(['leak-one', 'leak-two', 'node-compile-cache'])], envFor(tmp));
      assert.equal(r.status, 1, `a command that leaks should fail the check${said(r)}`);
      assert.match(r.stderr, /left 2 entries/, said(r));
      assert.match(r.stderr, /^ {2}leak-one {2}\(folder\)$/m, said(r));
      assert.match(r.stderr, /^ {2}leak-two {2}\(folder\)$/m, said(r));
      assert.doesNotMatch(r.stderr, /^ {2}node-compile-cache/m, `an allowed entry was reported as a leftover${said(r)}`);
      assert.match(r.stdout, /allowed: node-compile-cache/, said(r));
      assert.deepEqual(left(tmp), [], `the check left its own folder behind${said(r)}`);
    });

    test('a command that leaves nothing passes, and a command that fails fails the check with its own status', () => {
      const tmp = freshTmp();
      const clean = run([CHECK, '--', process.execPath, '-e', '0'], envFor(tmp));
      assert.equal(clean.status, 0, said(clean));
      assert.match(clean.stdout, /the temp folder is as it was/, said(clean));
      const failing = run([CHECK, '--', process.execPath, '-e', 'process.exit(5)'], envFor(tmp));
      assert.equal(failing.status, 5, said(failing));
      assert.deepEqual(left(tmp), [], said(failing));
    });
  });
});
