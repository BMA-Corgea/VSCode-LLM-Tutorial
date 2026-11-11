// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-52, in the real host: the Start form's three text fields as VS Code 1.145 draws them under the System
 * skin, read from inside the real page (`test/support/screen.ts`).
 *
 * The unit tests pin the rules; this pins what they DO here: the computed placeholder colour is the theme's
 * own `input.placeholderForeground`, and a focused field's computed outline is VS Code's 1 px `focusBorder`,
 * inset. A selector that reached no element, or a bridge variable VS Code did not define, would pass a rule
 * test and fail here (T-52's review, F1). Both expected colours are resolved in the page itself, from the
 * variables VS Code set, so the test holds in whatever theme the host runs.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import { Screen, sleep } from './support/screen.js';

const TITLE = 'Build Tutorials: Start';
const SKIN_KEY = 'buildTutorials.skin';

interface Field { placeholder: string; focused: boolean; outline: string }
interface Reading { skin: string | null; want: { placeholder: string; focus: string }; fields: Record<string, Field> }

const READ = `(async () => {
  const resolve = (value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  };
  const want = { placeholder: resolve('var(--vscode-input-placeholderForeground)'), focus: resolve('var(--vscode-focusBorder)') };
  const fields = {};
  for (const id of ['idea', 'repo', 'target']) {
    const el = document.getElementById(id);
    el.focus();
    await new Promise((r) => setTimeout(r, 250)); // the base sheet's own .13 s transition settles
    const cs = getComputedStyle(el);
    fields[id] = {
      placeholder: getComputedStyle(el, '::placeholder').color,
      focused: el.matches(':focus'),
      outline: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.outlineOffset].join(' '),
    };
    el.blur();
  }
  return { skin: document.documentElement.getAttribute('data-theme'), want, fields };
})()`;

suite('T-52: the Start form\'s fields in the real host, under System', function () {
  this.timeout(120_000);

  test('the placeholder is the theme\'s input.placeholderForeground and a focused field draws the 1 px focusBorder outline, inset', async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
    assert.ok(ext);
    const api = await ext.activate();
    const was = api._context.globalState.get<string>(SKIN_KEY);
    await api._context.globalState.update(SKIN_KEY, 'system');
    const screen = await Screen.open(api._context);
    try {
      await vscode.commands.executeCommand('buildTutorials.start');
      const read = screen.reader<Reading>(TITLE, READ);
      let r = await read();
      const deadline = Date.now() + 20_000;
      while (Object.values(r.fields).some((f) => !f.focused) && Date.now() < deadline) { await sleep(300); r = await read(); }
      assert.equal(r.skin, null, `the form is under System (no data-theme): ${JSON.stringify(r)}`);
      assert.notEqual(r.want.placeholder, 'rgba(0, 0, 0, 0)', `VS Code defines input.placeholderForeground here: ${JSON.stringify(r.want)}`);
      for (const [id, f] of Object.entries(r.fields)) {
        assert.equal(f.placeholder, r.want.placeholder, `#${id}: the placeholder is the theme's own: ${JSON.stringify(r)}`);
        assert.ok(f.focused, `#${id} took focus: ${JSON.stringify(f)}`);
        assert.equal(f.outline, `solid 1px ${r.want.focus} -1px`, `#${id}: the focused outline is VS Code's: ${JSON.stringify(r)}`);
      }
    } finally {
      screen.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api._context.globalState.update(SKIN_KEY, was);
    }
  });
});
