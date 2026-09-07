// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-7's acceptance suite — the detour, in a real Extension Development Host, driven through
 * the surfaces `activate()` actually registered.
 *
 * `test/unit/detour-session.test.ts` proves the state machine at full strength against a real
 * disk. What it cannot prove is the three claims that are ABOUT VS CODE, and those are exactly
 * the three this file exists for:
 *
 *   - **AC2** — the files open as REAL EDITOR TABS, and the learner's workspace tree is
 *     unchanged. The tabs are counted off `vscode.window.tabGroups`, which nothing but a real
 *     host has, and the tree is HASHED before and after. A hash rather than a file count
 *     because AC2's promise is not "no new files" but "nothing changed at all": a detour that
 *     rewrote one byte of the learner's `src/parse.ts` would pass every count and fail the only
 *     thing the criterion actually says.
 *   - **AC3** — *Back to my build* closes the detour's tabs and NOBODY ELSE'S, deletes its
 *     directory, leaves the current step where it was, and records the note (AC4).
 *   - **AC5** — a second press on the same step makes ZERO calls to the runner.
 *
 * ## Nothing here may reach a model, and the guard is armed rather than assumed
 *
 * `useTutorCore` puts a stand-in in front of the registered session's next request, exactly as
 * `test/tutor.test.ts` does and for the same reason: `runLlm` spends the learner's money. The
 * default stand-in's `runLlm` is POISONED — it rejects with a sentence that can only ever be a
 * test failure — and a test that wants an answer says what the answer is. `the spend guard is
 * armed` drives the poison through the whole registered session on purpose, which is what
 * makes every other test's canned detour evidence that it went through the seam.
 *
 * The stand-in is built ON TOP of the real core, so `resolveTutorChoice` and the rest are
 * repo-tour's genuine members rather than a second implementation inventing agreement with
 * itself. `availability` is stubbed to a fast yes, because the real claude probe shells out to
 * `claude --version`: free, but slow and dependent on the machine.
 *
 * ## Every test cleans up after itself
 *
 * The walk's surfaces are window-wide singletons made once in `activate()`. A session left
 * running keeps driving them into whichever test runs next, a detour left open holds editor
 * tabs, and a stand-in left installed would answer the NEXT file's requests. `teardownDetour`
 * disposes the session, restores the real core, closes every editor, and removes both the temp
 * directories this file made and anything it left in the extension's global storage.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { LlmReply, TutorCore } from '../src/tutor/core.js';
import { getTranscript } from '../src/tutor/transcript.js';
import { detourDir, detoursRoot, tutorialId, type DetourKey } from '../src/detour/store.js';
import type { WalkSession } from '../src/walk/session.js';
import { loadPlan, loadProgress } from '../src/walk/store.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

/** The step every test here takes its detour from. */
const STEP_ID = 'st-1-shape-src';

/**
 * The key the running session really uses. A detour is keyed by the TUTORIAL as well as the
 * step (T-7 code review findings 1 and 2) — `globalStorageUri` is per-extension and a repo-tour
 * step id carries no repository identity — so a test that named a directory by step id alone
 * would be naming a path this extension no longer writes to.
 */
function detourKey(target: string, stepId: string = STEP_ID): DetourKey {
  return { tutorial: tutorialId(target, loadPlan(target)), stepId };
}

/** What a runner nobody replaced says. If this reaches an assertion, a test forgot to answer
 *  for itself and would otherwise have dialled a real provider. */
const SPEND_GUARD = 'a test in detour.test.ts reached the real model';

/** The canned reply: three files (AC2's own check counts "at least 3 detour tabs") and three
 *  stops (the parser's minimum), in a domain nothing like the fixture's. */
const CANNED = {
  title: 'A vending machine',
  domain: 'vending machines',
  files: [
    { path: 'coins.ts', content: 'export type Coin = 5 | 10 | 25;\nexport const VALUES: Coin[] = [5, 10, 25];\n' },
    { path: 'stock/tray.ts', content: 'export interface Slot { code: string; count: number; }\nexport const EMPTY: Slot[] = [];\n' },
    { path: 'machine.ts', content: 'import { VALUES } from "./coins";\nexport function total(c: number[]) { return c.length + VALUES.length; }\n' },
  ],
  stops: [
    { file: 'coins.ts', startLine: 1, endLine: 1, text: 'The coins are their own module.' },
    { file: 'stock/tray.ts', startLine: 1, endLine: 2, text: 'The tray knows nothing about coins.' },
    { file: 'machine.ts', startLine: 2, endLine: 2, text: 'Only the machine joins them.' },
  ],
};

const CANNED_JSON = JSON.stringify(CANNED);

const REFERENCE_FILES = ['src/parse.ts', 'src/api/routes.ts', 'src/api/render.ts'];

// ── the harness ─────────────────────────────────────────────────────────────────────────────

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return await ext.activate();
}

const tempDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * A tutorial a detour can be taken from: the fixture target, a reference beside it, and the
 * `request.json` that joins the two.
 *
 * The dial is `manual`, which is the walk's own default and the position in which the extension
 * writes nothing — so the learner's files stay exactly as `writeFixtureTarget` left them and
 * the tree hash below is a fact about the fixture rather than about whatever the entry pass did
 * on its way past.
 */
function newTutorial(): string {
  const target = tmpDir('detour-test-target-');
  writeFixtureTarget(target);

  const refRoot = tmpDir('detour-test-reference-');
  for (const rel of REFERENCE_FILES) {
    const to = path.join(refRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(target, rel), to);
  }

  fs.writeFileSync(
    path.join(target, '.repo-tour', 'build', 'request.json'),
    `${JSON.stringify({ idea: '', recreate: true, repo: refRoot, referenceRoot: refRoot, target, dial: 'manual' }, null, 2)}\n`,
  );
  return target;
}

async function openWalk(dir: string) {
  const api = await getApi();
  await api._walk.openAt(dir);
  const session = api._walk.session();
  const panel = api._walk.panel();
  assert.ok(session, 'opening the walk should leave a live session behind');
  assert.ok(panel, 'the step view provider should have been registered in activate()');
  await session.settled();
  return { api, session, panel };
}

async function goTo(session: WalkSession, stepId: string): Promise<void> {
  await vscode.commands.executeCommand('buildTutorials.goToStep', stepId);
  await session.settled();
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Polls until `ok()`, or fails naming what never happened — `test/walk.test.ts`'s helper. A
 *  detour is asynchronous by construction (a request, then tabs, then a webview), so reading
 *  the tabs straight after a dispatch is reading them too early. */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await delay(25);
  }
}

/** The extension's own storage folder — where AC2 says the detour goes, and the workspace does
 *  not. Read off the real `ExtensionContext`, never composed here. */
async function storageRoot(): Promise<string> {
  return (await getApi())._context.globalStorageUri.fsPath;
}

// ── the stand-in core ───────────────────────────────────────────────────────────────────────

async function realCore(): Promise<TutorCore> {
  const api = await getApi();
  const core = await api._walk.tutorCore();
  assert.ok(core, 'repo-tour should load from the configured checkout — without it there is nothing to ask');
  return core;
}

interface Sent { prompt: string }

/** The real core with the two world-touching members replaced, and a COUNTER on the runner:
 *  AC5 is a claim about a NUMBER of calls, so the number has to be observable. */
async function countingCore(text?: string): Promise<{ core: TutorCore; sent: Sent[] }> {
  const sent: Sent[] = [];
  const core: TutorCore = {
    ...(await realCore()),
    availability: () => Promise.resolve({ ok: true, detail: 'a stubbed provider probe' }),
    runLlm: (prompt: string): Promise<LlmReply> => {
      sent.push({ prompt });
      if (text === undefined) return Promise.reject(new Error(SPEND_GUARD));
      return Promise.resolve({ text, inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
    },
  };
  return { core, sent };
}

async function useCore(core: TutorCore): Promise<void> {
  (await getApi())._walk.useTutorCore(core);
}

// ── AC2's measuring instrument ──────────────────────────────────────────────────────────────

/**
 * A hash of every file under `dir` — its relative path AND its bytes.
 *
 * The paths alone would miss a detour that overwrote something; the bytes alone would miss one
 * that added a file. AC2 is "the workspace tree hash is unchanged after a detour", and the only
 * reading of that worth testing is the strict one: not one file added, removed, renamed or
 * altered by so much as a byte.
 *
 * `.repo-tour/` is EXCLUDED, deliberately and with the reason stated out loud: it is the
 * extension's own bookkeeping, `progress.json` is written there by design on every navigation,
 * and AC4 requires this very feature to write the detour note into it. Including it would make
 * the hash move for the one reason the criteria demand, and a test that has to be true and
 * false at once is a test somebody deletes. What AC2 protects is the learner's SOURCE TREE,
 * which is everything else — and `the note is the ONLY thing that changed` below closes the gap
 * by asserting what did move inside that folder.
 */
function treeHash(dir: string): string {
  const entries: string[] = [];
  const walk = (at: string): void => {
    const found = fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of found) {
      if (entry.name === '.repo-tour' || entry.name === '.git') continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${path.relative(dir, full)} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/** Every open TEXT tab, as absolute paths — the arm of `Tab.input` that names exactly one
 *  file. A diff tab has two uris and a webview none, so neither is a file tab. */
function openTabPaths(): string[] {
  const out: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) out.push(tab.input.uri.fsPath);
    }
  }
  return out;
}

/** The webview tabs — the narrator is one, and in this suite it is the only one. */
function webviewTabs(): vscode.Tab[] {
  const out: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview) out.push(tab);
    }
  }
  return out;
}

/** Open tabs that belong to a detour — matched under BOTH spellings of the detours folder, for
 *  the reason `DetourSession.tabPrefixes` gives: the tabs are opened at resolved paths, and on
 *  a platform whose temp root is a symlink the two strings differ. */
function detourTabPaths(storage: string): string[] {
  const root = detoursRoot(storage);
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* nothing has been written yet — the composed spelling is the only one there is */
  }
  return openTabPaths().filter((p) => p.startsWith(root + path.sep) || p.startsWith(real + path.sep));
}

async function teardownDetour(): Promise<void> {
  const api = await getApi();
  api._walk.useTutorCore(undefined);
  api._walk.session()?.dispose();
  api._walk.decorator()?.clear();
  // A reveal already in flight when the session was disposed still finishes and still opens its
  // document; closing the editors before it lands would leave it opening one behind us.
  await delay(400);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  // Whatever a failing test left in the extension's own storage. Never the workspace: nothing
  // in this feature writes there, which is the criterion this whole file exists to prove.
  try {
    fs.rmSync(detoursRoot(await storageRoot()), { recursive: true, force: true });
  } catch {
    /* nothing to clean up */
  }
}

// ── AC2: real tabs, and a workspace nobody touched ──────────────────────────────────────────

suite('AC2 — the example opens as real editor tabs, and the workspace is UNCHANGED', () => {
  teardown(teardownDetour);

  test('files under globalStorage/detours, three tabs, a narrator, and the tree hash unmoved', async () => {
    const target = newTutorial();
    const before = treeHash(target);
    const storage = await storageRoot();

    const { session, panel } = await openWalk(target);
    const { core, sent } = await countingCore(CANNED_JSON);
    await useCore(core);
    await goTo(session, STEP_ID);

    // Through the real panel's real message handler, so what is proved is the wiring that
    // ships rather than a method called directly.
    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the detour to open its tabs', () => detourTabPaths(storage).length >= 3);

    assert.equal(sent.length, 1, 'one press, one request');

    // On disk: under the extension's own storage, at the model's own relative paths.
    const dir = detourDir(storage, detourKey(target));
    for (const file of CANNED.files) {
      const abs = path.join(fs.realpathSync(dir), ...file.path.split('/'));
      assert.ok(fs.existsSync(abs), `${file.path} should be written under globalStorageUri/detours/`);
      assert.equal(fs.readFileSync(abs, 'utf8'), file.content, 'holding exactly what the model sent');
    }

    // In the window: three real editor tabs, one per file.
    const tabs = detourTabPaths(storage);
    assert.ok(tabs.length >= 3, `AC2: at least three detour tabs are open, found ${tabs.length}`);
    for (const file of CANNED.files) {
      const leaf = file.path.split('/').pop();
      assert.ok(tabs.some((p) => p.endsWith(leaf ?? '')), `a tab for ${file.path}`);
    }

    // …and the narrator beside them.
    assert.ok(webviewTabs().length >= 1, 'AC2: a narrator webview tab is open');

    // The criterion itself.
    assert.equal(
      treeHash(target),
      before,
      "AC2: the learner's workspace tree is byte-for-byte what it was — the whole point of writing "
      + 'the example into global storage instead of into their folder',
    );

    // And nothing landed in the workspace under any name: the hash would catch a change, this
    // catches a directory nobody hashed because nobody expected it.
    assert.equal(fs.existsSync(path.join(target, 'detours')), false, 'no detours folder in the workspace');
    assert.equal(fs.existsSync(path.join(target, 'coins.ts')), false, "and none of the example's files either");
  });

  test('the tabs are NOT previews — three files means three tabs, not one that changed thrice', async () => {
    const target = newTutorial();
    const storage = await storageRoot();
    const { session, panel } = await openWalk(target);
    const { core } = await countingCore(CANNED_JSON);
    await useCore(core);
    await goTo(session, STEP_ID);

    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('three tabs', () => detourTabPaths(storage).length >= 3);

    // In preview mode VS Code reuses one italic tab, so a three-file example would end as a
    // single tab showing the third file — which is not a worked example, it is a file.
    const unique = new Set(detourTabPaths(storage));
    assert.equal(unique.size, 3, `three distinct files are open at once, found ${[...unique].join(', ')}`);
  });

  test('the spend guard is armed — a request that answers for nothing FAILS, it does not dial out', async () => {
    const target = newTutorial();
    const { session, panel } = await openWalk(target);
    const { core, sent } = await countingCore(); // poisoned: rejects
    await useCore(core);
    await goTo(session, STEP_ID);

    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();

    assert.equal(sent.length, 1, 'the request really went through the injected runner');
    const note = panel.getStateForTest()?.tutor?.note ?? panel.getStateForTest()?.detour?.note ?? '';
    assert.ok(note.includes(SPEND_GUARD), 'and the guard is what answered — so every other test here went through the seam too');
    assert.equal(panel.getStateForTest()?.detour?.open, undefined, 'and no detour opened on a failure');
  });
});

// ── AC3 and AC4: the way back leaves nothing behind, and records that it happened ────────────

suite('AC3 — Back to my build closes, deletes, restores; AC4 — and writes the note', () => {
  teardown(teardownDetour);

  /** Open a walk, take a detour, and hand back everything the assertions need. */
  async function inADetour() {
    const target = newTutorial();
    const hashBefore = treeHash(target);
    const storage = await storageRoot();
    const { session, panel } = await openWalk(target);
    const { core, sent } = await countingCore(CANNED_JSON);
    await useCore(core);
    await goTo(session, STEP_ID);

    // A file of the LEARNER's own, opened before the detour: AC3 says the return closes the
    // detour's tabs, and "only those" is half of what that sentence promises.
    const own = path.join(target, 'src', 'parse.ts');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(own), { preview: false });

    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the detour to open', () => detourTabPaths(storage).length >= 3);

    return { target, hashBefore, storage, session, panel, sent, own };
  }

  test('the detour\'s tabs close, the narrator goes, the directory is ABSENT, and the step is unmoved', async () => {
    const { target, hashBefore, storage, session, panel, own } = await inADetour();

    const stepBefore = loadProgress(target, loadPlan(target)).current;
    assert.equal(stepBefore, STEP_ID, 'the walk is on the step the detour was taken from');

    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();
    // Both waited for, not only the files: a tab leaves the workbench's own model on its own
    // schedule, so asserting straight after the dispatch would be reading it too early — the
    // same reason every other read in this file polls.
    await waitFor(
      'the detour tabs and the narrator to close',
      () => detourTabPaths(storage).length === 0 && webviewTabs().length === 0,
    );

    assert.equal(detourTabPaths(storage).length, 0, "AC3: the detour's tabs are closed");
    assert.equal(webviewTabs().length, 0, 'AC3: and the narrator with them');
    assert.equal(fs.existsSync(detourDir(storage, detourKey(target))), false, 'AC3: the directory is ABSENT');

    // "only those" — the learner's own tab is untouched, and so is its content.
    assert.ok(openTabPaths().includes(own), "AC3: the learner's own tab is still open — only the detour's were closed");
    assert.ok(fs.existsSync(own), 'and their file is still on disk');

    assert.equal(
      loadProgress(target, loadPlan(target)).current,
      stepBefore,
      'AC3: the active step is unchanged — the learner comes back exactly where they left',
    );
    assert.equal(
      treeHash(target),
      hashBefore,
      'AC2 again, at the other end: the round trip left the workspace tree byte-for-byte as it was',
    );
  });

  test('the transcript records "detour taken: <title>" — in progress.json, as a NOTE (AC4)', async () => {
    const { target, session, panel } = await inADetour();

    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();

    // AC4's own check is `progress.json`, so it is read back off the disk through the same
    // loader a fresh window would use — never off the session's memory.
    const turns = getTranscript(loadProgress(target, loadPlan(target)), STEP_ID);
    assert.equal(turns.length, 1, 'one detour, one record');
    assert.deepEqual(turns[0], {
      role: 'assistant',
      content: `detour taken: ${CANNED.title}`,
      kind: 'note',
    }, 'AC4: the sentence the criterion names, marked as a note rather than as something the tutor said');
  });

  test('the note is the ONLY thing the round trip changed inside .repo-tour, too', async () => {
    const { target, session, panel } = await inADetour();
    const build = path.join(target, '.repo-tour', 'build');
    const before = new Set(fs.readdirSync(build));

    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();

    // The tree hash deliberately excludes `.repo-tour` (see `treeHash`), because AC4 requires
    // `progress.json` to change. This closes that gap from the other side: nothing else in the
    // extension's own folder moved, so the exclusion is not hiding anything.
    assert.deepEqual(new Set(fs.readdirSync(build)), before, 'no new files in the build folder');
    const progress = loadProgress(target, loadPlan(target));
    const withTranscripts = Object.entries(progress.steps ?? {}).filter(([, v]) => (v as { transcript?: unknown[] }).transcript?.length);
    assert.equal(withTranscripts.length, 1, 'exactly one step gained a transcript');
    assert.equal(withTranscripts[0]?.[0], STEP_ID, 'and it is the step the detour was taken from');
  });

  test('closing the narrator by hand is the same gesture as pressing Back to my build', async () => {
    const { storage, session, target } = await inADetour();

    // A narrator closed with the example's files still open would leave the learner five tabs
    // of something with nothing to explain them — a control that stopped working rather than
    // one that was never there.
    const narrator = webviewTabs()[0];
    assert.ok(narrator, 'the narrator is open');
    await vscode.window.tabGroups.close(narrator, true);
    await session.settled();
    await waitFor('the return the closed narrator asked for', () => detourTabPaths(storage).length === 0);

    assert.equal(fs.existsSync(detourDir(storage, detourKey(target))), false, 'and the directory goes with it');
  });
});

// ── AC5: retaking is free ───────────────────────────────────────────────────────────────────

suite('AC5 — a second detour on the same step makes NO model call', () => {
  teardown(teardownDetour);

  test('the retake opens the same example and the runner is never called again', async () => {
    const target = newTutorial();
    const hashBefore = treeHash(target);
    const storage = await storageRoot();
    const { session, panel } = await openWalk(target);
    const { core, sent } = await countingCore(CANNED_JSON);
    await useCore(core);
    await goTo(session, STEP_ID);

    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the first detour', () => detourTabPaths(storage).length >= 3);
    assert.equal(sent.length, 1, 'the first press pays for exactly one answer');

    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();
    await waitFor('the first detour to close', () => detourTabPaths(storage).length === 0);

    // The criterion, measured: not "fewer calls", ZERO.
    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the retake', () => detourTabPaths(storage).length >= 3);

    assert.equal(sent.length, 1, 'AC5: the second run makes NO LLM call — the count did not move');
    assert.equal(
      panel.getStateForTest()?.detour?.open?.title,
      CANNED.title,
      'and the learner gets the same example back rather than an empty panel',
    );
    for (const file of CANNED.files) {
      const abs = path.join(fs.realpathSync(detourDir(storage, detourKey(target))), ...file.path.split('/'));
      assert.equal(fs.readFileSync(abs, 'utf8'), file.content, `${file.path} is rewritten from the cache, byte for byte`);
    }
    assert.equal(treeHash(target), hashBefore, 'and the workspace is still untouched after both round trips');
  });

  test('a DIFFERENT step is a miss and pays for its own answer — the cache is per step', async () => {
    const target = newTutorial();
    const storage = await storageRoot();
    const { session, panel } = await openWalk(target);
    const { core, sent } = await countingCore(CANNED_JSON);
    await useCore(core);

    await goTo(session, STEP_ID);
    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the first detour', () => detourTabPaths(storage).length >= 3);
    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();
    await waitFor('it to close', () => detourTabPaths(storage).length === 0);

    await goTo(session, 'st-2-file-parse');
    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the second step\'s detour', () => detourTabPaths(storage).length >= 3);

    assert.equal(sent.length, 2, 'two steps, two answers — a cache that served across steps would show one');
  });
});

// ── the merge bar, in a real extension host: two tutorials, one global storage ───────────────

/**
 * **T-7 code review findings 1 and 2.** `globalStorageUri` is per-EXTENSION, and repo-tour mints
 * a step id as `sha256(file + ' ' + kind + ' ' + symbolName)` with no repository identity in it
 * — so two tutorials built from two different repositories that share a file path collide **by
 * construction**. Every test above drives ONE tutorial, and a suite that only ever drives one
 * cannot see either finding.
 *
 * This is the same pair of tutorials the reviewer drove, in the real extension host, against the
 * one global storage folder VS Code really hands this extension. Two `newTutorial()` folders
 * carry the same fixture plan, so the step ids are identical — which is exactly the situation
 * the key has to survive rather than a contrivance.
 */
suite('two tutorials in ONE global storage do not serve each other’s examples', () => {
  teardown(teardownDetour);

  test('tutorial B pays for its own example rather than opening tutorial A’s', async () => {
    const storage = await storageRoot();

    // Tutorial A: generate and cache an example.
    const a = newTutorial();
    const walkA = await openWalk(a);
    const first = await countingCore(CANNED_JSON);
    await useCore(first.core);
    await goTo(walkA.session, STEP_ID);
    walkA.panel.dispatchForTest({ type: 'detour:start' });
    await walkA.session.settled();
    await waitFor('tutorial A’s detour', () => detourTabPaths(storage).length >= 3);
    assert.equal(first.sent.length, 1, 'A paid for one answer');
    walkA.panel.dispatchForTest({ type: 'detour:back' });
    await walkA.session.settled();
    await waitFor('A’s detour to close', () => detourTabPaths(storage).length === 0);

    // Tutorial B: a different folder, the same step id, the same extension storage.
    const b = newTutorial();
    assert.notEqual(a, b, 'the two tutorials must be different folders');
    const walkB = await openWalk(b);
    const second = await countingCore(CANNED_JSON);
    await useCore(second.core);
    await goTo(walkB.session, STEP_ID);
    walkB.panel.dispatchForTest({ type: 'detour:start' });
    await walkB.session.settled();
    await waitFor('tutorial B’s detour', () => detourTabPaths(storage).length >= 3);

    assert.equal(
      second.sent.length, 1,
      'tutorial B was served tutorial A’s worked example out of the cache, free and unannounced — '
      + 'the step id was the whole key, and a step id carries no repository in it',
    );
    assert.notEqual(
      detourDir(storage, detourKey(a)), detourDir(storage, detourKey(b)),
      'and the two tutorials would have written into ONE directory, so one’s return deletes the other’s files',
    );

    walkB.panel.dispatchForTest({ type: 'detour:back' });
    await walkB.session.settled();
  });
});

// ── the regenerate control, end to end ───────────────────────────────────────────────────────

/**
 * The spec's refinement notes: *"cached by `stepId` + prompt version so retaking is free; a
 * 'regenerate' button forces a fresh one."* T-7 shipped the cache and not the button, so
 * nothing could force a miss — `DETOUR_PROMPT_VERSION` is a source constant (code review
 * finding 9). Driven here through the real panel's real message handler, so what is proved is
 * the wiring that ships.
 */
suite('Write a new example — the learner can force a fresh one (code review finding 9)', () => {
  teardown(teardownDetour);

  test('it pays for a new answer while the ordinary retake stays free', async () => {
    const target = newTutorial();
    const hashBefore = treeHash(target);
    const storage = await storageRoot();
    const { session, panel } = await openWalk(target);
    const { core, sent } = await countingCore(CANNED_JSON);
    await useCore(core);
    await goTo(session, STEP_ID);

    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the first detour', () => detourTabPaths(storage).length >= 3);
    assert.equal(sent.length, 1, 'the first press pays');

    // AC5 is not weakened by the escape hatch existing: the plain retake is still free.
    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();
    await waitFor('it to close', () => detourTabPaths(storage).length === 0);
    panel.dispatchForTest({ type: 'detour:start' });
    await session.settled();
    await waitFor('the free retake', () => detourTabPaths(storage).length >= 3);
    assert.equal(sent.length, 1, 'AC5: the retake made a model call');

    // …and this one is not free, which is the whole point of it.
    panel.dispatchForTest({ type: 'detour:regenerate' });
    await session.settled();
    await waitFor('the regenerated example', () => detourTabPaths(storage).length >= 3);

    assert.equal(sent.length, 2, 'the regenerate control was served out of the cache');
    assert.equal(panel.getStateForTest()?.detour?.open?.stepId, STEP_ID, 'and the new example is what is open');
    assert.equal(treeHash(target), hashBefore, 'AC2 still holds across a regeneration');

    panel.dispatchForTest({ type: 'detour:back' });
    await session.settled();
  });
});
