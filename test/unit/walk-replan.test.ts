// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The press of *Choose this instead* in the walk (T-22): the re-plan starts at once, nothing is
 * written until it lands, and every ending says so on the page. Real files, real store, a fake
 * engine: the engine has its own suite (`derive-diverge.test.ts`), and no test here spends a token.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeriveCost } from '../../src/derive/assemble.js';
import type { DivergeInput, DivergeOutcome } from '../../src/derive/diverge.js';
import { loadCore, resolveCoreRoot } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import type { Dial } from '../../src/start/request.js';
import { tutorCoreFor, type LlmReply, type TutorCore } from '../../src/tutor/core.js';
import { DERIVED_CODE_MISSING_MESSAGE } from '../../src/walk/reference.js';
import { REPLANNED_TRANSCRIPT_NOTE, getTranscript, sentTurns } from '../../src/tutor/transcript.js';
import { setCurrent, setDial, markDone, type PlanLike, type Progress, type StepLike } from '../../src/walk/model.js';
import {
  CHOICE_ALREADY_REPLANNING, CHOICE_ALREADY_TAKEN, REPLAN_CANCELLED_BILLED, REPLAN_CANCELLED_UNSENT, REPLAN_NOTHING_FOLLOWS,
  REPLAN_NO_REFERENCE, REPLAN_STARTING, REPLAN_UNAVAILABLE, WalkSession, replanDoneText, replanRefusedText,
  type ReplanHooks, type Replanner, type WalkAdapters, type WalkView,
} from '../../src/walk/session.js';
import { buildDir, loadPlan, loadProgress, loadRequest, saveDivergedPlan, saveProgress } from '../../src/walk/store.js';
import { optionsTable } from '../../src/walk/model.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

const D = 'st-2-file-parse';
const ANSWER = 'inline-in-routes';
const LATER = 'st-4-symbol-render';
const TREE = 'k/new';

const made: string[] = [];
/** Every session a harness opened: disposed after each test, so no ledger leaves its scratch folder behind (code review N14). */
const opened: WalkSession[] = [];
teardown(() => {
  for (const session of opened.splice(0)) session.dispose();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const COST: DeriveCost = { provider: 'p', model: 'm', metered: true, calls: 2, cachedStops: 0, interpretedStops: 2, inputTokens: 10, outputTokens: 20, usd: 0.0123, failures: [] };

/** What a re-plan of `D` produces: D answered, the last step replaced by one the model wrote. */
function replanned(plan: PlanLike, tree = TREE, answer = ANSWER): PlanLike {
  const fresh: StepLike = {
    ...plan.steps.find((s) => s.id === LATER)!,
    id: 'fresh-1',
    kind: 'file',
    target: { file: 'src/api/fresh.ts' },
    derivedFrom: D,
  };
  const prior = (plan['divergences'] as unknown[] | undefined) ?? [];
  return {
    ...plan,
    steps: [...plan.steps.filter((s) => s.id !== LATER), fresh]
      .map((s, i) => ({ ...s, ordinal: i + 1, ...(s.id === D ? { derivedFrom: D, decision: { ...s.decision, chosen: answer } } : {}) })),
    divergences: [...prior, { stepId: D, answer, staleDependents: [], at: 't', tree }],
  };
}

function landed(plan: PlanLike, derivedRoot: string, tree = TREE): DivergeOutcome {
  return { ok: true, changed: true, plan: replanned(plan, tree), derivedRoot, staleDependents: [], replaced: [LATER], written: ['fresh-1'], cost: COST };
}

interface Pending {
  input: DivergeInput;
  hooks: ReplanHooks;
  finish(outcome: DivergeOutcome): void;
  fail(err: unknown): void;
}

interface Harness {
  session: WalkSession;
  target: string;
  repo: string;
  store: string;
  tree: string;
  adapters: WalkAdapters;
  /** every press of the engine, oldest first; finish one to land it */
  pending: Pending[];
  errors: string[];
  coreCalls(): number;
  views(): Array<WalkView | undefined>;
  view(): WalkView;
  /** every byte of the files AC11 names, and of `.repo-tour/build/` entire */
  bytes(): Record<string, string>;
  plan: PlanLike;
}

interface Options {
  progress?: (plan: PlanLike) => Progress;
  noReplanner?: boolean;
  replannerMissing?: boolean;
  noRequest?: boolean;
  /** the plan that is on disk, when not the fixture */
  plan?: PlanLike;
  savePlan?: Replanner['savePlan'];
  /** how the replanner loads: at once by default; a test holds it to cancel while it loads */
  replannerLoad?: (replanner: Replanner) => Promise<Replanner | undefined>;
  /** the dial core's load: at once and absent by default; a test holds it to keep the chain busy */
  core?: () => Promise<DialCore | undefined>;
  /** the global dial in request.json: automated by default */
  dial?: Dial;
  /** where the tree is in the store: `TREE` by default */
  treeName?: string;
  /** a test that navigates on purpose lets the editor move; by default a move is a failure */
  navigates?: boolean;
  git?: WalkAdapters['git'];
  tutorCore?: WalkAdapters['tutorCore'];
  tutorSettings?: WalkAdapters['tutorSettings'];
  /** files in the reference repository, written before the walk opens; it is empty by default */
  reference?: Record<string, string>;
}

/** Every file under `root` with its contents, except what is under `skip`. */
function snapshot(root: string, skip?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (skip !== undefined && full === skip) continue;
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function harness(options: Options = {}): Harness {
  const target = tempDir('rp-target-');
  const repo = tempDir('rp-repo-');
  const store = tempDir('rp-store-');
  const tree = path.join(store, options.treeName ?? TREE);
  fs.mkdirSync(tree, { recursive: true });
  for (const [rel, text] of Object.entries(options.reference ?? {})) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  const plan = options.plan ?? fixturePlan();
  const dir = buildDir(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 3)}\n`);
  saveProgress(target, options.progress?.(plan) ?? fixtureProgress(plan));
  if (options.noRequest !== true) {
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ idea: '', recreate: true, repo, target, dial: options.dial ?? 'automated', referenceRoot: repo }));
  }
  const pending: Pending[] = [];
  const errors: string[] = [];
  const views: Array<WalkView | undefined> = [];
  let coreCalls = 0;
  const replanner: Replanner = {
    diverge: (input, hooks) => new Promise((resolve, reject) => {
      pending.push({ input, hooks, finish: resolve, fail: reject });
    }),
    savePlan: options.savePlan ?? ((t, p, before) => { saveDivergedPlan(t, p, undefined, before); }),
  };
  const adapters: WalkAdapters = {
    setTree: (v) => { views.push(v); },
    setPanel: () => undefined,
    setStatus: () => undefined,
    revealEditor: () => { if (options.navigates !== true) assert.fail('a replan never moves the editor'); },
    clearEditor: () => undefined,
    openFile: () => undefined,
    fileExists: (p) => fs.existsSync(p),
    loadPlan,
    loadProgress,
    saveProgress,
    loadRequest: (t, p) => loadRequest(t, { plan: p, store }),
    reportError: (m) => { errors.push(m); },
    core: () => { coreCalls += 1; return options.core?.() ?? Promise.resolve(undefined); },
    readText: () => undefined,
    confirmOverwrite: () => Promise.resolve(false),
    git: options.git ?? (() => Promise.reject(new Error('no git here'))),
    ...(options.tutorCore === undefined ? {} : { tutorCore: options.tutorCore }),
    ...(options.tutorSettings === undefined ? {} : { tutorSettings: options.tutorSettings }),
    commitPerStep: () => false,
    ...(options.noReplanner === true ? {} : {
      replanner: () => options.replannerLoad?.(replanner) ?? Promise.resolve(options.replannerMissing === true ? undefined : replanner),
    }),
  };
  const session = WalkSession.open(target, adapters);
  opened.push(session);
  coreCalls = 0;
  views.length = 0;
  return {
    session, target, repo, store, tree, adapters, pending, errors, plan,
    coreCalls: () => coreCalls,
    views: () => views,
    view: () => { const v = session.getView(); assert.ok(v, 'the walk is showing a step'); return v; },
    bytes: () => snapshot(dir),
  };
}

/** What a real landing leaves in the tree: the code the plan says the model wrote, for D and for `fresh-1`. */
function holdCode(tree: string, files: string[] = ['src/parse.ts', 'src/api/fresh.ts']): void {
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.writeFileSync(path.join(tree, rel), `export const writtenByTheModel = ${JSON.stringify(rel)};\n`);
  }
}

/** Lets a press reach the engine: past `await replanner()`. */
async function reachedEngine(h: Harness, count = 1): Promise<Pending> {
  for (let i = 0; i < 50 && h.pending.length < count; i += 1) await new Promise((r) => { setImmediate(r); });
  const job = h.pending[count - 1];
  assert.ok(job, 'the press reached the engine');
  return job;
}

/** Lets every promise already in motion take its next steps. */
async function turns(count = 10): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((r) => { setImmediate(r); });
}

/** Finishes the press in flight with this outcome and waits for the walk to be done reacting. */
async function finish(h: Harness, job: Pending, outcome: DivergeOutcome): Promise<void> {
  job.finish(outcome);
  await h.session.settled();
}

const FAILED: DivergeOutcome = { ok: false, reason: 'the model said no', cost: COST };

suite('the press — it starts at once and writes nothing (T-22, AC6, AC11)', () => {
  test('the page says it is re-planning, and nothing on disk has moved', async () => {
    const h = harness();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    assert.deepEqual(h.view().replanning, { stepId: D, message: REPLAN_STARTING });
    const job = await reachedEngine(h);
    assert.deepEqual(h.bytes(), before, 'not the plan, not a version, not the request, not the progress');
    await finish(h, job, FAILED);
  });

  test('the engine is asked about the plan as it stands, with what the learner has walked', async () => {
    const h = harness({ progress: (p) => markDone(setCurrent(fixtureProgress(p), D), LATER) });
    h.session.choose(D, ANSWER);
    const { input } = await reachedEngine(h);
    assert.deepEqual(input.plan, h.plan);
    assert.equal(input.stepId, D);
    assert.equal(input.answer, ANSWER);
    assert.equal(input.referenceRoot, h.repo);
    assert.equal(input.derivedRoot, null, 'a plan that has not diverged has no tree');
    assert.deepEqual([...input.walked].sort(), [LATER, 'st-1-shape-src'].sort(), 'done, or before where they stand');
  });

  test('the engine reports as it goes, and each report changes the page', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.views().length = 0;
    job.hooks.onProgress('writing src/parse.ts…');
    assert.equal(h.view().replanning?.message, 'writing src/parse.ts…');
    assert.equal(h.views().length, 1, 'pushed to the surfaces');
    await finish(h, job, FAILED);
  });

  test('a press on the road already taken is refused as before, and starts nothing', async () => {
    const h = harness();
    h.session.choose(D, 'author');
    assert.equal(h.view().choiceNote, CHOICE_ALREADY_TAKEN);
    assert.equal(h.view().replanning, undefined);
    await h.session.settled();
    assert.equal(h.pending.length, 0);
  });

  test('the session\'s own ledger is the one the engine is given', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    const ledger = (h.session as unknown as { ledger: unknown }).ledger;
    assert.equal(job.hooks.ledger, ledger, 'so its cost is the walk\'s, and Cancel can reach it');
    await finish(h, job, FAILED);
  });
});

suite('it lands — the walk shows the new plan without a reload (T-22, AC3, AC4, AC8)', () => {
  test('the new plan is what the walk shows, and the learner stays on D', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.views().length = 0;
    await finish(h, job, landed(h.plan, h.tree));
    const view = h.view();
    assert.equal(view.step.id, D);
    assert.equal(view.replanning, undefined, 'the wait is over');
    assert.deepEqual(view.plan.steps.map((s) => s.id), replanned(h.plan).steps.map((s) => s.id));
    assert.equal(view.step.decision.chosen, ANSWER);
    assert.equal(optionsTable(view.step).on, optionsTable(view.step).keys.indexOf(ANSWER));
    assert.ok(h.views().length > 0, 'the surfaces were told');
  });

  test('the plan on disk is the new one, the old one is kept byte for byte, and the choice is recorded', async () => {
    const h = harness();
    const planFile = path.join(buildDir(h.target), 'plan.json');
    const old = fs.readFileSync(planFile, 'utf8');
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    assert.deepEqual(loadPlan(h.target), replanned(h.plan));
    assert.equal(fs.readFileSync(path.join(buildDir(h.target), 'versions', '1.json'), 'utf8'), old);
    assert.equal(loadProgress(h.target, replanned(h.plan)).steps[D]?.chosen, ANSWER);
    assert.equal(loadProgress(h.target, replanned(h.plan)).current, D);
  });

  test('the note says what changed and what it cost', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    // The walk's dial is automated: the learner's file is the one from before (a landing is not an arrival; code review N9).
    assert.equal(h.view().choiceNote, replanDoneText(1, true, COST, null, true));
    assert.match(h.view().choiceNote ?? '', /Your file is as you left it/);
    assert.match(h.view().choiceNote ?? '', /\$0\.0123/);
  });

  test('at a shape step the note does not claim the step\'s own code: a shape step has none', async () => {
    const SHAPE = 'st-1-shape-src';
    const ROAD = 'fold-into-root';
    const plan = fixturePlan();
    const shape = plan.steps.find((s) => s.id === SHAPE)!;
    shape.decision.options.push({ id: ROAD, label: 'Fold src into the root', consequence: 'One chapter fewer.', taken: false });
    const h = harness({ plan });
    h.session.choose(SHAPE, ROAD);
    const fresh: StepLike = { ...plan.steps.find((s) => s.id === LATER)!, id: 'fresh-1', kind: 'file', target: { file: 'src/api/fresh.ts' }, derivedFrom: SHAPE };
    const next: PlanLike = {
      ...plan,
      steps: [...plan.steps.filter((s) => s.id !== LATER), fresh]
        .map((s, i) => ({ ...s, ordinal: i + 1, ...(s.id === SHAPE ? { decision: { ...s.decision, chosen: ROAD } } : {}) })),
      divergences: [{ stepId: SHAPE, answer: ROAD, staleDependents: [], at: 't', tree: TREE }],
    };
    await finish(h, await reachedEngine(h), { ok: true, changed: true, plan: next, derivedRoot: h.tree, staleDependents: [], replaced: [LATER], written: ['fresh-1'], cost: COST });
    assert.deepEqual(loadPlan(h.target), next, 'discriminates: it landed');
    // The learner stands on D, not on the chapter step: the note names where the press was (code review SF3).
    assert.equal(h.view().choiceNote, replanDoneText(1, false, COST, 'step 1 (src)'), 'one later step follows the choice, and no code of the shape step\'s own');
    assert.doesNotMatch(h.view().choiceNote ?? '', /This step/, 'and it does not say "this step" on another step\'s page');
  });

  test('when nothing later needed re-planning the note does not say nothing depended on it: a walked step may have', () => {
    assert.match(replanDoneText(0, true, COST), /No later step needed re-planning/);
    assert.doesNotMatch(replanDoneText(0, true, COST), /depended/);
  });

  // The stopped re-review's NF3: a later step kept on the old road because a walked step stands on it is said, on D's own
  // page and on another, and the line never says no later step needed re-planning.
  test('a later step kept on the old road for a walked step is said, never "no later step needed re-planning" (NF3)', () => {
    assert.match(replanDoneText(0, true, COST, null, false, 1), /This step.s code now follows your choice\. A later step stays on the old road, because a step you have walked stands on it\./);
    assert.match(replanDoneText(2, true, COST, null, false, 3), /and 2 later steps now follow your choice\. 3 later steps stay on the old road, because steps you have walked stand on them\./);
    assert.match(replanDoneText(0, true, COST, 'step 2 (src/parse.ts)', false, 1), /stays on the old road, because a step you have walked stands on it; that step's page names it\./);
    for (const kept of [1, 2]) assert.doesNotMatch(replanDoneText(0, true, COST, null, false, kept), /No later step needed re-planning/);
    // The record path (MF1): nothing re-derived, and what stood on the old road was walked, or a walked step stands on it.
    assert.match(replanDoneText(0, false, COST, 'step 1 (src)', false, 1), /Nothing was re-planned: every later step that stood on the old road is one you have walked, or one a step you have walked stands on/);
    assert.doesNotMatch(replanDoneText(0, false, COST, 'step 1 (src)', false, 1), /is one you have already walked, so/);
  });

  test('the learner\'s folder is not touched: no file, no dial', async () => {
    const h = harness({ progress: (p) => setDial(setCurrent(fixtureProgress(p), D), D, 'automated') });
    fs.mkdirSync(path.join(h.target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(h.target, 'src/parse.ts'), 'the learner wrote this\n');
    const before = snapshot(h.target, path.join(h.target, '.repo-tour'));
    await h.session.settled();
    const entered = h.coreCalls();
    h.errors.length = 0; // arriving at the step reports the fake's missing core; that is not the landing
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    assert.deepEqual(snapshot(h.target, path.join(h.target, '.repo-tour')), before);
    assert.equal(h.coreCalls(), entered, 'landing is not an arrival: no dial was applied');
    assert.deepEqual(h.errors, []);
  });

  test('a reload shows the same plan, reading its own tree', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    const shown = h.view().plan;
    h.session.dispose();
    const again = WalkSession.open(h.target, h.adapters);
    assert.deepEqual(again.getView()?.plan, shown);
    assert.equal(again.getView()?.step.id, D);
    assert.equal(loadRequest(h.target, { plan: loadPlan(h.target), store: h.store })?.derivedRoot, fs.realpathSync(h.tree));
    again.dispose();
  });

  test('a second divergence is given the first one\'s tree, and stacks a second version', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    holdCode(h.tree);
    const afterFirst = fs.readFileSync(path.join(buildDir(h.target), 'plan.json'), 'utf8');
    h.session.choose(D, 'author');
    const second = await reachedEngine(h, 2);
    assert.equal(second.input.derivedRoot, h.tree, 'what was already re-derived is the starting point');
    assert.equal(second.input.answer, 'author', 'going back to the author\'s road is another re-plan');
    assert.deepEqual(second.input.plan, replanned(h.plan));
    const other = path.join(h.store, 'k/other');
    fs.mkdirSync(other, { recursive: true });
    await finish(h, second, landed(replanned(h.plan), other, 'k/other'));
    assert.equal(fs.readFileSync(path.join(buildDir(h.target), 'versions', '2.json'), 'utf8'), afterFirst);
  });

  test('what the session remembered about the old code at D is forgotten', async () => {
    const h = harness();
    const memory = h.session as unknown as { checks: Map<string, unknown>; prompted: Map<string, Set<string>> };
    memory.checks.set(D, { ok: true });
    memory.prompted.set(D, new Set(['/x']));
    memory.checks.set('st-1-shape-src', { ok: true });
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    assert.equal(memory.checks.has(D), false, 'a check against the old code says nothing about the new');
    assert.equal(memory.prompted.has(D), false, 'and the overwrite question is a new question');
    assert.equal(memory.checks.has('st-1-shape-src'), true, 'a step it did not reach keeps what it had');
  });

  test('a learner who walked on stays where they are, if that step is still there', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-3-symbol-handle');
    await finish(h, job, landed(h.plan, h.tree));
    assert.equal(h.view().step.id, 'st-3-symbol-handle');
    assert.match(h.view().choiceNote ?? '', /^Re-planned/, 'and they are told on the page they are on');
  });

  test('what the page said about D\'s old code goes with it: in manual mode, the shape of the file it replaced', async () => {
    const SIGNATURE = 'export function tokenize(text: string): string[] {';
    const h = harness({
      progress: (p) => setDial(fixtureProgress(p), D, 'manual'),
      reference: { 'src/parse.ts': `${SIGNATURE}\n${'  return [];\n'.repeat(11)}}\n` },
    });
    await h.session.settled();
    assert.deepEqual(h.view().shape?.signatures, [SIGNATURE], 'discriminates: in manual mode D shows the shape of its file');
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    assert.equal(h.view().step.id, D, 'discriminates: the learner is still on D');
    assert.equal(h.view().shape, undefined, 'the shape of a file D no longer has is not shown over the code that replaced it');
  });

  test('a learner standing on a step that is gone is brought back to D', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo(LATER);
    await finish(h, job, landed(h.plan, h.tree));
    assert.equal(h.view().step.id, D);
  });
});

suite('nothing follows — a choice that changes no later step (T-22)', () => {
  test('recorded as T-21 did, and it says the rest of the walk stands', async () => {
    const h = harness();
    const planBytes = fs.readFileSync(path.join(buildDir(h.target), 'plan.json'), 'utf8');
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), { ok: true, changed: false, staleDependents: [], cost: COST });
    assert.equal(h.view().step.decision.chosen, ANSWER);
    assert.equal(h.view().choiceNote, REPLAN_NOTHING_FOLLOWS);
    assert.equal(h.view().replanning, undefined);
    assert.equal(loadProgress(h.target, h.plan).steps[D]?.chosen, ANSWER);
    assert.equal(fs.readFileSync(path.join(buildDir(h.target), 'plan.json'), 'utf8'), planBytes, 'the plan is not rewritten');
    assert.equal(fs.existsSync(path.join(buildDir(h.target), 'versions')), false, 'and there is no version');
  });
});

suite('refused — every ending says why and leaves everything as it was (T-22, AC10, AC11)', () => {
  test('the engine refuses: the reason is on the page, the bytes have not moved, and the road is still pressable', async () => {
    const h = harness();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), FAILED);
    assert.equal(h.view().choiceNote, replanRefusedText('the model said no'));
    assert.equal(h.view().replanning, undefined);
    assert.deepEqual(h.bytes(), before);
    assert.equal(optionsTable(h.view().step).choosable[optionsTable(h.view().step).keys.indexOf(ANSWER)], true);
  });

  test('a second refusal in the same words says it is the second', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), FAILED);
    const first = h.view().choiceNote;
    h.session.choose(D, ANSWER);
    assert.equal(h.view().choiceNote, undefined, 'while it runs again, the old refusal is not on the page');
    await finish(h, await reachedEngine(h, 2), FAILED);
    assert.notEqual(h.view().choiceNote, first, 'two identical frames would be a press that changed nothing');
    assert.match(h.view().choiceNote ?? '', /Tried 2 times\.$/);
  });

  test('a press still works after a refusal, and lands', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), FAILED);
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h, 2), landed(h.plan, h.tree));
    assert.deepEqual(loadPlan(h.target), replanned(h.plan));
  });

  test('an engine that throws anyway is a refusal, not a stuck page', async () => {
    const h = harness();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    job.fail(new Error('kaboom'));
    await h.session.settled();
    assert.equal(h.view().choiceNote, replanRefusedText('kaboom'));
    assert.equal(h.view().replanning, undefined);
    assert.deepEqual(h.bytes(), before);
  });

  test('no replanner wired, or one that cannot load: it says so, and nothing is recorded', async () => {
    for (const options of [{ noReplanner: true }, { replannerMissing: true }]) {
      const h = harness(options);
      const before = h.bytes();
      h.session.choose(D, ANSWER);
      await h.session.settled();
      assert.equal(h.view().choiceNote, REPLAN_UNAVAILABLE);
      assert.equal(h.view().replanning, undefined);
      assert.deepEqual(h.bytes(), before);
    }
  });

  test('a folder with no reference: it says so, and nothing is recorded', async () => {
    const h = harness({ noRequest: true });
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    await h.session.settled();
    assert.equal(h.view().choiceNote, REPLAN_NO_REFERENCE);
    assert.equal(h.pending.length, 0);
    assert.deepEqual(h.bytes(), before);
  });

  test('the new plan cannot be saved: it says so, and the walk stays on the plan it had', async () => {
    const h = harness({ savePlan: () => { throw new Error('ENOSPC'); } });
    const progressBefore = fs.readFileSync(path.join(buildDir(h.target), 'progress.json'), 'utf8');
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    assert.equal(h.view().choiceNote, replanRefusedText('the new plan could not be saved: ENOSPC'));
    assert.deepEqual(h.view().plan.steps.map((s) => s.id), h.plan.steps.map((s) => s.id));
    assert.equal(fs.readFileSync(path.join(buildDir(h.target), 'progress.json'), 'utf8'), progressBefore, 'no choice is recorded for a plan that did not land');
    assert.equal(h.view().replanning, undefined);
  });
});

suite('cancel — it stops, and says what that cost (T-22, AC6, AC11)', () => {
  test('a cancel says so, moves no byte, and a late result is ignored', async () => {
    const h = harness();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.cancelReplan();
    assert.equal(h.view().replanning, undefined);
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_UNSENT);
    assert.equal(job.hooks.isCancelled(), true, 'the engine sees it before its next question');
    await finish(h, job, landed(h.plan, h.tree));
    assert.deepEqual(h.bytes(), before, 'what comes back after a cancel belongs to nobody');
    assert.deepEqual(h.view().plan.steps.map((s) => s.id), h.plan.steps.map((s) => s.id));
  });

  test('a cancel while a question is with the model says that it will still be billed', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    // A question still with the model, which ends when this test does. One that never ends holds
    // its deadline open (a deadline is never `unref`ed: `src/tutor/ask.ts`), and the test process
    // with it, for the whole minute.
    let end: (() => void) | undefined;
    const running = (): Promise<LlmReply> => new Promise((resolve) => {
      end = () => { resolve({ text: 'too late', inputTokens: 0, outputTokens: 0, usd: 0, metered: false }); };
    });
    const core = { availability: () => Promise.resolve({ ok: true as const }), resolveTutorChoice: (_: unknown, build: unknown) => build, resolveChoice: (c: unknown) => c, runLlm: running };
    const ticket = job.hooks.ledger.open('derive:diverge:x');
    ticket.sendPrompt({ core, provider: 'p', model: 'm', timeoutMs: 60_000, run: running } as never, 'a question');
    assert.equal(ticket.phase, 'sending');
    h.session.cancelReplan();
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_BILLED);
    assert.equal(ticket.abandoned, true);
    await turns();
    assert.ok(end, 'discriminates: the question really went to the model');
    end();
    await finish(h, job, FAILED);
  });

  test('a cancel stops the re-plan\'s questions and leaves a question to the tutor alone', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    const derive = job.hooks.ledger.open('derive:diverge:x');
    const tutor = job.hooks.ledger.open(D);
    h.session.cancelReplan();
    assert.equal(derive.abandoned, true);
    assert.equal(tutor.abandoned, false);
    tutor.abandon();
    await finish(h, job, FAILED);
  });

  test('a cancel when nothing is running does nothing at all', async () => {
    const h = harness();
    h.views().length = 0;
    h.session.cancelReplan();
    assert.equal(h.views().length, 0);
    assert.equal(h.view().choiceNote, undefined);
    await h.session.settled();
  });

  test('after a cancel the road is still there to press', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    await reachedEngine(h);
    h.session.cancelReplan();
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h, 2), landed(h.plan, h.tree));
    assert.deepEqual(loadPlan(h.target), replanned(h.plan));
  });
});

// The two gaps a cancel can fall into, each guarded by one line of `session.ts` (the sweep's
// `load-guard-removed` and `land-guard-removed`): before the engine is reached, and after it has
// finished but before its landing has had its turn on the chain.
suite('cancel — in the gaps before the engine and before the landing (T-22, AC11)', () => {
  test('a cancel while the replanner is still loading: the engine is never asked, and nothing moves', async () => {
    const loads: Array<() => void> = [];
    const h = harness({ replannerLoad: (replanner) => new Promise((resolve) => { loads.push(() => { resolve(replanner); }); }) });
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    assert.equal(loads.length, 1, 'discriminates: the press is waiting on the replanner');
    h.session.cancelReplan();
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_UNSENT);
    loads[0]!();
    await turns();
    await h.session.settled();
    assert.equal(h.pending.length, 0, 'a press cancelled before the engine was reached never reaches it: the engine reads the whole repository before its first question');
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_UNSENT, 'and the page still says it was cancelled');
    assert.deepEqual(h.bytes(), before);
  });

  test('a cancel while the replanner is still loading, then a second press: only the second reaches the engine, and it lands', async () => {
    const loads: Array<() => void> = [];
    const h = harness({ replannerLoad: (replanner) => new Promise((resolve) => { loads.push(() => { resolve(replanner); }); }) });
    h.session.choose(D, ANSWER);
    h.session.cancelReplan();
    h.session.choose(D, ANSWER);
    assert.equal(loads.length, 2, 'discriminates: both presses are waiting on the replanner');
    loads[0]!();
    loads[1]!();
    const job = await reachedEngine(h);
    await turns();
    assert.equal(h.pending.length, 1, 'the cancelled press is not one of them');
    assert.equal(job.hooks.isCancelled(), false, 'the press the engine hears about is the live one');
    await finish(h, job, landed(h.plan, h.tree));
    assert.deepEqual(loadPlan(h.target), replanned(h.plan));
  });

  test('a cancel after the engine has finished, while its landing waits its turn: it does not land, and nothing moves', async () => {
    let holding = false;
    const releases: Array<() => void> = [];
    const h = harness({ core: () => (holding ? new Promise((resolve) => { releases.push(() => { resolve(undefined); }); }) : Promise.resolve(undefined)) });
    await h.session.settled();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    // Something else holds the chain: a check, waiting on the core (an Overwrite prompt does the same).
    holding = true;
    h.session.runCheck();
    await turns();
    assert.equal(releases.length, 1, 'discriminates: the check holds the chain');
    job.finish(landed(h.plan, h.tree));
    await turns();
    assert.ok(h.view().replanning, 'discriminates: the engine has finished and the press has not landed yet');
    h.session.cancelReplan();
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_UNSENT);
    releases[0]!();
    await h.session.settled();
    assert.deepEqual(h.bytes(), before, 'a press cancelled before it landed does not land: not the plan, not a version, not the choice');
    assert.deepEqual(h.view().plan.steps.map((s) => s.id), h.plan.steps.map((s) => s.id), 'and the walk shows the plan it had');
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_UNSENT, 'and the page still says it was cancelled');
  });
});

suite('while one is running (T-22, AC6)', () => {
  test('a second press is refused in words, and counted, and the engine is not asked again', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.choose(D, ANSWER);
    assert.equal(h.view().choiceNote, CHOICE_ALREADY_REPLANNING);
    h.session.choose(D, ANSWER);
    assert.equal(h.view().choiceNote, `${CHOICE_ALREADY_REPLANNING} Tried 2 times.`);
    assert.deepEqual(h.view().replanning, { stepId: D, message: REPLAN_STARTING }, 'the wait is still on the page');
    await new Promise((r) => { setImmediate(r); });
    assert.equal(h.pending.length, 1);
    await finish(h, job, FAILED);
  });

  test('it is shown on whichever step the learner is on', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-3-symbol-handle');
    assert.deepEqual(h.view().replanning, { stepId: D, message: REPLAN_STARTING });
    await finish(h, job, FAILED);
  });

  test('a refusal is said on the step the learner walked on to, where the running line was', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-3-symbol-handle');
    await finish(h, job, FAILED);
    assert.equal(h.view().step.id, 'st-3-symbol-handle', 'discriminates: the learner is not on D');
    assert.equal(h.view().replanning, undefined);
    assert.equal(h.view().choiceNote, replanRefusedText('the model said no'), 'the running line is gone from this page, so what became of the press is said here');
  });

  test('a cancel is said on the step it was pressed on', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-3-symbol-handle');
    h.session.cancelReplan();
    assert.equal(h.view().step.id, 'st-3-symbol-handle', 'discriminates: the learner is not on D');
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_UNSENT, 'the Cancel was on this page, so its answer is too');
    await finish(h, job, FAILED);
  });

  test('it is not reported as a tutor question somewhere else', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    const ticket = job.hooks.ledger.open('derive:diverge:x');
    h.session.goTo('st-3-symbol-handle');
    assert.equal(h.view().tutor?.elsewhere, undefined);
    ticket.abandon();
    await finish(h, job, FAILED);
  });

  test('a session closed while it runs writes nothing, and says nothing', async () => {
    const h = harness();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.dispose();
    assert.equal(job.hooks.isCancelled(), true);
    h.views().length = 0;
    job.finish(landed(h.plan, h.tree));
    await new Promise((r) => { setImmediate(r); });
    await h.session.settled();
    assert.deepEqual(h.bytes(), before);
    assert.equal(h.views().length, 0);
  });

  test('settled waits for the re-plan to land', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    let settled = false;
    void h.session.settled().then(() => { settled = true; });
    await new Promise((r) => { setImmediate(r); });
    assert.equal(settled, false, 'still running');
    job.finish(FAILED);
    await h.session.settled();
    assert.equal(h.view().replanning, undefined);
  });
});

// T-22's code review, SF10: AC5 rested on a source scan, and a reader that reached the repository by a
// destructured read passed the whole suite (its M33-M35). Each reader is pinned here by what it DOES
// with a landed plan whose D reads differently from the tree and from the repository. MF3 and SF5: a
// step reads the tree only when it says it is re-derived, and never the author's file in its place.
suite('the one reader, by what each reader does on a landed plan (T-22, AC5)', () => {
  let dialCore: DialCore;
  let realTutor: TutorCore;
  suiteSetup(async () => {
    const loaded = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
    assert.ok(loaded.found, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
    dialCore = dialCoreFor(loaded.loaded);
    realTutor = tutorCoreFor(loaded.loaded);
  });

  const lines = (first: string, body: string): string => `${first}\n${body}\n${'// …\n'.repeat(9)}}\n`;
  const AUTHORS = lines('export function tokenize(line: string): string[] {', "  return line.split(' ');");
  const MODELS = lines('export function scanByHand(line: string): string[] {', '  return [line];');
  const NAMED_TREE = 'k/the-derived-tree-0f3a';

  /** A walk that landed a re-plan at D: D's re-derived file in the tree, the author's in the repository. */
  async function landedWalk(extra: Options = {}): Promise<Harness> {
    const h = harness({ dial: 'manual', reference: { 'src/parse.ts': AUTHORS }, core: () => Promise.resolve(dialCore), treeName: NAMED_TREE, navigates: true, progress: (p) => setDial(fixtureProgress(p), D, 'manual'), ...extra });
    fs.mkdirSync(path.join(h.tree, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(h.tree, 'src', 'parse.ts'), MODELS);
    fs.writeFileSync(path.join(h.tree, 'src', 'api', 'fresh.ts'), 'export const fresh = 1;\n');
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree, NAMED_TREE));
    assert.equal(h.view().step.id, D, 'discriminates: the learner is on D, which the re-plan re-derived');
    return h;
  }

  test('the dial: manual mode outlines D from the tree, not from the repository', async () => {
    const h = await landedWalk();
    h.session.goTo('st-1-shape-src');
    h.session.goTo(D);
    await h.session.settled();
    assert.deepEqual(h.view().shape?.signatures, ['export function scanByHand(line: string): string[] {'], 'what to write is the re-derived file');
  });

  test('the check: D is compared with the tree\'s file', async () => {
    const h = await landedWalk();
    fs.mkdirSync(path.join(h.target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(h.target, 'src', 'parse.ts'), MODELS);
    h.session.runCheck();
    await h.session.settled();
    assert.equal(h.view().check?.report.ok, true, 'the learner wrote exactly the re-derived file, and the check compared it with that one');
  });

  test('the tutor: a question at D diffs the learner\'s file against the tree\'s, and names the project after the repository', async () => {
    const diffs: string[] = [];
    const prompts: string[] = [];
    const git: WalkAdapters['git'] = (args, cwd) => {
      if (args[0] === 'diff' && cwd !== undefined) diffs.push(path.resolve(cwd, args[args.length - 2]!));
      return Promise.reject(new Error('no git here'));
    };
    const h = await landedWalk({
      git,
      tutorCore: () => Promise.resolve({ ...realTutor, availability: () => Promise.resolve({ ok: true, detail: 'a stand-in' }), runLlm: (prompt: string) => { prompts.push(prompt); return Promise.resolve({ text: 'an answer', inputTokens: 1, outputTokens: 1, usd: 0, metered: false }); } }),
      tutorSettings: () => ({ provider: 'claude', model: 'm', timeoutMs: 5_000 }),
    });
    fs.mkdirSync(path.join(h.target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(h.target, 'src', 'parse.ts'), AUTHORS);
    h.session.ask('Why is it written this way?');
    await h.session.settled();
    assert.deepEqual(diffs, [path.join(h.tree, 'src', 'parse.ts')], 'the reference the tutor reads is the re-derived file');
    assert.equal(prompts.length, 1, 'discriminates: the question reached the stand-in model');
    assert.ok(prompts[0]!.includes(path.basename(h.repo)), `the project is named after the repository (code review N2): ${path.basename(h.repo)}`);
    assert.ok(!prompts[0]!.includes(path.basename(h.tree)), 'not after the tree a re-derived step is read from');
  });

  test('a reload whose tree is gone: D says its code is missing, and nothing reads the author\'s file in its place (SF5)', async () => {
    const h = await landedWalk();
    fs.rmSync(h.tree, { recursive: true, force: true });
    h.session.dispose();
    const again = WalkSession.open(h.target, h.adapters);
    try {
      again.goTo('st-1-shape-src');
      again.goTo(D);
      await again.settled();
      const v = again.getView();
      assert.ok(v, 'the walk opened');
      assert.equal(v.step.id, D);
      assert.equal(v.derivedCodeMissing, true, 'the page says the re-derived code is missing');
      assert.equal(v.shape, undefined, 'and manual mode does not outline the author\'s file under the model\'s step');
      assert.equal(v.writeNote, DERIVED_CODE_MISSING_MESSAGE);
      again.runCheck();
      await again.settled();
      assert.equal(again.getView()?.check, undefined, 'no verdict is reached against the author\'s file');
      assert.equal(again.getView()?.writeNote, DERIVED_CODE_MISSING_MESSAGE, 'the check says why');
    } finally {
      again.dispose();
    }
  });
});

// T-22's code review: what became of a press, said where it is true.
suite('what a landing says, and what it leaves alone (T-22; code review MF1, SF3, SF6, SF9, N4, N12)', () => {
  test('on another step\'s page the note names the step the press was at: that step\'s code did not change (SF3)', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-1-shape-src');
    await finish(h, job, landed(h.plan, h.tree));
    assert.equal(h.view().step.id, 'st-1-shape-src', 'discriminates: the learner is not on D');
    assert.match(h.view().choiceNote ?? '', /^Re-planned from your choice at step 2 \(src\/parse\.ts\)\. Its code and 1 later step now follow your choice\./);
    assert.doesNotMatch(h.view().choiceNote ?? '', /This step/);
  });

  test('a chapter whose followers were all walked: recorded, nothing re-planned, and said so (MF1)', async () => {
    const h = harness();
    const SHAPE = 'st-1-shape-src';
    h.session.choose(D, ANSWER); // D is the file in the chapter; the press here only gives the walk a plan of its own to record on
    await finish(h, await reachedEngine(h), FAILED);
    const plan = h.plan;
    const recorded: PlanLike = { ...plan, steps: plan.steps.map((s) => (s.id === SHAPE ? { ...s, decision: { ...s.decision, chosen: 'author' } } : s)), divergences: [{ stepId: SHAPE, answer: 'author', staleDependents: [D], at: 't', replanned: false }] };
    const h2 = harness({ plan: { ...plan, steps: plan.steps.map((s) => (s.id === SHAPE ? { ...s, decision: { ...s.decision, options: [...s.decision.options, { id: 'flat', label: 'One folder', consequence: 'c', taken: false }] } } : s)) } });
    h2.session.choose(SHAPE, 'flat');
    await finish(h2, await reachedEngine(h2), { ok: true, changed: true, plan: recorded, derivedRoot: null, staleDependents: [D], replaced: [], written: [], cost: { ...COST, calls: 0, usd: 0 } });
    assert.equal(h2.view().choiceNote, replanDoneText(0, false, { ...COST, calls: 0, usd: 0 }, 'step 1 (src)'));
    assert.match(h2.view().choiceNote ?? '', /nothing was re-planned/);
    assert.doesNotMatch(h2.view().choiceNote ?? '', /^Re-planned/, 'nothing was re-planned, so it does not say it was');
  });

  test('a step the learner finished while it re-planned, which the new plan would replace: refused, and named (SF6)', async () => {
    const h = harness();
    const before = h.bytes();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo(LATER);
    h.session.markDone(LATER);
    await turns(); // not `settled()`: that waits for the re-plan, which this test is holding open
    const finishedBytes = h.bytes();
    assert.notDeepEqual(finishedBytes, before, 'discriminates: the step was finished, on disk');
    await finish(h, job, landed(h.plan, h.tree));
    assert.match(h.view().choiceNote ?? '', /you finished step 4 \(src\/api\/render\.ts\) while it re-planned/);
    assert.ok(h.view().plan.steps.some((s) => s.id === LATER), 'the step the learner finished is still in the walk');
    assert.deepEqual(h.bytes(), finishedBytes, 'and nothing else moved: not the plan, not a version');
  });

  test('a landing leaves an unrelated step\'s "What to write" alone; only D\'s own notes go (SF9)', async () => {
    const h = harness({ progress: (p) => setDial(fixtureProgress(p), 'st-1-shape-src', 'manual'), navigates: true });
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-1-shape-src');
    await turns();
    const note = (h.session as unknown as { note?: { stepId: string; text: string } }).note;
    (h.session as unknown as { note: { stepId: string; text: string } }).note = { stepId: 'st-1-shape-src', text: 'a note about this step' };
    await finish(h, job, landed(h.plan, h.tree));
    assert.equal(h.view().writeNote, 'a note about this step', `the learner's page on another step keeps its own note (it had ${JSON.stringify(note)})`);
  });

  test('a re-plan\'s question in flight is not "with the tutor" (N4)', async () => {
    const h = harness();
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    let end: (() => void) | undefined;
    const running = (): Promise<LlmReply> => new Promise((resolve) => { end = () => { resolve({ text: 'x', inputTokens: 0, outputTokens: 0, usd: 0, metered: false }); }; });
    const core = { availability: () => Promise.resolve({ ok: true as const }), resolveTutorChoice: (_: unknown, build: unknown) => build, resolveChoice: (c: unknown) => c, runLlm: running };
    const ticket = job.hooks.ledger.open('derive:diverge:x');
    ticket.sendPrompt({ core, provider: 'p', model: 'm', timeoutMs: 60_000, run: running } as never, 'a question');
    await turns();
    assert.ok(end, 'discriminates: the question went out');
    // A repaint while it is out: the view is drawn when the page is, so a stale one would prove nothing.
    job.hooks.onProgress('writing src/parse.ts…');
    assert.equal((job.hooks.ledger.spend()).sending, 1, 'discriminates: the ledger has it in flight');
    assert.equal(h.view().tutor?.spend?.sending ?? 0, 0, 'the tutor has nothing in flight');
    end();
    await finish(h, job, FAILED);
  });

  test('D\'s conversation says its code was re-derived, and later questions are not sent the history about the author\'s code (N12)', async () => {
    const h = harness({ progress: (p) => ({ ...fixtureProgress(p), steps: { ...fixtureProgress(p).steps, [D]: { ...fixtureProgress(p).steps[D]!, transcript: [{ role: 'user', content: 'why a tokenizer?' }, { role: 'assistant', content: 'because the author…' }] } } }) });
    h.session.choose(D, ANSWER);
    await finish(h, await reachedEngine(h), landed(h.plan, h.tree));
    const progress = loadProgress(h.target, loadPlan(h.target));
    const turnsAtD = getTranscript(progress, D);
    assert.equal(turnsAtD.at(-1)?.content, REPLANNED_TRANSCRIPT_NOTE, 'the line is in the conversation, where the learner reads it');
    assert.deepEqual(sentTurns(progress, D), [], 'and nothing from before it is sent as history about the new code');
  });
});

// The stopped re-review of the review fixes (NF4, NF5) and what follows from it: a press after an earlier
// one at the same step, and a step a press writes under the id of one it replaced (a step's id is a hash of
// its kind, path, question and labels, so a model that keeps those mints the same id; T-17's F9).
suite('a second press at the same step, and a step that comes back under its old id (T-22 re-review)', () => {
  const SHAPE = 'st-1-shape-src';
  /** The fixture after one press at D: D re-derived, `fresh-1` written in place of the last step. */
  const once = (): PlanLike => replanned(fixturePlan());
  const fresh1 = (plan: PlanLike): StepLike => plan.steps.find((s) => s.id === 'fresh-1')!;
  const onD = (plan: PlanLike): Progress => setCurrent(markDone(fixtureProgress(plan), 'st-1-shape-src'), D);
  const outcome = (plan: PlanLike, replaced: string[], written: string[], staleDependents: string[] = []): DivergeOutcome =>
    ({ ok: true, changed: true, plan, derivedRoot: null, staleDependents, replaced, written, cost: COST });

  test('a record on a chapter pressed before does not say it re-planned the steps the earlier press wrote (NF5)', async () => {
    const plan = fixturePlan();
    const shape = plan.steps.find((s) => s.id === SHAPE)!;
    shape.decision.options = [...shape.decision.options, { id: 'flat', label: 'One folder', consequence: 'c', taken: false }];
    shape.decision.chosen = 'flat'; // the earlier press's road
    const earlier: StepLike = { ...plan.steps.find((s) => s.id === D)!, id: 'fresh-s', ordinal: 5, target: { file: 'src/fresh.ts' }, derivedFrom: SHAPE, dependsOn: [SHAPE] };
    const before: PlanLike = { ...plan, steps: [...plan.steps, earlier], divergences: [{ stepId: SHAPE, answer: 'flat', staleDependents: [], at: 't', replanned: false, tree: TREE }] };
    const allWalked = (p: PlanLike): Progress => setCurrent(p.steps.reduce((acc, s) => markDone(acc, s.id), fixtureProgress(p)), SHAPE);
    const h = harness({ plan: before, progress: allWalked });
    holdCode(h.tree, ['src/parse.ts', 'src/api/fresh.ts', 'src/fresh.ts']);
    h.session.choose(SHAPE, 'author');
    const recorded: PlanLike = {
      ...before,
      steps: before.steps.map((s) => (s.id === SHAPE ? { ...s, decision: { ...s.decision, chosen: 'author' } } : s)),
      divergences: [...(before['divergences'] as unknown[]), { stepId: SHAPE, answer: 'author', staleDependents: [D, 'fresh-s'], at: 't2', replanned: false }],
    };
    await finish(h, await reachedEngine(h), outcome(recorded, [], [], [D, 'fresh-s']));
    const note = h.view().choiceNote ?? '';
    assert.doesNotMatch(note, /^Re-planned/, `nothing was re-planned, and the step the earlier press wrote is not this press's: "${note}"`);
    assert.match(note, /^Your choice is recorded\./);
  });

  test('a second re-plan counts the steps it wrote, not the ones an earlier press wrote and the learner walked (NF5)', async () => {
    const first = once();
    const h = harness({ plan: first, progress: (p) => markDone(onD(p), 'fresh-1') });
    holdCode(h.tree, ['src/parse.ts', 'src/api/fresh.ts', 'src/fresh.ts']);
    h.session.choose(D, 'author');
    const second: PlanLike = {
      ...first,
      steps: [
        ...first.steps.filter((s) => s.id !== 'st-3-symbol-handle').map((s) => (s.id === D ? { ...s, decision: { ...s.decision, chosen: 'author' } } : s)),
        { ...fresh1(first), id: 'fresh-2', target: { file: 'src/api/fresh2.ts' } },
      ].map((s, i) => ({ ...s, ordinal: i + 1 })),
      divergences: [...(first['divergences'] as unknown[]), { stepId: D, answer: 'author', staleDependents: [], at: 't2', tree: TREE }],
    };
    await finish(h, await reachedEngine(h), outcome(second, ['st-3-symbol-handle'], ['fresh-2']));
    const note = h.view().choiceNote ?? '';
    assert.match(note, /^Re-planned\. This step’s code and 1 later step now follow your choice\./, `only fresh-2 is this press's: "${note}"`);
  });

  test('a step the learner finished while it re-planned, written again under its own id: refused, and named (NF4, SF6)', async () => {
    const first = once();
    const h = harness({ plan: first, progress: onD, navigates: true });
    holdCode(h.tree, ['src/parse.ts', 'src/api/fresh.ts', 'src/fresh.ts']);
    h.session.choose(D, 'author');
    const job = await reachedEngine(h);
    h.session.goTo('fresh-1');
    h.session.markDone('fresh-1');
    await turns();
    const finishedBytes = h.bytes();
    const again: PlanLike = {
      ...first,
      steps: first.steps.map((s) => (s.id === D ? { ...s, decision: { ...s.decision, chosen: 'author' } } : s.id === 'fresh-1' ? { ...s, scaffold: { loadBearing: [{ startLine: 1, endLine: 3 }], boilerplate: [] } } : s)),
      divergences: [...(first['divergences'] as unknown[]), { stepId: D, answer: 'author', staleDependents: [], at: 't2', tree: TREE }],
    };
    await finish(h, job, outcome(again, ['fresh-1'], ['fresh-1']));
    assert.match(h.view().choiceNote ?? '', /you finished step 4 \(src\/api\/fresh\.ts\) while it re-planned/, `the finished step's code was replaced; the page says ${JSON.stringify(h.view().choiceNote)}`);
    assert.deepEqual(h.bytes(), finishedBytes, 'and nothing moved: not the plan, not a version');
  });

  test('a step written again under its own id starts again: no tick, no verdict, no choice, and its conversation is cut (NF4)', async () => {
    const first = once();
    const other = fresh1(first).decision.options[1]!.id;
    const h = harness({
      plan: first,
      progress: (p) => {
        const base = onD(p);
        return { ...base, steps: { ...base.steps, 'fresh-1': { status: 'pending', check: { ok: false, at: 't' }, chosen: other, transcript: [{ role: 'user', content: 'why this?' }, { role: 'assistant', content: 'because of the earlier code' }] } } };
      },
    });
    holdCode(h.tree, ['src/parse.ts', 'src/api/fresh.ts', 'src/fresh.ts']);
    h.session.choose(D, 'author');
    const again: PlanLike = {
      ...first,
      steps: first.steps.map((s) => (s.id === D ? { ...s, decision: { ...s.decision, chosen: 'author' } } : s)),
      divergences: [...(first['divergences'] as unknown[]), { stepId: D, answer: 'author', staleDependents: [], at: 't2', tree: TREE }],
    };
    await finish(h, await reachedEngine(h), outcome(again, ['fresh-1'], ['fresh-1']));
    const progress = loadProgress(h.target, loadPlan(h.target));
    const entry = progress.steps['fresh-1'];
    assert.equal(entry?.check, undefined, `the verdict was about the code the press replaced: ${JSON.stringify(entry)}`);
    assert.equal(entry?.chosen, undefined, 'and so was the choice made there');
    assert.notEqual(entry?.status, 'done');
    assert.deepEqual(sentTurns(progress, 'fresh-1'), [], 'nothing asked about the replaced code is sent as history');
    assert.match(String(getTranscript(progress, 'fresh-1').at(-1)?.content), /earlier version/, 'and the conversation says why');
  });

  test('a second press at D does not tell D\'s conversation its earlier code was the author\'s (N12, after a first press)', async () => {
    const first = once();
    const h = harness({
      plan: first,
      progress: (p) => {
        const base = onD(p);
        return { ...base, steps: { ...base.steps, [D]: { ...base.steps[D]!, transcript: [{ role: 'user', content: 'why inline?' }, { role: 'assistant', content: 'because the model wrote it so' }] } } };
      },
    });
    holdCode(h.tree, ['src/parse.ts', 'src/api/fresh.ts', 'src/fresh.ts']);
    h.session.choose(D, 'author');
    const again: PlanLike = {
      ...first,
      steps: first.steps.map((s) => (s.id === D ? { ...s, decision: { ...s.decision, chosen: 'author' } } : s)),
      divergences: [...(first['divergences'] as unknown[]), { stepId: D, answer: 'author', staleDependents: [], at: 't2', tree: TREE }],
    };
    await finish(h, await reachedEngine(h), outcome(again, [], []));
    const progress = loadProgress(h.target, loadPlan(h.target));
    const last = String(getTranscript(progress, D).at(-1)?.content);
    assert.doesNotMatch(last, /author/, `D's code before this press was the model's: "${last}"`);
    assert.deepEqual(sentTurns(progress, D), [], 'and the history is still cut');
  });
});

// The stopped re-review (NF7, NF8): the landing meets a tutor question in flight, and a press meets a plan
// whose earlier re-derived code cannot be found.
suite('what a landing meets: a question in flight, a tree that is gone (T-22 re-review)', () => {
  let realTutor: TutorCore;
  let dialCore: DialCore;
  suiteSetup(async () => {
    const loaded = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
    assert.ok(loaded.found, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
    realTutor = tutorCoreFor(loaded.loaded);
    dialCore = dialCoreFor(loaded.loaded);
  });

  // The re-review of the fixes, R5: SF6 refuses a landing that would replace work the learner finished while it
  // re-planned. In automated mode the dial marks a step done when it writes the step's file on arrival, so moving
  // on with Next while the re-plan ran stopped a landing the learner had paid for, over work they never did.
  test('a step the automated dial completed on arrival while it re-planned does not stop the landing (R5)', async () => {
    const plan = fixturePlan();
    plan.steps = plan.steps.map((s) => (s.id === 'st-3-symbol-handle' ? { ...s, kind: 'file' as const, target: { file: 'src/api/routes.ts' } } : s));
    const h = harness({
      plan, dial: 'automated', navigates: true, core: () => Promise.resolve(dialCore),
      reference: { 'src/api/routes.ts': 'export function handle(body: string): number {\n  return body.length;\n}\n' },
      progress: (p) => setCurrent(markDone(fixtureProgress(p), 'st-1-shape-src'), D),
    });
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    h.session.goTo('st-3-symbol-handle');
    for (let i = 0; i < 200 && loadProgress(h.target, loadPlan(h.target)).steps['st-3-symbol-handle']?.status !== 'done'; i += 1) await turns(1);
    assert.equal(loadProgress(h.target, loadPlan(h.target)).steps['st-3-symbol-handle']?.status, 'done', 'discriminates: the dial wrote the file and completed the step on arrival');
    const next: PlanLike = {
      ...plan,
      steps: plan.steps.filter((s) => s.id !== 'st-3-symbol-handle').map((s) => (s.id === D ? { ...s, derivedFrom: D, decision: { ...s.decision, chosen: ANSWER } } : s))
        .concat([{ ...plan.steps.find((s) => s.id === 'st-3-symbol-handle')!, id: 'fresh-routes', derivedFrom: D }]).map((s, i) => ({ ...s, ordinal: i + 1 })),
      divergences: [{ stepId: D, answer: ANSWER, staleDependents: [], at: 't', tree: TREE }],
    };
    await finish(h, job, { ok: true, changed: true, plan: next, derivedRoot: h.tree, staleDependents: [], replaced: ['st-3-symbol-handle'], written: ['fresh-routes'], cost: COST });
    assert.match(h.view().choiceNote ?? '', /^Re-planned/, `the learner did no work there, so the press lands: ${JSON.stringify(h.view().choiceNote)}`);
  });

  test('a question at D in flight when the re-plan lands: its answer is put before the line, and not sent as history about the new code (NF7)', async () => {
    let answer: ((reply: LlmReply) => void) | undefined;
    const held = (): Promise<LlmReply> => new Promise((resolve) => { answer = resolve; });
    const h = harness({
      dial: 'manual',
      progress: (p) => setDial(fixtureProgress(p), D, 'manual'),
      tutorCore: () => Promise.resolve({ ...realTutor, availability: () => Promise.resolve({ ok: true, detail: 'a stand-in' }), runLlm: held }),
      tutorSettings: () => ({ provider: 'claude', model: 'm', timeoutMs: 60_000 }),
    });
    h.session.ask('what does tokenize do?');
    for (let i = 0; i < 100 && answer === undefined; i += 1) await turns(1);
    assert.ok(answer, 'discriminates: the question is with the model');
    h.session.choose(D, ANSWER);
    const job = await reachedEngine(h);
    job.finish(landed(h.plan, h.tree));
    for (let i = 0; i < 50 && h.view().plan.steps.every((s) => s.id !== 'fresh-1'); i += 1) await turns(1);
    assert.ok(h.view().plan.steps.some((s) => s.id === 'fresh-1'), 'discriminates: the re-plan landed while the question was out');
    answer({ text: 'it splits on spaces, in the author\'s code', inputTokens: 1, outputTokens: 1, usd: 0, metered: false });
    await h.session.settled();
    const progress = loadProgress(h.target, loadPlan(h.target));
    const order = getTranscript(progress, D).map((m) => (m.kind === 'note' ? 'note' : m.role));
    assert.deepEqual(order, ['user', 'assistant', 'note'], `the answer was to a question about the code the press replaced: ${JSON.stringify(order)}`);
    assert.deepEqual(sentTurns(progress, D), [], 'so a later question is sent none of it');
  });

  test('a press while the plan\'s earlier re-derived code cannot be found is refused in words, and asks nothing (NF8)', async () => {
    const h = harness({ plan: replanned(fixturePlan()), progress: (p) => setCurrent(markDone(fixtureProgress(p), 'st-1-shape-src'), D) });
    // The tree the plan names was never written into this store: another machine, or cleared storage.
    assert.equal(fs.existsSync(path.join(h.tree, 'src', 'api', 'fresh.ts')), false, 'discriminates: fresh-1\'s code is not there');
    const before = h.bytes();
    h.session.choose(D, 'author');
    await turns(20);
    assert.equal(h.pending.length, 0, 'the engine is not asked: a new tree would be written without the code it cannot find');
    assert.match(h.view().choiceNote ?? '', /cannot be found/, `the page says why; it says ${JSON.stringify(h.view().choiceNote)}`);
    assert.deepEqual(h.bytes(), before, 'and nothing moved');
  });
});
