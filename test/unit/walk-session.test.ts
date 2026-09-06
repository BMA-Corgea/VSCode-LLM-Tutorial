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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitRunner } from '../../src/start/build.js';
import type { Dial } from '../../src/start/request.js';
import type { ResolvedRequest } from '../../src/walk/store.js';
import type { CheckReport, DialCore, StubQuestion } from '../../src/dial/core.js';
import {
  emptyProgress,
  markDone,
  setCurrent,
  setDial,
  statusText,
  type PlanLike,
  type Progress,
  type RangeLike,
} from '../../src/walk/model.js';
import type { AskMessage, Availability, LlmReply, TutorCore } from '../../src/tutor/core.js';
import { getTranscript } from '../../src/tutor/transcript.js';
import { WalkSession, type WalkAdapters, type WalkView } from '../../src/walk/session.js';
import { fixturePlan, fixtureProgress, writeFixtureTarget } from './walk-fixtures.js';

/** The in-memory target: nothing under it exists, so `readText` answers `undefined` for every
 *  path and no position can ever put bytes there. It is a stable absolute path and nothing
 *  more — the one every `fileExists` argument in the T-4 suites is joined against. The T-5
 *  suites that actually write use a real temporary directory instead; see `realBox`. */
const TARGET = '/fixture/target';

// ── the recording fake ──────────────────────────────────────────────────────────────────────

/** One adapter call, with what it was handed. The log of these is what most tests read. */
type Call =
  | { fn: 'loadPlan'; target: string }
  | { fn: 'loadProgress'; target: string }
  | { fn: 'loadRequest'; target: string }
  | { fn: 'saveProgress'; target: string; progress: Progress }
  | { fn: 'fileExists'; absPath: string }
  | { fn: 'setTree'; view: WalkView | undefined }
  | { fn: 'setPanel'; view: WalkView | undefined }
  | { fn: 'setStatus'; text: string }
  | { fn: 'revealEditor'; view: WalkView }
  | { fn: 'clearEditor' }
  | { fn: 'openFile'; view: WalkView }
  | { fn: 'reportError'; message: string }
  // ── T-5 ───────────────────────────────────────────────────────────────────────────────────
  | { fn: 'core' }
  | { fn: 'readText'; absPath: string }
  | { fn: 'confirmOverwrite'; relPath: string }
  | { fn: 'commitPerStep' }
  | { fn: 'git'; args: string[]; cwd: string | undefined }
  // Not adapters, but part of the same fake and worth the same log: what the DIAL asked
  // repo-tour's core to do is the difference between "scaffolded" and "automated" reaching
  // `planWrite` at all, and it is invisible from the outside if the core is silent.
  | { fn: 'stubFile'; language: string; ranges: RangeLike[]; questions: StubQuestion[] }
  | { fn: 'coreCheck'; relPath: string; language: string; learnerSource: string }
  | { fn: 'coreExtract'; root: string; paths: string[] }
  // ── T-6 ───────────────────────────────────────────────────────────────────────────────────
  | { fn: 'tutorCore' }
  | { fn: 'tutorSettings' }
  | { fn: 'availability'; providerId: string }
  // What was actually SENT to a model, as `askTutor` composed it. The prompt is the whole
  // point: it is how a test can tell "the tutor was given this step" from "something was
  // asked", without a provider anywhere near the suite.
  | { fn: 'runLlm'; prompt: string; provider: string; model: string; cwd: string; timeoutMs: number | undefined };

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
  /** Step target paths (relative to the target) that do NOT exist — everything else does. */
  missing?: string[];
  /** Make every `saveProgress` throw, the way a read-only target folder, a full disk or sync
   *  software holding the rename does. Nothing is stored, so `stored()` keeps showing what was
   *  last written successfully — which is exactly what the learner gets back on reload. */
  saveFails?: boolean;

  // ── T-5 ─────────────────────────────────────────────────────────────────────────────────

  /** The folder the walk writes INTO. `TARGET` (nothing exists, nothing can be written) unless
   *  a test hands over a real temporary directory. */
  target?: string;
  /** `request.json`. ABSENT MEANS `null`, and that is the T-4 default on purpose: a session
   *  with no request has no reference root, so no position writes and every one of the suites
   *  written before this ticket goes on describing a walk that touches nothing. */
  request?: ResolvedRequest;
  /** `core()` resolves `undefined` — repo-tour is not loadable at all. */
  coreMissing?: boolean;
  /** The core's `check` REJECTS — a missing grammar, an unloadable parser. Real breakage, and
   *  the opposite of the `null` that means "there is nothing to check here". */
  coreThrows?: boolean;
  /** What the core's `check` reports when it does answer. Default: everything present. */
  report?: CheckReport;
  /** What `confirmOverwrite` answers. `true` (overwrite) unless a test says otherwise. */
  overwrite?: boolean;
  /** `buildTutorials.commitPerStep`; default on, as the setting is. */
  commitPerStep?: boolean;
  /** Make `git config` reject the way a folder with no identity configured does. */
  noGitIdentity?: boolean;
  /** Make `git commit` reject, the way a stale lock file or an unchanged tree does. */
  gitFails?: string;

  // ── T-6 ─────────────────────────────────────────────────────────────────────────────────

  /** Wire NO tutor adapters at all — a walk with no *Ask* behind it, which is what every
   *  suite written before this ticket gets, and what `test/dial.test.ts` gets in production
   *  code. The two adapters are optional precisely so that stays possible. */
  noTutor?: boolean;
  /** `tutorCore()` resolves `undefined` — repo-tour is not loadable, so there is nobody to
   *  ask. Distinct from `noTutor`: the adapter is wired and answers honestly. */
  tutorCoreMissing?: boolean;
  /** What the provider's own `available()` says. Default: reachable. */
  availability?: Availability;
  /** What the injected runner answers with. */
  tutorReply?: string;
  /** A runner of the test's own — a promise that never settles, one that rejects, one that
   *  counts its calls. Overrides `tutorReply`. NOTHING in this suite may reach a real model. */
  tutorRunner?: TutorCore['runLlm'];
  /** `buildTutorials.tutorTimeoutSeconds`, in milliseconds. Small on purpose: the behaviour
   *  under test is the race, never the duration. */
  tutorTimeoutMs?: number;
  tutorProvider?: string;
  tutorModel?: string;
}

/** What the fake core's `stubFile` hands back: nothing like the reference file, so a test can
 *  tell "the core stubbed this" from "the reference was copied" by looking at the bytes. */
const STUB_OUTPUT = '// the core stubbed this file\n';

/** A report where the learner's file has everything the reference had. */
function okReport(): CheckReport {
  return {
    symbols: [{ name: 'tokenize', kind: 'function', status: 'present' }],
    imports: [],
    parseErrors: 0,
    ok: true,
  };
}

/** A report naming what is missing — AC5's "a missing export is named". */
function failingReport(): CheckReport {
  return {
    symbols: [{ name: 'tokenize', kind: 'function', status: 'missing' }],
    imports: [],
    parseErrors: 0,
    ok: false,
  };
}

/**
 * repo-tour's core, faked and recording.
 *
 * Faked rather than real, deliberately, and the split is with `test/unit/dial-writer.test.ts`
 * and `dial-check.test.ts` — those two load the REAL core because their questions are about
 * tree-sitter ("does the scaffold parse", "is a renamed local invisible"), which no fake can
 * answer honestly. The question HERE is which core call the session makes, with which dial's
 * arguments, and what it does with the answer — and for that a fake is not a weaker version of
 * the real thing, it is the only version that lets a test choose the answer and watch what the
 * session does with it. It also keeps this suite free of a grammar load per run.
 */
function fakeCore(log: Call[], options: FakeOptions): DialCore {
  return {
    stubFile: (source, loadBearing, language, questions) => {
      log.push({ fn: 'stubFile', language, ranges: loadBearing, questions });
      return STUB_OUTPUT;
    },
    check: (learnerSource, _referenceExtract, language, relPath) => {
      log.push({ fn: 'coreCheck', relPath, language, learnerSource });
      if (options.coreThrows) return Promise.reject(new Error('repo-tour has no typescript grammar loaded'));
      return Promise.resolve(options.report ?? okReport());
    },
    extract: (root, records) => {
      log.push({ fn: 'coreExtract', root, paths: records.map((r) => r.path) });
      // An opaque handle, exactly as `./core.ts` types it: nothing in this extension reads
      // inside one, it goes from `extract` straight back into `check`.
      return Promise.resolve({ extracts: records.map((r) => ({ path: r.path })) });
    },
  };
}

/**
 * `git`, faked — no repository, no commits, no `~/.gitconfig` to depend on.
 *
 * `test/unit/dial-commit.test.ts` runs the real binary against real temporary repositories,
 * which is where "a missing identity is never invented" is actually proven. What this one
 * proves is different and cannot be seen from there: WHICH steps the session decides to commit,
 * how many times, and with what subject.
 */
function fakeGit(log: Call[], options: FakeOptions): GitRunner {
  return (args, cwd) => {
    log.push({ fn: 'git', args, cwd });
    if (args[0] === 'config') {
      // git's own way of saying "not set at any level" is a non-zero exit, which `GitRunner`
      // surfaces as a rejection — not an empty string.
      if (options.noGitIdentity) return Promise.reject(new Error(`error: key does not exist: ${args[1] ?? ''}`));
      return Promise.resolve(args[1] === 'user.name' ? 'A Learner\n' : 'learner@example.com\n');
    }
    if (args[0] === 'commit' && options.gitFails !== undefined) {
      return Promise.reject(new Error(options.gitFails));
    }
    return Promise.resolve('');
  };
}

/** What a poisoned `runLlm` says when a test forgets to inject a runner. Byte-for-byte the
 *  same guard `test/unit/tutor-ask.test.ts` uses, for the same reason: a suite that quietly
 *  started dialling a provider must FAIL rather than bill somebody. */
const SPEND_GUARD = 'a test in walk-session.test.ts reached the real model';

/**
 * The tutor's slice of repo-tour, faked whole.
 *
 * Faked rather than real, and the split is the one `fakeCore` already draws: `tutor-ask.test.ts`
 * loads the genuine core because its questions are about repo-tour's own prompt building and
 * thirty-turn trimming, which no fake can answer honestly. The question HERE is what the
 * SESSION does with an outcome — what it persists, what it pushes, what it says — and for that
 * a fake is not a weaker version of the real thing, it is the only version that lets a test
 * choose the outcome.
 *
 * `runLlm` is POISONED unless a test injects a runner, so nothing in this suite can reach a
 * provider by omission. `askTutor` calls whatever `TutorDeps.run` holds and falls back to this,
 * so the poison is the backstop rather than the path.
 */
function fakeTutorCore(log: Call[], options: FakeOptions): TutorCore {
  const canned = options.tutorReply;
  const runner: TutorCore['runLlm'] = options.tutorRunner
    // POISONED by default. A test that drives an ask without saying what the model answers has
    // not decided what it is testing, and the honest failure is a loud one rather than a canned
    // sentence appearing from nowhere. `the poison is real` below proves this arm is reachable,
    // which is what makes every other test's answer evidence that it went through the seam.
    ?? (canned === undefined
      ? (): Promise<LlmReply> => Promise.reject(new Error(SPEND_GUARD))
      : (): Promise<LlmReply> => Promise.resolve({
        text: canned, inputTokens: 0, outputTokens: 0, usd: 0, metered: false,
      }));
  return {
    // Pure string work, and deliberately recognisable: a test asserting the tutor was told
    // about THIS step reads the prompt this builds.
    buildAskPrompt: (messages: AskMessage[], ctx) =>
      `PROMPT stop=${ctx.stopTitle ?? ''} file=${ctx.file ?? ''} diff=${ctx.build?.learnerDiff ?? ''} turns=${messages.map((m) => `${m.role}:${m.content}`).join('|')}`,
    buildContextBlock: (ctx) => `CONTEXT ${ctx.file ?? ''}`,
    trimMessages: (raw) => (Array.isArray(raw) ? (raw as AskMessage[]) : []),
    resolveChoice: (choice) => ({ provider: choice?.provider ?? 'claude', model: choice?.model ?? 'default' }),
    resolveTutorChoice: (stored, build) => ({
      provider: stored?.provider ?? build.provider,
      model: stored?.model === undefined || stored.model === '' ? 'strongest' : stored.model,
    }),
    runLlm: (prompt, choice, cwd, timeoutMs) => {
      log.push({ fn: 'runLlm', prompt, provider: choice.provider, model: choice.model, cwd, timeoutMs });
      return runner(prompt, choice, cwd, timeoutMs);
    },
    availability: (providerId) => {
      log.push({ fn: 'availability', providerId });
      return Promise.resolve(options.availability ?? { ok: true, detail: 'a stubbed provider probe' });
    },
  };
}

function fakeAdapters(options: FakeOptions = {}): Fake {
  const plan = options.plan ?? fixturePlan();
  const target = options.target ?? TARGET;
  /** Whether this fake is pointed at a real folder — see `fileExists`. */
  const onDisk = options.target !== undefined;
  const missing = new Set((options.missing ?? []).map((rel) => path.join(target, rel)));
  const saved = new Map<string, Progress>();
  if (options.progress) saved.set(target, options.progress);
  const log: Call[] = [];
  const core = fakeCore(log, options);
  const tutorCore = fakeTutorCore(log, options);

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
      if (missing.has(absPath)) return false;
      // A REAL target is answered from the real disk, exactly as `src/extension.ts` wires this
      // (`fs.existsSync`), and the in-memory `TARGET` from the table above. The split is not a
      // convenience: T-5's suites write files into a folder DURING a pass, and "does this file
      // exist" changes its answer in the middle of one. A fake that said `true` throughout
      // could not tell a step whose file the dial just created from one that was already there
      // — which is precisely the difference the reveal turns on (code review finding 2).
      return onDisk ? fs.existsSync(absPath) : true;
    },
    loadPlan: (loadTarget) => {
      log.push({ fn: 'loadPlan', target: loadTarget });
      return plan;
    },
    loadProgress: (loadTarget, forPlan) => {
      log.push({ fn: 'loadProgress', target: loadTarget });
      const found = saved.get(loadTarget);
      // A COPY, exactly as `JSON.parse` hands one back from the real file: a reload drill that
      // only passes because two sessions happen to share one object cannot pass here.
      return found ? structuredClone(found) : emptyProgress(forPlan);
    },
    saveProgress: (saveTarget, progress) => {
      // Logged BEFORE it can throw, deliberately: the real writer fails at the rename, having
      // already been asked to write, and a test that could not see the attempt could not tell
      // "the write failed" apart from "the write was never made".
      log.push({ fn: 'saveProgress', target: saveTarget, progress });
      if (options.saveFails) throw new Error('EACCES: permission denied, rename \'progress.json.tmp\'');
      saved.set(saveTarget, structuredClone(progress));
    },

    // ── T-5 ───────────────────────────────────────────────────────────────────────────────

    loadRequest: (requestTarget) => {
      log.push({ fn: 'loadRequest', target: requestTarget });
      return options.request ?? null;
    },
    core: () => {
      log.push({ fn: 'core' });
      return Promise.resolve(options.coreMissing ? undefined : core);
    },
    // The one adapter wired EXACTLY as `src/extension.ts` will wire it, on purpose: it is the
    // input to the overwrite decision, and a test that answered it from a table in memory
    // while `writeTextAtomic` put real bytes on a real disk would be comparing the session
    // against its own bookkeeping instead of against the learner's folder.
    readText: (absPath) => {
      log.push({ fn: 'readText', absPath });
      try {
        return fs.readFileSync(absPath, 'utf8');
      } catch {
        return undefined;
      }
    },
    confirmOverwrite: (relPath) => {
      log.push({ fn: 'confirmOverwrite', relPath });
      return Promise.resolve(options.overwrite ?? true);
    },
    git: fakeGit(log, options),
    commitPerStep: () => {
      log.push({ fn: 'commitPerStep' });
      return options.commitPerStep ?? true;
    },

    // ── T-6 ─────────────────────────────────────────────────────────────────────────────

    // Spread in rather than assigned, so `noTutor` produces an adapter set with the two keys
    // genuinely ABSENT — which is the shape `test/dial.test.ts` really has, and the shape
    // every suite written before this ticket has been running under all along.
    ...(options.noTutor
      ? {}
      : {
        tutorCore: () => {
          log.push({ fn: 'tutorCore' });
          return Promise.resolve(options.tutorCoreMissing ? undefined : tutorCore);
        },
        tutorSettings: () => {
          log.push({ fn: 'tutorSettings' });
          return {
            provider: options.tutorProvider ?? 'claude',
            model: options.tutorModel ?? '',
            timeoutMs: options.tutorTimeoutMs ?? 5_000,
          };
        },
      }),
  };

  return {
    adapters,
    log,
    names: () => log.map((call) => call.fn),
    stored: () => saved.get(target),
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
  const session = WalkSession.open(options.target ?? TARGET, fake.adapters);
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
      'loadPlan', 'loadProgress', 'loadRequest', 'fileExists', 'setTree', 'setPanel', 'setStatus', 'revealEditor',
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
      'loadPlan', 'loadProgress', 'loadRequest', 'fileExists', 'setTree', 'setPanel', 'setStatus', 'clearEditor',
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
      'loadPlan', 'loadProgress', 'loadRequest', 'setTree', 'setPanel', 'setStatus', 'clearEditor',
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
    assert.deepEqual(fake.names(), ['loadPlan', 'loadProgress', 'loadRequest', 'setTree', 'setPanel', 'setStatus', 'clearEditor'],
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

// ══ T-5 — the dial, the check and the commit ═══════════════════════════════════════════════

/**
 * Everything below runs against a REAL reference tree and a REAL target folder, and that is a
 * change of method worth stating rather than sliding past.
 *
 * The T-4 suites above never touch a disk, because the questions they ask are about which
 * surface got pushed what. T-5's questions are not like that. "manual writes nothing" is a
 * claim about a FOLDER, and its acceptance check is literally that the target tree is unchanged
 * after opening the step — a recording fake asked whether a write adapter had been called would
 * be checking the session's bookkeeping against itself, and would pass just as happily if
 * `writeTextAtomic` put a file down behind its back. "automated writes the reference byte for
 * byte" (AC4/AC6) is a `Buffer.equals` for the same reason, not a comparison of what the
 * session intended; and the overwrite prompt's whole subject is a file the learner has edited
 * on disk.
 *
 * So the destination is real, and both of the adapters that ASK about it — `readText` and
 * `fileExists` — are wired here exactly as `src/extension.ts` wires them (`readFileSync`,
 * `existsSync`). `fileExists` matters as much as `readText` and for the same reason: "is this
 * file there" changes its answer in the MIDDLE of an entry pass, and a fake answering from a
 * table cannot tell a file the dial just created from one that was there all along — which is
 * the difference the reveal turns on (code review finding 2). What stays faked is repo-tour's
 * core and `git` — see `fakeCore` and `fakeGit` for why each is a fake rather than a weaker
 * version of the real thing, and which suite owns the real one instead.
 */
suite('the dial, the check and the commit (T-5)', () => {
  /** Holds both trees, so a reference and a target are siblings the way they really are. */
  let box: string;
  /** The repository being copied FROM. `writeFixtureTarget` writes the same three source files
   *  the plan talks about, so the reference and the plan agree about what exists. */
  let refRoot: string;
  /** A fresh EMPTY folder per test: every "was anything written" assertion below is about a
   *  folder that started with nothing in it, which is the only way "nothing" means anything. */
  let target: string;

  suiteSetup(() => {
    box = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-walk-session-'));
    refRoot = path.join(box, 'reference');
    fs.mkdirSync(refRoot, { recursive: true });
    writeFixtureTarget(refRoot);
    // The generated / vendored files repo-tour never turns into steps — see the reproduce
    // suite. Written once, beside the reference's real sources, because that is where a real
    // `plan.reproduce` entry points.
    fs.mkdirSync(path.join(refRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(refRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
    // Deliberately not UTF-8: `reproduceFiles` is the one path that carries files which are not
    // text at all, and a decode anywhere on it would turn these bytes into U+FFFD.
    fs.writeFileSync(path.join(refRoot, 'dist/bundle.js'), Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]));
  });

  setup(() => {
    target = fs.mkdtempSync(path.join(box, 'learner-'));
  });

  suiteTeardown(() => {
    fs.rmSync(box, { recursive: true, force: true });
  });

  /** `request.json` as `loadRequest` hands it over: the RESOLVED reference root, and the
   *  GLOBAL dial. `repo` is only what the learner typed — for a GitHub URL the two differ,
   *  and reading `repo` as a path is what T-5's security review found silently refusing. */
  function request(dial: Dial): ResolvedRequest {
    return { idea: 'a tokenizer', recreate: true, repo: refRoot, referenceRoot: refRoot, target, dial };
  }

  /** A request pointing at a reference that is not there — for the in-memory suites, where the
   *  question is which dial resolves and never what lands on a disk. */
  function nowhereRequest(dial: Dial): ResolvedRequest {
    return { idea: '', recreate: true, repo: '/fixture/reference', referenceRoot: '/fixture/reference', target: TARGET, dial };
  }

  /** Every file under `dir`, relative and sorted. The empty array is the assertion AC2 is
   *  actually about, so it is produced by walking the real tree rather than by asking the
   *  session what it believes it did. */
  function tree(dir: string): string[] {
    const found: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else found.push(next);
      }
    };
    walk('');
    return found.sort();
  }

  function readTarget(rel: string): string | undefined {
    try {
      return fs.readFileSync(path.join(target, rel), 'utf8');
    } catch {
      return undefined;
    }
  }

  function writeTarget(rel: string, source: string): void {
    const abs = path.join(target, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
  }

  /** The same bytes, compared as bytes — AC6 is a `diff -r`, not a string equality that would
   *  forgive a re-encoding. */
  function sameBytes(rel: string): boolean {
    return fs.readFileSync(path.join(target, rel)).equals(fs.readFileSync(path.join(refRoot, rel)));
  }

  /**
   * A session open on the real target with the real reference, parked on `at`, ALREADY SETTLED
   * — the entry pass has run and whatever it writes has landed. Awaiting `settled()` here
   * rather than in every test is the point: the session owns its async, so a test that asserted
   * without waiting would be racing the very behaviour it is testing.
   */
  async function walking(options: FakeOptions & { dial?: Dial; at?: string } = {}): Promise<{
    session: WalkSession; fake: Fake; plan: PlanLike;
  }> {
    const plan = options.plan ?? fixturePlan();
    const fake = fakeAdapters({
      ...options,
      plan,
      target,
      request: options.request ?? request(options.dial ?? 'manual'),
      progress: options.progress ?? setCurrent(emptyProgress(plan), options.at ?? 'st-2-file-parse'),
    });
    const session = WalkSession.open(target, fake.adapters);
    await session.settled();
    return { session, fake, plan };
  }

  /** The plan with the named steps' `kind` flipped to `file`. One id reaches
   *  `src/api/routes.ts` — the only fixture file that has imports — through the file path,
   *  since the fixture's own file step points at `src/parse.ts`, which has none. Several ids
   *  give the plan a RUN of consecutive file steps, which is what a walk that writes on every
   *  arrival needs in order to be walked at all. */
  function asFileStep(...stepIds: string[]): PlanLike {
    const flipped = new Set(stepIds);
    const plan = fixturePlan();
    return {
      ...plan,
      steps: plan.steps.map((step) => (flipped.has(step.id) ? { ...step, kind: 'file' as const } : step)),
    };
  }

  /** The fixture plan plus the generated / vendored files repo-tour never turns into steps. */
  function planWithReproduce(): PlanLike {
    return { ...fixturePlan(), reproduce: ['package-lock.json', 'dist/bundle.js'] };
  }

  /** AC7's subject, spelled out rather than borrowed from `commitSubject`: this is text that
   *  ends up in a learner's own `git log` forever, and a test that computed it the way the code
   *  does would agree with a format change instead of catching one. */
  const STEP_2_SUBJECT = '2: Why does the tokenizer get its own module? — What the author did';

  // ── AC1: global, overridable per step, resolved in ONE place ───────────────────────────────

  suite('the resolved dial (AC1)', () => {
    test('a step with no override of its own resolves to the GLOBAL dial from request.json', () => {
      const plan = fixturePlan();
      const fake = fakeAdapters({
        plan,
        // A `symbol` step, so nothing is written and this test is about resolution alone.
        progress: setCurrent(emptyProgress(plan), 'st-3-symbol-handle'),
        request: nowhereRequest('automated'),
      });
      const session = WalkSession.open(TARGET, fake.adapters);

      assert.equal(session.getView()?.dial, 'automated',
        'T-4 read the per-step override alone and fell back to manual — telling a learner who had set automated that nothing was being written for them');
      assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 3 / 4 · automated',
        'and the status bar reads that same resolution rather than running a second one of its own');
    });

    test('a per-step override beats the global', () => {
      const plan = fixturePlan();
      const parked = setCurrent(emptyProgress(plan), 'st-3-symbol-handle');
      const fake = fakeAdapters({
        plan,
        progress: setDial(parked, 'st-3-symbol-handle', 'manual'),
        request: nowhereRequest('automated'),
      });

      assert.equal(WalkSession.open(TARGET, fake.adapters).getView()?.dial, 'manual',
        'the whole of "global, and overridable per step" is that the override wins');
    });

    test('no request.json at all falls back to manual — the one position that cannot overstate what happened', () => {
      const plan = fixturePlan();
      const fake = fakeAdapters({ plan, progress: setCurrent(emptyProgress(plan), 'st-3-symbol-handle') });

      assert.equal(WalkSession.open(TARGET, fake.adapters).getView()?.dial, 'manual');
      assert.equal(pick(fake, 'setStatus')[0]?.text, 'step 3 / 4 · manual');
    });

    test('the dial travels on the SAME snapshot the tree, the panel and the editor were handed', () => {
      const plan = fixturePlan();
      const fake = fakeAdapters({
        plan,
        progress: setCurrent(emptyProgress(plan), 'st-3-symbol-handle'),
        request: nowhereRequest('scaffolded'),
      });
      const session = WalkSession.open(TARGET, fake.adapters);

      assert.equal(pick(fake, 'setTree')[0]?.view, session.getView());
      assert.equal(pick(fake, 'setPanel')[0]?.view?.dial, 'scaffolded');
      assert.equal(pick(fake, 'revealEditor')[0]?.view.dial, 'scaffolded',
        'four surfaces, one answer — a surface that re-derived the dial would be a second one');
    });

    test('request.json is read ONCE, at open, so a walk’s global dial cannot drift under it', () => {
      const { fake } = opened({ request: nowhereRequest('automated') });
      // `opened` forgets the opening calls, so anything appearing here is a SECOND read.
      assert.deepEqual(pick(fake, 'loadRequest'), [],
        'AC1: the global setting never drifts toward automated on its own, and a value read once cannot drift at all');
    });
  });

  // ── AC2: manual writes nothing ─────────────────────────────────────────────────────────────

  suite('manual — the extension writes nothing at all (AC2)', () => {
    test('the target tree is UNCHANGED after opening a file step', async () => {
      const { fake } = await walking({ dial: 'manual' });

      assert.deepEqual(tree(target), [],
        'not an empty file, not a directory: nothing. The learner creates the file, which is the entire point of the position');
      assert.deepEqual(pick(fake, 'stubFile'), [], 'the core is not even asked to stub anything');
      assert.deepEqual(pick(fake, 'confirmOverwrite'), [], 'and nobody is asked about a file that was never going to be written');
      assert.deepEqual(pick(fake, 'saveProgress'), [], 'merely looking at a manual step writes no progress either');
    });

    test('the panel is handed the file’s SHAPE instead — the signature line, never the body', async () => {
      const { session } = await walking({ dial: 'manual' });

      assert.deepEqual(session.getView()?.shape, {
        // Line 1 of the reference's `src/parse.ts`, where its load-bearing range starts.
        signatures: ['export interface Token {'],
        imports: [],
      }, 'parse.ts imports nothing, so an empty list is the honest answer rather than a missing one');
    });

    test('a file that has imports shows them too', async () => {
      const { session } = await walking({
        dial: 'manual',
        plan: asFileStep('st-3-symbol-handle'),
        at: 'st-3-symbol-handle',
      });

      assert.deepEqual(session.getView()?.shape, {
        signatures: ['export function handleRequest(body: string): string {'],
        imports: ['import { tokenize } from \'../parse.js\';'],
      });
      assert.deepEqual(tree(target), [], 'and still nothing on disk');
    });

    test('a symbol step has no shape at all — it lives inside a file some earlier step wrote', async () => {
      const { session } = await walking({ dial: 'manual', at: 'st-3-symbol-handle' });

      assert.equal(session.getView()?.shape, undefined);
      assert.equal('shape' in (session.getView() ?? {}), false,
        'absent rather than undefined: the panel keys its repaints on which fields it is rendering');
    });
  });

  // ── AC3 / AC4: the two positions that write ────────────────────────────────────────────────

  suite('scaffolded — the core’s stubs, never the reference (AC3)', () => {
    test('what lands on disk is what the CORE produced', async () => {
      await walking({ dial: 'scaffolded' });

      assert.equal(readTarget('src/parse.ts'), STUB_OUTPUT);
      assert.notEqual(readTarget('src/parse.ts'), fs.readFileSync(path.join(refRoot, 'src/parse.ts'), 'utf8'),
        'a scaffold that was the reference file would hand over the answer under the label of a hint');
    });

    test('the core is handed this step’s language, its ranges in PLAN order, and the questions its stubs name', async () => {
      const { fake } = await walking({ dial: 'scaffolded' });

      assert.deepEqual(pick(fake, 'stubFile'), [{
        fn: 'stubFile',
        language: 'typescript',
        ranges: [{ startLine: 1, endLine: 12 }],
        questions: [{ ordinal: 2, question: 'Why does the tokenizer get its own module?' }],
      }]);
    });

    test('a scaffolded step is NOT marked done and is NOT committed — the learner still has to fill it in', async () => {
      const { fake } = await walking({ dial: 'scaffolded' });

      assert.notEqual(fake.stored()?.steps['st-2-file-parse']?.status, 'done');
      assert.deepEqual(pick(fake, 'git'), [],
        'AC7 commits a step that PASSED, or one that was automated; a scaffold is neither yet');
    });

    test('the panel is told, in a sentence, that a file appeared under the learner', async () => {
      const { session } = await walking({ dial: 'scaffolded' });

      assert.match(session.getView()?.writeNote ?? '', /src\/parse\.ts was written for you/);
    });
  });

  suite('automated — the reference file, byte for byte (AC4, AC6, AC7)', () => {
    test('the bytes are IDENTICAL to the reference — nothing on this path normalises anything', async () => {
      const { fake } = await walking({ dial: 'automated' });

      assert.ok(sameBytes('src/parse.ts'),
        'AC6 is checked by diff -r against the reference repository, so a trailing newline added here is a failed acceptance run');
      assert.deepEqual(pick(fake, 'stubFile'), [], 'automated never asks the core to stub anything');
    });

    test('the step is marked done and committed, naming the ordinal, the question and the option taken', async () => {
      const { fake } = await walking({ dial: 'automated' });

      assert.equal(fake.stored()?.steps['st-2-file-parse']?.status, 'done',
        'an automated step has no check to pass — the file IS the reference, so arriving with it written is what completing it means');
      assert.deepEqual(pick(fake, 'git').map((call) => call.args), [
        ['rev-parse', '--is-inside-work-tree'],
        ['init', '-q'],
        ['config', 'user.name'],
        ['config', 'user.email'],
        ['add', '--', path.join(target, 'src/parse.ts')],
        ['commit', '-q', '-m', STEP_2_SUBJECT, '--', path.join(target, 'src/parse.ts')],
      ], 'the step\'s own file, and the commit NAMES it rather than taking whatever the index holds — what that pathspec actually commits is proven against real git in dial-commit.test.ts, since an argv assertion against a fake can only ever show what was asked for');
    });

    test('re-entering a step already written writes nothing, says nothing, and commits nothing more', async () => {
      const { session, fake } = await walking({ dial: 'automated' });
      const written = fs.readFileSync(path.join(target, 'src/parse.ts'));
      fake.clearLog();

      session.goTo('st-2-file-parse');
      await session.settled();

      assert.ok(fs.readFileSync(path.join(target, 'src/parse.ts')).equals(written));
      assert.deepEqual(pick(fake, 'git'), [],
        'git commit on an unchanged file fails with "nothing to commit", which would surface as a refusal that never happened');
      assert.deepEqual(pick(fake, 'confirmOverwrite'), [], 'identical content is not a conflict');
      assert.equal(session.getView()?.writeNote, undefined,
        'and a re-entered step must not re-announce a write that happened ten clicks ago');
    });
  });

  /**
   * Code review finding 2. `refresh(true)` — the only path that reaches `revealEditor` — runs
   * inside `goTo`/`open`, which is BEFORE the entry pass has written anything: `fileExists` is
   * false at that moment, so the session calls `clearEditor()`, and every push after the write
   * lands is `refresh(false)`. So in scaffolded and automated — the two positions this ticket
   * exists for — the first arrival at every `file` step blanked the editor's decorations, wrote
   * the file, told the learner it had been written for them, and showed them nothing. AC4 asks
   * for reveal + decoration on the automated path.
   */
  suite('the reveal the write earns (AC4, code review finding 2)', () => {
    test('the arrival that writes the file is the arrival that reveals it', async () => {
      const { session, fake } = await walking({ dial: 'automated' });

      assert.deepEqual(pick(fake, 'revealEditor').map((call) => call.view.step.id), ['st-2-file-parse'],
        'nothing existed to reveal when the walk arrived, so the pass that made the file exist is the only thing that can show it');
      assert.equal(pick(fake, 'revealEditor')[0]?.view.fileExists, true);
      assert.deepEqual(fake.names().filter((fn) => fn === 'clearEditor' || fn === 'revealEditor'),
        ['clearEditor', 'revealEditor'],
        'the clear was honest — there really was nothing there yet — and it is not the end of the story');
      assert.match(session.getView()?.writeNote ?? '', /written for you/,
        'the sentence and the reveal describe the same moment: the panel saying so over an editor showing nothing is the whole of finding 2');
    });

    test('a step re-entered is revealed by the NAVIGATION, and not a second time by the pass', async () => {
      const { session, fake } = await walking({ dial: 'automated' });
      fake.clearLog();

      session.goTo('st-2-file-parse');
      await session.settled();

      assert.equal(pick(fake, 'revealEditor').length, 1,
        'the file is there, so goTo reveals it and the pass has nothing to add — re-centring the editor under a learner reading it is the jank setDial\'s no-reveal rule exists to avoid');
    });

    test('Keep mine reveals nothing of its own — what is on screen is still the learner\'s file', async () => {
      writeTarget('src/parse.ts', 'export function tokenize() {\n  return [];  // my own attempt\n}\n');
      const { fake } = await walking({ dial: 'automated', overwrite: false });

      assert.equal(pick(fake, 'revealEditor').length, 1, 'the arrival\'s own: the file existed all along');
      assert.deepEqual(pick(fake, 'clearEditor'), []);
    });

    test('a pass the walk has already moved PAST writes its file and reveals nothing', async () => {
      const { session, fake } = await walking({
        dial: 'automated',
        plan: asFileStep('st-3-symbol-handle', 'st-4-symbol-render'),
      });
      fake.clearLog();

      session.next();
      session.next();
      await session.settled();

      assert.deepEqual(pick(fake, 'revealEditor').map((call) => call.view.step.id), ['st-4-symbol-render'],
        'a deferred pass still writes its own step\'s file, but the reveal is about where the LEARNER is — dragging the editor onto a step they have walked past is not a fix for finding 2 but a second bug');
      assert.deepEqual(fake.names().filter((fn) => fn === 'clearEditor' || fn === 'revealEditor'),
        ['clearEditor', 'clearEditor', 'revealEditor'],
        'one clear per arrival at a file not written yet, and then the one reveal — a pass that refreshed WITH a reveal from behind the walk would clear the decorations off the step the learner is actually on, since `refresh` reveals whatever is current');
      assert.ok(sameBytes('src/api/routes.ts'), 'and the pass it belonged to still did its work');
    });
  });

  // ── never overwrite a learner's edits silently ─────────────────────────────────────────────

  suite('the Overwrite / Keep mine prompt', () => {
    /** The learner's own version of the step's file: real, on disk, and different. */
    const LEARNER_VERSION = 'export function tokenize() {\n  return [];  // my own attempt\n}\n';

    test('a file that already holds exactly these bytes is not a conflict — no prompt, no rewrite', async () => {
      writeTarget('src/parse.ts', fs.readFileSync(path.join(refRoot, 'src/parse.ts'), 'utf8'));
      const { fake } = await walking({ dial: 'automated' });

      assert.deepEqual(pick(fake, 'confirmOverwrite'), [],
        'prompting here would train the learner to dismiss the one dialog that exists to protect their work');
      assert.ok(sameBytes('src/parse.ts'));
    });

    test('a file that DIFFERS is asked about, exactly once', async () => {
      writeTarget('src/parse.ts', LEARNER_VERSION);
      const { fake } = await walking({ dial: 'automated' });

      assert.deepEqual(pick(fake, 'confirmOverwrite').map((call) => call.relPath), ['src/parse.ts'],
        'the RELATIVE path, because it is shown to a person who thinks in the paths their editor shows them');
    });

    test('Keep mine leaves the learner’s file exactly as it was, and says so', async () => {
      writeTarget('src/parse.ts', LEARNER_VERSION);
      const { session, fake } = await walking({ dial: 'automated', overwrite: false });

      assert.equal(readTarget('src/parse.ts'), LEARNER_VERSION, 'not one byte of it was touched');
      assert.match(session.getView()?.writeNote ?? '', /kept/);
      assert.notEqual(fake.stored()?.steps['st-2-file-parse']?.status, 'done',
        'a step whose file is the learner’s own is not an automated step that completed');
      assert.deepEqual(pick(fake, 'git'), [], 'and nothing was committed on its behalf');
    });

    test('the prompt is raised ONCE per (step, file) however many times the tree fires goTo', async () => {
      writeTarget('src/parse.ts', LEARNER_VERSION);
      const { session, fake } = await walking({ dial: 'automated', overwrite: false });

      // Clicking the step you are already on is how a learner asks for their file back, so the
      // tree really does re-fire `goTo` — this is the plan's named write-ahead risk, not a
      // hypothetical one.
      session.goTo('st-2-file-parse');
      await session.settled();
      session.goTo('st-2-file-parse');
      await session.settled();
      session.next();
      await session.settled();
      session.prev();
      await session.settled();

      assert.equal(pick(fake, 'confirmOverwrite').length, 1,
        'an unremembered prompt reappears on every click until it gets the answer it wants');
      assert.equal(readTarget('src/parse.ts'), LEARNER_VERSION,
        'and Keep mine goes on meaning keep mine — a decision that expired on the next click would be the most expensive bug this file can have');
    });

    test('Overwrite really overwrites, and is not asked again either', async () => {
      writeTarget('src/parse.ts', LEARNER_VERSION);
      const { session, fake } = await walking({ dial: 'automated', overwrite: true });

      assert.ok(sameBytes('src/parse.ts'), 'the learner asked for this step’s version, so they get it byte for byte');
      session.goTo('st-2-file-parse');
      await session.settled();
      assert.equal(pick(fake, 'confirmOverwrite').length, 1,
        'the file now matches, so the second pass has nothing to ask about in the first place');
    });

    /**
     * Code review finding 5. The remembered answer was keyed by `${step.id} ${absPath}` and
     * nothing else, so it also answered an explicit `dial:set` on that very step — and one
     * *Keep mine* therefore killed the dial for that step for the rest of the session,
     * contradicting the promise `setDial` makes in its own header ("drag it to automated and
     * the file should be there"). A learner who dismissed the modal once had no way back short
     * of reloading the window.
     */
    test('one Keep mine does not kill the dial: an explicit dial change on that step may ask again', async () => {
      writeTarget('src/parse.ts', LEARNER_VERSION);
      const { session, fake } = await walking({ dial: 'automated', overwrite: false });
      assert.equal(pick(fake, 'confirmOverwrite').length, 1, 'the arrival asked, and was told to keep');

      // The tree re-firing `goTo` is still answered from memory — that is the rule, and it is
      // the reason `prompted` exists at all.
      session.goTo('st-2-file-parse');
      await session.settled();
      assert.equal(pick(fake, 'confirmOverwrite').length, 1);

      // Moving the control is not the tree re-firing. It is a person asking for something.
      session.setDial('st-2-file-parse', 'scaffolded');
      await session.settled();

      assert.equal(pick(fake, 'confirmOverwrite').length, 2,
        'the prompt-once rule is about the entry pass the tree re-fires, never about a new deliberate gesture');
      assert.equal(readTarget('src/parse.ts'), LEARNER_VERSION, 'and Keep mine, said twice, still means keep mine');
    });

    test('and the second answer is obeyed — Overwrite after a Keep really writes', async () => {
      writeTarget('src/parse.ts', LEARNER_VERSION);
      let answer = false;
      const plan = fixturePlan();
      const fake = fakeAdapters({
        plan,
        target,
        request: request('automated'),
        progress: setCurrent(emptyProgress(plan), 'st-2-file-parse'),
      });
      const session = WalkSession.open(target, { ...fake.adapters, confirmOverwrite: () => Promise.resolve(answer) });
      await session.settled();
      assert.equal(readTarget('src/parse.ts'), LEARNER_VERSION, 'kept, as they asked the first time');

      answer = true;
      session.setDial('st-2-file-parse', 'automated');
      await session.settled();

      assert.ok(sameBytes('src/parse.ts'),
        'drag it to automated and the file should be there — an answer remembered past the gesture it was given for is a dial that does nothing');
    });
  });

  // ── AC5: Check my work ─────────────────────────────────────────────────────────────────────

  suite('runCheck — the verdict, and what a pass earns (AC5, AC7)', () => {
    test('a pass stores the verdict, marks the step done, and does both in ONE write', async () => {
      const { session, fake } = await walking({ dial: 'automated', commitPerStep: false });
      fake.clearLog();

      session.runCheck();
      await session.settled();

      const recorded = fake.stored()?.steps['st-2-file-parse'];
      assert.equal(recorded?.check?.ok, true);
      assert.match(recorded?.check?.at ?? '', /^\d{4}-\d{2}-\d{2}T/, 'an ISO instant, so a surface can say WHEN as well as whether');
      assert.equal(recorded?.status, 'done');
      assert.equal(pick(fake, 'saveProgress').length, 1,
        '"this check passed" and "this step is done" are the same fact; writing them separately leaves a window claiming one without the other');
    });

    test('the full report reaches the view; only the durable half reaches progress', async () => {
      const { session } = await walking({ dial: 'automated' });
      session.runCheck();
      await session.settled();

      const view = session.getView();
      assert.deepEqual(view?.check?.report, okReport(), 'the panel renders present / missing / extra per symbol');
      assert.match(view?.check?.summary ?? '', /every part is there/, 'and one line above it that carries the finding on its own');
      assert.deepEqual(Object.keys(view?.progress.steps['st-2-file-parse']?.check ?? {}).sort(), ['at', 'ok'],
        'progress carries the verdict and the instant and no report — a reload honestly shows none rather than remembering one it never stored');
    });

    test('a failing check records the verdict, leaves the step PENDING, and commits nothing', async () => {
      const { session, fake } = await walking({ dial: 'scaffolded', report: failingReport() });
      fake.clearLog();

      session.runCheck();
      await session.settled();

      const recorded = fake.stored()?.steps['st-2-file-parse'];
      assert.equal(recorded?.check?.ok, false);
      assert.notEqual(recorded?.status, 'done', 'a check that ran and failed is a step still being worked on');
      assert.deepEqual(pick(fake, 'git'), []);
      assert.match(session.getView()?.check?.summary ?? '', /missing export: tokenize/,
        'AC5: a missing export is NAMED — "1 missing" is a riddle, "missing export: tokenize" is a next action');
    });

    test('the learner’s own source is what gets compared, read back off their disk', async () => {
      const mine = 'export function tokenize(): string[] {\n  return [];\n}\n';
      writeTarget('src/parse.ts', mine);
      const { session, fake } = await walking({ dial: 'manual' });

      session.runCheck();
      await session.settled();

      assert.equal(pick(fake, 'coreCheck')[0]?.learnerSource, mine);
      assert.equal(pick(fake, 'coreCheck')[0]?.language, 'typescript');
      assert.equal(pick(fake, 'coreExtract')[0]?.root, refRoot,
        'compared against the REFERENCE, which is the only thing that knows what shape the file is supposed to have');
    });

    test('a null check is NOT a failure — nothing recorded, nothing marked, nothing reported', async () => {
      // Manual mode with nothing written yet: the commonest state `runCheck` sees, and the one
      // that must never mark a step wrong. `null` is not a verdict.
      const { session, fake } = await walking({ dial: 'manual' });
      assert.deepEqual(tree(target), [], 'the premise: the learner has not created the file yet');
      fake.clearLog();

      session.runCheck();
      await session.settled();

      assert.equal(fake.stored()?.steps['st-2-file-parse']?.check, undefined,
        'no verdict at all — "checked and failed" and "not checked" are different things, and the tree draws them differently');
      assert.notEqual(fake.stored()?.steps['st-2-file-parse']?.status, 'done');
      assert.deepEqual(pick(fake, 'reportError'), [],
        'and nothing is put in front of a learner who has simply not written the file yet');
      assert.deepEqual(pick(fake, 'coreCheck'), [],
        'the core is never even reached — a missing file costs a failed read, not a parse of the reference');
      assert.match(session.getView()?.writeNote ?? '', /nothing to check here yet/,
        'said, not swallowed: a pressed button that does nothing and explains nothing is what the walk’s conventions rule out');
    });

    test('a THROWING core is the opposite case, and it goes to the learner', async () => {
      const { session, fake } = await walking({ dial: 'automated', coreThrows: true });
      fake.clearLog();

      session.runCheck();
      await session.settled();

      assert.equal(pick(fake, 'reportError').length, 1,
        'an unloadable core or a missing grammar is real breakage — answering it with "nothing to check" leaves a learner pressing the button forever');
      assert.match(pick(fake, 'reportError')[0]?.message ?? '', /grammar/);
      assert.equal(fake.stored()?.steps['st-2-file-parse']?.check, undefined, 'and no verdict is invented out of a failure');
    });

    test('a core that will not load at all is reported ONCE, however many steps are walked', async () => {
      const { session, fake } = await walking({ dial: 'scaffolded', coreMissing: true });

      session.runCheck();
      await session.settled();
      session.goTo('st-3-symbol-handle');
      await session.settled();
      session.goTo('st-2-file-parse');
      await session.settled();

      assert.equal(pick(fake, 'reportError').length, 1,
        'a standing condition the doctor explains is stated once and then endured quietly');
      assert.deepEqual(tree(target), [],
        'and nothing is written without it — a "scaffold" that skipped stubFile would BE the answer');
    });

    test('pressing Check twice on a step already passed does not commit twice', async () => {
      const { session, fake } = await walking({ dial: 'scaffolded' });
      session.runCheck();
      await session.settled();
      const first = pick(fake, 'git').length;
      fake.clearLog();

      session.runCheck();
      await session.settled();

      assert.ok(first > 0, 'the first pass really did commit');
      assert.deepEqual(pick(fake, 'git'), [],
        'ONE commit per step, not one per click — a second git commit on an unchanged file fails with "nothing to commit"');
    });
  });

  suite('the commit per completed step (AC7)', () => {
    test('buildTutorials.commitPerStep off means git is never invoked at all', async () => {
      const { session, fake } = await walking({ dial: 'scaffolded', commitPerStep: false });
      session.runCheck();
      await session.settled();

      assert.equal(fake.stored()?.steps['st-2-file-parse']?.status, 'done', 'the step still completed');
      assert.deepEqual(pick(fake, 'git'), [], 'the setting turns the commit off, not the check');
    });

    test('no git identity: nothing is committed, the panel says why, and the learner is told once', async () => {
      const { session, fake } = await walking({ dial: 'scaffolded', noGitIdentity: true });
      session.runCheck();
      await session.settled();

      assert.deepEqual(pick(fake, 'git').map((call) => call.args[0]), ['rev-parse', 'init', 'config', 'config'],
        'it never reaches commit — a tutorial inventing an author on a repository the learner will keep and push is graffiti with a signature');
      assert.match(session.getView()?.writeNote ?? '', /was not committed/);
      assert.equal(pick(fake, 'reportError').length, 1);
      assert.match(pick(fake, 'reportError')[0]?.message ?? '', /git config user\.name/,
        'and it says exactly what they would type to fix it');
    });

    test('any other git failure comes back the same way, never as a rejected promise', async () => {
      const { session, fake } = await walking({
        dial: 'scaffolded',
        gitFails: 'fatal: Unable to create \'.git/index.lock\': File exists.',
      });
      session.runCheck();
      await session.settled();

      assert.equal(fake.stored()?.steps['st-2-file-parse']?.status, 'done', 'the step passed; only the bookkeeping failed');
      assert.match(session.getView()?.writeNote ?? '', /index\.lock/);
    });

    test('a refusal that is not about an identity does not tell them to configure one (code review finding 8)', async () => {
      const { session, fake } = await walking({
        dial: 'scaffolded',
        gitFails: 'fatal: Unable to create \'.git/index.lock\': File exists.',
      });
      session.runCheck();
      await session.settled();

      const message = pick(fake, 'reportError')[0]?.message ?? '';
      assert.equal(pick(fake, 'reportError').length, 1);
      assert.match(message, /index\.lock/, 'the reason is the half they can act on, so it is carried either way');
      assert.doesNotMatch(message, /git config/,
        '"set git config user.name" is an instruction that fixes nothing here, and it points them away from the sentence that says what actually happened');
    });
  });

  // ── AC6: the files that are never taught ───────────────────────────────────────────────────

  suite('reproduce — the never-taught files (AC6)', () => {
    test('copies every entry byte for byte and records when it happened', async () => {
      const { session, fake } = await walking({ dial: 'manual', plan: planWithReproduce() });
      fake.clearLog();

      session.reproduce();
      await session.settled();

      assert.deepEqual(tree(target), ['dist/bundle.js', 'package-lock.json']);
      assert.ok(sameBytes('dist/bundle.js'),
        'bytes, never a string: this is the one path that carries files which are not text at all');
      assert.match(fake.stored()?.reproduced ?? '', /^\d{4}-\d{2}-\d{2}T/);
    });

    test('the view offers the count until it has been taken, and then says it is done', async () => {
      const { session } = await walking({ dial: 'manual', plan: planWithReproduce() });

      assert.deepEqual(session.getView()?.reproduce, { count: 2, done: false });
      session.reproduce();
      await session.settled();
      assert.deepEqual(session.getView()?.reproduce, { count: 2, done: true });
    });

    test('a plan that lists none offers nothing, rather than an offer of nothing', async () => {
      const { session } = await walking({ dial: 'manual' });

      assert.equal(session.getView()?.reproduce, undefined);
      assert.equal('reproduce' in (session.getView() ?? {}), false);
    });

    test('automated runs it before the first file step, unasked, and only once', async () => {
      const { session, fake } = await walking({ dial: 'automated', plan: planWithReproduce() });

      assert.deepEqual(tree(target), ['dist/bundle.js', 'package-lock.json', 'src/parse.ts'],
        'AC6’s diff -r can only come back clean because the file steps and this list TOGETHER cover every file the inventory saw');
      const stampedAt = fake.stored()?.reproduced;
      assert.notEqual(stampedAt, undefined);
      fs.rmSync(path.join(target, 'package-lock.json'));

      session.goTo('st-2-file-parse');
      await session.settled();

      assert.equal(fake.stored()?.reproduced, stampedAt, 'the same instant, not a fresh one');
      assert.deepEqual(tree(target), ['dist/bundle.js', 'src/parse.ts'],
        'progress.reproduced is what remembers it, so walking back through the step copies nothing again — even a file deleted since');
    });

    test('pressing it again once it is done says so rather than doing nothing', async () => {
      const { session, fake } = await walking({ dial: 'manual', plan: planWithReproduce() });
      session.reproduce();
      await session.settled();
      fake.clearLog();

      session.reproduce();
      await session.settled();

      assert.deepEqual(pick(fake, 'saveProgress'), []);
      assert.match(session.getView()?.writeNote ?? '', /already been copied/);
    });

    /**
     * Security review finding 3 / code review finding 6. `reproduceFiles` overwrote whatever it
     * found, with no comparison and no count — from `applyDial` (so: on open, and on every
     * `goTo` in automated mode) and from a palette command that is always available. The case
     * is not exotic: the learner runs `npm install` in the target to try the app — which the
     * spec leaves to them on purpose — and the next reproduce silently replaces their
     * `package-lock.json`. `reproduce`'s files are the learner's to have edited like any other.
     */
    suite('a generated file the learner has since changed (security review finding 3)', () => {
      const MY_LOCKFILE = '{ "lockfileVersion": 3, "packages": { "": { "name": "mine" } } }\n';

      test('the press that would replace one copies nothing, and says how many and which', async () => {
        writeTarget('package-lock.json', MY_LOCKFILE);
        const { session, fake } = await walking({ dial: 'manual', plan: planWithReproduce() });
        fake.clearLog();

        session.reproduce();
        await session.settled();

        assert.equal(readTarget('package-lock.json'), MY_LOCKFILE, 'not one byte of theirs');
        assert.deepEqual(tree(target), ['package-lock.json'],
          'the list is copied as ONE act and recorded as one instant, so it is held as one too');
        assert.match(session.getView()?.writeNote ?? '', /Nothing was copied/);
        assert.match(session.getView()?.writeNote ?? '', /package-lock\.json/, 'named, not counted at them');
        assert.equal(fake.stored()?.reproduced, undefined, 'nothing happened, so nothing is recorded as having');
        assert.deepEqual(session.getView()?.reproduce, { count: 2, done: false },
          'and the offer stays on the page, which is how they say yes');
      });

      test('the press after that is the gesture, and it replaces them', async () => {
        writeTarget('package-lock.json', MY_LOCKFILE);
        const { session, fake } = await walking({ dial: 'manual', plan: planWithReproduce() });

        session.reproduce();
        await session.settled();
        session.reproduce();
        await session.settled();

        assert.ok(sameBytes('package-lock.json'), 'asked with the count in front of them, and answered');
        assert.deepEqual(tree(target), ['dist/bundle.js', 'package-lock.json'], 'and the rest of the list came with it');
        assert.match(session.getView()?.writeNote ?? '', /was replaced/);
        assert.notEqual(fake.stored()?.reproduced, undefined);
      });

      test('a file that already holds the reference\'s bytes is not a replacement and is never mentioned', async () => {
        writeTarget('package-lock.json', fs.readFileSync(path.join(refRoot, 'package-lock.json'), 'utf8'));
        const { session } = await walking({ dial: 'manual', plan: planWithReproduce() });

        session.reproduce();
        await session.settled();

        assert.deepEqual(tree(target), ['dist/bundle.js', 'package-lock.json'],
          'the identical-bytes short-circuit writeFile has always had, on this path too: one press, no warning about a file nobody is losing');
        assert.equal(session.getView()?.writeNote, undefined);
      });

      test('two binaries that DECODE the same are not identical — a lossy read is no evidence at all', async () => {
        // The premise, proven rather than assumed, exactly as the AC6 acceptance run proves its
        // own byte comparison: 0xff and 0xfe are both invalid UTF-8 starts, so both decode to
        // U+FFFD and a STRING comparison cannot tell these two files apart.
        const reference = fs.readFileSync(path.join(refRoot, 'dist/bundle.js'));
        const mine = Buffer.from(reference);
        mine[1] = 0xfe; // was 0xff
        assert.notDeepEqual(mine, reference, 'the bytes really do differ');
        assert.equal(mine.toString('utf8'), reference.toString('utf8'), 'and a decode really cannot see it');
        fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(target, 'dist/bundle.js'), mine);

        const { session } = await walking({ dial: 'manual', plan: planWithReproduce() });
        session.reproduce();
        await session.settled();

        assert.ok(fs.readFileSync(path.join(target, 'dist/bundle.js')).equals(mine),
          'a decode that lost something is not proof the bytes match — and reproduce is the one path that carries files which are not text at all');
        assert.match(session.getView()?.writeNote ?? '', /dist\/bundle\.js/);
      });

      test('an arrival in automated mode is not a gesture: it copies nothing and says so alongside its own write', async () => {
        writeTarget('package-lock.json', MY_LOCKFILE);
        const { session, fake } = await walking({ dial: 'automated', plan: planWithReproduce() });

        assert.equal(readTarget('package-lock.json'), MY_LOCKFILE, 'this pass ran on activation, with no gesture anywhere near it');
        assert.deepEqual(tree(target), ['package-lock.json', 'src/parse.ts'],
          'the STEP\'s own file is still written — the dial is what the learner asked for; the never-taught list is not');
        assert.equal(fake.stored()?.reproduced, undefined);
        assert.match(session.getView()?.writeNote ?? '', /package-lock\.json/);
        assert.match(session.getView()?.writeNote ?? '', /written for you/,
          'one line, both sentences: the pass has something to say about the step\'s file AND about the files nobody asked about');
      });

      test('said once, not once per step — the offer carries the count for as long as it stands', async () => {
        writeTarget('package-lock.json', MY_LOCKFILE);
        const plan: PlanLike = { ...asFileStep('st-3-symbol-handle'), reproduce: ['package-lock.json', 'dist/bundle.js'] };
        const { session } = await walking({ dial: 'automated', plan });
        assert.match(session.getView()?.writeNote ?? '', /Nothing was copied/, 'said on the first automated step');

        session.next();
        await session.settled();

        assert.doesNotMatch(session.getView()?.writeNote ?? '', /Nothing was copied/,
          'a standing condition with a button next to it is stated once, the same rule the core and the commit notices follow');
        assert.match(session.getView()?.writeNote ?? '', /routes\.ts was written for you/);
        assert.equal(readTarget('package-lock.json'), MY_LOCKFILE);
      });
    });
  });

  // ── the plumbing the asynchronous half adds ────────────────────────────────────────────────

  suite('the asynchronous half is OWNED, never voided', () => {
    test('a plan whose file leaves the target folder is refused in words — not written, not thrown', async () => {
      const plan = fixturePlan();
      const escaping: PlanLike = {
        ...plan,
        steps: plan.steps.map((step) => (
          step.id === 'st-2-file-parse' ? { ...step, target: { ...step.target, file: '../../escaped.ts' } } : step
        )),
      };
      const { session, fake } = await walking({ dial: 'automated', plan: escaping });

      assert.deepEqual(tree(target), []);
      assert.match(session.getView()?.writeNote ?? '', /points outside the folder you are building in/);
      assert.deepEqual(pick(fake, 'reportError'), [],
        'the learner did not write the plan, so a refusal is shown where they are already looking rather than raised at them');
    });

    test('a session disposed while work is queued does nothing when the queue drains', async () => {
      const { session, fake } = await walking({ dial: 'automated' });
      fake.clearLog();

      session.runCheck();
      session.dispose();
      await session.settled();

      assert.deepEqual(pick(fake, 'coreCheck'), [],
        'a replaced session must not answer a stale click by driving surfaces the new one has already claimed');
      assert.deepEqual(pick(fake, 'saveProgress'), []);
    });

    /**
     * Code review finding 3. `enqueue` re-guards a job that has not STARTED; `applyDial`
     * re-guards itself at three points after its awaits; `applyCheck` re-guarded NOWHERE,
     * across `await core()` and a two-parse structural check. A disposed session then wrote
     * `progress.json`, repainted all three surfaces — undoing the clear `dispose()` had just
     * pushed, or painting over the replacement session's view — and ran git. `openWalkAt`
     * disposes and re-opens on the same folder and `deactivate()` disposes, so this is an
     * ordinary gesture rather than a race anyone has to construct.
     */
    suite('a check whose session goes away mid-flight (code review finding 3)', () => {
      /** A session that disposes ITSELF at a chosen point inside the check — the one thing an
       *  `await` cannot see for itself — with the opening pass already settled and forgotten,
       *  so everything the assertions read describes the check alone. */
      async function checkDisposedDuring(work: 'the core load' | 'the parse' | 'the commit'): Promise<Fake> {
        const plan = fixturePlan();
        const fake = fakeAdapters({
          plan,
          target,
          // Scaffolded for the commit case: an automated step is marked done by its own entry
          // pass, and `commitFor` runs once per step — so a check pressed on one has nothing
          // left to commit and the window would never open.
          request: request(work === 'the commit' ? 'scaffolded' : 'automated'),
          progress: setCurrent(emptyProgress(plan), 'st-2-file-parse'),
          // Only the commit case needs a failing git: a commit that SUCCEEDS has nothing left
          // to say, so a session disposed under it would look identical either way.
          ...(work === 'the commit' ? { gitFails: 'fatal: Unable to create \'.git/index.lock\': File exists.' } : {}),
        });
        const walk: { session?: WalkSession } = {};
        let armed = false;
        walk.session = WalkSession.open(target, {
          ...fake.adapters,
          git: (args, cwd) => {
            if (armed && work === 'the commit' && args[0] === 'commit') walk.session?.dispose();
            return fake.adapters.git(args, cwd);
          },
          core: async () => {
            const core = await fake.adapters.core();
            if (!armed || !core || work === 'the commit') return core;
            if (work === 'the core load') {
              walk.session?.dispose();
              return core;
            }
            return {
              ...core,
              check: (learnerSource, extract, language, relPath) => {
                walk.session?.dispose();
                return core.check(learnerSource, extract, language, relPath);
              },
            };
          },
        });
        await walk.session.settled();
        armed = true;
        fake.clearLog();
        walk.session.runCheck();
        await walk.session.settled();
        return fake;
      }

      test('disposed while the core is loading: nothing persisted, nothing repainted, no git', async () => {
        const fake = await checkDisposedDuring('the core load');

        assert.deepEqual(pick(fake, 'saveProgress'), []);
        assert.deepEqual(pick(fake, 'git'), []);
        assert.deepEqual(pick(fake, 'coreCheck'), [],
          'it does not go on parsing the learner\'s file either — the earlier the check, the less work a dead session does');
        assert.deepEqual(pushedSteps(fake, 'setPanel'), [undefined],
          'the only push after the log was cleared is dispose\'s own "show nothing" — a repaint here undoes it, or paints over the session that replaced this one');
      });

      test('disposed inside the structural check itself — the widest window on this path', async () => {
        const fake = await checkDisposedDuring('the parse');

        assert.equal(pick(fake, 'coreCheck').length, 1, 'the parse really ran: this is disposal DURING the work, not before it');
        assert.deepEqual(pick(fake, 'saveProgress'), [],
          'the one-liner the handoff proposed for this — a disposed check at the top of refresh — would not have reached it, because commit PERSISTS before it refreshes');
        assert.deepEqual(pick(fake, 'git'), [], 'and commitFor runs after the refresh, so it would not have reached that either');
        assert.deepEqual(pushedSteps(fake, 'setPanel'), [undefined]);
      });

      test('disposed inside the commit git runs — the window the handoff flagged and left open', async () => {
        const fake = await checkDisposedDuring('the commit');

        assert.notDeepEqual(pick(fake, 'git'), [], 'the check passed and the commit was really attempted');
        assert.deepEqual(pick(fake, 'reportError'), [],
          'a refusal has nobody left to tell: the panel it would be shown in belongs to whatever comes next');
        assert.deepEqual(pushedSteps(fake, 'setPanel').slice(-1), [undefined],
          'and the last thing the panel was handed is still dispose\'s "show nothing"');
      });
    });

    test('moving the dial on the step in front of the learner applies it at once', async () => {
      const { session } = await walking({ dial: 'manual' });
      assert.deepEqual(tree(target), []);

      session.setDial('st-2-file-parse', 'automated');
      await session.settled();

      assert.deepEqual(tree(target), ['src/parse.ts'],
        'drag the control to automated and the file should be there — that is what the control appears to promise');
    });

    test('moving the dial on some OTHER step only records the choice', async () => {
      const { session } = await walking({ dial: 'manual' });

      session.setDial('st-4-symbol-render', 'automated');
      await session.settled();

      assert.deepEqual(tree(target), [],
        'that step applies it when the learner arrives, which is the same rule open and goTo follow rather than a second one');
    });

    /**
     * The acceptance suite found this one, and it is worth stating what it actually was.
     *
     * `applyDial` opened by returning unless its step was STILL the current one — a staleness
     * check ahead of every `await`, so a pass that had merely been queued behind another was
     * not deferred, it was dropped. Two `next()` calls in one tick (an ordinary double-click on
     * the Next button; a held keybinding repeats the same way) put two passes on the chain
     * before either could run, and the first one found the walk already on the second step and
     * did nothing at all: no file, no `markDone`, no commit, and — the part that made it worth
     * a suite of its own — no `reportError` and no `writeNote` either. A learner would find a
     * file missing from a walk that reported nothing wrong, and `diff -r` would fail AC6 on a
     * gesture nobody would think to mention in a bug report.
     */
    suite('a step the walk enters applies its dial, however fast the learner walks (AC6, AC7)', () => {
      const STEP_3_SUBJECT = '3: Fill in handleRequest — how should this function do its job? — What the author did';
      const STEP_4_SUBJECT = '4: Fill in render — how should a response be turned into markup? — What the author did';

      test('two Next presses in ONE tick write BOTH files and commit BOTH steps', async () => {
        // A RUN of consecutive file steps: the fixture's own single file step cannot be walked
        // past, so it cannot show a pass being skipped.
        const { session, fake } = await walking({
          dial: 'automated',
          plan: asFileStep('st-3-symbol-handle', 'st-4-symbol-render'),
        });
        assert.deepEqual(tree(target), ['src/parse.ts'], 'the step the walk opened on, already applied');
        fake.clearLog();

        // Both navigations land before a single queued job has had a chance to run — which is
        // exactly what a double-click is, and what the old guard could not survive.
        session.next();
        session.next();
        await session.settled();

        assert.deepEqual(tree(target), ['src/api/render.ts', 'src/api/routes.ts', 'src/parse.ts'],
          'AC6 is "walking every step in automated mode reproduces the reference", and clicking Next twice is walking');
        assert.ok(sameBytes('src/api/routes.ts'),
          'the step the walk moved off is still a step the walk ENTERED, and entering a step is what applies its dial');
        assert.ok(sameBytes('src/api/render.ts'));
        assert.deepEqual(
          pick(fake, 'git').filter((call) => call.args[0] === 'commit').map((call) => call.args[3]),
          [STEP_3_SUBJECT, STEP_4_SUBJECT],
          'AC7 is a commit per completed step, and a step whose file was never written completes nothing to commit',
        );
        assert.deepEqual(
          ['st-2-file-parse', 'st-3-symbol-handle', 'st-4-symbol-render'].map((id) => fake.stored()?.steps[id]?.status),
          ['done', 'done', 'done'],
          'and the tree marks every one of them, rather than leaving a hole nobody can account for',
        );
        assert.deepEqual(pick(fake, 'reportError'), [],
          'nothing to report is only honest when nothing was skipped — the dropped pass said nothing either');
        assert.match(session.getView()?.writeNote ?? '', /render\.ts/,
          'the sentence still describes the step in front of the learner, never the one the queue caught up on');
      });

      test('the passes run in the order they were entered, and each writes its own step\'s file', async () => {
        const { session, fake } = await walking({
          dial: 'automated',
          plan: asFileStep('st-3-symbol-handle', 'st-4-symbol-render'),
        });
        fake.clearLog();

        session.next();
        session.next();
        await session.settled();

        assert.deepEqual(pick(fake, 'readText').map((call) => call.absPath),
          [path.join(target, 'src/api/routes.ts'), path.join(target, 'src/api/render.ts')],
          'serialised, in entry order: two passes racing one destination is the one way an atomic write still loses');
      });

      test('a session disposed while the prompt is up writes nothing when the answer arrives', async () => {
        // The one thing that DOES cancel a pass in flight, and the reason the rule is about the
        // session being alive rather than about which step is current: a disposed session's
        // target may already belong to a replacement session writing the same file.
        writeTarget('src/parse.ts', 'export function tokenize() {\n  return [];  // my own attempt\n}\n');
        const before = readTarget('src/parse.ts');
        const plan = fixturePlan();
        const fake = fakeAdapters({
          plan,
          target,
          request: request('automated'),
          progress: setCurrent(emptyProgress(plan), 'st-2-file-parse'),
        });
        const walk: { session?: WalkSession } = {};
        walk.session = WalkSession.open(target, {
          ...fake.adapters,
          // The walk is torn down between the question and the answer — the folder was closed,
          // or a rebuild replaced the session — which is the one thing an `await` inside a pass
          // cannot see for itself.
          confirmOverwrite: async (relPath) => {
            walk.session?.dispose();
            return fake.adapters.confirmOverwrite(relPath);
          },
        });
        await walk.session.settled();

        assert.equal(readTarget('src/parse.ts'), before, 'not one byte of the learner’s file was touched');
        assert.deepEqual(pick(fake, 'saveProgress'), [],
          'and nothing was persisted or pushed on behalf of a walk that is no longer running');
      });
    });
  });
});

// ── T-6: the tutor ─────────────────────────────────────────────────────────────────────────

/**
 * `request.json` pointing at a reference that is not on disk — the T-5 suite keeps a helper of
 * the same name inside its own scope, and this is the in-memory twin of it.
 *
 * It is the right fixture for every suite below, and not merely a convenience. What
 * `src/tutor/context.ts` does with a reference file it cannot find is answer `learnerDiff` with
 * its own `NO_FILE_YET` sentence and spawn no git at all — so these suites are deterministic,
 * touch nothing on disk, and still exercise the REAL context builder rather than a stand-in for
 * it. The one thing they are not about is what a diff looks like; `tutor-context.test.ts` owns
 * that, against real files.
 */
function tutorRequest(): ResolvedRequest {
  return { idea: '', recreate: true, repo: '/fixture/reference', referenceRoot: '/fixture/reference', target: TARGET, dial: 'manual' };
}

/**
 * `WalkSession.ask` / `cancelAsk` — the walk's one asynchronous job that spends money, driven
 * with a fake core and never a provider.
 *
 * What these suites are actually guarding, in the order the criteria are numbered:
 *
 *   - **AC2, the durable half.** A question and its answer are appended to
 *     `progress.steps[id].transcript`, through the same atomic `saveProgress` as everything
 *     else, and read back through `getTranscript`. Switching steps switches transcripts and
 *     returning restores — asserted through a real reload (`dispose` then `open`), not by
 *     asking the session what it remembers.
 *   - **AC3.** What reaches the runner is the step's own context, with the conversation so
 *     far, at the provider and model the settings resolve to, in the LEARNER's folder.
 *   - **AC4, in one sentence: no spinner is ever left running.** Every path is asserted to end
 *     with `tutor.thinking` false — a reply, a timeout, a failure, an unreachable provider, a
 *     cancel, and a session disposed mid-ask. That is the whole criterion, and it is the one
 *     thing a suite of only-happy-path tests would miss.
 *   - **The unreachable / timed out / failed outcomes are NOTES, not turns.** A failure stored
 *     in the transcript would be sent back to the model on the next question as though the
 *     tutor had said it.
 *   - **Not one token is spent.** The fake core's `runLlm` is poisoned unless a test says what
 *     the model answers, so a suite that quietly started dialling out fails rather than bills.
 */
suite('the tutor — asking, and what is remembered (AC2, AC3)', () => {
  const STEP = 'st-2-file-parse';

  /** The tutor block off the last view pushed to the panel — what the page would draw. */
  function tutorOf(fake: Fake): { thinking: boolean; unreachable?: string; note?: string } | undefined {
    const pushes = pick(fake, 'setPanel');
    return pushes[pushes.length - 1]?.view?.tutor;
  }

  /** The transcript as the last push carried it — the panel's copy, not the session's. */
  function shownTranscript(fake: Fake): AskMessage[] {
    const pushes = pick(fake, 'setPanel');
    return pushes[pushes.length - 1]?.view?.transcript ?? [];
  }

  function asking(options: FakeOptions = {}): { session: WalkSession; fake: Fake } {
    const { session, fake } = opened({ request: tutorRequest(), ...options });
    return { session, fake };
  }

  test('a question and its answer both land in the transcript, in order, and on disk', async () => {
    const { session, fake } = asking({ tutorReply: 'Because the parser would otherwise have two jobs.' });

    session.ask('Why not keep it inline?');
    await session.settled();

    assert.deepEqual(getTranscript(session.getView()!.progress, STEP), [
      { role: 'user', content: 'Why not keep it inline?' },
      { role: 'assistant', content: 'Because the parser would otherwise have two jobs.' },
    ]);
    // Through the SAVE, not merely in memory: AC2 is about `progress.json`.
    assert.deepEqual(getTranscript(fake.stored()!, STEP), getTranscript(session.getView()!.progress, STEP));
    assert.deepEqual(shownTranscript(fake), getTranscript(fake.stored()!, STEP), 'and the panel is handed exactly what was stored');
  });

  test('the question is saved BEFORE the model is asked, with the spinner up', async () => {
    // A window closed mid-ask comes back with the question in the conversation and no answer
    // under it, which is what really happened. Recording it only on success would lose
    // questions exactly when a learner most wants to know what they asked.
    let released: (() => void) | undefined;
    const { session, fake } = asking({
      tutorRunner: () => new Promise((resolve) => {
        released = () => resolve({ text: 'late', inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
      }),
    });

    session.ask('why?');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(getTranscript(fake.stored()!, STEP), [{ role: 'user', content: 'why?' }], 'the question is on disk while the model is still thinking');
    assert.equal(tutorOf(fake)?.thinking, true, 'and the page says so');

    released!();
    await session.settled();
    assert.equal(tutorOf(fake)?.thinking, false);
  });

  test('AC3: the runner is handed this step\'s context, the conversation, and the learner\'s folder', async () => {
    const { session, fake } = asking({ tutorReply: 'because', tutorProvider: 'claude', tutorModel: '', tutorTimeoutMs: 9_000 });

    session.ask('why?');
    await session.settled();

    const sent = pick(fake, 'runLlm');
    assert.equal(sent.length, 1, 'one ask is one call — there is no retry and no fallback provider');
    assert.match(sent[0]!.prompt, /stop=Why does the tokenizer/, 'the tutor is told which decision the learner is inside of');
    assert.match(sent[0]!.prompt, /file=src\/parse\.ts/);
    assert.match(sent[0]!.prompt, /diff=The learner has not created this file yet/, 'and how their file differs — here, that there is not one');
    assert.match(sent[0]!.prompt, /turns=user:why\?/, 'with the conversation so far, this question included');
    assert.equal(sent[0]!.cwd, TARGET, 'run in the LEARNER\'s folder, never the reference');
    assert.equal(sent[0]!.timeoutMs, 9_000);
    // `resolveTutorChoice`, not `resolveChoice`: an unset tutor model means the provider's
    // STRONGEST, which is the right way round for the one place a wrong answer is read by
    // somebody who is already confused.
    assert.deepEqual({ provider: sent[0]!.provider, model: sent[0]!.model }, { provider: 'claude', model: 'strongest' });
  });

  test('the settings are read PER ASK, so switching provider mid-walk is obeyed', async () => {
    const { session, fake } = asking({ tutorReply: 'because', tutorProvider: 'codex', tutorModel: 'gpt-5' });

    session.ask('why?');
    await session.settled();

    assert.equal(pick(fake, 'tutorSettings').length, 1, 'read at the moment of the ask, not captured at open');
    assert.deepEqual(
      { provider: pick(fake, 'runLlm')[0]!.provider, model: pick(fake, 'runLlm')[0]!.model },
      { provider: 'codex', model: 'gpt-5' },
    );
  });

  test('the second question carries the first exchange with it', async () => {
    const { session, fake } = asking({ tutorReply: 'because' });

    session.ask('first?');
    await session.settled();
    session.ask('second?');
    await session.settled();

    assert.match(pick(fake, 'runLlm')[1]!.prompt, /turns=user:first\?\|assistant:because\|user:second\?/);
    assert.equal(getTranscript(fake.stored()!, STEP).length, 4);
  });

  test('AC2: switching steps switches transcripts, and returning restores — through a real reload', async () => {
    const { session, fake } = asking({ tutorReply: 'about parse' });

    session.ask('about parse?');
    await session.settled();
    session.goTo('st-3-symbol-handle');
    await session.settled();

    assert.deepEqual(shownTranscript(fake), [], 'a step nobody has asked about has an empty conversation, not the last one');

    session.ask('about handle?');
    await session.settled();
    assert.equal(shownTranscript(fake).length, 2);

    // The reload drill, exactly as AC4 of T-4 does it: the second session reads the file back
    // rather than sharing an object with the first, so a transcript that "survives" only
    // because two sessions share memory cannot pass here.
    session.dispose();
    const reopened = WalkSession.open(TARGET, fake.adapters);
    await reopened.settled();
    assert.deepEqual(getTranscript(reopened.getView()!.progress, 'st-3-symbol-handle').map((t) => t.content), ['about handle?', 'about parse']);
    reopened.goTo(STEP);
    assert.deepEqual(getTranscript(reopened.getView()!.progress, STEP).map((t) => t.content), ['about parse?', 'about parse']);
    reopened.dispose();
  });

  test('an ask that lands after the learner has navigated joins the conversation it belongs to', async () => {
    // The same rule an entry pass follows, and for the same reason: the learner asked for it.
    // What must NOT follow them is the spinner, which is tagged with its step.
    let released: (() => void) | undefined;
    const { session, fake } = asking({
      tutorRunner: () => new Promise((resolve) => {
        released = () => resolve({ text: 'the late answer', inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
      }),
    });

    session.ask('why?');
    await new Promise((resolve) => setImmediate(resolve));
    session.goTo('st-3-symbol-handle');
    assert.equal(tutorOf(fake)?.thinking, false, 'no spinner on a step the learner merely walked to');

    released!();
    await session.settled();

    assert.deepEqual(getTranscript(fake.stored()!, STEP).map((t) => t.content), ['why?', 'the late answer']);
    assert.deepEqual(getTranscript(fake.stored()!, 'st-3-symbol-handle'), [], 'and nothing landed under the step they moved to');
  });
});

suite('the tutor is honest, and never leaves a spinner running (AC4)', () => {
  const STEP = 'st-2-file-parse';

  function tutorOf(fake: Fake): { thinking: boolean; unreachable?: string; note?: string } | undefined {
    const pushes = pick(fake, 'setPanel');
    return pushes[pushes.length - 1]?.view?.tutor;
  }

  function asking(options: FakeOptions = {}): { session: WalkSession; fake: Fake } {
    return opened({ request: tutorRequest(), ...options });
  }

  test('an unreachable provider is answered IMMEDIATELY, with its own words, and nothing is spent', async () => {
    const { session, fake } = asking({ availability: { ok: false, detail: 'claude: not found on PATH' } });

    session.ask('why?');
    await session.settled();

    assert.deepEqual(pick(fake, 'runLlm'), [], 'the probe comes BEFORE the send — nothing was asked and nothing was charged');
    assert.equal(tutorOf(fake)?.thinking, false, 'and the panel never entered the thinking state at all');
    assert.equal(tutorOf(fake)?.unreachable, 'claude: not found on PATH', "the provider's own sentence, carried through");
    assert.match(tutorOf(fake)?.note ?? '', /not found on PATH/);
    assert.deepEqual(getTranscript(fake.stored() ?? emptyProgress(fixturePlan()), STEP), [], 'a refusal is a note, never a turn');
  });

  test('the unreachable line OUTLIVES the step, because the condition does', async () => {
    const { session, fake } = asking({ availability: { ok: false, detail: 'claude: not found on PATH' } });

    session.ask('why?');
    await session.settled();
    session.goTo('st-3-symbol-handle');
    await session.settled();

    const pushes = pick(fake, 'setPanel');
    const latest = pushes[pushes.length - 1]?.view;
    assert.equal(latest?.tutor?.unreachable, 'claude: not found on PATH', 'a claude that is not installed is not installed on the next step either');
    assert.equal(latest?.tutor?.note, undefined, 'but the sentence about that one ask does not follow the learner around');
  });

  test('a timeout is a REPLY, not a hang — the spinner comes off and the question stays', async () => {
    const { session, fake } = asking({
      tutorTimeoutMs: 20,
      tutorRunner: () => new Promise<LlmReply>(() => { /* never settles: a wedged provider */ }),
    });

    session.ask('why?');
    await session.settled();

    assert.equal(tutorOf(fake)?.thinking, false, 'this is the whole of AC4');
    assert.match(tutorOf(fake)?.note ?? '', /did not answer within/);
    assert.deepEqual(getTranscript(fake.stored()!, STEP), [{ role: 'user', content: 'why?' }],
      'their question really was asked and stays in the conversation; the timeout is not a turn');
  });

  test('a provider that throws is reported as a note, and takes nothing down', async () => {
    const { session, fake } = asking({ tutorRunner: () => Promise.reject(new Error('the CLI exited with code 127')) });

    session.ask('why?');
    await session.settled();

    assert.equal(tutorOf(fake)?.thinking, false);
    assert.match(tutorOf(fake)?.note ?? '', /the CLI exited with code 127/);
    assert.deepEqual(getTranscript(fake.stored()!, STEP).map((t) => t.role), ['user'], 'a failure is not something the tutor said');
    assert.deepEqual(pick(fake, 'reportError'), [], 'and a provider that failed is not a broken walk');
  });

  test('with no tutor wired at all, Ask says so once and writes nothing', async () => {
    const { session, fake } = asking({ noTutor: true });

    session.ask('why?');
    await session.settled();

    assert.equal(tutorOf(fake)?.thinking, false);
    assert.match(tutorOf(fake)?.note ?? '', /nobody to ask/);
    assert.deepEqual(getTranscript(fake.stored() ?? emptyProgress(fixturePlan()), STEP), []);
  });

  test('a core that will not load is the same answer, and is reported ONCE per session', async () => {
    const { session, fake } = asking({ tutorCoreMissing: true });

    session.ask('why?');
    await session.settled();
    session.ask('why again?');
    await session.settled();

    assert.match(tutorOf(fake)?.note ?? '', /nobody to ask/);
    assert.equal(pick(fake, 'reportError').length, 1, 'a standing condition is stated once, not once per question');
  });

  test('a walk with no reference recorded refuses rather than paying for half a question', async () => {
    const plan = fixturePlan();
    const fake = fakeAdapters({ plan, progress: setCurrent(fixtureProgress(plan), STEP) });
    const session = WalkSession.open(TARGET, fake.adapters); // no `request`, so no referenceRoot
    fake.clearLog();

    session.ask('why?');
    await session.settled();

    assert.deepEqual(pick(fake, 'runLlm'), []);
    const pushes = pick(fake, 'setPanel');
    assert.match(pushes[pushes.length - 1]?.view?.tutor?.note ?? '', /no reference repository/);
    assert.equal(pushes[pushes.length - 1]?.view?.tutor?.thinking, false);
    session.dispose();
  });

  test('the poison is real: an ask with no injected answer FAILS rather than dialling out', async () => {
    // What makes every other test in these suites evidence of anything. `tutorReply` and
    // `tutorRunner` are the only two ways a model answers here, so a test that forgot to say
    // what it expects gets this instead of a canned sentence from nowhere.
    const { session, fake } = asking({});

    session.ask('why?');
    await session.settled();

    const pushes = pick(fake, 'setPanel');
    assert.match(pushes[pushes.length - 1]?.view?.tutor?.note ?? '', /reached the real model/);
  });
});

suite('the tutor — Cancel detaches, and a late answer can never land (AC4)', () => {
  const STEP = 'st-2-file-parse';

  function tutorOf(fake: Fake): { thinking: boolean; unreachable?: string; note?: string } | undefined {
    const pushes = pick(fake, 'setPanel');
    return pushes[pushes.length - 1]?.view?.tutor;
  }

  /** An ask that will not answer until the test says so. */
  function held(): { runner: TutorCore['runLlm']; release: (text: string) => void; calls: () => number } {
    let resolveWith: ((reply: LlmReply) => void) | undefined;
    let calls = 0;
    return {
      runner: () => {
        calls += 1;
        return new Promise<LlmReply>((resolve) => {
          resolveWith = (reply) => resolve(reply);
        });
      },
      release: (text) => resolveWith?.({ text, inputTokens: 0, outputTokens: 0, usd: 0, metered: false }),
      calls: () => calls,
    };
  }

  test('Cancel takes the spinner off at once, and says the model is still finishing', async () => {
    const gate = held();
    const { session, fake } = opened({ request: tutorRequest(), tutorRunner: gate.runner });

    session.ask('why?');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tutorOf(fake)?.thinking, true);

    session.cancelAsk();

    // SYNCHRONOUS. The whole promise of Cancel is that the spinner goes now, and a Cancel that
    // waited behind a two-minute model call on the job chain would take two minutes to work.
    assert.equal(tutorOf(fake)?.thinking, false, 'no await in between');
    assert.match(tutorOf(fake)?.note ?? '', /still finishing/);
    assert.match(tutorOf(fake)?.note ?? '', /billed/, 'a cancel that quietly kept costing money would be the dishonest version of the same mechanism');
  });

  test('the answer to a cancelled question can NEVER appear in the transcript', async () => {
    // The safety property `AskRun.detach` exists for. The request is still running and still
    // costing money — nothing here can stop that without killing every other live child — but
    // the answer has nowhere to land.
    const gate = held();
    const { session, fake } = opened({ request: tutorRequest(), tutorRunner: gate.runner });

    session.ask('why?');
    await new Promise((resolve) => setImmediate(resolve));
    session.cancelAsk();
    gate.release('an answer to a question you walked away from');
    await session.settled();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(getTranscript(fake.stored()!, STEP), [{ role: 'user', content: 'why?' }],
      'the question they really asked stays; the answer they walked away from never arrives');
    assert.equal(tutorOf(fake)?.thinking, false);
  });

  test('Cancel with nothing in flight is a no-op, not a note about nothing', async () => {
    const { session, fake } = opened({ request: tutorRequest(), tutorReply: 'because' });

    session.ask('why?');
    await session.settled();
    fake.clearLog();
    session.cancelAsk();

    assert.deepEqual(fake.names(), [], 'the answer landed while the press was in the air; the reply on screen says more than any sentence about it could');
  });

  test('after a cancel the learner can ask again, and that answer DOES land', async () => {
    // The other direction, without which "cancel works" could mean "the tutor is broken now".
    const gate = held();
    const { session, fake } = opened({ request: tutorRequest(), tutorRunner: gate.runner });

    session.ask('first?');
    await new Promise((resolve) => setImmediate(resolve));
    session.cancelAsk();

    const second = held();
    const { session: s2, fake: f2 } = opened({ request: tutorRequest(), tutorRunner: second.runner });
    s2.ask('second?');
    await new Promise((resolve) => setImmediate(resolve));
    second.release('a real answer');
    await s2.settled();

    assert.deepEqual(getTranscript(f2.stored()!, STEP).map((t) => t.content), ['second?', 'a real answer']);
    assert.equal(gate.calls(), 1, 'and the cancelled one was asked exactly once — no retry, no second bill');
    void fake;
    session.dispose();
    s2.dispose();
  });

  test('a second ask while one is in flight is refused, and does not spend twice', async () => {
    const gate = held();
    const { session, fake } = opened({ request: tutorRequest(), tutorRunner: gate.runner });

    session.ask('first?');
    await new Promise((resolve) => setImmediate(resolve));
    session.ask('second?');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(gate.calls(), 1, 'one question with the model at a time');
    assert.match(tutorOf(fake)?.note ?? '', /already with the tutor/);
    assert.deepEqual(getTranscript(fake.stored()!, STEP), [{ role: 'user', content: 'first?' }], 'the refused question is not recorded as asked');
  });

  test('a session disposed mid-ask detaches, and the late answer touches nothing', async () => {
    // The liveness rule the whole of T-5's async half is built on, now for the longest await
    // in the extension: a disposed session's target may already belong to the session that
    // replaced it, and a `commit` from a dead one drives surfaces the new one has claimed.
    const gate = held();
    const { session, fake } = opened({ request: tutorRequest(), tutorRunner: gate.runner });

    session.ask('why?');
    await new Promise((resolve) => setImmediate(resolve));
    const savedBefore = pick(fake, 'saveProgress').length;
    session.dispose();
    fake.clearLog();

    gate.release('an answer for a walk that is not running');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(fake.names(), [], 'a torn-down session persists nothing and paints nothing');
    assert.equal(getTranscript(fake.stored()!, STEP).length, 1, 'the question survives; the answer to a walk that ended does not');
    assert.ok(savedBefore > 0, 'and the question really had been saved before the session went away');
  });

  test('every mutator is a no-op after dispose, the tutor\'s two included', async () => {
    const { session, fake } = opened({ request: tutorRequest(), tutorReply: 'because' });
    session.dispose();
    fake.clearLog();

    session.ask('why?');
    session.cancelAsk();
    await session.settled();

    assert.deepEqual(fake.names(), []);
  });
});

suite('the tutor — the spinner comes off even when a surface misbehaves (AC4)', () => {
  const STEP = 'st-2-file-parse';

  test('a push that throws mid-ask does not strand the thinking state', async () => {
    /*
     * The last of AC4's locks, and the one no ordinary path reaches. `commit` persists and then
     * pushes to four surfaces, any of which is an adapter that can throw — and a throw inside
     * the job escapes to `enqueue`, which reports it and moves on. If the ask were registered
     * for delivery AFTER that push, the failure would leave `asking` set and `thinking` true
     * with nothing left to take it down: a spinner that runs until the window closes, which is
     * exactly what the criterion forbids.
     *
     * So the delivery hook goes on BEFORE the commit, and this drives it: a `setPanel` that
     * throws on the push that raises the spinner, and then an answer that still lands.
     */
    const plan = fixturePlan();
    const fake = fakeAdapters({
      plan,
      progress: setCurrent(fixtureProgress(plan), STEP),
      request: tutorRequest(),
      tutorReply: 'because the parser has one job',
    });
    const session = WalkSession.open(TARGET, fake.adapters);
    await session.settled();

    let explode = true;
    const realSetPanel = fake.adapters.setPanel.bind(fake.adapters);
    fake.adapters.setPanel = (view) => {
      realSetPanel(view);
      if (explode) {
        explode = false;
        throw new Error('the panel threw while the spinner was going up');
      }
    };

    session.ask('why?');
    await session.settled();

    const pushes = pick(fake, 'setPanel');
    assert.equal(pushes[pushes.length - 1]?.view?.tutor?.thinking, false, 'the answer still cleared it');
    assert.deepEqual(getTranscript(fake.stored()!, STEP).map((t) => t.content), ['why?', 'because the parser has one job']);
    assert.equal(pick(fake, 'reportError').length, 1, 'and the throw was reported rather than swallowed');
    session.dispose();
  });
});
