// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vscode-test suite for the tutor (T-6): the REAL registered walk asking a REAL model layer —
 * with a stand-in where the model would be, because this is the one feature in this extension
 * that spends the learner's money and a test suite may not spend a penny of it.
 *
 * Everything here reaches the tutor the way a learner does: `ExtensionApi._walk` for the
 * surfaces `activate()` registered, `StepViewProvider.dispatchForTest` to send the exact
 * `tutor:ask` / `tutor:cancel` the webview sends, and `panel.webview.html` — the page actually
 * on screen — to read the answer back. Nothing constructs its own session, its own panel or
 * its own `TutorDeps`: a copy would prove something about a copy, and for the tutor that is
 * not a stylistic point. The registered session is the only object whose ask is genuinely
 * wired to a provider, so it is the only one whose ask being wired to a FAKE proves anything
 * about the wiring at all.
 *
 * **What only a real extension host can prove, and is therefore what lives here:**
 *   - that a question typed into the REGISTERED panel travels
 *     `webview → parseStepMessage → handleStepMessage → WalkSession.ask → tutor/ask.ts → the
 *     core's runLlm`, and that the answer comes back through `WalkAdapters.setPanel` into the
 *     page — six modules whose unit suites each prove their own link and none of which can
 *     prove they are joined;
 *   - that the reply lands in BOTH places at once (AC1/AC2): the panel's live state and
 *     `<target>/.repo-tour/build/progress.json` on a real disk, read back through
 *     `getTranscript` exactly as the plan's reconciliation table insists;
 *   - that `progress.steps[id].transcript` is really keyed by step — the walk navigating with
 *     the real `buildTutorials.goToStep` command, not a hand-built `Progress`;
 *   - that the context reaching the model is built by repo-tour's OWN `buildAskPrompt` out of
 *     a real `git diff --no-index` against a real reference tree (AC3), which needs both a
 *     loaded core and a filesystem;
 *   - that an unreachable provider is answered with the provider's own sentence and leaves no
 *     thinking state on the real page (AC4) — asserted on the ELEMENTS in `webview.html`,
 *     because "the host knew" and "the learner saw" are different claims and only the second
 *     one is the criterion;
 *   - that a model reply carrying an HTML payload contributes no element to that page but the
 *     one `<pre>` a code fence is allowed (AC5);
 *   - that a cancelled ask leaves no spinner and that its answer, which is still being paid
 *     for, can never appear afterwards.
 *
 * **What is already covered with no extension host at all, under `test/unit/`**, and is not
 * re-asserted here: `tutor-ask.test.ts` owns `askTutor`'s four outcomes, its deadline race and
 * `AskRun.detach` against an injected runner; `tutor-context.test.ts` owns every field of the
 * `AskContext` and all four "no diff" sentences; `tutor-transcript.test.ts` owns
 * `sanitizeTranscript`'s drop-don't-coerce rule and the `MAX_TURNS_KEPT` cap;
 * `walk-step-view.test.ts` owns `answerHtml`'s fence grammar case by case and
 * `stepRenderKey`'s mutation table; `walk-step-protocol.test.ts` owns the two refusals. Those
 * run in milliseconds and are where a failure is easiest to read. What is left for this file
 * is the claim none of them can make: that the parts are connected to each other and to a
 * provider.
 *
 * ## Not one token is spent in here, and it is enforced rather than promised
 *
 * `ExtensionApi._walk.useTutorCore` puts a stand-in in front of the tutor's slice of
 * repo-tour for the registered session's next ask. Every stand-in this file builds keeps the
 * REAL core's pure members — so an ask goes through repo-tour's genuine `buildAskPrompt`,
 * `buildContextBlock` and `trimMessages`, and AC3 is a claim about the shipped prompt rather
 * than about a mock agreeing with itself — and replaces exactly the two members that touch
 * the world:
 *
 *   - **`runLlm` is POISONED** by default (`coreWith`), so a test that forgets to answer for
 *     itself fails loudly instead of quietly dialling a provider. `the spend guard is armed`
 *     drives that poison through the whole registered session on purpose: it is what proves
 *     the poison is real, and therefore that every other test here — all of which get their
 *     canned text back — went through the injected runner and nowhere near a CLI.
 *   - **`availability` is stubbed to a fast yes**, because repo-tour's real claude probe
 *     shells out to `claude --version`: free, but slow and dependent on the machine. The one
 *     suite that WANTS the real probe — AC4's — asks for it by name and makes it answer "no"
 *     by pointing `REPO_TOUR_CLAUDE_BIN` at a path that does not exist.
 *
 * That env var name is the plan's own reconciliation finding, and it is the difference between
 * a test and a decoration: `BUILD_TUTORIALS_CLAUDE` is this extension's SETTING and reaches no
 * provider, `REPO_TOUR_CLAUDE_BIN` is what repo-tour's `resolveBin('claude', …)` actually
 * reads. `claude` is genuinely installed on the machine this was written on, so the wrong
 * name would have left the provider available and the AC4 tests passing for the wrong reason.
 * `resolveBin` only `access()`es the path it is given and does not fall through to `PATH` when
 * an explicit one is set, so that suite spawns nothing either.
 *
 * ## Every test cleans up after itself, and a leaked session is not a slow test but a wrong one
 *
 * The four walk surfaces are window-wide singletons made once in `activate()`. A session left
 * running keeps driving them into whichever test runs next, an ask left in flight keeps
 * holding a temp directory open, and a stand-in left installed would silently answer the NEXT
 * file's asks. So `teardownTutor` disposes the session, restores the real core, restores the
 * env var and removes every temp directory this file made — in that order.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { LlmChoice, LlmReply, TutorCore } from '../src/tutor/core.js';
import { getTranscript } from '../src/tutor/transcript.js';
import type { WalkSession } from '../src/walk/session.js';
import { loadPlan, loadProgress } from '../src/walk/store.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

/** VS Code auto-generates `<viewId>.focus` for every contributed view — the only way to make
 *  the step view resolve, and so the only way `panel.webview` is anything but `undefined`. */
const STEP_VIEW_FOCUS = 'buildTutorials.step.focus';

/** The two fixture steps this file argues about (`test/unit/walk-fixtures.ts` has the rest).
 *  Two, because "one transcript per step" is not a claim one step can carry. */
const STEPS = {
  /** `file`, target `src/parse.ts` — two options, one of them the author's, a real `why`. */
  file: 'st-2-file-parse',
  /** `symbol`, target `src/api/routes.ts` — a different step with a different conversation. */
  handle: 'st-3-symbol-handle',
} as const;

/** The fixture step's own question, quoted from `walk-fixtures.ts` rather than paraphrased:
 *  AC3 is that THIS reaches the model, so a near-enough copy would prove nothing. */
const STEP_QUESTION = 'Why does the tokenizer get its own module?';

/** The author's option on that step, as `renderOptionsText` and repo-tour's `buildContextBlock`
 *  both spell it — the marker that says the tutor was told which road was actually taken. */
const AUTHORS_OPTION = '[author] What the author did — parse.ts owns 2 exported symbols and depends on 0 imports.';

/** One line the author's copy of `src/parse.ts` has and the learner's does not, so the real
 *  `git diff --no-index` has something to say and AC3 can point at it in the prompt. */
const AUTHOR_ONLY_LINE = 'export const TOKENIZER_OWNS_ITS_OWN_MODULE = true;';

/** What a poisoned `core.runLlm` says. Reaching a provider is never a thing this file does by
 *  accident; if this string appears in a panel, a test forgot to answer for itself. */
const SPEND_GUARD = 'a test in tutor.test.ts reached the real model';

/** repo-tour's own sentence for a claude binary it cannot find (`src/llm.ts`). Its words. */
const PROVIDER_SAYS_MISSING = 'not found on PATH';

/** The env var repo-tour's claude provider really reads — see this file's header on why the
 *  name matters more here than anywhere else in the suite. */
const BIN_ENV = 'REPO_TOUR_CLAUDE_BIN';

// ── the harness ───────────────────────────────────────────────────────────────────────────

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return await ext.activate();
}

/** Every temp directory this file has made — targets and references alike — emptied in
 *  `teardownTutor`. One list, because both kinds are equally somebody's disk. */
const tempDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** The three files the fixture plan's steps point at, in the reference as in the target. */
const REFERENCE_FILES = ['src/parse.ts', 'src/api/routes.ts', 'src/api/render.ts'];

/**
 * A tutorial the tutor can actually be asked about: the fixture target, an author's repository
 * beside it, and the `request.json` that joins the two.
 *
 * `request.json` is not decoration here the way it is elsewhere. `WalkSession.beginAsk` refuses
 * to ask at all without `request.referenceRoot` — the tutor's context is built AGAINST the
 * author's tree (`src/tutor/context.ts`), and asking without it would spend the learner's
 * money on a question with half its context missing — so a fixture without one would make
 * every test in this file assert the same refusal.
 *
 * The dial is `manual`, which is the walk's own default and the position in which the extension
 * writes nothing: the learner's `src/parse.ts` stays exactly as `writeFixtureTarget` left it,
 * so the diff the tutor is shown is a fact about the fixture rather than about whatever the
 * entry pass did on its way past.
 *
 * The author's copy of `src/parse.ts` is the learner's plus `AUTHOR_ONLY_LINE`, so the diff is
 * non-empty, small, and has something in it a test can name.
 */
function newTutorial(): { target: string; refRoot: string } {
  const target = tmpDir('tutor-test-target-');
  writeFixtureTarget(target);

  const refRoot = tmpDir('tutor-test-reference-');
  for (const rel of REFERENCE_FILES) {
    const to = path.join(refRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(target, rel), to);
  }
  fs.appendFileSync(path.join(refRoot, 'src/parse.ts'), `\n${AUTHOR_ONLY_LINE}\n`);

  fs.writeFileSync(
    path.join(target, '.repo-tour', 'build', 'request.json'),
    `${JSON.stringify({ idea: '', recreate: true, repo: refRoot, referenceRoot: refRoot, target, dial: 'manual' }, null, 2)}\n`,
  );
  return { target, refRoot };
}

/** Opens the walk through the real activation path and hands back the REGISTERED surfaces,
 *  with the entry pass for the step it opened on already finished. */
async function openWalk(dir: string) {
  const api = await getApi();
  await api._walk.openAt(dir);
  const session = api._walk.session();
  const panel = api._walk.panel();
  assert.ok(session, 'opening the walk should leave a live session behind');
  assert.ok(panel, 'the step view provider should have been registered in activate()');
  assert.equal(session.target, dir, 'the session should be walking the folder it was opened at');
  await session.settled();
  return { api, session, panel };
}

/** The command every tree leaf carries, followed by the wait the session's own contract asks
 *  for — `settled()` drains the job chain AND any ask those jobs left in flight. */
async function goTo(session: WalkSession, stepId: string): Promise<void> {
  await vscode.commands.executeCommand('buildTutorials.goToStep', stepId);
  await session.settled();
}

/** Makes the step view resolve, so `panel.webview.html` is the page really on screen rather
 *  than `undefined`. Loud rather than skipped when it does not: a test that quietly passed
 *  with no page to read would be worse than no test (`test/walk.test.ts` says the same). */
async function showPanel(panel: { webview: vscode.Webview | undefined }): Promise<void> {
  await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
  await settle();
  assert.ok(panel.webview, `the step view did not resolve in this host, so ${STEP_VIEW_FOCUS} proves nothing about what is on screen`);
}

/** Whatever `BIN_ENV` was before a test touched it, so `teardownTutor` can put it back
 *  whether the test that changed it passed, failed or threw halfway through. */
let savedBinEnv: string | undefined;
let binEnvChanged = false;

function breakTheProvider(): void {
  savedBinEnv = process.env[BIN_ENV];
  binEnvChanged = true;
  // An explicit-but-broken override does NOT fall through to PATH in repo-tour's `resolveBin`,
  // so this makes the real probe answer "no" on any machine, `claude` installed or not.
  process.env[BIN_ENV] = path.join(os.tmpdir(), 'build-tutorials-no-such-claude');
}

async function teardownTutor(): Promise<void> {
  const api = await getApi();
  // The stand-in first: a disposed session detaches its ask, and nothing should be able to
  // answer one after this line whatever order the rest runs in.
  api._walk.useTutorCore(undefined);
  api._walk.session()?.dispose();
  api._walk.decorator()?.clear();
  if (binEnvChanged) {
    if (savedBinEnv === undefined) delete process.env[BIN_ENV];
    else process.env[BIN_ENV] = savedBinEnv;
    binEnvChanged = false;
    savedBinEnv = undefined;
  }
  // A reveal already in flight when the session was disposed still finishes and still opens
  // its document; closing the editors before it lands would leave it opening one behind us.
  await settle();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

const POLL_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Long enough for a view change to make it back across the extension-host boundary. */
function settle(): Promise<void> {
  return delay(300);
}

/** Polls until `ok()`, or fails naming what never happened — `test/walk.test.ts`'s helper,
 *  and needed here for the same reason: an ask is asynchronous by construction, so reading
 *  the thinking state straight after a dispatch is reading it too early. */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await delay(POLL_MS);
  }
}

// ── the stand-in core: the whole reason this suite costs nothing ───────────────────────────

/** The extension's OWN tutor core, loaded exactly as a real window loads it. Memoised by
 *  `ensureTutorCore` on the other side of the seam, so asking for it per test costs nothing. */
async function realCore(): Promise<TutorCore> {
  const api = await getApi();
  const core = await api._walk.tutorCore();
  assert.ok(core, 'repo-tour should load from the configured checkout — without it there is no tutor to test');
  return core;
}

/**
 * The real core with the two world-touching members replaced: `runLlm` poisoned so it can only
 * ever be a test failure, `availability` stubbed to a fast yes. Overrides are applied LAST, so
 * a suite that wants the genuine probe back can ask for it by name — which AC4's does.
 */
async function coreWith(overrides: Partial<TutorCore> = {}): Promise<TutorCore> {
  return {
    ...(await realCore()),
    runLlm: () => Promise.reject(new Error(SPEND_GUARD)),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
    ...overrides,
  };
}

/** Installs a stand-in for the registered session's next ask. Restored in `teardownTutor`. */
async function useCore(core: TutorCore): Promise<void> {
  (await getApi())._walk.useTutorCore(core);
}

/** One call to the injected runner, exactly as `askTutor` made it. */
interface Sent {
  prompt: string;
  choice: LlmChoice;
  cwd: string;
  timeoutMs: number | undefined;
}

/** The canned cost every fake answer carries. `metered: false` is the honest flag for a reply
 *  nobody was billed for — see `AskCost`: zeros mean UNKNOWN, never free. */
function cannedReply(text: string): LlmReply {
  return { text, inputTokens: 0, outputTokens: 0, usd: 0, metered: false };
}

/** A stand-in that records what the model was asked and answers with `text`. */
async function recordingCore(text: string): Promise<{ calls: Sent[]; core: TutorCore }> {
  const calls: Sent[] = [];
  const core = await coreWith({
    runLlm: (prompt, choice, cwd, timeoutMs) => {
      calls.push({ prompt, choice, cwd, timeoutMs });
      return Promise.resolve(cannedReply(text));
    },
  });
  return { calls, core };
}

/** An answer that arrives only when a test says so — the shape a cancel needs, since a reply
 *  that had already landed would leave nothing to cancel. */
function gate(): { promise: Promise<LlmReply>; open: (text: string) => void } {
  let open: (text: string) => void = () => undefined;
  const promise = new Promise<LlmReply>((resolve) => {
    open = (text) => { resolve(cannedReply(text)); };
  });
  return { promise, open };
}

// ── reading the page as ELEMENTS, never as a substring ─────────────────────────────────────

/**
 * The tutor section of the page, and nothing else on it.
 *
 * Every assertion about markup in this file is scoped through here first, because the page
 * also carries a client script and a skin picker whose own text would otherwise answer for the
 * transcript. `tutorHtml` nests no `<section>`, so the first closer after the opener is its.
 */
function tutorSection(panel: { webview: vscode.Webview | undefined }): string {
  const html = panel.webview?.html ?? '';
  const start = html.indexOf('<section class="tutor">');
  assert.notEqual(start, -1, 'the step page must carry a tutor section — it is drawn on every step');
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, 'the tutor section must be closed');
  return html.slice(start, end);
}

/**
 * Every element NAME the fragment opens, in order.
 *
 * A tag scan rather than a substring search, and that distinction is the whole of AC5's
 * assertion: `escapeHtml` leaves quotes alone (it escapes `&`, `<` and `>` and nothing else),
 * so a correctly escaped reply about HTML still contains `"` and `=` and reads, to a
 * `String.includes`, exactly like the attack it is quoting. What separates the two is whether
 * the browser would see an ELEMENT, and that is a question about `<` followed by a name.
 */
function elementsIn(fragment: string): string[] {
  return [...fragment.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => (m[1] ?? '').toLowerCase());
}

/** Every `id="…"` in the fragment — how this file asks which CONTROLS a page is offering,
 *  rather than matching on a label that could appear in a model's own sentence. */
function idsIn(fragment: string): string[] {
  return [...fragment.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1] ?? '');
}

/** The inner HTML of each `<div class="turn-text">` — one per rendered transcript turn, in
 *  order. A turn's text holds only escaped text and `<pre>`, so it never contains a `</div>`. */
function turnTexts(fragment: string): string[] {
  return [...fragment.matchAll(/<div class="turn-text">([\s\S]*?)<\/div>/g)].map((m) => m[1] ?? '');
}

/** The inner HTML of each `<p class="<cls>"…>` — the honest lines (`tutor-unreachable`,
 *  `tutor-note`) the panel draws beside the input. */
function paragraphsOfClass(fragment: string, cls: string): string[] {
  const re = new RegExp(`<p class="${cls}"[^>]*>([\\s\\S]*?)</p>`, 'g');
  return [...fragment.matchAll(re)].map((m) => m[1] ?? '');
}

/** The whole opening tag carrying `id="<id>"`, so a test can ask which ATTRIBUTES a control
 *  has rather than whether some string appears somewhere near it. */
function tagWithId(fragment: string, id: string): string {
  const match = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(fragment);
  assert.ok(match, `the page should be drawing a control with id="${id}"`);
  return match[0];
}

/** Tags out, entities back — what a reader actually SEES in a fragment. `&amp;` is undone last
 *  so an escaped `&lt;` in the model's own text cannot be decoded twice into a real `<`. */
function readableText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ── AC1 / AC2: one conversation, per step, in two places at once ───────────────────────────

suite('AC1/AC2 — the answer lands in the panel and on disk, under the step it was asked on', () => {
  teardown(teardownTutor);

  test('a question asked in the REGISTERED panel comes back as a turn, in the state and in progress.json', async () => {
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    const { calls, core } = await recordingCore('Because the router would otherwise have two jobs.');
    await useCore(core);
    await goTo(session, STEPS.file);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'Why not keep it inline?' } });
    await session.settled();

    const expected = [
      { role: 'user', content: 'Why not keep it inline?' },
      { role: 'assistant', content: 'Because the router would otherwise have two jobs.' },
    ];
    assert.deepEqual(
      panel.getStateForTest()?.transcript,
      expected,
      'the panel must be holding both turns — the learner\'s question and the model\'s answer, in that order',
    );
    assert.deepEqual(
      getTranscript(loadProgress(target, loadPlan(target)), STEPS.file),
      expected,
      'and the same two turns must be on disk under this step, read back the one way the plan allows — through getTranscript, never off progress.steps[id].transcript',
    );
    assert.equal(calls.length, 1, 'one press of Ask is one call to the model, and there is no retry behind it');
  });

  test('switching steps switches transcripts, and coming back restores', async () => {
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    await useCore((await recordingCore('The parser stays one job.')).core);

    await goTo(session, STEPS.file);
    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'about parse.ts' } });
    await session.settled();

    await goTo(session, STEPS.handle);
    assert.deepEqual(
      panel.getStateForTest()?.transcript,
      [],
      'a step nobody has asked about has an EMPTY conversation — the previous step\'s must not follow the learner across',
    );

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'about routes.ts' } });
    await session.settled();
    assert.deepEqual(
      panel.getStateForTest()?.transcript.map((turn) => turn.content),
      ['about routes.ts', 'The parser stays one job.'],
      'this step\'s conversation is its own',
    );

    await goTo(session, STEPS.file);
    assert.deepEqual(
      panel.getStateForTest()?.transcript.map((turn) => turn.content),
      ['about parse.ts', 'The parser stays one job.'],
      'and returning restores the FIRST step\'s conversation, unchanged and not appended to',
    );

    const onDisk = loadProgress(target, loadPlan(target));
    assert.deepEqual(
      [
        getTranscript(onDisk, STEPS.file).map((turn) => turn.content),
        getTranscript(onDisk, STEPS.handle).map((turn) => turn.content),
      ],
      [
        ['about parse.ts', 'The parser stays one job.'],
        ['about routes.ts', 'The parser stays one job.'],
      ],
      'the split survives the round trip to disk, which is where AC2 actually has to hold',
    );
  });
});

// ── AC3: the context really reaches the model ──────────────────────────────────────────────

suite('AC3 — the prompt is the core\'s own, and the step is really in it', () => {
  teardown(teardownTutor);

  /**
   * The distinction this test exists for: that a call HAPPENED is worth nothing. What AC3 asks
   * is whether the model was told about this step, and the only place that can be checked is
   * the string the runner was handed.
   *
   * Every marker asserted below is repo-tour's, not ours — `--- THE BUILD STEP ---`,
   * `Question: `, `[author] … — …`, `READER: ` all come out of `ask.ts`'s `buildContextBlock`
   * and `buildAskPrompt`. The stand-in keeps those members of the real core untouched, so this
   * is a claim about the prompt that ships and not about a fake agreeing with itself.
   */
  test('the runner receives this step\'s question, the author\'s option and the learner\'s real diff', async () => {
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    const { calls, core } = await recordingCore('Because a tokenizer has one job.');
    await useCore(core);
    await goTo(session, STEPS.file);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'Why is this its own file?' } });
    await session.settled();

    const sent = calls[0];
    assert.ok(sent, 'the ask must have reached the injected runner');
    assert.ok(sent.prompt.includes('--- THE BUILD STEP ---'), 'the prompt must be the core\'s own — this heading is buildContextBlock\'s, and nothing in this extension writes it');
    assert.ok(sent.prompt.includes(`Question: ${STEP_QUESTION}`), 'the step\'s question must be in the prompt, verbatim');
    assert.ok(sent.prompt.includes(AUTHORS_OPTION), 'and the author\'s option WITH its consequence, marked as the road actually taken');
    assert.ok(sent.prompt.includes('[alternative] Tokenize inside the router'), 'and the road not taken, marked as not taken');
    assert.ok(
      sent.prompt.includes(AUTHOR_ONLY_LINE),
      'and the learner\'s file against the author\'s: a real `git diff --no-index` of the fixture target against the reference tree, carrying the one line only the author\'s copy has',
    );
    assert.ok(sent.prompt.includes('READER: Why is this its own file?'), 'and the question the learner actually typed, as the last turn of the conversation');
    assert.equal(sent.cwd, target, 'the provider is run in the LEARNER\'s folder, never in the author\'s repository');
  });
});

// ── the spend guard ────────────────────────────────────────────────────────────────────────

suite('nothing in this file can reach a model', () => {
  teardown(teardownTutor);

  /**
   * The test that makes every other test in this file mean something.
   *
   * It drives the whole registered session with a core whose `runLlm` is the poison and
   * nothing else changed, and finds the poison's own words in the panel. Two things follow.
   * The session's only route to a provider really is `core.runLlm` — there is no second path,
   * no direct spawn, no fallback — so a stand-in that replaces it replaces the whole of the
   * spending. And every other test here, all of which get their canned text back rather than
   * this sentence, went through their injected runner and nowhere near a CLI.
   */
  test('the spend guard is armed: the session\'s only route to a provider is core.runLlm', async () => {
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    await useCore(await coreWith());
    await goTo(session, STEPS.file);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'anything at all' } });
    await session.settled();

    const state = panel.getStateForTest();
    assert.ok(
      (state?.tutor?.note ?? '').includes(SPEND_GUARD),
      `a poisoned runLlm must be what answers, and its words must reach the panel — got: ${state?.tutor?.note ?? '(no note)'}`,
    );
    assert.deepEqual(
      state?.transcript.map((turn) => turn.role),
      ['user'],
      'a failure is a note ABOUT the conversation, never a turn IN it: nothing may store a provider error as something the tutor said',
    );
    assert.equal(state?.tutor?.thinking, false, 'and a failure, like every other outcome, ends with the spinner off');
  });
});

// ── AC4: honest when unreachable, and no spinner left behind ───────────────────────────────

suite('AC4 — an unreachable provider is answered in the provider\'s own words', () => {
  teardown(teardownTutor);

  /**
   * The criterion in one test: *with no provider available the panel says so immediately and
   * never shows a spinner that does not end.*
   *
   * The probe is the REAL one — `availability` is delegated back to the genuine core, and
   * `REPO_TOUR_CLAUDE_BIN` points at a path that does not exist — so the sentence on the page
   * is repo-tour's own rather than something this suite made up. `runLlm` is the RECORDER
   * rather than the poison, and deliberately: `calls.length === 0` is then a real measurement
   * of "the probe came before the prompt was built and before a runner was reached for", and
   * a premise that ever broke — a provider that came back available — would show up as a
   * recorded call rather than as a test that passed for the wrong reason. It still spends
   * nothing, because the recorder is a stand-in like every other in this file.
   *
   * Both halves are asserted, and the second is the one that is actually AC4. The host knowing
   * `thinking: false` and the learner seeing a page with no spinner on it are different claims
   * — `stepRenderKey` is what joins them and it is a line somebody can delete — so the
   * controls are read off the ELEMENTS of the page that is really on screen.
   */
  test('the panel shows the provider\'s reason, offers Ask rather than Cancel, and never spent a thing', async () => {
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    const { calls, core } = await recordingCore('this answer must never be reached');
    const real = await realCore();
    await useCore({ ...core, availability: (id) => real.availability(id) });
    breakTheProvider();
    await goTo(session, STEPS.file);
    await showPanel(panel);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'is anybody there?' } });
    await session.settled();
    await settle();

    const state = panel.getStateForTest();
    assert.equal(
      state?.tutor?.unreachable,
      PROVIDER_SAYS_MISSING,
      'the provider\'s OWN sentence must be carried through — "not found on PATH" tells a learner what to do and a house phrasing does not',
    );
    assert.equal(state?.tutor?.thinking, false, 'the host must not think an ask is in flight');
    assert.equal(calls.length, 0, 'and nothing may have been sent: the probe comes BEFORE the prompt is built and before a runner is reached for');

    const section = tutorSection(panel);
    assert.deepEqual(
      paragraphsOfClass(section, 'tutor-unreachable').map(readableText),
      [PROVIDER_SAYS_MISSING],
      'and the reason must be ON THE PAGE, beside the input, as the line the panel draws for exactly this',
    );
    assert.deepEqual(
      idsIn(section).filter((id) => id === 'btn-tutor-ask' || id === 'btn-tutor-cancel' || id === 'tutor-thinking'),
      ['btn-tutor-ask'],
      'no spinner and no Cancel may remain on the page, and Ask must still be there: an unreachable provider does not take the input away, it explains itself beside it',
    );
    assert.ok(
      !/\bdisabled\b/.test(tagWithId(section, 'tutor-input')),
      'and the box itself must stay live: the ticket\'s own wording is that the panel shows the reason where the input is and disables nothing silently — a learner who installs claude in the next terminal over presses Ask again, they do not reload the window',
    );
  });

  test('the learner\'s question is not recorded, because nothing was asked and nothing was charged', async () => {
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    const real = await realCore();
    await useCore(await coreWith({ availability: (id) => real.availability(id) }));
    breakTheProvider();
    await goTo(session, STEPS.file);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'is anybody there?' } });
    await session.settled();

    assert.deepEqual(panel.getStateForTest()?.transcript, [], 'a refused ask leaves no half-conversation behind');
    assert.deepEqual(
      getTranscript(loadProgress(target, loadPlan(target)), STEPS.file),
      [],
      'and writes nothing to progress.json either',
    );
  });
});

// ── AC5: a model reply is untrusted text ───────────────────────────────────────────────────

suite('AC5 — a reply renders as text, and a fence is the only markup it can produce', () => {
  teardown(teardownTutor);

  /**
   * The reply below is the answer a tutor asked about escaping would really give: it quotes an
   * `<img onerror>` and a `<script>` because that is what the question is about, and it puts
   * some HTML in a code fence because that is what a code fence is for. None of it is exotic,
   * and all of it would execute inside a webview holding this extension's `postMessage` bridge
   * if `answerHtml` ever stopped escaping.
   *
   * The assertion is on the ELEMENTS the turn contributes, for the reason `elementsIn`'s own
   * comment gives: escaped text legitimately still contains quotes and equals signs, so a
   * substring test cannot tell a rendered attack from a described one. `['pre']` — exactly one
   * element, the fence's, with the fence's language tag nowhere in it — is the claim.
   */
  test('an HTML payload in an answer contributes no element to the page but the fence\'s own <pre>', async () => {
    const payload = [
      'Never trust this: <img src=x onerror="alert(1)"> or <script>alert(2)</script>.',
      '',
      '```html',
      '<b class="danger">this is a code sample, not markup</b>',
      '```',
      'Angle brackets are ordinary: Array<T> & Map<K, V>.',
    ].join('\n');

    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    await useCore((await recordingCore(payload)).core);
    await goTo(session, STEPS.file);
    await showPanel(panel);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'how does this panel stay safe?' } });
    await session.settled();
    await settle();

    const turns = turnTexts(tutorSection(panel));
    assert.equal(turns.length, 2, 'the page should be drawing the question and the answer');
    const answer = turns[1] ?? '';

    assert.deepEqual(
      elementsIn(answer),
      ['pre'],
      'the ONE element a reply may contribute is the code fence\'s <pre> — an <img>, a <script> or a <b> in this list means a model\'s text became markup inside a webview holding this extension\'s bridge',
    );
    assert.ok(answer.includes('<pre class="tutor-code">'), 'and the fence\'s language tag is discarded rather than interpolated into an attribute');
    assert.equal(
      readableText(answer),
      // The same text, with the fence's own delimiters gone because they became the element
      // above — everything else the model wrote, to the character.
      [
        'Never trust this: <img src=x onerror="alert(1)"> or <script>alert(2)</script>.',
        '',
        '<b class="danger">this is a code sample, not markup</b>',
        '',
        'Angle brackets are ordinary: Array<T> & Map<K, V>.',
      ].join('\n'),
      'every character the model wrote must still be READABLE on the page — escaping is not censoring, and a reply about escaping is exactly the reply a learner most needs to see whole',
    );
  });
});

// ── cancelling: no spinner, and no late answer ─────────────────────────────────────────────

suite('a cancelled ask stops waiting, and its answer never arrives afterwards', () => {
  teardown(teardownTutor);

  /**
   * `detach()` is not a kill and this test does not pretend otherwise — repo-tour's
   * `killLlmChildren()` kills EVERY live child, so cancelling one tutor question while a build
   * ran in the background would kill the build. What cancelling buys is the property asserted
   * at the end: the answer to a question the learner walked away from can never appear in
   * their transcript minutes later. The gate is opened AFTER the cancel precisely so that
   * "minutes later" really happens inside this test.
   */
  test('the spinner goes at once, the panel says the model is still finishing, and the late answer lands nowhere', async () => {
    const answer = gate();
    const { target } = newTutorial();
    const { session, panel } = await openWalk(target);
    await useCore(await coreWith({ runLlm: () => answer.promise }));
    await goTo(session, STEPS.file);
    await showPanel(panel);

    panel.dispatchForTest({ type: 'tutor:ask', payload: { text: 'a question I will walk away from' } });
    await waitFor('the ask to reach the thinking state', () => panel.getStateForTest()?.tutor?.thinking === true);
    await settle();
    assert.deepEqual(
      idsIn(tutorSection(panel)).filter((id) => id === 'btn-tutor-ask' || id === 'btn-tutor-cancel' || id === 'tutor-thinking'),
      ['tutor-thinking', 'btn-tutor-cancel'],
      'while an ask is in flight the page offers Cancel and says so, and Ask is not merely disabled but absent',
    );

    panel.dispatchForTest({ type: 'tutor:cancel' });
    await settle();

    assert.equal(panel.getStateForTest()?.tutor?.thinking, false, 'Cancel is synchronous: the spinner goes NOW, not when the model gets round to it');
    assert.deepEqual(
      idsIn(tutorSection(panel)).filter((id) => id === 'btn-tutor-ask' || id === 'btn-tutor-cancel' || id === 'tutor-thinking'),
      ['btn-tutor-ask'],
      'and the page is back to offering Ask, with no thinking state left on it',
    );
    assert.ok(
      (panel.getStateForTest()?.tutor?.note ?? '').includes('still finishing'),
      'and it says out loud that the request is still running and still costing money — a cancel that quietly kept billing would be the dishonest version of the same mechanism',
    );

    answer.open('an answer to a question nobody is waiting for any more');
    await session.settled();
    await settle();

    assert.deepEqual(
      panel.getStateForTest()?.transcript.map((turn) => turn.content),
      ['a question I will walk away from'],
      'the question stays — they really did ask it — and the answer they walked away from never appears',
    );
    assert.deepEqual(
      getTranscript(loadProgress(target, loadPlan(target)), STEPS.file).map((turn) => turn.role),
      ['user'],
      'nor is it written to progress.json, where it would come back on the next window',
    );
  });
});
