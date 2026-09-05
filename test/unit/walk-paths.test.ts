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
 */

import * as assert from 'node:assert/strict';
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
