#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `node scripts/release-draft.mjs <sha> [--verify-draft]` - put the CI-verified .vsix of one exact
// commit on `main` on a DRAFT GitHub release, by printing the command that would (T-140).
//
// Run it after `npm run -s build`: like scripts/publish.mjs it is a thin shell around
// dist/publish.js, where all of the deciding lives (src/publish/release.ts, unit-tested).
//
// THE LINE. This script reads GitHub and never writes to it. Creating the draft is the owner's
// act, so the command that does it is PRINTED, quoted so it can be pasted as printed, and never
// run. Every gh command this file runs is built by `ghRead` and checked by `isReadOnlyGh` first,
// an allowlist of read shapes that every printed command fails, so a later edit that hands the
// printed command to `gh()` refuses instead of creating a release.
//
// What it proves, in order, refusing at the first link that does not hold:
//
//   [1] the commit    hex sha -> full sha (`git rev-parse`); version from `git show <sha>:package.json`
//   [2] on main       `gh api .../compare/<sha>...main` is identical or ahead: main contains it
//   [3] its CI run    the push to main of exactly that sha, completed, success, and every step of
//                     every job success (`gh run list`, then `gh run view <id> --json jobs`); and the
//                     VS Code its install check proved the file on, from that job's own log
//                     (`gh api .../actions/jobs/<id>/logs`), which is the only version the notes name
//   [4] its artifact  build-tutorials-vsix of that run, unexpired; the zip, downloaded into a NEW
//                     empty directory, hashes to the digest GitHub recorded when the run uploaded it
//   [5] the .vsix     exactly build-tutorials-<version>.vsix inside, unpacked into a NEW empty
//                     directory; its extension/package.json read with `unzip -p`, never loaded
//   [6] the notes     notes.md, written beside them
//   [7] the release   first what is already there: this login can push (GitHub shows drafts to no
//                     one else), at most one release carries the tag (`gh api .../releases`), and the
//                     tag, if it exists, is at this commit (`gh api .../git/ref/tags/v<version>`,
//                     peeled once if annotated), because GitHub ignores --target when it does. Then
//                     `gh release view v<version>`: none yet prints `gh release create --draft`; a
//                     draft holding only its own .vsix, or nothing, prints `gh release upload
//                     --clobber` and `gh release edit --draft`; a published release, or a draft
//                     with any other asset, is refused
//
// --verify-draft runs [1]-[5], then [7] and [8]: `gh release download v<version> --pattern
// '*.vsix'` into a NEW empty directory, and the draft's .vsix must hash to the CI artifact's.
// It prints MATCH, or exits 1 naming both hashes.
//
// Everything this writes is under .scratch/release/v<version>/run-<run id>-<random>/, gitignored,
// one new directory per run: ci-artifact/ (the zip), ci-vsix/ (the .vsix), notes.md, and with
// --verify-draft draft-asset/. The downloads are untrusted data: each lands in its own new empty
// directory, and nothing in them is ever executed or imported, only hashed, listed and read.
//
// Exit: 0 the command was printed (or MATCH); 1 refused, with a sentence saying what to do;
// 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const verifyDraft = argv.includes('--verify-draft');
const positional = argv.filter((a) => !a.startsWith('--'));
const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--verify-draft');

const tty = process.stdout.isTTY;
const GREEN = tty ? '\x1b[32m' : '';
const RED = tty ? '\x1b[31m' : '';
const YELLOW = tty ? '\x1b[33m' : '';
const BOLD = tty ? '\x1b[1m' : '';
const OFF = tty ? '\x1b[0m' : '';

const step = (n, msg) => console.log(`\n${BOLD}[${n}]${OFF} ${msg}`);
const ok = (msg) => console.log(`  ${GREEN}ok${OFF} ${msg}`);
const note = (msg) => console.log(`  ${YELLOW}!${OFF} ${msg}`);
const die = (msg, code = 1) => {
  console.error(`\n${RED}FAILED: ${msg}${OFF}`);
  process.exit(code);
};

if (unknownFlags.length > 0 || positional.length > 1) {
  console.error('usage: node scripts/release-draft.mjs <sha> [--verify-draft]');
  process.exit(2);
}

const bundle = pathToFileURL(path.join(root, 'dist', 'publish.js')).href;
let R;
try {
  R = await import(bundle);
} catch (err) {
  console.error(`could not load ${bundle} - run "npm run -s build" first.`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** A refusal is the end of the run: its reason and its remedy, on stderr, exit 1. */
function refuse(refusal) {
  console.error(`\n${RED}REFUSED (${refusal.code}):${OFF} ${R.refusalText(refusal)}`);
  console.error('Nothing was sent to GitHub.');
  process.exit(1);
}
const must = (checked) => (checked.ok ? checked.value : refuse(checked));

/** What a command printed, for src/publish/release.ts to read. Nothing here interprets it. */
function result(r) {
  if (r.error) return { status: null, stdout: '', stderr: r.error.message };
  return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '', stderr: typeof r.stderr === 'string' ? r.stderr : '' };
}

function run(command, args) {
  // Only git and unzip run here (review N1): gh goes through gh() below, and its read-only check.
  if (!R.isDirectCommand(command)) die(`refusing to run ${command} directly: only ${R.DIRECT_COMMANDS.join(' and ')} run without a check, and gh goes through gh()`);
  return result(spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

// gh with no prompts, no update notice, and no forced terminal formatting in what it prints.
const ghEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
delete ghEnv.GH_FORCE_TTY;

/** The one way this file reaches GitHub. A command that is not a read is refused before it runs. */
function readOnly(args) {
  if (!R.isReadOnlyGh(args)) die(`refusing to run \`gh ${args.join(' ')}\`: this script only reads from GitHub`);
  return args;
}

function gh(args) {
  return result(spawnSync('gh', readOnly(args), { cwd: root, env: ghEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** `gh <args> > file`: the response body goes straight to a file that must not exist yet. */
function ghToFile(args, file) {
  const fd = fs.openSync(file, 'wx');
  try {
    return result(spawnSync('gh', readOnly(args), { cwd: root, env: ghEnv, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' }));
  } finally {
    fs.closeSync(fd);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const rel = (p) => path.relative(root, p);

console.log(`${BOLD}build-tutorials release-draft${verifyDraft ? ' --verify-draft' : ''}${OFF} - reads GitHub, writes nothing there`);

// -- [1] the commit ---------------------------------------------------------------------------

step(1, 'the commit');
const given = must(R.parseShaArgument(positional[0]));
const sha = must(R.checkResolvedSha(given, run('git', ['rev-parse', '--verify', '--quiet', `${given}^{commit}`])));
const { version } = must(R.readCommitManifest(run('git', ['show', `${sha}:package.json`]), sha));
ok(`${sha}, whose own package.json says ${version}`);

// -- [2] on GitHub's main ---------------------------------------------------------------------

step(2, "on GitHub's main");
const onMain = must(R.checkOnMain(gh(R.ghRead.compare(sha)), sha));
ok(onMain.status === 'identical' ? `${R.RELEASE_BRANCH} is this commit` : `${R.RELEASE_BRANCH} contains it (${onMain.aheadBy} commits ahead of it)`);

// -- [3] its CI run ---------------------------------------------------------------------------

step(3, `its ${R.RELEASE_WORKFLOW} run`);
const ciRun = must(R.chooseRun(gh(R.ghRead.runList(sha)), sha));
ok(`run ${ciRun.id}: ${ciRun.event} to ${ciRun.headBranch}, ${ciRun.status}, ${ciRun.conclusion} - ${ciRun.url}`);
const counted = must(R.checkRunSteps(gh(R.ghRead.runView(ciRun.id)), ciRun));
ok(`every step green: ${counted.steps} steps in ${counted.jobs} job${counted.jobs === 1 ? '' : 's'}, ${R.REQUIRED_STEPS.map((s) => `"${s.prefix}…"`).join(', ')} among them`);
// What the notes may say this run proved: the VS Code its own job log names (review S3).
const runner = must(R.readRunnerVscode(gh(R.ghRead.jobLog(counted.installJobId)), ciRun, counted.installJobId));
ok(`its install check proved the file on VS Code ${runner.version} (job ${counted.installJobId}'s log)`);

// -- [4] its artifact -------------------------------------------------------------------------

step(4, 'the artifact it uploaded');
const artifact = must(R.chooseArtifact(gh(R.ghRead.artifacts(ciRun.id)), ciRun));
ok(`${artifact.name} (artifact ${artifact.id}), recorded as ${artifact.digest}${artifact.expiresAt ? `, expires ${artifact.expiresAt}` : ''}`);

const versionDir = path.join(root, '.scratch', 'release', `v${version}`);
fs.mkdirSync(versionDir, { recursive: true });
const runDir = fs.mkdtempSync(path.join(versionDir, `run-${ciRun.id}-`));
const zipDir = path.join(runDir, 'ci-artifact');
fs.mkdirSync(zipDir);
const zipPath = path.join(zipDir, `${artifact.name}.zip`);
const download = ghToFile(R.ghRead.artifactZip(artifact.id), zipPath);
const zipBytes = download.status === 0 ? fs.readFileSync(zipPath) : new Uint8Array();
const { sha256: zipSha } = must(R.checkArtifactDigest(artifact, download, zipBytes));
ok(`downloaded ${formatBytes(zipBytes.length)} into ${rel(zipDir)}/`);
ok(`it hashes to the digest GitHub recorded at upload: sha256:${zipSha}`);

// -- [5] the .vsix inside ---------------------------------------------------------------------

step(5, 'the .vsix inside');
const { vsixName } = must(R.checkArtifactEntries(run('unzip', ['-Z1', zipPath]), version));
const vsixDir = path.join(runDir, 'ci-vsix');
fs.mkdirSync(vsixDir);
const unpacked = run('unzip', ['-qq', '-n', zipPath, '-d', vsixDir]);
must(R.checkExtraction(unpacked, fs.readdirSync(vsixDir), vsixName));
const vsixPath = path.join(vsixDir, vsixName);
const vsix = must(R.checkVsixManifest(run('unzip', ['-p', vsixPath, 'extension/package.json']), version));
const vsixSha = R.sha256Hex(fs.readFileSync(vsixPath));
ok(`exactly ${vsixName}, unpacked into ${rel(vsixDir)}/`);
ok(`its extension/package.json: ${R.EXTENSION_PUBLISHER}.${R.EXTENSION_NAME} ${version}, VS Code ${vsix.minimumVscode} or later`);
ok(`its sha256: ${vsixSha}`);

// -- [6] the notes ----------------------------------------------------------------------------

let notesPath = null;
if (!verifyDraft) {
  step(6, 'the release notes');
  notesPath = path.join(runDir, 'notes.md');
  fs.writeFileSync(notesPath, R.composeReleaseNotes({
    version, sha, run: { id: ciRun.id, url: ciRun.url }, vsixName, vsixSha256: vsixSha, minimumVscode: vsix.minimumVscode,
    runnerVscode: runner.version,
  }));
  ok(`wrote ${rel(notesPath)}`);
}

// -- [7] the release on GitHub ----------------------------------------------------------------

const tag = R.releaseTag(version);
step(7, `release ${tag} on GitHub`);
// Drafts are shown only to a login that can push, so first make sure "none" would mean none (review S2).
must(R.checkDraftsVisible(gh(R.ghRead.pushPermission())));
ok('this gh login can push, so GitHub shows it drafts too');
const existing = must(R.readExistingRelease(gh(R.ghRead.releaseView(version)), version));
// gh release view names one release per tag; the list says whether there is a second (review S2).
must(R.checkReleaseList(gh(R.ghRead.releases()), version, existing));
if (existing === null) ok('there is none yet, and no other release carries the tag');
else ok(`it exists, the only release with that tag: ${existing.isDraft ? 'a draft' : 'PUBLISHED'}, targeting ${existing.targetCommitish}, ${existing.assets.length} asset${existing.assets.length === 1 ? '' : 's'}${existing.assets.length > 0 ? ` (${existing.assets.map((a) => a.name).join(', ')})` : ''}`);
// A tag that already exists decides where the release lands: GitHub ignores --target then (review S1).
const ref = must(R.readTagRef(gh(R.ghRead.tagRef(version)), version));
const tagCommit = ref.kind === 'none' ? null
  : ref.kind === 'commit' ? ref.sha
    : must(R.peelTagObject(gh(R.ghRead.tagObject(ref.sha)), version, ref.sha));
const tagState = must(R.checkTagTarget(tagCommit, version, sha));
ok(tagState === 'none'
  ? `there is no tag ${tag} yet: a draft makes none, and publishing it creates one at this commit`
  : `the tag ${tag} already exists, at this commit`);

if (!verifyDraft) {
  const plan = must(R.releaseCommands({ version, sha, notesPath, vsixPath, existing }));
  console.log(`\n${BOLD}THE COMMAND${plan.commands.length === 1 ? '' : 'S'} - printed, NOT run.${OFF} Creating the draft is the owner's act:\n`);
  for (const command of plan.commands) console.log(`  ${command.line}\n`);
  console.log(plan.mode === 'create'
    ? `That creates ${tag} as a DRAFT targeting ${sha}, titled "${R.releaseTitle(version)}", with these notes and this one .vsix. A draft makes no tag until it is published, and publishing it is a separate decision.`
    : `${tag} is already a draft, so these replace its .vsix and set its target, title and notes; it stays a draft.`);
  console.log(`Then check what the draft carries: node scripts/release-draft.mjs ${sha} --verify-draft`);
  console.log(`\n${GREEN}Every gh command this ran was a read; nothing was sent to GitHub.${OFF}`);
  process.exit(0);
}

// -- [8] --verify-draft: the draft's own .vsix ------------------------------------------------

const release = must(R.checkDraftRelease(existing, version, sha));
if (!release.isDraft) note(`${tag} is published, not a draft; checking its .vsix all the same`);
step(8, `the .vsix on ${tag}`);
const draftDir = path.join(runDir, 'draft-asset');
fs.mkdirSync(draftDir);
const fetched = gh(R.ghRead.releaseDownload(version, draftDir));
const files = fs.readdirSync(draftDir, { withFileTypes: true }).map((entry) => (entry.isFile()
  ? { name: entry.name, sha256: R.sha256Hex(fs.readFileSync(path.join(draftDir, entry.name))) }
  : { name: `${entry.name} (not a file)`, sha256: '' }));
const matched = must(R.checkDraftAsset({ version, download: fetched, files, expectedSha256: vsixSha }));
ok(`downloaded into ${rel(draftDir)}/`);
console.log(`\n${GREEN}MATCH${OFF}: the ${vsixName} on ${tag} is byte for byte the .vsix of ${R.RELEASE_WORKFLOW} run ${ciRun.id}'s artifact (sha256 ${matched.sha256}).`);
console.log('Every gh command this ran was a read; nothing was sent to GitHub.');
