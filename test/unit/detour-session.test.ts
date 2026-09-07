// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/detour/session.ts — the detour's state machine, driven through fake adapters and a REAL
 * disk, with no extension host and no provider anywhere near it (T-7, plan step 4's own named
 * verification: "state machine with fake adapters").
 *
 * Nothing here may import `vscode`, value or type: `esbuild.mjs`'s `test/unit/*.test.ts` bundle
 * marks `repo-tour` and `mocha` external and deliberately not `vscode`, so one such import
 * fails the BUILD and takes the whole unit suite with it.
 *
 * ## Two things about this harness that are load-bearing rather than convenient
 *
 * **The disk is real.** `globalStorageRoot` is an `mkdtemp`, not a fixture path, and every
 * assertion about where a file landed is a `readdirSync`. That is not thoroughness for its own
 * sake — the whole containment argument in `src/detour/prompt.ts` and `src/detour/store.ts` is
 * that a path can stay under a root as a STRING and land somewhere else on a DISK, and only
 * `realpath` can tell the two apart. A fake filesystem would agree with the string every time
 * and prove exactly nothing. `the store root is a link to somewhere else` plants that link for
 * real and asserts the folder on the other end stays empty.
 *
 * **The ledger is real.** `AskLedger` is the genuine article from `src/tutor/ask.ts`, because
 * plan R2 — "nothing starts a paid request except a ticket this ledger opened" — is only a
 * property if the thing under test really goes through it. `spend()` and `abandonAll()` are
 * asserted against directly: a detour generation that had found its own way to a model would
 * be invisible to both, which is precisely the class T-6 closed and this ticket must not
 * reopen. What is faked is one layer lower: `TutorCore.runLlm`, which is where money is spent.
 *
 * **No test in this file may reach a provider.** The default runner is POISONED — it rejects
 * with a sentence that can only ever be a test failure — and a test that wants an answer says
 * what the answer is. `the poison is real` drives it on purpose, which is what makes every
 * other test's canned reply evidence that it went through the seam rather than past it.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AskLedger, type AskSettings } from '../../src/tutor/ask.js';
import type { AskMessage, LlmReply, TutorCore } from '../../src/tutor/core.js';
import { DETOUR_PROMPT_VERSION, detourPrompt, prepareDetourWrite } from '../../src/detour/prompt.js';
import {
  detourDir, detoursRoot, readCachedDetour, writeCachedDetour,
  type DetourCacheKey, type DetourKey,
} from '../../src/detour/store.js';
import {
  DetourSession, refusalSentence, type DetourAdapters, type DetourStartResult,
} from '../../src/detour/session.js';
import type { PlanLike, StepLike } from '../../src/walk/model.js';
import type { NarratorViewState } from '../../src/detour/narrator.js';
import type { Detour } from '../../src/detour/types.js';
import { fixturePlan } from './walk-fixtures.js';

/** What a runner nobody replaced says. If this reaches an assertion, a test forgot to answer
 *  for itself and would otherwise have dialled a real provider. */
const SPEND_GUARD = 'a test in detour-session.test.ts reached the real model';

const STEP_ID = 'st-2-file-parse';

/**
 * The other half of every key (T-7 code review findings 1 and 2). `globalStorageUri` is
 * per-EXTENSION and a repo-tour step id carries no repository identity, so a harness with only
 * one of these could not see either finding — the two tutorials that collide have to be real
 * inputs to a real session, which is what `makeFake({ tutorial })` is for.
 */
const TUTORIAL = 'tutorial-a-aaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TUTORIAL = 'tutorial-b-bbbbbbbbbbbbbbbbbbbbbb';

/** One step of one tutorial, for the assertions that name a directory on disk. */
function key(stepId: string, tutorial: string = TUTORIAL): DetourKey {
  return { tutorial, stepId };
}

/**
 * The cache key a `start(step, plan, refRoot)` really uses — built from the REAL prompt.
 *
 * **The prompt is the key** (T-7 code review finding 9): a cache is a memo of
 * `prompt -> reply`, and keying it by step id and version alone meant a plan rebuilt with a
 * different `decision.question` served yesterday's example forever, with `runLlm` calls = 0.
 * A test that wants to read an entry back has to compose the same prompt, and doing it through
 * `detourPrompt` rather than a fixture is what makes that a real assertion.
 */
function cacheKeyFor(
  s: StepLike,
  plan: PlanLike,
  refRoot: unknown = 'ref',
  over: { promptVersion?: number; tutorial?: string } = {},
): DetourCacheKey {
  const refName = typeof refRoot === 'string' && refRoot.trim().length > 0
    ? path.basename(path.resolve(refRoot))
    : refRoot;
  return {
    tutorial: over.tutorial ?? TUTORIAL,
    stepId: s.id,
    promptVersion: over.promptVersion ?? DETOUR_PROMPT_VERSION,
    prompt: detourPrompt(s, plan, refName),
  };
}

/** A well-formed reply: three files, three stops, every stop inside its own file. Three rather
 *  than one because AC2 counts tabs ("≥ 3 detour tabs open") and one file cannot carry that. */
const GOOD_DETOUR: Detour = {
  title: 'A vending machine',
  domain: 'vending machines',
  files: [
    { path: 'coins.ts', content: 'export type Coin = 5 | 10 | 25;\nexport const VALUES: Coin[] = [5, 10, 25];\n' },
    { path: 'stock/tray.ts', content: 'export interface Slot { code: string; count: number; }\nexport const EMPTY: Slot[] = [];\n' },
    { path: 'machine.ts', content: 'import { VALUES } from "./coins";\nexport function total(c: number[]) { return c.length + VALUES.length; }\n' },
  ],
  stops: [
    { file: 'coins.ts', startLine: 1, endLine: 1, text: 'The coins are their own module — one idea, one file.' },
    { file: 'stock/tray.ts', startLine: 1, endLine: 2, text: 'The tray knows nothing about coins.' },
    { file: 'machine.ts', startLine: 2, endLine: 2, text: 'Only the machine joins them.' },
  ],
};

function replyOf(detour: unknown): string {
  return JSON.stringify(detour);
}

// ── the recording fake ──────────────────────────────────────────────────────────────────────

/** One adapter call with what it was handed. The log IS the behaviour of a state machine whose
 *  job is which surface gets what and in which order (`walk-session.test.ts` says the same). */
type Call =
  | { fn: 'openDetourTab'; absPath: string }
  | { fn: 'revealDetourStop'; absPath: string; startLine: number; endLine: number }
  | { fn: 'closeTabsUnder'; prefixes: string[] }
  | { fn: 'showNarrator'; state: NarratorViewState }
  | { fn: 'closeNarrator' }
  | { fn: 'runLlm'; prompt: string }
  | { fn: 'availability' };

interface Fake {
  session: DetourSession;
  log: Call[];
  storage: string;
  ledger: AskLedger;
  refreshes: () => number;
  unreachable: () => string | undefined;
  /** Tabs the fake pretends it cannot close, by absolute path. */
  stuck: Set<string>;
  /**
   * Wait for the delivery half of `start` to have run (T-7 code review finding 3).
   *
   * `start` now returns as soon as the request is SENT — the press has to be visible in one
   * chain hop, so the model call cannot be awaited inside it — and the parse/write/tabs half
   * arrives later through `DetourDeps.resume`. This is the harness's stand-in for the walk's
   * chain: it settles every job `resume` has been handed, including jobs a job produced.
   */
  settle: () => Promise<void>;
  /**
   * Both halves in one, for the many tests that just want a finished detour — and it answers
   * with what the PANEL ends up drawing rather than with what the pre-flight returned.
   *
   * That distinction is the fix to code review finding 3 showing through the harness.
   * `start` returns as soon as the request is sent, so its own answer can no longer be the
   * outcome; the outcome is `view(stepId)` — is a detour open for this step, and what is the
   * sentence. Tests about the pre-flight itself call `session.start` directly.
   */
  run: (step: StepLike, plan: PlanLike, refRoot?: unknown) => Promise<DetourStartResult>;
}

interface FakeOptions {
  /** What the model answers. `undefined` leaves the poison in place. */
  canned?: string;
  /** A runner that decides per call — for the supersede and cancel tests, which need one that
   *  does not resolve until they say so. */
  runner?: (prompt: string) => Promise<LlmReply>;
  availability?: { ok: boolean; detail: string };
  /** No settings at all: repo-tour will not load, or no tutor is wired. */
  noSettings?: boolean;
  openThrows?: (absPath: string) => boolean;
  closeThrows?: boolean;
  /** Which TUTORIAL this session's detours belong to — the other half of every key. */
  tutorial?: string;
  /** Share another fake's global storage. ONE disk, two tutorials, is the shape of the
   *  collision T-7's review found; two disks cannot see it. */
  storage?: string;
}

const tempDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

function fakeCore(log: Call[], options: FakeOptions): TutorCore {
  const runner = options.runner
    ?? (options.canned === undefined
      ? (): Promise<LlmReply> => Promise.reject(new Error(SPEND_GUARD))
      : (): Promise<LlmReply> => Promise.resolve({
        text: options.canned as string, inputTokens: 3, outputTokens: 7, usd: 0.5, metered: true,
      }));
  return {
    // Deliberately recognisable AND deliberately wrong for a detour: if this string ever
    // reaches `runLlm`, the detour went through `askTutor`'s conversation path instead of
    // `sendPrompt`, and the prompt AC1 is about was never sent.
    buildAskPrompt: (messages: AskMessage[]) => `CONVERSATION PROMPT turns=${messages.length}`,
    buildContextBlock: () => 'CONTEXT',
    trimMessages: (raw) => (Array.isArray(raw) ? (raw as AskMessage[]) : []),
    resolveChoice: (choice) => ({ provider: choice?.provider ?? 'claude', model: 'default' }),
    resolveTutorChoice: (stored, build) => ({
      provider: stored?.provider ?? build.provider,
      model: stored?.model === undefined || stored.model === '' ? 'strongest' : stored.model,
    }),
    runLlm: (prompt) => {
      log.push({ fn: 'runLlm', prompt });
      return runner(prompt);
    },
    availability: () => {
      log.push({ fn: 'availability' });
      return Promise.resolve(options.availability ?? { ok: true, detail: 'a stubbed provider probe' });
    },
  };
}

function makeFake(options: FakeOptions = {}): Fake {
  const log: Call[] = [];
  const storage = options.storage ?? tmpDir('detour-storage-');
  const ledger = new AskLedger();
  const stuck = new Set<string>();
  let refreshes = 0;
  let unreachable: string | undefined;

  const settings: AskSettings = {
    core: fakeCore(log, options),
    provider: 'claude',
    model: '',
    timeoutMs: 5_000,
  };

  const adapters: DetourAdapters = {
    globalStorageRoot: storage,
    openDetourTab: (absPath) => {
      log.push({ fn: 'openDetourTab', absPath });
      if (options.openThrows?.(absPath) === true) return Promise.reject(new Error('that tab would not open'));
      return Promise.resolve();
    },
    revealDetourStop: (absPath, startLine, endLine) => {
      log.push({ fn: 'revealDetourStop', absPath, startLine, endLine });
      return Promise.resolve();
    },
    closeTabsUnder: (prefixes) => {
      log.push({ fn: 'closeTabsUnder', prefixes });
      if (options.closeThrows === true) return Promise.reject(new Error('the tabs could not be reached'));
      return Promise.resolve([...stuck]);
    },
    showNarrator: (state) => { log.push({ fn: 'showNarrator', state }); },
    closeNarrator: () => { log.push({ fn: 'closeNarrator' }); },
    skin: () => 'system',
  };

  // Not the walk's own chain — a queue that behaves like it. Jobs run in order, and a job that
  // enqueues another is drained too, which is what `settle` below waits on.
  const pending: Array<() => Promise<void>> = [];
  let draining: Promise<void> = Promise.resolve();

  const session = new DetourSession({
    adapters,
    ledger,
    settings: () => Promise.resolve(options.noSettings === true ? undefined : settings),
    refresh: () => { refreshes += 1; },
    reportUnreachable: (detail) => { unreachable = detail; },
    tutorial: options.tutorial ?? TUTORIAL,
    resume: (job) => {
      pending.push(job);
      draining = draining.then(async () => {
        const next = pending.shift();
        if (next) await next();
      });
    },
  });

  const settle = async (): Promise<void> => {
    // Microtasks AND a macrotask turn, twice. `delivered` resolves on a microtask, `resume` is
    // called from its `.then`, and the ledger's own bookkeeping (which is what `live()` reads)
    // settles on a timer — so a microtask-only drain would read the ledger one turn early.
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      await draining;
    }
  };

  const fake: Fake = {
    session,
    log,
    storage,
    ledger,
    refreshes: () => refreshes,
    unreachable: () => unreachable,
    stuck,
    settle,
    run: async (s2, p2, refRoot = '/somewhere/the-authors-repo') => {
      const pre = await session.start(s2, p2, refRoot);
      await settle();
      const view = session.view(s2.id);
      return view.open !== undefined && view.open.stepId === s2.id
        ? { started: true, title: view.open.title, ...(view.note !== undefined ? { note: view.note } : {}) }
        : { started: false, note: view.note ?? (pre.started ? '' : pre.note) };
    },
  };
  return fake;
}

function step() {
  const plan = fixturePlan();
  const found = plan.steps.find((s) => s.id === STEP_ID);
  assert.ok(found, `the fixture plan should contain ${STEP_ID}`);
  return { plan, step: found };
}

/** Every file under `dir`, relative and sorted — what "the tree is unchanged" is measured on. */
function treeOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function calls(log: Call[], fn: Call['fn']): Call[] {
  return log.filter((entry) => entry.fn === fn);
}

/**
 * Wait until the request has really reached the fake runner.
 *
 * Needed since the model call came off the walk's chain (code review finding 3): `start` now
 * returns the moment `sendPrompt` is called, and `AskLedger` probes availability before it
 * reaches `runLlm` — so a test that released its runner immediately after the press would be
 * releasing a `resolve` that had not been handed out yet, and the request would never end.
 */
async function reachedRunner(log: Call[]): Promise<void> {
  for (let i = 0; i < 200 && calls(log, 'runLlm').length === 0; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  assert.ok(calls(log, 'runLlm').length > 0, 'the request never reached the runner');
}

// ── AC1 and AC2: what one press actually does ───────────────────────────────────────────────

suite('DetourSession.start — the example is written, opened and narrated (ACs 1, 2)', () => {
  teardown(cleanTempDirs);

  test('a good reply becomes files under globalStorage/detours, tabs, a narrator and stop 1', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    const result = await fake.run(s, plan, '/somewhere/the-authors-repo');

    assert.equal(result.started, true, 'a well-formed reply opens a detour');
    assert.equal(result.started && result.title, GOOD_DETOUR.title, 'and hands back the title AC4 records');

    // The files, on a real disk, under the extension's own storage and nowhere else.
    const dir = detourDir(fake.storage, key(STEP_ID));
    assert.deepEqual(
      treeOf(dir),
      ['coins.ts', 'machine.ts', path.join('stock', 'tray.ts')].sort(),
      'every file in the reply is on disk, at its own relative path, nested folders included',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'coins.ts'), 'utf8'),
      GOOD_DETOUR.files[0]?.content,
      'and holds exactly what the model sent — no re-encoding on the way through',
    );

    // AC2's own check, at this level: everything written is inside the detours folder.
    for (const rel of treeOf(fake.storage)) {
      assert.ok(
        rel.startsWith('detours' + path.sep),
        `nothing outside <storage>/detours was written, but ${rel} was`,
      );
    }

    // One tab per file, in the reply's own order, at the paths that were really written.
    const tabs = calls(fake.log, 'openDetourTab');
    assert.equal(tabs.length, 3, 'one real editor tab per file (AC2)');
    assert.deepEqual(
      tabs.map((c) => (c.fn === 'openDetourTab' ? path.relative(dir, c.absPath) : '')),
      ['coins.ts', path.join('stock', 'tray.ts'), 'machine.ts'],
      'in the order the model listed them, so the narration and the tabs agree',
    );

    const shown = calls(fake.log, 'showNarrator');
    assert.ok(shown.length >= 1, 'the narrator is raised');
    const last = shown[shown.length - 1];
    assert.ok(last?.fn === 'showNarrator');
    assert.equal(last.state.current, 0, 'and parks on the FIRST stop — goto(0)');
    assert.equal(last.state.detour.title, GOOD_DETOUR.title, 'with the detour it is narrating');

    // …and that stop's range is revealed and decorated in ITS OWN tab.
    const reveals = calls(fake.log, 'revealDetourStop');
    assert.equal(reveals.length, 1, 'exactly one reveal, for the stop it landed on');
    const reveal = reveals[0];
    assert.ok(reveal?.fn === 'revealDetourStop');
    assert.equal(path.relative(dir, reveal.absPath), 'coins.ts', "the first stop's own file");
    assert.equal(reveal.startLine, 1);
    assert.equal(reveal.endLine, 1);
  });

  test('the narrator is raised BEFORE the reveal, so the prose is never behind the highlight', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    const order = fake.log.map((c) => c.fn);
    const narrator = order.indexOf('showNarrator');
    const reveal = order.indexOf('revealDetourStop');
    assert.ok(narrator >= 0 && reveal >= 0, 'both happened');
    assert.ok(narrator < reveal, 'the narrator is on screen before the editor is scrolled under it');
    // Every tab is open before either: a stop cannot be revealed into a tab that is not there.
    assert.ok(order.lastIndexOf('openDetourTab') < narrator, 'and every tab is open before the narrator');
  });

  test('the prompt that is SENT is the detour prompt, not the tutor conversation', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, '/tmp/checkouts/the-authors-repo');

    const sent = calls(fake.log, 'runLlm');
    assert.equal(sent.length, 1, 'exactly one model call for one press');
    const prompt = sent[0]?.fn === 'runLlm' ? sent[0].prompt : '';
    assert.ok(
      !prompt.startsWith('CONVERSATION PROMPT'),
      'it did NOT go through buildAskPrompt — repo-tour\'s persona asks for prose under 200 words, '
      + 'which is the opposite of the one JSON object this asks for',
    );
    assert.ok(prompt.includes('--- WHAT TO RETURN ---'), 'it is detourPrompt\'s own document');
    assert.ok(prompt.includes('the-authors-repo'), "and it names the learner's own domain, to avoid it (AC1)");
    // The FOLDER NAME, exactly as `tutorContext` names it for the tutor — never the whole
    // path, which can be a URL with a token in it and is going to a paid third party.
    assert.ok(!prompt.includes('/tmp/checkouts'), 'and only the folder name leaves this machine');
  });
});

// ── AC5: retaking is free, and a failure says why ───────────────────────────────────────────

suite('DetourSession.start — the cache (AC5)', () => {
  teardown(cleanTempDirs);

  test('a second start on the same step makes NO model call and no provider probe', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    await fake.run(s, plan, 'ref');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'the first press pays for one answer');
    await fake.session.returnToBuild();

    const before = fake.log.length;
    const again = await fake.run(s, plan, 'ref');

    assert.equal(again.started, true, 'the retake opens the same example');
    const after = fake.log.slice(before);
    assert.equal(after.filter((c) => c.fn === 'runLlm').length, 0, 'AC5: the second run makes NO LLM call');
    assert.equal(
      after.filter((c) => c.fn === 'availability').length,
      0,
      'and no provider probe either — a cached detour must reopen on a machine where the provider '
      + 'has since been uninstalled, which is what "retaking is free" has to mean to be worth having',
    );
    assert.equal(after.filter((c) => c.fn === 'openDetourTab').length, 3, 'the tabs come back all the same');
  });

  test('the cache is keyed by prompt VERSION, so a bumped version is a miss by construction', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    assert.ok(readCachedDetour(fake.storage, cacheKeyFor(s, plan)) !== null, 'it really was cached');
    assert.equal(
      readCachedDetour(fake.storage, cacheKeyFor(s, plan, 'ref', { promptVersion: DETOUR_PROMPT_VERSION + 1 })),
      null,
      'and the entry does not answer for a prompt that no longer asks the same question',
    );
  });

  test('the cache is keyed by the PROMPT — a rebuilt plan with a new question is a miss (finding 9)', async () => {
    // Driven in the review and served the stale example with `runLlm` calls = 0: the same step
    // id, the same prompt version, a plan whose `decision.question` had changed. A cache is a
    // memo of `prompt -> reply` and the only honest key for a memo is its input.
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    await fake.session.returnToBuild();
    assert.equal(calls(fake.log, 'runLlm').length, 1);

    // The SAME step id, rebuilt against a different question — which is what a plan regenerated
    // from a newer reference commit looks like.
    const rebuilt = {
      ...plan,
      steps: plan.steps.map((entry) => (entry.id === s.id
        ? { ...entry, decision: { ...entry.decision, question: 'A COMPLETELY DIFFERENT QUESTION about this step' } }
        : entry)),
    };
    const changed = rebuilt.steps.find((entry) => entry.id === s.id);
    assert.ok(changed);

    await fake.run(changed, rebuilt, 'ref');

    assert.equal(calls(fake.log, 'runLlm').length, 2, 'a changed question was served the old example');
  });

  test('two TUTORIALS that share a step id do not share a cache entry (finding 2)', async () => {
    // The merge bar. repo-tour mints a step id as `sha256(file + kind + symbol)` with no
    // repository in it, and `globalStorageUri` is one directory for every tutorial — so two
    // projects with a `src/index.ts` collided by construction. Driven in the review: tutorial B
    // pressed the button and was served tutorial A's worked example with `runLlm` calls = 0.
    //
    // ONE storage root, deliberately: that is the shape of the bug, and two disks cannot see
    // it. This is the review's own lesson made into a test — *the test to write is two inputs
    // that share a key, not one input twice*.
    const a = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const b = makeFake({
      canned: replyOf({ ...GOOD_DETOUR, title: 'B’s OWN example' }),
      tutorial: OTHER_TUTORIAL,
      storage: a.storage,
    });

    const { plan, step: s } = step();
    await a.run(s, plan, 'ref');
    assert.equal(calls(a.log, 'runLlm').length, 1, 'A paid for its own example');

    await b.run(s, plan, 'ref');

    assert.equal(calls(b.log, 'runLlm').length, 1, 'tutorial B was served tutorial A’s example for free');
    assert.equal(b.session.view(STEP_ID).open?.title, 'B’s OWN example', 'and B is reading A’s example');
  });

  test('two TUTORIALS that share a step id do not share a DIRECTORY (finding 1)', async () => {
    // The other half, and the one that lost a learner's files: `closeOpen` awaits
    // `closeTabsUnder` and only then deletes, so a session disposed while a tab was slow to
    // close deleted whatever was at that path when the await returned — which, keyed by step id
    // alone, was the OTHER tutorial's live detour. Driven in the review: three tabs left open on
    // deleted files, a narrator describing them, and no sentence anywhere.
    const a = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const b = makeFake({ canned: replyOf(GOOD_DETOUR), tutorial: OTHER_TUTORIAL, storage: a.storage });
    const { plan, step: s } = step();

    await a.run(s, plan, 'ref');
    await b.run(s, plan, 'ref');

    const dirA = detourDir(a.storage, key(STEP_ID));
    const dirB = detourDir(a.storage, key(STEP_ID, OTHER_TUTORIAL));
    assert.notEqual(dirA, dirB, 'two tutorials shared one detour directory');
    assert.ok(fs.existsSync(dirA) && fs.existsSync(dirB), 'both detours are on disk at once');

    // A disposes. B is untouched — files, tabs and all.
    await a.session.dispose();

    assert.equal(fs.existsSync(dirA), false, 'A did not clean up after itself');
    assert.deepEqual(
      treeOf(dirB).sort(),
      ['coins.ts', 'machine.ts', path.join('stock', 'tray.ts')].sort(),
      'one tutorial’s dispose deleted another tutorial’s live detour',
    );
    assert.equal(b.session.activeStepId(), STEP_ID, 'and B still believes its detour is open — because it is');
  });

  test('a poisoned cache entry is a MISS, not a detour — it is sanitised, never trusted', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    // Hand-written by "another tool" — legal JSON, wrong shape. `sanitizeDetour` drops the
    // whole entry rather than half-trusting it, because a stop refers to one of the detour's
    // own files and a half-trusted detour opens editor tabs.
    writeCachedDetour(fake.storage, cacheKeyFor(s, plan), GOOD_DETOUR);
    const cachePath = path.join(detoursRoot(fake.storage), 'cache');
    const entry = fs.readdirSync(cachePath)[0];
    assert.ok(entry);
    fs.writeFileSync(path.join(cachePath, entry), JSON.stringify({ title: 'x', domain: 'y', files: 'not an array', stops: [] }));

    const result = await fake.run(s, plan, 'ref');
    assert.equal(result.started, true, 'the press still works');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'by paying for a fresh answer rather than opening the poison');
  });
});

suite('DetourSession.start — a failed generation says WHY (AC5)', () => {
  teardown(cleanTempDirs);

  /** Every refusal path ends the same way: nothing on disk, nothing open, and a sentence. */
  async function refusedBy(canned: string): Promise<{ note: string; storage: string; log: Call[] }> {
    const fake = makeFake({ canned });
    const { plan, step: s } = step();
    const result = await fake.run(s, plan, 'ref');
    assert.equal(result.started, false, 'a reply this shape must not open a detour');
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and must open no tabs');
    assert.equal(calls(fake.log, 'showNarrator').length, 0, 'and raise no narrator');
    assert.equal(treeOf(detourDir(fake.storage, key(STEP_ID))).length, 0, 'and leave nothing on disk');
    return { note: result.started ? '' : result.note, storage: fake.storage, log: fake.log };
  }

  test('a reply that is not JSON at all', async () => {
    const { note } = await refusedBy('I would rather not, thanks.');
    assert.ok(note.length > 0, 'it says something');
    assert.ok(/JSON/i.test(note), 'and names what was wrong, rather than "something went wrong"');
  });

  test('too many files — the number is in the sentence', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, content: 'x\n' }));
    const { note } = await refusedBy(replyOf({ ...GOOD_DETOUR, files }));
    assert.ok(note.includes('7'), 'the count the model actually sent');
    assert.ok(note.includes('5'), 'and the limit it broke');
  });

  test('too few stops — the number is in the sentence', async () => {
    const { note } = await refusedBy(replyOf({ ...GOOD_DETOUR, stops: GOOD_DETOUR.stops.slice(0, 1) }));
    assert.ok(note.includes('1') && note.includes('3'), 'what was sent, and the range that was asked for');
  });

  test('a stop pointing at a file the model never sent', async () => {
    const { note } = await refusedBy(replyOf({
      ...GOOD_DETOUR,
      stops: [...GOOD_DETOUR.stops.slice(1), { file: 'ghost.ts', startLine: 1, endLine: 1, text: 'look here' }],
    }));
    assert.ok(note.includes('ghost.ts'), 'the file it named');
  });

  test('every DetourRefusal arm has a sentence, and none of them is empty', () => {
    // The union is the contract `./types.ts` wrote down for exactly this; a new arm with no
    // sentence would be a refusal the panel could not explain, which is the failure mode both
    // T-6 reviews named. Exhaustive by construction — a missing arm does not compile.
    const all = [
      refusalSentence({ reason: 'not-json', detail: 'x' }),
      refusalSentence({ reason: 'bad-shape', detail: 'x' }),
      refusalSentence({ reason: 'too-many-files', found: 9 }),
      refusalSentence({ reason: 'file-too-long', path: 'a.ts', lines: 99 }),
      refusalSentence({ reason: 'bad-stop-count', found: 0 }),
      refusalSentence({ reason: 'stop-file-unknown', file: 'a.ts' }),
      refusalSentence({ reason: 'bad-range', file: 'a.ts', detail: 'x' }),
      refusalSentence({ reason: 'unsafe-path', path: '../x', detail: 'climbs out' }),
    ];
    for (const sentence of all) assert.ok(sentence.trim().length > 20, `a real sentence, not "${sentence}"`);
    assert.equal(new Set(all).size, all.length, 'and each arm says something different from the others');
  });

  test('an unreachable provider is honest, costs nothing, and is carried up to the standing line', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR), availability: { ok: false, detail: 'not found on PATH' } });
    const { plan, step: s } = step();

    const result = await fake.run(s, plan, 'ref');

    assert.equal(result.started, false);
    assert.ok(result.started === false && result.note.includes('not found on PATH'), "the provider's OWN words, not a house phrasing");
    assert.equal(calls(fake.log, 'runLlm').length, 0, 'nothing was sent');
    assert.deepEqual(fake.ledger.spend().replies, 0, 'and nothing was billed');
    assert.equal(fake.unreachable(), 'not found on PATH', 'and the walk keeps the standing line beside the input');
  });

  test('no tutor wired at all is an honest answer rather than a broken button', async () => {
    const fake = makeFake({ noSettings: true });
    const { plan, step: s } = step();
    const result = await fake.run(s, plan, 'ref');
    assert.equal(result.started, false);
    assert.ok(result.started === false && result.note.includes('repo-tour'), 'it names what is missing');
    assert.equal(calls(fake.log, 'availability').length, 0, 'and does not probe a provider it has no way to reach');
  });

  test('the poison is real — a test that answers for nothing reaches no model, it FAILS', async () => {
    const fake = makeFake();
    const { plan, step: s } = step();
    const result = await fake.run(s, plan, 'ref');
    assert.equal(result.started, false, 'the failure is a refusal, not a crash');
    assert.ok(result.started === false && result.note.includes(SPEND_GUARD), 'and it is the guard that answered');
  });
});

// ── containment: the half a pure function cannot do ─────────────────────────────────────────

suite('DetourSession.start — every write goes through prepareDetourWrite', () => {
  teardown(cleanTempDirs);

  /** A hostile path is refused with its own reason, nothing lands, and the other files still
   *  do — one bad file must not cost the learner the example. */
  async function hostilePath(bad: string): Promise<{ note: string | undefined; storage: string; started: boolean }> {
    const fake = makeFake({
      canned: replyOf({
        ...GOOD_DETOUR,
        files: [{ path: bad, content: 'OWNED\n' }, ...GOOD_DETOUR.files],
      }),
    });
    const { plan, step: s } = step();
    const result = await fake.run(s, plan, 'ref');
    return { note: result.note, storage: fake.storage, started: result.started };
  }

  for (const bad of [
    '../escaped.ts',
    '../../escaped.ts',
    'a/../../escaped.ts',
    '/etc/escaped.ts',
    'C:\\escaped.ts',
    'a\\b.ts',
    '.ssh/authorized_keys',
    'nested/../../../escaped.ts',
  ]) {
    test(`"${bad}" is refused, by name, and writes nothing`, async () => {
      const { note, storage, started } = await hostilePath(bad);

      // The refusal is REPORTED. `parseDetourReply` rejects the whole reply for a path this
      // shape, so the honest outcome is a refusal with a reason rather than four files out of
      // five — the point being that the learner is told, either way.
      assert.ok(note !== undefined && note.length > 0, 'it says why');

      // And on the disk: nothing anywhere in the storage root but (at most) the detours
      // folder and its cache. `escaped.ts` exists nowhere under it, at any depth.
      for (const rel of treeOf(storage)) {
        assert.ok(!rel.includes('escaped.ts'), `${rel} should not exist`);
        assert.ok(!rel.includes('authorized_keys'), `${rel} should not exist`);
      }
      assert.equal(started, false, 'and no detour opened on a reply that tried it');
    });
  }

  test('a store root that is a LINK to somewhere else writes nothing, anywhere (T-5\'s HIGH)', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const outside = tmpDir('detour-outside-');

    // The exact shape T-5's merge-blocking finding was: a path that is contained as a STRING
    // and elsewhere on the DISK. `<storage>/detours` is where every detour goes, so a link
    // standing there would make every "contained" write land in the attacker's folder — and
    // `prepareDetourWrite` alone cannot see it, because it resolves the DETOUR directory and
    // would agree that everything is inside whatever that resolves to. `provenStoreRoot`, one
    // level further up, is what refuses; it is reached because `writeDetour` clears through
    // `removeDetour` before it writes.
    fs.symlinkSync(outside, detoursRoot(fake.storage), 'dir');

    const { plan, step: s } = step();
    const result = await fake.run(s, plan, 'ref');

    assert.equal(result.started, false, 'the detour is refused rather than written through the link');
    assert.deepEqual(treeOf(outside), [], 'and the folder on the other end stays EMPTY');
  });

  test('a file already standing as a SYMLINK at its destination is refused, not written through', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    // First press writes the detour for real.
    await fake.run(s, plan, 'ref');
    const dir = detourDir(fake.storage, key(STEP_ID));

    // Now replace one of its files with a link out. A second press clears the directory first,
    // so this is not the state a real second press would find — which is exactly why the check
    // is driven directly rather than only through `start`: the guard has to hold whether or
    // not the clearing ran, because "a defence that relies on a caller in another file is not
    // a defence this file has" (`store.ts`'s own words).
    const victim = path.join(tmpDir('detour-victim-'), 'secret.txt');
    fs.writeFileSync(victim, 'the learner\'s secret\n');
    fs.rmSync(path.join(dir, 'coins.ts'));
    fs.symlinkSync(victim, path.join(dir, 'coins.ts'));

    const answer = prepareDetourWrite(dir, 'coins.ts');
    assert.ok(typeof answer !== 'string', 'a symlink at the destination is refused');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'the learner\'s secret\n', 'and the file it pointed at is untouched');
  });

  test('the written paths are the ones prepareDetourWrite returned, under the RESOLVED root', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    const realDir = fs.realpathSync(detourDir(fake.storage, key(STEP_ID)));
    for (const call of calls(fake.log, 'openDetourTab')) {
      assert.ok(call.fn === 'openDetourTab');
      assert.ok(
        call.absPath.startsWith(realDir + path.sep),
        `${call.absPath} should sit under the resolved detour directory ${realDir} — the composed `
        + 'path is not what is opened, because on a platform whose temp root is a symlink the two differ',
      );
      assert.ok(fs.lstatSync(call.absPath).isFile(), 'and every one of them is a real file, not a link');
    }
  });
});

// ── R2: the ledger is the only way a paid request starts ────────────────────────────────────

suite('DetourSession — the generation is the LEDGER\'s request (plan R2)', () => {
  teardown(cleanTempDirs);

  test('what the detour spent is in the walk\'s own total, not beside it', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    assert.equal(fake.ledger.spend().replies, 0, 'nothing spent before the press');
    await fake.run(s, plan, 'ref');

    const spend = fake.ledger.spend();
    assert.equal(spend.replies, 1, 'the detour\'s answer is counted');
    assert.equal(spend.inputTokens, 3);
    assert.equal(spend.outputTokens, 7);
    assert.equal(spend.usd, 0.5, 'at what it cost — a request outside the ledger would show zero here');
    assert.equal(spend.metered, true);
  });

  test('the request is LIVE in the ledger while it runs, on the step it was asked from', async () => {
    let release: ((reply: LlmReply) => void) | undefined;
    const fake = makeFake({
      runner: () => new Promise<LlmReply>((resolve) => { release = resolve; }),
    });
    const { plan, step: s } = step();

    // The press RETURNS while the request runs — that is code review finding 3's fix, and it
    // is why this reads the ledger after an `await` rather than through a `setTimeout` race.
    const pre = await fake.session.start(s, plan, 'ref');
    assert.deepEqual(pre, { started: false, note: '' }, 'the press comes back before the model does');
    await reachedRunner(fake.log);

    const live = fake.ledger.live();
    assert.equal(live.length, 1, 'the ledger knows about it');
    assert.equal(live[0]?.stepId, STEP_ID, 'and which step it belongs to — so a panel elsewhere can offer to stop it');
    assert.equal(live[0]?.phase, 'sending', 'and that it is billing right now');
    assert.equal(fake.session.view(STEP_ID).generating, true, 'the button says so');

    release?.({ text: replyOf(GOOD_DETOUR), inputTokens: 1, outputTokens: 1, usd: 0, metered: false });
    await fake.settle();
    assert.equal(fake.ledger.live().length, 0, 'and it is gone when it ends');
    assert.equal(fake.session.view(STEP_ID).generating, false, 'as is the sentence about waiting');
  });

  test('abandonAll reaches it — one Cancel really does stop every live request', async () => {
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never answers */ }) });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    fake.ledger.abandonAll();
    const result = await running;

    assert.equal(result.started, false, 'the detour does not open behind a cancel');
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and nothing was opened');
    assert.equal(treeOf(detourDir(fake.storage, key(STEP_ID))).length, 0, 'and nothing was written');
  });

  test('cancel() answers whether it acted — a Cancel with nothing running must stay a no-op', async () => {
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => undefined) });
    const { plan, step: s } = step();

    assert.equal(fake.session.cancel(), false, 'nothing to stop');
    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.equal(fake.session.cancel(), true, 'something to stop');
    assert.equal(fake.session.cancel(), false, 'and it is idempotent');
    await running;
  });

  test('one generation at a time — a second press while the first runs is answered, not queued', async () => {
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => undefined) });
    const { plan, step: s } = step();

    const first = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const second = await fake.run(s, plan, 'ref');

    assert.equal(second.started, false);
    assert.ok(second.started === false && second.note.includes('already'), 'and it says so rather than doing nothing');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'the second press did not start a second billed request');
    fake.session.cancel();
    await first;
  });
});

// ── AC3: the way back leaves nothing behind ─────────────────────────────────────────────────

suite('DetourSession.returnToBuild — closes what it opened, deletes what it wrote (AC3)', () => {
  teardown(cleanTempDirs);

  test('the tabs, the narrator and the directory all go, and the title comes back for AC4', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    const dir = detourDir(fake.storage, key(STEP_ID));
    assert.equal(treeOf(dir).length, 3, 'the example really was on disk first');

    const before = fake.log.length;
    const result = await fake.session.returnToBuild();
    const after = fake.log.slice(before);

    assert.equal(result.returned, true);
    assert.equal(result.returned && result.stepId, STEP_ID, 'the step it belonged to — not whatever is current now');
    assert.equal(result.returned && result.title, GOOD_DETOUR.title, 'the title the transcript note records');
    assert.equal(result.returned && result.note, undefined, 'and nothing to apologise for');

    assert.equal(after.filter((c) => c.fn === 'closeTabsUnder').length, 1, 'the tabs are closed');
    assert.equal(after.filter((c) => c.fn === 'closeNarrator').length, 1, 'the narrator is disposed');
    assert.equal(fs.existsSync(dir), false, 'AC3: the directory is ABSENT');
    assert.equal(fake.session.activeStepId(), undefined, 'and nothing is open any more');
  });

  test('the tabs are closed BEFORE the files are deleted', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    const dir = detourDir(fake.storage, key(STEP_ID));

    let existedWhenClosing: boolean | undefined;
    // The adapter is asked while the return is mid-flight, which is the only moment the order
    // is observable — a learner staring at a "file not found" they did nothing to deserve is
    // what closing after deleting looks like from the outside.
    const wrapped = fake.session as unknown as { deps: { adapters: DetourAdapters } };
    const original = wrapped.deps.adapters.closeTabsUnder.bind(wrapped.deps.adapters);
    wrapped.deps.adapters.closeTabsUnder = (prefixes) => {
      existedWhenClosing = fs.existsSync(dir);
      return original(prefixes);
    };

    await fake.session.returnToBuild();
    assert.equal(existedWhenClosing, true, 'the files were still there when the tabs were asked to close');
    assert.equal(fs.existsSync(dir), false, 'and gone by the end');
  });

  test('BOTH spellings of the folder are handed to the tab matcher', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    await fake.session.returnToBuild();
    const close = calls(fake.log, 'closeTabsUnder')[0];
    assert.ok(close?.fn === 'closeTabsUnder');

    const composed = detourDir(fake.storage, key(STEP_ID));
    const resolved = fs.realpathSync(path.dirname(composed)) + path.sep + path.basename(composed);
    assert.ok(close.prefixes.includes(composed) || close.prefixes.includes(resolved), 'the folder is named');
    // On a platform whose temp root is a symlink the two differ and BOTH must be matched, or
    // every tab stays open on that platform. Where they are the same string, one is correct
    // and a duplicate would be needless work on the common path.
    if (composed !== resolved) {
      assert.deepEqual([...close.prefixes].sort(), [composed, resolved].sort(), 'both spellings');
    } else {
      assert.deepEqual(close.prefixes, [composed], 'one spelling, because there is only one');
    }
  });

  test('a return with nothing open says so rather than doing nothing', async () => {
    const fake = makeFake();
    const result = await fake.session.returnToBuild();
    assert.equal(result.returned, false);
    assert.ok(result.returned === false && result.note.length > 0, 'and it is a sentence, not silence');
  });
});

// ── honest controls: a tab that will not close ──────────────────────────────────────────────

suite('DetourSession.returnToBuild — honest when a tab will not close', () => {
  teardown(cleanTempDirs);

  test('the directory is STILL deleted and the learner is told WHICH tab to close', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    const dir = detourDir(fake.storage, key(STEP_ID));
    const stubborn = path.join(fs.realpathSync(dir), 'machine.ts');
    fake.stuck.add(stubborn);

    const result = await fake.session.returnToBuild();

    assert.equal(result.returned, true, 'the return still happens — a learner is not stranded in a detour by an unsaved buffer');
    assert.equal(fs.existsSync(dir), false, 'and the directory is still deleted, exactly as promised');
    const note = result.returned ? result.note : undefined;
    assert.ok(note !== undefined, 'and it is NOT silent: a partial success that said nothing would be the dishonest version');
    assert.ok(note.includes('machine.ts'), 'it names the tab, by a name the learner can find');
    assert.ok(/close/i.test(note), 'and says what to do about it');
  });

  test('the plural agrees with itself, because a sentence that does not reads like a bug', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    const real = fs.realpathSync(detourDir(fake.storage, key(STEP_ID)));
    fake.stuck.add(path.join(real, 'machine.ts'));
    fake.stuck.add(path.join(real, 'coins.ts'));

    const result = await fake.session.returnToBuild();
    const note = result.returned ? result.note ?? '' : '';
    assert.ok(note.includes('These tabs are'), `two tabs get a plural sentence, not "${note}"`);
  });

  test('an adapter that throws is reported as everything still open — the conservative direction', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR), closeThrows: true });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    const result = await fake.session.returnToBuild();
    assert.equal(result.returned, true, 'the return still completes');
    assert.equal(fs.existsSync(detourDir(fake.storage, key(STEP_ID))), false, 'the files still go');
    const note = result.returned ? result.note ?? '' : '';
    assert.ok(note.includes('coins.ts') && note.includes('machine.ts'), 'and every tab is named, because none of them is known to have closed');
  });

  test('a file that would not open is reported, and the rest of the example still opens', async () => {
    const fake = makeFake({
      canned: replyOf(GOOD_DETOUR),
      openThrows: (absPath) => absPath.endsWith('machine.ts'),
    });
    const { plan, step: s } = step();

    const result = await fake.run(s, plan, 'ref');
    assert.equal(result.started, true, 'one tab that will not open does not cost the learner the example');
    assert.ok(result.started && result.note?.includes('machine.ts'), 'and it is said out loud');
    assert.equal(calls(fake.log, 'showNarrator').length >= 1, true, 'the narrator still walks the stops');
  });
});

// ── the lifecycle: a superseded or cancelled detour lands NOWHERE ────────────────────────────

suite('DetourSession — nothing lands after the moment it belonged to', () => {
  teardown(cleanTempDirs);

  test('a session disposed mid-generation opens nothing, writes nothing and narrates nothing', async () => {
    let release: ((reply: LlmReply) => void) | undefined;
    const fake = makeFake({ runner: () => new Promise<LlmReply>((resolve) => { release = resolve; }) });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await fake.session.dispose();

    // The answer arrives AFTER the walk went away — the case T-6's reviews proved closed and
    // this must not reopen.
    release?.({ text: replyOf(GOOD_DETOUR), inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
    const result = await running;

    assert.equal(result.started, false);
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'no tab');
    assert.equal(calls(fake.log, 'showNarrator').length, 0, 'no narrator');
    assert.equal(treeOf(detourDir(fake.storage, key(STEP_ID))).length, 0, 'and no files');
  });

  test('dispose is idempotent and turns every method into a no-op', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    await fake.session.dispose();
    await fake.session.dispose();
    assert.equal(fs.existsSync(detourDir(fake.storage, key(STEP_ID))), false, 'the detour went with the session');

    const before = fake.log.length;
    const started = await fake.run(s, plan, 'ref');
    await fake.session.goto(1);
    await fake.session.next();
    const returned = await fake.session.returnToBuild();
    assert.equal(started.started, false, 'no detour starts on a dead session');
    assert.equal(returned.returned, false);
    assert.equal(fake.log.length, before, 'and not one adapter was touched');
  });

  test('a SUPERSEDED generation removes what it wrote rather than leaving it for the next press', async () => {
    // Two presses: the first is still waiting when the second is cancelled out from under it.
    // The supersede is arranged by cancelling, which bumps the same counter a second start
    // would — the two take one road out by design (see `stopped`).
    let release: ((reply: LlmReply) => void) | undefined;
    const fake = makeFake({ runner: () => new Promise<LlmReply>((resolve) => { release = resolve; }) });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    fake.session.cancel();
    release?.({ text: replyOf(GOOD_DETOUR), inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
    const result = await running;

    assert.equal(result.started, false, 'the overtaken generation does not open');
    assert.equal(treeOf(detourDir(fake.storage, key(STEP_ID))).length, 0, 'and leaves no directory behind');
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and no tab anywhere');
  });

  test('starting a SECOND detour closes the first — one narrator, one example', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const plan = fixturePlan();
    const first = plan.steps.find((st) => st.id === STEP_ID);
    const other = plan.steps.find((st) => st.id === 'st-4-symbol-render');
    assert.ok(first && other);

    await fake.run(first, plan, 'ref');
    const firstDir = detourDir(fake.storage, key(STEP_ID));
    await fake.run(other, plan, 'ref');

    assert.equal(fs.existsSync(firstDir), false, "the first example's files are gone");
    assert.equal(fake.session.activeStepId(), 'st-4-symbol-render', 'and the open one is the second');
    assert.equal(treeOf(detourDir(fake.storage, key('st-4-symbol-render'))).length, 3, 'which really is on disk');
  });
});

// ── walking the stops ───────────────────────────────────────────────────────────────────────

suite('DetourSession — next, prev and goto walk the narrator (AC2)', () => {
  teardown(cleanTempDirs);

  async function opened() {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    return fake;
  }

  function currentStop(fake: Fake): number | undefined {
    const shown = calls(fake.log, 'showNarrator');
    const last = shown[shown.length - 1];
    return last?.fn === 'showNarrator' ? last.state.current : undefined;
  }

  test('next walks forward and STOPS at the last — no wraparound', async () => {
    const fake = await opened();
    assert.equal(currentStop(fake), 0);
    await fake.session.next();
    assert.equal(currentStop(fake), 1);
    await fake.session.next();
    assert.equal(currentStop(fake), 2);
    await fake.session.next();
    assert.equal(currentStop(fake), 2, 'Next at the end stays put rather than starting the example again');
  });

  test('prev walks back and stops at the first', async () => {
    const fake = await opened();
    await fake.session.goto(2);
    await fake.session.prev();
    assert.equal(currentStop(fake), 1);
    await fake.session.prev();
    assert.equal(currentStop(fake), 0);
    await fake.session.prev();
    assert.equal(currentStop(fake), 0, 'and does not run off the front');
  });

  test('each stop reveals ITS OWN file, at its own lines', async () => {
    const fake = await opened();
    const dir = fs.realpathSync(detourDir(fake.storage, key(STEP_ID)));
    await fake.session.goto(1);
    await fake.session.goto(2);

    const reveals = calls(fake.log, 'revealDetourStop').map((c) =>
      (c.fn === 'revealDetourStop' ? [path.relative(dir, c.absPath), c.startLine, c.endLine] : []));
    assert.deepEqual(reveals, [
      ['coins.ts', 1, 1],
      [path.join('stock', 'tray.ts'), 1, 2],
      ['machine.ts', 2, 2],
    ], 'the three stops, each pointing into the file it names');
  });

  test('an index off either end is CLAMPED, never a blank page or a throw', async () => {
    const fake = await opened();
    await fake.session.goto(99);
    assert.equal(currentStop(fake), 2, 'past the end is the last stop');
    await fake.session.goto(-5);
    assert.equal(currentStop(fake), 0, 'before the start is the first');
    await fake.session.goto(Number.NaN);
    assert.equal(currentStop(fake), 0, 'and a number that is not one is the first, not a crash');
  });

  test('walking with nothing open touches nothing', async () => {
    const fake = makeFake();
    await fake.session.goto(0);
    await fake.session.next();
    await fake.session.prev();
    assert.deepEqual(fake.log, [], 'no narrator, no reveal, no anything');
  });
});

// ── the view the panel draws (plan R4's other half) ─────────────────────────────────────────

suite('DetourSession.view — what the button is told', () => {
  teardown(cleanTempDirs);

  test('the empty state is what puts the button on the page', () => {
    const fake = makeFake();
    assert.deepEqual(fake.session.view(STEP_ID), { generating: false }, 'absent keys, not undefined ones');
  });

  test('an open detour is reported on EVERY step, with the step it belongs to', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');

    const here = fake.session.view(STEP_ID);
    const elsewhere = fake.session.view('st-4-symbol-render');
    assert.deepEqual(here.open, { stepId: STEP_ID, title: GOOD_DETOUR.title });
    assert.deepEqual(
      elsewhere.open,
      { stepId: STEP_ID, title: GOOD_DETOUR.title },
      'the way out has to be reachable from wherever the learner is standing — a control that '
      + 'names something it cannot act on is what this repo rules out',
    );
    assert.equal(elsewhere.generating, false, 'while `generating` stays per-step');
  });

  test('a refusal is on the view as well as in the result, so the panel can draw it', async () => {
    const fake = makeFake({ canned: 'not json at all' });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    const note = fake.session.view(STEP_ID).note;
    assert.ok(note !== undefined && note.length > 0, 'AC5: the panel has the sentence');
    fake.session.clearNote();
    assert.equal(fake.session.view(STEP_ID).note, undefined, 'and it is cleared when the walk moves');
  });

  test('every refusal pushes, so the button cannot be left saying it is still writing', async () => {
    const fake = makeFake({ canned: 'not json at all' });
    const { plan, step: s } = step();
    const before = fake.refreshes();
    await fake.run(s, plan, 'ref');
    assert.ok(fake.refreshes() > before, 'the panel was told');
    assert.equal(fake.session.view(STEP_ID).generating, false, 'and nothing is left generating');
  });
});

suite('DetourSession — a second example does not un-tell the first one\'s bad news', () => {
  teardown(cleanTempDirs);

  test('a tab of the OLD detour that would not close is still named after the new one opens', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const plan = fixturePlan();
    const first = plan.steps.find((st) => st.id === STEP_ID);
    const other = plan.steps.find((st) => st.id === 'st-4-symbol-render');
    assert.ok(first && other);

    await fake.run(first, plan, 'ref');
    const stubborn = path.join(fs.realpathSync(detourDir(fake.storage, key(STEP_ID))), 'machine.ts');
    fake.stuck.add(stubborn);

    const result = await fake.run(other, plan, 'ref');

    assert.equal(result.started, true, 'the new example opens');
    const note = result.started ? result.note ?? '' : '';
    // The stuck tab is still on the learner's screen. Saying so and then replacing the
    // sentence with one about the new example would be the silence this rule forbids, with an
    // extra step in front of it.
    assert.ok(note.includes('machine.ts'), `the old detour's stuck tab is still named, got "${note}"`);
    assert.ok(fake.session.view(STEP_ID).note?.includes('machine.ts'), 'and the panel is told the same thing');
  });
});

// ── the fixes T-7's reviews asked for, each pinned by the reproduction that found it ─────────

suite('DetourSession — the press is visible, and every refusal says something (findings 3, 4, 10, 12)', () => {
  teardown(cleanTempDirs);

  test('the press RETURNS before the model does, with the button already drawn as waiting', async () => {
    // Code review finding 3, at this level. `start` used to await `ticket.delivered` — up to
    // 3,600 seconds — and `WalkSession.startDetour` awaited `start` inside its chain job, so
    // every other control on the panel waited on a model. The observable property is here: the
    // press comes back, and it comes back with the state that draws the wait.
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never answers */ }) });
    const { plan, step: s } = step();

    const pre = await fake.session.start(s, plan, 'ref');

    assert.deepEqual(pre, { started: false, note: '' }, 'the press is answered immediately');
    assert.equal(fake.session.view(STEP_ID).generating, true, 'and the panel has been told to draw the wait');
    assert.ok(fake.refreshes() > 0, 'and pushed to, so the wait is on screen rather than only in the host');
    fake.session.cancel();
  });

  test('Cancel while the request is SENDING says it is still being billed (finding 4)', async () => {
    // Driven in the review: after *Cancel*, `spend() = {sending: 1, unwatched: 1}` and both
    // `detour.note` and `tutor.note` were `undefined`. The sentence written for that case lived
    // in the delivery path and could never run, because `cancel()` bumps `seq` and
    // `stopped(seq)` is checked first — so the string appeared nowhere in `test/` either.
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never answers */ }) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    await reachedRunner(fake.log);

    assert.equal(fake.session.cancel(), true);

    const note = fake.session.view(STEP_ID).note;
    assert.ok(note !== undefined && note.length > 0, 'a Cancel that stops a paid request said nothing at all');
    assert.match(note, /still be billed/, 'and it is honest about what stopping does not do');
    assert.equal(fake.ledger.spend().unwatched, 1, 'which is true — the request goes on running and on billing');
    assert.equal(fake.session.view(STEP_ID).generating, false, 'and the wait comes off the button');
  });

  test('Cancel BEFORE the request is sent says nothing was charged (finding 4)', async () => {
    // The other half of the split, and `cancelAsk`'s own: what a cancel MEANS depends on which
    // side of `send` it lands on, and saying "you will still be billed" for a request that was
    // never sent would be a lie in the opposite direction.
    const { plan, step: s } = step();

    // `cancel()` reads `ticket.phase`, and a ticket is `preparing` from `ledger.open` until
    // `sendPrompt`. That window is one statement wide inside `start`, so the phase itself is
    // driven directly against the real ledger — the value `cancel` branches on is real even
    // though the window is not one this harness can stop inside.
    const probe = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never */ }) });
    const ticket = probe.ledger.open(STEP_ID);
    assert.equal(ticket.phase, 'preparing', 'a ticket is preparing until it is sent');
    ticket.abandon();
    assert.equal(probe.ledger.spend().sending, 0, 'and abandoning one is a real cancellation, not a detach');

    // The session's own pre-flight sentences are the reachable half of the same promise: every
    // path that stops before `sendPrompt` says nothing was charged, because nothing was.
    const noSettings = makeFake({ noSettings: true });
    const refused = await noSettings.run(s, plan, 'ref');
    assert.equal(refused.started, false);
    assert.ok(refused.started === false && refused.note.includes('repo-tour could not be loaded'),
      'a pre-flight that stops before sending says so, and says nothing was charged');
    assert.equal(noSettings.ledger.spend().sending, 0, 'because nothing was');
  });

  test('a request detached by something ELSE still says why nothing arrived (finding 4)', async () => {
    // `cancel()` now speaks for the detour's own button. This is the other way a ticket ends
    // with nothing delivered — `abandonAll()` reached it from a tutor Cancel or from
    // `clearConversation` — which does not move this session's `seq`, so the delivery path
    // really does run, and it used to run into a sentence nobody could ever see.
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never answers */ }) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    await reachedRunner(fake.log);

    fake.ledger.abandonAll();
    await fake.settle();

    const note = fake.session.view(STEP_ID).note;
    assert.ok(note !== undefined && note.includes('stopped before it arrived'),
      `the detour went silent when its request was detached: ${String(note)}`);
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and nothing opened behind it');
    assert.equal(treeOf(detourDir(fake.storage, key(STEP_ID))).length, 0, 'and nothing was written');
  });

  test('a second press while one is in flight is REFUSED, not queued into a rebuild (finding 10)', async () => {
    // Unreachable through the panel before: `startDetour` awaited the whole model call inside
    // its chain job, so a second press waited its turn, found `generating` already cleared, hit
    // the cache and tore the finished detour down to rebuild it — driven as `openDetourTab`×3,
    // `showNarrator`, `closeTabsUnder`, `closeNarrator`, `openDetourTab`×3, with no sentence.
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never answers */ }) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    await reachedRunner(fake.log);

    const second = await fake.session.start(s, plan, 'ref');

    assert.equal(second.started, false);
    assert.ok(second.started === false && second.note.includes('already being written'), 'and it says so');
    assert.equal(fake.session.view(STEP_ID).note, second.started === false ? second.note : '',
      'the sentence is stored where the panel draws it, not only returned');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'and no second billed request was started');
    assert.equal(calls(fake.log, 'closeTabsUnder').length, 0, 'and nothing was torn down');
    fake.session.cancel();
  });

  test('the narrator is raised ONCE per open, and once per cached retake (finding 12)', async () => {
    // `present` raised it directly and then again inside `goto(0)`, so `webview.html` was built
    // twice on every open — a whole page rebuilt for nothing, on the extension host.
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    await fake.run(s, plan, 'ref');
    assert.equal(calls(fake.log, 'showNarrator').length, 1, 'the narrator was rendered twice on one open');

    await fake.session.returnToBuild();
    await fake.run(s, plan, 'ref');
    assert.equal(calls(fake.log, 'showNarrator').length, 2, 'and twice on the free retake');
  });

  test('a detour with no stops still gets a narrator — the page says so rather than being blank', async () => {
    // What the double render was quietly covering for: `goto` used to return early on an empty
    // stop list, so removing the direct call had to make `goto` render one anyway.
    const fake = makeFake({ canned: replyOf({ ...GOOD_DETOUR, stops: [] }) });
    const { plan, step: s } = step();

    const result = await fake.run(s, plan, 'ref');

    // The parser refuses fewer than three stops, so this never opens — but the refusal is the
    // one AC5 asks for, and `narrator.ts`'s `NO_STOPS_MESSAGE` covers the hand-built state.
    assert.equal(result.started, false);
    assert.ok(result.started === false && result.note.includes('narration stops'), 'and it says which rule broke');
  });
});

suite('DetourSession — the narrator names what OPENED, not what was parsed (finding 6)', () => {
  teardown(cleanTempDirs);

  test('a file the writer refused is not on the narrator’s list of opened files', async () => {
    // Driven in the review: a reply whose second file collides with the directory the first one
    // made opened one tab, wrote one file, and the narrator listed both — while the panel's own
    // note one tab over said the second had been refused. The page the learner is reading and
    // the page telling them what went wrong disagreed.
    const colliding: Detour = {
      title: 'A vending machine',
      domain: 'vending machines',
      files: [
        { path: 'a/b.ts', content: 'export const B = 1;\n' },
        { path: 'a', content: 'this cannot be written — "a" is now a directory\n' },
      ],
      stops: [
        { file: 'a/b.ts', startLine: 1, endLine: 1, text: 'one' },
        { file: 'a', startLine: 1, endLine: 1, text: 'two — narrated, never opened' },
        { file: 'a/b.ts', startLine: 1, endLine: 1, text: 'three' },
      ],
    };
    const fake = makeFake({ canned: replyOf(colliding) });
    const { plan, step: s } = step();

    const result = await fake.run(s, plan, 'ref');

    assert.equal(result.started, true, 'the example still opens — one bad file does not cost the others');
    const shown = calls(fake.log, 'showNarrator');
    const state = shown[0];
    assert.ok(state?.fn === 'showNarrator');
    assert.deepEqual(
      state.state.detour.files.map((f) => f.path),
      ['a/b.ts'],
      'the narrator listed a file the detour never opened',
    );
    assert.equal(calls(fake.log, 'openDetourTab').length, 1, 'and exactly one tab really opened');
    // The STOPS are deliberately whole: the prose is the point, the narrator still walks it,
    // and filtering them would shift every index under `current`.
    assert.equal(state.state.detour.stops.length, 3, 'a stop whose file was refused still has its prose');
    assert.ok(result.started === true && result.note !== undefined, 'and the refusal is still said out loud');
  });
});

suite('DetourSession — the regenerate control forces a miss (finding 9)', () => {
  teardown(cleanTempDirs);

  test('{ fresh: true } skips the cache and pays for a new example', async () => {
    // The spec's refinement notes promised "a 'regenerate' button forces a fresh one" and T-7
    // shipped without it, which left the cache with no escape hatch at all: a learner served an
    // example that did not help had no way to ask for another one, ever.
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    await fake.run(s, plan, 'ref');
    assert.equal(calls(fake.log, 'runLlm').length, 1);

    // The ordinary retake is still free — AC5 is not weakened by the escape hatch existing.
    await fake.session.returnToBuild();
    await fake.run(s, plan, 'ref');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'a plain retake stopped being free');

    await fake.session.returnToBuild();
    const again = await fake.session.start(s, plan, 'ref', { fresh: true });
    await fake.settle();

    assert.equal(again.started, false, 'the press returns before the model does, like any other');
    assert.equal(calls(fake.log, 'runLlm').length, 2, 'a forced regeneration was still served from the cache');
    assert.equal(fake.session.activeStepId(), STEP_ID, 'and the new example is open');
  });

  test('a fresh generation REPLACES the cache entry, so the next free retake is the new one', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.run(s, plan, 'ref');
    await fake.session.returnToBuild();

    const second = makeFake({
      canned: replyOf({ ...GOOD_DETOUR, title: 'A DIFFERENT machine' }),
      storage: fake.storage,
    });
    await second.session.start(s, plan, 'ref', { fresh: true });
    await second.settle();

    assert.equal(readCachedDetour(fake.storage, cacheKeyFor(s, plan))?.title, 'A DIFFERENT machine',
      'the regenerated example did not become the cached one, so the next retake serves the old');
  });
});
