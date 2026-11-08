// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-17's AC3 ("the step panel renders each one"), read off the SCREEN.
 *
 * `test/derive.test.ts` proves the walk opens a derived plan and that the panel's STATE follows
 * each step. State is what a render would paint from, not the page: T-15's lesson is that a
 * property about what a person sees has to be tested by reading what a person sees. So this reads
 * the real webview's DOM (`test/support/screen.ts`), and compares consecutive frames, so a panel
 * that kept drawing the same page cannot pass.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { STEP_VIEW_FOCUS, cleanUpDerived, derivedTutorial, getApi } from './support/derived-tutorial.js';
import { Screen, nextFrame } from './support/screen.js';

const STEP_PAGE = 'Build Tutorials: Step';

suite('T-17 AC3, read off the screen — the step panel draws every step of a derived plan', () => {
  teardown(async () => {
    const api = await getApi();
    api._walk.session()?.dispose();
    api._walk.decorator()?.clear();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    cleanUpDerived();
  });

  test('each step\'s own question is on the page when the walk is on it, and every move changes the page', async () => {
    const { target, stepIds, questions } = await derivedTutorial();
    const api = await getApi();
    await api._walk.openAt(target);
    const session = api._walk.session();
    assert.ok(session, 'opening the walk should leave a live session behind');
    await session.settled();
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    const screen = await Screen.open(api._context);
    try {
      const read = screen.reader<string>(STEP_PAGE, 'document.body.innerText');
      let page = await nextFrame(read, '', 10_000);
      for (const [i, id] of stepIds.entries()) {
        if (i > 0) {
          const before = page;
          await vscode.commands.executeCommand('buildTutorials.goToStep', id);
          await session.settled();
          page = await nextFrame(read, before, 10_000);
          assert.notEqual(page, before, `moving to step ${i + 1} left the page as it was`);
        }
        assert.ok(page.includes(questions[i]!), `step ${i + 1}: the page should show "${questions[i]!}"; it shows:\n${page.slice(0, 500)}`);
      }
    } finally {
      screen.close();
    }
  });
});
