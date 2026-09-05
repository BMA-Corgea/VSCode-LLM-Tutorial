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
import { FALLBACK_DIAL, type OptionLike, type PlanLike, type StepLike } from '../../src/walk/model.js';
import { CHECK_NOTE, parseStepMessage, type StepViewState } from '../../src/walk/step-protocol.js';
import {
  AUTHOR_BADGE, FILE_MISSING_MESSAGE, MAX_OPTIONS_RENDERED, MAX_PLAN_TEXT, NOT_TEXT_MESSAGE,
  NO_HISTORY_MESSAGE, T10_BADGE, TRUNCATION_MARKER, UNKNOWN_WHY_SOURCE_MESSAGE,
  optionsOmittedMessage, renderNoticeHtml, renderStepHtml, stepScript,
} from '../../src/walk/step-view.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

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

/** The exact state the real panel hands the view: the current step already resolved. */
function stateAt(id: string, overrides: Partial<StepViewState> = {}): StepViewState {
  const plan = fixturePlan();
  return { plan, progress: fixtureProgress(plan), step: planStep(plan, id), fileExists: true, skin: 'system', ...overrides };
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
  });

  test('the dial renders exactly three radios with the step\'s own override checked', () => {
    // fixtureProgress drags step 2's dial to `scaffolded`.
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    assert.equal(occurrences(html, /<input type="radio" name="dial"/g), 3, 'exactly three dial positions');
    assert.match(html, /id="dial-scaffolded" value="scaffolded" checked>/);
    assert.equal(occurrences(html, / checked>/g), 1, 'one position checked, never two');
  });

  test('a step with no dial recorded falls back to manual — both "no override" shapes', () => {
    // st-1 HAS a progress entry (it is marked done) but no `dial` on it; st-4 has no entry
    // at all. Both mean "nothing has been done to this step", and manual is the one label
    // that cannot overstate that.
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

  test('a step id naming an Object.prototype member still checks exactly one dial', () => {
    // `progress.steps['constructor']` is not `undefined` — it is a function off the prototype.
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const state = stateAt('st-2-file-parse');
      state.step.id = id;

      let html = '';
      assert.doesNotThrow(() => { html = renderStepHtml(state, FAKE_SKINS); }, `step id ${id} threw`);
      assert.match(html, new RegExp(`id="dial-${FALLBACK_DIAL}" value="${FALLBACK_DIAL}" checked>`), `step id ${id}`);
      assert.equal(occurrences(html, / checked>/g), 1, `step id ${id}: one position checked, never none`);
    }
  });

  test('a dial value the plan invented checks FALLBACK_DIAL rather than leaving the fieldset blank', () => {
    const state = stateAt('st-2-file-parse');
    state.progress.steps[state.step.id] = poison({ status: 'pending', dial: 'turbo' });

    const html = renderStepHtml(state, FAKE_SKINS);
    assert.equal(occurrences(html, / checked>/g), 1, 'a fieldset with nothing checked would say nothing at all');
    assert.match(html, new RegExp(`id="dial-${FALLBACK_DIAL}" value="${FALLBACK_DIAL}" checked>`));
    assert.ok(!html.includes('turbo'), 'and the invented value is not echoed as though it were a position');
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
  'step-main', 'step-note', 'btn-prev', 'btn-open', 'btn-check', 'btn-next',
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

  test('an inbound step:note writes the reply into the note node (AC5)', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    const handlers = dom.windowListeners.get('message') ?? [];
    assert.equal(handlers.length, 1, 'the script should register exactly one message listener');
    handlers[0]!({ data: { type: 'step:note', payload: { note: CHECK_NOTE } } });

    assert.equal(dom.elements.get('step-note')!.textContent, CHECK_NOTE);
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

    onMessage!({ data: { type: 'step:note', payload: { note: CHECK_NOTE } } });

    assert.equal(dom.states.length, 1);
    assert.deepEqual(dom.states[0], { stepId: 'st-2-file-parse', note: CHECK_NOTE });
  });

  test('a note saved for THIS step comes back when the torn-down view reloads (AC5)', () => {
    const dom = buildFakeDom({ stepId: 'st-2-file-parse', note: CHECK_NOTE });
    runScript(dom, stateAt('st-2-file-parse'));

    assert.equal(dom.elements.get('step-note')!.textContent, CHECK_NOTE, 'the reply already on screen survives being hidden');
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
    runScript(rendered, stateAt('st-2-file-parse', { note: CHECK_NOTE }));
    assert.equal(rendered.elements.get('step-note')!.textContent, CHECK_NOTE);
    assert.ok(!rendered.elements.get('step-note')!.textContent.includes('already left'));
  });
});
