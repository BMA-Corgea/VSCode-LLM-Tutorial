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
import { derivePlan, type DeriveDeps } from '../../src/derive/engine.js';
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

/** A fake model: reads the INPUT line and answers the task it names. `code` maps a path to a file. */
function fakeModel(code: Record<string, string> = { 'core/tally.mjs': TALLY, 'cli/main.mjs': MAIN }) {
  const asked: Asked[] = [];
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '));
    if (line === undefined) return Promise.reject(new Error('the prompt had no INPUT line'));
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    asked.push({ task: String(input['task']), input });
    let text: string;
    if (input['task'] === 'outline') text = fixtureOutlineText();
    else if (input['task'] === 'code') text = JSON.stringify({ content: code[String((input['node'] as Record<string, unknown>)['path'])] ?? 'export {};\n' });
    else return Promise.reject(new Error(`the fake model has no answer for ${String(input['task'])}`));
    return Promise.resolve({ text, inputTokens: 10, outputTokens: 5, usd: 0.001, metered: true });
  };
  return { asked, run };
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

  test('a changed answer is refused in words until the replan exists — never quietly ignored', async () => {
    const gs = tempDir('derive-engine-gs-');
    const target = tempDir('derive-engine-target-');
    const first = await derivePlan({ idea: FIXTURE_IDEA }, deps(fakeModel().run, gs, target));
    if (!first.ok) assert.fail(first.reason);
    const tallyNode = first.outline.nodes.find((n) => n.path === 'core/tally.mjs')!;
    const out = await derivePlan({ idea: FIXTURE_IDEA, answers: { [stepIdFor(tallyNode)]: 'object' } }, deps(POISONED, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /needs the replan/);
  });
});
