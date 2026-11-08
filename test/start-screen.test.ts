// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-15's acceptance, read off the SCREEN (refine.md AC1–AC6).
 *
 * Every other start-screen test reads the protocol's replies or `webview.html` — and
 * `webview.html` never changes after a press, so a suite built on it cannot tell a press that
 * changed the page from one that did nothing. That is how T-15 survived eleven reviews. These
 * tests press the real button in the real webview and compare what is on screen before and after
 * (`test/support/screen.ts`), in an Extension Development Host under xvfb.
 *
 * What is real: the page and its script, the host's message handling, `runBuild`,
 * `reportOutcome`, the progress notification and its Cancel button. What is not: the build's
 * BODY, which a test holds open, fails or lets be cancelled — the real one either finishes in
 * milliseconds or spends a model call, and tests never spend tokens.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../src/core.js';
import { runBuild, type ExtensionApi } from '../src/extension.js';
import type { BuildContext, BuildOutcome } from '../src/start/build.js';
import { StartPanel, type StartPanelDeps } from '../src/start/panel.js';
import type { BuildRequest } from '../src/start/request.js';
import { SUBMIT_NOTES } from '../src/start/view.js';
import { Screen, nextFrame, sleep, type Frame } from './support/screen.js';

const TITLE = 'Build Tutorials: Start';
const BOOKMARK = 'buildTutorials.currentBuild';

/** What a person could see: the button, the note, the problem lines — and, separately, focus. */
const SNAPSHOT = `(() => {
  const q = (id) => document.getElementById(id);
  const btn = q('build-btn');
  return {
    button: btn.textContent + (btn.disabled ? ' [disabled]' : ''),
    note: q('submit-note').textContent,
    problems: ['idea', 'repo', 'target'].map((f) => q('problem-' + f).textContent),
    fields: [q('repo').value, q('target').value],
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
  };
})()`;
interface Snap { button: string; note: string; problems: string[]; fields: string[]; focus: string }

async function getContext(): Promise<vscode.ExtensionContext> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
  assert.ok(ext);
  return (await ext.activate())._context;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function validRequest(): BuildRequest {
  return { idea: '', recreate: true, repo: tmpDir('screen-repo-'), target: tmpDir('screen-target-'), dial: 'manual' };
}

/** The valid form is on the page: both paths typed in, and no problem line showing. (Problems alone
 *  would be vacuous — an untouched form shows none either.) */
const filled = (s: Snap): boolean => s.fields.every((v) => v !== '') && s.problems.every((p) => p === '');

/** A build body the test controls. `end` settles it; `isCancelled` sees the real Cancel button. */
const held: Array<(o: BuildOutcome) => void> = [];

function heldBuild(): { build: (r: BuildRequest, ctx: BuildContext) => Promise<BuildOutcome>; end: (o: BuildOutcome) => void; started: () => number } {
  let release: ((o: BuildOutcome) => void) | undefined;
  let done = false;
  const ended = new Promise<BuildOutcome>((resolve) => { release = resolve; held.push(resolve); }).finally(() => { done = true; });
  let calls = 0;
  return {
    build: async (_r, ctx) => {
      calls += 1;
      return Promise.race([
        ended,
        (async (): Promise<BuildOutcome> => {
          // Watches the REAL progress notification's Cancel button, until the test ends the build.
          while (!done && !ctx.isCancelled?.()) await sleep(50);
          return { ok: false, cancelled: true, reason: 'build cancelled before reading the repository' };
        })(),
      ]);
    },
    end: (o) => release?.(o),
    // (registered below, so teardown can end a build a failing test never did)
    started: () => calls,
  };
}

suite('the start screen, read off the screen (T-15 AC1–AC6)', function () {
  this.timeout(90_000);
  let screen: Screen;
  let context: vscode.ExtensionContext;
  let core: CoreLoadResult;
  let skins: StartPanelDeps['skins'];
  let panel: StartPanel | undefined;
  let frame: Frame | undefined;
  /** Webview targets of panels this suite has disposed — never to be read as a live page again. */
  const gone = new Set<string>();
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason instanceof Error ? reason.message : String(reason)); };

  suiteSetup(async () => {
    context = await getContext();
    core = await loadCore(resolveCoreRoot('../repo-tour', context.extensionUri.fsPath));
    assert.equal(core.found, true, core.reason ?? 'core');
    skins = core.loaded['skins'] as StartPanelDeps['skins'];
    screen = await Screen.open(context);
    process.on('unhandledRejection', onUnhandled);
  });

  suiteTeardown(() => {
    process.off('unhandledRejection', onUnhandled);
    screen?.close();
  });

  setup(async () => {
    unhandled.length = 0;
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  teardown(async () => {
    // A test that failed before ending its build would leave a live progress and a running flag for
    // the next one (code review finding 6): end them all.
    for (const release of held.splice(0)) release({ ok: false, cancelled: true, reason: 'ended by the test teardown' });
    if (frame?.targetId) gone.add(frame.targetId);
    panel?.dispose();
    panel = undefined;
    StartPanel.buildFinished('cancelled'); // never let one test's build leak "running" into the next
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  async function open(onSubmit: (r: BuildRequest) => void): Promise<{ page: Frame; read: () => Promise<Snap> }> {
    if (panel && frame?.targetId) gone.add(frame.targetId);
    panel = StartPanel.show(context, { skins, onSubmit });
    const page = await screen.webview(TITLE, undefined, gone);
    frame = page;
    return { page, read: screen.reader<Snap>(TITLE, SNAPSHOT, page, gone) };
  }

  const press = (page: Frame): Promise<unknown> => screen.reader(TITLE, `document.getElementById('build-btn').click()`, page, gone)();
  const fill = (page: Frame, r: BuildRequest): Promise<unknown> => screen.reader(TITLE, `((r) => {
    const q = (id) => document.getElementById(id);
    q('idea').value = r.idea; q('recreate').checked = r.recreate; q('repo').value = r.repo; q('target').value = r.target;
    q('start-form').dispatchEvent(new Event('change', { bubbles: true }));
  })(${JSON.stringify(r)})`, page, gone)();

  /**
   * Every notification not yet closed, read from the notification CENTRE (the bell's list). The
   * corner toasts are not a reliable witness: driven 2026-11-05, an error toast sent while the
   * progress toast was up was not drawn in the corner at all — it sits in the centre.
   */
  async function centre(): Promise<string[]> {
    await vscode.commands.executeCommand('notifications.showList');
    await sleep(150);
    const listed = await screen.listedNotifications();
    await vscode.commands.executeCommand('notifications.hideList');
    return listed;
  }

  async function until(read: () => Promise<Snap>, ok: (s: Snap) => boolean, what: string, ms = 10_000): Promise<Snap> {
    const deadline = Date.now() + ms;
    let now = await read();
    while (!ok(now) && Date.now() < deadline) {
      await sleep(50);
      now = await read();
    }
    assert.ok(ok(now), `${what} — the screen showed ${JSON.stringify(now)}`);
    return now;
  }

  test('AC1 + AC2: a refused press changes the screen, and so does every press after it with nothing edited', async () => {
    let builds = 0;
    const { page, read } = await open(() => { builds += 1; });
    const before = await read();

    await press(page);
    const first = await nextFrame(read, before);
    assert.notDeepEqual({ ...first, focus: '' }, { ...before, focus: '' }, 'a refused press left the screen as it was');
    assert.match(first.note, /fix the idea/, 'the note names what to fix');
    assert.equal(first.focus, 'idea', 'focus moves to the first field with a problem');

    await press(page);
    const second = await nextFrame(read, first);
    assert.notEqual(second.note, first.note, 'a second press with nothing edited left the WORDS on screen unchanged');
    assert.match(second.note, /^Still/);

    await press(page);
    const third = await nextFrame(read, second);
    assert.notEqual(third.note, second.note);
    assert.equal(builds, 0, 'a refused press must never start a build');
  });

  test('AC3: a valid press — and a double-click — starts exactly ONE build, and the screen says it is building', async () => {
    let builds = 0;
    const { page, read } = await open(() => { builds += 1; });
    await fill(page, validRequest());
    const ready = await until(read, filled, 'the valid form shows no problems');

    // Two clicks in one instant: the second leaves the page before the first reply disables the button.
    await screen.evaluate(page, `(() => { const b = document.getElementById('build-btn'); b.click(); b.click(); })()`);
    const after = await until(read, (s) => s.note === SUBMIT_NOTES.busy, 'the second click is answered in words');
    assert.notDeepEqual(after, ready);
    assert.equal(after.button, 'Building… [disabled]');
    await sleep(300);
    assert.equal(builds, 1, 'one double-click started more than one build');
  });

  test('AC4: each way a build can END gives the button back and says how — through the real runBuild', async () => {
    // failed
    const failing = heldBuild();
    const { page, read } = await open((r) => { void runBuild(context, core, r, failing.build); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.button === 'Building… [disabled]' && s.note === SUBMIT_NOTES.building, 'an accepted press says it is building');
    failing.end({ ok: false, reason: 'could not clone the reference repo' });
    const failed = await until(read, (s) => s.button === 'Build the plan' && s.note !== SUBMIT_NOTES.building, 'a failed build gives the button back');
    assert.equal(failed.note, SUBMIT_NOTES.failed);
    assert.equal(failed.problems[1], 'could not clone the reference repo', 'and the reason is under Reference repo, as the note says');
    assert.equal(panel!.getStateForTest().building, false, 'the host must forget the build too, or a re-render brings "Building…" back');

    // cancelled — by the progress notification's own Cancel button
    const cancelling = heldBuild();
    panel!.dispose();
    const second = await open((r) => { void runBuild(context, core, r, cancelling.build); });
    assert.equal((await second.read()).button, 'Build the plan', 'a start screen opened after a build ended must be idle');
    await fill(second.page, validRequest());
    await until(second.read, filled, 'valid form');
    await press(second.page);
    await until(second.read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    const deadline = Date.now() + 10_000;
    let pressed = false;
    while (!pressed && Date.now() < deadline) {
      pressed = await screen.pressNotificationButton('Build Tutorials', 'Cancel');
      if (!pressed) await sleep(100);
    }
    assert.ok(pressed, `no Cancel button on the progress notification (saw ${JSON.stringify(await screen.notifications())})`);
    const cancelled = await until(second.read, (s) => s.button === 'Build the plan', 'a cancelled build gives the button back');
    assert.equal(cancelled.note, SUBMIT_NOTES.cancelled);

    // built
    const building = heldBuild();
    panel!.dispose();
    const third = await open((r) => { void runBuild(context, core, r, building.build); });
    await fill(third.page, validRequest());
    await until(third.read, filled, 'valid form');
    await press(third.page);
    await until(third.read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    building.end({ ok: true, plan: { chapters: [], steps: [] }, cost: { metered: false, usd: 0, inputTokens: 0, outputTokens: 0 } });
    const built = await until(third.read, (s) => s.button === 'Build the plan', 'a finished build gives the button back');
    assert.equal(built.note, SUBMIT_NOTES.built);
    assert.deepEqual(unhandled, []);
  });

  test('AC4: a build that THROWS is a failed build — the screen is never left at "Building…"', async () => {
    let run: Promise<void> | undefined;
    const throwing = (): Promise<BuildOutcome> => Promise.reject(new Error('EACCES: the target folder is read-only'));
    const { page, read } = await open((r) => { run = runBuild(context, core, r, throwing); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    const ended = await until(read, (s) => s.button === 'Build the plan' && s.note !== '' && s.note !== SUBMIT_NOTES.building, 'a build that threw gives the button back');
    assert.equal(ended.note, SUBMIT_NOTES.failed);
    assert.equal(ended.problems[1], 'EACCES: the target folder is read-only');
    await run;
    if (frame?.targetId) gone.add(frame.targetId);
    panel!.dispose();
    panel = StartPanel.show(context, { skins, onSubmit: () => undefined });
    const again = await screen.webview(TITLE, undefined, gone);
    frame = again;
    assert.equal((await screen.reader<Snap>(TITLE, SNAPSHOT, again, gone)()).button, 'Build the plan', 'a reopened screen must not be stuck building');
    assert.deepEqual(unhandled, []);
  });

  test('AC5: closing the start tab mid-build never swallows the ending, and a reopened start screen shows it building', async () => {
    const held = heldBuild();
    let run: Promise<void> | undefined;
    const { page, read } = await open((r) => { run = runBuild(context, core, r, held.build); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');

    if (frame?.targetId) gone.add(frame.targetId);
    panel!.dispose(); // the learner closes the tab while the build runs
    panel = StartPanel.show(context, { skins, onSubmit: () => { throw new Error('a reopened screen must not start a second build'); } });
    const reopened = await screen.webview(TITLE, undefined, gone);
    frame = reopened;
    const readAgain = screen.reader<Snap>(TITLE, SNAPSHOT, reopened, gone);
    const mid = await readAgain();
    assert.equal(mid.button, 'Building… [disabled]', 'a start screen opened mid-build offered a live button for a second build');
    assert.equal(mid.note, SUBMIT_NOTES.building);

    held.end({ ok: false, reason: 'the network went away' });
    await run; // rejected with "Webview is disposed" before T-15's completion
    const ended = await until(readAgain, (s) => s.button === 'Build the plan', 'the REOPENED screen hears how the build ended');
    assert.equal(ended.note, SUBMIT_NOTES.failed);
    const deadline = Date.now() + 5_000;
    let shown: string[] = [];
    while (Date.now() < deadline && !shown.some((n) => n.includes('the network went away'))) {
      shown = await centre();
      await sleep(100);
    }
    assert.ok(shown.some((n) => n.includes('the network went away')), `the build's ending never reached the person: ${JSON.stringify(shown)}`);
    assert.deepEqual(unhandled, [], 'the ending threw where nobody was listening');
  });

  test('AC5: a start tab closed mid-build and LEFT closed still hears the ending — the failure, and on success the walk offer (code review 7)', async () => {
    for (const outcome of [
      { ok: false, reason: 'refused while nobody was looking' } as BuildOutcome,
      { ok: true, plan: { chapters: [], steps: [] }, cost: { metered: false, usd: 0, inputTokens: 0, outputTokens: 0 } } as BuildOutcome,
    ]) {
      await vscode.commands.executeCommand('notifications.clearAll');
      const build = heldBuild();
      let run: Promise<void> | undefined;
      const { page, read } = await open((r) => { run = runBuild(context, core, r, build.build); });
      await fill(page, validRequest());
      await until(read, filled, 'valid form');
      await press(page);
      await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');
      if (frame?.targetId) gone.add(frame.targetId);
      panel!.dispose(); // closed, and never reopened
      panel = undefined;

      build.end(outcome);
      const expected = outcome.ok ? 'Plan built — open the folder to start?' : 'refused while nobody was looking';
      const deadline = Date.now() + 5_000;
      let shown: string[] = [];
      while (Date.now() < deadline && !shown.some((n) => n.includes(expected))) {
        shown = await centre();
        await sleep(100);
      }
      assert.ok(shown.some((n) => n.includes(expected)), `with the tab closed, the ending never reached the person: ${JSON.stringify(shown)}`);
      if (!outcome.ok) await run;
      assert.deepEqual(unhandled, [], 'the ending threw where nobody was listening');
    }
  });

  test('a folder picker left open across the END of a build never brings "Building…" back (review: code 2, security 2)', async () => {
    // The native dialog is held open by the test; the real page's Browse… button opens it.
    const original = vscode.window.showOpenDialog;
    let closeDialog: ((v: vscode.Uri[] | undefined) => void) | undefined;
    (vscode.window as { showOpenDialog: typeof original }).showOpenDialog = () =>
      new Promise<vscode.Uri[] | undefined>((resolve) => { closeDialog = resolve; });
    try {
      const build = heldBuild();
      let builds = 0;
      const { page, read } = await open((r) => { builds += 1; void runBuild(context, core, r, build.build); });
      await fill(page, validRequest());
      await until(read, filled, 'valid form');
      await press(page);
      await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');

      await screen.reader(TITLE, `document.getElementById('browse-target').click()`, page, gone)();
      const deadline = Date.now() + 5_000;
      while (!closeDialog && Date.now() < deadline) await sleep(50);
      assert.ok(closeDialog, 'Browse… never opened the (held) folder dialog');

      build.end({ ok: false, reason: 'failed while the picker was open' });
      await until(read, (s) => s.button === 'Build the plan', 'the build ended while the dialog was open');
      closeDialog(undefined); // the person cancels the dialog AFTER the build has ended
      await sleep(300);

      assert.equal(panel!.getStateForTest().building, false, 'a dialog opened before the ending wrote "building" back');
      await press(page); // the form is still valid: this must start a build, not be told one is running
      const next = await until(read, (s) => s.note === SUBMIT_NOTES.building || s.note === SUBMIT_NOTES.busy, 'the next press is answered');
      assert.equal(next.note, SUBMIT_NOTES.building, 'the window still believed a finished build was running');
      assert.equal(builds, 2);
    } finally {
      (vscode.window as { showOpenDialog: typeof original }).showOpenDialog = original;
    }
  });

  test('a tab switch keeps how the build ended — a finished screen never looks unpressed (code review 4)', async () => {
    const build = heldBuild();
    const { page, read } = await open((r) => { void runBuild(context, core, r, build.build); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    build.end({ ok: false, cancelled: true, reason: 'build cancelled before reading the repository' });
    await until(read, (s) => s.note === SUBMIT_NOTES.cancelled, 'cancelled');

    // Another editor in the same column hides the start tab; the page is not kept while hidden.
    await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    await sleep(500);
    StartPanel.show(context, { skins, onSubmit: () => undefined }); // reveal it again: a fresh render
    const back = await until(read, (s) => s.button === 'Build the plan', 'the start tab is back');
    assert.equal(back.note, SUBMIT_NOTES.cancelled, 'the re-render forgot how the build ended');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('AC6 for a SUCCESSFUL build: the progress closes and the bookmark clears with nobody closing a message', async () => {
    const build = heldBuild();
    const request = validRequest();
    const { page, read } = await open((r) => { void runBuild(context, core, r, build.build); });
    await fill(page, request);
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    build.end({ ok: true, plan: { chapters: [], steps: [] }, cost: { metered: false, usd: 0, inputTokens: 0, outputTokens: 0 } });
    await until(read, (s) => s.note === SUBMIT_NOTES.built, 'built');
    const deadline = Date.now() + 3_000;
    while (context.workspaceState.get(BOOKMARK) !== undefined && Date.now() < deadline) await sleep(100);
    assert.equal(context.workspaceState.get(BOOKMARK), undefined, 'the bookmark waited on a toast nobody had closed');
    let left = await centre();
    const until2 = Date.now() + 2_000;
    while (left.some((n) => n.includes('Cancel')) && Date.now() < until2) {
      await sleep(200);
      left = await centre();
    }
    assert.ok(!left.some((n) => n.includes('Cancel')), `a progress notification with Cancel outlived a successful build: ${JSON.stringify(left)}`);
  });

  test('AC6: the progress closes when the build ends — nothing after it waits for a message to be closed', async () => {
    const held = heldBuild();
    let run: Promise<void> | undefined;
    const request = validRequest();
    const { page, read } = await open((r) => { run = runBuild(context, core, r, held.build); });
    await fill(page, request);
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    assert.equal(context.workspaceState.get(BOOKMARK), request.target);

    held.end({ ok: false, reason: 'refused for the test' });
    // Nobody touches the notifications. runBuild must finish on its own.
    const finished = await Promise.race([run!.then(() => true), sleep(5_000).then(() => false)]);
    assert.equal(finished, true, 'runBuild was still waiting — on a toast nobody had closed');
    assert.equal(context.workspaceState.get(BOOKMARK), undefined, 'the bookmark outlived the build');
    // The progress notification is closed with the build — given two seconds to leave, against the
    // indefinite wait (until someone closed the outcome toast) it had before.
    const deadline = Date.now() + 2_000;
    let left = await centre();
    while (left.some((n) => n.includes('Cancel')) && Date.now() < deadline) {
      await sleep(200);
      left = await centre();
    }
    assert.ok(!left.some((n) => n.includes('Cancel')), `a progress notification with Cancel outlived the build: ${JSON.stringify(left)}`);
    assert.ok(left.some((n) => n.includes('refused for the test')), `and the outcome itself was never shown: ${JSON.stringify(left)}`);
  });
});
