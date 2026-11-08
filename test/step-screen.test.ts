// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-21's acceptance, read off the SCREEN: the learner takes a road in the real Current Step
 * webview (the registered panel, through the real activation path), and every frame is read from
 * the page itself (`test/support/screen.ts`). Runs in the `screen` test host only — the one
 * launched with a DevTools port (`.vscode-test.mjs`).
 *
 * The stale-page tests use repo-tour's real option ids (`author`, `alt-1`, `alt-2` on every step).
 * A press there is evaluated in the OLD page's own context, with no reader in between: a reader
 * retries a dead frame on the new page, and that would prove nothing.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { PlanLike, Progress } from '../src/walk/model.js';
import { CHOICE_NOT_AN_OPTION, CHOICE_STALE_PAGE } from '../src/walk/session.js';
import { CHOOSE_LABEL, CHOSEN_BADGE, DIVERGED_NOTE } from '../src/walk/step-view.js';
import { Screen, sleep, stale, type Frame } from './support/screen.js';
import { repoTourShapedPlan, writeFixtureTarget } from './unit/walk-fixtures.js';

const TITLE = 'Build Tutorials: Step';
const STEP = 'st-4-symbol-render'; // three options: the author's and two alternatives

/** What a person could see in the options section: the rows, the words about the last press, and whether those words are on screen. */
const OPTIONS = `(() => {
  const list = document.querySelector('ul.options');
  if (!list) return null;
  const rows = Array.from(list.querySelectorAll('li'));
  const refused = document.getElementById('choice-note');
  const box = refused ? refused.getBoundingClientRect() : null;
  return {
    step: document.getElementById('step-main').getAttribute('data-step-id'),
    on: rows.filter((li) => li.classList.contains('option-taken')).map((li) => li.getAttribute('data-option-id')),
    yours: rows.filter((li) => li.querySelector('.badge-chosen')).map((li) => li.getAttribute('data-option-id')),
    choosable: Array.from(list.querySelectorAll('button.option-choose')).map((b) => b.getAttribute('data-option-id') + ':' + b.textContent),
    note: (document.querySelector('.options-diverged') || { textContent: '' }).textContent,
    refused: refused ? refused.textContent : '',
    refusedInView: box ? box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight : null,
    refusedBesideList: refused ? refused.closest('section') === list.closest('section') : null,
  };
})()`;
interface Options {
  step: string;
  on: string[];
  yours: string[];
  choosable: string[];
  note: string;
  refused: string;
  refusedInView: boolean | null;
  refusedBesideList: boolean | null;
}

const choose = (optionId: string): string => `button.option-choose[data-option-id=${JSON.stringify(optionId)}]`;

/** Polls until `ok`, or fails naming what was on screen instead. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let now = await read();
  while (!ok(now) && Date.now() < deadline) {
    await sleep(100);
    now = await read();
  }
  assert.ok(ok(now), `${what} — the screen showed ${JSON.stringify(now)}`);
  return now;
}

interface Drive {
  api: ExtensionApi;
  screen: Screen;
  planFile: string;
  progressFile: string;
  read: () => Promise<Options | null>;
  /** Moves the walk to a step and waits until that step's page is the one on screen. */
  onStep: (stepId: string) => Promise<Options | null>;
  /** The frame currently showing a step's page, for a press that must land on exactly that page. */
  pageShowing: (stepId: string) => Promise<Frame>;
  /** Evaluates `expression` on whatever page is live now, for a press on the current page. */
  pressNow: (expression: string) => Promise<unknown>;
  progress: () => Progress;
  /**
   * The stale-page press: the host moves on, and the click is evaluated in the OLD page's own
   * context in the same breath. A frame gone before the click reaches it is raced again from the
   * start, never clicked on the new page. `clickedOn` is the step the page that took the click
   * was drawn for; `progressAfterMove` is progress.json the instant the host had moved.
   */
  pressFromLeftPage: (leaving: string, moveOn: () => void, selector: string) => Promise<{ clickedOn: string; progressAfterMove: Buffer }>;
}

suite('the Current Step panel, read off the screen (T-21)', function () {
  this.timeout(120_000);

  /**
   * Opens a real walk on a fixture folder and runs `body` against the live panel. A failed test
   * still closes the walk's editor tabs and hands the sidebar back, so one failure here does not
   * drag the next suite's screen test down with it (the T-21 build's harness note).
   */
  async function drive(body: (d: Drive) => Promise<void>, plan?: PlanLike): Promise<void> {
    const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
    assert.ok(ext);
    const api = await ext.activate();
    const screen = await Screen.open(api._context);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-screen-'));
    writeFixtureTarget(dir, plan);
    const planFile = path.join(dir, '.repo-tour', 'build', 'plan.json');
    const progressFile = path.join(dir, '.repo-tour', 'build', 'progress.json');
    try {
      await api._walk.openAt(dir);
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      const read = screen.reader<Options | null>(TITLE, OPTIONS);
      const onStep = async (stepId: string): Promise<Options | null> => {
        api._walk.session()!.goTo(stepId);
        return until(read, (o) => o?.step === stepId && o.choosable.length > 0, `the page for ${stepId}`);
      };
      const pageShowing = async (stepId: string): Promise<Frame> => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const page = await screen.webview(TITLE);
          const shown = await screen.evaluate<string | null>(page, `document.getElementById('step-main').getAttribute('data-step-id')`).catch(() => null);
          if (shown === stepId) return page;
          await sleep(100);
        }
        throw new Error(`no frame ever showed ${stepId}`);
      };
      const pressNow = (expression: string): Promise<unknown> => screen.reader<unknown>(TITLE, expression)();
      const progress = (): Progress => JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Progress;
      const pressFromLeftPage: Drive['pressFromLeftPage'] = async (leaving, moveOn, selector) => {
        const click = `(() => { document.querySelector(${JSON.stringify(selector)}).click(); return document.getElementById('step-main').getAttribute('data-step-id'); })()`;
        for (let attempt = 0; attempt < 8; attempt++) {
          await onStep(leaving);
          const page = await pageShowing(leaving);
          moveOn();
          const progressAfterMove = fs.readFileSync(progressFile);
          try {
            return { clickedOn: await screen.evaluate<string>(page, click), progressAfterMove };
          } catch (err) {
            if (!stale(err)) throw err;
            // The old frame went before the click reached it. Race again; never click the new page.
          }
        }
        throw new Error('the old page was gone before the click reached it, eight times running');
      };
      await body({ api, screen, planFile, progressFile, read, onStep, pageShowing, pressNow, progress, pressFromLeftPage });
    } finally {
      api._walk.session()?.dispose();
      screen.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
    }
  }

  test('choose a road the author did not take: the panel shows it, progress keeps it, the plan file is untouched, a reload remembers it', () => drive(async ({ api, planFile, progressFile, read, onStep, pressNow }) => {
    const planBefore = fs.readFileSync(planFile);
    const before = await onStep(STEP);
    assert.deepEqual(before?.on, ['author'], 'before any choice the step is on the author\'s road');
    assert.deepEqual(before?.choosable, [`template-string:${CHOOSE_LABEL}`, `stream:${CHOOSE_LABEL}`], 'both alternatives are real controls');
    assert.equal(before?.note, '');

    await pressNow(`document.querySelector(${JSON.stringify(choose('stream'))}).click()`);
    const after = await until(read, (o) => (o?.on[0] ?? '') === 'stream', 'the learner\'s choice is where the author\'s was');
    assert.deepEqual(after?.yours, ['stream'], `and marked "${CHOSEN_BADGE}"`);
    assert.deepEqual(after?.choosable, [`author:${CHOOSE_LABEL}`, `template-string:${CHOOSE_LABEL}`], 'the author\'s road is choosable again; the learner\'s own is not a control');
    assert.equal(after?.note, DIVERGED_NOTE, 'and the panel says the rest of the walk has not changed');

    const onDisk = JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Progress;
    assert.equal(onDisk.steps[STEP]?.chosen, 'stream', 'recorded beside the plan');
    assert.ok(fs.readFileSync(planFile).equals(planBefore), 'plan.json is byte-for-byte what repo-tour wrote');

    // The reload drill: a fresh session from disk alone.
    const dir = path.dirname(path.dirname(path.dirname(planFile)));
    api._walk.session()!.dispose();
    await api._walk.openAt(dir);
    await vscode.commands.executeCommand('buildTutorials.step.focus');
    api._walk.session()!.goTo(STEP);
    const reloaded = await until(read, (o) => (o?.on[0] ?? '') === 'stream', 'a reload forgot the learner\'s road');
    assert.equal(reloaded?.note, DIVERGED_NOTE);

    // Latest wins: back to the author's road, and the line goes with it.
    await pressNow(`document.querySelector(${JSON.stringify(choose('author'))}).click()`);
    const back = await until(read, (o) => (o?.on[0] ?? '') === 'author', 'the author\'s road again');
    assert.equal(back?.note, '', 'on the author\'s road there is nothing to warn about');
  }));

  test('a press from a page for a step already left records nothing, says so beside the list and in view, and pressing again changes the screen again (AC2, AC5; reviews C1, S1, C8)', () => drive(async ({ read, api, progress, progressFile, pressFromLeftPage, pressNow }) => {
    const LEFT = STEP;
    const NOW = 'st-2-file-parse';
    const { clickedOn, progressAfterMove } = await pressFromLeftPage(LEFT, () => api._walk.session()!.goTo(NOW), choose('alt-1'));
    assert.equal(clickedOn, LEFT, 'the click landed on the page for the step the host had left');

    const first = await until(read, (o) => o?.step === NOW && o.refused !== '', 'the refusal reaches the page for the step the learner is on');
    assert.equal(first?.refused, CHOICE_STALE_PAGE);
    assert.equal(first?.refusedBesideList, true, 'in the options section, where the press was');
    assert.equal(first?.refusedInView, true, 'on screen, not below the fold');
    assert.deepEqual(first?.on, ['author'], 'the step the learner is on is still on the author\'s road');
    assert.equal(first?.note, '', 'and it says nothing about a road being taken');
    assert.ok(fs.readFileSync(progressFile).equals(progressAfterMove), 'a refused press writes nothing');
    assert.equal(progress().steps[NOW]?.chosen, undefined, 'nothing recorded on the step the learner is on');
    assert.equal(progress().steps[LEFT]?.chosen, undefined, 'nothing recorded on the step the page was drawn for');

    // Pressing again: this page, told it was drawn for the step already left, and a real button.
    const pressAsIfLeft = `(() => { document.getElementById('step-main').setAttribute('data-step-id', ${JSON.stringify(LEFT)}); document.querySelector(${JSON.stringify(choose('alt-1'))}).click(); })()`;
    // (Waiting on the words, not "any change": the forged attribute alone changes what `read` sees.)
    await pressNow(pressAsIfLeft);
    const second = await until(read, (o) => o?.refused === `${CHOICE_STALE_PAGE} Tried 2 times.`, 'a second refused press must change the screen');
    assert.equal(second?.step, NOW, 'on the page for the step the learner is on');
    assert.notDeepEqual(second, first);
    assert.equal(second?.refusedInView, true);

    await pressNow(pressAsIfLeft);
    const third = await until(read, (o) => o?.refused === `${CHOICE_STALE_PAGE} Tried 3 times.`, 'and so must a third');
    assert.notDeepEqual(third, second);
    assert.ok(fs.readFileSync(progressFile).equals(progressAfterMove), 'still nothing written');

    // The positive path is still there, and the refusal does not outlive it.
    await pressNow(`document.querySelector(${JSON.stringify(choose('alt-1'))}).click()`);
    const chosen = await until(read, (o) => (o?.on[0] ?? '') === 'alt-1', 'a press from the page for this step is recorded here');
    assert.equal(chosen?.refused, '', 'the sentence that says nothing was recorded goes when something is');
    assert.equal(progress().steps[NOW]?.chosen, 'alt-1');
  }, repoTourShapedPlan()));

  test('one page\'s Next then Choose, before its reload: the choice lands on neither step and the new page says so (AC2; security S3)', () => drive(async ({ read, onStep, pageShowing, screen, progress }) => {
    const FROM = 'st-2-file-parse';
    const NEXT = 'st-3-symbol-handle';
    await onStep(FROM);
    const page = await pageShowing(FROM);
    await screen.evaluate(page, `(() => { document.getElementById('btn-next').click(); document.querySelector(${JSON.stringify(choose('alt-1'))}).click(); })()`);
    const after = await until(read, (o) => o?.step === NEXT && o.refused !== '', 'the refusal is drawn on the next step\'s page');
    assert.equal(after?.refused, CHOICE_STALE_PAGE);
    assert.equal(after?.refusedInView, true);
    assert.deepEqual(after?.on, ['author']);
    assert.equal(progress().steps[FROM]?.chosen, undefined, 'nothing recorded on the step pressed on');
    assert.equal(progress().steps[NEXT]?.chosen, undefined, 'and nothing on the step it moved to');
  }, repoTourShapedPlan()));

  test('a stale press on the author\'s row does not undo a real choice made since (security S2)', () => drive(async ({ read, api, onStep, pressNow, progress, pressFromLeftPage }) => {
    const A = 'st-2-file-parse';
    const B = STEP;
    await onStep(A);
    await pressNow(`document.querySelector(${JSON.stringify(choose('alt-1'))}).click()`);
    await until(read, (o) => (o?.on[0] ?? '') === 'alt-1', 'a real choice at A');
    await onStep(B);
    await pressNow(`document.querySelector(${JSON.stringify(choose('alt-2'))}).click()`);
    await until(read, (o) => o?.step === B && (o.on[0] ?? '') === 'alt-2', 'a real choice at B');

    const { clickedOn } = await pressFromLeftPage(A, () => api._walk.session()!.goTo(B), choose('author'));
    assert.equal(clickedOn, A, 'the click landed on the old page');
    const after = await until(read, (o) => o?.step === B && o.refused !== '', 'the refusal reaches B');
    assert.equal(after?.refused, CHOICE_STALE_PAGE);
    assert.deepEqual(after?.on, ['alt-2'], 'B is still on the road the learner chose');
    assert.equal(progress().steps[A]?.chosen, 'alt-1');
    assert.equal(progress().steps[B]?.chosen, 'alt-2', 'a stale press undid a real choice');
  }, repoTourShapedPlan()));

  test('a press the host cannot take is answered beside the list and in view, even from a scrolled page, and every press changes the frame (AC5; review C8)', () => drive(async ({ read, onStep, pressNow, progress }) => {
    const before = await onStep(STEP);
    assert.equal(before?.refused, '');
    const forged = `(() => { const b = document.querySelector('button.option-choose'); b.setAttribute('data-option-id', 'nobody-offered-this'); b.click(); })()`;

    // (Waiting on the words, not "any change": the forged attribute alone changes what `read` sees.)
    await pressNow(forged);
    const one = await until(read, (o) => o?.refused === CHOICE_NOT_AN_OPTION, 'a refused press must change the screen');
    assert.notDeepEqual(one, before);
    assert.equal(one?.refusedBesideList, true, 'in the options section, where the press was');
    assert.equal(one?.refusedInView, true, 'on screen, not 900 px below the button');

    await pressNow(forged);
    const two = await until(read, (o) => o?.refused === `${CHOICE_NOT_AN_OPTION} Tried 2 times.`, 'the second identical refusal must change the screen too (T-15)');
    assert.notDeepEqual(two, one);
    assert.equal(two?.refusedInView, true);

    // Pressed from further down the page: the words are above the viewport until the answer brings them back.
    await pressNow(`(() => { const b = document.querySelector('button.option-choose'); window.scrollTo(0, b.getBoundingClientRect().top + window.scrollY - 4); })()`);
    await until(read, (o) => o?.refusedInView === false, 'the page scrolled so the words are out of view');
    await pressNow(forged);
    const three = await until(read, (o) => o?.refused === `${CHOICE_NOT_AN_OPTION} Tried 3 times.`, 'a press from a scrolled page is answered too');
    assert.equal(three?.refusedInView, true, 'and brings its answer back into view');

    assert.equal(progress().steps[STEP]?.chosen, undefined, 'none of them recorded anything');
  }));
});
