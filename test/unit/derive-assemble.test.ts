// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/derive/assemble.ts` — a derived plan in repo-tour's own shape (AC1), with Mode A's own
 * truths where they differ. Fake extracts stand in for repo-tour's parser here. The REAL
 * `extract` over derived files is the engine suite's (step 7), and the full render in a real
 * extension host is `test/derive.test.ts`'s (AC3).
 */

import * as assert from 'node:assert/strict';
import {
  MAX_LOAD_BEARING,
  assemblePlan,
  boilerplateRanges,
  lineCountOf,
  loadBearingRanges,
  stepIdFor,
  type DeriveCost,
  type ExtractLike,
  type SymbolLike,
} from '../../src/derive/assemble.js';
import { parseOutlineReply } from '../../src/derive/prompt.js';
import { isDeriveRefusal, type Outline } from '../../src/derive/types.js';
import { emptyProgress, nextStepId, statusText, treeModel } from '../../src/walk/model.js';
import { FIXTURE_IDEA, fixtureOutlineText } from './derive-fixtures.js';
import { BUILD_PLAN_SCHEMA, validateBuildPlan } from './plan-schema.js';

const TALLY = 'export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
const MAIN = "import { total } from '../core/tally.mjs';\n\nconsole.log(total([1, 2, 3]));\n";

const COST: DeriveCost = {
  provider: 'fake', model: 'fake-model', metered: true, calls: 3, cachedStops: 0, interpretedStops: 3,
  inputTokens: 1200, outputTokens: 800, usd: 0.02, failures: [],
};

function outline(): Outline {
  const o = parseOutlineReply(fixtureOutlineText());
  if (isDeriveRefusal(o)) assert.fail(o.refused);
  return o;
}

function sym(name: string, line: number, endLine: number, exported = true): SymbolLike {
  return { name, kind: 'function', line, endLine, exported };
}

function extracts(): Map<string, ExtractLike> {
  return new Map([
    ['core/tally.mjs', { path: 'core/tally.mjs', symbols: [sym('total', 1, 3)], imports: [], parseErrors: 0 }],
    ['cli/main.mjs', { path: 'cli/main.mjs', symbols: [], imports: [{ raw: '../core/tally.mjs', resolved: 'core/tally.mjs' }], parseErrors: 0 }],
  ]);
}

function assembled(answers: Record<string, string> = {}) {
  const o = outline();
  return assemblePlan({
    idea: FIXTURE_IDEA, title: o.title, language: o.language, chapters: o.chapters, nodes: o.nodes, answers,
    files: new Map([['core/tally.mjs', TALLY], ['cli/main.mjs', MAIN]]),
    extracts: extracts(), cost: COST, generatedAt: '2026-11-05T08:00:00.000Z',
  });
}

suite('assemblePlan — a derived plan in repo-tour\'s own shape (AC1)', () => {
  test('validates against repo-tour\'s REAL schema/build-plan.schema.json', () => {
    const errors = validateBuildPlan(BUILD_PLAN_SCHEMA, assembled());
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  test('says what it is: source.kind "idea", mode "idea", nothing to reproduce', () => {
    const plan = assembled();
    assert.deepEqual(plan.source, { kind: 'idea', text: FIXTURE_IDEA });
    assert.equal(plan.mode, 'idea');
    assert.deepEqual(plan.reproduce, []);
  });

  test('every step: 2–4 options, exactly one taken (the recommendation), whySource interpret, no witness', () => {
    for (const s of assembled().steps) {
      assert.ok(s.decision.options.length >= 2 && s.decision.options.length <= 4, s.id);
      const taken = s.decision.options.filter((o) => o.taken);
      assert.equal(taken.length, 1, `${s.target.file}: exactly one taken`);
      assert.equal(taken[0]?.id, s.decision.authorChoice);
      assert.equal(s.decision.chosen, null, 'nobody has answered yet');
      assert.equal(s.decision.whySource, 'interpret', 'a model\'s why is never passed off as the author\'s own words');
      assert.deepEqual(s.witness, { sha: null, date: null, subject: null });
    }
  });

  test('ids are unique, ordinals run 1..n, and dependsOn names earlier steps by id', () => {
    const plan = assembled();
    assert.equal(new Set(plan.steps.map((s) => s.id)).size, plan.steps.length);
    assert.deepEqual(plan.steps.map((s) => s.ordinal), [1, 2, 3, 4]);
    const seen = new Set<string>();
    for (const s of plan.steps) {
      for (const d of s.dependsOn) assert.ok(seen.has(d), `${s.target.file} depends on an earlier step`);
      seen.add(s.id);
    }
    const main = plan.steps.find((s) => s.target.file === 'cli/main.mjs');
    const tally = plan.steps.find((s) => s.target.file === 'core/tally.mjs');
    const cli = plan.steps.find((s) => s.target.file === 'cli');
    assert.deepEqual(main?.dependsOn, [cli?.id, tally?.id]);
  });

  test('a file step\'s scaffold comes from its own exported symbols; a shape step owns no lines', () => {
    const plan = assembled();
    const tally = plan.steps.find((s) => s.target.file === 'core/tally.mjs');
    assert.deepEqual(tally?.scaffold, { loadBearing: [{ startLine: 1, endLine: 3 }], boilerplate: [] });
    const main = plan.steps.find((s) => s.target.file === 'cli/main.mjs');
    assert.deepEqual(main?.scaffold, { loadBearing: [], boilerplate: [{ startLine: 1, endLine: 3 }] }, 'exports nothing: all boilerplate');
    for (const s of plan.steps.filter((x) => x.kind === 'shape')) assert.deepEqual(s.scaffold, { loadBearing: [], boilerplate: [] });
  });

  test('chapters carry tierPath and come in first-step order', () => {
    assert.deepEqual(assembled().chapters, [
      { key: 'core', title: 'The tally', subtitle: 'what a running total is', tierPath: 'core' },
      { key: 'cli', title: 'The command line', subtitle: 'how a person talks to it', tierPath: 'cli' },
    ]);
  });

  test('an answer is recorded as chosen; an answer that is not an option is ignored', () => {
    const plan = assembled();
    const tallyId = plan.steps.find((s) => s.target.file === 'core/tally.mjs')!.id;
    const mainId = plan.steps.find((s) => s.target.file === 'cli/main.mjs')!.id;
    const answered = assembled({ [tallyId]: 'object', [mainId]: 'not-an-option' });
    assert.equal(answered.steps.find((s) => s.id === tallyId)?.decision.chosen, 'object');
    assert.equal(answered.steps.find((s) => s.id === mainId)?.decision.chosen, null);
  });

  test('a step keeps its id when its own answer changes, and a different decision gets a new one', () => {
    const plan = assembled();
    const tallyId = plan.steps.find((s) => s.target.file === 'core/tally.mjs')!.id;
    assert.deepEqual(assembled({ [tallyId]: 'object' }).steps.map((s) => s.id), plan.steps.map((s) => s.id));
    const node = outline().nodes[1]!;
    assert.notEqual(stepIdFor({ ...node, question: `${node.question} (again)` }), stepIdFor(node));
    assert.notEqual(stepIdFor({ ...node, options: node.options.map((o) => ({ ...o, label: `${o.label}!` })) }), stepIdFor(node));
  });

  test('the walk\'s own model takes it as it stands: a tree of every step, and a walk to the end', () => {
    const plan = assembled();
    const progress = emptyProgress(plan);
    const tree = treeModel(plan, progress);
    assert.deepEqual(tree.map((c) => c.steps.length), [2, 2]);
    assert.equal(statusText(plan, progress), 'step 1 / 4 · manual');
    let at = progress;
    const visited: string[] = [];
    for (let id = progress.current; id !== null; id = nextStepId(plan, at)) {
      visited.push(id);
      at = { ...at, current: id };
      if (visited.length > plan.steps.length) assert.fail('the walk did not end');
    }
    assert.equal(visited.length, 4);
  });
});

suite('scaffold ranges — Mode A\'s own rule, stated', () => {
  test('lineCountOf counts lines the way a person does', () => {
    assert.equal(lineCountOf(''), 0);
    assert.equal(lineCountOf('a'), 1);
    assert.equal(lineCountOf('a\n'), 1);
    assert.equal(lineCountOf('a\nb\n'), 2);
    assert.equal(lineCountOf('a\nb'), 2);
  });

  test('overlapping exports: the widest wins; non-exported and out-of-file symbols never count', () => {
    const ex: ExtractLike = {
      path: 'x.mjs', parseErrors: 0, imports: [],
      symbols: [sym('outer', 1, 10), sym('inner', 3, 4), sym('hidden', 12, 14, false), sym('ghost', 40, 50), sym('tail', 11, 12)],
    };
    assert.deepEqual(loadBearingRanges(ex, 20), [{ startLine: 1, endLine: 10 }, { startLine: 11, endLine: 12 }]);
  });

  test(`at most ${MAX_LOAD_BEARING} ranges, in line order`, () => {
    const symbols = Array.from({ length: 8 }, (_, i) => sym(`f${i}`, i * 3 + 1, i * 3 + 2));
    const ranges = loadBearingRanges({ path: 'x.mjs', symbols, imports: [], parseErrors: 0 }, 30);
    assert.equal(ranges.length, MAX_LOAD_BEARING);
    assert.deepEqual(ranges.map((r) => r.startLine), [...ranges.map((r) => r.startLine)].sort((a, b) => a - b));
  });

  test('boilerplate is exactly the lines no load-bearing range covers', () => {
    assert.deepEqual(boilerplateRanges([{ startLine: 3, endLine: 5 }, { startLine: 8, endLine: 8 }], 10), [
      { startLine: 1, endLine: 2 }, { startLine: 6, endLine: 7 }, { startLine: 9, endLine: 10 },
    ]);
    assert.deepEqual(boilerplateRanges([], 0), []);
    assert.deepEqual(boilerplateRanges([{ startLine: 1, endLine: 4 }], 4), []);
  });
});
