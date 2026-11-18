// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-171: a build whose questions to the model failed says so, and one where every question failed is not a success.
 *
 * repo-tour's `interpretStops` asks one question per file, records each failure in `cost.failures` and goes on, and
 * the build used to end "N chapters · M steps — $0.00, 0 tokens" whatever had happened: a stranger whose `claude` was
 * missing or logged out got a plan with no answers in it and no word why. These drive the build's own reading of
 * that cost: how many questions were asked and failed, the sentence the ending says, and whether ANY answer exists.
 */

import * as assert from 'node:assert/strict';
import { everyQuestionFailed, failedQuestionsSentence, questionTally, type InterpretCostLike } from '../../src/start/build.js';

const UNPARSED = 'the reply was not the JSON that was asked for';

function cost(over: Partial<{ calls: number; failures: string[]; interpretedStops: number; cachedStops: number }> = {}): InterpretCostLike {
  return { metered: true, usd: 0, inputTokens: 0, outputTokens: 0, calls: 0, cachedStops: 0, interpretedStops: 0, failures: [], ...over };
}

suite('T-171: the build says how many of its questions to the model failed', () => {
  test('a build with no failure says nothing more', () => {
    const c = cost({ calls: 4, interpretedStops: 9 });
    assert.deepEqual(questionTally(c), { asked: 4, failed: 0 });
    assert.equal(failedQuestionsSentence(c), undefined);
    assert.equal(everyQuestionFailed(c), false);
  });

  test('some failed: k of n, the first reason, and the Doctor', () => {
    const c = cost({ calls: 3, interpretedStops: 7, failures: ['src/lookup.js: claude exited with code 1: not logged in'] });
    assert.deepEqual(questionTally(c), { asked: 4, failed: 1, first: 'src/lookup.js: claude exited with code 1: not logged in' });
    const said = failedQuestionsSentence(c);
    assert.ok(said !== undefined, 'a build with a failed question said nothing about it');
    assert.match(said, /^1 of 4 questions to the model failed/);
    assert.match(said, /src\/lookup\.js: claude exited with code 1: not logged in/);
    assert.match(said, /Build Tutorials: Doctor/);
    assert.equal(everyQuestionFailed(c), false, 'some answers came back: not every question failed');
  });

  test('a reply that was not JSON is one question, not two (it is counted in calls and in failures)', () => {
    const c = cost({ calls: 2, interpretedStops: 3, failures: [`src/a.js: ${UNPARSED}`] });
    assert.deepEqual(questionTally(c), { asked: 2, failed: 1, first: `src/a.js: ${UNPARSED}` });
  });

  test('every question failed (claude missing): not reported as a success, and says what the plan still holds', () => {
    const c = cost({ failures: ['index.js: claude was not found on PATH', 'lookup.js: claude was not found on PATH', 'utilities.js: claude was not found on PATH'] });
    assert.deepEqual(questionTally(c), { asked: 3, failed: 3, first: 'index.js: claude was not found on PATH' });
    assert.equal(everyQuestionFailed(c), true, 'a build with no answer at all was taken for a success');
    const said = failedQuestionsSentence(c) ?? '';
    assert.match(said, /every one of its 3 questions to the model failed/);
    assert.match(said, /index\.js: claude was not found on PATH/);
    assert.match(said, /Build Tutorials: Doctor/);
    assert.match(said, /You can still walk it/);
  });

  test('answers from the cache are answers: a build whose asked questions all failed but which had cached ones is not "every"', () => {
    const c = cost({ cachedStops: 5, failures: ['src/b.js: claude was not found on PATH'] });
    assert.equal(everyQuestionFailed(c), false);
    assert.match(failedQuestionsSentence(c) ?? '', /^1 of 1 question to the model failed/);
  });

  test('a long reason is cut, and a cost that is not shaped as expected is read as nothing failed', () => {
    const c = cost({ failures: [`src/c.js: ${'x'.repeat(500)}`] });
    assert.ok((failedQuestionsSentence(c) ?? '').length < 520, 'a failure reason was quoted whole');
    assert.equal(failedQuestionsSentence({ metered: true, usd: 0, inputTokens: 0, outputTokens: 0, failures: 'nope' }), undefined);
  });
});
