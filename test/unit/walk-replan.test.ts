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
teardown(() => {
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
  return { ok: true, changed: true, plan: replanned(plan, tree), derivedRoot, staleDependents: [], cost: COST };
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
  const tree = path.join(store, TREE);
  fs.mkdirSync(tree, { recursive: true });
  const plan = options.plan ?? fixturePlan();
  const dir = buildDir(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 3)}\n`);
  saveProgress(target, options.progress?.(plan) ?? fixtureProgress(plan));
  if (options.noRequest !== true) {
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ idea: '', recreate: true, repo, target, dial: 'automated', referenceRoot: repo }));
  }
  const pending: Pending[] = [];
  const errors: string[] = [];
  const views: Array<WalkView | undefined> = [];
  let coreCalls = 0;
  const replanner: Replanner = {
    diverge: (input, hooks) => new Promise((resolve, reject) => {
      pending.push({ input, hooks, finish: resolve, fail: reject });
    }),
    savePlan: options.savePlan ?? ((t, p) => { saveDivergedPlan(t, p); }),
  };
  const adapters: WalkAdapters = {
    setTree: (v) => { views.push(v); },
    setPanel: () => undefined,
    setStatus: () => undefined,
    revealEditor: () => { assert.fail('a replan never moves the editor'); },
    clearEditor: () => undefined,
    openFile: () => undefined,
    fileExists: (p) => fs.existsSync(p),
    loadPlan,
    loadProgress,
    saveProgress,
    loadRequest: (t, p) => loadRequest(t, { plan: p, store }),
    reportError: (m) => { errors.push(m); },
    core: () => { coreCalls += 1; return Promise.resolve(undefined); },
    readText: () => undefined,
    confirmOverwrite: () => Promise.resolve(false),
    git: () => Promise.reject(new Error('no git here')),
    commitPerStep: () => false,
    ...(options.noReplanner === true ? {} : { replanner: () => Promise.resolve(options.replannerMissing === true ? undefined : replanner) }),
  };
  const session = WalkSession.open(target, adapters);
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

/** Lets a press reach the engine: past `await replanner()`. */
async function reachedEngine(h: Harness, count = 1): Promise<Pending> {
  for (let i = 0; i < 50 && h.pending.length < count; i += 1) await new Promise((r) => { setImmediate(r); });
  const job = h.pending[count - 1];
  assert.ok(job, 'the press reached the engine');
  return job;
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
    assert.equal(h.view().choiceNote, replanDoneText(1, true, COST));
    assert.match(h.view().choiceNote ?? '', /\$0\.0123/);
  });

  test('when nothing later needed re-planning the note does not say nothing depended on it: a walked step may have', () => {
    assert.match(replanDoneText(0, true, COST), /No later step needed re-planning/);
    assert.doesNotMatch(replanDoneText(0, true, COST), /depended/);
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
    const never = (): Promise<never> => new Promise(() => undefined);
    const core = { availability: () => Promise.resolve({ ok: true as const }), resolveTutorChoice: (_: unknown, build: unknown) => build, resolveChoice: (c: unknown) => c, runLlm: never };
    const ticket = job.hooks.ledger.open('derive:diverge:x');
    ticket.sendPrompt({ core, provider: 'p', model: 'm', timeoutMs: 60_000, run: never } as never, 'a question');
    assert.equal(ticket.phase, 'sending');
    h.session.cancelReplan();
    assert.equal(h.view().choiceNote, REPLAN_CANCELLED_BILLED);
    assert.equal(ticket.abandoned, true);
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
