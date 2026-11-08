// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AC-A1 made runnable (T-19): the learner's answers demonstrably change the plan.
 *
 * Same idea, answers differing at exactly one decision D: the steps downstream of D differ, and
 * the steps independent of D do not. Determinism first, or neither clause can be evaluated.
 *
 * The real `derivePlan`, the real `AskLedger`, repo-tour's real `extract`. The model is a fake
 * whose answers are a pure function of the prompt's `INPUT (JSON):` line, so a changed answer
 * really changes what comes back; `core.runLlm` is poisoned, so a test that forgot the fake fails
 * instead of dialling out. No test spends a token. Every derivation starts from an empty cache,
 * or the engine's cache would answer the second run and hide a derivation that is not deterministic.
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
  type Derivation, type Derived, type PlanLike, type Scenario, type StepLike, type Verdict,
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
    const tag = `// ${node.chosen.label}: ${node.question}\n`;
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

/** The real engine, from an empty cache every time it is called. */
const realDerivation: Derivation = async (request) => {
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error(SPEND_GUARD)),
    availability: () => Promise.resolve({ ok: true, detail: 'a stubbed provider probe' }),
  };
  const outcome = await derivePlan(request, {
    ledger, globalStorageRoot: tempDir('t19-storage-'), target: path.join(os.tmpdir(), 't19-no-such-target'), dialCore,
    settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run: promptReadingModel },
    now: () => new Date('2026-11-08T08:00:00.000Z'),
  });
  return outcome as unknown as Derived;
};

const ON_THE_TALLY: Scenario = {
  idea: FIXTURE_IDEA, decision: 'core/tally.mjs', answers: ['pure', 'object'], alsoAnswered: { 'notes/about.mjs': 'long' },
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
  });

  test('AC7: the same for a decision that is a shape step, whose whole directory is downstream', async () => {
    const verdict = judged(await judgeResponsiveness(realDerivation, { idea: FIXTURE_IDEA, decision: 'core', answers: ['a', 'b'] }));
    assert.equal(verdict.precondition.status, 'pass', verdict.precondition.why);
    assert.equal(verdict.downstream.status, 'pass', verdict.downstream.why);
    assert.equal(verdict.independent.status, 'pass', verdict.independent.why);
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

  /** Changes nothing about any step, only the order of two the decision has nothing to do with. */
  const reordersTheIndependentSteps: Derivation = async (request) => {
    const out = await realDerivation(request);
    if (!out.ok) return out;
    if (!Object.values(request.answers ?? {}).includes('object')) return out;
    const steps = [...out.plan.steps];
    const notes = steps.findIndex((s) => s.target.file === 'notes/about.mjs');
    const cli = steps.findIndex((s) => s.target.file === 'cli');
    [steps[notes], steps[cli]] = [steps[cli] as StepLike, steps[notes] as StepLike];
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
});

suite('the walk over dependsOn stands on its own (T-19 AC4)', () => {
  test('a transitive chain: everything that reaches the decision, and not the decision itself', () => {
    const plan = planOf(step('root'), step('d', ['root']), step('one', ['d']), step('two', ['one']), step('elsewhere', ['root']));
    assert.deepEqual([...stepsReaching(plan, 'd')].sort(), ['one', 'two']);
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

  test('the harness computes it itself: it does not import the engine\'s graph', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'test', 'support', 'responsiveness.ts'), 'utf8');
    assert.doesNotMatch(source, /derive\/graph|from '.*src\/derive/, 'a wrong engine could then agree with a wrong test');
  });
});
