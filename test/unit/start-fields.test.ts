// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-52: the Start form's text fields read like VS Code's own inputs under System, as the tutor box already
 * does (T-43; the rules this file pins are the same shape as the box's, `test/unit/native-polish.test.ts`).
 *
 * Measured before (`.autodev/evidence/T-52/fields/`): in Dark Modern the fields' placeholder was the
 * browser's own grey, 2.82:1 on the theme's input background, where VS Code's inputs draw it in
 * `input.placeholderForeground` (4.51:1); and a focused field showed the base sheet's accent border and
 * halo with no outline, where VS Code's inputs (and the tutor box) draw a 1 px `focusBorder` outline.
 *
 * Under System only: a named skin keeps the look its own sheet gives its fields.
 *
 * The rules are read with `./css-rules.ts`, which keeps a selector's descendant spaces: the first version
 * of this file squeezed them out, and a typo that made the rules match no element still passed (T-52's
 * review, F1). The real host reads the computed result as well (`test/start-fields-screen.test.ts`).
 */

import * as assert from 'node:assert/strict';
import { renderStartHtml, type SkinsModule } from '../../src/start/view.js';
import { emptyRequest } from '../../src/start/request.js';
import { renderStepHtml } from '../../src/walk/step-view.js';
import { stepDial } from '../../src/walk/model.js';
import { cssOf, declarationsFor } from './css-rules.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

const FAKE_SKINS: SkinsModule = {
  SKINS: [
    { name: 'system', label: 'System', note: 'follow the editor' },
    { name: 'dark', label: 'Dark', note: 'always dark' },
  ],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

const FIELDS = ['.field textarea', '.field input[type=text]'];
const SYSTEM = ':root:not([data-theme])';

function startPage(): string {
  return renderStartHtml({ request: emptyRequest(), problems: {}, skin: 'system', building: false, refusedInARow: 0 }, FAKE_SKINS);
}

function tutorBoxPage(): string {
  const plan = fixturePlan();
  const progress = fixtureProgress(plan);
  const step = plan.steps.find((s) => s.id === 'st-1-shape-src')!;
  return renderStepHtml({ plan, progress, step, fileExists: true, dial: stepDial(progress, step.id), skin: 'system', transcript: [], detour: { generating: false } }, FAKE_SKINS);
}

suite('T-52: the Start form\'s fields, as VS Code draws its own inputs', () => {
  test('under System a field\'s placeholder is the theme\'s input.placeholderForeground, not the browser\'s grey', () => {
    const css = cssOf(startPage());
    for (const field of FIELDS) {
      assert.match(declarationsFor(css, `${SYSTEM} ${field}::placeholder`), /color:var\(--vscode-input-placeholderForeground,var\(--muted\)\)/,
        `${field}: the placeholder under System`);
    }
  });

  test('under System a focused field draws VS Code\'s 1 px focusBorder outline, inset so the field does not grow', () => {
    const css = cssOf(startPage());
    for (const field of FIELDS) {
      const decls = declarationsFor(css, `${SYSTEM} ${field}:focus`);
      assert.match(decls, /outline:1px solid var\(--focus\)/, `${field}: the outline`);
      assert.match(decls, /outline-offset:-1px/, `${field}: inset`);
    }
  });

  test('the same two properties as the tutor box\'s, on every field, so the inputs on this extension\'s pages match', () => {
    const box = cssOf(tutorBoxPage());
    const form = cssOf(startPage());
    const placeholder = (d: string): string | undefined => /color:([^;]+)/.exec(d)?.[1];
    const outline = (d: string): string => [/outline:([^;]+)/.exec(d)?.[1], /outline-offset:([^;]+)/.exec(d)?.[1]].join(' ');
    const boxPlaceholder = placeholder(declarationsFor(box, `${SYSTEM} .tutor-input::placeholder`));
    const boxOutline = outline(declarationsFor(box, '.tutor-input:focus'));
    assert.ok(boxPlaceholder && boxOutline.trim(), 'discriminates: the tutor box\'s own rules were found');
    for (const field of FIELDS) {
      assert.equal(placeholder(declarationsFor(form, `${SYSTEM} ${field}::placeholder`)), boxPlaceholder, `${field}: the placeholder colour`);
      assert.equal(outline(declarationsFor(form, `${SYSTEM} ${field}:focus`)), boxOutline, `${field}: the focus outline`);
    }
  });

  test('a named skin keeps its own: the new rules are all under System, none unscoped', () => {
    const css = cssOf(startPage());
    for (const field of FIELDS) {
      assert.equal(declarationsFor(css, `${field}::placeholder`), '', `${field}: no unscoped placeholder rule`);
      assert.equal(declarationsFor(css, `${field}:focus`), '', `${field}: no unscoped focus rule`);
    }
  });

  test('the selectors reach exactly the form\'s three text fields', () => {
    const html = startPage();
    const fields = [...html.matchAll(/<div class="field[^"]*">([\s\S]*?)<\/div>\s*(?=<div class="field|<fieldset|<button)/g)].map((m) => m[1]!);
    const text = fields.flatMap((f) => [...f.matchAll(/<(textarea|input type="text")[^>]*\sid="([a-z]+)"/g)].map((m) => m[2]));
    assert.deepEqual(text.sort(), ['idea', 'repo', 'target'], 'each text field sits in a .field');
    assert.ok(!/<input type="text"(?![^>]*id="(repo|target)")/.test(html), 'and there is no other text input on the form');
  });
});
