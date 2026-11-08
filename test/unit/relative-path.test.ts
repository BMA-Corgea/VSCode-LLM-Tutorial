// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/relative-path.ts` — the one lexical rule for a model-chosen path (T-17 hoist).
 *
 * The detour's own suite (`detour-prompt.test.ts`) drives every attack through
 * `unsafeDetourPathReason` and matches each refusal loosely (`/deep/i`, `/longer than/i`). That is
 * right for what it proves. It also means a WRONG folder word passed into the shared rule left
 * all 271 detour tests green. This was measured when the rule was hoisted, by passing `'XX folder'`:
 * zero failures. So the sentences that carry the caller's word are pinned here, exactly, together
 * with the property the hoist exists for: each caller's own word and bounds reach its sentences,
 * and nothing else differs.
 */

import * as assert from 'node:assert/strict';
import { MAX_DETOUR_PATH_CHARS, MAX_DETOUR_PATH_SEGMENTS, unsafeDetourPathReason } from '../../src/detour/prompt.js';
import { unsafeRelativePathReason, type RelativePathRules } from '../../src/relative-path.js';

const OTHER: RelativePathRules = { folder: 'reference tree', maxChars: 40, maxSegments: 3 };

suite('unsafeRelativePathReason — one rule, each caller\'s own word and bounds', () => {
  test('the detour still says exactly what it always said about a ".." segment', () => {
    assert.equal(
      unsafeDetourPathReason('../escape.ts'),
      'contains a ".." segment, which climbs out of the detour folder',
    );
  });

  test('another caller\'s word reaches the same sentence, and only the word differs', () => {
    assert.equal(
      unsafeRelativePathReason('a/../escape.mjs', OTHER),
      'contains a ".." segment, which climbs out of the reference tree',
    );
  });

  test('each caller\'s bounds are its own — the detour\'s numbers never leak into another caller', () => {
    const long = 'a'.repeat(OTHER.maxChars + 1);
    assert.equal(unsafeRelativePathReason(long, OTHER), `is longer than ${OTHER.maxChars} characters`);
    assert.equal(unsafeDetourPathReason(long), null, 'the same path is within the detour\'s own, larger, bound');
    assert.ok(OTHER.maxChars + 1 <= MAX_DETOUR_PATH_CHARS, 'the fixture assumes the detour\'s bound is the larger one');

    const deep = 'a/b/c/d.mjs';
    assert.equal(unsafeRelativePathReason(deep, OTHER), `is nested more than ${OTHER.maxSegments} directories deep`);
    assert.equal(unsafeDetourPathReason(deep), null);
    assert.ok(4 <= MAX_DETOUR_PATH_SEGMENTS);
  });

  test('every named attack is refused for every caller, with the same sentence', () => {
    const attacks: Array<[unknown, string]> = [
      [42, 'is a number, not a string'],
      ['', 'is empty'],
      ['   ', 'is only whitespace'],
      ['a\u0000b', 'contains a NUL byte'],
      ['a\u0007b', 'contains a control character'],
      ['C:/x.mjs', 'names a Windows drive letter'],
      ['//host/share', 'is a UNC path'],
      ['/etc/passwd', 'is an absolute path'],
      ['a\\b.mjs', 'contains a backslash, which is a path separator on Windows'],
      ['dir/', 'ends with a path separator, so it names a directory rather than a file'],
      ['a//b.mjs', 'has an empty path segment'],
      ['./a.mjs', 'contains a "." segment'],
      ['.git/hooks/pre-commit', 'has a segment beginning with a dot'],
      ['.vscode/tasks.json', 'has a segment beginning with a dot'],
      ['a./b.mjs', 'has a segment ending in a dot or a space, which Windows silently strips'],
      ['con.mjs', 'names a reserved Windows device'],
      ['-rf', 'has a segment with characters outside letters, digits, dot, dash and underscore'],
    ];
    for (const [value, sentence] of attacks) {
      assert.equal(unsafeRelativePathReason(value, OTHER), sentence, `for ${JSON.stringify(value)}`);
      assert.equal(unsafeDetourPathReason(value), sentence, `the detour, for ${JSON.stringify(value)}`);
    }
  });

  test('an ordinary relative path is accepted (discriminates against refusing everything)', () => {
    assert.equal(unsafeRelativePathReason('app/store.mjs', OTHER), null);
    assert.equal(unsafeDetourPathReason('src/kitchen/order.ts'), null);
  });
});
