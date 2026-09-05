// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/walk/model.ts — the walk's state as pure data, so every rule the tree, the panel and the
 * status bar depend on is pinned here, with no extension host anywhere near it.
 *
 * Three of its behaviours are deliberate choices rather than obvious ones, and each has a test
 * whose job is to notice if someone "simplifies" it away:
 *
 *   1. Everything that walks the plan sorts a COPY by `ordinal` first. The flat `steps` array
 *      is documented as already ordered, but a hand-built fixture or a future producer is not
 *      obliged to hand it over that way, and a walk that silently follows array order would put
 *      the learner in the wrong place with no error anywhere. Every ordering test below feeds a
 *      deliberately reversed array, and one of them also proves the caller's own array survives.
 *   2. A chapter with no steps is dropped from the tree, not rendered as an empty node.
 *   3. `statusText` falls back to `manual` when the current step carries no dial override —
 *      T-4 never reads the start screen's GLOBAL dial, so "manual" (never built, nothing typed)
 *      is the only fallback that cannot overstate what has actually happened to that step.
 *
 * The last suite validates `walk-fixtures.ts`'s hand-written plan against repo-tour's REAL
 * schema/build-plan.schema.json. Every other T-4 test — and `test/walk.test.ts` after them —
 * argues about that plan, so "the fixture is a legitimate BuildPlan" is load-bearing for all of
 * them, not a nicety. The checker is a hand-rolled draft-07 subset, duplicated from
 * `test/unit/build.test.ts` on purpose: mirroring it locally in each test file that needs it is
 * the established pattern here (repo-tour's own T-12 test does the same), and it keeps `ajv`
 * out of the dependency list for a schema that uses only $ref/const/enum/oneOf/type/
 * required+properties/items+minItems.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCoreRoot } from '../../src/core.js';
import {
  currentStep, emptyProgress, markDone, nextStepId, prevStepId, setCurrent, setDial, statusText, treeModel,
  type PlanLike, type Progress, type StepLike,
} from '../../src/walk/model.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

const IDS = ['st-1-shape-src', 'st-2-file-parse', 'st-3-symbol-handle', 'st-4-symbol-render'];

function stepById(plan: PlanLike, id: string): StepLike {
  const step = plan.steps.find((s) => s.id === id);
  assert.ok(step, `the fixture plan should contain a step ${id}`);
  return step;
}

/** The same plan with its steps handed over in the wrong order — ordinals 4, 3, 2, 1. */
function reversed(plan: PlanLike): PlanLike {
  return { ...plan, steps: [...plan.steps].reverse() };
}

function at(plan: PlanLike, stepId: string): Progress {
  return setCurrent(emptyProgress(plan), stepId);
}

suite('emptyProgress / currentStep — where a brand-new walk starts', () => {
  test('parks on the first step by ordinal, with nothing recorded against any step yet', () => {
    const progress = emptyProgress(fixturePlan());
    assert.deepEqual(progress, { schemaVersion: 1, current: 'st-1-shape-src', steps: {} });
  });

  test('an unsorted steps array still starts at ordinal 1, not at steps[0]', () => {
    const plan = reversed(fixturePlan());
    assert.equal(plan.steps[0]?.id, 'st-4-symbol-render', 'the fixture for this test must really be out of order');
    assert.equal(emptyProgress(plan).current, 'st-1-shape-src');
  });

  test('a plan with no steps at all has no current step — null, never an invented id', () => {
    const progress = emptyProgress({ ...fixturePlan(), steps: [] });
    assert.equal(progress.current, null);
  });

  test('currentStep resolves the current id against the plan', () => {
    const plan = fixturePlan();
    assert.equal(currentStep(plan, at(plan, 'st-3-symbol-handle'))?.ordinal, 3);
  });

  test('currentStep is undefined for nothing-current and for an id the plan does not have', () => {
    const plan = fixturePlan();
    const nothing: Progress = { schemaVersion: 1, current: null, steps: {} };
    assert.equal(currentStep(plan, nothing), undefined);
    assert.equal(currentStep(plan, at(plan, 'st-99-deleted')), undefined, 'a stale id must not resolve to some other step');
  });
});

suite('nextStepId / prevStepId — Next / Previous, and the two ends (AC2)', () => {
  test('next walks the plan in ordinal order and returns null at the last step — no wraparound', () => {
    const plan = fixturePlan();
    assert.deepEqual(IDS.map((id) => nextStepId(plan, at(plan, id))), [IDS[1], IDS[2], IDS[3], null]);
  });

  test('prev walks back and returns null at the first step — no wraparound at that end either', () => {
    const plan = fixturePlan();
    assert.deepEqual(IDS.map((id) => prevStepId(plan, at(plan, id))), [null, IDS[0], IDS[1], IDS[2]]);
  });

  test('a deliberately unsorted steps array is still walked in ordinal order, not array order', () => {
    const plan = reversed(fixturePlan());
    assert.equal(nextStepId(plan, at(plan, 'st-2-file-parse')), 'st-3-symbol-handle');
    assert.equal(prevStepId(plan, at(plan, 'st-2-file-parse')), 'st-1-shape-src');
  });

  test('an unrecognised current reads as "not started": next offers the first step, prev offers nothing', () => {
    const plan = fixturePlan();
    const nowhere: Progress = { schemaVersion: 1, current: null, steps: {} };
    assert.equal(nextStepId(plan, nowhere), 'st-1-shape-src');
    assert.equal(prevStepId(plan, nowhere), null);
    assert.equal(nextStepId(plan, at(plan, 'st-99-deleted')), 'st-1-shape-src', 'a stale tree click must not strand the walk');
    assert.equal(prevStepId(plan, at(plan, 'st-99-deleted')), null);
  });

  test('a plan with no steps yields null in both directions rather than throwing', () => {
    const empty = { ...fixturePlan(), steps: [] };
    const progress = emptyProgress(empty);
    assert.equal(nextStepId(empty, progress), null);
    assert.equal(prevStepId(empty, progress), null);
  });
});

suite('setCurrent / markDone / setDial — pure updates, never a mutation', () => {
  test('setCurrent moves the position and leaves the progress it was handed untouched', () => {
    const before = emptyProgress(fixturePlan());
    const after = setCurrent(before, 'st-3-symbol-handle');
    assert.equal(after.current, 'st-3-symbol-handle');
    assert.equal(before.current, 'st-1-shape-src', 'the caller\'s own object must not be rewritten under it');
  });

  test('markDone records a step that had no entry at all, and keeps a dial already set there', () => {
    const plan = fixturePlan();
    const withDial = setDial(emptyProgress(plan), 'st-2-file-parse', 'automated');
    const done = markDone(withDial, 'st-2-file-parse');
    assert.deepEqual(done.steps['st-2-file-parse'], { status: 'done', dial: 'automated' });
    assert.deepEqual(markDone(emptyProgress(plan), 'st-4-symbol-render').steps['st-4-symbol-render'], { status: 'done' });
    assert.deepEqual(withDial.steps['st-2-file-parse'], { status: 'pending', dial: 'automated' }, 'markDone must not edit its input');
  });

  test('setDial on a step already done keeps it done (the spread order here is easy to get backwards)', () => {
    const plan = fixturePlan();
    const done = markDone(emptyProgress(plan), 'st-1-shape-src');
    assert.deepEqual(setDial(done, 'st-1-shape-src', 'scaffolded').steps['st-1-shape-src'], { status: 'done', dial: 'scaffolded' });
  });

  test('setDial on a step with no entry yet defaults its status to pending', () => {
    const dialled = setDial(emptyProgress(fixturePlan()), 'st-3-symbol-handle', 'manual');
    assert.deepEqual(dialled.steps['st-3-symbol-handle'], { status: 'pending', dial: 'manual' });
  });

  test('one step\'s entry is never disturbed by an update to another', () => {
    const plan = fixturePlan();
    const both = setDial(markDone(emptyProgress(plan), 'st-1-shape-src'), 'st-2-file-parse', 'scaffolded');
    assert.deepEqual(both.steps, {
      'st-1-shape-src': { status: 'done' },
      'st-2-file-parse': { status: 'pending', dial: 'scaffolded' },
    });
  });
});

suite('treeModel — the decision tree (AC1)', () => {
  test('chapters in plan order, steps in ordinal order, with done / current / pending statuses', () => {
    const plan = fixturePlan();
    const tree = treeModel(plan, fixtureProgress(plan));

    assert.deepEqual(tree.map((c) => c.key), ['src', 'src/api']);
    assert.deepEqual(tree.map((c) => c.title), ['src', 'src/api']);
    assert.equal(tree[0]?.subtitle, '1 file · 20 lines');
    assert.deepEqual(
      tree.flatMap((c) => c.steps).map((s) => [s.id, s.status]),
      [
        ['st-1-shape-src', 'done'],       // marked done by fixtureProgress
        ['st-2-file-parse', 'current'],   // where the walk is parked
        ['st-3-symbol-handle', 'pending'],
        ['st-4-symbol-render', 'pending'],
      ],
    );
  });

  test('a step\'s tree label is its question, and its kind carries through for the icon', () => {
    const plan = fixturePlan();
    const first = treeModel(plan, emptyProgress(plan))[0]?.steps[0];
    assert.equal(first?.title, stepById(plan, 'st-1-shape-src').decision.question);
    assert.equal(first?.kind, 'shape');
    assert.equal(first?.ordinal, 1);
  });

  test('a step that is BOTH done and current shows as current — the walk shows where you are', () => {
    const plan = fixturePlan();
    const progress = markDone(emptyProgress(plan), 'st-1-shape-src');
    assert.equal(treeModel(plan, progress)[0]?.steps[0]?.status, 'current');
  });

  test('a chapter with no steps is left out entirely, not shown as an empty, unclickable node', () => {
    const plan = fixturePlan();
    const withGhost: PlanLike = {
      ...plan,
      chapters: [...plan.chapters, { key: 'docs', title: 'docs', subtitle: '0 files · 0 lines', tierPath: 'docs' }],
    };
    assert.deepEqual(treeModel(withGhost, emptyProgress(withGhost)).map((c) => c.key), ['src', 'src/api']);
  });

  test('an unsorted steps array comes back ordered — and the caller\'s own array is not reordered', () => {
    const plan = reversed(fixturePlan());
    const handedOver = plan.steps.map((s) => s.id);
    const tree = treeModel(plan, emptyProgress(plan));

    assert.deepEqual(tree.flatMap((c) => c.steps).map((s) => s.ordinal), [1, 2, 3, 4]);
    assert.deepEqual(plan.steps.map((s) => s.id), handedOver, 'treeModel must sort a copy, never the plan it was given');
  });

  // REVERSED on review (T-4 code review, finding 7). This suite previously pinned the
  // opposite — that an orphan step is dropped — and the reviewer was right that dropping is
  // the worse of the two behaviours. An orphan step is still reachable by Next/Previous and
  // still renders in the panel, so dropping it produces the one tree state worse than an
  // ugly one: the learner is standing ON a step the tree does not contain, and the tree
  // silently stops agreeing with the panel and the status bar. A real plan has no orphans;
  // a stale or hand-edited one can, and an odd-looking chapter is the honest answer.
  test('a step whose chapter matches no chapter key gets a chapter of its own, rather than vanishing', () => {
    const plan = fixturePlan();
    const orphan: StepLike = { ...stepById(plan, 'st-4-symbol-render'), id: 'st-orphan', chapter: 'ghost' };
    const tree = treeModel({ ...plan, steps: [...plan.steps, orphan] }, emptyProgress(plan));

    assert.deepEqual(tree.flatMap((c) => c.steps).map((s) => s.id), [...IDS, 'st-orphan'], 'every step in the plan is somewhere in the tree');
    const ghost = tree.find((c) => c.key === 'ghost');
    assert.ok(ghost, 'the orphan gets its own chapter node');
    assert.equal(ghost.steps.length, 1);
    assert.match(ghost.subtitle, /not listed/, 'and that chapter says plainly why it looks odd');
  });
});

suite('statusText — the status bar line (AC6)', () => {
  test('the exact "step N / M · dial" shape the AC asks for', () => {
    const plan = fixturePlan();
    assert.equal(statusText(plan, fixtureProgress(plan)), 'step 2 / 4 · scaffolded');
  });

  test('falls back to "manual" when the current step has no dial override recorded', () => {
    const plan = fixturePlan();
    assert.equal(statusText(plan, emptyProgress(plan)), 'step 1 / 4 · manual');
    assert.equal(statusText(plan, at(plan, 'st-4-symbol-render')), 'step 4 / 4 · manual');
  });

  test('the dial shown is the CURRENT step\'s, not some other step\'s override', () => {
    const plan = fixturePlan();
    const elsewhere = setDial(emptyProgress(plan), 'st-3-symbol-handle', 'automated');
    assert.equal(statusText(plan, elsewhere), 'step 1 / 4 · manual');
    assert.equal(statusText(plan, setCurrent(elsewhere, 'st-3-symbol-handle')), 'step 3 / 4 · automated');
  });

  test('the counter is 1-indexed by ORDINAL, not by position in the steps array', () => {
    const plan = reversed(fixturePlan());
    assert.equal(plan.steps[0]?.id, 'st-4-symbol-render');
    assert.equal(statusText(plan, at(plan, 'st-4-symbol-render')), 'step 4 / 4 · manual', 'array position would have said "step 1 / 4"');
  });
});

// ── the fixture plan, against repo-tour's real schema ───────────────────────────────────────
//
// A hand-rolled draft-07 subset checker, mirroring test/unit/build.test.ts's own (which in
// turn mirrors repo-tour's T-12 test) — no ajv, same reasoning: a small checker over exactly
// the subset schema/build-plan.schema.json uses ($ref, const, enum, oneOf, type,
// required/properties, items/minItems) needs no runtime dependency, and duplicating it per
// test file is the deliberate house pattern rather than a shared helper in src/.

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

type JsonSchema = Record<string, unknown>;

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const parts = ref.replace(/^#\//, '').split('/');
  let cur: unknown = root;
  for (const p of parts) cur = (cur as Record<string, unknown>)[p];
  return cur as JsonSchema;
}

function validateAgainst(root: JsonSchema, schema: JsonSchema, value: unknown, at: string, errors: string[]): void {
  if (typeof schema['$ref'] === 'string') {
    validateAgainst(root, resolveRef(root, schema['$ref']), value, at, errors);
    return;
  }
  if ('const' in schema) {
    if (value !== schema['const']) errors.push(`${at}: expected ${JSON.stringify(schema['const'])}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema['enum'])) {
    if (!schema['enum'].includes(value)) errors.push(`${at}: expected one of ${JSON.stringify(schema['enum'])}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema['oneOf'])) {
    const matches = (schema['oneOf'] as JsonSchema[]).filter((s) => {
      const sub: string[] = [];
      validateAgainst(root, s, value, at, sub);
      return sub.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at}: expected exactly one oneOf branch to match, ${matches.length} did`);
    return;
  }
  if (schema['type'] !== undefined) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    const ok = types.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
      return typeof value === t;
    });
    if (!ok) {
      errors.push(`${at}: expected type ${JSON.stringify(schema['type'])}, got ${JSON.stringify(value)}`);
      return;
    }
  }
  if (schema['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${at}: missing required key "${key}"`);
    }
    const props = (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateAgainst(root, sub, obj[key], `${at}.${key}`, errors);
    }
  }
  if (schema['type'] === 'array' && Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      errors.push(`${at}: expected at least ${schema['minItems']} items, got ${value.length}`);
    }
    if (schema['items']) value.forEach((v, i) => validateAgainst(root, schema['items'] as JsonSchema, v, `${at}[${i}]`, errors));
  }
}

function validateBuildPlan(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  validateAgainst(schema, schema, value, '$', errors);
  return errors;
}

const SCHEMA: JsonSchema = JSON.parse(
  fs.readFileSync(path.join(CORE_ROOT, 'schema', 'build-plan.schema.json'), 'utf8'),
) as JsonSchema;

suite('the fixture plan itself — a legitimate BuildPlan, not merely a plausible-looking one', () => {
  test('validates against repo-tour\'s real schema/build-plan.schema.json', () => {
    const errors = validateBuildPlan(SCHEMA, fixturePlan());
    assert.deepEqual(errors, [], `the hand-written fixture plan should validate:\n${errors.join('\n')}`);
  });

  test('the checker really checks: a missing top-level key and a bad enum deep inside a step both fail', () => {
    assert.ok(validateBuildPlan(SCHEMA, { schemaVersion: 1, mode: 'recreate' }).length > 0, 'missing source/chapters/steps/... should fail');

    const plan = fixturePlan();
    const broken: unknown = {
      ...plan,
      steps: plan.steps.map((s) => (s.id === 'st-3-symbol-handle' ? { ...s, decision: { ...s.decision, whySource: 'vibes' } } : s)),
    };
    const errors = validateBuildPlan(SCHEMA, broken);
    assert.ok(errors.some((e) => e.includes('whySource')), `a whySource outside the enum should be named:\n${errors.join('\n')}`);
  });

  test('it covers what the real sql-gauntlet plan cannot: every whySource, alternatives, and both witness shapes', () => {
    const plan = fixturePlan();
    assert.deepEqual(
      [...new Set(plan.steps.map((s) => s.decision.whySource))].sort(),
      ['docstring', 'interpret', 'none'],
      'all three whySource labels must be renderable from this one plan',
    );
    assert.ok(plan.steps.some((s) => s.decision.options.length >= 2), 'at least one step needs alternatives for the "coming with T-10" path');
    assert.ok(plan.steps.some((s) => s.witness.sha !== null), 'at least one witness sentence must be renderable');
    assert.ok(plan.steps.some((s) => s.witness.sha === null), 'and at least one "no history to show"');
    assert.ok(plan.steps.some((s) => s.kind === 'symbol' && s.scaffold.loadBearing.length > 0), 'a symbol step with load-bearing lines to decorate');
    assert.deepEqual(plan.steps.map((s) => s.ordinal), [1, 2, 3, 4]);
  });
});
