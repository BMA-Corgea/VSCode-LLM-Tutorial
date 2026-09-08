#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm run package` — build a .vsix that CARRIES repo-tour's core, so the extension installs
// on a machine that has never heard of repo-tour (T-8, AC1 + AC2).
//
// -- What was wrong, and why this script exists --------------------------------------------
//
// Until T-8, `package` was `vsce package --no-dependencies`: 11 files, ~129 KB, and nothing at
// all under `node_modules`. The extension resolved repo-tour from a SIBLING CHECKOUT, which
// exists on a developer's machine and nowhere else. Installed from that .vsix, the doctor
// reports "core NOT found" and every feature in the extension is unreachable.
//
// The knot is that `dependencies: { "repo-tour": "file:../repo-tour" }` cannot be represented
// in a .vsix at all: plain `vsce package` walks into the sibling's own node_modules for
// web-tree-sitter and tree-sitter-wasms and produces paths like
// `extension/../repo-tour/node_modules/...`, which escape the archive root. Hence
// `--no-dependencies`, which made the error go away by shipping nothing.
//
// So this script unties it instead:
//
//   1. `npm pack` the sibling repo-tour checkout into `vendor/` — a real tarball, the exact
//      thing `npm publish` would upload, honouring repo-tour's own `files` (dist, assets,
//      schema, README, LICENSE).
//   2. Build a STAGING copy of this extension from an explicit ALLOWLIST of top-level entries.
//   3. `npm install --omit=dev` the tarball into the staging copy, so `node_modules/repo-tour`
//      is a real directory inside the package root with its two runtime dependencies beside it.
//   4. `vsce package` from the staging copy, WITHOUT `--no-dependencies`.
//   5. Verify the archive actually contains what it must, and nothing it must not — and fail
//      if either is false.
//
// -- Why the staging copy is an allowlist ---------------------------------------------------
//
// Packaging's failure mode is not a crash, it is shipping something that should never have
// left the machine. `.vscodeignore` is a DENY list, which means it is only correct about the
// directories that existed when it was last edited; a new `.secrets/` created next week is
// shipped by default. The staging copy inverts that: it STARTS as only what is named in
// STAGED_ENTRIES, so anything new is absent unless someone adds it here on purpose. The
// disclosure check in step 6 is the third barrier, and the only one that reads the artifact
// that was actually produced rather than the intention behind it.
//
// Three things arrive in the staging copy after the allowlist has done its work, and saying
// "it contains only STAGED_ENTRIES" was therefore false (review finding 13):
//
//   node_modules/      what step 4 is for - the vendored core and its two runtime dependencies
//   package-lock.json  written by that same `npm install`; excluded from the archive by vsce
//   vendor/<core>.tgz  planted by step 3 because `npm install` needs the tarball inside the
//                      package root - and DELETED again by step 4 the moment it has been used,
//                      because the barrier a script builds does not cover the file that script
//                      plants afterwards (review finding 3: a re-zipped archive carrying that
//                      920 KB tarball passed every rule and printed its own size in the table
//                      below). `PATH_RULES` now names `vendor/`, `.package-staging/` and
//                      `*.tgz` as well, so the read-back barrier covers the intermediates its
//                      own producer creates.
//
// -- The name half of the disclosure check either certifies, or it fails --------------------
//
// The needles it searches for are supplied at RUN TIME (`BUILD_TUTORIALS_OWNER_NAMES`, else
// the local git identity) because writing them into this public repository would be the
// disclosure they exist to prevent. T-8 shipped that design with an exit 0 when the derivation
// came back empty - which is the default shape of a GitHub Actions runner, so the check did
// nothing and reported success exactly where it mattered most (review finding 2). It now
// REFUSES: no needles is exit 2, distinct from the exit 1 a real violation produces, with a
// message saying how to supply them. `--allow-vacuous-name-scan` is the only way past it, and
// a run that uses it does not get to print "packaged and verified".
//
// Flags:
//   --out <path>       where to write the .vsix (default: build-tutorials-<version>.vsix here)
//   --skip-build       do not re-run esbuild first (dist/ must already be current)
//   --skip-core-build  `npm pack --ignore-scripts`: do not let repo-tour's `prepare` rebuild
//                      its dist/. Useful when another worktree is reading that checkout.
//   --keep-staging     leave .package-staging/ behind for inspection
//   --verify-only [p]  skip the build entirely and run step 6's checks over an EXISTING .vsix
//                      (default: the same path --out would have written). This is `npm run
//                      check:package` - the same assertions, re-runnable against an artifact
//                      that came from somewhere else, such as the one CI uploaded.
//   --allow-vacuous-name-scan
//                      package (or verify) an archive whose name half could not be checked at
//                      all, and say so on screen. Exit 0, but NOT "verified".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  const next = i >= 0 ? argv[i + 1] : undefined;
  // A flag's value is never another flag: `--verify-only --keep-staging` means "verify the
  // default artifact", not "verify a file called --keep-staging".
  return next !== undefined && next.startsWith('--') ? undefined : next;
};
const verifyOnly = hasFlag('--verify-only');
const allowVacuousNameScan = hasFlag('--allow-vacuous-name-scan');

const tty = process.stdout.isTTY;
const GREEN = tty ? '\x1b[32m' : '';
const RED = tty ? '\x1b[31m' : '';
const YELLOW = tty ? '\x1b[33m' : '';
const DIM = tty ? '\x1b[2m' : '';
const BOLD = tty ? '\x1b[1m' : '';
const OFF = tty ? '\x1b[0m' : '';

const step = (n, msg) => console.log(`\n${BOLD}[${n}]${OFF} ${msg}`);
const ok = (msg) => console.log(`  ${GREEN}ok${OFF} ${msg}`);
const warn = (msg) => console.log(`  ${YELLOW}!${OFF} ${msg}`);
const die = (msg, code = 1) => {
  console.error(`\n${RED}FAILED: ${msg}${OFF}`);
  process.exit(code);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', encoding: 'utf8', ...options });
  if (result.error) die(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(' ')} exited ${result.status}`);
  return result;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) die(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    console.error(result.stderr ?? '');
    die(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return result.stdout ?? '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// -- 0. the manifest, and the tools this needs ---------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outPath = path.resolve(
  root,
  flagValue('--verify-only') ?? flagValue('--out') ?? `${manifest.name}-${manifest.version}.vsix`,
);

if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status !== 0) {
  die('`unzip` is not on PATH. It is how this script reads back the archive it just wrote, and an unverified archive is the failure this whole script exists to prevent.');
}

console.log(`${BOLD}packaging ${manifest.publisher}.${manifest.name} v${manifest.version}${OFF}`);

let staging = null;

if (verifyOnly) {
  console.log(`\n${BOLD}--verify-only${OFF} - checking the existing archive, building nothing`);
  if (!fs.existsSync(outPath)) die(`there is no archive at ${outPath}`);
} else {
  // -- 1. build this extension's own bundles --------------------------------------------------

  if (hasFlag('--skip-build')) {
    warn('--skip-build: using whatever is already in dist/');
  } else {
    step(1, 'building dist/ (esbuild)');
    run('npm', ['run', 'build'], { cwd: root });
  }
  if (!fs.existsSync(path.join(root, 'dist', 'extension.js'))) {
    die('dist/extension.js does not exist, so there is nothing to package');
  }

  // -- 2. pack the sibling repo-tour checkout -------------------------------------------------

  step(2, 'packing repo-tour into vendor/');

  // Resolved through node_modules rather than by assuming `../repo-tour`, so it is the SAME
  // checkout `npm install` linked and the same one the extension loads in development. A link
  // that points somewhere unexpected shows up here, at pack time, instead of inside the archive.
  const linkedCore = path.join(root, 'node_modules', 'repo-tour');
  if (!fs.existsSync(linkedCore)) {
    die('node_modules/repo-tour is missing. Run `npm install` first: it links the sibling checkout named by the file: dependency.');
  }
  const coreRoot = fs.realpathSync(linkedCore);
  const corePkg = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8'));
  if (corePkg.name !== 'repo-tour') die(`${coreRoot} is not a repo-tour checkout (its package.json says "${corePkg.name}")`);
  ok(`core checkout ${coreRoot} - repo-tour v${corePkg.version}`);

  const vendorDir = path.join(root, 'vendor');
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });

  const packArgs = ['pack', coreRoot, '--pack-destination', vendorDir, '--json'];
  if (hasFlag('--skip-core-build')) {
    // repo-tour's `prepare` is `npm run build` (tsc). Skipping it means dist/ must already be
    // current, which is why the assertion below is not optional.
    packArgs.push('--ignore-scripts');
    warn("--skip-core-build: repo-tour's prepare will not run, so its dist/ must already be current");
    if (!fs.existsSync(path.join(coreRoot, 'dist', 'extract.js'))) {
      die(`--skip-core-build was given but ${coreRoot}/dist is not built. Run \`npm run build\` there first.`);
    }
  }
  const packJson = capture('npm', packArgs, { cwd: root });
  let tarballName;
  try {
    tarballName = JSON.parse(packJson)[0].filename;
  } catch {
    die(`could not read the tarball name out of \`npm pack\`'s output:\n${packJson}`);
  }
  const tarballPath = path.join(vendorDir, path.basename(tarballName));
  if (!fs.existsSync(tarballPath)) die(`npm pack claimed to write ${tarballPath} but it is not there`);
  ok(`vendor/${path.basename(tarballPath)} - ${formatBytes(fs.statSync(tarballPath).size)}`);

  // -- 3. the staging copy: an ALLOWLIST, not a filtered copy of the working tree --------------

  step(3, 'staging the extension');

  /**
   * Every top-level entry that may reach the archive. Adding to this list is a deliberate act;
   * NOT adding to it is the default. That is the whole point - see this file's header.
   */
  const STAGED_ENTRIES = [
    'package.json',   // rewritten below
    'README.md',      // vsce renames it to readme.md in the archive
    'LICENSE',        // vsce renames it to LICENSE.txt in the archive
    'NOTICE',
    'CHANGELOG.md',
    'media',          // the activity-bar icon
    'dist',           // the bundles; .vscodeignore drops dist/test, dist/publish.js and the .map files
    '.vscodeignore',
    'build-tutorials',
    'start.sh',
  ];

  staging = path.join(root, '.package-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const staged = [];
  for (const entry of STAGED_ENTRIES) {
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) continue;
    if (entry === 'package.json') continue; // written below, transformed
    fs.cpSync(from, path.join(staging, entry), { recursive: true, dereference: true });
    staged.push(entry);
  }

  // The staged manifest drops `scripts` and `devDependencies`. Neither means anything to an
  // installed extension, and `vscode:prepublish` in particular would make vsce try to run
  // esbuild inside a staging copy that deliberately has no dev dependencies at all.
  const stagedManifest = { ...manifest };
  delete stagedManifest.scripts;
  delete stagedManifest.devDependencies;
  fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`);
  staged.unshift('package.json');
  ok(`staged ${staged.length} top-level entries: ${staged.join(', ')}`);

  // The one thing this script plants inside its own allowlisted copy. `npm install` will only
  // take a tarball path that is inside the package root, so it goes in - and comes straight
  // back out below, as soon as it has been used.
  const stagedVendor = path.join(staging, 'vendor');
  fs.mkdirSync(stagedVendor, { recursive: true });
  fs.copyFileSync(tarballPath, path.join(stagedVendor, path.basename(tarballPath)));

  // -- 4. install the core INTO the staging copy ----------------------------------------------

  step(4, 'installing the core into the staging copy (--omit=dev)');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `./vendor/${path.basename(tarballPath)}`], { cwd: staging });

  const stagedCore = path.join(staging, 'node_modules', 'repo-tour');
  if (!fs.existsSync(path.join(stagedCore, 'package.json'))) die('node_modules/repo-tour did not appear in the staging copy');
  if (fs.lstatSync(stagedCore).isSymbolicLink()) die('node_modules/repo-tour in the staging copy is a SYMLINK. A link cannot travel inside a .vsix, which is the entire bug T-8 exists to fix.');
  ok('node_modules/repo-tour is a real directory in the staging copy');

  // The tarball has done its job. Removing it here rather than trusting `.vscodeignore` is the
  // point of finding 3: the intermediate a pipeline creates for itself is exactly the artifact
  // no barrier was written with in mind, and the cheapest barrier is for it not to be there.
  fs.rmSync(stagedVendor, { recursive: true, force: true });
  ok('vendor/ removed from the staging copy - the tarball cannot reach the archive from there');

  // `npm install <tarball>` rewrote the staged manifest's dependency to
  // `file:vendor/repo-tour-<v>.tgz`, and `vendor/` is neither in the archive nor on disk any
  // more: the shipped package.json would declare a path that does not exist, which is one
  // unrepresentable `file:` link swapped for another (review finding 10). The archive ships
  // `node_modules/` pre-populated - that is what a .vsix IS, and no marketplace ever runs
  // `npm install` on one - so the honest declaration is the version that is actually inside.
  //
  // `"private": true` is deliberately left alone: whether to clear it before a first real
  // publish is the owner's call, and `scripts/publish.mjs` puts it on screen rather than
  // deciding it here.
  const installedManifest = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
  const stagedCoreVersion = JSON.parse(fs.readFileSync(path.join(stagedCore, 'package.json'), 'utf8')).version;
  if (installedManifest.dependencies?.['repo-tour']) {
    installedManifest.dependencies['repo-tour'] = stagedCoreVersion;
    fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(installedManifest, null, 2)}\n`);
    ok(`shipped manifest declares repo-tour ${stagedCoreVersion} - the copy that is actually inside the archive`);
  }

  // -- 5. package from the staging copy, WITHOUT --no-dependencies ----------------------------

  step(5, 'vsce package (with dependencies)');
  fs.rmSync(outPath, { force: true });
  run(process.execPath, [path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--out', outPath], { cwd: staging });
  if (!fs.existsSync(outPath)) die(`vsce reported success but ${outPath} is not there`);
}

// -- 6. read the archive back and check it --------------------------------------------------

step(6, 'verifying the archive');

const listing = capture('unzip', ['-Z1', outPath]);
const entries = listing.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.endsWith('/'));

const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-vsix-'));
run('unzip', ['-qq', '-o', outPath, '-d', extracted]);

const {
  VACUOUS_NAME_SCAN_FLAG, certifyNameScan, checkArchive, checkRequiredContent, relativeToExtension,
} = await import(pathToFileURL(path.join(root, 'dist', 'publish.js')).href);

// 6a. what MUST be there
const required = checkRequiredContent(entries);
for (const req of required) {
  if (req.ok) ok(`${req.id}: ${req.count} entr${req.count === 1 ? 'y' : 'ies'}`);
  else console.error(`  ${RED}MISSING${OFF} ${req.id}: found ${req.count}, needed ${req.atLeast} - ${req.why}`);
}

// 6b. what must NOT be there.
//
// The needles are supplied at run time and never written down in this public repository; see
// src/publish/disclosure.ts. `git config` is the fallback so a bare run still checks something
// real (the committing identity's email) rather than passing vacuously.
//
// Both halves of that sentence are load-bearing, so a `git` that could not be asked is recorded
// as a DIFFERENT fact from a `git` that answered with nothing. Reading the first as the second
// is how "we killed git" became "you have no identity" in T-13, one file over.
function gitConfig(key) {
  const result = spawnSync('git', ['config', key], { cwd: root, encoding: 'utf8' });
  if (result.error) return { value: '', unavailable: `git could not be run: ${result.error.message}` };
  if (result.status !== 0 && result.status !== 1) {
    // 1 is git's ordinary "this key is not set". Anything else is git failing to answer.
    return { value: '', unavailable: `\`git config ${key}\` exited ${result.status}` };
  }
  return { value: result.stdout?.trim() ?? '', unavailable: null };
}
const gitNameResult = gitConfig('user.name');
const gitEmailResult = gitConfig('user.email');

const certification = certifyNameScan({
  envValue: process.env.BUILD_TUTORIALS_OWNER_NAMES,
  gitName: gitNameResult.value,
  gitEmail: gitEmailResult.value,
  gitUnavailable: gitNameResult.unavailable ?? gitEmailResult.unavailable,
  allowVacuous: allowVacuousNameScan,
});
const ownerNeedles = certification.needles;

const scan = checkArchive(entries, (entry) => fs.readFileSync(path.join(extracted, entry)), { ownerNeedles });

console.log(`  ${DIM}scanned ${scan.filesScanned} files (${scan.textFilesScanned} textual) for forbidden paths, credential shapes and personal identifiers${OFF}`);

// What the word scan could NOT cover, by kind rather than as a count. A bare `42 binaries
// excluded` read like coverage and was hiding one ordinary .js file among 39 .wasm and 2 .jpg
// (review finding 4); a breakdown makes a stray file type visible at a glance, and --verify-only
// prints the full list so the claim is auditable rather than summarised.
const exemptByKind = new Map();
for (const entry of scan.nameScanExemptions) {
  const ext = path.extname(entry).toLowerCase() || '(no extension)';
  exemptByKind.set(ext, (exemptByKind.get(ext) ?? 0) + 1);
}
const exemptSummary = [...exemptByKind.entries()].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${n} ${ext}`).join(', ');
console.log(`  ${DIM}not word-scannable (short personal names cannot be matched in these): ${scan.nameScanExemptions.length}${exemptSummary ? ` - ${exemptSummary}` : ''}${OFF}`);
console.log(`  ${DIM}image metadata (XMP/IPTC) is ASCII inside the file, so credential shapes and specific needles DO reach it; a short name inside it does not.${OFF}`);

if (certification.kind === 'certified') {
  console.log(`  ${DIM}${certification.message}${OFF}`);
} else {
  warn(certification.message);
  console.log(`    ${DIM}${certification.remedy}${OFF}`);
}

for (const v of scan.violations) console.error(`  ${RED}VIOLATION${OFF} ${v.rule} - ${v.entry}: ${v.detail}`);

// 6c. the summary the owner reads
const size = fs.statSync(outPath).size;
const byTop = new Map();
let unpacked = 0;
for (const entry of entries) {
  const rel = relativeToExtension(entry);
  const top = rel.startsWith('node_modules/') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0];
  const bytes = fs.statSync(path.join(extracted, entry)).size;
  unpacked += bytes;
  const prev = byTop.get(top) ?? { files: 0, bytes: 0 };
  byTop.set(top, { files: prev.files + 1, bytes: prev.bytes + bytes });
}

console.log(`\n${BOLD}${path.relative(root, outPath)}${OFF} - ${entries.length} files, ${formatBytes(size)} compressed, ${formatBytes(unpacked)} unpacked`);
for (const [top, v] of [...byTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${String(v.files).padStart(5)} files  ${formatBytes(v.bytes).padStart(10)}  ${top}`);
}

fs.rmSync(extracted, { recursive: true, force: true });
if (staging !== null) {
  if (!hasFlag('--keep-staging')) fs.rmSync(staging, { recursive: true, force: true });
  else warn(`staging kept at ${path.relative(root, staging)}`);
}

const missing = required.filter((r) => !r.ok);

// THE RULE, and it is the same one this file already applies to a missing `unzip` above: the
// failure of a check's INPUT is a failure of the check. An archive nobody could check the
// name half of is an UNCERTIFIED archive, and an uncertified archive left on disk is precisely
// the "found later and trusted" failure the deletion below exists to prevent. Exit 2 rather
// than 1 so "I could not check" and "I checked and found something" stay distinguishable.
const uncertified = certification.kind === 'refused';

if (missing.length > 0 || scan.violations.length > 0 || uncertified) {
  const summary = uncertified && missing.length === 0 && scan.violations.length === 0
    ? `the archive is NOT CERTIFIED: ${certification.message}`
    : `the archive failed ${missing.length} content requirement(s) and ${scan.violations.length} disclosure rule(s)${uncertified ? ', and its name half could not be checked at all' : ''}.`;
  const exitCode = missing.length > 0 || scan.violations.length > 0 ? 1 : certification.exitCode;
  if (verifyOnly) {
    // This run did not create the artifact, so it does not get to delete it. Deleting input
    // someone else handed you is how a check becomes the thing people route around.
    die(`${summary} It was NOT deleted: --verify-only inspects an artifact it did not produce.`, exitCode);
  }
  fs.rmSync(outPath, { force: true });
  die(`${summary} It has been DELETED rather than left on disk to be found later and trusted.`, exitCode);
}

if (certification.kind === 'waived') {
  // Exit 0, because the caller asked for it out loud - but never the word "verified".
  console.log(`\n${YELLOW}packaged; the name half was NOT checked (${VACUOUS_NAME_SCAN_FLAG})${OFF}`);
} else {
  console.log(`\n${GREEN}packaged and verified${OFF}`);
}
