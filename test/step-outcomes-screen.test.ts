// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-42: does the REAL Current Step panel keep the outcome of a press in view?
 *
 * T-16 measured every state headless, where each one is a fresh page, so it could not see what a
 * press does to the scroll position once VS Code replaces the webview's `html`. It added a one-shot
 * reveal and said plainly that this was unverified where it matters. These tests are that check:
 * the real panel, the real presses, and every reading taken from inside the page
 * (`test/support/screen.ts`). They run in the `screen` host, the one launched with a DevTools port.
 *
 * What is real: the panel, its page and script, the walk, `check`. What is not: the model, which is
 * the tutor stand-in (`_walk.useTutorCore`), so nothing here spends a token.
 *
 * The step is made tall on purpose. On a step that fits the panel, every outcome is on screen
 * whatever the code does and these tests would prove nothing, so each one first proves the page is
 * taller than the panel. "Fully in view" rather than "intersects": measured without the reveal, the
 * boxes for Ask and the detour still clip the panel's edge, and "intersects" passes on that defect.
 *
 * Each test reads the panel before the press and again after it (T-15's rule: compare consecutive
 * frames). What must have changed is stated by the reading before and the condition waited for after.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { LlmReply, TutorCore } from '../src/tutor/core.js';
import type { PlanLike } from '../src/walk/model.js';
import { CHECK_HEADING, DETOUR_WAITING_MESSAGE } from '../src/walk/step-view.js';
import { Screen, sleep } from './support/screen.js';
import { repoTourShapedPlan, writeFixtureTarget } from './unit/walk-fixtures.js';

const TITLE = 'Build Tutorials: Step';
const STEP = 'st-4-symbol-render';
const ANSWER = 'An answer the tutor gave, in place of a model.';
const FIXTURE_FILES = ['src/parse.ts', 'src/api/routes.ts', 'src/api/render.ts'];

interface Box { top: number; bottom: number; height: number; fullyInView: boolean; words: string }
interface NewestTurn { top: number; bottom: number; inView: boolean; words: string }
interface Reading { y: number; panelHeight: number; pageHeight: number; outcome: Box | null; newestTurn: NewestTurn | null; thinking: boolean; step: string | null }

/** What is on screen, from inside the page: where it is scrolled to, and where the outcome is. */
const READ = (outcomeId: string): string => `(() => {
  const panelHeight = window.innerHeight;
  const element = document.getElementById(${JSON.stringify(outcomeId)});
  const box = element ? element.getBoundingClientRect() : null;
  const words = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const log = document.querySelector('ul.tutor-log');
  const newest = log ? log.lastElementChild : null;
  const turn = newest ? newest.getBoundingClientRect() : null;
  return {
    y: Math.round(window.scrollY),
    panelHeight,
    pageHeight: document.documentElement.scrollHeight,
    outcome: box ? {
      top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height),
      fullyInView: box.height > 0 && box.top >= 0 && box.bottom <= panelHeight,
      words: words(element),
    } : null,
    newestTurn: turn ? {
      top: Math.round(turn.top), bottom: Math.round(turn.bottom),
      inView: turn.height > 0 && turn.bottom > 0 && turn.top < panelHeight,
      words: words(newest),
    } : null,
    thinking: document.getElementById('tutor-thinking') !== null,
    step: (document.getElementById('step-main') || { getAttribute: () => null }).getAttribute('data-step-id'),
  };
})()`;

function tallPlan(): PlanLike {
  const plan = repoTourShapedPlan();
  const step = plan.steps.find((s) => s.id === STEP);
  assert.ok(step, `the fixture plan has no step ${STEP}`);
  step.decision.why = Array.from({ length: 40 }, (_unused, i) => `Reason ${i + 1}: this sentence is here to make the step as long as a real one, so what comes after its buttons starts below the first screen.`).join(' ');
  return plan;
}

/** A tutorial the tutor can be asked about, beside its reference: `WalkSession.beginAsk` needs `request.json`. */
function tallTutorial(dirs: string[]): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 't42-target-'));
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), 't42-reference-'));
  dirs.push(target, reference);
  writeFixtureTarget(target, tallPlan());
  for (const rel of FIXTURE_FILES) {
    const to = path.join(reference, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(target, rel), to);
  }
  fs.writeFileSync(
    path.join(target, '.repo-tour', 'build', 'request.json'),
    `${JSON.stringify({ idea: '', recreate: true, repo: reference, referenceRoot: reference, target, dial: 'manual' }, null, 2)}\n`,
  );
  return target;
}

interface Drive {
  /** Scrolls until the button is on screen, as a person must before pressing it, and reads the panel. */
  atButton: (button: string, outcomeId: string) => Promise<Reading>;
  click: (button: string) => Promise<void>;
  /** Waits until `ok` holds for this outcome and the panel has stopped moving, then reads it. */
  whenShown: (outcomeId: string, ok: (r: Reading) => boolean, what: string) => Promise<Reading>;
  type: (text: string) => Promise<void>;
  /** What the stand-in does when it is called: a test holds the answer back, or never gives one. */
  modelReplies: (how: () => Promise<LlmReply>) => void;
}

function assertTallPage(reading: Reading): void {
  assert.ok(reading.pageHeight > 2 * reading.panelHeight,
    `the page (${reading.pageHeight} px) is not much taller than the panel (${reading.panelHeight} px): every outcome is on screen whatever the code does, and this test proves nothing`);
}

suite('T-42: the real panel keeps the outcome of a press in view', function () {
  this.timeout(120_000);

  async function drive(body: (d: Drive) => Promise<void>): Promise<void> {
    const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
    assert.ok(ext);
    const api = await ext.activate();
    const screen = await Screen.open(api._context);
    const dirs: string[] = [];
    try {
      await api._walk.openAt(tallTutorial(dirs));
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      const session = api._walk.session();
      assert.ok(session, 'opening the walk should leave a session behind');
      await session.settled();
      session.goTo(STEP);

      const core = await api._walk.tutorCore();
      assert.ok(core, 'repo-tour should load, or there is no tutor to stand in for');
      let reply: () => Promise<LlmReply> = () => Promise.reject(new Error('T-42: a test forgot to say what the model does'));
      const standIn: TutorCore = {
        ...core,
        availability: () => Promise.resolve({ ok: true, detail: 'a stubbed provider probe' }),
        runLlm: () => reply(),
      };
      api._walk.useTutorCore(standIn);

      const onPage = (expression: string): Promise<unknown> => screen.reader<unknown>(TITLE, expression)();
      const read = (outcomeId: string): Promise<Reading> => screen.reader<Reading>(TITLE, READ(outcomeId))();

      // The right step's page, before anything is pressed on it.
      const deadline = Date.now() + 20_000;
      let first = await read('outcome-check');
      while (first.step !== STEP && Date.now() < deadline) {
        await sleep(100);
        first = await read('outcome-check');
      }
      assert.equal(first.step, STEP, 'the panel never showed the step under test');

      await body({
        atButton: async (button, outcomeId) => {
          await onPage(`document.getElementById(${JSON.stringify(button)}).scrollIntoView({ block: 'end' })`);
          await sleep(400); // the page's own listener keeps its place 150 ms after a scroll
          return read(outcomeId);
        },
        click: async (button) => { await onPage(`document.getElementById(${JSON.stringify(button)}).click()`); },
        whenShown: async (outcomeId, ok, what) => {
          const shownBy = Date.now() + 30_000;
          let now = await read(outcomeId);
          while (!ok(now) && Date.now() < shownBy) {
            await sleep(100);
            now = await read(outcomeId);
          }
          assert.ok(ok(now), `${what} never appeared: the panel showed ${JSON.stringify(now)}`);
          // Stopped moving: two readings in a row the same. A repaint and a scroll both take time.
          for (let i = 0; i < 40; i++) {
            await sleep(150);
            const next = await read(outcomeId);
            if (JSON.stringify(next) === JSON.stringify(now)) return next;
            now = next;
          }
          return now;
        },
        type: async (text) => { await onPage(`document.getElementById('tutor-input').value = ${JSON.stringify(text)}`); },
        modelReplies: (how) => { reply = how; },
      });
    } finally {
      api._walk.useTutorCore(undefined);
      api._walk.session()?.dispose();
      screen.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('AC1 + AC4: Check my work — the verdict is fully in view, where the button was just pressed', () => drive(async ({ atButton, click, whenShown }) => {
    const before = await atButton('btn-check', 'outcome-check');
    assertTallPage(before);
    assert.equal(before.outcome, null, 'there is no verdict before the first check');

    await click('btn-check');
    const after = await whenShown('outcome-check', (r) => r.outcome?.words.startsWith(CHECK_HEADING) === true, 'the verdict');

    assert.ok(after.outcome?.fullyInView, `the check's verdict is not fully in the panel: ${JSON.stringify(after)}`);
  }));

  // The answer is held back on purpose. A real ask paints at least twice — waiting, then the answer —
  // and the reveal is one-shot, so the first paint spends it; a stand-in that answered at once
  // sometimes merged those paints and sometimes did not, which is a flake and not the real path.
  //
  // Unlike Check and the detour, this one does not depend on the reveal (measured: T-42's build
  // evidence): the ask box is where the person just pressed, and the answer is drawn in place. It
  // pins that a repaint leaves them there. A repaint that moves the page away is what turns it red.
  test('AC2 + AC4: Ask — the waiting line is fully in view, and the answer starts on screen when it comes', () => drive(async ({ atButton, click, modelReplies, type, whenShown }) => {
    let answerNow: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => { answerNow = resolve; });
    modelReplies(async () => {
      await answered;
      return { text: ANSWER, inputTokens: 0, outputTokens: 0, usd: 0, metered: false };
    });
    const before = await atButton('btn-tutor-ask', 'outcome-tutor');
    assertTallPage(before);
    assert.equal(before.thinking, false, 'nothing is being asked before the press');
    assert.equal(before.newestTurn, null, 'there is no conversation before the first question');

    await type('why this?');
    await click('btn-tutor-ask');
    const waiting = await whenShown('outcome-tutor', (r) => r.thinking, 'the waiting line');
    assert.ok(waiting.outcome?.fullyInView, `the ask box, with the waiting line in it, is not fully in the panel: ${JSON.stringify(waiting)}`);

    answerNow();
    const after = await whenShown('outcome-tutor', (r) => r.newestTurn?.words.includes(ANSWER) === true, 'the answer');
    console.log(`T-42 AC2 measured: ${JSON.stringify({ waiting, after })}`);
    const turn = after.newestTurn;
    assert.ok(turn && turn.top >= 0 && turn.top < after.panelHeight, `the answer does not start on screen: ${JSON.stringify(after)}`);
  }));

  test('AC3 + AC4: Show me an unrelated example — "writing an example…" is fully in view', () => drive(async ({ atButton, click, modelReplies, whenShown }) => {
    modelReplies(() => new Promise<LlmReply>(() => undefined)); // the example stays "writing"
    const before = await atButton('btn-detour-start', 'outcome-detour');
    assertTallPage(before);
    assert.equal(before.outcome?.words.includes(DETOUR_WAITING_MESSAGE), false, 'nothing is being written before the press');

    await click('btn-detour-start');
    const after = await whenShown('outcome-detour', (r) => r.outcome?.words.includes(DETOUR_WAITING_MESSAGE) === true, 'the waiting line');

    assert.ok(after.outcome?.fullyInView, `"${DETOUR_WAITING_MESSAGE}" is not fully in the panel: ${JSON.stringify(after)}`);
  }));
});
