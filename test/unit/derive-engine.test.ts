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
import { DERIVE_LIMITS } from '../../src/derive/types.js';
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
    const d = deps(model.run, gs, target);
    const out = await derivePlan({ idea: FIXTURE_IDEA }, d);
    if (!out.ok) assert.fail(out.reason);
    assert.equal(d.ledger.spend().replies, out.plan.cost.calls, 'AC6: the ledger counted every call the plan reports — no call went around it');
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

  for (const [name, broken, pattern] of [
    ['a TypeScript annotation in a .mjs file (it parses as JSON and fails as code)', 'export function total(xs: number[]) {\n  return 0;\n}\n', /does not parse/],
    ['an import of a package that would need installing', "import _ from 'lodash';\nexport function total(xs) { return _.sum(xs); }\n", /would need installing/],
  ] as Array<[string, string, RegExp]>) {
    test(`a code reply with ${name} is refused and NOT kept: the next press asks again and can succeed`, async () => {
      const gs = tempDir('derive-engine-gs-');
      const target = tempDir('derive-engine-target-');
      const first = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel({ 'core/tally.mjs': broken, 'cli/main.mjs': MAIN }).run, gs, target));
      assert.ok(!first.ok, 'the broken reply fails the derivation');
      assert.match(first.reason, pattern);
      const good = fakeModel();
      const again = await derivePlan({ idea: FIXTURE_IDEA }, deps(good.run, gs, target));
      if (!again.ok) assert.fail(`a good model was given no chance, because the bad reply was served again: ${again.reason}`);
      assert.deepEqual(good.asked.map((a) => a.task), ['code', 'code'], 'the outline was kept; the bad file was asked again');
      assert.deepEqual({ calls: again.plan.cost.calls, cachedStops: again.plan.cost.cachedStops }, { calls: 2, cachedStops: 1 });
    });
  }

  test('AC10: the plan\'s cost is the run\'s, honestly: summed, named, and a floor once any reply was unmetered', async () => {
    const model = fakeModel();
    let n = 0;
    const halfMetered: TutorCore['runLlm'] = async (prompt, choice, cwd, ms) => {
      const reply = await model.run(prompt, choice, cwd, ms);
      n += 1;
      return n === 2 ? { ...reply, metered: false } : reply;
    };
    const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(halfMetered, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    if (!out.ok) assert.fail(out.reason);
    const cost = out.plan.cost;
    assert.equal(cost.provider, 'claude');
    assert.equal(cost.model, 'claude-sonnet-5');
    assert.equal(cost.calls, 3);
    assert.equal(cost.inputTokens, 30, 'summed across the three replies');
    assert.equal(cost.outputTokens, 15);
    assert.equal(cost.metered, false, 'one unmetered reply makes the totals a floor, never a figure');
    assert.deepEqual(cost.failures, []);
  });

  test('a derivation that fails partway keeps what parsed: pressing again pays only for the question that failed', async () => {
    const gs = tempDir('derive-engine-gs-');
    const target = tempDir('derive-engine-target-');
    const good = fakeModel();
    let calls = 0;
    const breaksOnTheSecondFile: TutorCore['runLlm'] = async (prompt, choice, cwd, ms) => {
      calls += 1;
      const reply = await good.run(prompt, choice, cwd, ms);
      return calls === 3 ? { ...reply, text: 'not json at all' } : reply;
    };
    const first = await derivePlan({ idea: FIXTURE_IDEA }, deps(breaksOnTheSecondFile, gs, target));
    assert.ok(!first.ok, 'the broken reply fails the derivation');
    assert.match(first.reason, /not one JSON object/);
    assert.equal(fs.existsSync(path.join(gs, 'derived')), false, 'no tree for a derivation that did not finish');

    const counting = fakeModel();
    const again = await derivePlan({ idea: FIXTURE_IDEA }, deps(counting.run, gs, target));
    if (!again.ok) assert.fail(again.reason);
    assert.deepEqual(counting.asked.map((a) => a.task), ['code'], 'only the question that failed was asked again');
    assert.deepEqual({ calls: again.plan.cost.calls, cachedStops: again.plan.cost.cachedStops }, { calls: 1, cachedStops: 2 });
  });

  test('cancelled midway: the derivation stops before its next question, says so, and writes no tree', async () => {
    const gs = tempDir('derive-engine-gs-');
    const model = fakeModel();
    const d = deps(model.run, gs, tempDir('derive-engine-target-'));
    d.isCancelled = () => model.asked.length >= 2;
    const out = await derivePlan({ idea: FIXTURE_IDEA }, d);
    assert.ok(!out.ok);
    assert.match(out.reason, /cancelled/);
    assert.equal(model.asked.length, 2, 'nothing was sent after the cancel');
    assert.equal(fs.existsSync(path.join(gs, 'derived')), false);
  });

  test('a node: import is one of Node\'s own modules, and is allowed', async () => {
    const tally = "import { strict as assert } from 'node:assert';\nexport function total(xs) {\n  assert.ok(Array.isArray(xs));\n  return xs.reduce((a, b) => a + b, 0);\n}\n";
    const out = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel({ 'core/tally.mjs': tally, 'cli/main.mjs': MAIN }).run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    if (!out.ok) assert.fail(out.reason);
  });

  test('an answered derivation asks for the code LAST and once: it never pays for code it would throw away', async () => {
    const seed = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel().run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    if (!seed.ok) assert.fail(seed.reason);
    const model = fakeModel();
    const out = await derivePlan({ idea: FIXTURE_IDEA, answers: { [idOf(seed.state, 'core/tally.mjs')]: 'object' } }, deps(model.run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    if (!out.ok) assert.fail(out.reason);
    assert.deepEqual(model.asked.map((a) => a.task), ['outline', 'replan', 'code', 'code']);
    assert.equal(out.state.files['core/tally.mjs'], OBJECT_TALLY, 'the code follows the answer');
  });

  test('an answer for a step this plan does not have is refused, never silently dropped', async () => {
    const model = fakeModel();
    const out = await derivePlan({ idea: FIXTURE_IDEA, answers: { deadbeefdeadbeef: 'x' } }, deps(model.run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
    assert.ok(!out.ok, 'an answer that matches nothing must be said out loud');
    assert.match(out.reason, /matches no step/);
    assert.ok(!model.asked.some((a) => a.task === 'code'), 'no code was paid for around an answer that matched nothing');
  });

  for (const [name, idea, pattern] of [
    ['an empty idea', '   \n', /no idea/],
    ['an idea past its bound', 'x'.repeat(DERIVE_LIMITS.maxIdeaChars + 1), /more than the 4000/],
  ] as Array<[string, string, RegExp]>) {
    test(`${name} is refused before anything is asked`, async () => {
      const model = fakeModel();
      const out = await derivePlan({ idea }, deps(model.run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-')));
      assert.ok(!out.ok);
      assert.match(out.reason, pattern);
      assert.equal(model.asked.length, 0, 'nothing was paid for');
    });
  }

  test('a model setting left empty is refused before anything is asked, rather than silently buying the strongest model', async () => {
    const model = fakeModel();
    const d = deps(model.run, tempDir('derive-engine-gs-'), tempDir('derive-engine-target-'));
    d.settings = { ...d.settings, model: '' };
    const out = await derivePlan({ idea: FIXTURE_IDEA }, d);
    assert.ok(!out.ok);
    assert.match(out.reason, /names no model/);
    assert.equal(model.asked.length, 0);
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

  test('a walked step the decision reaches is still kept VERBATIM, decision and code: walked steps are never re-derived', async () => {
    const b = await base();
    const tallyId = idOf(b.first.state, 'core/tally.mjs');
    const mainId = idOf(b.first.state, 'cli/main.mjs');
    const walked = [idOf(b.first.state, 'core'), idOf(b.first.state, 'cli'), mainId];
    const second = await replanPlan(b.first.state, tallyId, 'object', walked, deps(b.model.run, b.gs, b.target));
    if (!second.ok) assert.fail(second.reason);
    assert.equal(stepContent(second.plan, 'cli/main.mjs'), stepContent(b.first.plan, 'cli/main.mjs'), 'the walked entry keeps its decision');
    assert.equal(second.state.files['cli/main.mjs'], MAIN, 'and its code');
    assert.equal(second.state.files['core/tally.mjs'], OBJECT_TALLY, 'while the decision itself still follows the answer');
    assert.equal(b.model.asked.filter((a) => a.task === 'replan').length, 0, 'nothing was left to re-plan, so nothing was asked');
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

  test('two answers, the second to a step the first one CREATED: one derivePlan call equals the walk of two replans', async () => {
    const { gs, target, model, second, tallyId } = await replanned();
    const newMainId = idOf(second.state, 'cli/main.mjs');
    const walked = second.plan.steps.filter((st) => st.ordinal < second.plan.steps.find((x) => x.id === newMainId)!.ordinal).map((st) => st.id);
    const third = await replanPlan(second.state, newMainId, 'steps', walked, deps(model.run, gs, target));
    if (!third.ok) assert.fail(third.reason);
    const once = await derivePlan({ idea: FIXTURE_IDEA, answers: { [tallyId]: 'object', [newMainId]: 'steps' } }, deps(model.run, gs, target));
    if (!once.ok) assert.fail(once.reason);
    assert.equal(contentOf(once.plan), contentOf(third.plan));
    assert.equal(once.referenceRoot, third.referenceRoot);
    assert.equal(once.plan.steps.find((st) => st.id === newMainId)?.decision.chosen, 'steps', 'the second answer landed on the step the first created');
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

  test('the honesty rule: a replanned step the model did NOT link to the decision still depends on it, and on what it was shown', async () => {
    const b = await base();
    const forgetful = fakeModel({}, (input) => {
      const out = followTheAnswer(input) as { steps: Array<Record<string, unknown>> };
      return { steps: out.steps.map((st) => ({ ...st, dependsOn: [] })) };
    });
    const out = await replanPlan(b.first.state, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(forgetful.run, b.gs, b.target));
    if (!out.ok) assert.fail(out.reason);
    const main = out.plan.steps.find((st) => st.target.file === 'cli/main.mjs')!;
    assert.ok(main.dependsOn.includes(idOf(b.first.state, 'core/tally.mjs')), 'the decision it was derived from');
    assert.ok(main.dependsOn.includes(idOf(b.first.state, 'cli')), 'the outside step it was shown');
  });

  test('a replan may open a NEW chapter, shape step first, and the plan stays a plan', async () => {
    const b = await base();
    const opts = [{ id: 'a', label: 'A', consequence: 'x' }, { id: 'b', label: 'B', consequence: 'y' }];
    const widen = fakeModel({}, (input) => {
      const out = followTheAnswer(input) as { steps: Array<Record<string, unknown>> };
      return {
        chapters: [{ key: 'ui', title: 'The prompt', subtitle: 'how the tally talks back' }],
        steps: [
          { kind: 'shape', chapter: 'ui', path: 'ui', question: 'Where does the prompt live?', options: opts, recommended: 'a', why: 'w', dependsOn: [] },
          { kind: 'file', chapter: 'ui', path: 'ui/prompt.mjs', question: 'What does it ask?', options: opts, recommended: 'a', why: 'w', dependsOn: ['ui'] },
          ...out.steps,
        ],
      };
    });
    const out = await replanPlan(b.first.state, idOf(b.first.state, 'cli'), 'repl', [], deps(widen.run, b.gs, b.target));
    if (!out.ok) assert.fail(out.reason);
    assert.deepEqual(validateBuildPlan(BUILD_PLAN_SCHEMA, out.plan), []);
    assert.deepEqual(out.plan.chapters.map((c) => c.key), ['core', 'cli', 'ui']);
    const ui = out.plan.steps.filter((st) => st.chapter === 'ui');
    assert.deepEqual(ui.map((st) => st.kind), ['shape', 'file'], 'the new chapter opens with its shape step');
    const cliId = idOf(b.first.state, 'cli');
    for (const st of ui) assert.ok(st.dependsOn.includes(cliId), `${st.target.file}: the honesty rule — it depends on the decision it was derived from`);
  });

  test('a replan that re-lists a chapter the plan already has is refused', async () => {
    const b = await base();
    const relist = fakeModel({}, (input) => ({ ...(followTheAnswer(input) as object), chapters: [{ key: 'core', title: 'Again', subtitle: 'again' }] }));
    const out = await replanPlan(b.first.state, idOf(b.first.state, 'cli'), 'repl', [], deps(relist.run, b.gs, b.target));
    assert.ok(!out.ok);
    assert.match(out.reason, /already has/);
  });

  test('a state handed in from outside is re-checked: a hostile step path is refused before anything is asked or written', async () => {
    const b = await base();
    const tampered: DerivationState = JSON.parse(JSON.stringify(b.first.state)) as DerivationState;
    const main = tampered.nodes.find((n) => n.path === 'cli/main.mjs')!;
    main.path = 'cli/../../escape.mjs';
    tampered.files['cli/../../escape.mjs'] = tampered.files['cli/main.mjs']!;
    delete tampered.files['cli/main.mjs'];
    tampered.entry = main.path;
    const out = await replanPlan(tampered, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(POISONED, b.gs, b.target));
    assert.ok(!out.ok);
    assert.match(out.reason, /cannot be replanned: .*climbs out of the reference tree/);
  });

  const bigText = 'x'.repeat(5_000_000);
  const tampers: Array<[string, (s: Record<string, unknown>, nodes: Array<Record<string, unknown>>) => void, RegExp?]> = [
    ['nodes holding a null', (s) => { s['nodes'] = [null]; }],
    ['nodes that are not a list', (s) => { s['nodes'] = 'nope'; }],
    ['chapters that are null', (s) => { s['chapters'] = null; }],
    ['files that are null', (s) => { s['files'] = null; }],
    ['answers that are null', (s) => { s['answers'] = null; }],
    ['an idea that is not text', (s) => { s['idea'] = { toString: 'x' }; }],
    ['a step path that is a number', (_s, n) => { n[1]!['path'] = 7; }],
    ['a dependsOn that is a number', (_s, n) => { n[1]!['dependsOn'] = 7; }],
    ['a dependsOn that is missing', (_s, n) => { delete n[1]!['dependsOn']; }],
    ['no options', (_s, n) => { n[2]!['options'] = []; }],
    ['options that are not a list', (_s, n) => { n[2]!['options'] = 'nope'; }],
    ['one option where the parser wants two', (_s, n) => { (n[2]!['options'] as unknown[]).splice(1); n[2]!['recommended'] = (n[2]!['options'] as Array<{ id: string }>)[0]!.id; }],
    ['31 options', (_s, n) => { n[2]!['options'] = Array.from({ length: 31 }, (_, i) => ({ id: `o${i}`, label: 'l', consequence: 'c' })); n[2]!['recommended'] = 'o0'; }],
    ['a recommendation that is not an option', (_s, n) => { n[2]!['recommended'] = 'zzz'; }],
    ['a step kind the plan does not have, at a hostile path', (_s, n) => { n[1]!['kind'] = 'symbol'; n[1]!['path'] = '../../../../etc/passwd'; }],
    ['a shape step at a hostile path', (_s, n) => { n[0]!['path'] = '../../outside'; }],
    ['a chapter key that climbs out', (s) => { (s['chapters'] as Array<Record<string, unknown>>)[0]!['key'] = '../../x'; }],
    ['a 5 MB option label', (_s, n) => { (n[2]!['options'] as Array<Record<string, unknown>>)[0]!['label'] = bigText; }],
    ['a 5 MB why', (_s, n) => { n[2]!['why'] = bigText; }],
    ['a question holding a line break', (_s, n) => { n[1]!['question'] = 'How is it kept?\nglobalThis.INJECTED = true;'; }],
    ['a file step with its chapter edge removed', (_s, n) => { n[1]!['dependsOn'] = []; }],
    ['the same dependency listed 20,000 times', (_s, n) => { n[3]!['dependsOn'] = Array.from({ length: 20_000 }, () => 'core/tally.mjs'); }],
    ['a 1 MB file', (s) => { (s['files'] as Record<string, unknown>)['core/tally.mjs'] = bigText.slice(0, 1_000_000); }],
    ['a file that is not text', (s) => { (s['files'] as Record<string, unknown>)['core/tally.mjs'] = 7; }],
    ['a file step with no code', (s) => { delete (s['files'] as Record<string, unknown>)['core/tally.mjs']; }],
  ];
  for (const [name, tamper] of tampers) {
    test(`a stored state with ${name} is refused in a sentence, before anything is asked or written`, async () => {
      const b = await base();
      const copy = JSON.parse(JSON.stringify(b.first.state)) as Record<string, unknown>;
      tamper(copy, copy['nodes'] as Array<Record<string, unknown>>);
      const out = await replanPlan(copy as unknown as DerivationState, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(POISONED, b.gs, b.target));
      assert.ok(!out.ok, 'a tampered state must not be replanned');
      assert.match(out.reason, /cannot be replanned/, `it should be the state door that says no, not: ${out.reason}`);
    });
  }

  test('replanPlan never rejects: anything unexpected comes back as a sentence', async () => {
    const b = await base();
    const copy = JSON.parse(JSON.stringify(b.first.state)) as DerivationState;
    Object.defineProperty(copy.nodes[0]!, 'path', { get() { throw new Error('a hostile getter'); }, enumerable: true });
    const out = await replanPlan(copy, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(POISONED, b.gs, b.target));
    assert.ok(!out.ok);
    assert.match(out.reason, /a hostile getter/);
  });

  test('a state that holds code for a path the plan does not have is refused', async () => {
    const b = await base();
    const tampered: DerivationState = JSON.parse(JSON.stringify(b.first.state)) as DerivationState;
    tampered.files['cli/stray.mjs'] = 'export {};\n';
    const out = await replanPlan(tampered, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(POISONED, b.gs, b.target));
    assert.ok(!out.ok);
    assert.match(out.reason, /not one of its file steps/);
  });

  test('a replan reply the merge refuses is NOT kept: the next press asks again and can succeed', async () => {
    const b = await base();
    const tallyId = idOf(b.first.state, 'core/tally.mjs');
    const opts = [{ id: 'a', label: 'A', consequence: 'x' }, { id: 'b', label: 'B', consequence: 'y' }];
    const clashing = fakeModel({}, (input) => {
      const out = followTheAnswer(input) as { steps: Array<Record<string, unknown>> };
      return { steps: [{ kind: 'shape', chapter: 'cli', path: 'cli', question: 'again?', options: opts, recommended: 'a', why: 'w', dependsOn: [] }, ...out.steps] };
    });
    const refused = await replanPlan(b.first.state, tallyId, 'object', [], deps(clashing.run, b.gs, b.target));
    assert.ok(!refused.ok);
    assert.match(refused.reason, /a step it was told to keep/);
    const good = fakeModel();
    const again = await replanPlan(b.first.state, tallyId, 'object', [], deps(good.run, b.gs, b.target));
    if (!again.ok) assert.fail(`a good model was given no chance, because the refused replan was served again: ${again.reason}`);
    assert.equal(good.asked.filter((a) => a.task === 'replan').length, 1, 'the replan was asked again');
  });

  test('a replanned step that depends on something no step provides is refused: the MERGED plan is validated', async () => {
    const b = await base();
    const dangling = fakeModel({}, (input) => {
      const out = followTheAnswer(input) as { steps: Array<Record<string, unknown>> };
      return { steps: out.steps.map((st) => ({ ...st, dependsOn: ['core/ghost.mjs'] })) };
    });
    const out = await replanPlan(b.first.state, idOf(b.first.state, 'core/tally.mjs'), 'object', [], deps(dangling.run, b.gs, b.target));
    assert.ok(!out.ok, 'a dangling dependency must not make a plan');
    assert.match(out.reason, /do not make a plan: .*not an earlier step/);
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
