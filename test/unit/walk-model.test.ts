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
import { BUILD_PLAN_SCHEMA, validateBuildPlan, type JsonSchema } from './plan-schema.js';
import { MAX_OPTION_ID, MAX_OPTIONS_RENDERED, currentStep, emptyProgress, isOptionKey, markDone, nextStepId, optionsTable, prevStepId, setCheck, setChosen, setCurrent, setDial, statusText, stepDial, treeModel, withChosen, type OptionLike, type PlanLike, type Progress, type StepLike } from '../../src/walk/model.js';
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

suite('setChosen / withChosen — the learner\'s road, recorded beside the plan and shown on it (T-21)', () => {
  const STEP = 'st-4-symbol-render';

  test('setChosen is pure, keeps what the step already had, and latest wins', () => {
    const before = setDial(fixtureProgress(fixturePlan()), STEP, 'automated');
    const once = setChosen(before, STEP, 'stream');
    assert.equal(before.steps[STEP]?.chosen, undefined, 'the input progress was mutated');
    assert.equal(once.steps[STEP]?.chosen, 'stream');
    assert.equal(once.steps[STEP]?.dial, 'automated', 'the dial already recorded for the step was lost');
    assert.equal(setChosen(once, STEP, 'author').steps[STEP]?.chosen, 'author', 'latest wins');
  });

  test('withChosen shows the learner\'s choice in decision.chosen — on a NEW plan, never the one read from disk', () => {
    const plan = fixturePlan();
    const authors = plan.steps.find((s) => s.id === STEP)!.decision.chosen;
    const shown = withChosen(plan, setChosen(fixtureProgress(fixturePlan()), STEP, 'template-string'));
    assert.equal(shown.steps.find((s) => s.id === STEP)!.decision.chosen, 'template-string');
    assert.equal(plan.steps.find((s) => s.id === STEP)!.decision.chosen, authors, 'the plan read from disk was mutated');
    assert.equal(shown.steps.find((s) => s.id === STEP)!.decision.authorChoice, 'author', 'the author\'s road must stay the author\'s');
    assert.deepEqual(shown.steps.find((s) => s.id === STEP)!.decision.options.map((o) => o.taken), [true, false, false], '"taken" is the author\'s, never the learner\'s');
  });

  test('a recorded choice that names no option of its step is ignored, not shown (a rebuilt plan)', () => {
    const plan = fixturePlan();
    const shown = withChosen(plan, setChosen(fixtureProgress(fixturePlan()), STEP, 'an-option-that-is-gone'));
    assert.equal(shown, plan, 'nothing to overlay: the same plan comes back');
  });

  test('no choice recorded: the very same plan object comes back (discriminates)', () => {
    const plan = fixturePlan();
    assert.equal(withChosen(plan, fixtureProgress(fixturePlan())), plan);
  });
});

suite('optionsTable — the road a step is on and what the page can show, decided once (T-21: C4, C5, C6, S2, S3, S4)', () => {
  const STEP = 'st-4-symbol-render';
  const option = (id: unknown, taken = false): OptionLike => ({ id, label: 'a road', consequence: 'a consequence', taken } as OptionLike);

  function stepWith(options: unknown, decision: Partial<StepLike['decision']> = {}): StepLike {
    const step = fixturePlan().steps.find((s) => s.id === STEP)!;
    return { ...step, decision: { ...step.decision, options: options as OptionLike[], authorChoice: 'author', chosen: null, ...decision } };
  }

  test('on the author\'s road until the learner names a row: `taken` first, `authorChoice` only when nothing is `taken`', () => {
    const marked = optionsTable(stepWith([option('author', true), option('alt-1'), option('alt-2')]));
    assert.equal(marked.author, 0);
    assert.equal(marked.on, 0);
    assert.equal(marked.diverged, false);
    assert.deepEqual(marked.choosable, [false, true, true], 'every other road is choosable, the one the step is on is not');

    const fallback = optionsTable(stepWith([option('alt-1'), option('author'), option('alt-2')]));
    assert.equal(fallback.author, 1, 'no `taken` anywhere: `authorChoice` answers');
    assert.equal(fallback.on, 1);
  });

  test('the learner\'s road moves the mark and is called a divergence; the author\'s own road is not', () => {
    const chosen = optionsTable(stepWith([option('author', true), option('alt-1'), option('alt-2')], { chosen: 'alt-2' }));
    assert.equal(chosen.on, 2);
    assert.equal(chosen.author, 0, 'the author\'s road stays the author\'s');
    assert.equal(chosen.diverged, true);
    assert.deepEqual(chosen.choosable, [true, true, false], 'the author\'s road is choosable again');

    const back = optionsTable(stepWith([option('author', true), option('alt-1')], { chosen: 'author' }));
    assert.equal(back.diverged, false, 'repo-tour writes chosen:"author" on every step: nothing diverged there');
  });

  test('when `taken` and `authorChoice` disagree there is still one answer, `taken`\'s (C4, S3)', () => {
    const table = optionsTable(stepWith([option('author'), option('stream', true), option('alt')], { authorChoice: 'author' }));
    assert.equal(table.on, 1, 'the road this step is on is the marked one');
    assert.deepEqual(table.choosable, [true, false, true], '`author` is offered and must be choosable, not refused');
  });

  test('a row whose id another row shares has no key and no control, wherever the mark is (C4, S3)', () => {
    const table = optionsTable(stepWith([option('author', true), option('dup'), option('dup'), option('other')]));
    assert.deepEqual(table.keys, ['author', null, null, 'other']);
    assert.deepEqual(table.choosable, [false, false, false, true]);
    assert.equal(optionsTable(stepWith([option('dup', true), option('dup')], { chosen: 'dup' })).diverged, false, 'a duplicated id names no row: nothing diverged');
  });

  test('an id the message cannot carry has no control: empty, not a string, one past the limit — the longest it can carry has one (C6, S4)', () => {
    const long = 'x'.repeat(MAX_OPTION_ID);
    const table = optionsTable(stepWith([option('author', true), option(''), option(7), option(null), option(`${long}x`), option(long)]));
    assert.deepEqual(table.keys, ['author', null, null, null, null, long]);
    assert.deepEqual(table.choosable, [false, false, false, false, false, true]);
    for (const id of ['', 7, null, undefined, `${long}x`]) assert.equal(isOptionKey(id), false, JSON.stringify(id));
    assert.equal(isOptionKey(long), true);
  });

  test('the page shows the first 24, the author\'s option kept in view; nothing past them is a road (C5, S2)', () => {
    const many = Array.from({ length: 30 }, (_, i) => option(i === 28 ? 'author' : `alt-${i}`, i === 28));
    const table = optionsTable(stepWith(many, { chosen: 'alt-26' }));
    assert.equal(table.rows.length, MAX_OPTIONS_RENDERED);
    assert.equal(table.omitted, 30 - MAX_OPTIONS_RENDERED);
    assert.equal(table.author, MAX_OPTIONS_RENDERED - 1, 'AC2 outranks the cap: the author\'s option takes the last slot');
    assert.ok(!table.keys.includes('alt-26'), 'an option the page cannot draw is not on the table');
    assert.equal(table.on, table.author, 'so a recorded choice past the window leaves the step on the author\'s road');
    assert.equal(table.diverged, false);
    assert.ok(!table.keys.includes('alt-23'), 'the row the author\'s option displaced is not on the table either');
  });

  test('withChosen overlays only what the page can show (C5, S2): the screen and decision.chosen must agree', () => {
    const plan = fixturePlan();
    const step = plan.steps.find((s) => s.id === STEP)!;
    step.decision.options = Array.from({ length: 30 }, (_, i) => option(i === 0 ? 'author' : `alt-${i}`, i === 0));
    step.decision.chosen = null;
    const past = withChosen(plan, setChosen(fixtureProgress(fixturePlan()), STEP, 'alt-27'));
    assert.equal(past, plan, 'a recorded choice the page cannot draw is not overlaid');
    const within = withChosen(plan, setChosen(fixtureProgress(fixturePlan()), STEP, 'alt-3'));
    assert.equal(within.steps.find((s) => s.id === STEP)!.decision.chosen, 'alt-3', 'discriminates: one it can draw is');
  });

  test('a step with one option offers nothing, whether or not that option is the marked road (AC6)', () => {
    assert.deepEqual(optionsTable(stepWith([option('author', true)])).choosable, [false]);
    assert.deepEqual(optionsTable(stepWith([option('alt-1')], { authorChoice: '' })).choosable, [false], 'not even an unmarked one');
  });

  test('a step with no id the page could report offers nothing: every press would be refused', () => {
    assert.deepEqual(optionsTable({ ...stepWith([option('author', true), option('alt-1')]), id: '' }).choosable, [false, false]);
    assert.deepEqual(optionsTable({ ...stepWith([option('author', true), option('alt-1')]), id: 7 as unknown as string }).choosable, [false, false]);
  });

  test('total over a plan whose decision is not the shape its type claims', () => {
    for (const options of [undefined, null, 'three', { length: 3 }, 7]) {
      assert.deepEqual(optionsTable(stepWith(options)).rows, [], `options ${JSON.stringify(options)}`);
    }
    assert.deepEqual(optionsTable({ id: STEP, decision: undefined as unknown as StepLike['decision'] }).choosable, []);
    assert.deepEqual(optionsTable(stepWith([null, 7, 'x', option('author', true)])).keys, [null, null, null, 'author']);
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

suite('stepDial and setCheck — the dial that actually applies, and the check that ran (T-5 AC1, AC5)', () => {
  test('a per-step override wins over the global', () => {
    const plan = fixturePlan();
    const progress = setDial(emptyProgress(plan), 'st-1-shape-src', 'automated');
    assert.equal(stepDial(progress, 'st-1-shape-src', 'scaffolded'), 'automated');
  });

  test('with no override, the GLOBAL from the start screen applies — the half T-4 left undone', () => {
    const plan = fixturePlan();
    assert.equal(stepDial(emptyProgress(plan), 'st-1-shape-src', 'automated'), 'automated');
  });

  test('with neither, it is manual — the only fallback that cannot overstate what was written', () => {
    const plan = fixturePlan();
    assert.equal(stepDial(emptyProgress(plan), 'st-1-shape-src', undefined), 'manual');
    assert.equal(stepDial(emptyProgress(plan), null, undefined), 'manual');
  });

  test('setCheck records a verdict without disturbing status or dial', () => {
    const plan = fixturePlan();
    const before = setDial(markDone(emptyProgress(plan), 'st-2-file-parse'), 'st-2-file-parse', 'scaffolded');
    const after = setCheck(before, 'st-2-file-parse', false, '2026-09-05T00:00:00.000Z');
    assert.deepEqual(after.steps['st-2-file-parse'], {
      status: 'done', dial: 'scaffolded', check: { ok: false, at: '2026-09-05T00:00:00.000Z' },
    });
  });

  test('the tree distinguishes not-checked from checked-and-failed', () => {
    const plan = fixturePlan();
    // The distinction matters: without it every step the learner has not reached yet would
    // wear the same mark as one they actually got wrong.
    const progress = setCheck(setCheck(emptyProgress(plan), 'st-2-file-parse', true, 'now'), 'st-3-symbol-handle', false, 'now');
    const nodes = treeModel(plan, progress).flatMap((c) => c.steps);
    assert.equal(nodes.find((n) => n.id === 'st-2-file-parse')?.check, 'pass');
    assert.equal(nodes.find((n) => n.id === 'st-3-symbol-handle')?.check, 'fail');
    assert.equal(nodes.find((n) => n.id === 'st-1-shape-src')?.check, undefined, 'never checked is not a failure');
  });
});

suite('statusText — the status bar line (AC6)', () => {
  test('the exact "step N / M · dial" shape the AC asks for', () => {
    const plan = fixturePlan();
    assert.equal(statusText(plan, fixtureProgress(plan)), 'step 2 / 4 · scaffolded');
  });

  test('the GLOBAL dial reaches the status bar when a step has no override (AC1)', () => {
    const plan = fixturePlan();
    assert.equal(statusText(plan, emptyProgress(plan), 'automated'), 'step 1 / 4 · automated');
  });

  test('and a per-step override still wins there', () => {
    const plan = fixturePlan();
    assert.equal(statusText(plan, fixtureProgress(plan), 'automated'), 'step 2 / 4 · scaffolded');
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

// ── repo-tour's real schema, through the ONE shared checker (test/unit/plan-schema.ts, hoisted
// by T-17 from the two byte-identical copies this file and its sibling used to carry). ──

const SCHEMA: JsonSchema = BUILD_PLAN_SCHEMA;

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
    assert.ok(plan.steps.some((s) => s.decision.options.length >= 2), 'at least one step needs alternatives, the only steps a learner can choose on');
    assert.ok(plan.steps.some((s) => s.witness.sha !== null), 'at least one witness sentence must be renderable');
    assert.ok(plan.steps.some((s) => s.witness.sha === null), 'and at least one "no history to show"');
    assert.ok(plan.steps.some((s) => s.kind === 'symbol' && s.scaffold.loadBearing.length > 0), 'a symbol step with load-bearing lines to decorate');
    assert.deepEqual(plan.steps.map((s) => s.ordinal), [1, 2, 3, 4]);
  });
});
