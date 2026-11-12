// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-72: a `.gitattributes` repo-tour would read without end is refused before the digest.
 *
 * SAFETY: no test here ever lets repo-tour's real digest near a hostile file. A link to /dev/zero,
 * read for real, allocates until the process dies. The build tests use a core whose digest FAILS
 * the test if it is called, so a pre-flight that misses something fails loudly instead. The walk
 * itself only ever `lstat`s a `.gitattributes`; nothing here opens one.
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDir, buildFromRequest, markerPath, readMarker, resumeIfMarked, type BuildContext, type BuildCore, type GitRunner,
} from '../../src/start/build.js';
import {
  GITATTRIBUTES_MAX_BYTES, REPO_TOUR_NEVER_DESCEND, gitAttributesRefusal, hazardousGitAttributes,
} from '../../src/start/gitattributes.js';
import { emptyRequest, type BuildRequest } from '../../src/start/request.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A repository root: a folder with a `.git` in it, as repo-tour's walk decides. */
function repo(at: string): string {
  fs.mkdirSync(path.join(at, '.git'), { recursive: true });
  fs.writeFileSync(path.join(at, 'app.ts'), 'export const a = 1;\n');
  return at;
}

/** A repository whose `.git` is a FILE, as in a `git worktree` or a submodule's working tree. */
function pointerRepo(at: string): string {
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, '.git'), 'gitdir: ../.git/worktrees/x\n');
  fs.writeFileSync(path.join(at, 'app.ts'), 'export const a = 1;\n');
  return at;
}

/** A core whose digest must never run: the pre-flight refuses first, or this test fails. */
const NO_DIGEST: BuildCore = {
  digest: () => Promise.reject(new Error('T-72: the digest ran on a repository with a hostile .gitattributes')),
  buildPlan: () => Promise.reject(new Error('unreachable')),
  interpretPlan: () => Promise.reject(new Error('unreachable')),
  defaultCacheDir: () => tmp('t72-cache-'),
};

function context(more: Partial<BuildContext> = {}): BuildContext {
  return { core: NO_DIGEST, globalStorageRoot: tmp('t72-storage-'), provider: 'claude', model: 'claude-haiku-4-5-20251001', cachedOnly: true, ...more };
}

function request(repoPath: string, target: string): BuildRequest {
  return { ...emptyRequest(), recreate: true, repo: repoPath, target };
}

const LINK_REFUSAL = '.gitattributes is a link, which repo-tour would follow: remove it from the reference repository, or build from a copy without it';

/** Root can list any folder, so the folders some pins need cannot be made. */
const asRoot = process.getuid?.() === 0;

suite('T-72: a .gitattributes repo-tour would read without end', () => {
  test('the scan root: a link (to anything), a pipe, and a file over the bound are each refused; a small one is not', async () => {
    const link = repo(tmp('t72-link-'));
    fs.symlinkSync('/dev/zero', path.join(link, '.gitattributes'));
    assert.deepEqual(await hazardousGitAttributes(link), { file: path.join(link, '.gitattributes'), why: 'link' });

    // Not only /dev/zero: repo-tour follows any link, and what is behind it is the repository's choice.
    // (Each of these is only ever `lstat`ed.)
    const toFile = repo(tmp('t72-link-file-'));
    fs.writeFileSync(path.join(toFile, 'attrs.txt'), '*.lock linguist-generated\n');
    fs.symlinkSync(path.join(toFile, 'attrs.txt'), path.join(toFile, '.gitattributes'));
    const toDevice = repo(tmp('t72-link-urandom-'));
    fs.symlinkSync('/dev/urandom', path.join(toDevice, '.gitattributes'));
    const dangling = repo(tmp('t72-link-dangling-'));
    fs.symlinkSync(path.join(dangling, 'nothing-here'), path.join(dangling, '.gitattributes'));
    for (const root of [toFile, toDevice, dangling]) {
      assert.deepEqual(await hazardousGitAttributes(root), { file: path.join(root, '.gitattributes'), why: 'link' },
        `a link to ${fs.readlinkSync(path.join(root, '.gitattributes'))} was not refused: only the one to /dev/zero is`);
    }

    const pipe = repo(tmp('t72-pipe-'));
    const made = spawnSync('mkfifo', [path.join(pipe, '.gitattributes')]);
    assert.equal(made.status, 0, 'mkfifo is needed to make the pipe');
    assert.deepEqual(await hazardousGitAttributes(pipe), { file: path.join(pipe, '.gitattributes'), why: 'not-a-file' });

    const big = repo(tmp('t72-big-'));
    fs.writeFileSync(path.join(big, '.gitattributes'), Buffer.alloc(GITATTRIBUTES_MAX_BYTES + 1, 0x20));
    assert.deepEqual(await hazardousGitAttributes(big), { file: path.join(big, '.gitattributes'), why: 'too-large', bytes: GITATTRIBUTES_MAX_BYTES + 1 });

    const fine = repo(tmp('t72-fine-'));
    fs.writeFileSync(path.join(fine, '.gitattributes'), '*.min.js linguist-generated\nvendor/** linguist-vendored\n');
    assert.equal(await hazardousGitAttributes(fine), null);
    assert.equal(await hazardousGitAttributes(repo(tmp('t72-none-'))), null, 'no .gitattributes at all');
    const asFolder = repo(tmp('t72-folder-'));
    fs.mkdirSync(path.join(asFolder, '.gitattributes'));
    assert.equal(await hazardousGitAttributes(asFolder), null, "a folder: repo-tour's read fails at once and it carries on");
  });

  test('a NESTED repository is checked as repo-tour reads it, and only where its walk goes', async () => {
    const root = repo(tmp('t72-nested-'));
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.lock linguist-generated\n');
    const nested = repo(path.join(root, 'packages', 'inner'));
    fs.symlinkSync('/dev/zero', path.join(nested, '.gitattributes'));
    assert.deepEqual(await hazardousGitAttributes(root), { file: path.join(nested, '.gitattributes'), why: 'link' });

    // Where repo-tour's walk never goes, nothing is read, so nothing is refused.
    const quiet = repo(tmp('t72-quiet-'));
    for (const skipped of ['node_modules/dep', '.venv/lib/x', '.repo-tour/cache']) {
      const inner = repo(path.join(quiet, ...skipped.split('/')));
      fs.symlinkSync('/dev/zero', path.join(inner, '.gitattributes'));
    }
    const noGit = path.join(quiet, 'docs'); // a folder with no .git: repo-tour does not read its .gitattributes
    fs.mkdirSync(noGit);
    fs.symlinkSync('/dev/zero', path.join(noGit, '.gitattributes'));
    const elsewhere = repo(tmp('t72-elsewhere-'));
    fs.symlinkSync('/dev/zero', path.join(elsewhere, '.gitattributes'));
    fs.symlinkSync(elsewhere, path.join(quiet, 'linked')); // a link to a folder: the walk does not follow it
    assert.equal(await hazardousGitAttributes(quiet), null);
  });

  test('a .git FILE marks a repository too: a worktree at the root, and a submodule-style one nested', async () => {
    const worktree = pointerRepo(tmp('t72-worktree-'));
    fs.symlinkSync('/dev/zero', path.join(worktree, '.gitattributes'));
    assert.deepEqual(await hazardousGitAttributes(worktree), { file: path.join(worktree, '.gitattributes'), why: 'link' },
      "a root whose .git is a file was not taken for a repository, but repo-tour's maybeRepo takes any .git");

    const root = repo(tmp('t72-pointer-nested-'));
    const nested = pointerRepo(path.join(root, 'modules', 'lib'));
    fs.symlinkSync('/dev/zero', path.join(nested, '.gitattributes'));
    assert.deepEqual(await hazardousGitAttributes(root), { file: path.join(nested, '.gitattributes'), why: 'link' },
      'a nested folder whose .git is a file was not taken for a repository');
  });

  test('the walk never enters .git, as repo-tour\'s does not', async () => {
    const root = repo(tmp('t72-inside-git-'));
    const inside = repo(path.join(root, '.git', 'modules', 'lib'));
    fs.symlinkSync('/dev/zero', path.join(inside, '.gitattributes'));
    assert.equal(await hazardousGitAttributes(root), null, 'the walk went into .git, where repo-tour never reads anything');
  });

  test('a folder that can be searched but not listed (0311) is checked as repo-tour reads it: the scan root, and a nested one', async function () {
    if (asRoot) this.skip();
    // repo-tour's maybeRepo `lstat`s <dir>/.git and reads <dir>/.gitattributes BY NAME, before it
    // lists <dir>. Listing fails here, and both by-name reads succeed (T-72 reviews, both).
    const root = repo(tmp('t72-xonly-root-'));
    fs.symlinkSync('/dev/zero', path.join(root, '.gitattributes'));
    const outer = repo(tmp('t72-xonly-nested-'));
    const inner = repo(path.join(outer, 'vendor', 'lib'));
    fs.symlinkSync('/dev/zero', path.join(inner, '.gitattributes'));
    fs.chmodSync(root, 0o311);
    fs.chmodSync(inner, 0o311);
    try {
      assert.throws(() => fs.readdirSync(root), { code: 'EACCES' }, 'the fixture has to be a folder that cannot be listed');
      assert.deepEqual(await hazardousGitAttributes(root), { file: path.join(root, '.gitattributes'), why: 'link' },
        'a scan root that cannot be listed was passed, but repo-tour reads its .gitattributes all the same');
      assert.deepEqual(await hazardousGitAttributes(outer), { file: path.join(inner, '.gitattributes'), why: 'link' },
        'a nested repository that cannot be listed was passed, but repo-tour reads its .gitattributes all the same');
      const target = tmp('t72-xonly-target-');
      const outcome = await buildFromRequest(request(root, target), context());
      assert.equal(outcome.reason, LINK_REFUSAL, 'the build has to refuse it before the digest');
    } finally {
      fs.chmodSync(root, 0o755);
      fs.chmodSync(inner, 0o755);
    }
  });

  test('a folder that cannot be read at all does not end the walk: its siblings are still checked', async function () {
    if (asRoot) this.skip();
    const root = repo(tmp('t72-locked-'));
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    const nested = repo(path.join(root, 'pkg', 'inner'));
    fs.symlinkSync('/dev/zero', path.join(nested, '.gitattributes'));
    // The walk visits a folder's sub-folders last-listed first. So `locked` is listed last here, and
    // visited before `pkg`, whatever order this filesystem lists them in.
    const promises = fs.promises as unknown as { readdir: (dir: string, opts: unknown) => Promise<fs.Dirent[]> };
    const real = promises.readdir;
    const listed: string[] = [];
    promises.readdir = async (dir, opts) => {
      listed.push(dir);
      const entries = await real.call(fs.promises, dir, opts);
      return [...entries].sort((a, b) => Number(a.name === 'locked') - Number(b.name === 'locked'));
    };
    fs.chmodSync(locked, 0o000);
    try {
      const found = await hazardousGitAttributes(root);
      assert.ok(listed.includes(locked), 'the fixture has to make the walk try the unreadable folder first');
      assert.deepEqual(found, { file: path.join(nested, '.gitattributes'), why: 'link' },
        'one folder that could not be read ended the walk, and the hazard beside it was never checked');
    } finally {
      promises.readdir = real;
      fs.chmodSync(locked, 0o755);
    }
  });

  test("REPO_TOUR_NEVER_DESCEND is repo-tour's own NEVER_DESCEND, as ../repo-tour/src/inventory.ts declares it", () => {
    const source = fs.readFileSync(path.join(process.cwd(), '..', 'repo-tour', 'src', 'inventory.ts'), 'utf8');
    const declared = /const NEVER_DESCEND = new Set\(\[([\s\S]*?)\]\);/.exec(source);
    assert.ok(declared, "repo-tour's src/inventory.ts no longer declares NEVER_DESCEND as `const NEVER_DESCEND = new Set([...]);`");
    const listed = declared[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const names = [...listed.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
    assert.ok(names.length >= 10, `read ${names.length} names from repo-tour's NEVER_DESCEND: this test is not reading it`);
    assert.deepEqual([...REPO_TOUR_NEVER_DESCEND].sort(), [...new Set(names)].sort(),
      "the copy in src/start/gitattributes.ts differs from repo-tour's NEVER_DESCEND, so the pre-flight walks a different set of folders");
  });

  test('the walk gives the event loop a turn as it goes: it never holds the thread for the whole repository', async () => {
    const root = repo(tmp('t72-yield-'));
    for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(root, `d${i}`));
    let turns = 0;
    let walking = true;
    const spin = (): void => {
      if (!walking) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    const found = await hazardousGitAttributes(root);
    walking = false;
    assert.equal(found, null);
    assert.ok(turns >= 100, `the event loop had ${turns} turns during a walk of 301 folders: the walk held the thread`);
  });

  test('the build refuses it BEFORE the digest and before the marker, says it is checking, and says what to do', async () => {
    const reference = repo(tmp('t72-ref-'));
    fs.symlinkSync('/dev/zero', path.join(reference, '.gitattributes'));
    const target = tmp('t72-target-');
    const progress: string[] = [];
    const phases: string[] = [];
    const started = Date.now();
    const outcome = await buildFromRequest(request(reference, target),
      context({ onProgress: (m) => progress.push(m), onPhase: (p) => phases.push(p) }));
    assert.ok(Date.now() - started < 2_000, 'the refusal should come at once');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, LINK_REFUSAL);
    assert.deepEqual(progress, ['checking the repository…'], 'the progress notification has to say what the build is doing while it checks');
    // `onPhase` fires as each marker is written: none may be, or a host that died during the check
    // would leave something to resume. (The refusal removes a marker too, so only this can tell.)
    assert.deepEqual(phases, [], 'the marker was written before the refusal');
    assert.equal(readMarker(target), null, 'a refused repository leaves nothing to resume');
    assert.deepEqual(fs.readdirSync(target), [], 'and nothing in the target');
  });

  test('on a Resume, the refusal removes the marker the crash left: nothing asks again, and the target is free', async () => {
    const reference = repo(tmp('t72-resume-ref-'));
    fs.symlinkSync('/dev/zero', path.join(reference, '.gitattributes'));
    const target = tmp('t72-resume-target-');
    // The marker a host that died in this very read left, before T-72.
    fs.mkdirSync(buildDir(target), { recursive: true });
    fs.writeFileSync(markerPath(target), JSON.stringify({ startedAt: new Date().toISOString(), phase: 'digest', request: request(reference, target) }));
    let asked = 0;
    const resume = { ...context(), confirm: (): Promise<'Resume'> => { asked += 1; return Promise.resolve('Resume'); } };
    const outcome = await resumeIfMarked(target, resume);
    assert.equal(asked, 1, 'the fixture has to be a marker resumeIfMarked offers to resume');
    assert.equal(outcome?.reason, LINK_REFUSAL);
    assert.equal(readMarker(target), null, 'the refused Resume left the crashed marker, so every reload asks again and is refused again');
    assert.deepEqual(fs.readdirSync(target), [], 'the target has to be empty again, or the next press on the same form is refused as "not empty"');
    assert.equal(await resumeIfMarked(target, resume), undefined);
    assert.equal(asked, 1, 'a second activation asked again');
  });

  test('for a GitHub URL it is the CLONE that is checked, before the digest', async () => {
    const storage = tmp('t72-url-storage-');
    const calls: string[][] = [];
    // A git whose clone writes what a hostile repository's would: `.git`, and `.gitattributes` as a link.
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'clone') {
        const dest = args[2]!;
        repo(dest);
        fs.symlinkSync('/dev/zero', path.join(dest, '.gitattributes'));
      }
      return Promise.resolve('');
    };
    const target = tmp('t72-url-target-');
    const outcome = await buildFromRequest(request('https://github.com/someone/hostile', target), context({ globalStorageRoot: storage, git }));
    assert.deepEqual(calls.map((c) => c[0]), ['clone'], 'the fixture has to take the URL path, through a clone');
    assert.match(outcome.reason ?? '', /^\.gitattributes is a link, which repo-tour would follow/, "the pre-flight did not check the clone: for a URL, the reference is the clone, not the URL");
    // Code review, finding 5: the clone is only ever fetched, so "remove it from the reference
    // repository" would leave the learner refused for ever. The words name the way that works.
    assert.equal(outcome.reason, '.gitattributes is a link, which repo-tour would follow: clone the repository yourself, remove it in your copy, and build from that folder');
    assert.equal(readMarker(target), null);
  });

  test('a Cancel during the walk stops it, and the build ends the usual way, before the digest', async () => {
    const root = repo(tmp('t72-cancel-'));
    for (let i = 0; i < 200; i++) fs.mkdirSync(path.join(root, `d${i}`));
    /** Cancel is pressed once the walk has begun, and stays pressed, as a cancellation token does. */
    const pressedAfter = (folders: number): (() => boolean) => {
      let asked = 0;
      let pressed = false;
      return () => (pressed ||= ++asked > folders);
    };
    assert.equal(await hazardousGitAttributes(root, pressedAfter(5)), 'cancelled', 'the walk went on after the Cancel');
    const target = tmp('t72-cancel-target-');
    const outcome = await buildFromRequest(request(root, target), context({ isCancelled: pressedAfter(5) }));
    assert.deepEqual(outcome, { ok: false, cancelled: true, reason: 'build cancelled while checking the repository' });
    assert.equal(readMarker(target), null);
    assert.deepEqual(fs.readdirSync(target), []);
  });

  test("the refusal's words name the file relative to the reference, for each kind, and state the bound", () => {
    const root = '/r';
    assert.equal(gitAttributesRefusal(root, { file: '/r/packages/inner/.gitattributes', why: 'link' }),
      'packages/inner/.gitattributes is a link, which repo-tour would follow: remove it from the reference repository, or build from a copy without it');
    assert.match(gitAttributesRefusal(root, { file: '/r/.gitattributes', why: 'not-a-file' }), /^\.gitattributes is not a regular file \(a pipe or a device\)/);
    assert.equal(gitAttributesRefusal(root, { file: '/r/.gitattributes', why: 'too-large', bytes: 3 * 1024 * 1024 }, 'url'),
      '.gitattributes is 3.0 MB, over the 1 MB a .gitattributes may be: clone the repository yourself, remove it in your copy, and build from that folder');
    assert.match(gitAttributesRefusal(root, { file: '/r/.gitattributes', why: 'too-large', bytes: 3 * 1024 * 1024 }),
      /^\.gitattributes is 3\.0 MB, over the 1 MB a \.gitattributes may be: remove it/);
    assert.match(gitAttributesRefusal(root, { file: '/r/.gitattributes', why: 'too-large', bytes: GITATTRIBUTES_MAX_BYTES + 1 }),
      /^\.gitattributes is 1\.1 MB, over the 1 MB/, 'a size just over the bound must not read as "1.0 MB, over the 1 MB"');
  });
});
