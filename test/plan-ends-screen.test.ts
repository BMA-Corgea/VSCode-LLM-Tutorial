// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-51, read off the real screen (`test/support/screen.ts`): at the last step of the plan the Current Step
 * panel's *Next* is disabled with its reason under the action row, and the Decisions view's own *Next step*
 * arrow in its title bar is disabled too (the command's `enablement`, kept current by the walk). One step
 * back, both work again. A press on a control that cannot act is impossible, rather than ignored.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import { LAST_STEP_HINT } from '../src/walk/step-view.js';
import { Screen, sleep } from './support/screen.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const TITLE = 'Build Tutorials: Step';
const LAST = 'st-4-symbol-render';
const BEFORE_LAST = 'st-3-symbol-handle';

interface Panel { step: string | null; prevDisabled: boolean; nextDisabled: boolean; hint: string | null }
interface Arrow { label: string; disabled: boolean }

const PANEL = `(() => ({
  step: (document.getElementById('step-main') || { getAttribute: () => null }).getAttribute('data-step-id'),
  prevDisabled: !!(document.getElementById('btn-prev') || {}).disabled,
  nextDisabled: !!(document.getElementById('btn-next') || {}).disabled,
  hint: (document.getElementById('ends-hint') || { textContent: null }).textContent,
}))()`;

const ARROWS = `Array.from(document.querySelectorAll('.monaco-action-bar .action-item a.action-label'))
  .map((a) => ({ label: a.getAttribute('aria-label') || '', disabled: a.classList.contains('disabled') || a.getAttribute('aria-disabled') === 'true' }))
  .filter((a) => /^(Previous step|Next step)/.test(a.label))`;

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) { await sleep(150); last = await read(); }
  assert.ok(ok(last), `${what}: the screen showed ${JSON.stringify(last)}`);
  return last;
}

suite('T-51: the ends of the plan, read off the real panel and the real title bar', function () {
  this.timeout(120_000);

  test('at the last step Next is disabled with its reason, in the panel and in the view\'s title bar; one step back both work', async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
    assert.ok(ext);
    const api = await ext.activate();
    const screen = await Screen.open(api._context);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't51-screen-'));
    try {
      writeFixtureTarget(dir);
      await api._walk.openAt(dir);
      await vscode.commands.executeCommand('buildTutorials.decisions.focus');
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      const session = api._walk.session();
      assert.ok(session);
      await session.settled();
      const panel = (): Promise<Panel> => screen.reader<Panel>(TITLE, PANEL)().catch(() => ({ step: null, prevDisabled: false, nextDisabled: false, hint: null }));
      const arrows = async (): Promise<Arrow[]> => screen.evaluate<Arrow[]>(await screen.workbench(), ARROWS);

      session.goTo(LAST);
      const atLast = await until(panel, (p) => p.step === LAST, 'the last step\'s page');
      assert.ok(atLast.nextDisabled && !atLast.prevDisabled, `Next, not Previous, is disabled at the last step: ${JSON.stringify(atLast)}`);
      assert.equal(atLast.hint, LAST_STEP_HINT, 'and the panel says why');
      const barAtLast = await until(arrows, (a) => a.some((x) => x.label.startsWith('Next step') && x.disabled), 'the title bar\'s Next arrow disabled');
      assert.ok(barAtLast.some((x) => x.label.startsWith('Previous step') && !x.disabled), `Previous still enabled: ${JSON.stringify(barAtLast)}`);

      session.goTo(BEFORE_LAST);
      const back = await until(panel, (p) => p.step === BEFORE_LAST, 'the page one step back');
      assert.ok(!back.nextDisabled && !back.prevDisabled && back.hint === null, `between the ends both work and nothing needs explaining: ${JSON.stringify(back)}`);
      await until(arrows, (a) => a.length >= 2 && a.every((x) => !x.disabled), 'both title-bar arrows enabled again');
    } finally {
      screen.close();
      api._walk.session()?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
