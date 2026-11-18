// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-122's blind review, F1 and F3: what the press's record makes a later reload do and say.
 *
 * The record (`buildTutorials.pressedRequest`) is written and cleared in `src/extension.ts`, which only the host suite
 * runs. These pins read the source instead, as `resume-tell.test.ts` does: the record is written before the bookmark
 * (F3); a press that ended before its first write keeps neither, since only its own marker keeps them (F1); and the
 * reload says only what it knows, that the folder's build is not the one pressed (F1).
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');

function body(name: string): string {
  const at = SOURCE.search(new RegExp(`\\n(?:export )?async function ${name}\\(`));
  assert.ok(at >= 0, `src/extension.ts no longer declares ${name}`);
  const next = SOURCE.slice(at + 1).search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return next < 0 ? SOURCE.slice(at) : SOURCE.slice(at, at + 1 + next);
}

suite('T-122 review: the press\'s record', () => {
  test('F3: runBuild writes the record before the bookmark, so a reload between the two never pairs a new bookmark with an older press', () => {
    const text = body('runBuild');
    const record = text.indexOf('workspaceState.update(PRESSED_REQUEST_KEY, request)');
    const bookmark = text.indexOf('workspaceState.update(CURRENT_BUILD_KEY, request.target)');
    assert.ok(record >= 0 && bookmark >= 0, 'runBuild no longer writes the record and the bookmark');
    assert.ok(record < bookmark, 'the bookmark is written before the record');
  });

  test('F1: a press that ended before its first write keeps neither the bookmark nor the record: only its own marker keeps them', () => {
    assert.match(body('runBuild'), /await forgetUnlessResumable\(context, request\.target, request\);/,
      'runBuild\'s ending does not say which request was pressed');
    assert.match(body('forgetUnlessResumable'), /!sameRequest\(pressed, marker\.request\)/,
      'another request\'s marker keeps the bookmark and the record after a press');
  });

  test('F1: the reload says only that the folder\'s build is not the one pressed, never that the press was interrupted', () => {
    const text = body('resumeOnActivate');
    assert.doesNotMatch(text, /interrupted before it began/, 'the reload claims the press was interrupted, which it cannot know');
    assert.match(text, /deps\.tell\(`Build Tutorials: the build in \$\{target\} is not the one you last pressed in this window, so nothing was resumed: press Build the plan to start yours again`\)/,
      'the reload does not say the folder\'s build is not the one pressed');
  });
});
