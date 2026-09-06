// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/walk/step-view.ts — pure (no `vscode`). Two different senses of "DOM assertion" for
 * AC2/AC5, the same split `test/unit/start-view.test.ts` established for the start screen,
 * because the two halves catch different bugs:
 *
 *   1. **The SERVER-rendered markup.** Does the page put the right source label under `why`,
 *      the verbatim "no history to show" line where a witness is missing, and an honest
 *      reason beside a disabled *Open the file* rather than a bare `disabled` — and does it
 *      escape every last plan-sourced string on the way. The one this ticket is most
 *      particular about is asserted STRUCTURALLY: the options list holds no `<button>` and
 *      no `<input>` at all, so "the alternatives are not selectable" is a fact about what
 *      exists rather than about an attribute one accident could remove.
 *   2. **The REAL client script, executed** against a minimal hand-built fake DOM — no
 *      jsdom, just enough `document`/`window`/`acquireVsCodeApi` for this one script. Does
 *      the SHIPPED code actually post anything when a button is clicked, and actually write
 *      an inbound `step:note` into the note node? That is the repo-tour T-3 lesson this
 *      whole guard exists for — a script that parses fine and does nothing — and no amount
 *      of markup assertion can see it. Every message the script posts is then fed to the
 *      REAL `parseStepMessage`, so a drift between what the view sends and what the host
 *      accepts fails here rather than silently, in a webview, at run time.
 *   3. **The review's fixes, asserted as behaviour rather than as code.** The two render caps
 *      (security finding 3), the total lookups (security finding 5) and the author's-choice
 *      fallback (code review, finding 6) each get a suite of their own below. Every one
 *      asserts against a constant `step-view.ts` EXPORTS — `MAX_OPTIONS_RENDERED`,
 *      `MAX_PLAN_TEXT`, `TRUNCATION_MARKER`, `optionsOmittedMessage`,
 *      `UNKNOWN_WHY_SOURCE_MESSAGE`, `NOT_TEXT_MESSAGE` — or `model.ts`'s own
 *      `FALLBACK_DIAL`, never a copy of the value, so retuning a cap moves these tests with
 *      it while DELETING one fails them. A cap is asserted twice over on purpose: that the
 *      output shrank, AND that the page says what it left out. A cap that silently swallowed
 *      content would pass the first assertion on its own, and it would be the wrong fix.
 *
 * The script under test is lifted out of `renderStepHtml`'s own output, never from
 * `stepScript()` alone: `post`/`restore`/`save` come from `src/webview/page.ts`'s bootstrap,
 * which `renderPage` prepends, so `stepScript()` on its own would throw the moment a handler
 * fired. One test pins that the two are the same text, so the harness cannot end up
 * exercising a script the page does not ship.
 *
 * A fake skins module stands in for repo-tour's real one so this suite never touches it.
 */

import * as assert from 'node:assert/strict';
import { DIALS } from '../../src/start/request.js';
import { type SkinsModule } from '../../src/start/view.js';
import type { CheckReport } from '../../src/dial/core.js';
import { FALLBACK_DIAL, stepDial, type OptionLike, type PlanLike, type StepLike } from '../../src/walk/model.js';
import { parseStepMessage, type StepViewState } from '../../src/walk/step-protocol.js';
import {
  AUTHOR_BADGE, CHECK_HEADING, CHECK_PARSE_MESSAGE, EXPORTS_HEADING, FILE_MISSING_MESSAGE,
  IMPORTS_HEADING, SHAPE_HEADING,
  MAX_CHECK_TEXT, MAX_LIST_ROWS, MAX_OPTIONS_RENDERED, MAX_PLAN_TEXT, NOT_TEXT_MESSAGE,
  NO_HISTORY_MESSAGE, REPRODUCE_BUTTON_LABEL, SHAPE_EMPTY_MESSAGE, SHAPE_NOTE_MESSAGE, T10_BADGE,
  TRUNCATION_MARKER, UNKNOWN_CHECK_STATUS_MESSAGE, UNKNOWN_WHY_SOURCE_MESSAGE, listOmittedMessage,
  optionsOmittedMessage, renderNoticeHtml, renderStepHtml, reproduceOfferMessage, stepRenderKey,
  stepScript,
} from '../../src/walk/step-view.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

/** A note the host might send — any sentence at all. T-4's tests used `A_NOTE` for this,
 *  which T-5 deleted along with the placeholder reply it named; the note CHANNEL is what these
 *  tests are about, not whichever message happens to feed it, so a local string is the honest
 *  stand-in and cannot go stale the same way. */
const A_NOTE = 'a sentence the host put on the page';

const FAKE_SKINS: SkinsModule = {
  SKINS: [
    { name: 'system', label: 'System', note: 'follow the editor' },
    { name: 'dark', label: 'Dark', note: 'always dark' },
  ],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

/**
 * The three lines the TICKET pins, written out here rather than imported: `step-view.ts`
 * keeps its map unexported on purpose, and a test that imported it would only prove the
 * file agrees with itself. These are the words the spec asks for.
 */
const SOURCE_LABEL = {
  interpret: 'from the model, reading the code',
  docstring: "from the author's own comment",
  none: 'not inferable from the source',
};

function planStep(plan: PlanLike, id: string): StepLike {
  const step = plan.steps.find((s) => s.id === id);
  assert.ok(step, `the fixture plan has no step ${id}`);
  return step;
}

/**
 * The exact state the real panel hands the view: the current step already resolved, and the
 * DIAL already resolved too (AC1) — through `model.ts`'s own `stepDial`, the same function
 * `WalkSession.refresh` calls, so this fixture cannot disagree with what a real push carries.
 */
function stateAt(id: string, overrides: Partial<StepViewState> = {}): StepViewState {
  const plan = fixturePlan();
  const progress = fixtureProgress(plan);
  return {
    plan, progress, step: planStep(plan, id), fileExists: true,
    dial: stepDial(progress, id), skin: 'system', ...overrides,
  };
}

/** The three replacements `src/webview/html.ts` makes, written out here rather than imported:
 *  a test that reused the implementation would only prove the file agrees with itself. */
function escapeForHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A whole page with the per-render nonce blanked, so two renders of the SAME state compare
 *  equal — `renderPage` mints a fresh one every call, which is the entire reason
 *  `step-panel.ts` cannot rely on VS Code's identical-html short-circuit. */
function pageWithoutNonce(html: string): string {
  return html.replace(/nonce="[^"]*"/g, 'nonce=""').replace(/'nonce-[^']*'/g, "'nonce-'");
}

/** The `<li>` rows of one `<ul class="check-list">` — the first is Exports, the second
 *  Imports, in the order `checkHtml` emits them. */
function checkLists(html: string): string[] {
  return [...html.matchAll(/<ul class="check-list">([\s\S]*?)<\/ul>/g)].map((m) => m[1]!);
}

/** Every check row as (status, name) — enough to say WHICH symbols were called what. */
function checkRows(list: string): Array<{ status: string; name: string }> {
  return [...list.matchAll(/<span class="check-status">([^<]*)<\/span><code class="check-name">([^<]*)<\/code>/g)]
    .map((m) => ({ status: m[1]!, name: m[2]! }));
}

/** A `CheckReport` with only the fields a test cares about spelled out. */
function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return { symbols: [], imports: [], parseErrors: 0, ok: true, ...overrides };
}

/** The text inside one of the page's single-purpose paragraphs, so a test can assert what
 *  the line SAYS rather than merely that the phrase occurs somewhere on the page. */
function paragraph(html: string, cls: string): string {
  const found = new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`).exec(html);
  assert.ok(found, `the page should render a .${cls} paragraph`);
  return found[1]!;
}

/** Just the `<ul class="options">…</ul>` slice — the region that must contain nothing
 *  selectable, asserted separately from the four action buttons further down the page. */
function optionsList(html: string): string {
  const found = /<ul class="options">[\s\S]*?<\/ul>/.exec(html);
  assert.ok(found, 'the page should render an options list');
  return found[0];
}

function occurrences(html: string, needle: RegExp): number {
  return [...html.matchAll(needle)].length;
}

/**
 * A plan field set to something its own TYPE forbids.
 *
 * The cast is not the test cheating — it is the test reproducing what the compiler cannot
 * see. `plan.json` is `JSON.parse`d and cast to `PlanLike`; nothing validates its shape (T-4
 * security review, finding 5's sibling), so at run time every one of these fields holds
 * whatever a third-party repo's plan file said. `tsc` believes `whySource` is one of three
 * strings for exactly the same reason the bug shipped.
 */
function poison<T>(value: unknown): T {
  return value as T;
}

/** The `<li …>` rows of the options list, as (class, id) pairs — enough to say WHICH option
 *  the page marked, not merely how many it marked. */
function optionRows(html: string): Array<{ cls: string; id: string }> {
  return [...optionsList(html).matchAll(/<li class="(option option-\w+)" data-option-id="([^"]*)"/g)]
    .map((m) => ({ cls: m[1]!, id: m[2]! }));
}

/** The text of one option's label span, in row order. */
function optionLabels(html: string): string[] {
  return [...optionsList(html).matchAll(/<span class="option-label">([\s\S]*?)<\/span>/g)].map((m) => m[1]!);
}

/** `count` options that all share ONE long string. Shared on purpose: JS strings are
 *  immutable and passed by reference, so a hostile-sized plan costs kilobytes to BUILD here
 *  while still being megabytes to RENDER — which is the asymmetry the cap exists for, and the
 *  only reason this test can hold a 5,000-option plan in memory at all. */
function floodOptions(count: number, text: string): OptionLike[] {
  return Array.from({ length: count }, (_, i) => ({ id: `alt-${i}`, label: text, consequence: text, taken: false }));
}

suite('renderStepHtml — markup-level DOM assertions (AC2)', () => {
  test("whySource 'none' names its source as 'not inferable from the source'", () => {
    const html = renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS);
    assert.equal(paragraph(html, 'why-source'), SOURCE_LABEL.none);
    // The `why` text itself reads the same sentence here — repo-tour's own value for an
    // uninterpreted step IS that line. Documented as correct, so both are asserted rather
    // than one being "fixed" away.
    assert.equal(paragraph(html, 'why-text'), 'not inferable from the source');
  });

  test("whySource 'interpret' names its source as 'from the model, reading the code'", () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    assert.equal(paragraph(html, 'why-source'), SOURCE_LABEL.interpret);
    assert.ok(!html.includes(SOURCE_LABEL.docstring), 'no other source label leaks onto the page');
  });

  test("whySource 'docstring' names its source as \"from the author's own comment\"", () => {
    const html = renderStepHtml(stateAt('st-3-symbol-handle'), FAKE_SKINS);
    assert.equal(paragraph(html, 'why-source'), SOURCE_LABEL.docstring);
    assert.ok(!html.includes(SOURCE_LABEL.interpret), 'no other source label leaks onto the page');
  });

  test('a null witness renders the verbatim NO_HISTORY_MESSAGE, not an empty line', () => {
    const html = renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS);
    assert.equal(paragraph(html, 'witness-text'), NO_HISTORY_MESSAGE);
  });

  test('a real witness renders the commit subject, its SHORT sha and its date', () => {
    const state = stateAt('st-2-file-parse');
    const witness = state.step.witness;
    const text = paragraph(renderStepHtml(state, FAKE_SKINS), 'witness-text');

    assert.ok(text.includes(witness.subject!), 'the commit subject');
    assert.ok(text.includes(witness.sha!.slice(0, 7)), 'the short sha');
    assert.ok(!text.includes(witness.sha!), 'the full sha is never dumped into a narrow sidebar');
    assert.ok(text.includes(witness.date!), 'the date');
    assert.ok(!text.includes(NO_HISTORY_MESSAGE), 'a step WITH history never says it has none');
  });

  test('fileExists false disables "Open the file" AND says why, in the hint beside it', () => {
    const html = renderStepHtml(stateAt('st-4-symbol-render', { fileExists: false }), FAKE_SKINS);
    assert.match(html, /<button type="button" class="btn" id="btn-open" disabled>Open the file<\/button>/);
    // A disabled control with no explanation is exactly what this repo's house rule forbids,
    // so the reason is asserted in the same test as the disabling — they are one behaviour.
    assert.match(html, new RegExp(`<span class="hint" id="open-hint">${FILE_MISSING_MESSAGE}</span>`));
  });

  test('fileExists true leaves the button live and the hint present but EMPTY', () => {
    const html = renderStepHtml(stateAt('st-4-symbol-render', { fileExists: true }), FAKE_SKINS);
    assert.match(html, /<button type="button" class="btn" id="btn-open">Open the file<\/button>/);
    assert.ok(!html.includes('id="btn-open" disabled'), 'nothing disables a button whose file exists');
    // Present-but-empty, never created or removed by the client — `problemDiv`'s pattern.
    assert.match(html, /<span class="hint" id="open-hint"><\/span>/);
    assert.ok(!html.includes(FILE_MISSING_MESSAGE), 'and it does not claim a missing file');
  });

  test('the alternatives are not selectable — nothing in the options list to select at all', () => {
    const state = stateAt('st-4-symbol-render'); // three options: one taken, two alternatives
    const html = renderStepHtml(state, FAKE_SKINS);
    const list = optionsList(html);
    const alternatives = state.step.decision.options.filter((o) => !o.taken);
    assert.equal(alternatives.length, 2, 'the fixture step this test needs has two alternatives');

    for (const alt of alternatives) {
      assert.ok(list.includes(alt.label), `the alternative "${alt.label}" is still SHOWN`);
      assert.ok(list.includes(alt.consequence), 'with its consequence');
    }
    assert.equal(occurrences(list, new RegExp(T10_BADGE, 'g')), alternatives.length, 'every alternative is badged, where the eye is');

    // The guarantee itself: not a `disabled` attribute, which a later edit could drop by
    // accident, but the absence of anything to click.
    assert.ok(!/<button/i.test(list), 'no <button> anywhere inside the options list');
    assert.ok(!/<input/i.test(list), 'no <input> anywhere inside the options list');

    // …and page-wide, so a control cannot hide just outside the <ul>: the only buttons on
    // this page are the four actions, and the only inputs are the dial's three radios.
    assert.equal(occurrences(html, /<button/g), 4, 'Previous, Open the file, Check my work, Next — and nothing else');
    assert.equal(occurrences(html, /<input/g), 3, 'the three dial radios — and nothing else');

    // T-5's reproduce offer is the ONLY thing that adds a fifth button, and it still adds
    // nothing to the options list — the alternatives stay unselectable whatever else the page
    // grows (the page-wide count is asserted here so a stray control cannot hide behind it).
    const withOffer = renderStepHtml(stateAt('st-4-symbol-render', { reproduce: { count: 3, done: false } }), FAKE_SKINS);
    assert.equal(occurrences(withOffer, /<button/g), 5, 'the four actions plus Copy them in');
    assert.equal(occurrences(withOffer, /<input/g), 3, 'and still only the dial radios');
    assert.ok(!/<button/i.test(optionsList(withOffer)), 'and nothing selectable moved into the options list');
  });

  test('the dial renders exactly three radios with the step\'s own override checked', () => {
    // fixtureProgress drags step 2's dial to `scaffolded`, and `stateAt` resolves it the way
    // the session does — so this asserts the whole path, not the view agreeing with itself.
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    assert.equal(occurrences(html, /<input type="radio" name="dial"/g), 3, 'exactly three dial positions');
    assert.match(html, /id="dial-scaffolded" value="scaffolded" checked>/);
    assert.equal(occurrences(html, / checked>/g), 1, 'one position checked, never two');
  });

  test('every dial position renders, one checked, with its own label (AC1)', () => {
    const LABEL = { manual: "I'll type it", scaffolded: 'Scaffold it for me', automated: 'Watch me build it' };
    for (const dial of DIALS) {
      const html = renderStepHtml(stateAt('st-2-file-parse', { dial }), FAKE_SKINS);
      assert.match(html, new RegExp(`id="dial-${dial}" value="${dial}" checked>`), `${dial} is the checked position`);
      assert.equal(occurrences(html, / checked>/g), 1, `${dial}: one position checked, never two`);
      for (const [name, label] of Object.entries(LABEL)) {
        assert.ok(html.includes(label), `${dial}: the ${name} position is still offered, by its own label`);
      }
    }
  });

  test('the GLOBAL dial reaches the page for a step with no override of its own (AC1)', () => {
    // The half T-4 could not show. `st-4-symbol-render` has no progress entry at all, so the
    // old panel — which read `progress.steps[id].dial` and nothing else — checked `manual` at
    // a learner whose start screen said `automated`, on a walk that was writing whole files.
    const html = renderStepHtml(stateAt('st-4-symbol-render', { dial: 'automated' }), FAKE_SKINS);
    assert.match(html, /id="dial-automated" value="automated" checked>/);
    assert.equal(occurrences(html, / checked>/g), 1);
  });

  test('a step with no dial recorded anywhere falls back to manual — both "no override" shapes', () => {
    // st-1 HAS a progress entry (it is marked done) but no `dial` on it; st-4 has no entry
    // at all. Both mean "nothing has been done to this step", and manual is the one label
    // that cannot overstate that. `stateAt` runs the real resolution, so this pins the
    // session's fallback and the page's rendering of it together.
    for (const id of ['st-1-shape-src', 'st-4-symbol-render']) {
      const html = renderStepHtml(stateAt(id), FAKE_SKINS);
      assert.match(html, /id="dial-manual" value="manual" checked>/, `${id} should fall back to manual`);
      assert.equal(occurrences(html, / checked>/g), 1, `${id}: one position checked`);
    }
  });

  test('every plan-sourced string is escaped — question, label, consequence, why and the ids', () => {
    const state = stateAt('st-4-symbol-render');
    const step = state.step;
    step.id = 'st-4" onclick="alert(1)';
    step.decision.question = '<script>alert("q")</script> & then?';
    step.decision.why = 'Because <script>alert("w")</script>';
    step.decision.options[0]!.label = '<script>alert("l")</script>';
    step.decision.options[1]!.consequence = 'Tom & Jerry <script>alert("c")</script>';
    step.decision.options[1]!.id = 'alt" onclick="alert(1)';

    const html = renderStepHtml(state, FAKE_SKINS);

    // The page ships exactly one script tag: its own. Nothing a plan carried became a second.
    assert.equal(occurrences(html, /<script/g), 1, 'no plan text opened a script tag');
    assert.equal(occurrences(html, /<\/script>/g), 1);
    for (const raw of ['<script>alert("q")</script>', '<script>alert("w")</script>', '<script>alert("l")</script>', '<script>alert("c")</script>']) {
      assert.ok(!html.includes(raw), `raw markup landed on the page: ${raw}`);
    }
    // Escaped, not silently dropped — the learner still SEES what the plan said.
    assert.ok(html.includes('&lt;script&gt;alert("q")&lt;/script&gt; &amp; then?'), 'the question is shown, escaped');
    assert.ok(html.includes('Tom &amp; Jerry &lt;script&gt;alert("c")&lt;/script&gt;'), 'the consequence is shown, escaped');
    assert.ok(!html.includes('Tom & Jerry'), 'a bare ampersand never survives into the markup');

    // Attributes: a quote in an id closes nothing and starts no handler.
    assert.ok(!/ onclick="/.test(html), 'no live event-handler attribute was forged');
    assert.ok(html.includes('data-step-id="st-4&quot; onclick=&quot;alert(1)"'), 'the step id stays inside its attribute');
    assert.ok(html.includes('data-option-id="alt&quot; onclick=&quot;alert(1)"'), 'the option id stays inside its attribute');
  });

  test('the author badge is SUPPRESSED when the label already says it (no stutter)', () => {
    // Every step of a plan built with no interpretation looks exactly like this: one option,
    // labelled by repo-tour itself with the same words the badge would add.
    const state = stateAt('st-1-shape-src');
    assert.equal(state.step.decision.options[0]!.label, AUTHOR_BADGE, 'the fixture this test needs');

    const list = optionsList(renderStepHtml(state, FAKE_SKINS));
    assert.ok(!list.includes('badge-taken'), 'no badge element is emitted at all');
    assert.equal(occurrences(list, new RegExp(AUTHOR_BADGE, 'g')), 1, 'the phrase appears once — as the label, not twice');
    // The author's choice is still marked, by the row itself.
    assert.ok(list.includes('option option-taken'), 'the taken option keeps its distinct class');
  });

  test('the author badge IS emitted when the option label says something else', () => {
    const state = stateAt('st-2-file-parse');
    state.step.decision.options[0]!.label = 'Split the tokenizer into its own module';

    const list = optionsList(renderStepHtml(state, FAKE_SKINS));
    assert.ok(list.includes(`<span class="badge badge-taken">${AUTHOR_BADGE}</span>`), 'the badge comes back');
    assert.ok(list.includes('Split the tokenizer into its own module'), 'beside the plan\'s own label');
    assert.equal(occurrences(list, new RegExp(T10_BADGE, 'g')), 1, 'and the one alternative is still badged for T-10');
  });

  test('the page renders the question and all four actions AC2 names', () => {
    const state = stateAt('st-3-symbol-handle');
    const html = renderStepHtml(state, FAKE_SKINS);
    assert.match(html, new RegExp(`<h1>${state.step.decision.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`));
    assert.match(html, /id="btn-prev">Previous<\/button>/);
    assert.match(html, /id="btn-open">Open the file<\/button>/);
    assert.match(html, /id="btn-check">Check my work<\/button>/);
    assert.match(html, /id="btn-next">Next<\/button>/);
    assert.match(html, /<select class="skinpick" id="skinpick"/, 'the skin picker rides along on this page too');
  });

  test('renderNoticeHtml says its sentence — and needs no skins module to do it', () => {
    const html = renderNoticeHtml('No tutorial in this folder yet.');
    assert.match(html, /<main class="notice-only"><p class="notice">No tutorial in this folder yet\.<\/p><\/main>/);
    // The "core is missing" case is exactly the case with no SkinsModule to pass, so this
    // page is deliberately unskinned: no data-theme, and no repo-tour CSS inlined.
    // (`data-theme` occurs in the bridge sheet's own selectors, so this asserts the <html>
    // TAG, not the absence of the string.)
    assert.match(html, /<html lang="en">/, 'the notice page stamps no theme on <html>');
    assert.ok(!html.includes('--bg:#fff'), 'and inlines none of repo-tour\'s own sheet');
    assert.ok(html.includes('<!doctype html>'), 'it is still a whole page, not a fragment');
  });

  test('renderNoticeHtml escapes the sentence it is handed', () => {
    const html = renderNoticeHtml('<script>alert(1)</script> & co');
    assert.equal(occurrences(html, /<script/g), 1);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co'));
  });
});

suite('renderStepHtml — a hostile plan renders BOUNDED, and says what it left out (security finding 3)', () => {
  test('a 5,001-option plan draws MAX_OPTIONS_RENDERED rows and counts the rest, accurately', () => {
    const state = stateAt('st-2-file-parse');
    const author = { id: 'author', label: 'What the author actually did', consequence: 'the real one', taken: true };
    const flood = floodOptions(5000, 'an alternative an injected docstring talked the model into');
    state.step.decision.options = [author, ...flood];

    const html = renderStepHtml(state, FAKE_SKINS);
    const drawn = occurrences(optionsList(html), /<li /g);
    assert.equal(drawn, MAX_OPTIONS_RENDERED, 'the list stops at the cap');

    // The half that makes the cap honest rather than a silent swallow: the page SAYS how many
    // it is not showing, and the number is right — rows drawn plus rows announced is the plan.
    const omitted = state.step.decision.options.length - MAX_OPTIONS_RENDERED;
    assert.equal(paragraph(html, 'options-omitted'), optionsOmittedMessage(omitted));
    assert.equal(drawn + omitted, state.step.decision.options.length, 'the count on the page adds up');
    assert.ok(paragraph(html, 'options-omitted').startsWith(String(omitted)), 'and it leads with the number');
  });

  test('the omitted line counts in the singular when exactly one option is left out', () => {
    const state = stateAt('st-2-file-parse');
    state.step.decision.options = floodOptions(MAX_OPTIONS_RENDERED + 1, 'one too many');

    const html = renderStepHtml(state, FAKE_SKINS);
    assert.equal(paragraph(html, 'options-omitted'), optionsOmittedMessage(1));
    assert.ok(!paragraph(html, 'options-omitted').includes('options'), 'one option, not "1 more options"');
  });

  test('a plan whose strings are gigantic renders a page bounded BY THE CAPS, not by the plan', () => {
    // Unbounded, this is the render that hangs the window: `webview.html = ...` is synchronous
    // on the extension host, and 5,000 options of 40,000 characters each is ~400 MB of markup.
    const long = 'x'.repeat(MAX_PLAN_TEXT * 2);
    const state = stateAt('st-2-file-parse');
    state.step.decision.options = floodOptions(5000, long);

    const chrome = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS).length; // CSS, script, the rest of the body
    const perOption = 2 * (MAX_PLAN_TEXT + TRUNCATION_MARKER.length) + 500;       // two capped strings and its own tags
    const uncapped = state.step.decision.options.length * 2 * long.length;        // what this plan used to render
    const html = renderStepHtml(state, FAKE_SKINS);

    assert.ok(html.length < chrome + MAX_OPTIONS_RENDERED * perOption,
      `the page is bounded by the caps (${html.length} bytes)`);
    assert.ok(html.length < uncapped / 100,
      `and by two orders of magnitude less than the ${Math.round(uncapped / 1e6)} MB this plan used to build`);
  });

  test('a string past MAX_PLAN_TEXT is cut with a VISIBLE marker, never silently shortened', () => {
    const state = stateAt('st-2-file-parse');
    const why = `${'w'.repeat(MAX_PLAN_TEXT)}THIS TAIL IS PAST THE CAP`;
    state.step.decision.why = why;

    const text = paragraph(renderStepHtml(state, FAKE_SKINS), 'why-text');
    assert.equal(text.slice(0, MAX_PLAN_TEXT), why.slice(0, MAX_PLAN_TEXT), 'everything up to the cap is shown');
    assert.ok(text.endsWith(TRUNCATION_MARKER), 'and the cut is admitted where it happened');
    assert.equal(text.length, MAX_PLAN_TEXT + TRUNCATION_MARKER.length);
    assert.ok(!text.includes('THIS TAIL IS PAST THE CAP'));
  });

  test('a string exactly AT the cap is left whole — the boundary is not off by one', () => {
    const state = stateAt('st-2-file-parse');
    state.step.decision.why = 'w'.repeat(MAX_PLAN_TEXT);

    const html = renderStepHtml(state, FAKE_SKINS);
    assert.equal(paragraph(html, 'why-text').length, MAX_PLAN_TEXT);
    assert.ok(!html.includes(TRUNCATION_MARKER), 'nothing was cut, so nothing claims it was');
  });

  test('the cap reaches every plan-sourced string on the page, not only `why`', () => {
    const long = 'y'.repeat(MAX_PLAN_TEXT + 200);
    const state = stateAt('st-2-file-parse');
    state.step.decision.question = long;
    state.step.decision.options[0]!.label = long;
    state.step.decision.options[0]!.consequence = long;
    state.step.witness = { sha: 'abc1234def', date: '2026-08-14T09:12:03Z', subject: long };

    const html = renderStepHtml(state, FAKE_SKINS);
    // Four cuts, four markers — question, label, consequence, witness subject.
    assert.equal(occurrences(html, new RegExp(TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 4);
    assert.ok(optionLabels(html)[0]!.endsWith(TRUNCATION_MARKER), 'the option label is cut and says so');
    assert.ok(paragraph(html, 'witness-text').includes(TRUNCATION_MARKER), 'so is a very long commit subject');
  });

  test('NEITHER cap can fire on a real plan — the whole fixture renders untouched', () => {
    // The point of the numbers. The fixture is schema-validated against repo-tour's REAL
    // build-plan schema in walk-model.test.ts, so "under the cap" here is a claim about a
    // legitimate plan, not about a convenient one.
    const plan = fixturePlan();
    for (const step of plan.steps) {
      assert.ok(step.decision.options.length <= MAX_OPTIONS_RENDERED, `${step.id}: option count is under the cap`);
      const strings = [
        step.decision.question, step.decision.why,
        ...step.decision.options.flatMap((o) => [o.label, o.consequence]),
      ];
      for (const s of strings) assert.ok(s.length <= MAX_PLAN_TEXT, `${step.id}: "${s.slice(0, 40)}…" is under the cap`);

      const html = renderStepHtml(stateAt(step.id), FAKE_SKINS);
      assert.ok(!html.includes(TRUNCATION_MARKER), `${step.id} renders with nothing cut`);
      assert.ok(!html.includes('<p class="options-omitted">'), `${step.id} renders with nothing left out`);
    }

    // And the margin is not incidental. repo-tour's interpreter prompt asks for "exactly two
    // OTHER reasonable ways" beside the author's own option, so THREE is the most options a
    // legitimate plan carries (the real 61-step sql-gauntlet plan carries one, on every step).
    assert.ok(MAX_OPTIONS_RENDERED >= 3 * 4, 'four times the widest legitimate step, at least');
    // The longest string a plan can honestly carry is a docstring. Across the 621 doc comments
    // in the three repos on hand the median is 146 characters and the longest — step-view.ts's
    // own header — is 5,121; repo-tour's only clamp on anything, SUMMARY_MAX, is 400.
    const LONGEST_REAL_DOC_COMMENT = 5121;
    assert.ok(MAX_PLAN_TEXT > LONGEST_REAL_DOC_COMMENT * 2, 'twice the longest real doc comment, at least');
  });
});

suite('renderStepHtml — every plan lookup is TOTAL: no throw from a render nobody hears (security finding 5)', () => {
  test('an unrecognised whySource says so out loud — including the Object.prototype names', () => {
    // `'constructor'`, `'toString'` and `'__proto__'` are the sharp ones: a plain index does
    // not return `undefined` for them, it returns an inherited FUNCTION or OBJECT, which then
    // reaches `escapeHtml` and throws `.replace is not a function` — inside a promise the
    // activation path voids, so the panel simply never appears and nobody is told why.
    for (const source of ['nonsense', 'constructor', 'toString', '__proto__', 'valueOf', '', 42, null, undefined, {}]) {
      const state = stateAt('st-2-file-parse');
      state.step.decision.whySource = poison(source);

      let html = '';
      assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); }, `whySource ${JSON.stringify(source)} threw`);
      assert.equal(paragraph(html, 'why-source'), UNKNOWN_WHY_SOURCE_MESSAGE, `whySource ${JSON.stringify(source)}`);
    }
  });

  test('the three real sources are unaffected — the fallback is a fallback, not a replacement', () => {
    // Guards against "fixing" the lookup by making it always answer the honest line.
    assert.equal(paragraph(renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS), 'why-source'), SOURCE_LABEL.interpret);
    assert.equal(paragraph(renderStepHtml(stateAt('st-3-symbol-handle'), FAKE_SKINS), 'why-source'), SOURCE_LABEL.docstring);
    assert.equal(paragraph(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS), 'why-source'), SOURCE_LABEL.none);
  });

  test('a plan whose strings are not strings renders NOT_TEXT_MESSAGE, never a throw', () => {
    const state = stateAt('st-4-symbol-render');
    state.step.decision.question = poison(null);
    state.step.decision.why = poison(42);
    state.step.decision.options[0]!.label = poison(undefined);
    state.step.decision.options[1]!.consequence = poison({ toString: () => 'not a string' });

    let html = '';
    assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); });
    assert.ok(html.includes(`<h1>${NOT_TEXT_MESSAGE}</h1>`), 'the question');
    assert.equal(paragraph(html, 'why-text'), NOT_TEXT_MESSAGE, 'the why');
    assert.equal(optionLabels(html)[0], NOT_TEXT_MESSAGE, 'an option label — this one used to throw on `.trim()`');
    assert.ok(optionsList(html).includes(`<p class="option-consequence">${NOT_TEXT_MESSAGE}</p>`), 'a consequence');
    assert.ok(!html.includes('>undefined<'), 'and never the word "undefined" dressed up as the plan\'s own text');
  });

  test('an id that is not a string becomes an EMPTY attribute, not an invented key', () => {
    const state = stateAt('st-4-symbol-render');
    state.step.id = poison(undefined);
    state.step.decision.options[0]!.id = poison(7);

    let html = '';
    assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); });
    assert.ok(html.includes('<main id="step-main" data-step-id="">'), 'no id is no id');
    assert.equal(optionRows(html)[0]!.id, '', 'and an option with no usable id carries none');
  });

  test('a witness whose sha is not a usable string falls back to NO_HISTORY_MESSAGE', () => {
    // `.slice(0, 7)` on a number or an object is the throw; a witness with no usable sha has
    // nothing to show, which is the sentence this page already has for exactly that case.
    for (const sha of [42, {}, [], true, '']) {
      const state = stateAt('st-2-file-parse');
      state.step.witness = poison({ sha, date: '2026-08-14T09:12:03Z', subject: 'a subject' });

      let html = '';
      assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); }, `sha ${JSON.stringify(sha)} threw`);
      assert.equal(paragraph(html, 'witness-text'), NO_HISTORY_MESSAGE);
    }
  });

  test('a witness with a non-string subject or date still renders one honest sentence', () => {
    const state = stateAt('st-2-file-parse');
    state.step.witness = poison({ sha: 'abc1234def5678', date: 99, subject: { nope: true } });

    let html = '';
    assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); });
    const text = paragraph(html, 'witness-text');
    assert.ok(text.includes('abc1234'), 'the short sha it really does have');
    assert.ok(text.includes(NOT_TEXT_MESSAGE), 'and an honest placeholder where the plan had no text');
    assert.ok(!text.includes('[object Object]'), 'never a coerced object');
  });

  test('a dial value nothing recognises checks FALLBACK_DIAL rather than leaving the fieldset blank', () => {
    // The value now arrives already resolved from the session — but it has still travelled
    // through `progress.json` AND `request.json`, both `JSON.parse`d and cast, so a fourth
    // position is a value this page can really be handed. A fieldset with nothing checked
    // says nothing at all, and says it silently.
    for (const dial of ['turbo', '', 'MANUAL', 42, null, undefined, {}, ['manual']]) {
      const state = stateAt('st-2-file-parse', { dial: poison(dial) });

      let html = '';
      assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); }, `dial ${JSON.stringify(dial)} threw`);
      assert.equal(occurrences(html, / checked>/g), 1, `dial ${JSON.stringify(dial)}: one position checked, never none`);
      assert.match(html, new RegExp(`id="dial-${FALLBACK_DIAL}" value="${FALLBACK_DIAL}" checked>`));
    }
    assert.ok(!renderStepHtml(stateAt('st-2-file-parse', { dial: poison('turbo') }), FAKE_SKINS).includes('turbo'),
      'and the invented value is not echoed back as though it were a position');
  });

  test('the fallback dial is model.ts\'s exported constant — the local copy is gone', () => {
    // T-4 code review, the quality row: `FALLBACK_DIAL` was duplicated between model.ts and
    // step-view.ts, both inside this ticket's own boundary. Asserted against the EXPORT, so a
    // change to model.ts moves this test with the page rather than leaving the two disagreeing.
    const html = renderStepHtml(stateAt('st-4-symbol-render'), FAKE_SKINS);
    assert.match(html, new RegExp(`id="dial-${FALLBACK_DIAL}" value="${FALLBACK_DIAL}" checked>`));
    assert.equal(occurrences(html, / checked>/g), 1);
  });
});

suite("renderStepHtml — the author's choice is marked from `taken` OR `authorChoice` (code review, finding 6)", () => {
  test('a plan with no `taken` anywhere still marks exactly one option — the one authorChoice names', () => {
    // Version skew, or a hand-edited plan. Without the fallback nothing is marked, every
    // option wears a "coming with T-10" badge, and AC2 is silently unmet on a page that
    // otherwise looks perfectly fine.
    const state = stateAt('st-4-symbol-render');
    const options = state.step.decision.options;
    assert.equal(options.length, 3, 'the fixture step this test needs');
    for (const opt of options) opt.taken = false;
    state.step.decision.authorChoice = options[1]!.id;

    const rows = optionRows(renderStepHtml(state, FAKE_SKINS));
    const marked = rows.filter((r) => r.cls === 'option option-taken');
    assert.equal(marked.length, 1, 'exactly one option is marked');
    assert.equal(marked[0]!.id, options[1]!.id, 'and it is the one the plan named');
    assert.equal(occurrences(optionsList(renderStepHtml(state, FAKE_SKINS)), new RegExp(T10_BADGE, 'g')), 2,
      'the other two are still badged for T-10');
  });

  test('`taken` wins when the two fields disagree — one row marked, never two', () => {
    const state = stateAt('st-4-symbol-render');
    const options = state.step.decision.options;
    assert.equal(options.filter((o) => o.taken).length, 1, 'the fixture has exactly one taken option');
    state.step.decision.authorChoice = options[2]!.id; // points somewhere else entirely

    const rows = optionRows(renderStepHtml(state, FAKE_SKINS));
    const marked = rows.filter((r) => r.cls === 'option option-taken');
    assert.equal(marked.length, 1, 'the fallback never marks a SECOND option');
    assert.equal(marked[0]!.id, options[0]!.id, '`taken` is still what a real plan is read by');
  });

  test('an authorChoice that names no option marks nothing — the page does not guess', () => {
    const state = stateAt('st-4-symbol-render');
    for (const opt of state.step.decision.options) opt.taken = false;
    state.step.decision.authorChoice = 'an-option-this-plan-does-not-contain';

    const list = optionsList(renderStepHtml(state, FAKE_SKINS));
    assert.equal(occurrences(list, /option option-taken/g), 0, 'marking an arbitrary row would be a confident lie');
    assert.equal(occurrences(list, new RegExp(T10_BADGE, 'g')), 3, 'so all three are honestly badged for T-10');
  });

  test('a non-string authorChoice marks nothing rather than matching an id that is also missing', () => {
    const state = stateAt('st-4-symbol-render');
    for (const opt of state.step.decision.options) opt.taken = false;
    state.step.decision.authorChoice = poison(undefined);
    state.step.decision.options[0]!.id = poison(undefined);

    let html = '';
    assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); });
    assert.equal(occurrences(optionsList(html), /option option-taken/g), 0, '"" must never match ""');
  });

  test("AC2 outranks the cap: the author's own option is drawn even when buried past it", () => {
    // The interaction between the two fixes. A hostile plan that put five thousand
    // alternatives in front of the author's own option would otherwise meet the security cap
    // by breaking the acceptance criterion it was capping.
    const state = stateAt('st-2-file-parse');
    const author = { id: 'author', label: 'What the author actually did', consequence: 'the real one', taken: true };
    state.step.decision.options = [...floodOptions(MAX_OPTIONS_RENDERED + 40, 'a decoy'), author];

    const html = renderStepHtml(state, FAKE_SKINS);
    const rows = optionRows(html);
    assert.equal(rows.length, MAX_OPTIONS_RENDERED, 'the cap still holds');

    const marked = rows.filter((r) => r.cls === 'option option-taken');
    assert.equal(marked.length, 1, "the author's choice is still marked (AC2)");
    assert.equal(marked[0]!.id, 'author');
    assert.ok(optionsList(html).includes('the real one'), 'with its own consequence, not a decoy\'s');
    assert.equal(paragraph(html, 'options-omitted'),
      optionsOmittedMessage(state.step.decision.options.length - MAX_OPTIONS_RENDERED),
      'and the count of what was left out is still right');
  });
});


// ── a minimal, dependency-free fake DOM: just enough of document/window/acquireVsCodeApi
// for THIS script. Deliberately not jsdom — the goal is to run the exact shipped code with
// as little else as possible standing between the assertion and the real script text.
class FakeElement {
  value = '';
  textContent = '';
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

const ELEMENT_IDS = [
  'step-main', 'step-note', 'btn-prev', 'btn-open', 'btn-check', 'btn-next', 'btn-reproduce',
  'dial-manual', 'dial-scaffolded', 'dial-automated', 'skinpick',
];

/** `saved` seeds what `getState()` returns BEFORE the script loads — the view-scoped blob a
 *  torn-down webview comes back to, which is the whole subject of the restore tests. */
function buildFakeDom(saved?: unknown) {
  const elements = new Map<string, FakeElement>();
  for (const id of ELEMENT_IDS) elements.set(id, new FakeElement());

  const docAttrs = new Map<string, string>();
  const fakeDocument = {
    documentElement: {
      setAttribute: (name: string, value: string) => docAttrs.set(name, value),
      removeAttribute: (name: string) => docAttrs.delete(name),
    },
    getElementById: (id: string) => elements.get(id),
  };

  const windowListeners = new Map<string, Array<(e: unknown) => void>>();
  const fakeWindow = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
  };

  const posted: Array<{ type: string; payload: unknown }> = [];
  const states: unknown[] = saved === undefined ? [] : [saved];
  const acquireVsCodeApi = () => ({
    postMessage: (m: { type: string; payload: unknown }) => posted.push(m),
    getState: () => states[states.length - 1],
    setState: (s: unknown) => states.push(s),
  });

  return { elements, fakeDocument, fakeWindow, windowListeners, posted, states, docAttrs, acquireVsCodeApi };
}

/**
 * Runs the REAL shipped script — extracted from `renderStepHtml`'s own output, so this is
 * the `src/webview/page.ts` bootstrap (`post`/`restore`/`save`) combined with `stepScript()`
 * exactly as `renderPage` combines them for the real webview.
 *
 * Two values are copied out of that same markup into the fake DOM first — the `data-step-id`
 * the script keys its note by, and the note the server already rendered — because in a real
 * webview the script reads both off the page it was shipped inside. Copying them keeps the
 * harness a stand-in for the browser rather than a second, hand-maintained opinion about
 * what the page contains.
 *
 * This is the one deliberate parse-and-execute use of the Function constructor
 * `no-implied-eval` warns about in this file; every test below calls this helper.
 */
function runScript(dom: ReturnType<typeof buildFakeDom>, state: StepViewState): void {
  const html = renderStepHtml(state, FAKE_SKINS);

  const idMatch = /<main id="step-main" data-step-id="([^"]*)"/.exec(html);
  assert.ok(idMatch, 'the page should stamp the step id the script keys its note by');
  dom.elements.get('step-main')!.setAttribute('data-step-id', idMatch[1]!);

  const noteMatch = /<div class="note" id="step-note">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(noteMatch, 'the page should render the note node');
  dom.elements.get('step-note')!.textContent = noteMatch[1]!;

  const [, code] = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html) ?? [];
  assert.ok(code, 'renderStepHtml should inline a <script> block');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- fake DOM, no untrusted input; see the doc comment above
  const fn = new Function('document', 'window', 'acquireVsCodeApi', code);
  fn(dom.fakeDocument, dom.fakeWindow, dom.acquireVsCodeApi);
}

suite('the step panel\'s client script, actually executed against a fake DOM (AC2, AC5)', () => {
  test('the real script parses, and the page ships exactly what stepScript() exports', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const [, code] = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html) ?? [];
    assert.ok(code && code.length > 200, 'the script block should be present and non-trivial');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- parse-only, see test/unit/page.test.ts
    assert.doesNotThrow(() => new Function(code));
    assert.ok(code.includes(stepScript()), 'the harness below runs the script the page really ships');
  });

  test('each of the four buttons posts exactly the message parseStepMessage accepts for it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    const buttons: Array<[string, string]> = [
      ['btn-prev', 'step:prev'],
      ['btn-open', 'step:open'],
      ['btn-check', 'step:check'],
      ['btn-next', 'step:next'],
    ];
    // `step:check` is no longer answered by the host with a sentence (T-5 made it real), but
    // the BUTTON's job is unchanged: post the message. What the host does with it is
    // `test/unit/walk-step-protocol.test.ts`'s subject.
    for (const [id] of buttons) {
      dom.elements.get(id)!.dispatch('click');
    }

    assert.equal(dom.posted.length, 4, 'four clicks, four messages — no button is wired to nothing');
    for (const [i, [id, type]] of buttons.entries()) {
      assert.equal(dom.posted[i]!.type, type, `${id} posts ${type}`);
      // Through the REAL parser, so a payload shape drift fails here, not in a live webview.
      assert.deepEqual(parseStepMessage(dom.posted[i]), { type }, `the host accepts what ${id} sent`);
    }
  });

  test('every dial position posts dial:set with its own value, and the host accepts it', () => {
    for (const dial of DIALS) {
      const dom = buildFakeDom();
      runScript(dom, stateAt('st-2-file-parse'));
      dom.elements.get(`dial-${dial}`)!.dispatch('change');

      assert.deepEqual(dom.posted, [{ type: 'dial:set', payload: { dial } }]);
      assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'dial:set', payload: { dial } });
    }
  });

  test('picking a skin stamps data-theme INSTANTLY and posts skin:set', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    dom.elements.get('skinpick')!.value = 'dark';
    dom.elements.get('skinpick')!.dispatch('change');

    assert.equal(dom.docAttrs.get('data-theme'), 'dark', 'no host round-trip needed to see the skin');
    assert.deepEqual(dom.posted, [{ type: 'skin:set', payload: { skin: 'dark' } }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'skin:set', payload: { skin: 'dark' } });
  });

  test('picking "system" REMOVES data-theme rather than setting it to the string "system"', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    dom.docAttrs.set('data-theme', 'dark'); // as if a skin was previously chosen
    dom.elements.get('skinpick')!.value = 'system';
    dom.elements.get('skinpick')!.dispatch('change');

    assert.equal(dom.docAttrs.has('data-theme'), false);
    assert.deepEqual(dom.posted, [{ type: 'skin:set', payload: { skin: 'system' } }]);
  });

  test('the reproduce offer\'s button posts reproduce:run, and the host accepts it (AC6)', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-1-shape-src', { reproduce: { count: 12, done: false } }));
    dom.elements.get('btn-reproduce')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'reproduce:run', payload: {} }]);
    // Through the REAL parser, so a drift between what the button sends and what the host
    // accepts fails here rather than silently, in a webview, on the one control that writes
    // files into the learner's folder.
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'reproduce:run' });
  });

  test('with no offer on the page there is no button to click, and the script still loads', () => {
    // The offer's ABSENCE is what removes the affordance — not a disabled attribute a later
    // edit could drop. `id="btn-reproduce"`, not the bare id: the client script names it on
    // every page, so only the attribute says whether the control was really rendered.
    const html = renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS);
    assert.ok(!html.includes('id="btn-reproduce"'), 'no offer, no button anywhere in the markup');

    // And the script survives it. The harness pre-creates every id it knows about, so the
    // missing node has to be taken away deliberately to reproduce what the browser really
    // hands this script on a page with no offer on it: `getElementById` answering nothing.
    const dom = buildFakeDom();
    dom.elements.delete('btn-reproduce');
    assert.doesNotThrow(() => { runScript(dom, stateAt('st-1-shape-src')); });

    dom.elements.get('btn-next')!.dispatch('click');
    assert.deepEqual(dom.posted, [{ type: 'step:next', payload: {} }], 'and the rest of the page is still wired');
  });

  test('an inbound step:note writes the reply into the note node (AC5)', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    const handlers = dom.windowListeners.get('message') ?? [];
    assert.equal(handlers.length, 1, 'the script should register exactly one message listener');
    handlers[0]!({ data: { type: 'step:note', payload: { note: A_NOTE } } });

    assert.equal(dom.elements.get('step-note')!.textContent, A_NOTE);
  });

  test('a message of some other type is ignored, not written anywhere', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const [onMessage] = dom.windowListeners.get('message') ?? [];

    onMessage!({ data: { type: 'form:problems', payload: { problems: { idea: 'nope' } } } });
    onMessage!({ data: null });

    assert.equal(dom.elements.get('step-note')!.textContent, '');
    assert.equal(dom.states.length, 0, 'and nothing was saved');
  });

  test('the note is saved KEYED BY the step it belongs to', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const [onMessage] = dom.windowListeners.get('message') ?? [];

    onMessage!({ data: { type: 'step:note', payload: { note: A_NOTE } } });

    assert.equal(dom.states.length, 1);
    assert.deepEqual(dom.states[0], { stepId: 'st-2-file-parse', note: A_NOTE });
  });

  test('a note saved for THIS step comes back when the torn-down view reloads (AC5)', () => {
    const dom = buildFakeDom({ stepId: 'st-2-file-parse', note: A_NOTE });
    runScript(dom, stateAt('st-2-file-parse'));

    assert.equal(dom.elements.get('step-note')!.textContent, A_NOTE, 'the reply already on screen survives being hidden');
  });

  test('a note saved for a DIFFERENT step is ignored — the guard against a confident lie', () => {
    // The getState blob is scoped to the whole VIEW, not to a step. Hide the panel, navigate,
    // show it again: without the key check, the note the learner LEFT reappears under the
    // question they arrived at, stated as if it belonged there.
    const stale = { stepId: 'st-4-symbol-render', note: 'a reply about a step you already left' };

    const blank = buildFakeDom(stale);
    runScript(blank, stateAt('st-2-file-parse'));
    assert.equal(blank.elements.get('step-note')!.textContent, '', 'the stale note does not appear');

    // And it does not overwrite a note the HOST itself rendered for the step now on screen —
    // the host's render stays authoritative (spec §5.1).
    const rendered = buildFakeDom(stale);
    runScript(rendered, stateAt('st-2-file-parse', { note: A_NOTE }));
    assert.equal(rendered.elements.get('step-note')!.textContent, A_NOTE);
    assert.ok(!rendered.elements.get('step-note')!.textContent.includes('already left'));
  });
});

// ── T-5: what the dial's work looks like on the page ───────────────────────────────────────

suite('renderStepHtml — the check report (AC5)', () => {
  test('a pass leads with the summary, marked as a pass, and lists every symbol and import', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'every part is there: 2 exports and 1 import present',
        report: report({
          symbols: [
            { name: 'tokenize', kind: 'function', status: 'present' },
            { name: 'Token', kind: 'interface', status: 'present' },
          ],
          imports: [{ raw: '../parse.js', status: 'present' }],
        }),
      },
    }), FAKE_SKINS);

    assert.equal(paragraph(html, 'check-summary check-pass'), 'every part is there: 2 exports and 1 import present');
    assert.ok(html.includes(`<h2>${CHECK_HEADING}</h2>`), 'the block names itself, and not with the button\'s own label');
    assert.ok(!html.includes('class="check-summary check-fail"'), 'a pass is never dressed as a failure');

    const [exportsList, importsList] = checkLists(html);
    assert.deepEqual(checkRows(exportsList ?? ''), [
      { status: 'present', name: 'tokenize' },
      { status: 'present', name: 'Token' },
    ]);
    assert.deepEqual(checkRows(importsList ?? ''), [{ status: 'present', name: '../parse.js' }]);
    // AC5 asks for present/missing/extra PER SYMBOL, so the kind rides along with the name.
    assert.ok(exportsList!.includes('<span class="check-kind">function</span>'), 'a symbol\'s kind is shown beside it');
    assert.ok(html.includes(`<h3>${EXPORTS_HEADING}</h3>`) && html.includes(`<h3>${IMPORTS_HEADING}</h3>`));
  });

  test('a missing export is NAMED, marked as a failure, and drawn first', () => {
    // AC5 names this case out loud. "1 missing" is a riddle; the name is a next action — and
    // the row has to be at the top, because that is the row the learner came here for.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'missing export: rank',
        report: report({
          ok: false,
          symbols: [
            { name: 'tokenize', kind: 'function', status: 'present' },
            { name: 'rank', kind: 'function', status: 'missing' },
            { name: 'debugDump', kind: 'function', status: 'extra' },
          ],
        }),
      },
    }), FAKE_SKINS);

    assert.equal(paragraph(html, 'check-summary check-fail'), 'missing export: rank');
    assert.deepEqual(checkRows(checkLists(html)[0] ?? ''), [
      { status: 'missing', name: 'rank' },
      { status: 'extra', name: 'debugDump' },
      { status: 'present', name: 'tokenize' },
    ], 'news first: missing, then extra, then the bulk');
    assert.ok(checkLists(html)[0]!.includes('class="check-row check-missing"'), 'and the missing row is marked as one');
  });

  test('a renamed local is invisible to the report, so a pass really is a pass', () => {
    // The premise of the whole extension (src/dial/check.ts's header): the check is
    // STRUCTURAL, so a learner who wrote their own body with their own names passes. There is
    // no field in `CheckReport` that can express "the body differs" — asserted here as a fact
    // about what this page can therefore ever draw.
    const html = renderStepHtml(stateAt('st-3-symbol-handle', {
      check: {
        summary: 'every part is there: 1 export present, and no imports to match',
        report: report({ symbols: [{ name: 'handleRequest', kind: 'function', status: 'present' }] }),
      },
    }), FAKE_SKINS);

    assert.ok(html.includes('class="check-summary check-pass"'));
    const rows = checkRows(checkLists(html)[0] ?? '');
    assert.deepEqual(rows, [{ status: 'present', name: 'handleRequest' }]);
    assert.ok(!rows.some((r) => r.status !== 'present'), 'nothing on this page can call a correct body wrong');
  });

  test('a parse failure leads with the core\'s own reason and lists NOTHING', () => {
    // The trap this branch exists for: repo-tour's `check` finds no symbols in a tree it could
    // not build, so EVERY export comes back `missing`. Rendering that list would tell a learner
    // one stray brace away from correct that their whole file is missing.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'unexpected token at line 12 — a closing brace is missing',
        report: report({
          ok: false,
          parseErrors: 3,
          reason: 'unexpected token at line 12 — a closing brace is missing',
          symbols: [
            { name: 'zzUnparsedExport', kind: 'function', status: 'missing' },
            { name: 'Token', kind: 'interface', status: 'missing' },
          ],
          imports: [{ raw: '../parse.js', status: 'missing' }],
        }),
      },
    }), FAKE_SKINS);

    assert.equal(paragraph(html, 'check-summary check-fail'), 'unexpected token at line 12 — a closing brace is missing');
    assert.equal(checkLists(html).length, 0, 'no symbol list and no import list at all');
    assert.ok(!html.includes('zzUnparsedExport'), 'and no name from the would-be missing list leaks onto the page');
    assert.equal(paragraph(html, 'check-aside'), CHECK_PARSE_MESSAGE, 'the page says WHY there is no list');
  });

  test('a parse failure whose reason differs from the summary shows both, once each', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'this file did not parse — 3 errors — so its shape could not be compared yet',
        report: report({ ok: false, parseErrors: 3, reason: 'unterminated string starting at line 4' }),
      },
    }), FAKE_SKINS);

    assert.equal(paragraph(html, 'check-reason'), 'unterminated string starting at line 4');
    assert.equal(occurrences(html, /unterminated string/g), 1, 'said once, not twice');
  });

  test('a parse failure with no usable reason still explains the absent list', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: { summary: 'this file did not parse', report: report({ ok: false, parseErrors: 1 }) },
    }), FAKE_SKINS);

    assert.ok(!html.includes('<p class="check-reason">'), 'nothing to say means no empty line pretending otherwise');
    assert.equal(paragraph(html, 'check-aside'), CHECK_PARSE_MESSAGE);
  });

  test('extras are shown and never scolded — the page agrees with what the core does', () => {
    // repo-tour's `compare` only fails on `missing`, so an export of the learner's own is a
    // pass with a note. A page that coloured it like a failure would teach the wrong lesson.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'every part is there: 1 export present · plus 1 export of your own (debugDump) — extras never fail the check',
        report: report({
          symbols: [
            { name: 'tokenize', kind: 'function', status: 'present' },
            { name: 'debugDump', kind: 'function', status: 'extra' },
          ],
        }),
      },
    }), FAKE_SKINS);

    assert.ok(html.includes('class="check-summary check-pass"'), 'extras do not turn a pass into a failure');
    assert.ok(checkLists(html)[0]!.includes('class="check-row check-extra"'));
  });

  test('no check at all renders no report section — never an empty one, never a fake pass', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    assert.ok(!html.includes('class="check"'), 'nobody has pressed the button, so there is nothing to show');
    assert.ok(!html.includes(CHECK_HEADING));
    // `class="…"`, not the bare class name: PAGE_CSS declares every one of these selectors on
    // every page, so a bare `includes` would be true whatever the markup did.
    assert.ok(!html.includes('class="check-summary'));
  });

  test('every string in a report is escaped — a report is plan-adjacent, third-party text', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: '<script>alert("s")</script> & co',
        report: report({
          ok: false,
          symbols: [{ name: '<script>alert("n")</script>', kind: '<img src=x onerror=alert(1)>', status: 'missing' }],
          imports: [{ raw: '"><script>alert("i")</script>', status: 'missing' }],
        }),
      },
    }), FAKE_SKINS);

    assert.equal(occurrences(html, /<script/g), 1, 'the page still ships exactly one script tag: its own');
    // The `onerror=` TEXT survives (escapeHtml has no reason to touch an equals sign); what
    // must not survive is the tag it needed to become an attribute of.
    assert.ok(!html.includes('<img'), 'no tag was forged out of a symbol kind');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the kind is shown, inert, exactly as the report gave it');
    assert.ok(html.includes('&lt;script&gt;alert("n")&lt;/script&gt;'), 'shown, escaped — never silently dropped');
    assert.ok(html.includes('&amp; co'), 'a bare ampersand never survives into the markup');
  });

  test('a status the core invented is labelled honestly and reaches no class attribute', () => {
    // `status` crosses a duck-typed boundary from a core loaded at run time, so
    // `class="check-${status}"` would be an attribute injection escapeHtml never sees.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'a summary',
        report: report({ symbols: [poison({ name: 'rank', kind: 'function', status: 'a" onclick="alert(1)' })] }),
      },
    }), FAKE_SKINS);

    assert.ok(!/ onclick="/.test(html), 'nothing broke out of the class attribute');
    assert.ok(html.includes('class="check-row check-unknown"'), 'an unrecognised status gets the one fixed class');
    assert.deepEqual(checkRows(checkLists(html)[0] ?? ''), [{ status: UNKNOWN_CHECK_STATUS_MESSAGE, name: 'rank' }]);
  });

  test('a report whose shape is nothing like a report renders, and does not throw', () => {
    // Same discipline as every other lookup on this page (T-4 security finding 5): a throw
    // from a render lands inside a promise the activation path voids, and the panel simply
    // never appears.
    for (const bad of [
      report({ symbols: poison(null) }),
      report({ symbols: poison('tokenize') }),
      report({ symbols: poison([null, 42, 'x']) }),
      report({ imports: poison({ 0: { raw: 'x' } }) }),
      report({ parseErrors: poison('3') }),
      report({ ok: poison('yes') }),
    ]) {
      let html = '';
      assert.doesNotThrow(
        () => { html = renderStepHtml(stateAt('st-2-file-parse', { check: { summary: 'a summary', report: bad } }), FAKE_SKINS); },
        `report ${JSON.stringify(bad)} threw`,
      );
      assert.ok(html.includes('check-summary'), 'and the summary is still drawn');
    }
    // A row with nothing readable in it says so, rather than rendering the word "undefined".
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: { summary: 'a summary', report: report({ symbols: poison([{ status: 'missing' }]) }) },
    }), FAKE_SKINS);
    assert.deepEqual(checkRows(checkLists(html)[0] ?? ''), [{ status: 'missing', name: NOT_TEXT_MESSAGE }]);
  });
});

suite('renderStepHtml — a hostile report renders BOUNDED, and says what it left out', () => {
  function flood(count: number, status: string, prefix: string) {
    return Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}`, kind: 'function', status }));
  }

  test(`a report with ${MAX_LIST_ROWS * 10} exports draws MAX_LIST_ROWS rows and counts the rest, accurately`, () => {
    const symbols = flood(MAX_LIST_ROWS * 10, 'present', 'sym');
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: { summary: 'a summary', report: report({ symbols: poison(symbols) }) },
    }), FAKE_SKINS);

    const drawn = occurrences(checkLists(html)[0] ?? '', /<li /g);
    assert.equal(drawn, MAX_LIST_ROWS, 'the list stops at the cap');
    const omitted = symbols.length - MAX_LIST_ROWS;
    assert.equal(paragraph(html, 'list-omitted'), listOmittedMessage(omitted, 'export'));
    assert.equal(drawn + omitted, symbols.length, 'the count on the page adds up');
  });

  test('the omitted line counts in the singular, and names the right noun per list', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'a summary',
        report: report({
          symbols: poison(flood(MAX_LIST_ROWS + 1, 'present', 'sym')),
          imports: poison(Array.from({ length: MAX_LIST_ROWS + 1 }, (_, i) => ({ raw: `./m${i}.js`, status: 'present' }))),
        }),
      },
    }), FAKE_SKINS);

    const lines = [...html.matchAll(/<p class="list-omitted">([^<]*)<\/p>/g)].map((m) => m[1]!);
    assert.deepEqual(lines, [listOmittedMessage(1, 'export'), listOmittedMessage(1, 'import')]);
    assert.ok(!lines[0]!.includes('exports'), 'one export, not "1 more exports"');
  });

  test('AC5 outranks the cap: a lone missing export survives a flood of present ones', () => {
    // The interaction that makes the cap safe. In report order the missing row sits past the
    // cap and the page would name nothing at all — meeting the security fix by breaking the
    // acceptance criterion it was capping (`optionsHtml` makes the same trade for AC2).
    const symbols = [...flood(MAX_LIST_ROWS * 3, 'present', 'sym'), { name: 'rank', kind: 'function', status: 'missing' }];
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: { summary: 'missing export: rank', report: report({ ok: false, symbols: poison(symbols) }) },
    }), FAKE_SKINS);

    const rows = checkRows(checkLists(html)[0] ?? '');
    assert.equal(rows.length, MAX_LIST_ROWS, 'the cap still holds');
    assert.deepEqual(rows[0], { status: 'missing', name: 'rank' }, 'and the one row AC5 is about is the FIRST one drawn');
  });

  test('a giant identifier is cut at MAX_CHECK_TEXT with a VISIBLE marker', () => {
    const name = `${'n'.repeat(MAX_CHECK_TEXT)}THIS TAIL IS PAST THE CAP`;
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: { summary: 'a summary', report: report({ symbols: [{ name, kind: 'function', status: 'missing' }] }) },
    }), FAKE_SKINS);

    const drawn = checkRows(checkLists(html)[0] ?? '')[0]!.name;
    assert.equal(drawn, name.slice(0, MAX_CHECK_TEXT) + TRUNCATION_MARKER);
    assert.ok(!html.includes('THIS TAIL IS PAST THE CAP'));
  });

  test('the SUMMARY keeps the prose cap, not the identifier one — it is a sentence', () => {
    const summary = 'w'.repeat(MAX_CHECK_TEXT + 500);
    const html = renderStepHtml(stateAt('st-2-file-parse', { check: { summary, report: report() } }), FAKE_SKINS);
    assert.equal(paragraph(html, 'check-summary check-pass'), summary, 'well under MAX_PLAN_TEXT, so nothing is cut');
    assert.ok(!html.includes(TRUNCATION_MARKER));
  });

  test('neither cap can fire on a report a real file produces', () => {
    // Measured, not assumed: the widest export surface across the three repos on hand is 28
    // (src/start/build.ts) and the widest import list 21 (repo-tour's src/cli.ts). A cap that
    // fired on those would be the cap doing harm rather than work.
    const WIDEST_REAL_EXPORT_SURFACE = 28;
    const WIDEST_REAL_IMPORT_LIST = 21;
    assert.ok(MAX_LIST_ROWS > WIDEST_REAL_EXPORT_SURFACE * 4, 'four times the widest real file, at least');
    assert.ok(MAX_LIST_ROWS > WIDEST_REAL_IMPORT_LIST * 4);
    // And the longest exported identifier measured is 26 characters.
    assert.ok(MAX_CHECK_TEXT > 26 * 4, 'four times the longest real identifier, at least');

    const html = renderStepHtml(stateAt('st-2-file-parse', {
      check: {
        summary: 'every part is there: 28 exports and 21 imports present',
        report: report({
          symbols: poison(flood(WIDEST_REAL_EXPORT_SURFACE, 'present', 'exported')),
          imports: poison(Array.from({ length: WIDEST_REAL_IMPORT_LIST }, (_, i) => ({ raw: `../module-${i}.js`, status: 'present' }))),
        }),
      },
    }), FAKE_SKINS);
    assert.ok(!html.includes('<p class="list-omitted">'), 'a real file is drawn whole');
    assert.ok(!html.includes(TRUNCATION_MARKER));
  });
});

suite('renderStepHtml — the manual-mode shape block (AC2)', () => {
  const SHAPE = {
    signatures: ['export function tokenize(line: string): Token[] {', 'export const VERSION = 1;'],
    imports: ["import { tokenize } from '../parse.js';"],
  };

  test('renders the reference\'s imports and signature lines, with a caption saying what they are not', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', { shape: SHAPE }), FAKE_SKINS);

    assert.ok(html.includes(`<h2>${SHAPE_HEADING}</h2>`));
    assert.equal(paragraph(html, 'shape-note'), SHAPE_NOTE_MESSAGE);
    for (const line of [...SHAPE.signatures, ...SHAPE.imports]) {
      assert.ok(html.includes(escapeForHtml(line)), `the block shows: ${line}`);
    }
    // Imports first, then signatures — the order a file is actually written in.
    assert.ok(html.indexOf(`<h3>${IMPORTS_HEADING}</h3>`) < html.indexOf(`<h3>${EXPORTS_HEADING}</h3>`));
  });

  test('it shows LINES and never a body — the block must not become the answer', () => {
    // The whole premise of manual mode is that the extension writes nothing. A shape block
    // that quietly grew into the finished file would defeat the position of the dial the
    // learner deliberately chose, and no test below this line would notice.
    const html = renderStepHtml(stateAt('st-2-file-parse', { shape: SHAPE }), FAKE_SKINS);
    const section = /<section class="shape">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';

    assert.ok(section.length > 0, 'the block is on the page');
    assert.equal(occurrences(section, /<li>/g), 3, 'exactly the three lines it was given, and nothing else');
    assert.ok(!section.includes('const out'), 'no body from the fixture\'s real parse.ts leaked in');
    assert.ok(!/<button|<input/i.test(section), 'and nothing in it is selectable');
  });

  test('no shape means no block — the mode gate is the field\'s presence, not a dial re-read', () => {
    // Deliberate: the session decides what mode wrote (or did not write) the file, and a page
    // that re-derived "am I in manual" from the dial could disagree with what is on disk.
    for (const dial of DIALS) {
      const html = renderStepHtml(stateAt('st-2-file-parse', { dial }), FAKE_SKINS);
      assert.ok(!html.includes('class="shape"'), `${dial}: no shape sent, so no block`);
      assert.ok(!html.includes(SHAPE_NOTE_MESSAGE));
    }
  });

  test('a shape with nothing in it says so, rather than showing an empty heading', () => {
    const html = renderStepHtml(stateAt('st-1-shape-src', { shape: { signatures: [], imports: [] } }), FAKE_SKINS);
    assert.equal(paragraph(html, 'check-aside'), SHAPE_EMPTY_MESSAGE);
    assert.ok(!html.includes(`<h3>${EXPORTS_HEADING}</h3>`), 'and no heading over a list that is not there');
    assert.ok(!html.includes(SHAPE_NOTE_MESSAGE), 'nor a caption about lines there are none of');
  });

  test('one empty half draws the other half alone', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', { shape: { signatures: SHAPE.signatures, imports: [] } }), FAKE_SKINS);
    assert.ok(html.includes(`<h3>${EXPORTS_HEADING}</h3>`));
    assert.ok(!html.includes(`<h3>${IMPORTS_HEADING}</h3>`), 'a file with no imports gets no Imports heading');
    assert.equal(paragraph(html, 'shape-note'), SHAPE_NOTE_MESSAGE, 'and the caption still applies');
  });

  test('every line is escaped — a signature is source text from someone else\'s repository', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      shape: { signatures: ['export const x = "</script><script>alert(1)</script>";'], imports: ['import "&<>";'] },
    }), FAKE_SKINS);

    assert.equal(occurrences(html, /<script/g), 1);
    assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;alert(1)'), 'shown, escaped');
    assert.ok(html.includes('import "&amp;&lt;&gt;";'));
  });

  test('the block is capped and counted the same visible way everything else is', () => {
    const signatures = Array.from({ length: MAX_LIST_ROWS + 3 }, (_, i) => `export function f${i}(): void {`);
    const html = renderStepHtml(stateAt('st-2-file-parse', { shape: { signatures, imports: [] } }), FAKE_SKINS);

    assert.equal(occurrences(html, /<li><code class="shape-line">/g), MAX_LIST_ROWS);
    assert.equal(paragraph(html, 'list-omitted'), listOmittedMessage(3, 'signature'));
  });

  test('a shape whose halves are not arrays renders, and does not throw', () => {
    type Shape = StepViewState['shape'];
    for (const shape of [
      poison<Shape>({ signatures: null, imports: null }),
      poison<Shape>({ signatures: 'export function f()', imports: 7 }),
      poison<Shape>({}),
    ]) {
      let html = '';
      assert.doesNotThrow(() => { html = renderStepHtml(stateAt('st-2-file-parse', { shape }), FAKE_SKINS); });
      assert.equal(paragraph(html, 'check-aside'), SHAPE_EMPTY_MESSAGE, 'nothing readable is nothing to show');
    }
  });
});

suite('renderStepHtml — the write note, and the reproduce offer (AC6)', () => {
  test('the write note is rendered in its own node, escaped, where the eye already is', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      writeNote: 'your version was kept — nothing was overwritten <ok>',
    }), FAKE_SKINS);

    const written = /<p class="write-note" id="write-note">([\s\S]*?)<\/p>/.exec(html);
    assert.ok(written, 'the write note gets a node of its own');
    assert.equal(written[1], 'your version was kept — nothing was overwritten &lt;ok&gt;');
    // Between the dial that caused the write and the actions the write is about, and NOT in
    // `#step-note`: that node is the client script's, updated without a repaint, and this one
    // is the session's, server-rendered and keyed.
    assert.ok(html.indexOf('<fieldset class="dial">') < html.indexOf('<p class="write-note"'));
    assert.ok(html.indexOf('<p class="write-note"') < html.indexOf('<div class="actions">'));
    assert.match(html, /<div class="note" id="step-note"><\/div>/, 'and the panel\'s own note line is untouched');
  });

  test('no write note means no node at all — never an empty paragraph under the dial', () => {
    for (const writeNote of [undefined, '', poison<string>(42), poison<string>(null), poison<string>({})]) {
      const html = renderStepHtml(stateAt('st-2-file-parse', { writeNote }), FAKE_SKINS);
      assert.ok(!html.includes('id="write-note"'), `writeNote ${JSON.stringify(writeNote)} should render nothing`);
    }
  });

  test('the offer names the count and ships a button, once, at the bottom of the page', () => {
    const html = renderStepHtml(stateAt('st-1-shape-src', { reproduce: { count: 12, done: false } }), FAKE_SKINS);

    assert.ok(html.includes(reproduceOfferMessage(12)), 'the count is in the sentence, not "some files"');
    assert.ok(html.includes('12 files'), 'and it really is the number it was given');
    assert.match(html, new RegExp(`<button type="button" class="btn" id="btn-reproduce">${REPRODUCE_BUTTON_LABEL}</button>`));
    assert.equal(occurrences(html, /id="btn-reproduce"/g), 1);
  });

  test('one file is offered in the singular', () => {
    const html = renderStepHtml(stateAt('st-1-shape-src', { reproduce: { count: 1, done: false } }), FAKE_SKINS);
    assert.ok(html.includes(reproduceOfferMessage(1)));
    assert.ok(html.includes('1 file here is'), 'not "1 files here are"');
  });

  test('once done, no offer — a taken offer left on the page invites a second press', () => {
    const html = renderStepHtml(stateAt('st-1-shape-src', { reproduce: { count: 12, done: true } }), FAKE_SKINS);
    assert.ok(!html.includes('id="btn-reproduce"'), 'no button');
    assert.ok(!html.includes('id="reproduce-offer"'), 'and no line either — it has already happened');
  });

  test('nothing to copy is no offer, and nothing usable is no offer either', () => {
    type Offer = StepViewState['reproduce'];
    for (const reproduce of [
      undefined,
      { count: 0, done: false },
      poison<Offer>({ count: -3, done: false }),
      poison<Offer>({ count: Number.NaN, done: false }),
      poison<Offer>({ count: '12', done: false }),
      poison<Offer>({ count: null, done: false }),
      poison<Offer>({ done: false }),
      poison<Offer>({ count: 12, done: 1 }),
    ]) {
      const html = renderStepHtml(stateAt('st-1-shape-src', { reproduce }), FAKE_SKINS);
      assert.ok(!html.includes('id="btn-reproduce"'), `reproduce ${JSON.stringify(reproduce)} should offer nothing`);
    }
  });
});

// ── the repaint key: the one bug in this ticket that fails no test unless this one exists ──

/**
 * `stepRenderKey` is what `src/walk/step-panel.ts` decides whether to repaint on, and the
 * failure it guards is silent: a field this page DRAWS and that function OMITS is stored on
 * the host and never appears on screen until something else forces a repaint. Nothing throws,
 * no other test fails, and the button simply looks dead.
 *
 * So the proof is by mutation, in both directions:
 *
 *   - **change one rendered field and the key must move** — the table below carries every
 *     field T-5 added plus the ones T-4 already had, and each case asserts the KEY changed AND
 *     that the PAGE really did change (with the per-render nonce blanked, since `renderPage`
 *     mints a fresh one every call). Asserting only the key would pass on a field that is in
 *     the key and rendered nowhere; asserting only the page would pass on the very bug this
 *     exists to catch.
 *   - **change nothing and the key must not move** — otherwise "repaint only when the page
 *     would change" degrades to "repaint always", which is T-4 code review finding 1 back
 *     again, and the learner loses the radio holding keyboard focus on every dial click.
 */
suite('stepRenderKey — every field the page draws moves the repaint key', () => {
  /** `[what changed, the page before, the page after]` — one field apart, never two. */
  function mutations(): Array<[string, StepViewState, StepViewState]> {
    const check = { summary: 'every part is there: 1 export present', report: report({ symbols: [{ name: 'tokenize', kind: 'function', status: 'present' }] }) };
    const pair = (name: string, before: Partial<StepViewState>, after: Partial<StepViewState>): [string, StepViewState, StepViewState] =>
      [name, stateAt('st-2-file-parse', before), stateAt('st-2-file-parse', after)];

    const withQuestion = (q: string): StepViewState => {
      const state = stateAt('st-2-file-parse');
      state.step.decision.question = q;
      return state;
    };

    return [
      ['step.decision.question', withQuestion('one question'), withQuestion('a different question')],
      pair('state.fileExists', { fileExists: true }, { fileExists: false }),

      // ── the four T-5 added. Each of these is a "stored and never drawn" bug waiting. ──
      pair('state.check appearing', {}, { check }),
      pair('state.check changing verdict', { check }, {
        check: { summary: 'missing export: rank', report: report({ ok: false, symbols: [{ name: 'rank', kind: 'function', status: 'missing' }] }) },
      }),
      pair('state.check summary only', { check }, { check: { summary: 'a different sentence entirely', report: check.report } }),
      pair('state.shape appearing', {}, { shape: { signatures: ['export function f(): void {'], imports: [] } }),
      pair('state.shape contents', { shape: { signatures: ['export function f(): void {'], imports: [] } }, { shape: { signatures: ['export function g(): void {'], imports: [] } }),
      pair('state.writeNote appearing', {}, { writeNote: 'your version was kept' }),
      pair('state.writeNote changing', { writeNote: 'your version was kept' }, { writeNote: 'the reference file was written' }),
      pair('state.reproduce appearing', {}, { reproduce: { count: 12, done: false } }),
      pair('state.reproduce count', { reproduce: { count: 12, done: false } }, { reproduce: { count: 3, done: false } }),
      pair('state.reproduce done', { reproduce: { count: 12, done: false } }, { reproduce: { count: 12, done: true } }),
    ];
  }

  test('changing one drawn field changes the key AND the page — every field, one at a time', () => {
    for (const [what, before, after] of mutations()) {
      assert.notEqual(
        stepRenderKey(before, FAKE_SKINS), stepRenderKey(after, FAKE_SKINS),
        `${what} changes the page, so it MUST change the repaint key — otherwise the panel stores it and never draws it`,
      );
      assert.notEqual(
        pageWithoutNonce(renderStepHtml(before, FAKE_SKINS)), pageWithoutNonce(renderStepHtml(after, FAKE_SKINS)),
        `${what} is in the key but changes nothing on the page — the key describes a render that does not happen`,
      );
    }
  });

  test('the same state twice is the same key and the same page', () => {
    const state = stateAt('st-2-file-parse', {
      check: { summary: 'a summary', report: report() },
      shape: { signatures: ['export function f(): void {'], imports: ['import x from "y";'] },
      writeNote: 'the reference file was written',
      reproduce: { count: 4, done: false },
    });
    assert.equal(stepRenderKey(state, FAKE_SKINS), stepRenderKey(stateAt('st-2-file-parse', {
      check: { summary: 'a summary', report: report() },
      shape: { signatures: ['export function f(): void {'], imports: ['import x from "y";'] },
      writeNote: 'the reference file was written',
      reproduce: { count: 4, done: false },
    }), FAKE_SKINS), 'two equal states, one key — or the panel repaints on every push');
    assert.equal(
      pageWithoutNonce(renderStepHtml(state, FAKE_SKINS)),
      pageWithoutNonce(renderStepHtml(state, FAKE_SKINS)),
      'and the page itself is a pure function of the state, once the nonce is set aside',
    );
  });

  test('the deliberate exclusions really are excluded, and are the ones documented', () => {
    // These four DO change the page and deliberately do NOT move the key, because the page
    // itself keeps them current between repaints (the dial radio the browser already checked,
    // the skin the client script already applied, the note the client script writes into its
    // own node) or because nothing on the page reads them at all (`progress`). Asserted, not
    // assumed: if one of them ever starts changing from a source other than the page's own
    // controls, this test is where the decision gets revisited.
    const base = stateAt('st-2-file-parse');
    for (const [what, other] of [
      ['dial', stateAt('st-2-file-parse', { dial: 'automated' })],
      ['skin', stateAt('st-2-file-parse', { skin: 'dark' })],
      ['note', stateAt('st-2-file-parse', { note: A_NOTE })],
    ] as const) {
      assert.equal(stepRenderKey(base, FAKE_SKINS), stepRenderKey(other, FAKE_SKINS), `${what} is excluded from the key on purpose`);
      assert.notEqual(
        pageWithoutNonce(renderStepHtml(base, FAKE_SKINS)), pageWithoutNonce(renderStepHtml(other, FAKE_SKINS)),
        `${what} does change the page — which is exactly why the exclusion has to be a decision, not an oversight`,
      );
    }

    // `progress` is the fourth: nothing on the page reads it any more, so it moves neither.
    const withProgress = stateAt('st-2-file-parse');
    withProgress.progress = { ...withProgress.progress, steps: { ...withProgress.progress.steps, 'st-9-invented': { status: 'done' } } };
    assert.equal(stepRenderKey(base, FAKE_SKINS), stepRenderKey(withProgress, FAKE_SKINS));
    assert.equal(
      pageWithoutNonce(renderStepHtml(base, FAKE_SKINS)), pageWithoutNonce(renderStepHtml(withProgress, FAKE_SKINS)),
      'the dial is resolved by the session now, so progress reaches this page through nothing at all',
    );
  });

  test('a plan whose options are not an array does not throw the repaint decision', () => {
    // A throw here would take down a PUSH rather than merely a render — the panel would stop
    // updating and nothing would say why (T-4 security review, finding 5's whole family).
    const state = stateAt('st-2-file-parse');
    state.step.decision.options = poison({ 0: { id: 'author' } });
    assert.doesNotThrow(() => stepRenderKey(state, FAKE_SKINS));
    assert.doesNotThrow(() => stepRenderKey(stateAt('st-2-file-parse'), poison({ ...FAKE_SKINS, SKINS: null })));
  });
});
