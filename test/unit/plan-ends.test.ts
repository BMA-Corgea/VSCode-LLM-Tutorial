// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-51: at the ends of the plan the step panel offers no move it cannot make (T-43's code review, F5).
 *
 * Before: at the last step *Next* stayed enabled and a press changed nothing and said nothing; *Previous* at
 * the first step the same. T-15's shape: an enabled control with no response. Now the control that cannot act
 * is DISABLED, with a sentence under the action row saying why (the narrator's own pattern at its first and
 * last stop). "Cannot act" is decided by the very functions the press would use (`prevStepId`, `nextStepId`),
 * so the page can never disable a press that would have moved, nor offer one that would not.
 */

import * as assert from 'node:assert/strict';
import { type SkinsModule } from '../../src/start/view.js';
import { setCurrent, stepDial, type PlanLike } from '../../src/walk/model.js';
import type { StepViewState } from '../../src/walk/step-protocol.js';
import { FIRST_STEP_HINT, LAST_STEP_HINT, ONLY_STEP_HINT, renderStepHtml } from '../../src/walk/step-view.js';
import { cssOf, declarationsFor } from './css-rules.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

const FAKE_SKINS: SkinsModule = {
  SKINS: [{ name: 'system', label: 'System', note: 'follow the editor' }],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

/** The page for step `id`, with the walk really standing on it (`progress.current`), as the session pushes it. */
function pageAt(id: string, plan: PlanLike = fixturePlan()): string {
  const progress = setCurrent(fixtureProgress(plan), id);
  const step = plan.steps.find((s) => s.id === id);
  assert.ok(step, `the plan has no step ${id}`);
  const state: StepViewState = { plan, progress, step, fileExists: true, dial: stepDial(progress, id), skin: 'system', transcript: [], detour: { generating: false } };
  return renderStepHtml(state, FAKE_SKINS);
}

function button(html: string, id: string): string {
  const found = new RegExp(`<button[^>]*\\sid="${id}"[^>]*>`).exec(html);
  assert.ok(found, `the page has #${id}`);
  return found[0];
}

const disabled = (tag: string): boolean => /\sdisabled(?=[\s>])/.test(tag);

/** The reason line, or null when the page has none. */
function endsHint(html: string): string | null {
  return /<p class="ends-hint" id="ends-hint">([^<]*)<\/p>/.exec(html)?.[1] ?? null;
}

suite('T-51: the step panel at the ends of the plan', () => {
  test('at the first step Previous is disabled and the panel says why; Next still moves', () => {
    const html = pageAt('st-1-shape-src');
    assert.ok(disabled(button(html, 'btn-prev')), `Previous cannot move before the first step: ${button(html, 'btn-prev')}`);
    assert.ok(!disabled(button(html, 'btn-next')), 'Next can');
    assert.equal(endsHint(html), FIRST_STEP_HINT);
  });

  test('at the last step Next is disabled and the panel says why; Previous still moves', () => {
    const html = pageAt('st-4-symbol-render');
    assert.ok(disabled(button(html, 'btn-next')), `Next cannot move past the last step: ${button(html, 'btn-next')}`);
    assert.ok(!disabled(button(html, 'btn-prev')), 'Previous can');
    assert.equal(endsHint(html), LAST_STEP_HINT);
  });

  test('between the ends both move, and there is no reason line', () => {
    for (const id of ['st-2-file-parse', 'st-3-symbol-handle']) {
      const html = pageAt(id);
      assert.ok(!disabled(button(html, 'btn-prev')) && !disabled(button(html, 'btn-next')), id);
      assert.equal(endsHint(html), null, `${id}: nothing to explain`);
    }
  });

  test('a plan of one step disables both, and says it is the only one', () => {
    const plan = fixturePlan();
    plan.steps = plan.steps.filter((s) => s.id === 'st-3-symbol-handle');
    const html = pageAt('st-3-symbol-handle', plan);
    assert.ok(disabled(button(html, 'btn-prev')) && disabled(button(html, 'btn-next')));
    assert.equal(endsHint(html), ONLY_STEP_HINT);
  });

  test('the ends follow the plan\'s order (ordinal), as the press does, not the order the plan lists its steps', () => {
    const plan = fixturePlan();
    plan.steps = [...plan.steps].reverse(); // listed last-first; their ordinals still say st-1 comes first
    const first = pageAt('st-1-shape-src', plan);
    assert.ok(disabled(button(first, 'btn-prev')) && !disabled(button(first, 'btn-next')), 'st-1 is still the first step');
    const last = pageAt('st-4-symbol-render', plan);
    assert.ok(disabled(button(last, 'btn-next')) && !disabled(button(last, 'btn-prev')), 'st-4 is still the last step');
    // T-51's review, F2: the count agrees with the moves and the ends, so "Step 4 of 4" never sits beside
    // "This is the first step of the plan".
    assert.match(first, /<p class="step-count">Step 1 of 4<\/p>/, 'the first step is counted first');
    assert.match(last, /<p class="step-count">Step 4 of 4<\/p>/, 'and the last last');
  });

  test('a disabled Next keeps its look under the pointer (the review\'s F1)', () => {
    const css = cssOf(pageAt('st-4-symbol-render'));
    const hover = declarationsFor(css, '.btn.primary[disabled]:hover');
    assert.match(hover, /background:var\(--accent-solid\)/, 'not the primary hover colour');
    assert.match(hover, /border-color:var\(--accent-solid-edge\)/);
  });
});
