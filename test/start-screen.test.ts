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
 * `reportOutcome`, the progress notification and its Cancel button. What is not, except in the
 * T-30 and T-70 tests that say so: the build's BODY, which a test holds open, fails or lets be
 * cancelled — the real one either finishes in milliseconds or spends a model call, and tests never
 * spend tokens. (T-30's real body ends at the language refusal, before any model; T-70's asks a
 * model of the test's own.)
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../src/core.js';
import { runBuild, type ExtensionApi } from '../src/extension.js';
import { buildFromRequest, markerPath, type BuildContext, type BuildOutcome } from '../src/start/build.js';
import { StartPanel, type StartPanelDeps } from '../src/start/panel.js';
import type { BuildRequest } from '../src/start/request.js';
import { FAILED_AGAIN, SUBMIT_NOTES } from '../src/start/view.js';
import { Screen, nextFrame, sleep, type Frame } from './support/screen.js';
import { STALL_BOUND_MS } from './support/stall-bound.js';

const TITLE = 'Build Tutorials: Start';
/** How many times a test's Cancel is pressed before it gives up on the button coming back (T-152). */
const CANCEL_PRESSES = 6;
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
  /** Puts back what a test slowed (T-30's check), from the teardown too: a test cut off by mocha's timeout
   *  has not reached its own `finally` when the next test starts. */
  let undoSlowCheck: (() => void) | undefined;

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
    undoSlowCheck?.();
    undoSlowCheck = undefined;
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

  /**
   * Presses the real Cancel on the build's progress notification, as a toast or, when VS Code did
   * not draw one, in the notification centre (T-30 review F1: driven, the notification was there
   * with its button and no toast appeared). Returns when the press was made: the moment to measure from.
   */
  async function pressCancel(ms = 10_000): Promise<number> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const attempted = Date.now();
      if (await screen.pressNotificationButton('Build Tutorials', 'Cancel')) return attempted;
      await vscode.commands.executeCommand('notifications.showList');
      await sleep(100);
      const pressed = await screen.pressNotificationButton('Build Tutorials', 'Cancel', 'centre');
      await vscode.commands.executeCommand('notifications.hideList');
      if (pressed) return attempted;
      await sleep(100);
    }
    return assert.fail(`no Cancel button on the progress notification (saw ${JSON.stringify(await screen.notifications())})`);
  }

  /** Waits until the build has said `line` on its progress notification. */
  async function untilSaid(said: ReadonlyArray<{ line: string }>, line: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!said.some((s) => s.line === line) && Date.now() < deadline) await sleep(20);
    assert.ok(said.some((s) => s.line === line), `the build never said "${line}": it said ${JSON.stringify(said.map((s) => s.line))}`);
  }

  /**
   * Presses the real Cancel until the build's button comes back, at most `CANCEL_PRESSES` times (T-152). A press can
   * reach another notification's own Cancel, or be lost as a toast re-renders, and one unchecked press failed AC4
   * ten seconds later, far from the cause (GitHub CI, run 44217317883). T-30's measured Cancel keeps its single press:
   * its bound is the point there.
   */
  async function cancelUntilBack(read: () => Promise<Snap>, what: string): Promise<Snap> {
    for (let pressNo = 1; pressNo <= CANCEL_PRESSES; pressNo++) {
      await pressCancel();
      const deadline = Date.now() + 2_000;
      let now = await read();
      while (now.button !== 'Build the plan' && Date.now() < deadline) {
        await sleep(50);
        now = await read();
      }
      if (now.button === 'Build the plan') return now;
    }
    return until(read, (s) => s.button === 'Build the plan', `${what} (after ${CANCEL_PRESSES} presses)`, 1_000);
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

  test('T-30 AC3 + AC6: the real Cancel during a real read stops it within the bound, and the next press builds again', async () => {
    // T-15's shape: Go only, 20,000 small files, so the real build ends at the language refusal and
    // never reaches a model. The real build body here, unlike the tests below: the read is the point.
    const repo = tmpDir('screen-t30-go-');
    for (let d = 0; d < 200; d++) {
      const dir = path.join(repo, `pkg${d}`);
      fs.mkdirSync(dir);
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `f${i}.go`), `package pkg${d}\n\nfunc F${i}() int { return ${i} }\n`);
    }
    const target = tmpDir('screen-t30-target-');
    const outcomes: BuildOutcome[] = [];
    // What the build says on its progress notification, and when (the same calls that draw it).
    const said: Array<{ line: string; at: number }> = [];
    // T-72: before the read, the build checks the repository's folders (src/start/gitattributes.ts), and
    // a Cancel that lands there stops the check, not the read (the merge check's screen run, 2026-11-11:
    // "build cancelled while checking the repository"). The check is made slow here, so that a Cancel
    // pressed before the read has begun lands in it every time. It runs on this thread, so a slower
    // `fs.promises.readdir` slows it; the read runs on its own thread, with its own `fs`, at its own speed.
    const promises = fs.promises as unknown as { readdir: (...args: unknown[]) => Promise<unknown> };
    const realReaddir = promises.readdir;
    promises.readdir = async (...args: unknown[]): Promise<unknown> => { await sleep(15); return realReaddir.apply(fs.promises, args); };
    undoSlowCheck = () => { promises.readdir = realReaddir; };
    try {
      const request: BuildRequest = { idea: '', recreate: true, repo, target, dial: 'manual' };
      const { page, read } = await open((r) => {
        void runBuild(context, core, r, async (rr, ctx) => {
          const outcome = await buildFromRequest(rr, { ...ctx, onProgress: (line) => { said.push({ line, at: Date.now() }); ctx.onProgress?.(line); } });
          outcomes.push(outcome);
          return outcome;
        });
      });
      await fill(page, request);
      await until(read, filled, 'the valid form shows no problems');
      await press(page);
      const building = await until(read, (s) => s.note === SUBMIT_NOTES.building, 'an accepted press says it is building');

      // The real button, as soon as the read has begun.
      await untilSaid(said, 'reading the repository…', 60_000);
      const pressedAt = await pressCancel();
      const cancelled = await until(read, (s) => s.button === 'Build the plan', 'a cancelled build gives the button back', 60_000);
      const tookMs = Date.now() - pressedAt;
      undoSlowCheck?.();
      console.log(`T-30 AC3 measured: Cancel to the button back ${tookMs} ms`);

      assert.ok(tookMs <= STALL_BOUND_MS, `the Cancel took ${tookMs} ms to land, past the bound of ${STALL_BOUND_MS} ms`);
      assert.notDeepEqual(cancelled, building, 'the press has to change what is on screen');
      assert.equal(cancelled.note, SUBMIT_NOTES.cancelled);
      assert.equal(outcomes[0]?.reason, 'build cancelled while reading the repository');
      // The fixture's own condition: the check outlasted a press, so a Cancel pressed early lands in it.
      const checking = said.find((s) => s.line === 'checking the repository…')?.at ?? Number.NaN;
      const reading = said.find((s) => s.line === 'reading the repository…')?.at ?? Number.NaN;
      assert.ok(reading - checking >= 2_000, `the check took ${reading - checking} ms: too short to stand for a large repository's`);
      const listed = await centre();
      assert.ok(listed.some((n) => n.includes('build cancelled while reading the repository')), 'the notification says it was cancelled, and when');
      assert.deepEqual(listed.filter((n) => n.includes('Cancel')), [], 'the progress notification and its Cancel button should be gone');
      assert.equal(fs.existsSync(path.join(repo, '.repo-tour')), false, 'a cancelled read left a digest cache in the reference folder');
      assert.equal(fs.existsSync(markerPath(target)), false);
      assert.deepEqual(fs.readdirSync(target), [], 'a cancelled build has to leave the folder it was given empty, or the next press is refused');

      // AC6: the repeat. Nothing edited, the same form, and a build that runs to its normal ending.
      await press(page);
      await until(read, (s) => s.note === SUBMIT_NOTES.building, 'the second press was accepted: a cancelled build must not block the next');
      const ended = await until(read, (s) => s.button === 'Build the plan' && s.note !== SUBMIT_NOTES.building, 'the repeat ran to its ending', 60_000);
      assert.equal(ended.note, SUBMIT_NOTES.failed);
      assert.match(ended.problems[1] ?? '', /is go; the grammars repo-tour ships cover/);
      assert.notDeepEqual(ended, cancelled, 'the two endings have to look different');
      assert.equal(outcomes.length, 2);
      assert.equal(outcomes[1]?.cancelled, undefined);
    } finally {
      undoSlowCheck?.();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  // ── T-141: what a stranger's first run says ───────────────────────────────────────────────────────

  test('T-141: an idea typed without recreate is answered in the form\'s own words, naming the box by its label on the form, and no ticket number is on the page', async () => {
    let builds = 0;
    const { page, read } = await open(() => { builds += 1; });
    await fill(page, { idea: 'a chat app', recreate: false, repo: '', target: tmpDir('screen-t141-target-'), dial: 'manual' });
    await press(page);
    const after = await until(read, (s) => s.problems[0] !== '', 'the press answers under the idea field');
    // The label as the form draws it (review F10): a label changed on the form alone fails here.
    const label = await screen.reader<string>(TITLE, "(document.getElementById('recreate').parentElement.textContent || '').trim()", page, gone)();
    assert.ok(label.length > 5, 'the fixture has to read the box\'s label off the form');
    assert.ok((after.problems[0] ?? '').includes('tick "' + label + '"'), 'the line under the idea does not name the box to tick by its label (' + label + '): ' + (after.problems[0] ?? ''));
    const text = await screen.reader<string>(TITLE, 'document.body.innerText', page, gone)();
    assert.doesNotMatch(text, /\bT-\d+\b/, 'the Start form shows a ticket number: ' + (/\bT-\d+\b/.exec(text)?.[0] ?? ''));
    assert.equal(builds, 0);
  });

  test('T-141: a build that ends while git lacks a name or an email says so before the walk; with an identity, with commits off, with no git, with one only some folders get, or with a git that hangs, it does not, and the walk is offered within seconds', async () => {
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, path: process.env.PATH };
    const settings = vscode.workspace.getConfiguration('buildTutorials');
    const setBefore = settings.inspect<boolean>('commitPerStep')?.globalValue;
    const dir = tmpDir('screen-t141-gitconfig-');
    const withIdentity = path.join(dir, 'with-identity');
    fs.writeFileSync(withIdentity, '[user]\n\tname = A Learner\n\temail = learner@example.com\n');
    // An identity git gives only to repositories under one folder (review F3).
    fs.writeFileSync(path.join(dir, 'work'), '[user]\n\tname = At Work\n\temail = work@example.com\n');
    const someFolders = path.join(dir, 'some-folders');
    fs.writeFileSync(someFolders, '[includeIf "gitdir:' + path.join(dir, 'work-repos') + '/"]\n\tpath = ' + path.join(dir, 'work') + '\n');
    // No git on the PATH at all (review F1), and a git that never answers (review F2).
    const noGit = tmpDir('screen-t141-no-git-');
    const hangs = tmpDir('screen-t141-hanging-git-');
    fs.writeFileSync(path.join(hangs, 'git'), '#!/bin/sh\nexec /usr/bin/sleep 120\n', { mode: 0o755 });
    const built: BuildOutcome = { ok: true, plan: { chapters: [], steps: [] }, cost: { metered: false, usd: 0, inputTokens: 0, outputTokens: 0 } };
    const { page, read } = await open((r) => { void runBuild(context, core, r, () => Promise.resolve(built)); });
    interface Round { gitConfig: string; commitPerStep: boolean; pathOnly?: string; sees: 'nothing' | 'the identity' | 'no git' | 'a hang' }
    /** One build to its ending: the notifications once the walk is offered (which comes after the ask), and how soon. */
    const endingOf = async (round: Round): Promise<{ listed: string[]; offeredMs: number }> => {
      process.env.GIT_CONFIG_GLOBAL = round.gitConfig; // so git reads neither ~/.gitconfig nor its XDG file
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await settings.update('commitPerStep', round.commitPerStep, vscode.ConfigurationTarget.Global);
      const request = validRequest();
      // The fixture's own condition, in this round's own folder, both keys (review F11).
      const env = { ...process.env, PATH: round.pathOnly ?? process.env.PATH };
      if (round.sees === 'nothing' || round.sees === 'the identity') {
        const ask = (key: string): string => spawnSync('git', ['config', key], { cwd: request.target, encoding: 'utf8', env }).stdout.trim();
        assert.deepEqual([ask('user.name'), ask('user.email')], round.sees === 'the identity' ? ['A Learner', 'learner@example.com'] : ['', ''],
          'the fixture has to give git exactly this identity, or none');
      } else if (round.sees === 'no git') {
        assert.equal(spawnSync('git', ['--version'], { env }).error?.message.includes('ENOENT'), true, 'the fixture has to leave no git on the PATH');
      }
      // Nothing of the round before may be read as this one's: the centre is empty before the press.
      await vscode.commands.executeCommand('notifications.clearAll');
      const emptyBy = Date.now() + 5_000;
      let leftOver = await centre();
      while (leftOver.length > 0 && Date.now() < emptyBy) {
        await vscode.commands.executeCommand('notifications.clearAll');
        await sleep(200);
        leftOver = await centre();
      }
      assert.deepEqual(leftOver, [], 'the notifications of the round before were still there');
      await fill(page, request);
      await until(read, filled, 'the valid form shows no problems');
      if (round.pathOnly !== undefined) process.env.PATH = round.pathOnly;
      try {
        const pressedAt = Date.now();
        await press(page);
        const deadline = Date.now() + 40_000;
        let listed = await centre();
        while (!listed.some((n) => n.includes('open the folder to start')) && Date.now() < deadline) {
          await sleep(200);
          listed = await centre();
        }
        const offeredMs = Date.now() - pressedAt;
        assert.ok(listed.some((n) => n.includes('open the folder to start')), 'the walk was never offered: ' + JSON.stringify(listed));
        return { listed, offeredMs };
      } finally {
        process.env.PATH = saved.path;
      }
    };
    const told = (listed: string[]): string | undefined => listed.find((n) => n.includes('git needs your name and email'));
    try {
      const first = await endingOf({ gitConfig: '/dev/null', commitPerStep: true, sees: 'nothing' });
      const line = told(first.listed);
      assert.ok(line !== undefined, 'a build that ended with no git identity did not say so before the walk: ' + JSON.stringify(first.listed));
      assert.match(line, /git config --global user\.name "Your Name"/);
      assert.match(line, /git config --global user\.email "you@example\.com"/);
      for (const [round, why] of [
        [{ gitConfig: withIdentity, commitPerStep: true, sees: 'the identity' }, 'with a git identity set'],
        [{ gitConfig: '/dev/null', commitPerStep: false, sees: 'nothing' }, 'with per-step commits turned off'],
        [{ gitConfig: '/dev/null', commitPerStep: true, pathOnly: noGit, sees: 'no git' }, 'with no git to ask at all'],
        [{ gitConfig: someFolders, commitPerStep: true, sees: 'nothing' }, 'with an identity git gives only to some folders (includeIf)'],
        [{ gitConfig: '/dev/null', commitPerStep: true, pathOnly: hangs, sees: 'a hang' }, 'with a git that never answers'],
      ] as Array<[Round, string]>) {
        const ended = await endingOf(round);
        assert.equal(told(ended.listed), undefined, 'it said so ' + why + ': ' + JSON.stringify(ended.listed));
        assert.ok(ended.offeredMs < 10_000, 'the walk was offered only after ' + ended.offeredMs + ' ms ' + why);
      }
    } finally {
      process.env.PATH = saved.path;
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
      await settings.update('commitPerStep', setBefore, vscode.ConfigurationTarget.Global); // its own value back (review F11)
    }
  });

  test('T-70: the real Cancel while the build asks about each decision ends the call in flight, starts no other, and says so', async () => {
    // The owner's check, end to end (T-70 review F2, from the reviewer's own drive). Real: the press,
    // runBuild, the core src/extension.ts builds (offThreadCore over coreFor, the shipped polls), the
    // worker's read and plan, repo-tour's own interpretPlan, and the progress notification's Cancel. The
    // test's own: the provider repo-tour's llm module hands out, which holds every call until its signal
    // fires, and where answers are kept. And no model CLI can be found while it runs.
    const saved = { claude: process.env.REPO_TOUR_CLAUDE_BIN, codex: process.env.REPO_TOUR_CODEX_BIN };
    const nowhere = tmpDir('screen-t70-no-cli-');
    process.env.REPO_TOUR_CLAUDE_BIN = path.join(nowhere, 'no-such-claude');
    process.env.REPO_TOUR_CODEX_BIN = path.join(nowhere, 'no-such-codex');
    // Four TS files, so four model calls are due. Salted, so no answer cached anywhere can stand in for one.
    const repo = tmpDir('screen-t70-repo-');
    const salt = `${Date.now()}${Math.random()}`.replace('.', '');
    fs.mkdirSync(path.join(repo, 'src'));
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
      fs.writeFileSync(path.join(repo, 'src', `${name}.ts`), `export function ${name}(a: number): number {\n  return a + ${JSON.stringify(salt)}.length;\n}\n`);
    }
    const target = tmpDir('screen-t70-target-');
    const cache = tmpDir('screen-t70-cache-');
    const calls: Array<{ at: number; file: string; endedAt?: number; end: () => void }> = [];
    let ending = false;
    const provider = {
      run: (prompt: string, opts: { signal?: AbortSignal }): Promise<unknown> => new Promise((_resolve, reject) => {
        if (ending) { reject(new Error('the test has ended')); return; }
        const call: (typeof calls)[number] = { at: Date.now(), file: /File: (\S+)/.exec(prompt)?.[1] ?? '?', end: () => reject(new Error('the test has ended')) };
        calls.push(call);
        const cap = setTimeout(() => reject(new Error('never ended: its signal did not fire')), 20_000);
        opts.signal?.addEventListener('abort', () => { call.endedAt = Date.now(); clearTimeout(cap); reject(new Error('aborted by its signal')); }, { once: true });
      }),
    };
    const asked: string[] = [];
    const llm = { ...(core.loaded['llm'] as object), providerById: (id: string) => { asked.push(id); return provider; } };
    const interpret = { ...(core.loaded['interpret'] as object), defaultCacheDir: () => cache };
    const withTestModel: CoreLoadResult = { ...core, loaded: { ...core.loaded, llm, interpret } };
    const outcomes: BuildOutcome[] = [];
    let run: Promise<void> | undefined;
    try {
      const { page, read } = await open((r) => {
        run = runBuild(context, withTestModel, r, async (rr, ctx) => {
          const outcome = await buildFromRequest(rr, ctx);
          outcomes.push(outcome);
          return outcome;
        });
      });
      await fill(page, { idea: '', recreate: true, repo, target, dial: 'manual' });
      await until(read, filled, 'the valid form shows no problems');
      const pressedBuildAt = Date.now();
      await press(page);
      await until(read, (s) => s.note === SUBMIT_NOTES.building, 'an accepted press says it is building');

      // The read and the plan of four small files take a moment, and then the first call is in flight.
      const deadline = Date.now() + 30_000;
      while (calls.length === 0 && outcomes.length === 0 && Date.now() < deadline) await sleep(25);
      assert.ok(calls.length > 0, `the build never reached its first model call: ${JSON.stringify(outcomes.map((o) => ({ ok: o.ok, reason: o.reason, failures: o.cost?.['failures'] })))}`);
      await sleep(300); // a real call would be seconds into its answer
      const pressedAt = await pressCancel();
      const endBy = Date.now() + 5_000;
      while (calls[0]!.endedAt === undefined && Date.now() < endBy) await sleep(25);
      assert.notEqual(calls[0]!.endedAt, undefined, 'the call in flight at Cancel was never ended');
      const msCancelToCallEnded = calls[0]!.endedAt! - pressedAt;
      const back = await until(read, (s) => s.button === 'Build the plan', 'a cancelled build gives the button back', 20_000);
      const msCancelToButtonBack = Date.now() - pressedAt;
      await run;
      const listed = await centre();
      console.log(`T-70 measured: ${JSON.stringify({
        load: os.loadavg().map((n) => n.toFixed(2)).join(' '), msPressToFirstCall: calls[0]!.at - pressedBuildAt,
        msCancelToCallEnded, msCancelToButtonBack, calls: calls.map((c) => c.file), providersAsked: asked,
      })}`);

      assert.ok(msCancelToCallEnded <= STALL_BOUND_MS, `the call in flight outlived Cancel by ${msCancelToCallEnded} ms, past the bound of ${STALL_BOUND_MS} ms`);
      assert.equal(calls.length, 1, `${calls.length} calls reached the model; only the one in flight at Cancel may`);
      assert.equal(back.note, SUBMIT_NOTES.cancelled);
      assert.equal(outcomes[0]?.reason, 'build cancelled while asking about each decision');
      assert.ok(listed.some((n) => n.includes('build cancelled while asking about each decision')), `the notification says where it stopped: ${JSON.stringify(listed)}`);
      assert.deepEqual(listed.filter((n) => n.includes('Cancel')), [], 'the progress notification and its Cancel button should be gone');
      assert.equal(fs.existsSync(markerPath(target)), false, 'a cancel leaves nothing to resume');
      assert.deepEqual(fs.readdirSync(target), [], 'a cancelled build has to leave the folder it was given empty, or the next press is refused');
      assert.deepEqual(fs.readdirSync(cache), [], 'a cancelled build wrote an answer');
    } finally {
      // A failed test must not leave its build asking a held model into the next test: end every call, now and to come.
      ending = true;
      for (const call of calls) call.end();
      const settleBy = Date.now() + 10_000;
      while (run !== undefined && outcomes.length === 0 && Date.now() < settleBy) await sleep(50);
      if (saved.claude === undefined) delete process.env.REPO_TOUR_CLAUDE_BIN;
      else process.env.REPO_TOUR_CLAUDE_BIN = saved.claude;
      if (saved.codex === undefined) delete process.env.REPO_TOUR_CODEX_BIN;
      else process.env.REPO_TOUR_CODEX_BIN = saved.codex;
    }
  });

  test('T-152: a Cancel pressed the AC4 way reaches the build\'s own progress while other Build Tutorials notifications are up, and the button comes back', async () => {
    /** Two notifications of this extension an earlier ending left up: one with no button, one with a Cancel of its own. */
    const leaveStale = (when: string): void => {
      void vscode.window.showErrorMessage(`Build Tutorials: an earlier build failed (left up on purpose, ${when})`);
      void vscode.window.showInformationMessage(`Build Tutorials: an earlier question (left up on purpose, ${when})`, 'Cancel');
    };
    const cancelling = heldBuild();
    const { page, read } = await open((r) => { void runBuild(context, core, r, cancelling.build); });
    leaveStale('before the build');
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    // The build's own progress is listed before the next two, so whichever order the list keeps, a stale one is first.
    const listedBy = Date.now() + 10_000;
    let listed = await centre();
    while (!listed.some((n) => n.includes('Build Tutorials') && n.includes('Cancel') && !n.includes('left up on purpose')) && Date.now() < listedBy) {
      await sleep(100);
      listed = await centre();
    }
    leaveStale('after the build');
    const cancelled = await cancelUntilBack(read, 'a cancelled build gives the button back with stale notifications of this extension up');
    assert.equal(cancelled.note, SUBMIT_NOTES.cancelled);
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
    // The failed sub-case's error toast is still up here: pressed until the button returns (T-152).
    const cancelled = await cancelUntilBack(second.read, 'a cancelled build gives the button back');
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

  test('T-72: a reference whose .gitattributes is a link to /dev/zero is refused at once, on screen, and its digest never runs', async () => {
    const repo = tmpDir('screen-t72-repo-');
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
    fs.symlinkSync('/dev/zero', path.join(repo, '.gitattributes'));
    const request: BuildRequest = { idea: '', recreate: true, repo, target: tmpDir('screen-t72-target-'), dial: 'manual' };
    const { page, read } = await open((r) => {
      // SAFETY: if the pre-flight ever missed it, this digest fails the test instead of reading the link
      // (read for real, it allocates until the extension host dies).
      void runBuild(context, core, r, (rr, ctx) =>
        buildFromRequest(rr, { ...ctx, core: { ...ctx.core, digest: () => Promise.reject(new Error('T-72: the digest ran')) } }));
    });
    await fill(page, request);
    await until(read, filled, 'valid form');
    await press(page);
    const refused = await until(read, (s) => s.note === SUBMIT_NOTES.failed, 'the build is refused');
    assert.match(refused.problems[1] ?? '', /^\.gitattributes is a link, which repo-tour would follow: remove it/,
      'the reason under Reference repo does not say what is wrong and what to do');
  });

  test('T-72: a name the reference repository chose never becomes a link in the refusal notification', async () => {
    // T-72 security review, finding 1, re-driven here. The folder of a nested repository is named as a
    // VS Code link to a command. Before the fix, the refusal quoted that name, the notification drew it
    // as a link, and one click on it ran the command with the arguments the repository chose.
    const ran: unknown[][] = [];
    const probe = vscode.commands.registerCommand('t72.screen.probe', (...args: unknown[]) => { ran.push(args); });
    try {
      const repo = tmpDir('screen-t72-name-');
      fs.mkdirSync(path.join(repo, '.git'));
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
      const name = '[Remove the link for me](command:t72.screen.probe?%5B%22chosen-by-the-repository%22%5D)';
      const nested = path.join(repo, name);
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../.git/modules/x\n');
      fs.symlinkSync('/dev/zero', path.join(nested, '.gitattributes'));
      const request: BuildRequest = { idea: '', recreate: true, repo, target: tmpDir('screen-t72-name-target-'), dial: 'manual' };
      const { page, read } = await open((r) => {
        // SAFETY: as above, a digest that fails the test instead of reading the link.
        void runBuild(context, core, r, (rr, ctx) =>
          buildFromRequest(rr, { ...ctx, core: { ...ctx.core, digest: () => Promise.reject(new Error('T-72: the digest ran')) } }));
      });
      await fill(page, request);
      await until(read, filled, 'valid form');
      await press(page);
      const refused = await until(read, (s) => s.note === SUBMIT_NOTES.failed, 'the build is refused');
      assert.equal(refused.problems[1],
        `${name}/.gitattributes is a link, which repo-tour would follow: remove it from the reference repository, or build from a copy without it`,
        'the line under Reference repo names the file as it is: the page sets it as text, so it needs nothing');

      await vscode.commands.executeCommand('notifications.showList');
      await sleep(300);
      const bench = await screen.workbench();
      const listed = await screen.listedNotifications();
      const anchors = await screen.evaluate<Array<{ text: string | null; href: string | null }>>(bench,
        `Array.from(document.querySelectorAll('.notifications-center .notification-list-item a')).map((a) => ({ text: a.textContent, href: a.getAttribute('href') }))`);
      // What the learner would do: click the words that ask to be clicked, if they are a link.
      await screen.evaluate<number>(bench, `(() => {
        const links = Array.from(document.querySelectorAll('.notifications-center .notification-list-item a'))
          .filter((a) => (a.getAttribute('href') || '').startsWith('command:t72.screen.probe'));
        for (const a of links) a.click();
        return links.length;
      })()`);
      await sleep(500);
      await vscode.commands.executeCommand('notifications.hideList');
      const commandLinks = anchors.filter((a) => (a.href ?? '').startsWith('command:'));
      console.log(`T-72 refusal notification: ${commandLinks.length} command link(s) drawn, ${JSON.stringify(commandLinks)}; the probe ran ${ran.length} time(s), ${JSON.stringify(ran)}`);
      assert.ok(listed.some((n) => n.includes('Remove the link for me') && n.includes('.gitattributes is a link')),
        `the refusal notification is not in the notification centre: ${JSON.stringify(listed)}`);
      assert.deepEqual(commandLinks, [], 'the refusal notification drew a command link that the repository chose');
      assert.deepEqual(ran, [], 'one click on the refusal ran a command the repository named, with its arguments');
    } finally {
      probe.dispose();
    }
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
      // One HELD build per press (T-80). The second press used to run the first build's body again,
      // whose ending had already settled, so the second build ended the moment it began: the page's
      // own record showed "Building…" for 1 to 44 ms (driven 2026-11-10), while the polls, 50 ms
      // apart on paper, came 51 to 113 ms apart under load. It was caught only by luck, failing 4 runs
      // in 6 at load 13-18 on both VS Code 1.145.0 and 1.145.2. Held, it stays until this test ends it.
      const first = heldBuild();
      const second = heldBuild();
      let builds = 0;
      const { page, read } = await open((r) => { builds += 1; void runBuild(context, core, r, (builds === 1 ? first : second).build); });
      await fill(page, validRequest());
      await until(read, filled, 'valid form');
      await press(page);
      await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');

      await screen.reader(TITLE, `document.getElementById('browse-target').click()`, page, gone)();
      const deadline = Date.now() + 5_000;
      while (!closeDialog && Date.now() < deadline) await sleep(50);
      assert.ok(closeDialog, 'Browse… never opened the (held) folder dialog');

      first.end({ ok: false, reason: 'failed while the picker was open' });
      await until(read, (s) => s.button === 'Build the plan', 'the build ended while the dialog was open');
      closeDialog(undefined); // the person cancels the dialog AFTER the build has ended
      await sleep(300);

      assert.equal(panel!.getStateForTest().building, false, 'a dialog opened before the ending wrote "building" back');
      const ended = await read();
      assert.deepEqual({ button: ended.button, note: ended.note, reason: ended.problems[1] },
        { button: 'Build the plan', note: SUBMIT_NOTES.failed, reason: 'failed while the picker was open' }, 'the screen after the dialog closed');
      // And the host still knows how the build ended (T-80 review F1): a tab switch re-renders the page
      // from the host's state, which the cancelled dialog's snapshot from before the ending used to replace.
      await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
      await sleep(500);
      StartPanel.show(context, { skins, onSubmit: () => undefined });
      const back = await until(read, (s) => s.button === 'Build the plan', 'the start tab is back');
      assert.deepEqual({ note: back.note, reason: back.problems[1] }, { note: SUBMIT_NOTES.failed, reason: 'failed while the picker was open' },
        'after the cancelled dialog, a re-render forgot that the build failed, and why');
      const before = back;
      await press(page); // the form is still valid: this must start a build, not be told one is running
      // `until`'s 10 s: the answer takes milliseconds on a quiet machine and under a second at load 20,
      // so the deadline only ever bounds a press that is never answered at all.
      const next = await until(read, (s) => s.note === SUBMIT_NOTES.building || s.note === SUBMIT_NOTES.busy, 'the next press is answered');
      assert.equal(next.note, SUBMIT_NOTES.building, 'the window still believed a finished build was running');
      assert.notDeepEqual({ ...next, focus: '' }, { ...before, focus: '' }, 'the press left the screen as it was');
      assert.equal(builds, 2, 'the second press did not start a second build');

      // And that build ends like any other: the button comes back, and the screen says how and why.
      second.end({ ok: false, reason: 'failed again, after the picker' });
      const after = await until(read, (s) => s.button === 'Build the plan', 'the second build gives the button back');
      assert.match(after.note, /^The build failed/);
      assert.equal(after.problems[1], 'failed again, after the picker', "the screen kept the first build's reason");
    } finally {
      (vscode.window as { showOpenDialog: typeof original }).showOpenDialog = original;
    }
  });

  test('a folder PICKED in a dialog left open across the END of a build never brings "Building…" back either (T-80 review)', async () => {
    // The guard above, on the dialog's other way out. A cancelled dialog changes nothing, so nothing is
    // written back at all (T-80 review F1); a pick changes the form, and that write must still read
    // whether a build is running live, not from the snapshot taken before the dialog opened.
    const original = vscode.window.showOpenDialog;
    let closeDialog: ((v: vscode.Uri[] | undefined) => void) | undefined;
    (vscode.window as { showOpenDialog: typeof original }).showOpenDialog = () =>
      new Promise<vscode.Uri[] | undefined>((resolve) => { closeDialog = resolve; });
    try {
      const first = heldBuild();
      const second = heldBuild();
      let builds = 0;
      const { page, read } = await open((r) => { builds += 1; void runBuild(context, core, r, (builds === 1 ? first : second).build); });
      await fill(page, validRequest());
      await until(read, filled, 'valid form');
      await press(page);
      await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');

      await screen.reader(TITLE, `document.getElementById('browse-target').click()`, page, gone)();
      const deadline = Date.now() + 5_000;
      while (!closeDialog && Date.now() < deadline) await sleep(50);
      assert.ok(closeDialog, 'Browse… never opened the (held) folder dialog');

      first.end({ ok: false, reason: 'failed while the picker was open' });
      await until(read, (s) => s.button === 'Build the plan', 'the build ended while the dialog was open');
      const picked = tmpDir('screen-target-picked-');
      closeDialog([vscode.Uri.file(picked)]); // the person picks a folder AFTER the build has ended
      const shown = await until(read, (s) => s.fields[1] === picked, 'the picked folder is in the form');

      assert.equal(panel!.getStateForTest().building, false, 'a dialog opened before the ending wrote "building" back');
      await press(page);
      const next = await until(read, (s) => s.note === SUBMIT_NOTES.building || s.note === SUBMIT_NOTES.busy, 'the next press is answered');
      assert.equal(next.note, SUBMIT_NOTES.building, 'the window still believed a finished build was running');
      assert.notDeepEqual({ ...next, focus: '' }, { ...shown, focus: '' }, 'the press left the screen as it was');
      assert.equal(builds, 2, 'the press after the pick did not start a second build');
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
    // T-154: the press writes its record and then the bookmark (T-122, its review's F3), so the bookmark can land a
    // moment after the page says "Building…". Waited for, bounded, not read at once (GitHub CI, run 44230665824).
    const bookmarkedBy = Date.now() + 5_000;
    while (context.workspaceState.get(BOOKMARK) !== request.target && Date.now() < bookmarkedBy) await sleep(50);
    assert.equal(context.workspaceState.get(BOOKMARK), request.target, 'the press never bookmarked the folder it builds in');

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

  test('T-71: after a build that fails partway, the very next press on the same form builds again, and the reason said it would', async () => {
    // The first build is the REAL one with a digest that throws, so its real write-ahead marker is
    // left in the target, as after a network blip or a model error. The press after it used to be
    // refused: "<target> is not empty — pick an empty or new folder". The retry is held, so the
    // screen shows "Building…" for as long as this test needs to read it (T-80's lesson).
    const retry = heldBuild();
    const request = validRequest();
    let builds = 0;
    const { page, read } = await open((r) => {
      builds += 1;
      if (builds > 1) { void runBuild(context, core, r, retry.build); return; }
      void runBuild(context, core, r, (rr, ctx) =>
        buildFromRequest(rr, { ...ctx, core: { ...ctx.core, digest: () => Promise.reject(new Error('the network blinked')) } }));
    });
    await fill(page, request);
    await until(read, filled, 'valid form');
    await press(page);
    const failed = await until(read, (s) => s.note === SUBMIT_NOTES.failed, 'the first build fails');
    assert.ok(fs.existsSync(markerPath(request.target)), 'the failed build should leave its marker, for a resume');
    assert.match(failed.problems[1] ?? '', /the network blinked — nothing is lost: press Build the plan to try again\./,
      'the reason under Reference repo does not say what to do next');

    await press(page); // the same form, unedited
    const again = await until(read, (s) => s.note === SUBMIT_NOTES.building || s.problems[2] !== '', 'the next press is answered');
    assert.equal(again.problems[2], '', `the same form was refused after the failure: ${again.problems[2]}`);
    assert.equal(again.note, SUBMIT_NOTES.building);
    assert.equal(builds, 2);
  });

  test('T-71: a build that fails twice in a row changes the words on screen the second time', async () => {
    // Driven for T-80: a second failure with the same reason, as a language refusal gives, left the
    // screen after the press exactly as it was before it. Consecutive frames must differ.
    const first = heldBuild();
    const second = heldBuild();
    let builds = 0;
    const { page, read } = await open((r) => { builds += 1; void runBuild(context, core, r, (builds === 1 ? first : second).build); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'building');
    first.end({ ok: false, reason: 'the same reason both times' });
    const once = await until(read, (s) => s.note === SUBMIT_NOTES.failed, 'the first failure');

    await press(page);
    await until(read, (s) => s.note === SUBMIT_NOTES.building, 'the second build');
    second.end({ ok: false, reason: 'the same reason both times' });
    const twice = await until(read, (s) => s.button === 'Build the plan', 'the second failure gives the button back');
    assert.notDeepEqual({ ...twice, focus: '' }, { ...once, focus: '' }, 'the second failure left the screen exactly as the first did');
    assert.equal(twice.note, FAILED_AGAIN.replace('{n}', '2'));
    assert.equal(builds, 2);
  });

  // T-171: repo-tour records each failed question in cost.failures and goes on; the ending used to say "Done" whatever.
  const withFailures = (over: Record<string, unknown>): BuildOutcome => ({
    ok: true, plan: { chapters: [], steps: [] },
    cost: { metered: false, usd: 0, inputTokens: 0, outputTokens: 0, calls: 0, cachedStops: 0, interpretedStops: 0, failures: [], ...over },
  });

  test('T-171: a build where every question to the model failed is not "Done": the form says it failed, and why, under Reference repo', async () => {
    const allFailed = withFailures({ failures: ['index.js: claude was not found on PATH', 'lookup.js: claude was not found on PATH'] });
    const held = heldBuild();
    const { page, read } = await open((r) => { void runBuild(context, core, r, held.build); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.button === 'Building… [disabled]' && s.note === SUBMIT_NOTES.building, 'an accepted press says it is building');
    held.end(allFailed);
    const ended = await until(read, (s) => s.button === 'Build the plan' && s.note !== SUBMIT_NOTES.building, 'the build gives the button back');
    assert.equal(ended.note, SUBMIT_NOTES.failed, 'a plan with no answer from the model in it was reported as Done');
    assert.match(ended.problems[1] ?? '', /every one of its 2 questions failed/);
    assert.match(ended.problems[1] ?? '', /\(index\.js\): claude was not found on PATH/);
    assert.match(ended.problems[1] ?? '', /Build Tutorials: Doctor/);
    // Review S3: the notification says it too, as a warning, not the information a clean build gets.
    const said = (await centre()).join('\n');
    assert.match(said, /every one of its 2 questions failed/, `the notification did not say it: ${said}`);
  });

  test('T-171: a build where some questions failed is built, and the form says how many, under Reference repo', async () => {
    const someFailed = withFailures({ calls: 2, interpretedStops: 5, failures: ['lookup.js: claude exited with code 1'] });
    const held = heldBuild();
    const { page, read } = await open((r) => { void runBuild(context, core, r, held.build); });
    await fill(page, validRequest());
    await until(read, filled, 'valid form');
    await press(page);
    await until(read, (s) => s.button === 'Building… [disabled]' && s.note === SUBMIT_NOTES.building, 'an accepted press says it is building');
    held.end(someFailed);
    const ended = await until(read, (s) => s.button === 'Build the plan' && s.note !== SUBMIT_NOTES.building, 'the build gives the button back');
    assert.equal(ended.note, SUBMIT_NOTES.partial, 'the note under the button must point at the line that says how many (review S2)');
    assert.match(ended.problems[1] ?? '', /^1 of 3 questions to the model failed/, 'the form said nothing about the failed question');
    const said = (await centre()).join('\n');
    assert.match(said, /1 of 3 questions to the model failed/, `the notification did not say it: ${said}`);
  });
});
