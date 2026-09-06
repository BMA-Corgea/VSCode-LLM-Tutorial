// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vscode-test suite for the walk (T-4): the REAL surfaces `activate()` registers — the
 * `TreeDataProvider` VS Code renders in the `buildTutorials` container, the
 * `WebviewViewProvider` beside it, the `StepDecorator` that drives the learner's own editor,
 * and a `WalkSession` reading a plan and a `progress.json` off a real disk. Every test reaches
 * them through `ExtensionApi._walk` (see `src/extension.ts`) rather than constructing its own
 * copies, because a copy would prove something about a copy: only the REGISTERED providers are
 * the ones VS Code actually resolves, re-renders and routes commands to.
 *
 * **What only a real extension host can prove, and is therefore what lives here:**
 *   - that `buildTutorials.goToStep` — the command every tree leaf carries — really runs
 *     through `WalkSession.goTo` and repaints the tree, the panel and the editor together;
 *   - that `openTextDocument` / `showTextDocument` / `revealRange` / `setDecorations` actually
 *     succeed against the fixture's files, including the two cases that reject or refuse
 *     (a `shape` step's target is a DIRECTORY; a step whose file has not been written yet);
 *   - that repo-tour's 1-based inclusive line numbers reach `vscode.Position` converted, and
 *     land on the line the plan named — measured against a calibrated reveal of a known line,
 *     since a `TextEditorDecorationType` is write-only (see `getLastRangeCountForTest`);
 *   - that the walk survives its own teardown: dispose the session, open again on the same
 *     target, and the step comes back from `<target>/.repo-tour/build/progress.json` (AC4);
 *   - that `buildTutorials.step.focus` — the command VS Code auto-generates for a contributed
 *     view — exists at all, which is a claim about `package.json`'s wiring, not about TS;
 *   - that the step panel's REENTRANCY guard is doing something (T-4 code review, finding 5):
 *     only a live session makes `step:next` re-enter `setView` mid-handler, so only a real
 *     host can tell the guard from its absence;
 *   - that a dial change does NOT reassign `webview.html` (finding 1), which is only
 *     observable by reading the real webview's page back before and after;
 *   - that a symlink pointing out of the target folder is not an openable file (security
 *     review, finding 2) — a claim about `fs.realpathSync` on a real disk;
 *   - that a malformed `plan.json` reaches the learner instead of escaping as an unhandled
 *     rejection (finding 2 / security finding 5) — the panel's REAL page is the only place
 *     the wrong answer it used to give was visible.
 *
 * **What is already covered with no extension host at all, under `test/unit/`** (the same
 * division of labour `test/start.test.ts` draws, and for the same reason — those suites run in
 * milliseconds under plain mocha and are where a failure is easiest to read):
 * `walk-model.test.ts` owns `treeModel`'s done/current/pending arithmetic, `nextStepId`/
 * `prevStepId` at the ends, and `statusText`'s exact AC6 wording including the `manual`
 * fallback; `walk-store.test.ts` owns the plan/progress round trip and the atomic write;
 * `walk-step-protocol.test.ts` owns every inbound message's effect and reply. Nothing here
 * re-asserts any of that — it asserts that the real surfaces are wired to it.
 *
 * **Two things this file deliberately asserts one layer in from the pixels, because VS Code
 * exposes no way to assert them at the pixels. Both are stated here rather than hidden:**
 *
 *   1. **VS Code tells an extension nothing about a view's LIFECYCLE.** There is no API to
 *      ask whether a view is visible, or whether `resolveWebviewView` has fired. So AC5's
 *      drill executes the real reveal and hide commands — `buildTutorials.step.focus` and
 *      `workbench.action.closeSidebar` — so that the genuine teardown-and-re-render path is
 *      what runs, and then asserts on both halves of the promise: `getStateForTest()` for the
 *      state the host kept, and the panel's `webview.html` for the page it actually redrew.
 *      The second matters on its own — "kept the right state but never repainted" is
 *      precisely the AC5 failure, and the state seam alone cannot see it. If the host ever
 *      stops resolving the view, that test FAILS loudly rather than passing empty.
 *   2. **`vscode.StatusBarItem.text` is write-only too**, and `_walk` exposes no handle on
 *      `WalkStatusBar`. AC6 therefore asserts the exact string `WalkSession.refresh` hands
 *      `WalkAdapters.setStatus` — `statusText(view.plan, view.progress)`, computed from the
 *      LIVE session's own view — which `src/extension.ts` wires straight into
 *      `WalkStatusBar.setText` and thence into `item.text`, unmodified.
 *
 * `WalkSession` has no unit suite of its own (nothing under `test/unit/` imports it), so this
 * file also carries the state machine's own end-of-plan behaviour: Next and Previous stop
 * rather than wrap.
 *
 * **Every test opens its own fixture target and disposes its session in `teardown`.** The four
 * surfaces are window-wide singletons created once in `activate()`; a session left running
 * would keep driving them into whichever test runs next, and the temp directory it walks would
 * outlive the run.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import { statusText, type PlanLike, type Progress, type StepLike } from '../src/walk/model.js';
import { fixturePlan, writeFixtureTarget } from './unit/walk-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

/** VS Code auto-generates `<viewId>.focus` for every contributed view; `package.json`'s
 *  `views.buildTutorials` entry and `StepViewProvider.viewType` are what make this the id. */
const STEP_VIEW_FOCUS = 'buildTutorials.step.focus';

/** The fixture's four steps, by id (`test/unit/walk-fixtures.ts` documents the whole shape).
 *  Named here so a test reads as what it is doing rather than as a string constant. */
const STEPS = {
  /** `shape`, target `src` — a DIRECTORY, and the step the walk opens on. */
  shape: 'st-1-shape-src',
  /** `file`, target `src/parse.ts`, load-bearing 1-12. */
  file: 'st-2-file-parse',
  /** `symbol`, target `src/api/routes.ts` 6-13, load-bearing 6-13. */
  handle: 'st-3-symbol-handle',
  /** `symbol`, target `src/api/render.ts` 3-10 — the one safe to delete. */
  render: 'st-4-symbol-render',
} as const;

// ── the harness ───────────────────────────────────────────────────────────────────────────

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return await ext.activate();
}

/** Every temp target this file has made, emptied by `teardownWalk`. */
const targets: string[] = [];

/** A fresh folder that looks exactly like one repo-tour has already planned — plan.json, the
 *  files its steps point at, and deliberately NO progress.json (see the fixture's header). */
function newTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-test-target-'));
  writeFixtureTarget(dir);
  targets.push(dir);
  return dir;
}

/** One step of the fixture plan, by id — the same object the walk is reading off disk, so a
 *  test can quote the plan's own line numbers instead of hardcoding a second copy of them. */
function stepOf(id: string): StepLike {
  const step = fixturePlan().steps.find((s) => s.id === id);
  assert.ok(step, `the fixture plan should contain a step "${id}"`);
  return step;
}

/**
 * Opens the walk at `dir` through the real activation path (`_walk.openAt` is
 * `runOpenWalkCommand` minus the workspace-folder lookup, which cannot find a temp directory)
 * and hands back the REGISTERED surfaces it now drives.
 */
async function openWalk(dir: string) {
  const api = await getApi();
  await api._walk.openAt(dir);
  const session = api._walk.session();
  const tree = api._walk.tree();
  const panel = api._walk.panel();
  const decorator = api._walk.decorator();
  assert.ok(session, 'opening the walk should leave a live session behind');
  assert.ok(tree, 'the decision tree provider should have been registered in activate()');
  assert.ok(panel, 'the step view provider should have been registered in activate()');
  assert.ok(decorator, 'the editor decorator should have been created in activate()');
  assert.equal(session.target, dir, 'the session should be walking the folder it was opened at');
  return { api, session, tree, panel, decorator };
}

/** The command every tree leaf carries (`item.command.arguments = [step.id]`), which is also
 *  AC1's "clicking a step makes it current". */
async function goTo(stepId: string): Promise<void> {
  await vscode.commands.executeCommand('buildTutorials.goToStep', stepId);
}

async function teardownWalk(): Promise<void> {
  const api = await getApi();
  api._walk.session()?.dispose();
  api._walk.decorator()?.clear();
  // A reveal already in flight when the session was disposed still finishes and still opens
  // its document; closing the editors before it lands would leave it opening one behind us,
  // into the next test's window.
  await settle();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const dir of targets.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

const POLL_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Long enough for a viewport change to make it back across the extension-host boundary, and
 *  paid only where a value is READ after a reveal rather than waited for. */
function settle(): Promise<void> {
  return delay(300);
}

/**
 * Polls until `ok()`, or fails naming what never happened. Everything the walk does to an
 * editor arrives through a promise `WalkAdapters.revealEditor` has already `void`-ed (see
 * `session.ts`'s header), so a test that reads `activeTextEditor` or the decoration count
 * straight after `goTo` is reading it too early — that is a race, not a fast test.
 */
async function waitFor(what: string | (() => string), ok: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() >= deadline) {
      // `what` may be a thunk: a message built at CALL time would quote the value as it was
      // before the wait, which is the one moment it is guaranteed to be uninteresting.
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${typeof what === 'function' ? what() : what}`);
    }
    await delay(POLL_MS);
  }
}

function activePath(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

function editorFor(file: string): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === file);
}

/** The first line the viewport is showing — the one number that moves, exactly one line at a
 *  time, when a revealed line moves by one. See the conversion probe below. */
function topLine(editor: vscode.TextEditor): number {
  return editor.visibleRanges[0]?.start.line ?? -1;
}

function showsLine(editor: vscode.TextEditor, line0: number): boolean {
  return editor.visibleRanges.some((range) => range.contains(new vscode.Position(line0, 0)));
}

// ── AC1: the native decision tree ─────────────────────────────────────────────────────────

suite('the decision tree is the real registered TreeDataProvider (AC1)', () => {
  teardown(teardownWalk);

  test('AC1: it renders the fixture plan\'s two chapters and their four steps, in plan order', async () => {
    const dir = newTarget();
    const { tree } = await openWalk(dir);

    const chapters = tree.getChildren();
    assert.deepEqual(
      chapters.map((node) => (node.kind === 'chapter' ? node.chapter.key : `not a chapter: ${node.step.id}`)),
      ['src', 'src/api'],
    );
    assert.deepEqual(chapters.map((node) => tree.getTreeItem(node).label), ['src', 'src/api']);

    const steps = chapters.flatMap((chapter) => tree.getChildren(chapter));
    assert.deepEqual(
      steps.map((node) => (node.kind === 'step' ? node.step.id : `not a step: ${node.chapter.key}`)),
      [STEPS.shape, STEPS.file, STEPS.handle, STEPS.render],
    );

    // AC1's second half, as the tree actually offers it: every leaf carries the command, with
    // its own id as the argument. `src/extension.ts` routes that straight into
    // `WalkSession.goTo`, which is what the next test drives.
    assert.deepEqual(tree.getTreeItem(steps[2]!).command, {
      command: 'buildTutorials.goToStep',
      title: 'Go to step',
      arguments: [STEPS.handle],
    });
  });

  test('AC1: done / current / pending reach the items themselves, as the three codicons', async () => {
    const dir = newTarget();
    const { tree, session } = await openWalk(dir);

    // A never-walked target has no progress.json at all, so the walk parks on step 1.
    assert.deepEqual(statusesIn(tree), ['current', 'pending', 'pending', 'pending']);
    assert.deepEqual(iconsIn(tree), ['arrow-right', 'circle-outline', 'circle-outline', 'circle-outline']);

    await goTo(STEPS.handle);
    assert.equal(session.getView()?.step.id, STEPS.handle, 'the command should have moved the session, not just the tree');
    assert.deepEqual(statusesIn(tree), ['pending', 'pending', 'current', 'pending']);

    // `markDone` is T-5's last act after a check passes; it is declared and persisting now, and
    // it is the only way `done` — one of AC1's three icons — can be reached at all in T-4.
    session.markDone(STEPS.file);
    assert.deepEqual(statusesIn(tree), ['pending', 'done', 'current', 'pending']);
    assert.deepEqual(iconsIn(tree), ['circle-outline', 'check', 'arrow-right', 'circle-outline']);
  });

  test('Next and Previous stop at the ends of the plan rather than wrapping', async () => {
    const dir = newTarget();
    const { session } = await openWalk(dir);

    // The walk opens on the first step, so Previous has nowhere to go.
    await vscode.commands.executeCommand('buildTutorials.prevStep');
    assert.equal(session.getView()?.step.id, STEPS.shape);

    for (const expected of [STEPS.file, STEPS.handle, STEPS.render]) {
      await vscode.commands.executeCommand('buildTutorials.nextStep');
      assert.equal(session.getView()?.step.id, expected);
    }
    await vscode.commands.executeCommand('buildTutorials.nextStep');
    assert.equal(session.getView()?.step.id, STEPS.render, 'the end of the plan is the end, not a wrap to step 1');

    await vscode.commands.executeCommand('buildTutorials.prevStep');
    assert.equal(session.getView()?.step.id, STEPS.handle);
  });
});

/** The four steps' statuses, read back out of the live provider in tree order. */
function statusesIn(tree: NonNullable<ReturnType<ExtensionApi['_walk']['tree']>>): string[] {
  return tree.getChildren()
    .flatMap((chapter) => tree.getChildren(chapter))
    .map((node) => (node.kind === 'step' ? node.step.status : `not a step: ${node.chapter.key}`));
}

/** The same row, as the codicon ids VS Code will actually draw. */
function iconsIn(tree: NonNullable<ReturnType<ExtensionApi['_walk']['tree']>>): string[] {
  return tree.getChildren()
    .flatMap((chapter) => tree.getChildren(chapter))
    .map((node) => {
      const icon = tree.getTreeItem(node).iconPath;
      return icon instanceof vscode.ThemeIcon ? icon.id : `not a ThemeIcon: ${JSON.stringify(icon)}`;
    });
}

// ── AC3: the learner's own editor ─────────────────────────────────────────────────────────

suite('the walk drives the real editor (AC3)', () => {
  setup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor('the editor area to be empty', () => vscode.window.activeTextEditor === undefined);
  });

  teardown(teardownWalk);

  test('AC3: a symbol step opens its file, reveals the step\'s line and decorates its load-bearing range', async () => {
    const dir = newTarget();
    const { decorator } = await openWalk(dir);

    // The walk opens on step 1, whose target is a directory: nothing is opened, nothing painted.
    assert.equal(vscode.window.activeTextEditor, undefined, 'a shape step must not open an editor');
    assert.equal(decorator.getLastRangeCountForTest(), 0);

    await goTo(STEPS.handle);

    const file = path.join(dir, 'src', 'api', 'routes.ts');
    await waitFor(
      () => `${file} to become the active editor (active: ${activePath() ?? 'none'})`,
      () => activePath() === file,
    );
    const editor = editorFor(file);
    assert.ok(editor, 'the file the step is about should be visible in the editor area');

    // 1-based inclusive in the plan, 0-based in `vscode.Position` — quoted from the plan the
    // walk is actually reading, so a fixture edit cannot leave this assertion agreeing with a
    // number nobody uses any more. Containment is necessary but NOT sufficient here: this
    // fixture file is 14 lines, so the whole of it is on screen and line 5 and line 6 are
    // both "visible". The conversion itself is pinned by the probe at the end of this suite,
    // which is the test that fails when the `- 1` goes missing.
    const startLine = stepOf(STEPS.handle).target.startLine;
    assert.ok(startLine !== undefined, 'a symbol step carries target.startLine — that is what makes it a symbol step');
    assert.equal(startLine, 6, 'the fixture\'s symbol step should start at line 6');
    assert.ok(showsLine(editor, startLine - 1), `the viewport should be showing the step's line (${startLine} → 0-based ${startLine - 1})`);

    await waitFor(
      () => `the step's one load-bearing range to be decorated (count: ${decorator.getLastRangeCountForTest()})`,
      () => decorator.getLastRangeCountForTest() === 1,
    );
    assert.equal(stepOf(STEPS.handle).scaffold.loadBearing.length, 1, 'and one is what the plan asks for');
  });

  test('AC3: the decorations follow the step — moving to a shape step whose target is a DIRECTORY clears them, and throws nothing', async () => {
    const dir = newTarget();
    const { decorator, panel } = await openWalk(dir);
    const routes = path.join(dir, 'src', 'api', 'routes.ts');

    await goTo(STEPS.handle);
    await waitFor('the symbol step to be decorated', () => decorator.getLastRangeCountForTest() === 1);

    await goTo(STEPS.shape);

    assert.equal(decorator.getLastRangeCountForTest(), 0, 'the previous step\'s highlight must not survive the move');
    assert.equal(panel.getStateForTest()?.fileExists, false, 'a directory is not an openable file, so the panel must not offer to open it');
    assert.ok(editorFor(routes), 'the editor itself stays open — it is the highlight that goes, not the file');

    // The last line of defence, exercised directly: `WalkSession` gates the reveal on
    // `isOpenableFile` (a `statSync().isFile()`, not an `existsSync`, precisely because a
    // directory passes the latter), but `StepDecorator.revealStep` must ALSO survive being
    // handed one — `openTextDocument` rejects on a directory, inside a promise the adapter
    // boundary has already voided, where nobody is listening.
    await decorator.revealStep(dir, stepOf(STEPS.shape));
    assert.equal(decorator.getLastRangeCountForTest(), 0, 'a rejected open leaves nothing decorated');
  });

  test('AC3: a step whose file has not been written yet reveals nothing, decorates nothing, and opens nothing when asked', async () => {
    const dir = newTarget();
    const missing = path.join(dir, 'src', 'api', 'render.ts');
    fs.rmSync(missing);

    const { decorator, panel } = await openWalk(dir);
    await goTo(STEPS.handle);
    await waitFor('the symbol step to be decorated', () => decorator.getLastRangeCountForTest() === 1);

    await goTo(STEPS.render);

    assert.equal(decorator.getLastRangeCountForTest(), 0, 'the previous step\'s highlight goes even though this step could not be revealed');
    assert.equal(panel.getStateForTest()?.fileExists, false);
    assert.equal(panel.getStateForTest()?.step.id, STEPS.render, 'the walk still MOVED — it just has no file to show');

    // The panel's own *Open the file* button, through the real message path: the same
    // `fileExists` snapshot that disables it in the markup also gates the effect behind it.
    panel.dispatchForTest({ type: 'step:open' });
    await settle();
    assert.equal(editorFor(missing), undefined, 'nothing should be opened for a file that does not exist');
  });

  test('AC3: repo-tour\'s 1-based line reaches vscode.Position converted — an off-by-one would land one line lower', async () => {
    const dir = newTarget();
    const { decorator } = await openWalk(dir);

    // A long file, and a line far enough down it that `InCenter` really has to scroll: every
    // line the fixture's own steps point at is within the first screenful, where the viewport
    // is pinned to the top of the document and a one-line error is invisible.
    const file = path.join(dir, 'probe.ts');
    fs.writeFileSync(file, `${Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n')}\n`);
    const start1 = 200;
    const step: StepLike = {
      ...stepOf(STEPS.render),
      target: { file: 'probe.ts', startLine: start1, endLine: start1 + 3 },
      scaffold: { loadBearing: [{ startLine: start1, endLine: start1 + 3 }], boilerplate: [] },
    };

    const doc = await vscode.workspace.openTextDocument(file);
    let editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });

    // Calibration, not arithmetic: ask this very editor, in this window, at whatever size the
    // test host gave it, where the viewport lands when a KNOWN 0-based line is centred. Two
    // reveals one line apart give the two answers a correct conversion and an off-by-one would
    // produce — `assert.notEqual` between them is what makes the measurement discriminating,
    // and it fails loudly rather than silently passing if this window is too tall to tell them
    // apart. (Decorations themselves cannot answer this: `setDecorations` is write-only, so
    // the count seam reports how MANY ranges were painted, never where.)
    //
    // Every measurement starts from the top of the file, so "the scroll has landed" is
    // something to OBSERVE (the first visible line leaving 0) rather than to wait a fixed
    // delay for — the first reveal after a document opens can take longer than any fixed
    // delay is honest about, and reading early is how this probe first lied to its author.
    const parkAtTop = async (): Promise<void> => {
      editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.InCenter);
      await waitFor('the viewport to park at the top of the file', () => topLine(editor) === 0);
      await settle();
    };
    const centreOn = async (line0: number): Promise<number> => {
      await parkAtTop();
      editor.revealRange(new vscode.Range(line0, 0, line0, 0), vscode.TextEditorRevealType.InCenter);
      await waitFor(() => `the viewport to scroll to line ${line0}`, () => topLine(editor) !== 0);
      await settle();
      return topLine(editor);
    };

    /**
     * Every number below is measured until two consecutive takes agree, and that is not
     * ceremony: the FIRST reveal in a freshly opened editor is regularly read while the editor
     * is still laying out, and a viewport whose height has not settled centres a line one row
     * off. Measured once, this probe reported an off-by-one in code that has none — twice in
     * three runs — which is worse than not measuring at all.
     */
    const stable = async (label: string, take: () => Promise<number>): Promise<number> => {
      let previous = await take();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const again = await take();
        if (again === previous) return again;
        previous = again;
      }
      return assert.fail(`${label}: the viewport never gave the same answer twice (last: ${previous})`);
    };

    const converted = await stable(`centring 0-based ${start1 - 1}`, () => centreOn(start1 - 1));
    const offByOne = await stable(`centring 0-based ${start1}`, () => centreOn(start1));
    assert.notEqual(
      converted,
      offByOne,
      `this window cannot tell a one-line error from a correct one (both put the viewport at line ${converted}) — the assertion below would be vacuous`,
    );

    // Park at the top, then let the SHIPPED code do the reveal — measured the same way.
    const actual = await stable('the walk\'s own reveal', async () => {
      await parkAtTop();
      await decorator.revealStep(dir, step);
      editor = editorFor(file) ?? editor;
      await waitFor('the walk to scroll away from the top of the file', () => topLine(editor) !== 0);
      await settle();
      return topLine(editor);
    });

    assert.equal(
      actual,
      converted,
      `the walk should have revealed the plan's line ${start1} as 0-based ${start1 - 1}, which centres this viewport at line ${converted} — line ${offByOne} is where the un-converted ${start1} would land`,
    );
    assert.notEqual(actual, offByOne, `off by one: the plan's ${start1} was used as a 0-based line`);
    assert.ok(showsLine(editor, start1 - 1));
    assert.equal(decorator.getLastRangeCountForTest(), 1, 'and the one load-bearing range was painted');
  });
});

// ── AC4: the reload drill ─────────────────────────────────────────────────────────────────

suite('two navigations in flight at once (code review finding 3)', () => {
  teardown(teardownWalk);

  /**
   * The race: `revealStep` awaits `openTextDocument` and then `showTextDocument`, and the
   * walk fires one per navigation with nothing serialising them. Press Next twice quickly and
   * the second step's document — already open, so it resolves from VS Code's cache — can
   * finish first, letting the FIRST call land afterwards and repaint the older step's
   * highlight over the newer one. Tree, panel and status bar would then all say step 4 while
   * the editor showed step 3's file, scrolled to step 3's line.
   *
   * **This test is a net, not a proof, and that is deliberate.** With the sequence guard the
   * last-STARTED call always wins, whatever order the promises settle in — so this can never
   * fail against correct code. Without it, it fails only on the interleaving where the older
   * call finishes last, which is why the newer step's file is pre-opened here to make that
   * interleaving the likely one. A strictly deterministic version would need a serialising
   * lock in the adapter, and the header of `editor.ts` argues why that trade is worse: it
   * would make the learner wait for a file they have already moved past.
   */
  test('the LAST navigation started is the one on screen, whichever promise settles first', async () => {
    const dir = newTarget();
    const { decorator, session } = await openWalk(dir);
    const plan = session.getView()!.plan;
    const older = plan.steps.find((step) => step.id === STEPS.handle)!;
    const newer = plan.steps.find((step) => step.id === STEPS.render)!;

    // Warm VS Code's document cache for the NEWER step only, so its reveal has every chance
    // to overtake the older one's cold read.
    await vscode.workspace.openTextDocument(path.join(dir, newer.target.file));

    const first = decorator.revealStep(dir, older);
    const second = decorator.revealStep(dir, newer);
    await Promise.all([first, second]);

    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'a reveal should have left an active editor');
    assert.equal(
      active.document.uri.fsPath,
      path.join(dir, newer.target.file),
      'the editor must show the step the learner most recently asked for, not the one they left',
    );
    assert.equal(
      decorator.getLastRangeCountForTest(),
      newer.scaffold.loadBearing.length,
      'and the decorations on screen must be the newer step\'s, not the older call repainting over them',
    );
  });
});

suite('progress survives the session — the reload drill (AC4)', () => {
  teardown(teardownWalk);

  test('AC4: dispose the session, open again on the same target, and the walk comes back where it was', async () => {
    const dir = newTarget();
    const progressFile = path.join(dir, '.repo-tour', 'build', 'progress.json');
    const { session: first, tree, panel } = await openWalk(dir);

    assert.equal(fs.existsSync(progressFile), false, 'merely LOOKING at a tutorial must not write into the learner\'s folder');

    await goTo(STEPS.handle);
    first.markDone(STEPS.file);
    first.setDial(STEPS.handle, 'scaffolded');

    const onDisk = JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Progress;
    assert.equal(onDisk.current, STEPS.handle);
    assert.equal(onDisk.steps[STEPS.file]?.status, 'done');
    assert.equal(onDisk.steps[STEPS.handle]?.dial, 'scaffolded');

    // The teardown half of the drill, asserted rather than assumed: the surfaces really are
    // emptied, so nothing the second session shows below can be a leftover of the first.
    first.dispose();
    assert.deepEqual(tree.getChildren(), [], 'a disposed session leaves an empty tree');
    assert.equal(panel.getStateForTest(), undefined, 'and an empty panel');

    const { session: second } = await openWalk(dir);
    assert.notEqual(second, first, 'the reopen must be a genuinely new session, not the old one revived');

    const view = second.getView();
    assert.ok(view, 'the reopened walk should have a current step');
    assert.equal(view.step.id, STEPS.handle, 'the step came back from progress.json');
    assert.equal(view.progress.steps[STEPS.file]?.status, 'done', 'and so did the per-step status');
    assert.equal(statusText(view.plan, view.progress), 'step 3 / 4 · scaffolded', 'and the dial');

    // …and all the way back out to the surfaces, which is what the learner actually sees.
    assert.deepEqual(statusesIn(tree), ['pending', 'done', 'current', 'pending']);
    assert.equal(panel.getStateForTest()?.step.id, STEPS.handle);
  });

  test('AC4: it is the FILE that decides — editing progress.json between two sessions moves the walk', async () => {
    const dir = newTarget();
    const progressFile = path.join(dir, '.repo-tour', 'build', 'progress.json');
    const { session } = await openWalk(dir);

    await goTo(STEPS.file);
    session.dispose();

    const edited = JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Progress;
    edited.current = STEPS.render;
    fs.writeFileSync(progressFile, `${JSON.stringify(edited, null, 2)}\n`);

    const { session: reopened } = await openWalk(dir);
    assert.equal(
      reopened.getView()?.step.id,
      STEPS.render,
      'the reopened walk must read the file, not remember the step the previous session was on',
    );
  });
});

// ── AC6: the status bar ───────────────────────────────────────────────────────────────────

suite('the status bar line (AC6)', () => {
  teardown(teardownWalk);

  test('AC6: the walk hands the status bar the literal "step N / M · <dial>"', async () => {
    const dir = newTarget();
    const { session } = await openWalk(dir);

    assert.equal(statusOf(session), 'step 1 / 4 · manual');
    await goTo(STEPS.handle);
    assert.equal(statusOf(session), 'step 3 / 4 · manual');
    session.setDial(STEPS.handle, 'scaffolded');
    assert.equal(statusOf(session), 'step 3 / 4 · scaffolded');
  });
});

/**
 * The exact string `WalkSession.refresh` passes to `WalkAdapters.setStatus`, which
 * `src/extension.ts` wires to `WalkStatusBar.setText` and which lands unmodified in
 * `item.text`. Read from the LIVE session's own view, so it is this walk's real position —
 * but computed here rather than read back off the item, because `vscode.StatusBarItem` has no
 * getter a test can call and `_walk` deliberately exposes no handle on the status bar. See
 * this file's header.
 */
function statusOf(session: NonNullable<ReturnType<ExtensionApi['_walk']['session']>>): string {
  const view = session.getView();
  assert.ok(view, 'the walk should have a current step to report');
  return statusText(view.plan, view.progress);
}

// ── the panel's own wiring: the two review findings only a live host can see ───────────────

suite('the step panel drives the session, and repaints only when the page would change', () => {
  teardown(teardownWalk);

  /**
   * The exact failure `src/walk/step-panel.ts`'s identity guard exists to stop, driven the one
   * way that can produce it (T-4 code review, finding 5 — the guard was correct and untested,
   * so deleting it failed nothing).
   *
   * `step:next` is REENTRANT: `handleStepMessage` resolves the id, calls `effects.goTo`, which
   * is `WalkSession.goTo`, which persists and refreshes, which calls `setPanel`, which is
   * `setView` on the panel — all synchronously, before `handleStepMessage` has returned. By
   * then the panel already holds the step moved TO. The handler then returns its INPUT state
   * untouched (navigating is entirely an effect), and adopting that unconditionally would put
   * the step moved FROM back. `step:open` and `step:check` — the only two messages the panel
   * was previously driven with anywhere in this suite — re-enter nothing, so they cannot see
   * this at all.
   *
   * `step:check` runs first on purpose — it is one of the messages that re-enters nothing, so
   * it leaves the panel holding the state the guard is about. T-5 removed the sentence it used
   * to reply (the button drives the real check now), so what is asserted here is the step id
   * alone; the note's own lifetime has no producer to drive it until T-6's tutor arrives.
   */
  test('code review finding 5 — Next pressed IN THE PANEL leaves the panel on the step it moved TO', async () => {
    const dir = newTarget();
    const { panel, session } = await openWalk(dir);
    assert.equal(panel.getStateForTest()?.step.id, STEPS.shape, 'a never-walked target opens on step 1');

    panel.dispatchForTest({ type: 'step:check' });

    panel.dispatchForTest({ type: 'step:next' });

    assert.equal(session.getView()?.step.id, STEPS.file, 'the message really did navigate the session');
    assert.equal(
      panel.getStateForTest()?.step.id,
      STEPS.file,
      'the panel must hold the step it moved TO — without the identity guard it adopts the handler\'s stale return value and lands a step behind the session, which is an AC5 failure produced by an AC2 message',
    );
    panel.dispatchForTest({ type: 'step:prev' });
    assert.equal(panel.getStateForTest()?.step.id, STEPS.shape, 'Previous re-enters exactly the same way, and is guarded by the same check');
  });

  /**
   * Finding 1, at the only place it is visible: the real webview's own page.
   *
   * `renderPage` mints a fresh nonce per call, so re-rendering ALWAYS produces a different
   * string and VS Code's identical-html short-circuit can never save us — every assignment
   * tears the iframe down. `WalkSession.setDial` refreshes every surface so the status bar can
   * show `· scaffolded` (AC6), which pushes the step already on screen back at the panel; the
   * learner who tabbed into the dial and pressed Down would lose the radio holding focus, and
   * a second Down would do nothing.
   *
   * Asserting on `webview.html` IDENTITY is the whole point — `getStateForTest` cannot see a
   * repaint, and "the state was right but the page was rebuilt anyway" is exactly the bug.
   */
  test('code review finding 1 — a dial change does not reassign the page, but a navigation does', async () => {
    const dir = newTarget();
    const { panel } = await openWalk(dir);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();
    assert.ok(panel.webview, `the step view did not resolve in this host, so ${STEP_VIEW_FOCUS} proves nothing about what is on screen`);

    const painted = panel.webview.html;
    assert.match(painted, new RegExp(`data-step-id="${STEPS.shape}"`), 'the page starts on step 1');

    panel.dispatchForTest({ type: 'dial:set', payload: { dial: 'scaffolded' } });

    assert.equal(
      panel.webview?.html,
      painted,
      'the page must not be reassigned for a dial the PAGE already applied itself — a new nonce here means a torn-down iframe, lost keyboard focus and a scroll back to the top',
    );
    assert.equal(
      panel.getStateForTest()?.progress.steps[STEPS.shape]?.dial,
      'scaffolded',
      'the host still took the change: what is skipped is the repaint, never the truth',
    );

    panel.dispatchForTest({ type: 'step:next' });
    const afterNavigation = panel.webview?.html ?? '';
    assert.notEqual(afterNavigation, painted, 'a real change to what the page shows must still repaint');
    assert.match(afterNavigation, new RegExp(`data-step-id="${STEPS.file}"`));

    // Back to the step whose dial was changed while nothing was repainted: this paint is the
    // first one that has to carry it, and it is what proves the skipped repaint lost nothing.
    panel.dispatchForTest({ type: 'step:prev' });
    assert.match(
      panel.webview?.html ?? '',
      /id="dial-scaffolded"[^>]*\bchecked\b/,
      'the next real paint carries the dial the host recorded while it was not painting',
    );
  });
});

// ── code review finding 2 / security finding 5: a plan that cannot be loaded ───────────────

suite('a malformed plan.json is reported, not swallowed', () => {
  teardown(teardownWalk);

  /**
   * The failure this closes was invisible in every direction at once. `loadPlan` throws on a
   * `plan.json` that is not a build plan; the throw escaped `openWalkAt` →
   * `openWalkOnActivate` → the `void` at the `activate()` call site as an unhandled rejection,
   * so the walk silently never opened — no notification, not a line in the output channel —
   * and the step panel, never having been handed a view, fell through to its standing "No
   * tutorial in this folder yet". A folder with a `plan.json` sitting in it was told there was
   * no tutorial in it. A silent failure is bad; a silent failure that produces a confident
   * wrong answer is worse, and the second half is what only the real page can show.
   */
  test('code review finding 2 — the panel names the real reason instead of claiming there is no tutorial', async () => {
    const dir = newTarget();
    fs.writeFileSync(path.join(dir, '.repo-tour', 'build', 'plan.json'), '{"chapters": "not an array"}\n');

    const api = await getApi();
    const panel = api._walk.panel();
    assert.ok(panel, 'the step view provider should have been registered in activate()');
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();
    assert.ok(panel.webview, `the step view did not resolve in this host, so ${STEP_VIEW_FOCUS} proves nothing about what is on screen`);

    // The line that used to reject. `openAt` is the same funnel activation, the command and a
    // finished build all go through, so this is that path and not a copy of it.
    await api._walk.openAt(dir);

    assert.equal(api._walk.session(), undefined, 'a walk that could not be opened must not leave a session behind — least of all the disposed one it replaced');
    assert.equal(panel.getStateForTest(), undefined, 'and no step state');

    const html = panel.webview?.html ?? '';
    assert.match(html, /could not be opened/, 'the panel has to say something happened');
    assert.match(html, /not a build plan/, 'and say what, in the words loadPlan wrote for a person to read');
    assert.doesNotMatch(
      html,
      /No tutorial in this folder yet/,
      'the confidently wrong message is the half of this finding that a notification alone would not have fixed',
    );

    // And it is not sticky: the next walk that opens clears it, so a fixed plan.json is not
    // shadowed by the reason the previous one failed.
    const good = newTarget();
    await api._walk.openAt(good);
    assert.match(panel.webview?.html ?? '', new RegExp(`data-step-id="${STEPS.shape}"`), 'a successful open clears the notice and paints the step');
  });
});

// ── security review finding 2: the fs half of path containment ────────────────────────────

suite('a target.file that leaves the folder is not openable', () => {
  teardown(teardownWalk);

  /**
   * `src/walk/paths.ts`'s `resolveInsideTarget` is pure `path` arithmetic and refuses
   * `../../..`; it cannot see a symlink, and it is deliberately not allowed to (`session.ts`
   * may not import `fs` without breaking the plain-mocha unit bundle — see that file's
   * header). The `fs` half is `isOpenableFile` in `src/extension.ts`, and this is the case
   * that separates the two: a path that is textually inside the target and physically is not.
   *
   * The plan is the untrusted input here, so the test crafts one — which is the only way this
   * is reachable at all, since repo-tour's own inventory walker skips symlinks (see the
   * security review's note on finding 2). It matters now rather than later because T-5 turns
   * this read gate into a WRITE gate at the same paths.
   */
  test('security finding 2 — a symlink inside the target pointing outside it reports fileExists: false', async () => {
    const dir = newTarget();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-test-outside-'));
    targets.push(outside);
    const secret = path.join(outside, 'id_rsa');
    fs.writeFileSync(secret, 'not yours\n');
    const escape = path.join(dir, 'escape.ts');
    fs.symlinkSync(secret, escape);

    const planFile = path.join(dir, '.repo-tour', 'build', 'plan.json');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as PlanLike;
    const crafted = plan.steps.find((step) => step.id === STEPS.render);
    assert.ok(crafted, 'the fixture plan should contain the step this test repoints');
    crafted.target = { file: 'escape.ts' };
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

    const { panel } = await openWalk(dir);

    // First, and loudly: an ORDINARY file in this same target is still openable. Without it
    // the assertion below would also pass if the containment check were simply broken for
    // everything — which is exactly what happens if the TARGET is not itself realpath'd and
    // it is reached through a symlinked parent.
    await goTo(STEPS.handle);
    assert.equal(panel.getStateForTest()?.fileExists, true, 'an ordinary file in the target is still openable — otherwise this test proves nothing');

    await goTo(STEPS.render);
    assert.equal(
      panel.getStateForTest()?.fileExists,
      false,
      'statSync follows the link and says "a file"; only realpath says where that file actually is',
    );

    panel.dispatchForTest({ type: 'step:open' });
    await settle();
    assert.equal(editorFor(escape), undefined, 'and the panel\'s own Open the file must not open it either');
    assert.equal(editorFor(secret), undefined);
  });
});

// ── AC5: hidden and shown again ───────────────────────────────────────────────────────────

suite('the step view survives being hidden (AC5)', () => {
  teardown(teardownWalk);

  test('the contributed view has VS Code\'s auto-generated focus command', async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes(STEP_VIEW_FOCUS),
      `${STEP_VIEW_FOCUS} should exist — VS Code generates it for every contributed view, so its absence means package.json's view id is not what the provider registers`,
    );
    // Revealing the container is what makes VS Code call `resolveWebviewView`; a rejection
    // here would mean the view cannot be shown at all.
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
  });

  test('AC5: hiding the view and showing it again keeps the step this panel was on', async () => {
    const dir = newTarget();
    const { panel } = await openWalk(dir);
    await goTo(STEPS.handle);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    // `step:check` used to be the one message that left a mark on the panel's own state — an
    // honest "not built yet" reply carried in `note`. T-5 replaced it with the real check, so
    // it posts nothing back and the panel keeps no sentence of its own; the note CHANNEL is
    // still there (and still proven, script and all, in
    // `test/unit/walk-step-view.test.ts`'s restore tests) but nothing drives it until T-6's
    // tutor. What this test still proves is the half that needs a live host: the STEP and the
    // rest of what the page renders from survive the view being torn down.
    const reply = panel.dispatchForTest({ type: 'step:check' });
    assert.equal(reply, undefined, 'the real check answers through the session, never as a reply here');

    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await settle();
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    const state = panel.getStateForTest();
    assert.equal(state?.step.id, STEPS.handle, 'the step must survive the view being torn down');
    assert.equal(state?.fileExists, true, 'and the rest of what the page renders from');
    assert.equal(state?.dial, 'manual', 'including the RESOLVED dial the session sent (AC1)');
  });

  test('AC5: the host is the truth — a step change made while the view was hidden is what comes back', async () => {
    const dir = newTarget();
    const { panel, session } = await openWalk(dir);
    await goTo(STEPS.handle);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();
    panel.dispatchForTest({ type: 'step:check' });

    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await settle();
    await goTo(STEPS.file);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    const state = panel.getStateForTest();
    assert.equal(state?.step.id, STEPS.file, 'the panel must come back on the step the SESSION is on');
    assert.equal(state?.step.id, session.getView()?.step.id);
  });

  test('AC5: the page is actually REPAINTED, not merely remembered', async () => {
    const dir = newTarget();
    const { panel } = await openWalk(dir);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    // Loud, not skipped: if the host never resolved the view there is genuinely nothing to
    // say about paint, and a test that quietly passed in that case would be worse than none.
    assert.ok(panel.webview, `the step view did not resolve in this host, so ${STEP_VIEW_FOCUS} proves nothing about what is on screen`);

    await goTo(STEPS.handle);
    await settle();
    assert.match(
      panel.webview.html,
      new RegExp(`data-step-id="${STEPS.handle}"`),
      'the live page should be showing the step the session is on',
    );

    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await settle();
    await goTo(STEPS.file);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    // Re-read rather than reuse: a re-resolve hands the provider a NEW `WebviewView`, and
    // asserting against the old one would be asserting about a corpse.
    const html = panel.webview?.html ?? '';
    assert.match(
      html,
      new RegExp(`data-step-id="${STEPS.file}"`),
      'the page that came back must be REDRAWN on the step the session is on — this is the half getStateForTest cannot see, and "kept the right state but never repainted" is exactly the AC5 failure',
    );
    assert.doesNotMatch(html, new RegExp(`data-step-id="${STEPS.handle}"`), 'and must not still be the page it was showing when it was hidden');
  });
});
