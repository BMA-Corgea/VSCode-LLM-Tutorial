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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import {
  buildFromRequest, coreFor, everyQuestionFailed, failedQuestionsSentence, questionTally, type InterpretCostLike,
} from '../../src/start/build.js';
import { emptyRequest } from '../../src/start/request.js';

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
    assert.match(said, /Why \(lookup\.js\): claude exited with code 1: not logged in\./);
    assert.match(said, /installed and logged in \(Build Tutorials: Doctor shows whether it is found\)/);
    assert.match(said, /build again into an empty folder/);
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
    assert.match(said, /^The build got no answer from the model: every one of its 3 questions failed/);
    assert.match(said, /The first reason \(index\.js\): claude was not found on PATH\./);
    assert.match(said, /logged in \(Build Tutorials: Doctor shows whether it is found\), then build again into an empty folder/);
    assert.match(said, /You can still walk the plan it wrote/);
    assert.doesNotMatch(said, /commit/, 'a plain-folder reference has no commits');
  });

  test('answers from the cache are answers: a build whose asked questions all failed but which had cached ones is not "every"', () => {
    const c = cost({ cachedStops: 5, failures: ['src/b.js: claude was not found on PATH'] });
    assert.equal(everyQuestionFailed(c), false);
    assert.match(failedQuestionsSentence(c) ?? '', /^1 of 1 question to the model failed/);
  });

  test('one full stop after a reason however it ended, a long path cannot crowd out the words, and another provider is named (review S4, M1)', () => {
    const said = failedQuestionsSentence(cost({ calls: 1, interpretedStops: 2, provider: 'codex', failures: ['a/very/long/path/to/some/deeply/nested/file/name.js: rate limited..'] } as never)) ?? '';
    assert.match(said, /Why \(name\.js\): rate limited\. Check that codex is installed and can be reached/);
  });

  test('a long reason is cut, and a cost that is not shaped as expected is read as nothing failed', () => {
    const c = cost({ failures: [`src/c.js: ${'x'.repeat(500)}`] });
    assert.ok((failedQuestionsSentence(c) ?? '').length < 520, 'a failure reason was quoted whole');
    assert.equal(failedQuestionsSentence({ metered: true, usd: 0, inputTokens: 0, outputTokens: 0, failures: 'nope' }), undefined);
  });
});

/**
 * T-171 review M2: the pin the DONE WHEN names, "a provider that fails every call", through repo-tour's REAL
 * `interpretStops`, as T-70 drives it (`test/unit/off-thread.test.ts`): repo-tour's own modules, its llm module's
 * provider swapped for a stub, its cache in a fresh folder, and no model CLI findable. If repo-tour ever counts or words
 * these differently, these fail here rather than a stranger's build going back to "Done".
 */
suite('T-171: a real build through repo-tour, with a provider that fails', function () {
  this.timeout(60_000);
  let loaded: CoreLoadResult;
  const made: string[] = [];
  const tmp = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
  const saved = { claude: process.env.REPO_TOUR_CLAUDE_BIN, codex: process.env.REPO_TOUR_CODEX_BIN };

  suiteSetup(async () => {
    loaded = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
    assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
    const nowhere = tmp('t171-no-cli-');
    process.env.REPO_TOUR_CLAUDE_BIN = path.join(nowhere, 'no-such-claude');
    process.env.REPO_TOUR_CODEX_BIN = path.join(nowhere, 'no-such-codex');
  });
  suiteTeardown(() => {
    if (saved.claude === undefined) delete process.env.REPO_TOUR_CLAUDE_BIN; else process.env.REPO_TOUR_CLAUDE_BIN = saved.claude;
    if (saved.codex === undefined) delete process.env.REPO_TOUR_CODEX_BIN; else process.env.REPO_TOUR_CODEX_BIN = saved.codex;
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture(): string {
    const root = tmp('t171-fixture-');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), "import { add } from './util.js';\n\nexport function twice(a: number): number {\n  return add(a, a);\n}\n");
    return root;
  }

  async function buildWith(run: (prompt: string) => Promise<unknown>): Promise<InterpretCostLike> {
    const cache = tmp('t171-interpret-cache-');
    const core = coreFor({
      ...loaded.loaded,
      llm: { ...(loaded.loaded['llm'] as object), providerById: () => ({ run }) },
      interpret: { ...(loaded.loaded['interpret'] as object), defaultCacheDir: () => cache },
    });
    const target = tmp('t171-target-');
    const outcome = await buildFromRequest({ ...emptyRequest(), recreate: true, repo: fixture(), target },
      // isCancelled as every build the extension makes has one: it is what puts the core's runner (and so this
      // provider) between repo-tour and the model, rather than repo-tour's own CLI lookup.
      { core, globalStorageRoot: tmp('t171-storage-'), provider: 'claude', model: 'stub', cachedOnly: false, isCancelled: () => false });
    assert.equal(outcome.ok, true, outcome.reason);
    assert.ok(outcome.cost, 'the build reported no cost');
    return outcome.cost;
  }

  test('every call fails: every question is counted, none answered, and the build says so', async () => {
    let n = 0;
    const c = await buildWith(() => { n += 1; return Promise.reject(new Error('Not logged in · Please run /login')); });
    const t = questionTally(c);
    assert.ok(n >= 2, `the provider was asked ${n} times; the fixture's two files should each be a question (${JSON.stringify(c)})`);
    assert.equal(t.asked, n, `${n} questions were put to the provider; the tally says ${t.asked} (${JSON.stringify(c)})`);
    assert.equal(t.failed, t.asked);
    assert.equal(everyQuestionFailed(c), true, `a real build whose every call failed was not seen as such: ${JSON.stringify(c)}`);
    assert.match(failedQuestionsSentence(c) ?? '', new RegExp(`every one of its ${t.asked} questions failed`));
    assert.match(failedQuestionsSentence(c) ?? '', /Not logged in · Please run \/login\./, 'the provider\'s own words');
  });

  test('a reply that is not JSON is one question, not two, as repo-tour really counts it', async () => {
    let n = 0;
    const c = await buildWith(() => { n += 1; return n === 1 ? Promise.resolve({ text: 'not json at all', inputTokens: 1, outputTokens: 1, usd: 0, metered: true }) : Promise.reject(new Error('rate limited')); });
    const t = questionTally(c);
    assert.equal(t.asked, n, `${n} questions were put to the provider; the tally says ${t.asked} (${JSON.stringify(c)})`);
    assert.equal(t.failed, n);
  });
});
