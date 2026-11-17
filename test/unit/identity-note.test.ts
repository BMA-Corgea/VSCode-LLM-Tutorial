// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-141: the identity note's place in a build's ending, read off `src/extension.ts` itself.
 *
 * Both endings, a press's (`runBuild`) and a Resume's (`resumeOnActivate`), tell the learner whose git lacks a name or
 * an email. Both settle the window's bookmark BEFORE they ask git, because the ask can take seconds and a bookmark
 * cleared late can wipe the bookmark of a build pressed meanwhile (review F2). And both offer the walk only after it.
 * The screen test drives the press's ending for real; the Resume's needs a finished real build, which spends a model
 * call, so this pin reads the order from the source (review F5), as T-72's pins of `neutraliseLinks` do.
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NO_IDENTITY_NOTE } from '../../src/dial/commit.js';

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');

/** The text of one top-level function, from its declaration to the next one. */
function body(name: string): string {
  const at = SOURCE.search(new RegExp(`\\n(?:export )?async function ${name}\\(`));
  assert.ok(at >= 0, `src/extension.ts no longer declares ${name}`);
  const next = SOURCE.slice(at + 1).search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return next < 0 ? SOURCE.slice(at) : SOURCE.slice(at, at + 1 + next);
}

/** Where each call is made in `text`, in the order the ending makes them; -1 for one that is not made. */
function order(text: string, calls: string[]): number[] {
  return calls.map((call) => text.indexOf(call));
}

suite('T-141: the identity note in a build\'s ending', () => {
  for (const [ending, target] of [['runBuild', 'request.target'], ['resumeOnActivate', 'target']] as const) {
    test(`${ending}: the ending is told, the bookmark settled, git asked, then the walk offered`, () => {
      const text = body(ending);
      const calls = ['reportOutcome(', `forgetUnlessResumable(context, ${target})`, `tellIfNoIdentity(${target})`, `openOrOfferWalk(context, ${target})`];
      const at = order(text, calls);
      for (const [i, call] of calls.entries()) assert.ok(at[i]! >= 0, `${ending} no longer calls ${call}`);
      assert.deepEqual([...at].sort((a, b) => a - b), at, `${ending} makes them in another order: ${calls.map((c, i) => `${c} at ${at[i]}`).join(', ')}`);
    });
  }

  test('the note says what is missing without claiming which, names both commands, and the code sets neither', () => {
    assert.equal(NO_IDENTITY_NOTE, 'git needs your name and email to commit each step you finish, and until both are set none will be: '
      + 'git config --global user.name "Your Name" and git config --global user.email "you@example.com" (the tutorial works either way)');
    // Every git this file runs for the note only reads: no `config` with a value, no `--add`, no `--global` write.
    const ask = body('askIdentity');
    for (const writes of [/'config',\s*'user\.(name|email)',/, /'--add'/, /'--global'/, /'--replace-all'/]) {
      assert.doesNotMatch(ask, writes, `askIdentity writes git's config: ${writes}`);
    }
  });
});
