// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AC-A1 made runnable (T-19): the learner's answers demonstrably change the plan.
 *
 * Same idea, answers differing at exactly one decision D: the steps downstream of D differ, and
 * the steps independent of D do not. Determinism first, or neither clause can be evaluated.
 *
 * The real `derivePlan`, the real `AskLedger`, repo-tour's real `extract`. The model is a fake
 * whose answers are a pure function of the prompt's `INPUT (JSON):` line: every file it writes
 * carries a hash of that line WITHOUT its `dependencies`, so a step shown anything else different
 * comes back different, and "the independent steps do not differ" also means nothing they were
 * shown differed. Not the dependencies: an independent step's dependencies are independent too, and
 * hashing them would make a step that nothing re-derived look as though it had responded.
 * `core.runLlm` is poisoned, so a test that forgot the fake fails instead of dialling out (pinned
 * below). No test spends a token. Every derivation starts from an empty cache, or the engine's cache
 * would answer the second run and hide a derivation that is not deterministic.
 *
 * AC-A1 tests whether the derivation LISTENS. It says nothing about whether the plan is any good.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO_TOUR_PATH, loadCore, resolveCoreRoot } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { derivePlan } from '../../src/derive/engine.js';
import { AskLedger } from '../../src/tutor/ask.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import {
  judgeResponsiveness, passed, stepsReaching,
  type DerivedFileLike, type Derivation, type Derived, type PlanLike, type Scenario, type StepLike, type Verdict,
} from '../support/responsiveness.js';
import { FIXTURE_IDEA, outlineWith, stepsOf } from './derive-fixtures.js';

const SPEND_GUARD = 'a test in derive-responsiveness.test.ts reached the real model';

let realCore: TutorCore;
let dialCore: DialCore;
const made: string[] = [];
const ledgers: AskLedger[] = [];

suiteSetup(async () => {
  const loaded = await loadCore(resolveCoreRoot(DEFAULT_REPO_TOUR_PATH, process.cwd()));
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found');
  realCore = tutorCoreFor(loaded.loaded);
  dialCore = dialCoreFor(loaded.loaded);
});

teardown(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * The fixture idea, with what AC-A1 needs to mean anything: a chain two hops long
 * (`core/tally.mjs` -> `cli/format.mjs` -> `cli/main.mjs`), so a re-derivation that stops at direct
 * dependents is caught, and a chapter that has nothing to do with it (`notes`).
 */
const CHAIN_OUTLINE = outlineWith((o) => {
  (o['chapters'] as unknown[]).splice(1, 0, { key: 'notes', title: 'Notes', subtitle: 'beside the rest' });
  const steps = stepsOf(o);
  // A third option on each decision the tests answer, so both runs can answer OFF the
  // recommendation: answering the recommendation does not replan at all.
  const optionsOf = (file: string): unknown[] => steps.find((s) => s['path'] === file)?.['options'] as unknown[];
  optionsOf('core/tally.mjs').push({ id: 'array', label: 'A list it appends to', consequence: 'simple; grows with use' });
  optionsOf('core').push({ id: 'c', label: 'A folder per feature', consequence: 'roomy; too much for a tally' });
  const main = steps.findIndex((s) => s['path'] === 'cli/main.mjs');
  steps.splice(main, 0, {
    kind: 'file', chapter: 'cli', path: 'cli/format.mjs', question: 'How is a total shown?',
    options: [{ id: 'plain', label: 'Plain', consequence: 'just the number' }, { id: 'fancy', label: 'Fancy', consequence: 'with a label' }],
    recommended: 'plain', why: 'The smallest thing that shows it.', dependsOn: ['cli', 'core/tally.mjs'],
  });
  const mainStep = steps[main + 1];
  assert.ok(mainStep);
  mainStep['dependsOn'] = ['cli', 'cli/format.mjs'];
  const cli = steps.findIndex((s) => s['path'] === 'cli');
  steps.splice(cli, 0, {
    kind: 'shape', chapter: 'notes', path: 'notes', question: 'Where do notes go?',
    options: [{ id: 'one', label: 'One file', consequence: 'simple' }, { id: 'many', label: 'Many files', consequence: 'roomy' }],
    recommended: 'one', why: 'There are few of them.', dependsOn: [],
  }, {
    kind: 'file', chapter: 'notes', path: 'notes/about.mjs', question: 'What does it say?',
    options: [{ id: 'short', label: 'Briefly', consequence: 'one line' }, { id: 'long', label: 'At length', consequence: 'a paragraph' }],
    recommended: 'short', why: 'A line is enough.', dependsOn: ['notes'],
  });
});

/** Every reply is a function of the prompt alone: the same prompt, the same reply, every time. */
const promptReadingModel: TutorCore['runLlm'] = (prompt) => {
  const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '));
  if (line === undefined) return Promise.reject(new Error('the prompt had no INPUT line'));
  const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
  let text: string;
  if (input['task'] === 'outline') {
    text = CHAIN_OUTLINE;
  } else if (input['task'] === 'replan') {
    const decision = input['decision'] as { chosen: string };
    const replacing = input['replacing'] as Array<Record<string, unknown>>;
    text = JSON.stringify({
      steps: replacing.map((r) => ({
        kind: r['kind'], chapter: r['chapter'], path: r['path'],
        question: `${String(r['question'])} (following ${decision.chosen})`,
        options: r['options'], recommended: r['chosen'], why: r['why'], dependsOn: r['dependsOn'],
      })),
    });
  } else if (input['task'] === 'code') {
    const node = input['node'] as { path: string; question: string; chosen: { label: string } };
    // The whole input, hashed: a step that was shown something else writes something else.
    const shown = createHash('sha256').update(JSON.stringify({ ...input, dependencies: undefined })).digest('hex').slice(0, 12);
    const tag = `// ${node.chosen.label}: ${node.question} [${shown}]\n`;
    const code: Record<string, string> = {
      'core/tally.mjs': `${tag}export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n`,
      'cli/format.mjs': `${tag}import { total } from '../core/tally.mjs';\n\nexport function show(xs) {\n  return String(total(xs));\n}\n`,
      'cli/main.mjs': `${tag}import { show } from './format.mjs';\n\nconsole.log(show([1, 2, 3]));\n`,
      'notes/about.mjs': `${tag}export const about = 'notes';\n`,
    };
    text = JSON.stringify({ content: code[node.path] ?? 'export {};\n' });
  } else {
    return Promise.reject(new Error(`the fake model has no answer for ${String(input['task'])}`));
  }
  return Promise.resolve({ text, inputTokens: 1, outputTokens: 1, usd: 0, metered: true });
};

/** The real engine, from an empty cache every time it is called, answered by `run`. */
const derivationWith = (run: TutorCore['runLlm'] | undefined): Derivation => async (request) => {
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error(SPEND_GUARD)),
    availability: () => Promise.resolve({ ok: true, detail: 'a stubbed provider probe' }),
  };
  const outcome = await derivePlan(request, {
    ledger, globalStorageRoot: tempDir('t19-storage-'), target: path.join(os.tmpdir(), 't19-no-such-target'), dialCore,
    settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run },
    now: () => new Date('2026-11-08T08:00:00.000Z'),
  });
  return outcome as unknown as Derived;
};

const realDerivation: Derivation = derivationWith(promptReadingModel);

/** Both answers are off the recommendation, so BOTH runs really replan and the determinism check covers it. */
const ON_THE_TALLY: Scenario = {
  idea: FIXTURE_IDEA, decision: 'core/tally.mjs', answers: ['object', 'array'], alsoAnswered: { 'notes/about.mjs': 'long' },
};

function judged(verdict: Verdict): Extract<Verdict, { kind: 'judged' }> {
  assert.equal(verdict.kind, 'judged', `expected a judgement, got: ${JSON.stringify(verdict)}`);
  return verdict;
}

function step(id: string, dependsOn: string[] = []): StepLike {
  return { id, target: { file: id }, dependsOn, decision: { chosen: null } };
}

function planOf(...steps: StepLike[]): PlanLike {
  return { steps };
}

suite('AC-A1 on the real engine (T-19)', function () {
  this.timeout(60_000);

  test('AC1-AC3: same answers, the same plan; one answer changed, its downstream changes and nothing else does', async () => {
    const verdict = judged(await judgeResponsiveness(realDerivation, ON_THE_TALLY));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
    assert.equal(verdict.independent.status, 'pass', verdict.independent.why);
    assert.deepEqual(verdict.partition, {
      downstream: ['cli/format.mjs', 'cli/main.mjs'],
      independent: ['core', 'notes', 'notes/about.mjs', 'cli'],
    }, 'the plan\'s own edges decide what may change: the fixture knows what they should be');
  });

  test('when one answer is the recommendation it is still recorded, and the comparison still holds', async () => {
    const verdict = judged(await judgeResponsiveness(realDerivation, { ...ON_THE_TALLY, answers: ['pure', 'object'] }));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
    assert.equal(verdict.independent.status, 'pass', verdict.independent.why);
  });

  test('nothing here can reach a model: with no fake, the poisoned runner is what answers, and it refuses', async () => {
    const out = await derivationWith(undefined)({ idea: FIXTURE_IDEA });
    assert.equal(out.ok, false, 'a derivation with no fake and no poison would have gone to a real model');
    assert.match((out as { reason: string }).reason, new RegExp(SPEND_GUARD));
  });

  test('AC7: the same for a decision that is a shape step, whose whole directory is downstream', async () => {
    const verdict = judged(await judgeResponsiveness(realDerivation, { idea: FIXTURE_IDEA, decision: 'core', answers: ['b', 'c'] }));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
    assert.equal(verdict.independent.status, 'pass', verdict.independent.why);
    assert.deepEqual(new Set(verdict.partition?.downstream), new Set(['core/tally.mjs', 'cli/format.mjs', 'cli/main.mjs']));
    assert.deepEqual(new Set(verdict.partition?.independent), new Set(['notes', 'notes/about.mjs', 'cli']));
  });
});

suite('the harness can fail: three mutant derivations (T-19 AC6)', function () {
  this.timeout(60_000);

  const tagOf = (answers: Readonly<Record<string, string>> | undefined): string =>
    createHash('sha256').update(JSON.stringify(answers ?? {})).digest('hex').slice(0, 8);

  /** Deterministic in its input, and rewrites everything whichever decision changed: noise that looks like listening. */
  const reshufflesEverything: Derivation = async (request) => {
    const out = await realDerivation(request);
    if (!out.ok) return out;
    const tag = tagOf(request.answers);
    return {
      ok: true,
      plan: { ...out.plan, steps: out.plan.steps.map((s) => ({ ...s, reshuffled: tag })) },
      files: out.files.map((f) => ({ ...f, content: `${f.content}// ${tag}\n` })),
    };
  };

  const ignoresTheAnswers: Derivation = (request) => realDerivation({ idea: request.idea });

  /** Changes nothing about any step, only the order the walk would present two the decision has nothing to do with. */
  const reordersTheIndependentSteps: Derivation = async (request) => {
    const out = await realDerivation(request);
    if (!out.ok) return out;
    if (!Object.values(request.answers ?? {}).includes('array')) return out;
    const steps = out.plan.steps.map((s) => ({ ...s }));
    const notes = steps.find((s) => s.target.file === 'notes/about.mjs') as StepLike;
    const cli = steps.find((s) => s.target.file === 'cli') as StepLike;
    [notes['ordinal'], cli['ordinal']] = [cli['ordinal'], notes['ordinal']];
    return { ...out, plan: { ...out.plan, steps } };
  };

  let calls = 0;
  const notDeterministic: Derivation = async (request) => {
    const out = await realDerivation(request);
    if (!out.ok) return out;
    calls += 1;
    const [first, ...rest] = out.plan.steps;
    assert.ok(first);
    return { ...out, plan: { ...out.plan, steps: [{ ...first, drawnOn: calls }, ...rest] } };
  };

  test('reshuffling everything on any input fails the independent clause, naming a step, and only that', async () => {
    const verdict = judged(await judgeResponsiveness(reshufflesEverything, ON_THE_TALLY));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
    assert.equal(verdict.independent.status, 'fail', 'a derivation that rewrites everything passed the independent clause');
    assert.match(verdict.independent.why, /notes|cli\b|core\b/, 'the failure should name a step');
    assert.equal(passed(verdict), false);
  });

  test('moving independent steps among themselves fails the independent clause, though no step changed', async () => {
    const verdict = judged(await judgeResponsiveness(reordersTheIndependentSteps, ON_THE_TALLY));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
    assert.equal(verdict.independent.status, 'fail', 'a derivation that reorders what the decision has nothing to do with passed');
    assert.match(verdict.independent.why, /different order/);
  });

  test('ignoring the answers fails the downstream clause, and only that: a run satisfying only the precondition fails', async () => {
    const verdict = judged(await judgeResponsiveness(ignoresTheAnswers, ON_THE_TALLY));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.independent.status, 'pass', verdict.independent.why);
    assert.equal(verdict.downstream.status, 'fail', 'a derivation that ignores the answers passed the downstream clause');
    assert.equal(passed(verdict), false);
  });

  test('a derivation that is not deterministic fails the precondition, and the two clauses are not evaluated', async () => {
    const verdict = judged(await judgeResponsiveness(notDeterministic, ON_THE_TALLY));
    assert.equal(verdict.precondition.status, 'fail', 'a derivation that changes between runs passed the precondition');
    assert.equal(verdict.downstream.status, 'not-evaluated');
    assert.equal(verdict.independent.status, 'not-evaluated');
    assert.equal(passed(verdict), false);
  });
});

suite('what counts as a step having responded (T-19)', () => {
  test('a step whose only change is the id of something it depends on was not re-derived', async () => {
    // What a one-hop re-derivation leaves behind: `direct` was re-derived and got a new id, and
    // `after` depends on it, so `after`'s record differs without `after` having been touched.
    const derive: Derivation = (request) => {
      const answer = request.answers?.['d'] ?? null;
      const direct = `direct-${String(answer)}`;
      const plan = planOf(
        { ...step('d'), decision: { chosen: answer } },
        { ...step(direct, ['d']), target: { file: 'direct' }, decision: { chosen: answer } },
        { ...step('after', [direct]) },
        step('elsewhere'),
      );
      return Promise.resolve({ ok: true, plan, files: [] });
    };
    const verdict = judged(await judgeResponsiveness(derive, { idea: 'x', decision: 'd', answers: ['a', 'b'] }));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.independent.status, 'pass', verdict.independent.why);
    assert.equal(verdict.downstream.status, 'fail', 'a step nobody re-derived passed for one that was');
    assert.match(verdict.downstream.why, /^after is downstream of d and did not change/);
  });
});

suite('"cannot judge" is its own outcome, and is never a pass (T-19 AC5)', function () {
  this.timeout(60_000);

  function cannotJudge(verdict: Verdict, reason: RegExp): void {
    assert.equal(verdict.kind, 'cannot-judge', `expected "cannot judge", got: ${JSON.stringify(verdict)}`);
    assert.match((verdict as { why: string }).why, reason);
    assert.equal(passed(verdict), false);
  }

  /** A derivation that hands back the given plan whatever it is asked. */
  const always = (plan: PlanLike): Derivation => () => Promise.resolve({ ok: true, plan, files: [] });

  test('a decision with nothing downstream', async () => {
    cannotJudge(await judgeResponsiveness(realDerivation, { idea: FIXTURE_IDEA, decision: 'notes/about.mjs', answers: ['short', 'long'] }), /nothing .*downstream/i);
  });

  test('a decision with nothing independent of it', async () => {
    const plan = planOf(step('d'), step('after', ['d']));
    cannotJudge(await judgeResponsiveness(always(plan), { idea: 'x', decision: 'd', answers: ['a', 'b'] }), /nothing .*independent/i);
  });

  test('a derivation that refuses', async () => {
    const refuses: Derivation = () => Promise.resolve({ ok: false, reason: 'the model would not answer' });
    cannotJudge(await judgeResponsiveness(refuses, ON_THE_TALLY), /the model would not answer/);
  });

  test('a decision that is not in the plan', async () => {
    cannotJudge(await judgeResponsiveness(always(planOf(step('a'))), { idea: 'x', decision: 'no-such-step', answers: ['a', 'b'] }), /no-such-step/);
  });

  test('two runs that would answer the decision the same way are not a comparison', async () => {
    cannotJudge(await judgeResponsiveness(realDerivation, { ...ON_THE_TALLY, answers: ['pure', 'pure'] }), /differ/i);
  });

  test('another answer on a step downstream of the decision is not "differing at exactly one decision"', async () => {
    cannotJudge(await judgeResponsiveness(realDerivation, { ...ON_THE_TALLY, alsoAnswered: { 'cli/main.mjs': 'steps' } }), /downstream/i);
  });

  test('an answer on an ancestor of the decision is the scenario\'s mistake, and says so', async () => {
    cannotJudge(await judgeResponsiveness(realDerivation, { ...ON_THE_TALLY, alsoAnswered: { core: 'b' } }), /ancestor/i);
  });
});

suite('every branch of the judge has a failure of its own (T-19 code review F6)', () => {
  const D = (chosen: string | null): StepLike => ({ ...step('d'), decision: { chosen } });
  const SCENARIO: Scenario = { idea: 'x', decision: 'd', answers: ['a', 'b'] };
  type Shape = { steps: StepLike[]; files?: DerivedFileLike[]; extra?: Record<string, unknown> };

  /** A hand-built derivation: `d` takes the answer, `down` depends on it and follows it, `ind` is left alone. */
  function fromAnswer(make: (answer: string | null, call: number) => Shape): Derivation {
    let calls = 0;
    return (request) => {
      calls += 1;
      const { steps, files = [], extra = {} } = make(request.answers?.['d'] ?? null, calls);
      return Promise.resolve({ ok: true, plan: { ...extra, steps }, files });
    };
  }
  const followed = (answer: string | null): StepLike => ({ ...step('down', ['d']), decision: { chosen: answer } });
  const plain = (answer: string | null): StepLike[] => [D(answer), followed(answer), step('ind')];

  async function clauses(derive: Derivation): Promise<Extract<Verdict, { kind: 'judged' }>> {
    return judged(await judgeResponsiveness(derive, SCENARIO));
  }

  test('precondition: a file that differs between two runs of the same input', async () => {
    const verdict = await clauses(fromAnswer((a, call) => ({ steps: plain(a), files: [{ path: 'ind', content: String(call) }] })));
    assert.equal(verdict.precondition.status, 'fail');
    assert.match(verdict.precondition.why, /the file ind differs/);
  });

  test('precondition: a plan-level field that differs between two runs of the same input', async () => {
    const verdict = await clauses(fromAnswer((a, call) => ({ steps: plain(a), extra: { title: String(call) } })));
    assert.equal(verdict.precondition.status, 'fail');
    assert.match(verdict.precondition.why, /the plan differs/);
  });

  test('precondition: `generatedAt` and `cost` describe the run, and may differ', async () => {
    const verdict = await clauses(fromAnswer((a, call) => ({ steps: plain(a), extra: { generatedAt: String(call), cost: call } })));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
  });

  test('independent: only its file changed', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: plain(a), files: [{ path: 'ind', content: String(a) }] })));
    assert.equal(verdict.independent.status, 'fail');
    assert.match(verdict.independent.why, /^ind is independent of d and its file changed/);
  });

  test('independent: only its record changed', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: [D(a), followed(a), { ...step('ind'), why: String(a) }] })));
    assert.equal(verdict.independent.status, 'fail');
    assert.match(verdict.independent.why, /^ind is independent of d and its step changed/);
  });

  test('independent: gone from the second run', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: a === 'b' ? [D(a), followed(a)] : plain(a) })));
    assert.equal(verdict.independent.status, 'fail');
    assert.match(verdict.independent.why, /is gone from the second run/);
  });

  test('independent: a step appears in the second run that is not downstream of the decision', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: a === 'b' ? [...plain(a), step('extra')] : plain(a) })));
    assert.equal(verdict.independent.status, 'fail');
    assert.match(verdict.independent.why, /^extra appeared in the second run/);
  });

  test('independent: a file no step owns, and a chapter the decision does not reach', async () => {
    const stray = await clauses(fromAnswer((a) => ({ steps: plain(a), files: [{ path: 'stray', content: String(a) }] })));
    assert.equal(stray.independent.status, 'fail');
    assert.match(stray.independent.why, /the file stray, which the decision does not reach, changed/);
    const inChapter = (s: StepLike, chapter: string): StepLike => ({ ...s, chapter });
    const chapter = await clauses(fromAnswer((a) => ({
      steps: [inChapter(D(a), 'near'), inChapter(followed(a), 'near'), inChapter(step('ind'), 'far')],
      extra: { chapters: [{ key: 'near', title: 'n' }, { key: 'far', title: String(a) }] },
    })));
    assert.equal(chapter.independent.status, 'fail');
    assert.match(chapter.independent.why, /the chapter far, which the decision does not reach, changed/);
  });

  test('downstream: a step whose only change is its file has responded', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: [D(a), step('down', ['d']), step('ind')], files: [{ path: 'down', content: String(a) }] })));
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
  });

  test('downstream: a step that is gone from the second run has responded', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: a === 'b' ? [D(a), step('ind')] : plain(a) })));
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
  });

  test('the decision itself: it must take the answer it was given, in each run', async () => {
    const swapped = await clauses(fromAnswer((a) => ({ steps: [D(a === 'a' ? 'b' : 'a'), followed(a), step('ind')] })));
    assert.equal(swapped.downstream.status, 'fail');
    assert.match(swapped.downstream.why, /did not take the answer/);
    const unrecorded = await clauses(fromAnswer((a) => ({ steps: [D(a === 'a' ? null : a), followed(a), step('ind')] })));
    assert.equal(unrecorded.downstream.status, 'fail');
    assert.match(unrecorded.downstream.why, /chose null when asked for a/);
  });

  test('the decision itself: gone from the second run', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: a === 'b' ? [followed(a), step('ind')] : plain(a) })));
    assert.equal(verdict.downstream.status, 'fail');
    assert.match(verdict.downstream.why, /the decision itself, is gone/);
  });

  test('the decision itself: its own code has to change with the answer', async () => {
    const verdict = await clauses(fromAnswer((a) => ({ steps: plain(a), files: [{ path: 'd', content: 'the same whatever was asked' }] })));
    assert.equal(verdict.downstream.status, 'fail');
    assert.match(verdict.downstream.why, /its own code did not change/);
  });
});

suite('the walk over dependsOn stands on its own (T-19 AC4)', () => {
  test('a transitive chain: everything that reaches the decision, and not the decision itself', () => {
    const plan = planOf(step('root'), step('d', ['root']), step('one', ['d']), step('two', ['one']), step('elsewhere', ['root']));
    assert.deepEqual([...stepsReaching(plan, 'd')].sort(), ['one', 'two']);
  });

  test('the plan does not have to be in order: it is what is being judged', () => {
    const plan = planOf(step('after', ['mid']), step('mid', ['d']), step('d'), step('elsewhere'));
    assert.deepEqual([...stepsReaching(plan, 'd')].sort(), ['after', 'mid']);
  });

  test('a diamond is counted once and reached by either side', () => {
    const plan = planOf(step('d'), step('left', ['d']), step('right', ['d']), step('join', ['left', 'right']));
    assert.deepEqual([...stepsReaching(plan, 'd')].sort(), ['join', 'left', 'right']);
  });

  test('a cycle terminates', () => {
    const plan = planOf(step('d'), step('a', ['d', 'b']), step('b', ['a']));
    assert.deepEqual([...stepsReaching(plan, 'd')].sort(), ['a', 'b']);
  });

  test('a dependency on an id that is not in the plan is not followed, and does not throw', () => {
    const plan = planOf(step('d'), step('a', ['ghost']), step('b', ['ghost', 'd']));
    assert.deepEqual([...stepsReaching(plan, 'd')], ['b']);
  });

  test('the harness computes it itself: it imports nothing at all, so a wrong engine cannot agree with a wrong test', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'test', 'support', 'responsiveness.ts'), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s|\brequire\(/m);
  });
});
