// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/walk/session.ts — the walk's state machine, driven through fake adapters with no
 * extension host anywhere near it. This is plan step 5's own named verification ("unit test of
 * the state machine with fake adapters"), and the reason `WalkSession` was written with a
 * duck-typed `WalkAdapters` interface and ZERO `vscode` import in the first place: everything
 * below runs under plain mocha in milliseconds. (Nothing in this file may import `vscode`
 * either, value or type — `esbuild.mjs`'s `test/unit/*.test.ts` bundle marks `repo-tour` and
 * `mocha` external and deliberately not `vscode`, so one such import fails the BUILD and takes
 * the whole unit suite with it.)
 *
 * `test/walk.test.ts` opens a real walk in a real window, and it is the only place that can
 * prove a range really got revealed and decorated. What it cannot do is see the state machine
 * ISOLATED — the four surfaces it drives are real there, so "did the panel get the same
 * snapshot as the tree", "was progress written before anything was pushed", "did a dial click
 * re-centre the editor" and "was anything written at all" are questions it can only answer by
 * inference, and slowly. So the fake here is a RECORDING one: every adapter call is appended
 * to one log with the arguments it was handed, and most assertions below read that log. That
 * is not an implementation detail standing in for behaviour — this object's entire job is
 * which surface gets pushed what, and in which order, so the call sequence IS the behaviour.
 * The fake also keeps progress in memory, so `loadProgress`/`saveProgress` round-trip exactly
 * as `<target>/.repo-tour/build/progress.json` does, without touching a learner's disk.
 *
 * The guarantees worth stating out loud, because each is a deliberate choice that a
 * "simplification" would quietly reverse:
 *
 *   - **The reveal is a parameter, not a habit.** `goTo`/`next`/`prev` refresh WITH a reveal;
 *     `setDial`/`markDone` refresh without one, and without clearing the editor either. Both
 *     directions are asserted — that a dial click still pushes tree, panel and status, and
 *     that it touches no editor adapter at all. Re-centring the file on every radio click is
 *     not incorrect, just needless jank in the one window the learner is reading code in.
 *   - **Merely looking at a tutorial writes nothing.** `open` never calls `saveProgress` — not
 *     on a first-ever walk, and not when it repairs a stale `current` in memory.
 *   - **An unknown step id is silently ignored, everywhere.** A tree item left over from a
 *     rebuilt plan and a hand-typed `goToStep` argument are both ordinary; neither may throw,
 *     push, or grow a garbage key in the learner's `progress.json`.
 *   - **The reload drill (AC4).** Navigate, dispose, open again on the same store: the same
 *     step comes back, read through `loadProgress` rather than remembered. The fake hands back
 *     a CLONE of what was stored, exactly as `JSON.parse` would, so a reload that "passes"
 *     only because two sessions share one object in memory cannot pass here.
 *   - **A `target.file` that escapes the target folder is not openable.** `fileExists` is
 *     never even ASKED about an escaping path — a containment check that consults the disk
 *     first has already lost — nothing is revealed, and the view reports `fileExists: false`,
 *     the same honest "there is nothing to open here" a file T-5 has not written yet gets. No
 *     error reaches a learner who did not write the plan and cannot fix it.
 *   - **A failed write may not desynchronise the surfaces from the session.** `saveProgress`
 *     throwing keeps the navigation the learner asked for, still refreshes the tree, the panel
 *     and the status bar, and reports ONCE per session however many times it goes on failing.
 *   - **The empty cases are honest.** A plan with no steps pushes `undefined` to the tree and
 *     the panel and the EMPTY string to the status bar — never `step 1 / 0 · manual`, a number
 *     invented to fill a slot. A disposed session clears all four surfaces, is idempotent, and
 *     turns every mutator into a no-op.
 */

import * as assert from 'node:assert/strict';
import path from 'node:path';
import {
  emptyProgress,
  markDone,
  setCurrent,
  statusText,
  type PlanLike,
  type Progress,
} from '../../src/walk/model.js';
import { WalkSession, type WalkAdapters, type WalkView } from '../../src/walk/session.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

/** Nothing here touches the filesystem, so this only has to be a stable absolute path — the
 *  one every `fileExists` argument below is expected to be joined against. */
const TARGET = '/fixture/target';

// ── the recording fake ──────────────────────────────────────────────────────────────────────

/** One adapter call, with what it was handed. The log of these is what most tests read. */
type Call =
  | { fn: 'loadPlan'; target: string }
  | { fn: 'loadProgress'; target: string }
  | { fn: 'saveProgress'; target: string; progress: Progress }
  | { fn: 'fileExists'; absPath: string }
  | { fn: 'setTree'; view: WalkView | undefined }
  | { fn: 'setPanel'; view: WalkView | undefined }
  | { fn: 'setStatus'; text: string }
  | { fn: 'revealEditor'; view: WalkView }
  | { fn: 'clearEditor' }
  | { fn: 'openFile'; view: WalkView }
  | { fn: 'reportError'; message: string };

interface Fake {
  adapters: WalkAdapters;
  /** Every call made so far, in order. */
  log: Call[];
  /** Just the names, in order — the shape a "which surfaces, in which order" assertion wants. */
  names(): string[];
  /** What `progress.json` would hold right now; `undefined` when nothing has been written. */
  stored(): Progress | undefined;
  /** Forget the calls so far, so the next assertion describes exactly ONE action. */
  clearLog(): void;
}

interface FakeOptions {
  plan?: PlanLike;
  /** Progress already "on disk"; absent means a build that has never been walked. */
  progress?: Progress;
  /** Step target paths (relative to `TARGET`) that do NOT exist — everything else does. */
  missing?: string[];
  /** Make every `saveProgress` throw, the way a read-only target folder, a full disk or sync
   *  software holding the rename does. Nothing is stored, so `stored()` keeps showing what was
   *  last written successfully — which is exactly what the learner gets back on reload. */
  saveFails?: boolean;
}

function fakeAdapters(options: FakeOptions = {}): Fake {
  const plan = options.plan ?? fixturePlan();
  const missing = new Set((options.missing ?? []).map((rel) => path.join(TARGET, rel)));
  const saved = new Map<string, Progress>();
  if (options.progress) saved.set(TARGET, options.progress);
  const log: Call[] = [];

  const adapters: WalkAdapters = {
    setTree: (view) => { log.push({ fn: 'setTree', view }); },
    setPanel: (view) => { log.push({ fn: 'setPanel', view }); },
    setStatus: (text) => { log.push({ fn: 'setStatus', text }); },
    revealEditor: (view) => { log.push({ fn: 'revealEditor', view }); },
    clearEditor: () => { log.push({ fn: 'clearEditor' }); },
    openFile: (view) => { log.push({ fn: 'openFile', view }); },
    reportError: (message) => { log.push({ fn: 'reportError', message }); },
    fileExists: (absPath) => {
      log.push({ fn: 'fileExists', absPath });
      return !missing.has(absPath);
    },
    loadPlan: (target) => {
      log.push({ fn: 'loadPlan', target });
      return plan;
    },
    loadProgress: (target, forPlan) => {
      log.push({ fn: 'loadProgress', target });
      const found = saved.get(target);
      // A COPY, exactly as `JSON.parse` hands one back from the real file: a reload drill that
      // only passes because two sessions happen to share one object cannot pass here.
      return found ? structuredClone(found) : emptyProgress(forPlan);
    },
    saveProgress: (target, progress) => {
      // Logged BEFORE it can throw, deliberately: the real writer fails at the rename, having
      // already been asked to write, and a test that could not see the attempt could not tell
      // "the write failed" apart from "the write was never made".
      log.push({ fn: 'saveProgress', target, progress });
      if (options.saveFails) throw new Error('EACCES: permission denied, rename \'progress.json.tmp\'');
      saved.set(target, structuredClone(progress));
    },
  };

  return {
    adapters,
    log,
    names: () => log.map((call) => call.fn),
    stored: () => saved.get(TARGET),
    clearLog: () => { log.length = 0; },
  };
}

/** Every call of one kind, already narrowed — `pick(fake, 'setStatus')[0]?.text`. */
function pick<K extends Call['fn']>(fake: Fake, fn: K): Extract<Call, { fn: K }>[] {
  return fake.log.filter((call): call is Extract<Call, { fn: K }> => call.fn === fn);
}

/** The step ids pushed to one surface, in order; `undefined` for a "show nothing" push. */
function pushedSteps(fake: Fake, fn: 'setTree' | 'setPanel'): (string | undefined)[] {
  return pick(fake, fn).map((call) => call.view?.step.id);
}

/**
 * A session already open on a walk under way (`fixtureProgress`: step 1 done, parked on step 2
 * with its dial dragged to `scaffolded`), with the opening calls forgotten so the assertion
 * that follows describes only the action under test.
 */
function opened(options: FakeOptions = {}): { session: WalkSession; fake: Fake; plan: PlanLike } {
  const plan = options.plan ?? fixturePlan();
  const fake = fakeAdapters({ ...options, plan, progress: options.progress ?? fixtureProgress(plan) });
  const session = WalkSession.open(TARGET, fake.adapters);
  fake.clearLog();
  return { session, fake, plan };
}

/** A plan whose chapters produced no steps at all — legal, and reachable. */
function emptyPlan(): PlanLike {
  return { ...fixturePlan(), steps: [] };
}

/**
 * `fixturePlan()` with the CURRENT step's `target.file` rewritten to whatever is asked for.
 * `plan.json` is `JSON.parse`d and cast into shape, never validated, so any string at all can
 * genuinely arrive in that slot — and `fixtureProgress` parks the walk on exactly this step,
 * so whatever is written here is what activation tries to open, with no click in between.
 */
function planTargeting(file: string): PlanLike {
  const plan = fixturePlan();
  return {
    ...plan,
    steps: plan.steps.map((step) => (
      step.id === 'st-2-file-parse' ? { ...step, target: { ...step.target, file } } : step
    )),
  };
}

suite('WalkSession.open — loaded through the adapters, pushed to every surface', () => {
  test('loads plan then progress, pushes tree, panel and status, and reveals — in that order', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(fake.names(), [
      'loadPlan', 'loadProgress', 'fileExists', 'setTree', 'setPanel', 'setStatus', 'revealEditor',
    ], 'opening the walk should land the learner IN the file they left off in, not merely name it');
    assert.equal(session.getView()?.step.id, 'st-2-file-parse', 'the step the stored progress was parked on');
  });

  test('the tree, the panel and the editor are handed ONE snapshot — the same object getView returns', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const session = WalkSession.open(TARGET, fake.adapters);
    const view = session.getView();
    assert.ok(view);

    // Reference equality, deliberately: four surfaces rendering four separately-built values is
    // exactly the drift `refresh` being the single push point exists to make impossible.
    assert.equal(pick(fake, 'setTree')[0]?.view, view, 'the tree gets the session\'s own view');
    assert.equal(pick(fake, 'setPanel')[0]?.view, view, 'and so does the panel');
    assert.equal(pick(fake, 'revealEditor')[0]?.view, view, 'and so does the editor');
    assert.equal(pick(fake, 'setStatus')[0]?.text, statusText(plan, view.progress));
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 2 / 4 · scaffolded', 'AC6, spelled out');
  });

  test('fileExists is asked about <target>/<step.target.file>, joined — never the bare relative path', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(pick(fake, 'fileExists').map((call) => call.absPath), [path.join(TARGET, 'src/parse.ts')]);
    assert.equal(session.getView()?.fileExists, true);
  });

  test('a step whose target file is missing gets clearEditor instead of a reveal', () => {
    // `openTextDocument` REJECTS on a path that is not there, from inside a void-ed promise
    // nobody is listening to — so the missing file has to be caught before the reveal, not by
    // the reveal. In manual mode with nothing written yet (T-5's job) this is the normal case.
    const plan = fixturePlan();
    const fake = fakeAdapters({
      plan,
      progress: setCurrent(emptyProgress(plan), 'st-4-symbol-render'),
      missing: ['src/api/render.ts'],
    });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(fake.names(), [
      'loadPlan', 'loadProgress', 'fileExists', 'setTree', 'setPanel', 'setStatus', 'clearEditor',
    ]);
    assert.equal(session.getView()?.fileExists, false);
    assert.deepEqual(pushedSteps(fake, 'setPanel'), ['st-4-symbol-render'],
      'the panel is still pushed — the step exists, only its file does not, and the panel says so');
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 4 / 4 · manual');
  });

  test('open writes NOTHING — looking at a tutorial must not write into the learner\'s folder', () => {
    const fake = fakeAdapters({ plan: fixturePlan() }); // no progress at all: a first-ever walk
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(pick(fake, 'saveProgress'), []);
    assert.equal(fake.stored(), undefined, 'no progress.json would exist on disk after this');
    assert.equal(session.getView()?.step.id, 'st-1-shape-src', 'a first-ever walk is parked on the first step');
  });

  test('open lands where the stored progress says, not at the beginning', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: setCurrent(emptyProgress(plan), 'st-3-symbol-handle') });

    assert.equal(WalkSession.open(TARGET, fake.adapters).getView()?.step.id, 'st-3-symbol-handle');
  });
});

suite('a target.file that escapes the target folder (security review finding 2)', () => {
  test('a `..` path is not openable at all: the disk is never asked, nothing is revealed, the view says false', () => {
    const plan = planTargeting('../../../.ssh/id_rsa');
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(pick(fake, 'fileExists'), [],
      'refused by `path` alone — a containment check that consults the filesystem first is one that has already lost');
    assert.deepEqual(pick(fake, 'revealEditor'), [],
      '`path.join` would have made that a real path to somebody\'s private key, and this reveal runs on activation with no gesture in between');
    assert.deepEqual(fake.names(), [
      'loadPlan', 'loadProgress', 'setTree', 'setPanel', 'setStatus', 'clearEditor',
    ], 'exactly the shape of a step whose file is not there — the escape is a dead end, not a state of its own');
    assert.equal(session.getView()?.fileExists, false);
    assert.deepEqual(pushedSteps(fake, 'setPanel'), ['st-2-file-parse'],
      'the step is still shown: only its file is unreachable, and the panel already says that honestly');
    assert.deepEqual(pick(fake, 'reportError'), [],
      'the learner did not write the plan and has nothing to fix in it, so nothing is put in front of them');
  });

  test('an ABSOLUTE target.file is out too, rather than being quietly re-rooted under the target', () => {
    const plan = planTargeting('/etc/passwd');
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(pick(fake, 'fileExists'), []);
    assert.equal(session.getView()?.fileExists, false,
      '`path.join` swallowed this into `<target>/etc/passwd` — harmless by accident, and no kind of check');
  });

  test('the panel\'s Open the file button cannot be talked into opening one either', () => {
    const { session, fake } = opened({ plan: planTargeting('../../../.ssh/id_rsa') });
    session.openFile();

    assert.deepEqual(fake.log, [],
      'a `step:open` message arriving anyway must not become the one gesture that opens it');
  });

  test('a `..` that stays INSIDE the target still opens — this is containment, not a ban on the characters', () => {
    const plan = planTargeting('src/api/../parse.ts');
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(pick(fake, 'fileExists').map((call) => call.absPath), [path.join(TARGET, 'src/parse.ts')],
      'normalised to where it actually points and asked about THAT — a substring test for `..` would have rejected a legal path');
    assert.equal(session.getView()?.fileExists, true);
    assert.equal(pick(fake, 'revealEditor').length, 1, 'and it is revealed like any other step');
  });
});

suite('goTo — real navigation, which is what a reveal is for (AC1, AC3)', () => {
  test('makes the step current, persists it, and pushes every surface WITH a reveal', () => {
    const { session, fake } = opened();
    session.goTo('st-3-symbol-handle');

    assert.deepEqual(fake.names(), ['saveProgress', 'fileExists', 'setTree', 'setPanel', 'setStatus', 'revealEditor'],
      'durable before any surface is told where the walk moved to, and the reveal last');
    assert.equal(session.getView()?.step.id, 'st-3-symbol-handle');
    assert.equal(fake.stored()?.current, 'st-3-symbol-handle');
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 3 / 4 · manual');
  });

  test('an id the plan does not contain is silently ignored — no throw, no push, nothing persisted', () => {
    const { session, fake, plan } = opened();
    assert.doesNotThrow(() => { session.goTo('st-99-from-the-old-plan'); },
      'a stale tree item or a hand-typed goToStep argument must never take the walk down');

    assert.deepEqual(fake.log, [], 'not one surface was touched');
    assert.deepEqual(fake.stored(), fixtureProgress(plan), 'and the learner\'s progress.json is untouched');
    assert.equal(session.getView()?.step.id, 'st-2-file-parse', 'the walk is still exactly where it was');
  });

  test('going to the step already current is NOT a no-op — it is how a learner asks for the file back', () => {
    const { session, fake } = opened();
    session.goTo('st-2-file-parse');

    assert.equal(pick(fake, 'revealEditor').length, 1,
      'clicking the current step in the tree takes you back to the file after wandering off in the editor');
    assert.deepEqual(pushedSteps(fake, 'setTree'), ['st-2-file-parse']);
  });

  test('what is persisted is the whole progress, not just the position', () => {
    const { session, fake, plan } = opened();
    session.markDone('st-2-file-parse');
    session.goTo('st-3-symbol-handle');

    assert.deepEqual(
      fake.stored(),
      setCurrent(markDone(fixtureProgress(plan), 'st-2-file-parse'), 'st-3-symbol-handle'),
      'a done status recorded a moment ago must not be dropped by the next navigation',
    );
  });
});

suite('next / prev — and the two ends of the plan (AC2)', () => {
  test('next moves one step by ordinal, revealing as it goes', () => {
    const { session, fake } = opened();
    session.next();

    assert.equal(session.getView()?.step.id, 'st-3-symbol-handle');
    assert.equal(pick(fake, 'revealEditor')[0]?.view.step.id, 'st-3-symbol-handle');
    assert.equal(fake.stored()?.current, 'st-3-symbol-handle');
  });

  test('prev moves back one step, revealing too', () => {
    const { session, fake } = opened();
    session.prev();

    assert.equal(session.getView()?.step.id, 'st-1-shape-src');
    assert.equal(pick(fake, 'revealEditor')[0]?.view.step.id, 'st-1-shape-src');
    assert.equal(fake.stored()?.current, 'st-1-shape-src');
  });

  test('next on the LAST step does nothing at all — no wraparound, no throw, no push', () => {
    const plan = fixturePlan();
    const { session, fake } = opened({ plan, progress: setCurrent(emptyProgress(plan), 'st-4-symbol-render') });
    assert.doesNotThrow(() => { session.next(); });

    assert.deepEqual(fake.log, [], 'the end of the walk is a quiet place, not a wrap to the start');
    assert.equal(session.getView()?.step.id, 'st-4-symbol-render');
  });

  test('prev on the FIRST step does nothing at all either', () => {
    const plan = fixturePlan();
    const { session, fake } = opened({ plan, progress: setCurrent(emptyProgress(plan), 'st-1-shape-src') });
    assert.doesNotThrow(() => { session.prev(); });

    assert.deepEqual(fake.log, []);
    assert.equal(session.getView()?.step.id, 'st-1-shape-src');
  });
});

suite('setDial / markDone — the same push, deliberately WITHOUT a reveal', () => {
  test('setDial pushes tree, panel and status, and does not touch the editor at all', () => {
    const { session, fake } = opened();
    session.setDial('st-2-file-parse', 'automated');

    assert.deepEqual(fake.names(), ['saveProgress', 'fileExists', 'setTree', 'setPanel', 'setStatus'],
      're-centring the editor on a radio click for the step already on screen is needless jank');
    assert.deepEqual(pick(fake, 'revealEditor'), [], 'no reveal');
    assert.deepEqual(pick(fake, 'clearEditor'), [], 'and no clear either — refresh(false) leaves the editor entirely alone');
    // The other half of the split, which is what stops this from passing on a session that
    // simply stopped refreshing: the three surfaces really were pushed, with the new dial.
    assert.deepEqual(pushedSteps(fake, 'setTree'), ['st-2-file-parse']);
    assert.deepEqual(pushedSteps(fake, 'setPanel'), ['st-2-file-parse']);
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 2 / 4 · automated', 'AC6\'s "· <dial>" has to update');
    assert.equal(fake.stored()?.steps['st-2-file-parse']?.dial, 'automated');
  });

  test('markDone records the step done and refreshes the same way, no reveal', () => {
    const { session, fake } = opened();
    session.markDone('st-2-file-parse');

    assert.deepEqual(fake.names(), ['saveProgress', 'fileExists', 'setTree', 'setPanel', 'setStatus']);
    assert.equal(pick(fake, 'setTree')[0]?.view?.progress.steps['st-2-file-parse']?.status, 'done',
      'the tree draws its $(check) from the pushed view, so the push must carry the new status');
    assert.equal(fake.stored()?.steps['st-2-file-parse']?.status, 'done');
  });

  test('setDial with an id the plan does not contain writes no garbage key into progress', () => {
    const { session, fake, plan } = opened();
    assert.doesNotThrow(() => { session.setDial('st-99-from-the-old-plan', 'manual'); });

    assert.deepEqual(fake.log, []);
    assert.deepEqual(fake.stored(), fixtureProgress(plan), 'progress.json must never grow an entry for a step that does not exist');
  });

  test('markDone with an unknown id is ignored the same way', () => {
    const { session, fake, plan } = opened();
    assert.doesNotThrow(() => { session.markDone('st-99-from-the-old-plan'); });

    assert.deepEqual(fake.log, []);
    assert.deepEqual(fake.stored(), fixtureProgress(plan));
  });

  test('a dial set against a step that is not the current one records it without moving the walk', () => {
    const { session, fake } = opened();
    session.setDial('st-4-symbol-render', 'automated');

    assert.equal(session.getView()?.step.id, 'st-2-file-parse');
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 2 / 4 · scaffolded', 'the status bar shows the CURRENT step\'s dial');
    assert.equal(fake.stored()?.steps['st-4-symbol-render']?.dial, 'automated');
  });
});

suite('a saveProgress that throws — the surfaces may never be left disagreeing (code review finding 4)', () => {
  test('the navigation stands, every surface is still refreshed, and the report comes last', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan), saveFails: true });
    const session = WalkSession.open(TARGET, fake.adapters);
    fake.clearLog();

    assert.doesNotThrow(() => { session.goTo('st-3-symbol-handle'); },
      'the throw used to escape through handleStepMessage into onDidReceiveMessage, where VS Code logs it and shows nothing');

    assert.deepEqual(fake.names(), [
      'saveProgress', 'fileExists', 'setTree', 'setPanel', 'setStatus', 'revealEditor', 'reportError',
    ], 'the write is attempted, every surface is pushed ANYWAY, and only then is anyone told — so the surfaces already agree by the time they see it');
    assert.equal(session.getView()?.step.id, 'st-3-symbol-handle',
      'the navigation is what the learner asked for and it stands; what they lost is the walk remembering it');
    assert.deepEqual(pushedSteps(fake, 'setTree'), ['st-3-symbol-handle']);
    assert.deepEqual(pushedSteps(fake, 'setPanel'), ['st-3-symbol-handle'],
      'the bug: the session on step 3 while the page still read step 2, and the next click moving it to step 4');
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 3 / 4 · manual');
    assert.equal(pick(fake, 'revealEditor')[0]?.view.step.id, 'st-3-symbol-handle');
  });

  test('the message names the folder and says what was actually lost', () => {
    const { session, fake } = opened({ saveFails: true });
    session.next();

    const message = pick(fake, 'reportError')[0]?.message ?? '';
    assert.match(message, /Could not save your progress/, 'in the learner\'s words, not a stack trace');
    assert.ok(message.includes(TARGET), 'which folder — a window can have several open');
    assert.match(message, /will not remember/,
      'what they lost is their PLACE next time, not their work and not this session — the walk keeps working');
    assert.match(message, /EACCES/, 'and the underlying reason rides along for the output channel');
  });

  test('reported ONCE per session, not once per click — a read-only folder is not a notification storm', () => {
    const { session, fake } = opened({ saveFails: true });

    session.next();
    session.next();
    session.prev();
    session.setDial('st-2-file-parse', 'automated');
    session.markDone('st-2-file-parse');

    assert.equal(pick(fake, 'saveProgress').length, 5, 'every one of those really did try to write, and really did fail');
    assert.equal(pick(fake, 'setStatus').length, 5, 'and every one of them still refreshed the surfaces');
    assert.equal(pick(fake, 'reportError').length, 1,
      'the condition is standing, so it is stated once and then endured quietly — 61 steps of dismissing the same dialog is not a walk');
  });

  test('and the walk really does forget: a reload comes back where the last SUCCESSFUL write left it', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan), saveFails: true });
    const first = WalkSession.open(TARGET, fake.adapters);
    first.goTo('st-4-symbol-render');
    first.dispose();

    assert.deepEqual(fake.stored(), fixtureProgress(plan), 'a failed write leaves the file exactly as it was');
    assert.equal(WalkSession.open(TARGET, fake.adapters).getView()?.step.id, 'st-2-file-parse',
      'exactly what the message promises — the session moved, the file did not, so the next open is where the file says');
  });
});

suite('openFile — the panel\'s "Open the file" button (step:open)', () => {
  test('hands the adapter the current view when the file is there', () => {
    const { session, fake } = opened();
    session.openFile();

    assert.deepEqual(fake.names(), ['openFile'], 'an explicit request opens the file and does nothing else');
    assert.equal(pick(fake, 'openFile')[0]?.view, session.getView(),
      'the same snapshot the panel drew the button\'s enabled state from — the two cannot disagree');
  });

  test('does nothing when the step\'s file does not exist', () => {
    const plan = fixturePlan();
    const { session, fake } = opened({
      plan,
      progress: setCurrent(emptyProgress(plan), 'st-4-symbol-render'),
      missing: ['src/api/render.ts'],
    });
    session.openFile();

    assert.deepEqual(fake.log, [], 'the panel drew this button disabled; a click that arrived anyway is not a reason to reject a promise');
  });

  test('does nothing when there is no current step at all', () => {
    const { session, fake } = opened({ plan: emptyPlan() });
    session.openFile();

    assert.deepEqual(fake.log, []);
  });
});

suite('dispose — a session that stops driving the surfaces it drove', () => {
  test('clears every surface it drives: decorations, tree, panel, status bar', () => {
    const { session, fake } = opened();
    session.dispose();

    assert.deepEqual(fake.names(), ['clearEditor', 'setTree', 'setPanel', 'setStatus']);
    assert.equal(pick(fake, 'setTree')[0]?.view, undefined);
    assert.equal(pick(fake, 'setPanel')[0]?.view, undefined);
    assert.equal(pick(fake, 'setStatus')[0]?.text, '',
      'a status pill still reading "step 2 / 4 · scaffolded" for a walk that is not running is the bug this prevents');
    assert.equal(session.getView(), undefined, 'and nothing is left to hand a surface that asks');
  });

  test('idempotent — a second dispose touches nothing', () => {
    const { session, fake } = opened();
    session.dispose();
    fake.clearLog();
    session.dispose();

    assert.deepEqual(fake.log, [], 'the adapters outlive this session and may already belong to the next one');
  });

  test('every mutator is a no-op afterwards, so a queued click cannot write the old target\'s progress', () => {
    const { session, fake, plan } = opened();
    session.dispose();
    fake.clearLog();

    assert.doesNotThrow(() => {
      session.goTo('st-3-symbol-handle');
      session.next();
      session.prev();
      session.setDial('st-2-file-parse', 'automated');
      session.markDone('st-2-file-parse');
      session.openFile();
    });

    assert.deepEqual(fake.log, [], 'a replaced session must not repaint surfaces the new one has already claimed');
    assert.deepEqual(fake.stored(), fixtureProgress(plan), 'nor write the old target\'s progress');
    assert.equal(session.getView(), undefined);
  });
});

suite('the reload drill (AC4) — nothing is cached across instances', () => {
  test('navigate, dispose, open again on the same store: the same step comes back', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const first = WalkSession.open(TARGET, fake.adapters);
    first.goTo('st-4-symbol-render');
    first.markDone('st-3-symbol-handle');
    first.dispose();
    fake.clearLog();

    const second = WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(fake.names().slice(0, 2), ['loadPlan', 'loadProgress'],
      'the position is read back through the adapters, not remembered by the class');
    assert.equal(second.getView()?.step.id, 'st-4-symbol-render');
    assert.equal(second.getView()?.progress.steps['st-3-symbol-handle']?.status, 'done',
      'per-step status survives the reload too, not just the position');
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 4 / 4 · manual', 'and the status bar comes back with it');
  });

  test('the session reads the store rather than remembering: progress changed while it was closed wins', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const first = WalkSession.open(TARGET, fake.adapters);
    first.goTo('st-4-symbol-render');
    first.dispose();

    // Another window — or T-5's own writer — moves the walk while this one is not running.
    fake.adapters.saveProgress(TARGET, setCurrent(emptyProgress(plan), 'st-3-symbol-handle'));

    assert.equal(WalkSession.open(TARGET, fake.adapters).getView()?.step.id, 'st-3-symbol-handle',
      'a session that memoised anything across instances would come back on st-4');
  });

  test('a per-step dial recorded before the reload is what the status bar reads after it', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: fixtureProgress(plan) });
    const first = WalkSession.open(TARGET, fake.adapters);
    first.setDial('st-2-file-parse', 'automated');
    first.dispose();
    fake.clearLog();

    WalkSession.open(TARGET, fake.adapters);
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 2 / 4 · automated');
  });
});

suite('a stale current — a tutorial rebuilt over an old progress.json', () => {
  /** Perfectly valid JSON naming a step id that no longer exists: new plan, old progress. */
  function stale(): Progress {
    return { schemaVersion: 1, current: 'st-7-from-the-old-plan', steps: { 'st-7-from-the-old-plan': { status: 'done' } } };
  }

  test('a current naming no step in this plan is repaired to the plan\'s first step', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: stale() });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.equal(session.getView()?.step.id, 'st-1-shape-src',
      'left alone this is an empty tree and an empty panel on top of a plan that is entirely fine');
    assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 1 / 4 · manual');
  });

  test('the repair is in memory only — open still writes nothing', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: stale() });
    WalkSession.open(TARGET, fake.adapters);

    assert.deepEqual(pick(fake, 'saveProgress'), []);
    assert.deepEqual(fake.stored(), stale(),
      'the repair is deterministic, so the next open reaches the same place without a write');
  });

  test('a current of null is repaired the same way', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: { schemaVersion: 1, current: null, steps: {} } });

    assert.equal(WalkSession.open(TARGET, fake.adapters).getView()?.step.id, 'st-1-shape-src');
  });

  test('the repair really moves the walk, not just the view: next goes to step 2 and prev does nothing', () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: stale() });
    const session = WalkSession.open(TARGET, fake.adapters);
    fake.clearLog();

    session.prev();
    assert.deepEqual(fake.log, [], 'the repaired position is the FIRST step, so there is nothing before it');
    session.next();
    assert.equal(session.getView()?.step.id, 'st-2-file-parse',
      'a repair that only fixed the view would leave progress.current unrecognised, and next would offer step 1 again');
  });
});

suite('a plan with no steps at all — the honest empty case', () => {
  test('nothing in the tree, nothing in the panel, and an EMPTY status bar', () => {
    const plan = emptyPlan();
    const fake = fakeAdapters({ plan });
    const session = WalkSession.open(TARGET, fake.adapters);

    assert.equal(session.getView(), undefined);
    assert.deepEqual(fake.names(), ['loadPlan', 'loadProgress', 'setTree', 'setPanel', 'setStatus', 'clearEditor'],
      'no file is even asked about, and the editor is cleared rather than revealed');
    assert.equal(pick(fake, 'setTree')[0]?.view, undefined);
    assert.equal(pick(fake, 'setPanel')[0]?.view, undefined);
    assert.equal(statusText(plan, emptyProgress(plan)), 'step 1 / 0 · manual',
      'this is the number the session must NOT push — invented to fill a slot');
    assert.equal(pick(fake, 'setStatus')[0]?.text, '');
  });

  test('every mutator is a no-op rather than a throw', () => {
    const fake = fakeAdapters({ plan: emptyPlan() });
    const session = WalkSession.open(TARGET, fake.adapters);
    fake.clearLog();

    assert.doesNotThrow(() => {
      session.next();
      session.prev();
      session.goTo('st-1-shape-src');
      session.setDial('st-1-shape-src', 'manual');
      session.markDone('st-1-shape-src');
      session.openFile();
    });

    assert.deepEqual(fake.log, []);
    assert.equal(fake.stored(), undefined, 'and nothing was written into a folder whose plan has nothing to walk');
  });
});
