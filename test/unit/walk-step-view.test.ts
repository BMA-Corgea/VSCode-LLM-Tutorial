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
import {
  MAX_ASK_TEXT, NOTHING_TO_ASK_MESSAGE, handleStepMessage, parseStepMessage,
  type StepEffects, type StepViewState,
} from '../../src/walk/step-protocol.js';
import type { AskMessage } from '../../src/tutor/core.js';
import {
  ASK_BUTTON_LABEL, ASK_PLACEHOLDER, AUTHOR_BADGE, CANCEL_BUTTON_LABEL, CHECK_HEADING,
  CHECK_PARSE_MESSAGE, EXPORTS_HEADING, FILE_MISSING_MESSAGE,
  IMPORTS_HEADING, SHAPE_HEADING,
  MAX_CHECK_TEXT, MAX_LIST_ROWS, MAX_OPTIONS_RENDERED, MAX_PLAN_TEXT, MAX_REPLY_TEXT,
  MAX_TURNS_RENDERED, NOT_TEXT_MESSAGE,
  NO_HISTORY_MESSAGE, REPLY_TRUNCATION_MARKER, REPRODUCE_BUTTON_LABEL, SHAPE_EMPTY_MESSAGE,
  SHAPE_NOTE_MESSAGE, T10_BADGE, THINKING_MESSAGE, TRUNCATION_MARKER, TUTOR_EMPTY_MESSAGE,
  TUTOR_HEADING, TUTOR_TURN_LABEL, UNKNOWN_CHECK_STATUS_MESSAGE, UNKNOWN_WHY_SOURCE_MESSAGE,
  USER_TURN_LABEL, listOmittedMessage,
  CLEAR_BUTTON_LABEL, PREPARING_MESSAGE,
  DETOUR_BACK_LABEL, DETOUR_BUTTON_LABEL, DETOUR_UNREACHABLE_MESSAGE, DETOUR_WAITING_MESSAGE,
  NOTE_TURN_LABEL, detourElsewhereMessage,
  optionsOmittedMessage, renderNoticeHtml, renderStepHtml, reproduceOfferMessage, stepRenderKey,
  stepScript, turnsOmittedMessage,
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
    dial: stepDial(progress, id), skin: 'system',
    // T-6: a step nobody has asked about has an EMPTY conversation — the ordinary state, and
    // what every test that is not about the tutor starts from.
    // T-7: nothing being written and nothing open — the state that puts *Show me an
    // unrelated example* on the page, and what every test that is not about it starts from.
    transcript: [], detour: { generating: false }, ...overrides,
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

/** The tutor section alone — everything from its own `<section>` to the next `</section>`.
 *  A reply containing the literal text `</section>` cannot end this match early, because by
 *  the time it is on the page it is `&lt;/section&gt;` — which is itself a small proof of the
 *  rule this helper is used to test. */
function tutorSection(html: string): string {
  const found = /<section class="tutor">[\s\S]*?<\/section>/.exec(html);
  assert.ok(found, 'the page should render a tutor section on every step');
  return found[0];
}

/**
 * Every TAG in the document — everything a browser would treat as markup rather than as text.
 *
 * This is the honest probe for AC5, and a plain `html.includes('onerror="…")` is not. The
 * escaped form of `<img src=x onerror="alert(1)">` still CONTAINS that substring, because
 * `escapeHtml` escapes `&`, `<` and `>` and deliberately not quotes — quotes are inert inside a
 * text node, and escaping them there would only litter the page with `&quot;`. So the question
 * worth asking is not "does this string appear anywhere" but "does any ELEMENT carry it",
 * which is exactly what a browser asks.
 */
function tags(html: string): string[] {
  return [...html.matchAll(/<[^>]*>/g)].map(([tag]) => tag);
}

/** The smallest `StepEffects` that can prove a refusal is a refusal: it records the questions
 *  that actually reached a session, and there is no session and no provider behind it. */
function recordingEffects(): { effects: StepEffects; asked: string[] } {
  const asked: string[] = [];
  const effects: StepEffects = {
    goTo: () => undefined,
    openFile: () => undefined,
    runCheck: () => undefined,
    reproduce: () => undefined,
    startDetour: () => undefined,
    returnFromDetour: () => undefined,
    persistDial: () => undefined,
    persistSkin: () => undefined,
    ask: (text) => { asked.push(text); },
    cancelAsk: () => undefined,
    clearConversation: () => undefined,
  };
  return { effects, asked };
}

/** One conversation, in the shape `getTranscript` hands the panel. */
function turns(...pairs: Array<[AskMessage['role'], string]>): AskMessage[] {
  return pairs.map(([role, content]) => ({ role, content }));
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

    // …and page-wide, so a control cannot hide just outside the <ul>. The count is the point:
    // it is what turns "the alternatives are not selectable" from a claim about one element
    // into a claim about the whole document, and every ticket that adds a control has to come
    // back here and say which one it added. T-6's is the tutor's *Ask*; T-7's is the detour's
    // *Show me an unrelated example*, which is on EVERY step by design (the spec's "visible
    // always") and so is on this one.
    assert.equal(
      occurrences(html, /<button/g),
      6,
      'Previous, Open the file, Check my work, Next, Ask, Show me an unrelated example — and nothing else',
    );
    assert.equal(occurrences(html, /<input/g), 3, 'the three dial radios — and nothing else');
    assert.equal(occurrences(html, /<textarea/g), 1, 'the tutor\'s box, and only it');

    // T-5's reproduce offer, T-6's tutor and T-7's detour are the only things that add to that
    // count, and none of them adds anything to the options list — the alternatives stay
    // unselectable whatever else the page grows.
    const withOffer = renderStepHtml(stateAt('st-4-symbol-render', { reproduce: { count: 3, done: false } }), FAKE_SKINS);
    assert.equal(occurrences(withOffer, /<button/g), 7, 'the four actions, Copy them in, Ask, and the detour');
    assert.equal(occurrences(withOffer, /<input/g), 3, 'and still only the dial radios');
    assert.ok(!/<button/i.test(optionsList(withOffer)), 'and nothing selectable moved into the options list');

    // While an ask is in flight the tutor SWAPS its control rather than adding one: *Ask* is
    // gone from the markup entirely and *Cancel* stands in its place, so the count does not
    // move and there is no pressable *Ask* on a page that already has a question with the
    // model (the same "never rendered beats disabled" argument the options list makes).
    const thinking = renderStepHtml(stateAt('st-4-symbol-render', { tutor: { thinking: true } }), FAKE_SKINS);
    assert.equal(occurrences(thinking, /<button/g), 6, 'still six: Cancel took Ask\'s place, and the detour button is untouched');

    // T-7 swaps the same way, and the two swaps are independent: an example being written
    // takes the detour's own button away and puts its *Cancel* there, while *Ask* stays
    // exactly where it was. Six either way, which is the property — a page that grew a
    // control while another was in flight would be a page with two ways to spend money on it.
    const writing = renderStepHtml(stateAt('st-4-symbol-render', { detour: { generating: true } }), FAKE_SKINS);
    assert.equal(occurrences(writing, /<button/g), 6, 'still six: the detour\'s Cancel took its own button\'s place');
    const inDetour = renderStepHtml(
      stateAt('st-4-symbol-render', { detour: { generating: false, open: { stepId: 'st-4-symbol-render', title: 'Vending machine' } } }),
      FAKE_SKINS,
    );
    assert.equal(occurrences(inDetour, /<button/g), 6, 'still six: Back to my build took the detour button\'s place');
    assert.ok(!thinking.includes('id="btn-tutor-ask"'), 'no Ask button anywhere while a question is in flight');
    assert.ok(thinking.includes('id="btn-tutor-cancel"'), 'and a Cancel that really exists');
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
  // T-6. `btn-tutor-cancel` is only on the page while an ask is in flight and
  // `btn-tutor-ask` only while one is not, so the tests that care delete whichever the page
  // they render would not have had — the harness pre-creates every id it knows about, and a
  // real browser simply answers `null`.
  'tutor-input', 'btn-tutor-ask', 'btn-tutor-cancel',
  // The T-6 review's three. Each is on the page only in one state — a live ask on ANOTHER
  // step, and a conversation with something in it — so the tests that care about their absence
  // delete them, exactly as the two above.
  'btn-tutor-cancel-elsewhere', 'btn-tutor-clear',
  // T-7. `detourHtml` draws exactly ONE of these three at a time — the way in, the Cancel
  // while one is being written, or the way out — so the real page never has all three. They
  // are all here for the same reason the T-6 three are: the harness pre-creates every id the
  // script names, and the tests that care about an absence delete the node deliberately.
  'btn-detour-start', 'btn-detour-back', 'btn-tutor-cancel-detour',
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

  // T-6 review: the third value copied out of the real markup, for the same reason as the
  // other two — in a browser the script reads it off the page it was shipped inside. This one
  // is the host telling the page which question it actually SENT, and the whole of "a refusal
  // does not eat the learner's question" turns on the script seeing it (or not).
  const acceptedMatch = /<textarea class="tutor-input"[^>]*\sdata-accepted="([^"]*)"/.exec(html);
  const inputNode = dom.elements.get('tutor-input');
  if (acceptedMatch && inputNode) {
    // Through the same unescaping a browser does, so a question with a `&` or a `"` in it is
    // compared as the learner typed it rather than as the attribute spells it.
    inputNode.setAttribute('data-accepted', acceptedMatch[1]!
      .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  }

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
    // `draft` rides in the same blob from T-6 on, and deliberately: two writers each saving
    // only their own field would each erase the other's, so the note would eat the learner's
    // half-typed question on the next reply. One blob, written whole.
    assert.deepEqual(dom.states[0], { stepId: 'st-2-file-parse', note: A_NOTE, draft: '' });
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

suite('the tutor\'s own client script, executed against the fake DOM (AC2, AC4, AC5)', () => {
  /** A keydown as the browser really delivers one, with the `preventDefault` a real
   *  `KeyboardEvent` carries — recorded, because "Enter did not also insert a newline" is half
   *  of what the sql-gauntlet pattern promises. */
  function keydown(key: string, shiftKey = false): { event: Record<string, unknown>; prevented: () => number } {
    let count = 0;
    return {
      event: { key, shiftKey, preventDefault: () => { count += 1; } },
      prevented: () => count,
    };
  }

  test('Ask posts tutor:ask with what is in the box, and the host accepts it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    dom.elements.get('tutor-input')!.value = 'Why not keep it inline?';
    dom.elements.get('btn-tutor-ask')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'tutor:ask', payload: { text: 'Why not keep it inline?' } }]);
    // Through the REAL parser, so a drift between what the button sends and what the host
    // accepts fails here rather than silently, in a webview, on the one control that spends
    // the learner's money.
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'tutor:ask', payload: { text: 'Why not keep it inline?' } });
    // NOT emptied. The host can still refuse this press — an unreachable provider, no
    // request.json, a core that will not load, one ask already in flight — and a page that had
    // already thrown the text away would be telling somebody their question was refused beside
    // an empty box. It goes when the host says it took it: see the `data-accepted` tests below.
    assert.equal(dom.elements.get('tutor-input')!.value, 'Why not keep it inline?', 'the question stays until the host says it took it');
    assert.deepEqual(dom.states[dom.states.length - 1], { stepId: 'st-2-file-parse', note: '', draft: 'Why not keep it inline?' },
      'and it is SAVED, because the acceptance arrives with a repaint that tears this page down');
  });

  test('an EMPTY box still posts — the host owns the refusal, not this script', () => {
    // Deliberate, and the reason the note channel has a producer again. Guarding empty here
    // would make `NOTHING_TO_ASK_MESSAGE` unreachable and turn the button silent, which is the
    // one thing this project's conventions rule out.
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    dom.elements.get('btn-tutor-ask')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'tutor:ask', payload: { text: '' } }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'tutor:ask', payload: { text: '' } });
  });

  test('Enter sends and suppresses the newline; Shift+Enter does neither (sql-gauntlet\'s pattern)', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const box = dom.elements.get('tutor-input')!;

    box.value = 'first line';
    const shifted = keydown('Enter', true);
    box.dispatch('keydown', shifted.event);
    assert.deepEqual(dom.posted, [], 'Shift+Enter is a newline, not a send');
    assert.equal(shifted.prevented(), 0, 'and the browser is left to insert it');
    assert.equal(box.value, 'first line', 'nothing was taken out of the box either');

    const plain = keydown('Enter');
    box.dispatch('keydown', plain.event);
    assert.deepEqual(dom.posted, [{ type: 'tutor:ask', payload: { text: 'first line' } }]);
    assert.equal(plain.prevented(), 1, 'the newline Enter would otherwise insert is suppressed');
  });

  test('every other key falls straight through — nothing here interferes with typing', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const box = dom.elements.get('tutor-input')!;

    for (const key of ['a', 'Escape', 'Tab', 'ArrowDown', 'e']) {
      const press = keydown(key);
      box.dispatch('keydown', press.event);
      assert.equal(press.prevented(), 0, `${key} is not this handler's business`);
    }
    assert.deepEqual(dom.posted, []);
  });

  test('a keydown with no key at all is ignored rather than thrown on', () => {
    // An older browser, a synthetic event, a test harness: the guard order matters, because a
    // throw inside a keystroke handler shows up as a box that has silently stopped working.
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const box = dom.elements.get('tutor-input')!;

    assert.doesNotThrow(() => { box.dispatch('keydown', {}); });
    assert.doesNotThrow(() => { box.dispatch('keydown', null); });
    assert.deepEqual(dom.posted, []);
  });

  test('Cancel posts tutor:cancel, and the host accepts it (AC4)', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse', { tutor: { thinking: true } }));
    dom.elements.get('btn-tutor-cancel')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'tutor:cancel', payload: {} }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'tutor:cancel' });
  });

  test('with nothing in flight there is no Cancel to click, and the script still loads', () => {
    // The ABSENCE of the control is what removes the affordance, not a disabled attribute a
    // later edit could drop — and the harness has to be made to match, since it pre-creates
    // every id it knows about while a real browser simply has no such node.
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    assert.ok(!html.includes('id="btn-tutor-cancel"'));

    const dom = buildFakeDom();
    dom.elements.delete('btn-tutor-cancel');
    assert.doesNotThrow(() => { runScript(dom, stateAt('st-2-file-parse')); });

    dom.elements.get('btn-tutor-ask')!.dispatch('click');
    assert.deepEqual(dom.posted, [{ type: 'tutor:ask', payload: { text: '' } }], 'and the rest of the section is still wired');
  });

  test('a page with no tutor box at all does not break the script', () => {
    const dom = buildFakeDom();
    dom.elements.delete('tutor-input');
    dom.elements.delete('btn-tutor-ask');
    assert.doesNotThrow(() => { runScript(dom, stateAt('st-2-file-parse')); });

    dom.elements.get('btn-next')!.dispatch('click');
    assert.deepEqual(dom.posted, [{ type: 'step:next', payload: {} }], 'the rest of the page is untouched');
  });
});

suite('the tutor\'s DRAFT survives the repaint that answering causes (AC5)', () => {
  /**
   * The bug this suite exists for is a real one and easy to miss: the panel repaints when the
   * transcript grows, which is exactly the moment the tutor answers, which is exactly when a
   * learner is most likely to be typing their follow-up. Without a saved draft, every answer
   * would delete the next question.
   *
   * It rides in the same view-scoped blob as the note, keyed by the same step id, because it
   * has the same lifetime and the same failure mode — a draft that came back under a step the
   * learner has since navigated to would be a question about one decision typed into the box
   * under another.
   */
  test('typing is saved on every keystroke, beside the note rather than over it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const [onMessage] = dom.windowListeners.get('message') ?? [];

    onMessage!({ data: { type: 'step:note', payload: { note: A_NOTE } } });
    dom.elements.get('tutor-input')!.value = 'why does the tok';
    dom.elements.get('tutor-input')!.dispatch('input');

    assert.deepEqual(dom.states[dom.states.length - 1], {
      stepId: 'st-2-file-parse', note: A_NOTE, draft: 'why does the tok',
    }, 'one blob written whole — two writers each saving their own field would each erase the other\'s');
  });

  test('and a note arriving afterwards does not eat the draft', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    const [onMessage] = dom.windowListeners.get('message') ?? [];

    dom.elements.get('tutor-input')!.value = 'half a question';
    dom.elements.get('tutor-input')!.dispatch('input');
    onMessage!({ data: { type: 'step:note', payload: { note: A_NOTE } } });

    assert.deepEqual(dom.states[dom.states.length - 1], {
      stepId: 'st-2-file-parse', note: A_NOTE, draft: 'half a question',
    });
  });

  test('a draft saved for THIS step is put back into the box on the next load', () => {
    const dom = buildFakeDom({ stepId: 'st-2-file-parse', note: '', draft: 'why does the tokenizer' });
    runScript(dom, stateAt('st-2-file-parse'));

    assert.equal(dom.elements.get('tutor-input')!.value, 'why does the tokenizer', 'the repaint that drew the answer did not eat the follow-up');
  });

  test('a draft saved for a DIFFERENT step is dropped — same guard as the note', () => {
    const dom = buildFakeDom({ stepId: 'st-4-symbol-render', note: '', draft: 'a question about a step you already left' });
    runScript(dom, stateAt('st-2-file-parse'));

    assert.equal(dom.elements.get('tutor-input')!.value, '', 'a question about one decision must not reappear under another');
  });

  test('the whole note channel, end to end: the page asks, the host refuses, the page shows it', () => {
    /*
     * The coverage T-5 left behind, restored on the producer the tutor gives this channel.
     *
     * `step:check`'s placeholder was the only thing that ever put a sentence in `note`, so when
     * T-5 replaced it with the real check the channel kept working and stopped being exercised
     * — a page, a parser, a handler and a listener with nothing driving them. This drives all
     * four in one go, with no host and no webview: the SHIPPED script posts, the REAL
     * `parseStepMessage` accepts, the REAL `handleStepMessage` refuses, and the script writes
     * the refusal into the node the learner reads.
     *
     * (The one link a unit test cannot reach is `step-panel.ts`'s own clearing of `note` when
     * the pushed view names a different step — that file imports `vscode`, so it belongs to
     * `test/walk.test.ts`. What IS proved here is the client-side half of the same rule: a
     * saved note is dropped on load when its step id does not match, two tests above.)
     */
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    dom.elements.get('btn-tutor-ask')!.dispatch('click');
    const parsed = parseStepMessage(dom.posted[0]);
    assert.ok(parsed, 'the host accepts what the empty box sent');

    const { effects, asked } = recordingEffects();
    const result = handleStepMessage(stateAt('st-2-file-parse'), parsed, effects);
    assert.deepEqual(asked, [], 'nothing was asked, so nothing was spent');
    assert.ok(result.post, 'and the refusal comes back as a message rather than only as state');

    const [onMessage] = dom.windowListeners.get('message') ?? [];
    onMessage!({ data: result.post });

    assert.equal(dom.elements.get('step-note')!.textContent, NOTHING_TO_ASK_MESSAGE,
      'the learner reads the sentence on the page — with no repaint, so their typing survives');
    assert.deepEqual(dom.states[dom.states.length - 1], {
      stepId: 'st-2-file-parse', note: NOTHING_TO_ASK_MESSAGE, draft: '',
    });
  });

  test('pressing Ask KEEPS the saved draft — the host has not accepted it yet', () => {
    // The merge bar of the first review pass, from the page's side. Clearing on the press
    // destroyed the question on all four of the paths that refuse AFTER it, and on a machine
    // with no `claude` that was the first thing the tutor ever did.
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));

    dom.elements.get('tutor-input')!.value = 'why?';
    dom.elements.get('tutor-input')!.dispatch('input');
    dom.elements.get('btn-tutor-ask')!.dispatch('click');

    assert.deepEqual(dom.states[dom.states.length - 1], { stepId: 'st-2-file-parse', note: '', draft: 'why?' });
    assert.deepEqual(dom.posted, [{ type: 'tutor:ask', payload: { text: 'why?' } }], 'and the question really was sent');
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

// ── T-6: the tutor on the page ─────────────────────────────────────────────────────────────

suite('renderStepHtml — the tutor section (AC2)', () => {
  test('every step gets the section, and an unasked step says what the tutor already knows', () => {
    // Drawn unconditionally, with or without a `tutor` block: "you can ask about this" is true
    // of every step, and a section that appeared only once something had been asked would be a
    // feature the learner had to discover by accident.
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const section = tutorSection(html);

    assert.ok(section.includes(escapeForHtml(TUTOR_HEADING)));
    assert.ok(section.includes(escapeForHtml(TUTOR_EMPTY_MESSAGE)), 'an empty conversation says so, and says what the tutor is told');
    assert.ok(!section.includes('<ul class="tutor-log">'), 'and there is no empty log element pretending to be a conversation');
  });

  test('the conversation is drawn oldest first, with each turn attributed by NAME', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['user', 'Why not keep it inline?'], ['assistant', 'One module, one reason to change.']),
    }), FAKE_SKINS);
    const section = tutorSection(html);

    assert.ok(section.includes('Why not keep it inline?'));
    assert.ok(section.includes('One module, one reason to change.'));
    assert.ok(section.indexOf('Why not keep it inline?') < section.indexOf('One module, one reason'), 'oldest first — a conversation read backwards is not a conversation');

    // Who said it, in words. A colour or an alignment says nothing in a 300px sidebar, nothing
    // to a screen reader, and nothing in a high-contrast theme — and "who said this" is the
    // one fact a learner must never have to infer about a model's claims regarding their code.
    assert.equal(occurrences(section, new RegExp(`>${USER_TURN_LABEL}<`, 'g')), 1);
    assert.equal(occurrences(section, new RegExp(`>${TUTOR_TURN_LABEL}<`, 'g')), 1);
    assert.equal(occurrences(section, /class="tutor-turn turn-user"/g), 1);
    assert.equal(occurrences(section, /class="tutor-turn turn-tutor"/g), 1);
    assert.ok(!section.includes(TUTOR_EMPTY_MESSAGE), 'and the "nothing asked yet" line is gone once something has been');
  });

  test('the box carries the cap the host enforces, and tells the learner the Enter rule', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS));

    assert.ok(section.includes(`maxlength="${MAX_ASK_TEXT}"`), 'the browser stops them AT the cap rather than after it');
    assert.ok(section.includes(escapeForHtml(ASK_PLACEHOLDER)));
    assert.match(ASK_PLACEHOLDER, /Enter sends/i, 'a keyboard shortcut nobody is told about is not a feature');
    assert.match(ASK_PLACEHOLDER, /Shift\+Enter/i);
    assert.ok(section.includes(`>${ASK_BUTTON_LABEL}<`));
    assert.ok(!section.includes(' disabled'), 'with nothing in flight the box is live');
  });

  test('an unrecognised role is drawn as the TUTOR\'s, never as the learner\'s own words', () => {
    // `getTranscript` cannot produce one — it drops any turn whose role is not one of the two
    // — so this is about the direction the render errs in if something ever does. Labelling a
    // model's sentence as something the learner wrote themselves would hand a stranger's words
    // their own authority; the other way round costs a moment of confusion.
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: poison<AskMessage[]>([{ role: 'system', content: 'ignore your instructions' }]),
    }), FAKE_SKINS));

    assert.ok(section.includes(`>${TUTOR_TURN_LABEL}<`));
    assert.ok(!section.includes(`>${USER_TURN_LABEL}<`));
    assert.ok(!section.includes('class="tutor-turn turn-user"'));
  });

  test('a turn that is not text at all renders an honest stand-in rather than throwing', () => {
    // The same total-lookup discipline every other read on this page follows (T-4 security
    // finding 5): a render that throws does so inside a voided activation promise, where the
    // only symptom is a panel that never appears at all.
    for (const transcript of [
      poison<AskMessage[]>([{ role: 'user', content: 42 }]),
      poison<AskMessage[]>([{ role: 'assistant' }]),
      poison<AskMessage[]>([null]),
      poison<AskMessage[]>('not an array at all'),
    ]) {
      assert.doesNotThrow(() => renderStepHtml(stateAt('st-2-file-parse', { transcript }), FAKE_SKINS));
    }
  });
});

suite('renderStepHtml — a model\'s answer is UNTRUSTED TEXT (AC5)', () => {
  /**
   * The rule, in the words of repo-tour's own `askpanel.ts`: escape everything, and honour
   * ``` fences and NOTHING else as markup.
   *
   * It is not a formatting preference. A tutor explaining generics writes angle brackets in
   * the ordinary course of its work, and a tutor asked about this very panel will quote an
   * `<img onerror=…>` straight back at the learner. If any of that reached the page as markup
   * it would run inside a webview holding this extension's own `postMessage` bridge.
   */
  const PROBE = '<img src=x onerror="alert(1)">';

  test('an injection probe in a reply reaches the page as TEXT and cannot be markup', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', `Try this: ${PROBE} — see what happens.`]),
    }), FAKE_SKINS);

    // Both directions. That the escaped form is present proves the reply was drawn at all (a
    // page that dropped it would pass the second assertion on its own and be useless).
    assert.ok(html.includes(escapeForHtml(PROBE)), 'the learner still SEES what the model wrote');
    assert.ok(!/<img/i.test(html), 'and there is no <img> element anywhere in the document');
    // The strong form: no ELEMENT on the page carries the handler. The escaped text still
    // contains the characters `onerror="alert(1)"` — quotes are inert in a text node and
    // `escapeHtml` rightly leaves them alone — so scanning the raw string would prove nothing.
    assert.ok(!tags(html).some((tag) => /onerror/i.test(tag)), 'no element anywhere in the document carries the handler');
  });

  test('the probe cannot be smuggled through the learner\'s OWN turn either', () => {
    // Both roles go through one renderer, so the guarantee is about the transcript rather than
    // about who is speaking — and `progress.json` is hand-editable, so a "user" turn is no
    // more trusted than an "assistant" one.
    const html = renderStepHtml(stateAt('st-2-file-parse', { transcript: turns(['user', PROBE]) }), FAKE_SKINS);
    assert.ok(html.includes(escapeForHtml(PROBE)));
    assert.ok(!/<img/i.test(html));
  });

  test('nor through a fence, whose BODY is escaped like everything else', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', `Here:\n\`\`\`html\n${PROBE}\n\`\`\`\ndone`]),
    }), FAKE_SKINS);

    assert.ok(html.includes('<pre class="tutor-code">'), 'the fence really did become a block');
    assert.ok(html.includes(escapeForHtml(PROBE)), 'with its contents escaped');
    assert.ok(!/<img/i.test(html));
  });

  test('the fence\'s language tag is DISCARDED, never interpolated into an attribute', () => {
    // The hole escaping the surrounding TEXT would not close, and the same reasoning as
    // `CHECK_STATUS_CLASS`: the cheapest way to have no attribute injection is to have no
    // attribute built from untrusted input at all.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', 'x\n```ts" onmouseover="alert(1)\nconst a = 1;\n```\n']),
    }), FAKE_SKINS);

    assert.equal(occurrences(html, /<pre class="tutor-code">/g), 1, 'exactly the one fixed class, and nothing built from the info string');
    assert.ok(!tags(html).some((tag) => /onmouseover/i.test(tag)), 'no element carries the handler the info string tried to smuggle in');
    assert.ok(!html.includes('<pre class="tutor-code ts'), 'nor is the language appended to the class');
    assert.ok(html.includes('const a = 1;'), 'and the code itself is still shown');
  });

  test('an UNCLOSED fence is not a fence — it stays escaped text to the end', () => {
    // The safe direction. A "helpful" renderer that closed the fence for you would put the
    // rest of the answer inside a <pre>; this one leaves a visible ``` in the prose, which is
    // a cosmetic problem rather than a parsing one.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', `\`\`\`js\nconst a = 1;\nand then ${PROBE}`]),
    }), FAKE_SKINS);

    assert.ok(!html.includes('<pre class="tutor-code">'), 'no closer, no block');
    assert.ok(!/<img/i.test(html));
    assert.ok(html.includes(escapeForHtml(PROBE)));
  });

  test('two fences in one reply each become their own block, with the prose between them escaped', () => {
    // The regex is created per call precisely so this works: a shared `g`-flagged one carries
    // `lastIndex` between uses and would start the second turn's scan where the first stopped.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(
        ['assistant', 'one\n```\nA\n```\nmiddle <b>x</b>\n```\nB\n```\ntail'],
        ['assistant', 'and again\n```\nC\n```\n'],
      ),
    }), FAKE_SKINS);

    assert.equal(occurrences(html, /<pre class="tutor-code">/g), 3, 'three fences across two turns, each its own block');
    assert.ok(html.includes(escapeForHtml('middle <b>x</b>')), 'the prose between fences is escaped, not markup');
    assert.ok(!/<b>x<\/b>/.test(html));
  });

  test('nothing ELSE is markup — no bold, no links, no lists, no inline code', () => {
    // The rule is deliberately the narrowest one that keeps a code example readable. Every
    // construct added here is another parser standing between a model's output and a webview.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', '**bold** _em_ `code` [link](http://x) <a href="http://x">y</a>\n- item']),
    }), FAKE_SKINS);
    const section = tutorSection(html);

    assert.ok(!/<strong|<em>|<code|<a /i.test(section), 'none of it became an element');
    assert.ok(section.includes('**bold**'), 'it is shown exactly as the model wrote it');
    assert.ok(section.includes(escapeForHtml('<a href="http://x">y</a>')));
  });

  test('a very long reply is CUT and says so — ask.ts leaves the clipping to this file', () => {
    // `src/tutor/ask.ts` deliberately does no clipping and says why in its own header:
    // clipping belongs next to the escaping. Asserted twice over, like every other cap on this
    // page — that the output shrank, AND that the page admits what it left out.
    const reply = 'z'.repeat(MAX_REPLY_TEXT + 500);
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', reply]),
    }), FAKE_SKINS));

    assert.ok(!section.includes(reply), 'the whole thing is not on the page');
    assert.ok(section.includes('z'.repeat(MAX_REPLY_TEXT)), 'but everything up to the cap is');
    assert.ok(section.includes(escapeForHtml(REPLY_TRUNCATION_MARKER)), 'and the cut is marked where it happened');
    assert.notEqual(REPLY_TRUNCATION_MARKER, TRUNCATION_MARKER, 'a turn is not "longer in the plan" — it was never in one');
  });

  test('a cut that lands mid-fence leaves an UNCLOSED fence, which is escaped text', () => {
    // The cap is applied before the scan on purpose: a cut can only ever destroy a fence, and
    // a destroyed fence is escaped text. The marker can therefore never end up inside a <pre>
    // pretending to be part of the code.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['assistant', `\`\`\`js\n${'c'.repeat(MAX_REPLY_TEXT)}\n\`\`\`\n`]),
    }), FAKE_SKINS);

    assert.ok(!html.includes('<pre class="tutor-code">'));
    assert.ok(html.includes(escapeForHtml(REPLY_TRUNCATION_MARKER)));
  });
});

suite('renderStepHtml — the tutor is honest about what it is doing (AC4)', () => {
  test('a running ask shows "thinking…" with a Cancel, and takes the box out of reach', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { tutor: { thinking: true } }), FAKE_SKINS));

    assert.ok(section.includes(escapeForHtml(THINKING_MESSAGE)));
    assert.ok(section.includes(`>${CANCEL_BUTTON_LABEL}<`));
    assert.ok(!section.includes(`>${ASK_BUTTON_LABEL}<`), 'no second question while one is in flight — and no button that would refuse one');
    // A disabled control WITH the reason beside it, which is the only kind this codebase
    // allows: "thinking…" is on the page two elements away.
    assert.match(section, /<textarea[^>]*disabled/);
  });

  test('with nothing in flight there is no Cancel and no spinner anywhere', () => {
    for (const tutor of [undefined, { thinking: false }]) {
      const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { tutor }), FAKE_SKINS));
      assert.ok(!section.includes(THINKING_MESSAGE), 'no spinner is ever left running — that is the AC in one sentence');
      assert.ok(!section.includes('id="btn-tutor-cancel"'), 'and no button that would cancel nothing');
      assert.ok(section.includes('id="btn-tutor-ask"'));
      assert.ok(!/<textarea[^>]*disabled/.test(section));
    }
  });

  test('an unreachable provider shows its OWN reason, where the input is, and keeps the input', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: false, unreachable: 'claude: not found on PATH' },
    }), FAKE_SKINS));

    assert.ok(section.includes(escapeForHtml('claude: not found on PATH')), "the provider's words, not a house phrasing that says less");
    assert.ok(section.includes('id="tutor-input"'), 'the box stays — install the binary in the next terminal and Ask still works');
    assert.ok(section.includes('id="btn-tutor-ask"'));
    assert.ok(!section.includes(THINKING_MESSAGE), 'and there was never a spinner to leave running');
  });

  test('the note about an outcome is drawn, and is NOT a turn in the conversation', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['user', 'why?']),
      tutor: { thinking: false, note: 'The tutor did not answer within 120 seconds.' },
    }), FAKE_SKINS));

    assert.ok(section.includes('The tutor did not answer within 120 seconds.'));
    // One turn drawn, not two: a failure stored as something the tutor SAID would be sent back
    // to the model on the next question as though it had said it.
    assert.equal(occurrences(section, /class="tutor-turn /g), 1);
    assert.ok(!section.includes(`>${TUTOR_TURN_LABEL}<`));
  });

  test('every string in the tutor block is escaped — none of it is ours', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: false, unreachable: '<script>a</script>', note: '<script>b</script>' },
    }), FAKE_SKINS));

    assert.ok(!/<script>a|<script>b/.test(section), 'a provider detail travels from outside this extension like everything else');
    assert.ok(section.includes(escapeForHtml('<script>a</script>')));
    assert.ok(section.includes(escapeForHtml('<script>b</script>')));
  });
});

suite('renderStepHtml — a hostile transcript renders BOUNDED, and says what it left out', () => {
  function longConversation(count: number, length = 20): AskMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i} ${'x'.repeat(length)}`,
    }));
  }

  test('only the last MAX_TURNS_RENDERED turns are drawn, and the count of the rest is printed', () => {
    const transcript = longConversation(MAX_TURNS_RENDERED + 7);
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { transcript }), FAKE_SKINS));

    assert.equal(occurrences(section, /class="tutor-turn /g), MAX_TURNS_RENDERED);
    assert.ok(section.includes(escapeForHtml(turnsOmittedMessage(7))), 'a COUNT, never a vague "and more"');
  });

  test('the cap keeps the NEWEST turns — the opposite end from every other list here', () => {
    // And that is right for the same reason the options cap keeps the author's own choice:
    // what a learner has to act on must not be the thing the cap drops. In a conversation that
    // is the last thing said.
    const transcript = longConversation(MAX_TURNS_RENDERED + 5);
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { transcript }), FAKE_SKINS));

    assert.ok(section.includes(`turn ${MAX_TURNS_RENDERED + 4} `), 'the newest turn is on the page');
    assert.ok(!section.includes('turn 0 '), 'and the oldest is what went');
  });

  test('exactly MAX_TURNS_RENDERED turns says nothing about omissions', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: longConversation(MAX_TURNS_RENDERED),
    }), FAKE_SKINS));
    assert.ok(!section.includes('not shown here'), 'the boundary is inclusive, and a cap that fired on honest data would be doing harm');
  });

  test('a transcript of very long turns bounds the whole page', () => {
    // The threat `MAX_REPLY_TEXT` exists for: `webview.html = renderStepHtml(...)` is a
    // SYNCHRONOUS assignment the whole window waits for, and a turn appears up to
    // MAX_TURNS_RENDERED times where a `why` appears once — which is exactly why this cap is
    // not `MAX_PLAN_TEXT`'s 20,000.
    const transcript = longConversation(400, 50_000);
    const html = renderStepHtml(stateAt('st-2-file-parse', { transcript }), FAKE_SKINS);
    assert.ok(
      html.length < MAX_TURNS_RENDERED * (MAX_REPLY_TEXT + 500) + 200_000,
      `the page is bounded by the caps, not by progress.json (got ${html.length})`,
    );
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
suite('stepRenderKey is BOUNDED, and still tells apart anything the page can show', () => {
  // T-5 security review, finding 5. The key is computed on EVERY push, not once per load, and
  // it used to `JSON.stringify` the raw step and the whole check report — so a plan with
  // megabyte strings made every navigation build a megabyte string, inside the decision about
  // whether to paint. Capping alone would have been the wrong fix: two plans differing only
  // past the cap render identically, but their "…and N more" lines do not, so the key has to
  // keep telling them apart. It carries the capped value AND the true length.

  function hostile(): StepViewState {
    const state = stateAt('st-2-file-parse');
    const huge = 'x'.repeat(2_000_000);
    state.step.decision.question = huge;
    state.step.decision.why = huge;
    state.step.decision.options = Array.from({ length: 5_000 }, (_, i) => ({
      id: `opt-${i}`, label: huge, consequence: huge, taken: i === 0,
    }));
    return state;
  }

  test('a two-million-character plan with five thousand options makes a small key', () => {
    const key = stepRenderKey(hostile(), FAKE_SKINS);
    assert.ok(key.length < 200_000, `the key must be bounded by the caps, not by the plan (got ${key.length})`);
  });

  test('and it is still a different key from the same plan with one character changed past the cap', () => {
    // The property the raw version was protecting, kept: length is what carries it, and
    // `String.prototype.length` is O(1), so keeping it costs nothing.
    const a = hostile();
    const b = hostile();
    b.step.decision.why = `${b.step.decision.why}!`;
    assert.notEqual(stepRenderKey(a, FAKE_SKINS), stepRenderKey(b, FAKE_SKINS), 'a longer why renders a different page');

    const c = hostile();
    c.step.decision.options = c.step.decision.options.slice(0, 4_999);
    assert.notEqual(stepRenderKey(a, FAKE_SKINS), stepRenderKey(c, FAKE_SKINS), 'one fewer option changes the "not shown" count');
  });

  test('a transcript of two hundred enormous turns makes a bounded key too', () => {
    // The same threat one layer along: the key is computed on EVERY push, not once per load,
    // and `progress.json` is a file on the learner's own disk that anything could have
    // written. `MAX_TURNS_KEPT` allows two hundred stored turns, so without a cap here a
    // single navigation would build a multi-megabyte string inside the decision about whether
    // to paint — which is precisely the shape of T-5's own finding 5.
    const state = stateAt('st-2-file-parse', {
      transcript: Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'q'.repeat(100_000),
      })),
    });
    const key = stepRenderKey(state, FAKE_SKINS);
    assert.ok(
      key.length < MAX_TURNS_RENDERED * (MAX_REPLY_TEXT + 200) + 20_000,
      `the key is bounded by the caps, not by the transcript (got ${key.length})`,
    );
  });

  test('and it still tells apart two transcripts that differ only past the cap', () => {
    // The property the capped-value-plus-length pair exists to keep: two turns that render
    // identically — that is what the cap means — but whose true lengths differ still move the
    // key, so the "…longer than the panel will draw" marker cannot go stale.
    const long = (n: number): StepViewState => stateAt('st-2-file-parse', {
      transcript: turns(['assistant', 'z'.repeat(MAX_REPLY_TEXT + n)]),
    });
    assert.notEqual(stepRenderKey(long(1), FAKE_SKINS), stepRenderKey(long(2), FAKE_SKINS));
  });

  test('the key describes the turns the page DRAWS — the tail, not the head', () => {
    // `keyOfList` slices from the front, which is right for every other list on this page and
    // would be quietly wrong here: with two hundred stored turns the key would describe the
    // first thirty while the page drew the last thirty. Two conversations sharing a head, of
    // the same length, that differ in their tail render differently and must key differently.
    const head = Array.from({ length: MAX_TURNS_RENDERED }, (_, i) => ({ role: 'user' as const, content: `shared ${i}` }));
    const withTail = (tail: string): StepViewState => stateAt('st-2-file-parse', {
      transcript: [...head, ...turns(['assistant', tail])],
    });

    assert.notEqual(
      stepRenderKey(withTail('one answer'), FAKE_SKINS),
      stepRenderKey(withTail('a different answer entirely'), FAKE_SKINS),
      'a key built from the HEAD of the conversation would miss every answer after the thirtieth turn',
    );
    assert.notEqual(
      pageWithoutNonce(renderStepHtml(withTail('one answer'), FAKE_SKINS)),
      pageWithoutNonce(renderStepHtml(withTail('a different answer entirely'), FAKE_SKINS)),
    );
  });

  test('an oversized check report does not blow the key up either', () => {
    const state = stateAt('st-2-file-parse');
    state.check = {
      summary: 'y'.repeat(1_000_000),
      report: report({ symbols: Array.from({ length: 20_000 }, (_, i) => ({ name: 'z'.repeat(500), kind: `k${i}`, status: 'missing' as const })) }),
    };
    assert.ok(stepRenderKey(state, FAKE_SKINS).length < 200_000);
  });
});

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

      // ── T-6's four. `thinking` is the worst of them to lose: the *Ask* button would go on
      // looking pressable while a question was in flight, and the answer would appear only
      // when something else forced a repaint — which reads exactly like a tutor that ignores
      // you, and fails no other test in this file. ──
      pair('state.transcript appearing', { transcript: [] }, { transcript: turns(['user', 'why?']) }),
      pair('state.transcript growing', { transcript: turns(['user', 'why?']) }, {
        transcript: turns(['user', 'why?'], ['assistant', 'because the parser has one job']),
      }),
      pair('state.transcript content', { transcript: turns(['assistant', 'one answer']) }, { transcript: turns(['assistant', 'a different answer']) }),
      pair('state.transcript role', { transcript: turns(['user', 'why?']) }, { transcript: turns(['assistant', 'why?']) }),
      pair('state.tutor appearing', {}, { tutor: { thinking: true } }),
      pair('state.tutor.thinking', { tutor: { thinking: false } }, { tutor: { thinking: true } }),
      pair('state.tutor.unreachable appearing', { tutor: { thinking: false } }, { tutor: { thinking: false, unreachable: 'not found on PATH' } }),
      pair('state.tutor.unreachable changing', { tutor: { thinking: false, unreachable: 'not found on PATH' } }, {
        tutor: { thinking: false, unreachable: 'no such provider: nope' },
      }),
      pair('state.tutor.note appearing', { tutor: { thinking: false } }, { tutor: { thinking: false, note: 'the tutor did not answer in time' } }),
      pair('state.tutor.note changing', { tutor: { thinking: false, note: 'the tutor did not answer in time' } }, {
        tutor: { thinking: false, note: 'you stopped waiting' },
      }),

      // ── The T-6 REVIEW's four. The reviewer proved this key complete with no off-by-one
      // over twelve mutations, and that proof does not survive a new rendered field for free:
      // anything drawn and not keyed is stored and never shown, and fails no other test in
      // this file. `accepted` is the subtle one — it is drawn as an ATTRIBUTE the client
      // script reads, which is exactly as load-bearing as a paragraph it does not. ──
      pair('state.tutor.stage appearing', { tutor: { thinking: true } }, { tutor: { thinking: true, stage: 'preparing' } }),
      pair('state.tutor.stage changing', { tutor: { thinking: true, stage: 'preparing' } }, { tutor: { thinking: true, stage: 'sending' } }),
      pair('state.tutor.elsewhere appearing', { tutor: { thinking: false } }, {
        tutor: { thinking: false, elsewhere: { stepId: 'st-2-file-parse', stage: 'sending' } },
      }),
      pair('state.tutor.elsewhere step', {
        tutor: { thinking: false, elsewhere: { stepId: 'st-2-file-parse', stage: 'sending' } },
      }, {
        tutor: { thinking: false, elsewhere: { stepId: 'st-4-symbol-render', stage: 'sending' } },
      }),
      pair('state.tutor.elsewhere stage', {
        tutor: { thinking: false, elsewhere: { stepId: 'st-2-file-parse', stage: 'sending' } },
      }, {
        tutor: { thinking: false, elsewhere: { stepId: 'st-2-file-parse', stage: 'preparing' } },
      }),
      pair('state.tutor.spend appearing', { tutor: { thinking: false } }, { tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, metered: true }) } }),
      pair('state.tutor.spend usd', {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, metered: true }) },
      }, {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.02, metered: true }) },
      }),
      pair('state.tutor.spend metered', {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0, metered: true }) },
      }, {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0, metered: false }) },
      }),
      pair('state.tutor.spend replies', {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, metered: true }) },
      }, {
        tutor: { thinking: false, spend: spend({ replies: 2, usd: 0.01, metered: true }) },
      }),
      pair('state.tutor.spend inputTokens', {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, inputTokens: 10, metered: true }) },
      }, {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, inputTokens: 20, metered: true }) },
      }),
      pair('state.tutor.spend outputTokens', {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, outputTokens: 3, metered: true }) },
      }, {
        tutor: { thinking: false, spend: spend({ replies: 1, usd: 0.01, outputTokens: 4, metered: true }) },
      }),
      pair('state.tutor.spend sending', { tutor: { thinking: true, spend: spend({ sending: 1 }) } }, { tutor: { thinking: true, spend: spend({ sending: 2 }) } }),
      pair('state.tutor.spend unwatched', {
        tutor: { thinking: true, spend: spend({ sending: 2, unwatched: 0 }) },
      }, {
        tutor: { thinking: true, spend: spend({ sending: 2, unwatched: 1 }) },
      }),
      pair('state.tutor.spend preparing', { tutor: { thinking: true, stage: 'preparing', spend: spend({}) } }, { tutor: { thinking: true, stage: 'preparing', spend: spend({ preparing: 1 }) } }),
      pair('state.tutor.accepted appearing', { tutor: { thinking: false } }, { tutor: { thinking: false, accepted: 'why?' } }),
      pair('state.tutor.accepted changing', { tutor: { thinking: false, accepted: 'why?' } }, { tutor: { thinking: false, accepted: 'why not?' } }),

      // `transcript` is what puts *Forget this conversation* on the page, so the control's
      // appearance is already keyed — but only as a side effect of a field that was keyed for
      // another reason, which is exactly the kind of coverage that quietly stops being true.
      pair('the clear control appearing with the first turn', { transcript: [] }, { transcript: turns(['user', 'why?']) }),

      // ── T-7's own, and plan R4 is why they are here (six mutations for three fields). ──
      //
      // Each of these changes what is on the page, so each of them must move the key. The
      // sharpest is `generating`: without it the button would go on looking pressable while
      // an example was being written, and the example would appear only when something else
      // forced a repaint — which reads exactly like a button that ignores you. `open` decides
      // WHICH control is drawn at all, and `note` is the sentence AC5 requires a failure to
      // carry, so a second failure with a different reason under an unchanged key would show
      // the learner the first one's words.
      pair('state.detour.generating', { detour: { generating: false } }, { detour: { generating: true } }),
      pair('state.detour.open appearing', { detour: { generating: false } }, {
        detour: { generating: false, open: { stepId: 'st-2-file-parse', title: 'A vending machine' } },
      }),
      pair('state.detour.open title', {
        detour: { generating: false, open: { stepId: 'st-2-file-parse', title: 'A vending machine' } },
      }, {
        detour: { generating: false, open: { stepId: 'st-2-file-parse', title: 'A card game' } },
      }),
      // The step id is drawn too — an example open ELSEWHERE names which step it is on, so
      // moving it changes a sentence even though the title has not moved.
      pair('state.detour.open stepId', {
        detour: { generating: false, open: { stepId: 'st-3-symbol-handle', title: 'A vending machine' } },
      }, {
        detour: { generating: false, open: { stepId: 'st-4-symbol-render', title: 'A vending machine' } },
      }),
      pair('state.detour.note appearing', { detour: { generating: false } }, {
        detour: { generating: false, note: 'The model did not answer with the JSON this asks for.' },
      }),
      pair('state.detour.note changing', {
        detour: { generating: false, note: 'The model sent 7 files and a worked example may have at most 5.' },
      }, {
        detour: { generating: false, note: 'The model narrated a file it never sent (ghost.ts).' },
      }),

      // T-7 (AC4): a note is drawn with its own class, its own label and its own escaping
      // path, so a transcript identical BUT FOR `kind` renders differently and must not share
      // a key. This is the one T-7 field that is not on `state.detour` at all — it rides in on
      // the transcript, which is exactly how a rendered field goes missing from a key.
      pair('a turn\'s kind', {
        transcript: [{ role: 'assistant', content: 'detour taken: A vending machine' }],
      }, {
        transcript: [{ role: 'assistant', content: 'detour taken: A vending machine', kind: 'note' }],
      }),
    ];
  }

  /** A whole `AskSpend`, so a mutation can name the ONE number it is changing. */
  function spend(over: Partial<NonNullable<NonNullable<StepViewState['tutor']>['spend']>>): NonNullable<NonNullable<StepViewState['tutor']>['spend']> {
    return { preparing: 0, sending: 0, unwatched: 0, replies: 0, inputTokens: 0, outputTokens: 0, usd: 0, metered: false, ...over };
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
    const everything = (): Partial<StepViewState> => ({
      check: { summary: 'a summary', report: report() },
      shape: { signatures: ['export function f(): void {'], imports: ['import x from "y";'] },
      writeNote: 'the reference file was written',
      reproduce: { count: 4, done: false },
      transcript: turns(['user', 'why?'], ['assistant', 'because']),
      tutor: {
        thinking: false,
        unreachable: 'not found on PATH',
        note: 'you stopped waiting',
        elsewhere: { stepId: 'st-4-symbol-render', stage: 'sending' },
        spend: { preparing: 0, sending: 1, unwatched: 1, replies: 2, inputTokens: 90, outputTokens: 12, usd: 0.004, metered: true },
        accepted: 'why?',
      },
      detour: { generating: false, open: { stepId: 'st-2-file-parse', title: 'A vending machine' }, note: 'one tab is still open' },
    });
    const state = stateAt('st-2-file-parse', everything());
    assert.equal(stepRenderKey(state, FAKE_SKINS), stepRenderKey(stateAt('st-2-file-parse', everything()), FAKE_SKINS),
      'two equal states, one key — or the panel repaints on every push');
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

// ── T-6 review: the page's half of the cost-and-abort control surface ──────────────────────

suite('the tutor\'s DRAFT survives a REFUSAL — the review\'s merge bar, from the page', () => {
  /**
   * `askTutor()` used to do `box.value = ''; savedDraft = ''; persist()` BEFORE it posted, so
   * the four refusals the host decides after the press each destroyed the learner's question:
   * gone from the box, gone from the saved blob, and deliberately not in the transcript. It
   * was nowhere. On a machine with no `claude` it was the first thing the tutor ever did.
   *
   * The page now keeps the draft until the host names the question it actually sent
   * (`data-accepted`), so these two tests are the two directions of that one comparison.
   */
  test('a refused press leaves the question in the box, with the reason beside it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    dom.elements.get('tutor-input')!.value = 'why does the tokenizer get its own module?';
    dom.elements.get('tutor-input')!.dispatch('input');
    dom.elements.get('btn-tutor-ask')!.dispatch('click');

    // The host refuses and repaints — an unreachable provider, say. The page that comes back
    // has a note and NO `data-accepted`, because nothing was sent.
    const refused = buildFakeDom(dom.states[dom.states.length - 1]);
    runScript(refused, stateAt('st-2-file-parse', {
      tutor: { thinking: false, unreachable: 'claude: not found on PATH', note: 'nothing was asked and nothing was charged. Your question is still in the box.' },
    }));

    assert.equal(refused.elements.get('tutor-input')!.value, 'why does the tokenizer get its own module?',
      'a minute of somebody\'s typing, still there');
    assert.deepEqual(refused.states[refused.states.length - 1] ?? refused.states[0], {
      stepId: 'st-2-file-parse', note: '', draft: 'why does the tokenizer get its own module?',
    }, 'and still saved, so the next repaint keeps it too');
  });

  test('an ACCEPTED press drops the draft, so the question is not typed twice', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    dom.elements.get('tutor-input')!.value = 'why?';
    dom.elements.get('tutor-input')!.dispatch('input');
    dom.elements.get('btn-tutor-ask')!.dispatch('click');

    // The host accepted it: the repaint that raises the spinner names the question it sent.
    const accepted = buildFakeDom(dom.states[dom.states.length - 1]);
    runScript(accepted, stateAt('st-2-file-parse', {
      transcript: turns(['user', 'why?']),
      tutor: { thinking: true, stage: 'sending', accepted: 'why?' },
    }));

    assert.equal(accepted.elements.get('tutor-input')!.value, '', 'it is a turn in the conversation now, not a draft');
    assert.deepEqual(accepted.states[accepted.states.length - 1], { stepId: 'st-2-file-parse', note: '', draft: '' });
  });

  test('a DIFFERENT question being accepted does not drop this draft', () => {
    // The comparison is what makes this safe on the one path where the host accepts one
    // question and refuses another: an ask already in flight.
    const dom = buildFakeDom({ stepId: 'st-2-file-parse', note: '', draft: 'second?' });
    runScript(dom, stateAt('st-2-file-parse', {
      transcript: turns(['user', 'first?']),
      tutor: { thinking: true, stage: 'sending', accepted: 'first?', note: 'One question is already with the tutor.' },
    }));

    assert.equal(dom.elements.get('tutor-input')!.value, 'second?');
  });

  test('the draft survives the answer\'s repaint too, when it is a NEW question', () => {
    // The bug the draft was added for in the first place, re-proved against the new signal:
    // the panel repaints when the transcript grows, which is exactly when a learner is typing
    // their follow-up.
    const dom = buildFakeDom({ stepId: 'st-2-file-parse', note: '', draft: 'and what about handle?' });
    runScript(dom, stateAt('st-2-file-parse', {
      transcript: turns(['user', 'why?'], ['assistant', 'because']),
      tutor: { thinking: false, accepted: 'why?' },
    }));

    assert.equal(dom.elements.get('tutor-input')!.value, 'and what about handle?');
  });

  test('the accepted question is rendered as an ATTRIBUTE, and escaped as one', () => {
    // The one place on this page where a `"` matters: everything else the tutor draws lands in
    // a text node, which is why `escapeHtml` not escaping quotes is fine everywhere else.
    const html = renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: false, accepted: 'why " onmouseover="alert(1) ?' },
    }), FAKE_SKINS);

    assert.ok(!/data-accepted="why " onmouseover=/.test(html), 'the attribute must not be breakable');
    assert.ok(html.includes('data-accepted="why &quot; onmouseover=&quot;alert(1) ?"'));
    assert.deepEqual(tags(tutorSection(html)).filter((tag) => tag.startsWith('<img') || tag.startsWith('<script')), []);
  });
});

suite('renderStepHtml — the tutor\'s new controls and what they cost (findings 3, 5, 6, and security 5)', () => {
  test('the pre-flight says it is getting ready, not that anything is thinking', () => {
    const preparing = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { tutor: { thinking: true, stage: 'preparing' } }), FAKE_SKINS));
    assert.ok(preparing.includes(escapeForHtml(PREPARING_MESSAGE)), 'nothing has been sent yet, and describing a `claude --version` probe as "thinking" is a small lie');
    assert.ok(!preparing.includes(THINKING_MESSAGE));
    assert.ok(preparing.includes('id="btn-tutor-cancel"'), 'and it is interruptible, which is the whole of security review finding 5');

    const sending = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { tutor: { thinking: true, stage: 'sending' } }), FAKE_SKINS));
    assert.ok(sending.includes(escapeForHtml(THINKING_MESSAGE)));
  });

  test('a live ask on another step is named, with a control that can actually stop it', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-3-symbol-handle', {
      tutor: { thinking: false, elsewhere: { stepId: 'st-2-file-parse', stage: 'sending' } },
    }), FAKE_SKINS));

    assert.ok(section.includes('id="tutor-elsewhere"'));
    assert.match(section, /step 2/, 'the step it belongs to, by ordinal — the old page pointed at a Cancel that was not on it');
    assert.match(section, /still being billed/);
    assert.ok(section.includes('id="btn-tutor-cancel-elsewhere"'));
  });

  test('and that control posts the same tutor:cancel the host already accepts', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-3-symbol-handle', {
      tutor: { thinking: false, elsewhere: { stepId: 'st-2-file-parse', stage: 'sending' } },
    }));
    dom.elements.get('btn-tutor-cancel-elsewhere')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'tutor:cancel', payload: {} }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'tutor:cancel' });
  });

  test('an elsewhere line for a step this plan does not have says "another step" rather than a raw id', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: false, elsewhere: { stepId: 'st-99-invented', stage: 'preparing' } },
    }), FAKE_SKINS));

    assert.match(section, /another step/);
    assert.match(section, /nothing has been sent yet/);
  });

  test('a metered spend is a figure with enough places to be true', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: false, spend: { preparing: 0, sending: 0, unwatched: 0, replies: 3, inputTokens: 2400, outputTokens: 310, usd: 0.0123, metered: true } },
    }), FAKE_SKINS));

    assert.ok(section.includes('id="tutor-spend"'));
    assert.match(section, /\$0\.0123/, 'one question costs fractions of a cent, so two decimal places would round the whole thing away');
    assert.match(section, /3 answers/);
    assert.match(section, /2,400 tokens in/);
  });

  test('an UNMETERED spend never renders $0.00 — the dishonest half of carrying the numbers', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: false, spend: { preparing: 0, sending: 0, unwatched: 0, replies: 2, inputTokens: 0, outputTokens: 0, usd: 0, metered: false } },
    }), FAKE_SKINS));

    assert.ok(!section.includes('$0.00'), '`metered: false` means UNKNOWN, and a learner who was in fact billed must never read a zero');
    assert.ok(!section.includes('$'), 'no figure at all, because there is no figure');
    assert.match(section, /2 answers/);
    assert.match(section, /does not report what they cost/);
  });

  test('a request the learner stopped waiting for is still said to be billing (finding 10)', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: true, stage: 'sending', spend: { preparing: 0, sending: 2, unwatched: 1, replies: 0, inputTokens: 0, outputTokens: 0, usd: 0, metered: false } },
    }), FAKE_SKINS));

    assert.match(section, /2 requests are with the tutor right now/);
    assert.match(section, /1 of them you stopped waiting for/);
    assert.match(section, /still running, still billing/);
  });

  test('the pre-flight says explicitly that nothing is being charged yet', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      tutor: { thinking: true, stage: 'preparing', spend: { preparing: 1, sending: 0, unwatched: 0, replies: 0, inputTokens: 0, outputTokens: 0, usd: 0, metered: false } },
    }), FAKE_SKINS));

    assert.match(section, /Nothing has been sent yet, so nothing is being charged/);
  });

  test('a walk that has spent nothing and has nothing in the air draws no spend line at all', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { tutor: { thinking: false } }), FAKE_SKINS));
    assert.ok(!section.includes('id="tutor-spend"'), 'an empty box saying nothing is worse than no box');
  });

  test('Forget this conversation appears only when there IS one, and never mid-ask', () => {
    const empty = tutorSection(renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS));
    assert.ok(!empty.includes('id="btn-tutor-clear"'), 'a control that was never rendered cannot be pressed by accident');

    const withTurns = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { transcript: turns(['user', 'why?']) }), FAKE_SKINS));
    assert.ok(withTurns.includes('id="btn-tutor-clear"'));
    assert.ok(withTurns.includes(escapeForHtml(CLEAR_BUTTON_LABEL)));

    const asking = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: turns(['user', 'why?']), tutor: { thinking: true, stage: 'sending' },
    }), FAKE_SKINS));
    assert.ok(!asking.includes('id="btn-tutor-clear"'), 'deleting the conversation an answer is landing in is a race with nothing to gain');
  });

  test('it posts tutor:clear, and the host accepts it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse', { transcript: turns(['user', 'why?']) }));
    dom.elements.get('btn-tutor-clear')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'tutor:clear', payload: {} }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'tutor:clear' });
  });
});

suite('renderStepHtml — the spend line is TOTAL, like every other lookup on this page', () => {
  test('a spend block full of nonsense renders rather than throwing a push down', () => {
    // T-4 security review finding 5's family: a throw from inside a render takes down a PUSH,
    // and the panel stops updating with nothing to say why. The numbers here are the ledger's
    // own — this is the same guard applied a second time, where the drawing happens.
    const state = stateAt('st-2-file-parse', {
      tutor: { thinking: false, spend: poison({ replies: '3', usd: null, inputTokens: undefined, outputTokens: {}, sending: NaN, unwatched: [], preparing: 'x', metered: 'yes' }) },
    });

    assert.doesNotThrow(() => renderStepHtml(state, FAKE_SKINS));
    assert.doesNotThrow(() => stepRenderKey(state, FAKE_SKINS));
    const section = tutorSection(renderStepHtml(state, FAKE_SKINS));
    assert.ok(!section.includes('NaN'), 'and never a NaN on somebody\'s page');
    assert.ok(!section.includes('$0.00'));
  });
});

// ── T-7: the detour's controls and the note in the transcript ───────────────────────────────

suite('renderStepHtml — the detour, the second rung of the ladder (T-7, ACs 3, 4, 5)', () => {
  test('the button is on EVERY step, in the tutor section, beside Ask', () => {
    for (const id of ['st-1-shape-src', 'st-2-file-parse', 'st-3-symbol-handle', 'st-4-symbol-render']) {
      const section = tutorSection(renderStepHtml(stateAt(id), FAKE_SKINS));
      assert.ok(section.includes('id="btn-detour-start"'), `${id} has the detour button`);
      assert.ok(section.includes(DETOUR_BUTTON_LABEL), 'with its label, where the eye already is');
      assert.ok(section.includes('id="btn-tutor-ask"'), 'and *Ask* is still there — a ladder, not a replacement');
    }
  });

  test('an unreachable provider keeps the button and says what it would have done', () => {
    const section = tutorSection(renderStepHtml(
      stateAt('st-2-file-parse', { tutor: { thinking: false, unreachable: 'not found on PATH' } }),
      FAKE_SKINS,
    ));
    // Honest, not hidden: a control that vanished would tell somebody the feature was gone
    // rather than that a binary was missing (the ask input's own argument, applied again).
    assert.ok(section.includes('id="btn-detour-start"'), 'the button stays exactly where it was');
    assert.ok(section.includes(DETOUR_UNREACHABLE_MESSAGE), 'with the reason under it');
    assert.ok(section.includes('not found on PATH'), "and the provider's own sentence still above it");
  });

  test('while an example is being written the button is REPLACED by a Cancel that can act', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', { detour: { generating: true } }), FAKE_SKINS));
    assert.ok(!section.includes('id="btn-detour-start"'), 'never rendered beats disabled');
    assert.ok(section.includes(DETOUR_WAITING_MESSAGE), 'and it says what it is doing');
    assert.ok(section.includes('id="btn-tutor-cancel-detour"'), 'with a control that really stops it');
  });

  test('while an example is OPEN the way out takes the button\'s place, and names the example', () => {
    const section = tutorSection(renderStepHtml(
      stateAt('st-2-file-parse', { detour: { generating: false, open: { stepId: 'st-2-file-parse', title: 'A vending machine' } } }),
      FAKE_SKINS,
    ));
    assert.ok(!section.includes('id="btn-detour-start"'), 'no offer to start a second one on top of the first');
    assert.ok(section.includes('id="btn-detour-back"'), 'the way out is on the page');
    assert.ok(section.includes(DETOUR_BACK_LABEL));
    assert.ok(section.includes('A vending machine'), 'and the learner is told which example they are in');
  });

  test('an example open on ANOTHER step names that step and still offers the way out', () => {
    const section = tutorSection(renderStepHtml(
      stateAt('st-2-file-parse', { detour: { generating: false, open: { stepId: 'st-4-symbol-render', title: 'A card game' } } }),
      FAKE_SKINS,
    ));
    // The same failure `tutor.elsewhere` fixed: a control named on a page that does not have
    // it. The session's return works from wherever the learner is standing, so the button may
    // honestly be here.
    assert.ok(section.includes(detourElsewhereMessage(4)), 'it says which step, 1-based, because a person reads it');
    assert.ok(section.includes('id="btn-detour-back"'), 'and the control that acts on it is right there');
  });

  test('a plan that no longer has the step says "another step" rather than a raw id', () => {
    const section = tutorSection(renderStepHtml(
      stateAt('st-2-file-parse', { detour: { generating: false, open: { stepId: 'st-gone', title: 'A card game' } } }),
      FAKE_SKINS,
    ));
    assert.ok(section.includes(detourElsewhereMessage(undefined)));
    assert.ok(!section.includes('st-gone'), 'and never shows an internal id to a learner');
  });

  test('the refusal sentence is drawn, escaped, and capped like every other string here', () => {
    const hostileNote = '<img src=x onerror="alert(1)"> ' + 'z'.repeat(MAX_PLAN_TEXT * 2);
    const html = renderStepHtml(stateAt('st-2-file-parse', { detour: { generating: false, note: hostileNote } }), FAKE_SKINS);
    const section = tutorSection(html);
    assert.ok(section.includes('detour-note'), 'AC5: the sentence is on the page');
    assert.ok(!section.includes('<img'), 'and nothing in it became markup');
    assert.ok(section.includes('&lt;img'), 'it is drawn as text');
    // Cut with a VISIBLE marker, never silently shortened — the whole-codebase rule for a cap.
    assert.ok(section.includes(TRUNCATION_MARKER), 'the cap fired, and said so');
    assert.ok(section.length < hostileNote.length, 'so one string cannot set the page size');
  });

  test('a note in the TRANSCRIPT is drawn as a note, never as something the tutor said (AC4)', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: [
        { role: 'user', content: 'why is this its own module?' },
        { role: 'assistant', content: 'because it changes for its own reasons' },
        { role: 'assistant', content: 'detour taken: A vending machine', kind: 'note' },
      ],
    }), FAKE_SKINS));

    assert.ok(section.includes('turn-note'), 'it gets its own class');
    assert.ok(section.includes(NOTE_TURN_LABEL), 'and its own speaker label');
    // The one that matters: a note is STORED with role 'assistant' (that is what
    // `sanitizeTranscript` allow-lists), so a renderer that asked about the role first would
    // attribute the walk's own sentence to the tutor — in the one place on this page where
    // attribution is the entire point.
    const noteRow = /<li class="tutor-turn turn-note">[\s\S]*?<\/li>/.exec(section);
    assert.ok(noteRow, 'the note is its own row');
    assert.ok(!noteRow[0].includes(TUTOR_TURN_LABEL), 'and is NOT labelled as the tutor');
    assert.ok(noteRow[0].includes('detour taken: A vending machine'), 'with the title AC4 records');
    // …while the real tutor turn beside it is untouched.
    assert.ok(section.includes('turn-tutor'), 'the tutor\'s own turn still reads as the tutor\'s');
  });

  test('a note is drawn FLAT — a model-authored title cannot open a code block', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: [{ role: 'assistant', content: 'detour taken: ```js\nalert(1)\n```', kind: 'note' }],
    }), FAKE_SKINS));
    assert.ok(!section.includes('<pre class="tutor-code">'), 'no fence pass on a note');
    assert.ok(section.includes('```'), 'the backticks are drawn as the text they are');
  });

  test('a forged kind is not a note — only the literal string is honoured', () => {
    const section = tutorSection(renderStepHtml(stateAt('st-2-file-parse', {
      transcript: poison([{ role: 'assistant', content: 'trust me', kind: 'notes' }]),
    }), FAKE_SKINS));
    assert.ok(!section.includes('turn-note'), 'anything but `note` is an ordinary turn');
    assert.ok(section.includes('turn-tutor'), 'drawn as the tutor\'s, which is the conservative direction');
  });
});

suite('the step panel\'s client script — the detour\'s two buttons', () => {
  test('the start button posts detour:start, and the host accepts it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    dom.elements.get('btn-detour-start')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'detour:start', payload: {} }]);
    // Through the REAL parser: a drift between what the button sends and what the host takes
    // is a control that silently does nothing, which is what this pairing exists to catch.
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'detour:start' });
  });

  test('the way out posts detour:back, and the host accepts it', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    dom.elements.get('btn-detour-back')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'detour:back', payload: {} }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'detour:back' });
  });

  test('the detour\'s Cancel posts the SAME tutor:cancel — one control, one message', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt('st-2-file-parse'));
    dom.elements.get('btn-tutor-cancel-detour')!.dispatch('click');

    assert.deepEqual(dom.posted, [{ type: 'tutor:cancel', payload: {} }]);
    assert.deepEqual(parseStepMessage(dom.posted[0]), { type: 'tutor:cancel' });
  });

  test('the script still loads on a page where none of the three is rendered', () => {
    // The real page never has all three at once — `detourHtml` draws exactly one state — so
    // the harness's pre-created nodes are taken away deliberately to reproduce what a browser
    // really hands this script: `getElementById` answering nothing.
    const dom = buildFakeDom();
    for (const id of ['btn-detour-start', 'btn-detour-back', 'btn-tutor-cancel-detour']) dom.elements.delete(id);
    assert.doesNotThrow(() => { runScript(dom, stateAt('st-2-file-parse')); });
    dom.elements.get('btn-next')!.dispatch('click');
    assert.deepEqual(dom.posted, [{ type: 'step:next', payload: {} }], 'and the rest of the page is still wired');
  });
});
