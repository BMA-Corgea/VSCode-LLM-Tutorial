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
 *     view — exists at all, which is a claim about `package.json`'s wiring, not about TS.
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
 *   1. **The webview view's rendered HTML is unobservable.** `StepViewProvider` keeps its
 *      `vscode.WebviewView` private (it needs no public accessor to do its job), and VS Code
 *      offers an extension no API to read a view's HTML, to query whether a view is visible,
 *      or to learn that `resolveWebviewView` has fired. So AC5's hide/show drill executes the
 *      REAL reveal and hide commands — `buildTutorials.step.focus` and
 *      `workbench.action.closeSidebar`, so that if the host does resolve the view, the real
 *      teardown-and-re-render path is what runs — and then asserts through
 *      `getStateForTest()`, the panel's own documented seam (handoff T-4 item 7's named
 *      fallback). That seam is exactly the state `render()` paints from, so it is the whole
 *      truth about what comes back on screen; what is NOT proven here is the paint itself.
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
import { statusText, type Progress, type StepLike } from '../src/walk/model.js';
import { CHECK_NOTE } from '../src/walk/step-protocol.js';
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

  test('AC5: hiding the view and showing it again keeps the step and the note on it', async () => {
    const dir = newTarget();
    const { panel } = await openWalk(dir);
    await goTo(STEPS.handle);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    // `step:check` is the one message that leaves a mark on the panel's own state — the
    // honest "not built yet" reply, which is not in `progress.json` and not in the plan, so it
    // can only come back from the host after a hide/show if the host is what re-renders.
    const reply = panel.dispatchForTest({ type: 'step:check' });
    assert.deepEqual(reply, { type: 'step:note', payload: { note: CHECK_NOTE } });
    assert.equal(panel.getStateForTest()?.note, CHECK_NOTE);

    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await settle();
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();

    const state = panel.getStateForTest();
    assert.equal(state?.step.id, STEPS.handle, 'the step must survive the view being torn down');
    assert.equal(state?.note, CHECK_NOTE, 'and so must the reply the learner was reading');
    assert.equal(state?.fileExists, true, 'and the rest of what the page renders from');
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
    assert.equal(state?.note, undefined, 'the note belongs to the step it was produced on, and that step is gone');
  });
});
