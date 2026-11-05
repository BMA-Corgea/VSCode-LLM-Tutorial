// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-21's acceptance, read off the SCREEN: the learner takes a road in the real Current Step
 * webview (the registered panel, through the real activation path), and every frame is read from
 * the page itself (`test/support/screen.ts`). Runs in the `screen` test host only — the one
 * launched with a DevTools port (`.vscode-test.mjs`).
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { Progress } from '../src/walk/model.js';
import { CHOOSE_LABEL, CHOSEN_BADGE, DIVERGED_NOTE } from '../src/walk/step-view.js';
import { Screen, nextFrame, type Frame } from './support/screen.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const TITLE = 'Build Tutorials: Step';
const STEP = 'st-4-symbol-render'; // three options: the author's and two alternatives

/** What a person could see in the options list. */
const OPTIONS = `(() => {
  const list = document.querySelector('ul.options');
  if (!list) return null;
  const rows = Array.from(list.querySelectorAll('li'));
  return {
    on: rows.filter((li) => li.classList.contains('option-taken')).map((li) => li.getAttribute('data-option-id')),
    yours: rows.filter((li) => li.querySelector('.badge-chosen')).map((li) => li.getAttribute('data-option-id')),
    choosable: Array.from(list.querySelectorAll('button.option-choose')).map((b) => b.getAttribute('data-option-id') + ':' + b.textContent),
    note: (document.querySelector('.options-diverged') || { textContent: '' }).textContent,
  };
})()`;
interface Options { on: string[]; yours: string[]; choosable: string[]; note: string }

suite('the Current Step panel, read off the screen (T-21)', function () {
  this.timeout(90_000);

  test('choose a road the author did not take: the panel shows it, progress keeps it, the plan file is untouched, a reload remembers it', async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
    assert.ok(ext);
    const api = await ext.activate();
    const screen = await Screen.open(api._context);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-screen-'));
    writeFixtureTarget(dir);
    const planFile = path.join(dir, '.repo-tour', 'build', 'plan.json');
    const progressFile = path.join(dir, '.repo-tour', 'build', 'progress.json');
    const planBefore = fs.readFileSync(planFile);
    try {
      await api._walk.openAt(dir);
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      api._walk.session()!.goTo(STEP);
      const page: Frame = await screen.webview(TITLE);
      const read = screen.reader<Options | null>(TITLE, OPTIONS, page);
      const press = (optionId: string): Promise<unknown> => screen.reader(
        TITLE, `document.querySelector('button.option-choose[data-option-id=${JSON.stringify(optionId)}]').click()`, page,
      )();

      let before = await read();
      for (let i = 0; i < 40 && !before?.choosable.length; i++) before = await nextFrame(read, before, 250);
      assert.deepEqual(before?.on, ['author'], 'before any choice the step is on the author\'s road');
      assert.deepEqual(before?.choosable, [`template-string:${CHOOSE_LABEL}`, `stream:${CHOOSE_LABEL}`], 'both alternatives are real controls');
      assert.equal(before?.note, '');

      await press('stream');
      const after = await nextFrame(read, before);
      assert.deepEqual(after?.on, ['stream'], 'his choice is where the author\'s was');
      assert.deepEqual(after?.yours, ['stream'], `and marked "${CHOSEN_BADGE}"`);
      assert.deepEqual(after?.choosable, [`author:${CHOOSE_LABEL}`, `template-string:${CHOOSE_LABEL}`], 'the author\'s road is choosable again; his own is not a control');
      assert.equal(after?.note, DIVERGED_NOTE, 'and the panel says the rest of the walk has not changed');

      const onDisk = JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Progress;
      assert.equal(onDisk.steps[STEP]?.chosen, 'stream', 'recorded beside the plan');
      assert.ok(fs.readFileSync(planFile).equals(planBefore), 'plan.json is byte-for-byte what repo-tour wrote');

      // The reload drill: a fresh session from disk alone.
      api._walk.session()!.dispose();
      await api._walk.openAt(dir);
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      api._walk.session()!.goTo(STEP);
      let reloaded = await read();
      for (let i = 0; i < 40 && JSON.stringify(reloaded?.on) !== '["stream"]'; i++) reloaded = await nextFrame(read, reloaded, 250);
      assert.deepEqual(reloaded?.on, ['stream'], 'a reload forgot the learner\'s road');
      assert.equal(reloaded?.note, DIVERGED_NOTE);

      // Latest wins: back to the author's road, and the line goes with it.
      await press('author');
      const back = await nextFrame(read, reloaded);
      assert.deepEqual(back?.on, ['author']);
      assert.equal(back?.note, '', 'on the author\'s road there is nothing to warn about');
    } finally {
      api._walk.session()?.dispose();
      screen.close();
    }
  });
});
