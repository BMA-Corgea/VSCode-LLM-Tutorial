// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `resolveInsideTarget` — the containment check between a plan's `target.file` and the
 * learner's folder (T-4 security review, finding 2).
 *
 * The bug this exists to prevent is that `path.join` reads like a containment check and is
 * not one. `path.join('/home/you/repo', '../../../.ssh/id_rsa')` is `/home/.ssh/id_rsa`, and
 * the walk reveals the current step's file automatically on activation — so between a
 * crafted `plan.json` and an opened file there is no user gesture at all. Today that is a
 * read; T-5 writes the learner's files at these same paths, which makes it a write.
 *
 * Both directions are pinned. A check that rejects everything would "pass" a suite that only
 * tested escapes, and would break every ordinary step in every real plan — so the ordinary
 * cases are asserted just as carefully as the hostile ones.
 *
 * The THIRD direction is pinned too, at the bottom: what this deliberately does not do. T-5's
 * security review found a HIGH in the gap between the lexical check and the filesystem, and
 * the reason it survived a review was a comment that read as though the job were finished. A
 * test is a harder thing to misread than a comment, so the boundary is asserted rather than
 * described.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInsideTarget } from '../../src/walk/paths.js';

const TARGET = path.resolve('/home/learner/project');

suite('resolveInsideTarget — ordinary plan paths still resolve', () => {
  test('a plain relative file', () => {
    assert.equal(resolveInsideTarget(TARGET, 'src/parse.ts'), path.join(TARGET, 'src', 'parse.ts'));
  });

  test('a nested one, and a directory (a `shape` step\'s target is a directory)', () => {
    assert.equal(resolveInsideTarget(TARGET, 'src/api/routes.ts'), path.join(TARGET, 'src', 'api', 'routes.ts'));
    assert.equal(resolveInsideTarget(TARGET, 'public'), path.join(TARGET, 'public'));
  });

  test('the `@misc` sentinel resolves to a contained path that simply does not exist', () => {
    // Not a path at all, but repo-tour emits it as one; containment is the only question
    // here, and "does it exist" is answered later by the fs gate.
    assert.equal(resolveInsideTarget(TARGET, '@misc'), path.join(TARGET, '@misc'));
  });

  test('an interior `..` that stays inside is fine — this is not a substring check', () => {
    assert.equal(resolveInsideTarget(TARGET, 'src/../public/xray.js'), path.join(TARGET, 'public', 'xray.js'));
  });

  test('the target itself', () => {
    assert.equal(resolveInsideTarget(TARGET, '.'), TARGET);
  });
});

suite('resolveInsideTarget — anything that leaves the folder is null', () => {
  test('climbing out with ..', () => {
    assert.equal(resolveInsideTarget(TARGET, '../../../.ssh/id_rsa'), null);
    assert.equal(resolveInsideTarget(TARGET, '..'), null);
    assert.equal(resolveInsideTarget(TARGET, 'src/../../../etc/passwd'), null);
  });

  test('an absolute path, which path.join would have quietly made relative', () => {
    // `path.join(TARGET, '/etc/passwd')` is `<TARGET>/etc/passwd` — contained, but NOT what
    // the plan asked for. `resolve` honours the absolute path, so containment must reject it.
    assert.equal(resolveInsideTarget(TARGET, '/etc/passwd'), null);
  });

  test('a sibling directory that merely shares a name prefix', () => {
    // The classic off-by-one in containment checks: `startsWith(target)` without the
    // separator lets `/home/learner/project-evil` through.
    assert.equal(resolveInsideTarget(TARGET, '../project-evil/secrets.env'), null);
  });

  test('anything that is not a non-empty string', () => {
    for (const bad of [undefined, null, 42, {}, [], '']) {
      assert.equal(resolveInsideTarget(TARGET, bad), null, `${JSON.stringify(bad)} should not resolve`);
    }
  });
});

// ── the boundary: what this check is NOT ────────────────────────────────────────────────────

/**
 * `resolveInsideTarget` is the LEXICAL half of containment, and the whole of what this module
 * can be: `src/walk/session.ts` has to stay loadable without `fs`, so the check the session
 * needs has to be arithmetic on strings. Arithmetic on strings cannot see a symlink.
 *
 * The test below therefore asserts that a symlinked directory PASSES — which looks, out of
 * context, like a test asserting a vulnerability. It is the opposite. T-5's security review
 * found that gap being treated as if it did not exist (finding 1: the write landed outside the
 * learner's folder), and what let that ship was a header claiming the hole was closed. So the
 * division of labour is pinned here on purpose, in both halves:
 *
 *   - if someone gives this module `fs` and makes it refuse symlinks, this test fails and
 *     tells them the contract moved and `src/walk/session.ts` can no longer load it;
 *   - and the same symlink is refused for real in `dial-writer.test.ts`, where the filesystem
 *     half lives (`prepareDirectory`). Neither suite is complete without the other, which is
 *     the honest shape of a check that comes in two pieces.
 */
suite('resolveInsideTarget — the lexical half, and exactly where it ends', () => {
  test('a REAL symlinked directory inside the target passes — by design, and not by accident', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-paths-'));
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    // Exactly what a repository can commit; git recreates it on clone, so it is free.
    fs.symlinkSync(path.join('..', 'outside'), path.join(target, 'up'));

    // Contained, as a string. Every check in `paths.ts` agrees, and every one of them is right
    // about the question it was asked.
    assert.equal(resolveInsideTarget(target, 'up/victim.txt'), path.join(target, 'up', 'victim.txt'));

    // And here is the other question, the one only a filesystem can answer: that path's real
    // directory is not in the target at all. `src/dial/writer.ts` is what asks it before any
    // write, and `dial-writer.test.ts` is what proves the answer is acted on.
    assert.equal(fs.realpathSync(path.join(target, 'up')), fs.realpathSync(outside));
    assert.equal(resolveInsideTarget(fs.realpathSync(target), fs.realpathSync(path.join(target, 'up'))), null);

    fs.rmSync(sandbox, { recursive: true, force: true });
  });
});
