// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE SHELL, driven (T-140, review S4). `test/unit/publish-release.test.ts` pins `src/publish/release.ts`,
 * the deciding. This drives `scripts/release-draft.mjs` itself, the one place that binds "the file the
 * printed command uploads" to "the file inside the zip whose bytes hashed to GitHub's digest". A one-line
 * edit there (`path.join(root, vsixName)`, "use the file npm run package made") would pass every pure
 * check, print that file's sha256, and make `--verify-draft` say MATCH about it. These tests go red then.
 *
 * Each test builds a world in a NEW temp folder and removes it itself:
 *
 *   <tmp>/release tree/   a git repo whose one commit's package.json says 0.0.1, with this repository's
 *                         script and built dist/publish.js copied in (the space is on purpose: paths
 *                         have spaces), and a DECOY build-tutorials-0.0.1.vsix in its root, chmod 000,
 *                         so a script that read it would fail and one that named it would say so
 *   <tmp>/fixtures/       the artifact zip and the .vsix inside it, written by `storeZip` below
 *   <tmp>/bin/gh          a stub gh, first on PATH: it answers exactly the reads the script makes, with
 *                         the shapes GitHub returned for 7050fd2 (run 43141446029, artifact 13910310691,
 *                         job 130929135909), logs every argv, and fails any call it has no answer for
 *
 * No real gh, no network: every gh call the script makes is one the stub logged, and every logged call
 * must pass `isReadOnlyGh`. git and unzip are the real ones.
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_REPO, ghRead, isReadOnlyGh } from '../../src/publish/release.js';

const ROOT = process.cwd();
const RUN_ID = 43141446029;
const JOB_ID = 130929135909;
const ARTIFACT_ID = 13910310691;
const VERSION = '0.0.1';
const VSIX = `build-tutorials-${VERSION}.vsix`;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ── a zip, stored (no compression), enough for unzip -Z1 / -qq / -p to read ──────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array; symlink?: boolean }

/** A Unix-made zip with every entry stored; a `symlink` entry's data is its target, as unzip expects. */
function storeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5b6c, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x5b6c, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(((entry.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** A .vsix as far as the script reads one: a zip holding extension/package.json. */
const vsixWith = (extra: Record<string, unknown> = {}): Buffer => storeZip([{
  name: 'extension/package.json',
  data: Buffer.from(JSON.stringify({ name: 'build-tutorials', publisher: 'bma-corgea', version: VERSION, engines: { vscode: '^1.95.0' }, ...extra })),
}]);

// ── the stub gh ──────────────────────────────────────────────────────────────────────────

interface Rule {
  argv: string[];
  status?: number;
  stdout?: string;
  stdoutFile?: string;
  stderr?: string;
  /** what `release download … --dir <dir>` leaves in <dir> */
  download?: { name: string; from: string };
}

/** gh with CLICOLOR_FORCE set colours its JSON, so a script that let it through reads no JSON (review N2). */
const STUB_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_STUB_LOG, JSON.stringify(argv) + '\\n');
const rules = JSON.parse(fs.readFileSync(process.env.RELEASE_STUB_RULES, 'utf8'));
const rule = rules.find((r) => r.argv.length === argv.length && r.argv.every((a, i) => a === '<any>' || a === argv[i]));
if (!rule) { fs.writeSync(2, 'stub gh: no answer for ' + JSON.stringify(argv) + '\\n'); process.exit(99); }
if (rule.download) fs.copyFileSync(rule.download.from, path.join(argv[argv.indexOf('--dir') + 1], rule.download.name));
let out = rule.stdoutFile ? fs.readFileSync(rule.stdoutFile) : Buffer.from(rule.stdout || '');
const force = process.env.CLICOLOR_FORCE;
if (force && force !== '0' && !rule.stdoutFile && out.length > 0) out = Buffer.concat([Buffer.from('\\x1b[1;38m'), out, Buffer.from('\\x1b[m')]);
if (out.length > 0) fs.writeSync(1, out);
if (rule.stderr) fs.writeSync(2, rule.stderr);
process.exit(rule.status || 0);
`;

/** The step names ci.yml declares, as a real run of it reports them. */
function ciStepNames(): string[] {
  return [...fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').matchAll(/^\s*- name:\s*(.+?)\s*$/gm)].map((m) => m[1] ?? '');
}

interface World {
  tmp: string;
  tree: string;
  sha: string;
  ciVsix: Buffer;
  decoyPath: string;
  log: string;
  run(args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
  calls(): string[][];
}

interface WorldOptions {
  /** the artifact's one entry is a symlink to a readable decoy .vsix elsewhere (review N5) */
  symlinkEntry?: boolean;
  /** an existing draft whose .vsix is these bytes */
  draft?: 'ci' | 'decoy';
}

function buildWorld(options: WorldOptions = {}): World {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-release-shell-'));
  const tree = path.join(tmp, 'release tree');
  const fixtures = path.join(tmp, 'fixtures');
  const bin = path.join(tmp, 'bin');
  for (const dir of [tree, path.join(tree, 'scripts'), path.join(tree, 'dist'), fixtures, bin]) fs.mkdirSync(dir, { recursive: true });

  // The tree: a real git repo with one commit, the script and the bundle this repository built.
  fs.writeFileSync(path.join(tree, 'package.json'), `${JSON.stringify({ name: 'build-tutorials', publisher: 'bma-corgea', version: VERSION })}\n`);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-q'], ['add', 'package.json'],
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: tree, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tree, env: gitEnv, encoding: 'utf8' }).stdout.trim();
  fs.copyFileSync(path.join(ROOT, 'scripts', 'release-draft.mjs'), path.join(tree, 'scripts', 'release-draft.mjs'));
  fs.copyFileSync(path.join(ROOT, 'dist', 'publish.js'), path.join(tree, 'dist', 'publish.js'));

  // The decoy: a valid .vsix of the same name in the tree root, the stale local build of the review's scenario.
  const decoy = vsixWith({ decoy: 'a local build, never released' });
  const decoyPath = path.join(tree, VSIX);
  fs.writeFileSync(decoyPath, decoy);
  const readableDecoy = path.join(fixtures, 'decoy-copy.vsix');
  fs.writeFileSync(readableDecoy, decoy);

  // The CI artifact: a zip holding the .vsix, or (N5) holding a symlink to the decoy under the .vsix's name.
  const ciVsix = vsixWith();
  const zip = options.symlinkEntry
    ? storeZip([{ name: VSIX, data: Buffer.from(readableDecoy), symlink: true }])
    : storeZip([{ name: VSIX, data: ciVsix }]);
  const zipPath = path.join(fixtures, 'artifact.zip');
  fs.writeFileSync(zipPath, zip);
  const ciVsixPath = path.join(fixtures, 'ci.vsix');
  fs.writeFileSync(ciVsixPath, ciVsix);

  const steps = ['Set up job', ...ciStepNames(), 'Complete job'].map((name, i) => ({ conclusion: 'success', name, number: i + 1, status: 'completed' }));
  const runUrl = `https://github.com/${RELEASE_REPO}/actions/runs/${RUN_ID}`;
  const draft = options.draft
    ? { tagName: `v${VERSION}`, isDraft: true, targetCommitish: sha, assets: [{ name: VSIX, size: ciVsix.length }] }
    : null;
  const rules: Rule[] = [
    { argv: ghRead.compare(sha), stdout: JSON.stringify({ status: 'identical', ahead_by: 0, behind_by: 0, base_commit: { sha } }) },
    { argv: ghRead.runList(sha), stdout: JSON.stringify([{ conclusion: 'success', databaseId: RUN_ID, event: 'push', headBranch: 'main', headSha: sha, status: 'completed', url: runUrl }]) },
    { argv: ghRead.runView(RUN_ID), stdout: JSON.stringify({ jobs: [{ conclusion: 'success', databaseId: JOB_ID, name: 'build-and-test', status: 'completed', steps }] }) },
    { argv: ghRead.jobLog(JOB_ID), stdout: '2026-11-12T02:28:25.0346631Z ✔ Validated version: 1.146.0\n2026-11-12T02:30:26.0097330Z   PROVEN   Visual Studio Code (downloaded by @vscode/test-electron into .vscode-test/, not a system install)\n' },
    { argv: ghRead.artifacts(RUN_ID), stdout: JSON.stringify({ total_count: 1, artifacts: [{ id: ARTIFACT_ID, name: 'build-tutorials-vsix', size_in_bytes: zip.length, expired: false, digest: `sha256:${sha256(zip)}`, expires_at: '2027-02-10T02:26:39Z', workflow_run: { id: RUN_ID, head_branch: 'main', head_sha: sha } }] }) },
    { argv: ghRead.artifactZip(ARTIFACT_ID), stdoutFile: zipPath },
    { argv: ghRead.pushPermission(), stdout: 'true\n' },
    draft
      ? { argv: ghRead.releaseView(VERSION), stdout: JSON.stringify(draft) }
      : { argv: ghRead.releaseView(VERSION), status: 1, stderr: 'release not found\n' },
    { argv: ghRead.releases(), stdout: JSON.stringify(draft ? [{ id: 555, tag_name: `v${VERSION}`, draft: true }] : []) },
    { argv: ghRead.tagRef(VERSION), status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n' },
    { argv: ghRead.releaseDownload(VERSION, '<any>'), download: { name: VSIX, from: options.draft === 'decoy' ? readableDecoy : ciVsixPath } },
  ];
  const rulesPath = path.join(tmp, 'stub-rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify(rules));
  const log = path.join(tmp, 'stub-calls.jsonl');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'gh'), STUB_GH, { mode: 0o755 });

  // Never readable, so a script that opened it would fail; never named, which the tests check.
  fs.chmodSync(decoyPath, 0o000);

  return {
    tmp, tree, sha, ciVsix, decoyPath, log,
    run(args, env = {}) {
      const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'release-draft.mjs'), ...args], {
        cwd: tree,
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
          RELEASE_STUB_LOG: log, RELEASE_STUB_RULES: rulesPath, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env,
        },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    calls() {
      return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as string[]);
    },
  };
}

function withWorld(options: WorldOptions, body: (world: World) => void): void {
  const world = buildWorld(options);
  try {
    body(world);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
}

/** Every gh call the script made was a read, and none of them reached the real gh. */
function assertOnlyReads(world: World, expected: string[][]): void {
  const calls = world.calls();
  for (const call of calls) assert.equal(isReadOnlyGh(call), true, `the script ran gh ${call.join(' ')}`);
  const key = (argv: string[]): string => JSON.stringify(argv.map((a) => (a === '<any>' || a.startsWith(world.tree) ? '<a path in the tree>' : a)));
  assert.deepEqual(calls.map(key).sort(), expected.map(key).sort(), 'the script made exactly these gh calls, each once');
}

const createCalls = (sha: string): string[][] => [
  ghRead.compare(sha), ghRead.runList(sha), ghRead.runView(RUN_ID), ghRead.jobLog(JOB_ID), ghRead.artifacts(RUN_ID),
  ghRead.artifactZip(ARTIFACT_ID), ghRead.pushPermission(), ghRead.releaseView(VERSION), ghRead.releases(), ghRead.tagRef(VERSION),
];

/** The words of a printed command line, unquoted the way a POSIX shell would. */
function words(line: string): string[] {
  return [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2] ?? ''));
}

suite('release-draft.mjs, driven with a stub gh (review S4)', function () {
  this.timeout(60_000);

  test('the printed create uploads the .vsix unpacked from the digest-checked zip, never the stale one in the tree root', () => {
    withWorld({}, (world) => {
      const r = world.run([world.sha]);
      assert.equal(r.status, 0, `exit ${String(r.status)}\n${r.stdout}\n${r.stderr}`);
      const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('gh release create '));
      assert.ok(line, r.stdout);
      const argv = words(line);
      const asset = argv.at(-1) ?? '';
      const notes = argv[argv.indexOf('--notes-file') + 1] ?? '';
      const runDirs = new RegExp(`^${world.tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.scratch/release/v${VERSION.replace(/\./g, '\\.')}/run-${RUN_ID}-[A-Za-z0-9]{6}/`);
      assert.match(asset, new RegExp(`${runDirs.source}ci-vsix/${VSIX.replace(/\./g, '\\.')}$`), `the printed asset is the unpacked one: ${asset}`);
      assert.equal(fs.lstatSync(asset).isFile(), true, 'and it is a file, not a link');
      const ciSha = sha256(world.ciVsix);
      assert.equal(sha256(fs.readFileSync(asset)), ciSha, 'its bytes are the .vsix inside the CI zip');
      assert.ok(r.stdout.includes(`its sha256: ${ciSha}`), 'the printed sha256 is that .vsix\'s');
      assert.ok(fs.readFileSync(notes, 'utf8').includes(ciSha), 'and so is the one in the notes');
      assert.ok(fs.readFileSync(notes, 'utf8').includes("VS Code 1.146.0 on GitHub's Ubuntu runner"), 'the notes name the VS Code the run\'s own log names');
      const said = `${r.stdout}\n${r.stderr}`;
      assert.ok(!said.includes(world.decoyPath), 'the decoy in the tree root is never named');
      assert.equal(argv.filter((w) => w.endsWith('.vsix')).length, 1, 'one .vsix on the command line');
      assertOnlyReads(world, createCalls(world.sha));
    });
  });

  test('--verify-draft says MATCH only about the CI artifact\'s bytes', () => {
    withWorld({ draft: 'ci' }, (world) => {
      const r = world.run([world.sha, '--verify-draft']);
      assert.equal(r.status, 0, `exit ${String(r.status)}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stdout.includes(`MATCH`) && r.stdout.includes(`sha256 ${sha256(world.ciVsix)}`), r.stdout);
      assert.ok(!`${r.stdout}\n${r.stderr}`.includes(world.decoyPath), 'the decoy is never named');
      assertOnlyReads(world, [...createCalls(world.sha), ghRead.releaseDownload(VERSION, '<any>')]);
    });
  });

  test('--verify-draft refuses a draft carrying the stale local build, naming both hashes', () => {
    withWorld({ draft: 'decoy' }, (world) => {
      const r = world.run([world.sha, '--verify-draft']);
      assert.equal(r.status, 1, `exit ${String(r.status)}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes('REFUSED (draft-mismatch)'), r.stderr);
      assert.ok(r.stderr.includes(sha256(world.ciVsix)), 'it names the CI artifact\'s hash');
      assert.ok(!r.stdout.includes('MATCH'), r.stdout);
      assertOnlyReads(world, [...createCalls(world.sha), ghRead.releaseDownload(VERSION, '<any>')]);
    });
  });

  test('an artifact whose one entry is a symlink is refused before anything is read through it (review N5)', () => {
    withWorld({ symlinkEntry: true }, (world) => {
      const r = world.run([world.sha]);
      assert.equal(r.status, 1, `exit ${String(r.status)}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes('REFUSED (archive-contents)'), r.stderr);
      assert.ok(r.stderr.includes('not a file'), r.stderr);
      assert.ok(!r.stdout.includes('gh release create'), 'no command is printed');
    });
  });

  test('CLICOLOR_FORCE in the caller\'s environment does not reach gh (review N2)', () => {
    withWorld({}, (world) => {
      const r = world.run([world.sha], { CLICOLOR_FORCE: '1' });
      assert.equal(r.status, 0, `exit ${String(r.status)}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stdout.includes('gh release create'), r.stdout);
    });
  });
});
