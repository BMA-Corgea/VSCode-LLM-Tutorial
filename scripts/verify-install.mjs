#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm run verify:install` - install the built .vsix into an ISOLATED extensions directory,
// prove the vendored core resolves from the installed copy, and prove the extension actually
// activates in a real editor (T-8, AC1 + AC2).
//
// -- Why this is not optional -----------------------------------------------------------------
//
// `scripts/package.mjs` proves the archive CONTAINS the core. That is a claim about a zip file.
// This proves the extension can USE it, from where a user's editor puts it, with no
// `buildTutorials.repoTourPath` setting and no repo-tour checkout anywhere near it - which is
// the actual promise AC2 makes and the one thing a file listing cannot establish.
//
// The write-ahead risk it closes: a .vsix missing the WASM grammars installs, activates, and
// looks perfectly healthy right up until the first real digest, which is a long way from the
// packaging change that caused it. `initParsers()` here loads all four for real.
//
// -- Two halves, and both are named ---------------------------------------------------------
//
//   1. THE DOCTOR, from the installed copy. `dist/doctor.js` out of the installed extension
//      directory, called with `resolveCoreRoot(DEFAULT_REPO_TOUR_PATH, <installed dir>)` - the
//      setting's real default, read from the bundle rather than typed here, which is the exact
//      resolution an installed extension performs when nobody has set the path. Asserts found,
//      via: exports, every module loaded, and the four grammars initialised. Isolation is proven
//      by where that resolution LANDED (inside the installed directory), not by asserting that
//      some other path happens to be empty.
//   2. ACTIVATION, in the editor itself. The editor is launched on a scratch folder with the
//      isolated dirs, and `exthost.log` must show `_doActivateExtension` for this extension
//      with no activation error beside it.
//
// -- Which editors ---------------------------------------------------------------------------
//
// AC1 names VS Code AND VSCodium. `codium` is on PATH here. `code` is NOT - but
// `@vscode/test-electron` downloads a real stable Visual Studio Code into `.vscode-test/` for
// the vscode-test suite, and that build's own CLI is a perfectly good `code`. Both are used
// when both are found, each is named in the output, and any editor that is missing is reported
// as an UNPROVEN half rather than quietly skipped.
//
// Flags: --vsix <path>   which artifact (default: <name>-<version>.vsix in the repo root)
//        --keep          leave the isolated profile behind for inspection
//        --allow-missing-editors
//                        exit 0 rather than 2 when an editor is not installed at all. For CI,
//                        where neither editor is preinstalled and only VS Code arrives (via
//                        @vscode/test-electron, during `npm test`). The UNPROVEN lines are
//                        still printed - this changes the exit code, never the report.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next !== undefined && next.startsWith('--') ? undefined : next;
};

const tty = process.stdout.isTTY;
const GREEN = tty ? '\x1b[32m' : '';
const RED = tty ? '\x1b[31m' : '';
const YELLOW = tty ? '\x1b[33m' : '';
const BOLD = tty ? '\x1b[1m' : '';
const OFF = tty ? '\x1b[0m' : '';

const ok = (msg) => console.log(`    ${GREEN}ok${OFF} ${msg}`);
const bad = (msg) => console.log(`    ${RED}FAILED${OFF} ${msg}`);
const warn = (msg) => console.log(`    ${YELLOW}!${OFF} ${msg}`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const vsix = path.resolve(root, flagValue('--vsix') ?? `${manifest.name}-${manifest.version}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`there is no artifact at ${vsix} - run \`npm run package\` first`);
  process.exit(1);
}

/** Every editor AC1 names, with how it was found, so the evidence can never overstate itself. */
function findEditors() {
  const found = [];

  const codium = spawnSync('which', ['codium'], { encoding: 'utf8' });
  if (codium.status === 0) found.push({ label: 'VSCodium', bin: codium.stdout.trim(), how: 'on PATH' });
  else found.push({ label: 'VSCodium', bin: null, how: 'not on PATH' });

  const code = spawnSync('which', ['code'], { encoding: 'utf8' });
  if (code.status === 0) {
    found.push({ label: 'Visual Studio Code', bin: code.stdout.trim(), how: 'on PATH' });
  } else {
    // The stable VS Code build @vscode/test-electron downloads for the vscode-test suite. It is
    // the real product (product.json says "Visual Studio Code", quality "stable"), not a
    // rebrand - it simply is not installed system-wide on this machine.
    const testDir = path.join(root, '.vscode-test');
    const downloaded = fs.existsSync(testDir)
      ? fs.readdirSync(testDir)
          .filter((d) => d.startsWith('vscode-linux'))
          .map((d) => path.join(testDir, d, 'bin', 'code'))
          .filter((p) => fs.existsSync(p))
      : [];
    if (downloaded.length > 0) {
      found.push({ label: 'Visual Studio Code', bin: downloaded[0], how: 'downloaded by @vscode/test-electron into .vscode-test/, not a system install' });
    } else {
      found.push({ label: 'Visual Studio Code', bin: null, how: 'not on PATH and none downloaded under .vscode-test/ (run `npm test` once to fetch one)' });
    }
  }
  return found;
}

/** vscode-test's own rule: wrap in xvfb-run exactly when there is no DISPLAY to draw into. */
function editorCommand(bin, args) {
  return process.env.DISPLAY ? [bin, args] : ['xvfb-run', ['-a', bin, ...args]];
}

async function verifyOne(editor) {
  console.log(`\n${BOLD}${editor.label}${OFF}  (${editor.how})`);
  if (editor.bin === null) {
    warn(`UNPROVEN here: ${editor.how}. AC1's half for this editor is open, not passed.`);
    return { editor, proven: false, reason: editor.how };
  }
  console.log(`    ${editor.bin}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-install-'));
  const extensionsDir = path.join(profile, 'extensions');
  const userDataDir = path.join(profile, 'user-data');
  const workspace = path.join(profile, 'workspace');
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const isolation = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`];
  const failures = [];

  // -- install ------------------------------------------------------------------------------
  const [installBin, installArgs] = editorCommand(editor.bin, [...isolation, '--install-extension', vsix, '--force']);
  const install = spawnSync(installBin, installArgs, { encoding: 'utf8', timeout: 180_000 });
  if (install.status !== 0) {
    bad(`install exited ${install.status}: ${(install.stderr || install.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
    failures.push('install');
  } else {
    ok('installed into an isolated --extensions-dir');
  }

  const installed = fs.existsSync(extensionsDir)
    ? fs.readdirSync(extensionsDir).find((d) => d.toLowerCase().startsWith(extensionId.toLowerCase()))
    : undefined;
  if (!installed) {
    bad(`no ${extensionId}-* directory appeared under the isolated extensions dir`);
    return { editor, proven: false, failures: [...failures, 'installed-directory'], profile };
  }
  const installedDir = path.join(extensionsDir, installed);
  ok(`installed as ${installed}`);

  // A repo-tour must not be reachable from here EXCEPT the one inside the installed extension.
  // If another were, a passing doctor would prove nothing: it could be reading whatever is on
  // the chain, which is exactly how the old .vsix looked fine on a developer's machine.
  //
  // This used to check `<extensionsDir>/repo-tour` - the path the OLD `'../repo-tour'` default
  // resolved to, and a path the new default never consults (T-8 review, finding 12). It was a
  // leftover whose `ok` line read as though it were the proof. What the empty default actually
  // does is walk `node_modules` up from the installed directory, so that is what is walked here.
  // The proof itself is still the `coreRoot.startsWith(installedDir)` assertion below, which is
  // a statement about where Node REALLY went rather than about where it might have gone.
  const reachableCores = [];
  for (let dir = installedDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', 'repo-tour');
    if (fs.existsSync(candidate)) reachableCores.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
  }
  const strangers = reachableCores.filter((c) => !c.startsWith(installedDir + path.sep));
  if (strangers.length > 0) {
    bad(`a repo-tour is reachable from outside the installed extension: ${strangers.join(', ')} - this run would not prove anything`);
    failures.push('isolation');
  } else {
    ok(`the only repo-tour on Node's resolution chain from the installed copy is inside it (${reachableCores.length} found)`);
  }

  // -- 1. the doctor, from the installed copy, with NO repoTourPath setting -------------------
  const doctorBundle = pathToFileURL(path.join(installedDir, 'dist', 'doctor.js')).href;
  try {
    const { runDoctor, resolveCoreRoot, DEFAULT_REPO_TOUR_PATH } = await import(doctorBundle);
    // The setting's default, taken from the bundle rather than written down again here: empty
    // means "resolve the repo-tour dependency", i.e. the copy packaged inside the extension.
    // This is the resolution a real installed copy performs.
    const coreRoot = resolveCoreRoot(DEFAULT_REPO_TOUR_PATH, installedDir);
    const report = await runDoctor(coreRoot);

    if (!coreRoot.startsWith(installedDir)) {
      bad(`the core resolved to ${coreRoot}, which is OUTSIDE the installed extension`);
      failures.push('core-outside');
    } else {
      ok(`core resolved inside the installed extension: ${path.relative(installedDir, coreRoot)}`);
    }
    if (report.core.found !== true) { bad(`doctor: core not found - ${report.core.reason}`); failures.push('core-found'); }
    else ok(`doctor: core found, repo-tour v${report.core.version}`);

    if (report.core.via !== 'exports') { bad(`doctor: via was ${report.core.via}, expected "exports"`); failures.push('core-via'); }
    else ok('doctor: via = exports (the packaged core\'s own exports map resolved)');

    const failedModules = report.modules.filter((m) => !m.ok);
    if (failedModules.length > 0) { bad(`doctor: ${failedModules.length} module(s) failed: ${failedModules.map((m) => m.name).join(', ')}`); failures.push('modules'); }
    else ok(`doctor: all ${report.modules.length} core modules loaded`);

    if (!report.grammars.ok) { bad(`doctor: grammars - ${report.grammars.detail}`); failures.push('grammars'); }
    else ok(`doctor: grammars - ${report.grammars.detail} (${report.grammars.loaded.join(', ')})`);
  } catch (err) {
    bad(`could not run the doctor from the installed copy: ${err instanceof Error ? err.message : String(err)}`);
    failures.push('doctor');
  }

  // -- 2. activation, in the editor itself ---------------------------------------------------
  // `--no-sandbox` is not optional here and it is not a shortcut: without it the downloaded
  // VS Code build starts, fails to bring up its Chromium sandbox in this environment, and dies
  // before writing a single line - the CLI still exits 0, so the failure looks exactly like
  // "the extension never activated". It is the same flag @vscode/test-electron passes to launch
  // the very same binary for `npm test`.
  const [runBin, runArgs] = editorCommand(editor.bin, [
    ...isolation, '--no-sandbox', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-gpu', '--disable-updates', '--new-window', workspace,
  ]);
  const child = spawn(runBin, runArgs, { stdio: 'ignore', detached: true });

  const activationLine = `_doActivateExtension ${extensionId}`;
  const deadline = Date.now() + 120_000;
  let logText = '';
  let logPath = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    logPath = findExthostLog(userDataDir);
    if (logPath) {
      logText = fs.readFileSync(logPath, 'utf8');
      if (logText.includes(activationLine)) break;
    }
  }
  await stopEditor(child, profile);

  if (!logPath) {
    bad('no exthost.log was produced - the editor did not get far enough to say anything');
    failures.push('exthost-log');
    printEditorLogTails(userDataDir);
  } else if (!logText.includes(activationLine)) {
    bad(`exthost.log never logged "${activationLine}"`);
    failures.push('activation');
    printEditorLogTails(userDataDir);
  } else {
    ok(`exthost.log: ${activationLine}`);

    // An activation that THREW still logs _doActivateExtension, so the line alone is not the
    // proof - the absence of an error beside it is the other half.
    const errors = logText.split('\n').filter((l) =>
      l.toLowerCase().includes(manifest.name)
      && /activat\w* (error|fail)|error.*activat|Cannot find module|ERR_MODULE_NOT_FOUND|Activating extension.*failed/i.test(l));
    if (errors.length > 0) {
      bad(`exthost.log carries ${errors.length} activation error line(s): ${errors[0]?.trim()}`);
      failures.push('activation-errors');
    } else {
      ok('exthost.log carries no activation error for this extension');
    }
  }

  if (argv.includes('--keep')) warn(`profile kept at ${profile}`);
  else fs.rmSync(profile, { recursive: true, force: true });

  return { editor, proven: failures.length === 0, failures, logPath };
}

/**
 * Processes still using THIS run's isolated profile.
 *
 * The profile is a directory this script minted with `mkdtemp`, so a command line containing
 * it belongs to this run and to nothing else on the machine. That is the whole safety
 * argument: the cleanup can only ever reach processes it started, never an editor the person
 * at the keyboard has open.
 */
function processesUsingProfile(profile) {
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(profile))
    .map((line) => Number.parseInt(line.split(/\s+/)[0] ?? '', 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/**
 * Shuts the launched editor down, then makes sure it is actually gone.
 *
 * Killing the process GROUP is not enough on its own: VSCodium here is a snap, and the
 * wrapper puts the real editor in a session this process never owned, so `kill(-pid)` returns
 * cleanly while a full editor keeps running — and the profile directory then gets deleted out
 * from under it. "The signal was sent" is not "the process stopped"; only looking is.
 */
async function stopEditor(child, profile) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const alive = processesUsingProfile(profile);
    if (alive.length === 0) return true;
    // Escalate once the polite request has had a couple of seconds.
    if (attempt >= 4) for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ } }
  }
  const stubborn = processesUsingProfile(profile);
  if (stubborn.length > 0) warn(`${stubborn.length} editor process(es) would not stop: ${stubborn.join(', ')}`);
  return stubborn.length === 0;
}

/**
 * T-131: when the editor never said what this check waits for, what it DID say. The tail of every log the editor
 * wrote for this run (main.log, renderer*.log, sharedprocess.log, the extension host's own, whatever its logs folder
 * holds), each under its own name, so a failure on a machine nobody can log into (GitHub's runner) says why. It only
 * prints: what passes and what fails is decided above it, and nothing here can change that.
 */
function printEditorLogTails(userDataDir, { lines = 40, maxFiles = 30, maxLine = 400 } = {}) {
  const logsRoot = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsRoot)) {
    warn(`the editor wrote no logs folder: ${logsRoot}`);
    return;
  }
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.log')) files.push(full);
    }
  };
  walk(logsRoot, 0);
  if (files.length === 0) {
    warn(`the editor's logs folder holds no log: ${logsRoot}`);
    return;
  }
  files.sort();
  warn(`what the editor logged (${files.length} file${files.length === 1 ? '' : 's'} under ${logsRoot}; the last ${lines} lines of each)`);
  for (const file of files.slice(0, maxFiles)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { text = `(could not be read: ${err instanceof Error ? err.message : String(err)})`; }
    const tail = text.split('\n').filter((l) => l.trim() !== '').slice(-lines);
    console.log(`      -- ${path.relative(logsRoot, file)} (${tail.length === 0 ? 'empty' : `last ${tail.length} line${tail.length === 1 ? '' : 's'}`})`);
    for (const l of tail) console.log(`         ${l.length > maxLine ? `${l.slice(0, maxLine)}…` : l}`);
  }
  if (files.length > maxFiles) warn(`and ${files.length - maxFiles} more log file(s) not shown`);
}

function findExthostLog(userDataDir) {
  const logsRoot = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsRoot)) return null;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'exthost.log') found.push(full);
    }
  };
  try { walk(logsRoot, 0); } catch { return null; }
  if (found.length === 0) return null;
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

console.log(`${BOLD}verifying ${path.basename(vsix)} (${(fs.statSync(vsix).size / 1024 / 1024).toFixed(2)} MB)${OFF}`);
const results = [];
for (const editor of findEditors()) results.push(await verifyOne(editor));

console.log(`\n${BOLD}AC1 - installs and activates on both editors${OFF}`);
let anyProven = false;
let anyFailed = false;
for (const r of results) {
  if (r.proven) { console.log(`  ${GREEN}PROVEN${OFF}   ${r.editor.label} (${r.editor.how})`); anyProven = true; }
  else if (r.editor.bin === null) console.log(`  ${YELLOW}UNPROVEN${OFF} ${r.editor.label} - ${r.reason}`);
  else { console.log(`  ${RED}FAILED${OFF}   ${r.editor.label} - ${r.failures.join(', ')}`); anyFailed = true; }
}

// An editor that is not installed is an OPEN half, never a pass. Reporting it as a failure of
// the artifact would be wrong too - so it exits 2, distinguishable from both.
if (anyFailed) process.exit(1);
if (!anyProven) process.exit(1);
if (results.some((r) => r.editor.bin === null)) {
  console.log(`\n${YELLOW}One half of AC1 is unproven on this machine - see above. It is open, not passed.${OFF}`);
  process.exit(argv.includes('--allow-missing-editors') ? 0 : 2);
}
process.exit(0);
