// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-72: a `.gitattributes` repo-tour would read without end is refused before the digest.
 *
 * SAFETY: no test here ever lets repo-tour's real digest near a hostile file. A link to /dev/zero,
 * read for real, allocates until the process dies. The build tests use a core whose digest FAILS
 * the test if it is called, so a pre-flight that misses something fails loudly instead.
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFromRequest, readMarker, type BuildCore } from '../../src/start/build.js';
import { GITATTRIBUTES_MAX_BYTES, gitAttributesRefusal, hazardousGitAttributes } from '../../src/start/gitattributes.js';
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

/** A core whose digest must never run: the pre-flight refuses first, or this test fails. */
const NO_DIGEST: BuildCore = {
  digest: () => Promise.reject(new Error('T-72: the digest ran on a repository with a hostile .gitattributes')),
  buildPlan: () => Promise.reject(new Error('unreachable')),
  interpretPlan: () => Promise.reject(new Error('unreachable')),
  defaultCacheDir: () => tmp('t72-cache-'),
};

suite('T-72: a .gitattributes repo-tour would read without end', () => {
  test('the scan root: a link to /dev/zero, a pipe, and a file over the bound are each refused; a small one is not', async () => {
    const link = repo(tmp('t72-link-'));
    fs.symlinkSync('/dev/zero', path.join(link, '.gitattributes'));
    assert.deepEqual(await hazardousGitAttributes(link), { file: path.join(link, '.gitattributes'), why: 'link' });

    const pipe = repo(tmp('t72-pipe-'));
    const made = spawnSync('mkfifo', [path.join(pipe, '.gitattributes')]);
    assert.equal(made.status, 0, 'mkfifo is needed to make the pipe');
    assert.equal((await hazardousGitAttributes(pipe))?.why, 'not-a-file');

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

  test('the build refuses it BEFORE the digest and before the marker, with words that say what to do', async () => {
    const reference = repo(tmp('t72-ref-'));
    fs.symlinkSync('/dev/zero', path.join(reference, '.gitattributes'));
    const target = tmp('t72-target-');
    const request: BuildRequest = { ...emptyRequest(), recreate: true, repo: reference, target };
    const started = Date.now();
    const outcome = await buildFromRequest(request, {
      core: NO_DIGEST, globalStorageRoot: tmp('t72-storage-'), provider: 'claude', model: 'claude-haiku-4-5-20251001', cachedOnly: true,
    });
    assert.ok(Date.now() - started < 2_000, 'the refusal should come at once');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, '.gitattributes is a link, which repo-tour would follow and might read without end: remove it from the reference repository, or build from a copy without it');
    assert.equal(readMarker(target), null, 'a refused repository leaves nothing to resume');
    assert.deepEqual(fs.readdirSync(target), [], 'and nothing in the target');
  });

  test("the refusal's words name the file relative to the reference, for each kind", () => {
    const root = '/r';
    assert.equal(gitAttributesRefusal(root, { file: '/r/packages/inner/.gitattributes', why: 'link' }),
      'packages/inner/.gitattributes is a link, which repo-tour would follow and might read without end: remove it from the reference repository, or build from a copy without it');
    assert.match(gitAttributesRefusal(root, { file: '/r/.gitattributes', why: 'not-a-file' }), /^\.gitattributes is not a regular file \(a pipe or a device\)/);
    assert.match(gitAttributesRefusal(root, { file: '/r/.gitattributes', why: 'too-large', bytes: 3 * 1024 * 1024 }), /^\.gitattributes is 3\.0 MB, far too large to be a \.gitattributes:/);
  });
});
