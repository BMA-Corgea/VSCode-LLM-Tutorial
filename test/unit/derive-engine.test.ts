// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/derive/engine.ts` — an idea, through the real `AskLedger`, the real cache and repo-tour's
 * REAL `extract`, becomes a schema-valid plan and its reference tree (AC1, AC2's parse and import
 * checks, AC4, AC9, AC10).
 *
 * The model is a scripted fake that answers by reading the prompt's one `INPUT (JSON):` line —
 * the line exists so that a fake can do exactly this — and `core.runLlm` is poisoned, so a test
 * that forgot to inject the fake fails instead of dialling out. No test spends a token.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { derivePlan, replanPlan, type DerivationState, type DeriveDeps } from '../../src/derive/engine.js';
import type { DerivedPlan } from '../../src/derive/assemble.js';
import { stepIdFor } from '../../src/derive/assemble.js';
import { AskLedger } from '../../src/tutor/ask.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import { FIXTURE_IDEA, fixtureOutlineText } from './derive-fixtures.js';
import { BUILD_PLAN_SCHEMA, validateBuildPlan } from './plan-schema.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());
const SPEND_GUARD = 'a test in derive-engine.test.ts reached the real model';

let realCore: TutorCore;
let dialCore: DialCore;

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = tutorCoreFor(loaded.loaded);
  dialCore = dialCoreFor(loaded.loaded);
});

const TALLY = 'export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
const MAIN = "import { total } from '../core/tally.mjs';\n\nconsole.log(total([1, 2, 3]));\n";

const made: string[] = [];
const ledgers: AskLedger[] = [];

teardown(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

interface Asked { task: string; input: Record<string, unknown> }

const OBJECT_TALLY = 'export class Tally {\n  constructor() {\n    this.sum = 0;\n  }\n\n  add(n) {\n    this.sum += n;\n    return this;\n  }\n}\n';
const MAIN_OBJECT = "import { Tally } from '../core/tally.mjs';\n\nconsole.log(new Tally().add(1).add(2).add(3).sum);\n";

/**
 * A fake model: reads the INPUT line and answers the task it names, and its answers DEPEND ON THE
 * PROMPT — so a changed answer really changes what comes back, which is the least AC5 needs.
 *
 *   - outline: the fixture outline.
 *   - code: `code[path]` if the test gave one; otherwise the tally follows its chosen option (a
 *     pure function, or an object that remembers) and the entry follows its question.
 *   - replan: every step it is told it is replacing, again, with the question saying which option
 *     it now follows. A replanned step therefore has a NEW decision, and so a new id.
 */
function fakeModel(code: Record<string, string> = {}, replan: (input: Record<string, unknown>) => unknown = followTheAnswer) {
  const asked: Asked[] = [];
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '));
    if (line === undefined) return Promise.reject(new Error('the prompt had no INPUT line'));
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    asked.push({ task: String(input['task']), input });
    let text: string;
    if (input['task'] === 'outline') {
      text = fixtureOutlineText();
    } else if (input['task'] === 'code') {
      const node = input['node'] as { path: string; question: string; chosen: { label: string } };
      const given = code[node.path];
      if (given !== undefined) text = JSON.stringify({ content: given });
      else if (node.path === 'core/tally.mjs') text = JSON.stringify({ content: /object/i.test(node.chosen.label) ? OBJECT_TALLY : TALLY });
      else if (node.path === 'cli/main.mjs') text = JSON.stringify({ content: node.question.includes('(following object)') ? MAIN_OBJECT : MAIN });
      else text = JSON.stringify({ content: 'export {};\n' });
    } else if (input['task'] === 'replan') {
      text = JSON.stringify(replan(input));
    } else {
      return Promise.reject(new Error(`the fake model has no answer for ${String(input['task'])}`));
    }
    return Promise.resolve({ text, inputTokens: 10, outputTokens: 5, usd: 0.001, metered: true });
  };
  return { asked, run };
}

/** The default replan: each replaced step again, following the learner's choice. */
function followTheAnswer(input: Record<string, unknown>): unknown {
  const decision = input['decision'] as { chosen: string };
  const replacing = input['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string; dependsOn: string[] }>;
  return {
    steps: replacing.map((r) => ({
      kind: r.kind, chapter: r.chapter, path: r.path,
      question: `${r.question} (following ${decision.chosen})`,
      options: r.options, recommended: r.chosen, why: r.why, dependsOn: r.dependsOn,
    })),
  };
}

const POISONED: TutorCore['runLlm'] = () => Promise.reject(new Error('the second derivation called the model — it should have been served from the cache'));

function deps(run: TutorCore['runLlm'], gs: string, target: string): DeriveDeps {
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error(SPEND_GUARD)),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
  };
  return {
    ledger, globalStorageRoot: gs, target, dialCore,
    settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run },
    now: () => new Date('2026-11-05T08:00:00.000Z'),
  };
}

/** The plan's content: everything except the two fields that describe the RUN. */
function contentOf(plan: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([k]) => k !== 'generatedAt' && k !== 'cost')));
}

suite('derivePlan — an idea becomes a plan and its tree, through the one door (AC1, AC2, AC4, AC9, AC10)', () => {
  test('the fixture idea yields a plan valid against repo-tour\'s REAL schema, and a tree holding its files', async () => {
    const gs = tempDir('derive-engine-gs-');
    const target = tempDir('derive-engine-target-');
    const model = fakeModel();
    const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(model.run, gs, target));
    if (!out.ok) assert.fail(out.reason);
    assert.deepEqual(validateBuildPlan(BUILD_PLAN_SCHEMA, out.plan), []);
    assert.equal(out.plan.mode, 'idea');
    assert.equal(fs.readFileSync(path.join(out.referenceRoot, 'core/tally.mjs'), 'utf8'), TALLY);
    assert.equal(fs.readFileSync(path.join(out.referenceRoot, 'cli/main.mjs'), 'utf8'), MAIN);
    assert.deepEqual(model.asked.map((a) => a.task), ['outline', 'code', 'code']);
    assert.deepEqual(
      { calls: out.plan.cost.calls, interpretedStops: out.plan.cost.interpretedStops, cachedStops: out.plan.cost.cachedStops, metered: out.plan.cost.metered },
      { calls: 3, interpretedStops: 3, cachedStops: 0, metered: true },
    );
    const tally = out.plan.steps.find((s) => s.target.file === 'core/tally.mjs');
    assert.deepEqual(tally?.scaffold.loadBearing, [{ startLine: 1, endLine: 3 }], 'the REAL extract found the exported function');
  });

  test('AC4: the same idea derived again makes ZERO calls and gives the same plan and the same tree', async () => {
    const gs = tempDir('derive-engine-gs-');
    const target = tempDir('derive-engine-target-');
    const first = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel().run, gs, target));
    if (!first.ok) assert.fail(first.reason);
    const second = await derivePlan({ idea: FIXTURE_IDEA }, deps(POISONED, gs, target));
    if (!second.ok) assert.fail(second.reason);
    assert.equal(contentOf(second.plan), contentOf(first.plan), 'byte-identical apart from generatedAt and cost');
    assert.equal(second.referenceRoot, first.referenceRoot);
    assert.deepEqual(second.files, first.files);
    assert.deepEqual({ calls: second.plan.cost.calls, cachedStops: second.plan.cost.cachedStops }, { calls: 0, cachedStops: 3 });
  });

  test('each code prompt holds exactly its chapter decision and the files it declares — nothing else', async () => {
    const model = fakeModel();
    const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(model.run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    if (!out.ok) assert.fail(out.reason);
    const codeAsks = model.asked.filter((a) => a.task === 'code');
    const tally = codeAsks.find((a) => (a.input['node'] as Record<string, unknown>)['path'] === 'core/tally.mjs')!;
    const main = codeAsks.find((a) => (a.input['node'] as Record<string, unknown>)['path'] === 'cli/main.mjs')!;
    assert.equal((tally.input['chapter'] as Record<string, unknown>)['path'], 'core');
    assert.deepEqual(tally.input['dependencies'], [], 'the tally depends on nothing but its chapter');
    assert.equal((main.input['chapter'] as Record<string, unknown>)['path'], 'cli');
    const deps0 = main.input['dependencies'] as Array<Record<string, unknown>>;
    assert.deepEqual(deps0.map((d) => d['path']), ['core/tally.mjs']);
    assert.equal(deps0[0]?.['content'], TALLY, 'the file it builds on, in full');
    assert.equal((main.input['node'] as Record<string, unknown>)['isEntry'], true);
  });

  test('the learner\'s target folder is untouched by a derivation (AC9)', async () => {
    const target = tempDir('derive-engine-target-');
    fs.writeFileSync(path.join(target, 'mine.txt'), 'mine');
    const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel().run, tempDir('derive-engine-gs-'), target));
    assert.ok(out.ok);
    assert.deepEqual(fs.readdirSync(target), ['mine.txt']);
  });

  for (const [name, tally, pattern] of [
    ['a file that does not parse', 'export function total(xs {\n', /does not parse/],
    ['an import of a local file it does not depend on', "import { x } from './ghost.mjs';\nexport function total() { return x; }\n", /not one of its dependencies' files|a file it does not depend on/],
    ['an import of a package that would need installing', "import _ from 'lodash';\nexport function total(xs) { return _.sum(xs); }\n", /would need installing/],
  ] as Array<[string, string, RegExp]>) {
    test(`a derived file with ${name} fails the derivation with a sentence, and no tree is written`, async () => {
      const gs = tempDir('derive-engine-gs-');
      const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel({ 'core/tally.mjs': tally, 'cli/main.mjs': MAIN }).run, gs, tempDir('derive-engine-target-')));
      assert.ok(!out.ok, 'expected the derivation to fail');
      assert.match(out.reason, pattern);
      assert.equal(fs.existsSync(path.join(gs, 'derived')), false);
    });
  }

  test('a node: import is one of Node\'s own modules, and is allowed', async () => {
    const tally = "import { strict as assert } from 'node:assert';\nexport function total(xs) {\n  assert.ok(Array.isArray(xs));\n  return xs.reduce((a, b) => a + b, 0);\n}\n";
    const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel({ 'core/tally.mjs': tally, 'cli/main.mjs': MAIN }).run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    if (!out.ok) assert.fail(out.reason);
  });

  test('an answer that is not one of the step\'s options is refused, never guessed at', async () => {
    const gs = tempDir('derive-engine-gs-');
    const target = tempDir('derive-engine-target-');
    const first = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel().run, gs, target));
    if (!first.ok) assert.fail(first.reason);
    const tallyId = idOf(first.state, 'core/tally.mjs');
    const out = await derivePlan({ idea: FIXTURE_IDEA, answers: { [tallyId]: 'not-an-option' } }, deps(POISONED, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /is not one of the options/);
  });
});

/** The step id of the node at `p` — the key answers and prefixes are given by. */
function idOf(state: DerivationState, p: string): string {
  const node = state.nodes.find((n) => n.path === p);
  assert.ok(node, `the plan should have a step at ${p}`);
  return stepIdFor(node);
}

/** A step as the walk sees it, minus its position — what "kept exactly" compares. */
function stepContent(plan: DerivedPlan, file: string): string {
  const step = plan.steps.find((s) => s.target.file === file);
  assert.ok(step, `the plan should have a step for ${file}`);
  return JSON.stringify(Object.fromEntries(Object.entries(step).filter(([k]) => k !== 'ordinal')));
}

suite('replanPlan — a changed answer re-derives what it reaches, and nothing else (AC5)', () => {
  async function base() {
    const gs = tempDir('derive-engine-gs-');
    const target = tempDir('derive-engine-target-');
    const model = fakeModel();
    const first = await derivePlan({ idea: FIXTURE_IDEA }, deps(model.run, gs, target));
    if (!first.ok) assert.fail(first.reason);
    return { gs, target, model, first };
  }

  async function replanned() {
    const b = await base();
    const tallyId = idOf(b.first.state, 'core/tally.mjs');
    const coreId = idOf(b.first.state, 'core');
    const second = await replanPlan(b.first.state, tallyId, 'object', [coreId], deps(b.model.run, b.gs, b.target));
    if (!second.ok) assert.fail(second.reason);
    return { ...b, tallyId, coreId, second };
  }

  test('the answer is recorded, the decision keeps its id, and its own code follows the answer', async () => {
    const { first, second, tallyId } = await replanned();
    const d = second.plan.steps.find((s) => s.id === tallyId);
    assert.ok(d, 'the decision keeps its id, so the walk keeps its place');
    assert.equal(d.decision.chosen, 'object');
    assert.equal(first.state.files['core/tally.mjs'], TALLY);
    assert.equal(second.state.files['core/tally.mjs'], OBJECT_TALLY);
  });

  test('every step the decision does not reach is kept exactly: id, decision, target, scaffold, dependsOn', async () => {
    const { first, second } = await replanned();
    for (const file of ['core', 'cli']) assert.equal(stepContent(second.plan, file), stepContent(first.plan, file), file);
  });

  test('the steps it reaches are re-derived: a new decision, a new id, and code that follows the answer', async () => {
    const { first, second, tallyId } = await replanned();
    const before = first.plan.steps.find((s) => s.target.file === 'cli/main.mjs')!;
    const after = second.plan.steps.find((s) => s.target.file === 'cli/main.mjs')!;
    assert.notEqual(after.id, before.id);
    assert.match(after.decision.question, /\(following object\)/);
    assert.ok(after.dependsOn.includes(tallyId), 'the honesty rule: it depends on the decision it was derived from');
    assert.equal(second.state.files['cli/main.mjs'], MAIN_OBJECT);
  });

  test('the state it was handed is untouched, and so is its tree: the substrate for plan versions', async () => {
    const b = await base();
    const frozen = JSON.stringify(b.first.state);
    const second = await replanPlan(b.first.state, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(b.model.run, b.gs, b.target));
    if (!second.ok) assert.fail(second.reason);
    assert.equal(JSON.stringify(b.first.state), frozen);
    assert.notEqual(second.referenceRoot, b.first.referenceRoot);
    assert.equal(fs.readFileSync(path.join(b.first.referenceRoot, 'core/tally.mjs'), 'utf8'), TALLY, 'the old tree still holds the old bytes');
  });

  test('folding replanPlan over the answers equals derivePlan over the same answers, byte for byte', async () => {
    const { gs, target, model, second, tallyId } = await replanned();
    const once = await derivePlan({ idea: FIXTURE_IDEA, answers: { [tallyId]: 'object' } }, deps(model.run, gs, target));
    if (!once.ok) assert.fail(once.reason);
    assert.equal(contentOf(once.plan), contentOf(second.plan));
    assert.equal(once.referenceRoot, second.referenceRoot);
    assert.deepEqual(once.files, second.files);
  });

  test('the same idea and answers derived again make ZERO calls', async () => {
    const { gs, target, tallyId } = await replanned();
    const again = await derivePlan({ idea: FIXTURE_IDEA, answers: { [tallyId]: 'object' } }, deps(POISONED, gs, target));
    if (!again.ok) assert.fail(again.reason);
    assert.equal(again.plan.cost.calls, 0);
  });

  test('an answer equal to the recommendation changes nothing but chosen', async () => {
    const b = await base();
    const tallyId = idOf(b.first.state, 'core/tally.mjs');
    const same = await replanPlan(b.first.state, tallyId, 'pure', [], deps(POISONED, b.gs, b.target));
    if (!same.ok) assert.fail(same.reason);
    assert.deepEqual(same.plan.steps.map((s) => s.id), b.first.plan.steps.map((s) => s.id));
    assert.equal(same.plan.steps.find((s) => s.id === tallyId)?.decision.chosen, 'pure');
    assert.equal(same.referenceRoot, b.first.referenceRoot);
  });

  test('a replan that replaces the entry file without naming a new one is refused', async () => {
    const b = await base();
    const moved = fakeModel({}, (input) => {
      const out = followTheAnswer(input) as { steps: Array<Record<string, unknown>> };
      return { steps: out.steps.map((st) => ({ ...st, path: 'cli/start.mjs' })) };
    });
    const out = await replanPlan(b.first.state, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(moved.run, b.gs, b.target));
    assert.ok(!out.ok);
    assert.match(out.reason, /without naming a new one/);
  });

  test('a replanned step at the path of a step that is KEPT is refused', async () => {
    const b = await base();
    const clash = fakeModel({}, (input) => {
      const out = followTheAnswer(input) as { steps: Array<Record<string, unknown>> };
      return { steps: [{ kind: 'shape', chapter: 'cli', path: 'cli', question: 'again?', options: [{ id: 'a', label: 'A', consequence: 'x' }, { id: 'b', label: 'B', consequence: 'y' }], recommended: 'a', why: 'w', dependsOn: [] }, ...out.steps] };
    });
    const out = await replanPlan(b.first.state, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(clash.run, b.gs, b.target));
    assert.ok(!out.ok);
    assert.match(out.reason, /a step it was told to keep/);
  });
});
