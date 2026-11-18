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

/** T-110's Start half: the form's other controls, each in the container the selector names. */
const CONTROLS = ['.checkbox-field input[type=checkbox]', '.dial input[type=radio]', '.panel-foot .skinpick'];

suite('T-110: the Start form\'s checkbox, dial radios and skin picker show VS Code\'s focus outline under System', () => {
  test('under System each draws VS Code\'s 1 px focusBorder outline on :focus-visible (the base sheet\'s glow alone measured 1.30 to 1.48:1)', () => {
    const css = cssOf(startPage());
    // The offsets too, the T-52 way (review N2): 1 px outside the small controls, inset in the picker like a field.
    const offset: Record<string, string> = { '.checkbox-field input[type=checkbox]': '1px', '.dial input[type=radio]': '1px', '.panel-foot .skinpick': '-1px' };
    for (const control of CONTROLS) {
      const decls = declarationsFor(css, `${SYSTEM} ${control}:focus-visible`);
      assert.match(decls, /outline:1px solid var\(--focus\)/, `${control}: no focusBorder outline under System`);
      assert.match(decls, new RegExp(`outline-offset:${offset[control]}(;|$)`), `${control}: the offset is not ${offset[control]}: ${decls}`);
    }
  });

  test('a named skin keeps its own: no unscoped focus rule for these controls', () => {
    const css = cssOf(startPage());
    for (const control of CONTROLS) {
      assert.equal(declarationsFor(css, `${control}:focus-visible`), '', `${control}: an unscoped :focus-visible rule`);
      assert.equal(declarationsFor(css, `${control}:focus`), '', `${control}: an unscoped :focus rule`);
    }
    // And no focus rule on the page at all that a named skin would get, whatever its selector (review S1): an extra
    // `.skinpick:focus-visible` or `fieldset.dial input:focus` passed the checks above.
    const focusSelectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim())).filter((x) => x.includes(':focus'));
    assert.ok(focusSelectors.length >= 5, `the page's focus rules were not found: ${JSON.stringify(focusSelectors)}`);
    for (const selector of focusSelectors) assert.ok(selector.startsWith(`${SYSTEM} `), `a focus rule a named skin would get: ${selector}`);
  });

  test('the selectors reach exactly the checkbox, the three dial radios and the skin picker', () => {
    const html = startPage();
    assert.match(html, /<div class="field checkbox-field">\s*<label><input type="checkbox" id="recreate"/, 'the checkbox sits in .checkbox-field');
    const dial = /<fieldset class="field dial">([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? '';
    assert.equal([...dial.matchAll(/<input type="radio" name="dial"/g)].length, 3, 'the three dial radios sit in fieldset.dial');
    assert.equal([...html.matchAll(/<input type="radio"/g)].length, 3, 'and there is no other radio on the form');
    assert.match(html, /<div class="panel-foot"><select class="skinpick" id="skinpick"/, 'the skin picker sits in .panel-foot');
  });
});
