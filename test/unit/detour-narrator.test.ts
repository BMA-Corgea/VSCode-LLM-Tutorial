// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/detour/narrator.ts — pure (no `vscode`). The same three-way split
 * `test/unit/walk-step-view.test.ts` established, because the three halves catch different
 * bugs:
 *
 *   1. **The SERVER-rendered markup.** Does the page put the current stop's text where it
 *      says it does, mark exactly one row current, name every file the detour opened, and
 *      stay total when the model's own JSON turns out not to hold what its type promised.
 *      The one this step is most particular about is asserted STRUCTURALLY: the stop list
 *      holds no `<button>`, no `<a>` and no `data-` attribute at all, so "a model's file path
 *      never becomes a DOM id or a data attribute" is a fact about what exists rather than
 *      about an escape one accident could remove.
 *   2. **The REAL client script, executed** against a minimal hand-built fake DOM — the
 *      repo-tour T-3 lesson (a script that parses fine and does nothing), plus the one
 *      client-side escaping property no markup assertion can see: the note channel writes
 *      `textContent`, and the shipped script contains no `innerHTML` at all.
 *   3. **The AC5 bar, re-earned for this page.** `title`, `domain`, every `stops[].text` and
 *      every `files[].path` are MODEL-AUTHORED — exactly as untrusted as a tutor reply. T-6's
 *      security review measured its escaping by stripping the tokens `answerHtml` is allowed
 *      to emit and asserting **no `<` survives**; 21 named payloads plus an 84-case fuzz, zero
 *      breakouts. The suite at the bottom of this file is that measure, ported:
 *
 *        - `strippedOfAllowedTokens` deletes, in order, exactly the tags a BENIGN render of
 *          the same state emits, and asserts no `<` is left in the whole document. With the
 *          fake skins module below, every `<` on this page comes from a tag, so the leftover
 *          really is "text nodes only".
 *        - `tagSequence` compares the hostile render's tags against the benign one's. This is
 *          the half that sees an ATTRIBUTE break-out, which the `<` measure cannot: a payload
 *          of `x" onmouseover="alert(1)` holds no angle bracket at all and shows up only as a
 *          tag that changed shape.
 *        - one test deliberately runs both measures against a BROKEN renderer that
 *          interpolates raw, and asserts they FAIL — because "my regex found nothing scary"
 *          is not a measurement unless the measurement can fail.
 *
 * Nothing here spends a token: every input is a hand-built `Detour`, and the module under
 * test is a pure function from that to a string.
 */

import * as assert from 'node:assert/strict';
import type { SkinsModule } from '../../src/start/view.js';
import type { Detour } from '../../src/detour/types.js';
import {
  BACK_LABEL, BAD_RANGE_LABEL, CONTROL_STAND_IN, DETOUR_ASIDE, FILES_HEADING, FIRST_STOP_HINT,
  LAST_STOP_HINT, MAX_LABEL_TEXT, MAX_ROWS_RENDERED, MAX_STOP_TEXT, NARRATOR_TITLE, NEXT_LABEL,
  NOT_TEXT_MESSAGE, NO_FILES_MESSAGE, NO_STOPS_MESSAGE, PREV_LABEL, TRUNCATION_MARKER,
  domainSentence, linesLabel, narratorScript, parseNarratorMessage, renderNarratorHtml,
  rowsOmittedMessage, stopProgressMessage,
  type NarratorViewState,
} from '../../src/detour/narrator.js';

/** Stands in for repo-tour's real skins module so this suite never touches it. Deliberately
 *  free of `<` — see the file header: that is what makes the whole-page "no `<` survives"
 *  measure below mean "no tag at all", rather than "no tag except the stylesheet's". */
const FAKE_SKINS: SkinsModule = {
  SKINS: [
    { name: 'system', label: 'System', note: 'follow the editor' },
    { name: 'dark', label: 'Dark', note: 'always dark' },
  ],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

/** A detour in the shape `parseDetourReply` promises: a title, a domain, files, 3–6 stops. */
function fixtureDetour(): Detour {
  return {
    title: 'A vending machine that makes change',
    domain: 'coin-operated hardware',
    files: [
      { path: 'coins.ts', content: 'export const COINS = [200, 100, 50];\n' },
      { path: 'change/greedy.ts', content: 'export function change(n) { return n; }\n' },
    ],
    stops: [
      { file: 'coins.ts', startLine: 1, endLine: 1, text: 'The denominations, largest first.' },
      { file: 'change/greedy.ts', startLine: 1, endLine: 1, text: 'One coin at a time, greedily.' },
      { file: 'change/greedy.ts', startLine: 1, endLine: 1, text: 'And why greedy is enough here.' },
    ],
  };
}

function stateAt(current = 0, over: Partial<NarratorViewState> = {}): NarratorViewState {
  return { detour: fixtureDetour(), current, skin: 'system', ...over };
}

/** A field set to something its own TYPE forbids. Not the test cheating: a `Detour` is
 *  `JSON.parse`d model output cast to that interface, so at run time every field holds
 *  whatever the model actually emitted — `tsc` believes `title` is a string for exactly the
 *  reason a bug here would ship. */
function poison<T>(value: unknown): T {
  return value as T;
}

/** T-40: the markup with its decorative icons taken out: an empty, aria-hidden codicon says nothing,
 *  so what an element says is unchanged by one (test/unit/codicons.test.ts pins the icons). */
function withoutIcons(markup: string): string {
  return markup.replace(/<span class="codicon [^"]*" aria-hidden="true"><\/span>/g, '');
}

/** The text of the first element carrying `class="<cls>"`, exactly as the markup spells it. */
function textOfClass(html: string, cls: string): string {
  const found = new RegExp(`<[a-z0-9]+ class="${cls}"[^>]*>([\\s\\S]*?)</[a-z0-9]+>`).exec(html);
  assert.ok(found, `the page should render an element with class="${cls}"`);
  return found[1]!;
}

/** The stop list alone — from its own `<ol>` to the matching close. A stop text containing
 *  the literal `</ol>` cannot end this match early, because by the time it is on the page it
 *  is `&lt;/ol&gt;` — itself a small proof of the rule this helper is used to test. */
function stopList(html: string): string {
  const found = /<ol class="stop-list">[\s\S]*?<\/ol>/.exec(html);
  assert.ok(found, 'the page should render a stop list');
  return found[0];
}

function fileList(html: string): string {
  const found = /<ul class="file-list">[\s\S]*?<\/ul>/.exec(html);
  assert.ok(found, 'the page should render a file list');
  return found[0];
}

/** The `<li …>` rows of the stop list, as their class attribute alone — enough to say WHICH
 *  row the page marked current, not merely how many it marked. */
function stopRowClasses(html: string): string[] {
  return [...stopList(html).matchAll(/<li class="([^"]*)"/g)].map((m) => m[1]!);
}

function scriptOf(html: string): string {
  const found = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(found, 'renderNarratorHtml should inline a <script> block');
  return found[1]!;
}

/** Both spellings of the per-render nonce blanked — the attribute on each `<style>`/`<script>`
 *  and the two `'nonce-…'` sources inside the CSP's own `content`. `renderPage` mints a fresh
 *  one every call, so without this no two renders of the same state would ever compare. */
function withoutNonce(html: string): string {
  return html.replace(/nonce="[^"]*"/g, 'nonce="N"').replace(/'nonce-[^']*'/g, "'nonce-N'");
}

/** Every tag in the document, nonce-blanked so two renders compare. */
function tagSequence(html: string): string[] {
  return [...withoutNonce(html).matchAll(/<[^>]*>/g)].map(([tag]) => tag);
}

/**
 * T-6's own measure, whole-page: delete — in order — exactly the tags this renderer is
 * ALLOWED to emit, taken from a benign render of the same state, and hand back what is left.
 * Anything holding a `<` in the result is a token the renderer was not allowed to emit, which
 * is to say a payload that became markup.
 */
function strippedOfAllowedTokens(hostile: string, benign: string): string {
  let out = withoutNonce(hostile);
  for (const tag of tagSequence(benign)) {
    const at = out.indexOf(tag);
    if (at >= 0) out = out.slice(0, at) + out.slice(at + tag.length);
  }
  return out;
}

// ── the fake DOM: just enough of document/window/acquireVsCodeApi for THIS script ──────────

class FakeElement {
  value = '';
  textContent = '';
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

const ELEMENT_IDS = ['detour-main', 'detour-note', 'btn-detour-prev', 'btn-detour-next', 'btn-detour-back'];

function buildFakeDom(saved?: unknown) {
  const elements = new Map<string, FakeElement>();
  for (const id of ELEMENT_IDS) elements.set(id, new FakeElement());

  const fakeDocument = {
    documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined },
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

  return { elements, fakeDocument, fakeWindow, windowListeners, posted, states, acquireVsCodeApi };
}

/**
 * Runs the REAL shipped script — lifted out of `renderNarratorHtml`'s own output, so this is
 * `src/webview/page.ts`'s bootstrap (`post`/`restore`/`save`) combined with `narratorScript()`
 * exactly as `renderPage` combines them for the real webview. The one value the script reads
 * off the page it was shipped inside (`data-stop`) is copied out of that same markup first,
 * so the harness stands in for the browser rather than holding a second opinion about what
 * the page contains.
 */
function runScript(dom: ReturnType<typeof buildFakeDom>, state: NarratorViewState): void {
  const html = renderNarratorHtml(state, FAKE_SKINS);
  const stopMatch = /<main id="detour-main" data-stop="([^"]*)"/.exec(html);
  assert.ok(stopMatch, 'the page should stamp the stop ordinal the script keys its note by');
  dom.elements.get('detour-main')!.setAttribute('data-stop', stopMatch[1]!);

  const code = scriptOf(html);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- fake DOM, no untrusted input
  const fn = new Function('document', 'window', 'acquireVsCodeApi', code);
  fn(dom.fakeDocument, dom.fakeWindow, dom.acquireVsCodeApi);
}

// ────────────────────────────────────────────────────────────────────────────────────────────

suite('renderNarratorHtml — the walk it draws (AC2)', () => {
  test('the title, the domain sentence and the current stop are all on the page', () => {
    const html = renderNarratorHtml(stateAt(1), FAKE_SKINS);
    assert.equal(textOfClass(html, 'detour-title'), 'A vending machine that makes change');
    assert.equal(textOfClass(html, 'detour-domain'), domainSentence('coin-operated hardware'));
    assert.equal(textOfClass(html, 'detour-aside'), DETOUR_ASIDE);
    assert.equal(textOfClass(html, 'stop-text'), 'One coin at a time, greedily.');
    assert.equal(textOfClass(html, 'now-where'), `change/greedy.ts · ${linesLabel(1, 1)}`);
  });

  test('exactly one row is marked current, and it is the one the state names', () => {
    assert.deepEqual(stopRowClasses(renderNarratorHtml(stateAt(2), FAKE_SKINS)), ['stop', 'stop', 'stop stop-current']);
    assert.deepEqual(stopRowClasses(renderNarratorHtml(stateAt(0), FAKE_SKINS)), ['stop stop-current', 'stop', 'stop']);
  });

  test('the progress line counts from one, through the exported message', () => {
    assert.equal(textOfClass(renderNarratorHtml(stateAt(1), FAKE_SKINS), 'stop-progress'), stopProgressMessage(2, 3));
  });

  test('the stop list is NOT interactive — a file path never becomes an id, an href or a data attribute', () => {
    // The whole point of step 3's security note, asserted structurally rather than by escape.
    // Navigation is Previous/Next; a row a learner could click would need a key, and the only
    // key a row has is the model's own `file` — so there is no such control at all.
    const list = stopList(renderNarratorHtml(stateAt(1), FAKE_SKINS));
    assert.ok(!/<button/i.test(list), 'no <button> anywhere in the stop list');
    assert.ok(!/<a[\s>]/i.test(list), 'no <a> anywhere in the stop list');
    assert.ok(!/<input/i.test(list), 'no <input> anywhere in the stop list');
    assert.ok(!/data-/i.test(list), 'and no data- attribute for a path to land in');
    assert.ok(!/ id=/i.test(list), 'nor an id');
    assert.ok(!/href|src=/i.test(list), 'nor a url of any kind');
  });

  test('the only run-time attribute on the page holds a host-generated integer', () => {
    // `data-stop` is the ordinal THIS file computed, never anything the model said — a
    // `current` that is not a number at all still produces digits.
    for (const current of [0, 2, poison<number>('2" onmouseover="alert(1)'), poison<number>(Number.NaN)]) {
      const stop = /<main id="detour-main" data-stop="([^"]*)"/.exec(renderNarratorHtml(stateAt(current), FAKE_SKINS));
      assert.ok(stop, 'the ordinal attribute is always present');
      assert.match(stop[1]!, /^[0-9]+$/, 'and always digits');
    }
  });

  test('the three controls are there, with the labels this module exports', () => {
    const html = renderNarratorHtml(stateAt(1), FAKE_SKINS);
    const controls: Array<[string, string]> = [
      ['btn-detour-prev', PREV_LABEL], ['btn-detour-next', NEXT_LABEL], ['btn-detour-back', BACK_LABEL],
    ];
    for (const [id, label] of controls) {
      const found = new RegExp(`<button[^>]*id="${id}"[^>]*>([^<]*)</button>`).exec(withoutIcons(html));
      assert.ok(found, `${id} should be on the page`);
      assert.equal(found[1], label);
    }
  });

  test('an end of the walk disables the control it would move past — and SAYS why', () => {
    // conventions.md: never a disabled button with no explanation. The hint node is always
    // present, so the sentence has somewhere to go without a shape change.
    const first = renderNarratorHtml(stateAt(0), FAKE_SKINS);
    assert.match(first, /<button[^>]*id="btn-detour-prev"[^>]*\sdisabled/);
    assert.ok(!/<button[^>]*id="btn-detour-next"[^>]*\sdisabled/.test(first), 'Next still works at the first stop');
    assert.equal(textOfClass(first, 'detour-hint'), FIRST_STOP_HINT);

    const last = renderNarratorHtml(stateAt(2), FAKE_SKINS);
    assert.match(last, /<button[^>]*id="btn-detour-next"[^>]*\sdisabled/);
    assert.ok(!/<button[^>]*id="btn-detour-prev"[^>]*\sdisabled/.test(last), 'Previous still works at the last stop');
    assert.equal(textOfClass(last, 'detour-hint'), LAST_STOP_HINT);

    const middle = renderNarratorHtml(stateAt(1), FAKE_SKINS);
    assert.ok(!/<button[^>]*id="btn-detour-(prev|next)"[^>]*\sdisabled/.test(middle), 'neither is disabled in the middle');
    assert.equal(textOfClass(middle, 'detour-hint'), '', 'and the hint node is present but empty');
  });

  test('Back to my build is never disabled — it is the way out of every state', () => {
    for (const current of [0, 1, 2]) {
      assert.ok(!/<button[^>]*id="btn-detour-back"[^>]*\sdisabled/.test(renderNarratorHtml(stateAt(current), FAKE_SKINS)));
    }
  });

  test('every file the detour opened is named, so a learner can tell which tabs are the detour’s', () => {
    const html = renderNarratorHtml(stateAt(0), FAKE_SKINS);
    const list = fileList(html);
    assert.ok(list.includes('coins.ts'));
    assert.ok(list.includes('change/greedy.ts'));
    assert.ok(html.includes(FILES_HEADING));
  });

  test('the page title is FIXED — the model never names the tab', () => {
    const detour = { ...fixtureDetour(), title: '</title><script>alert(1)</script>' };
    const html = renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS);
    assert.ok(html.includes(`<title>${NARRATOR_TITLE}</title>`), 'the shell titles itself');
    assert.equal([...html.matchAll(/<title>/g)].length, 1, 'and there is exactly one title element');
  });
});

suite('renderNarratorHtml — total against a `Detour` that is not one (the model wrote it)', () => {
  test('no stops at all says so, and renders no walk controls to press', () => {
    const empties = [[], poison<Detour['stops']>(null), poison<Detour['stops']>('nope'), poison<Detour['stops']>({ 0: 'x' })];
    for (const stops of empties) {
      const html = renderNarratorHtml(stateAt(0, { detour: { ...fixtureDetour(), stops } }), FAKE_SKINS);
      assert.ok(html.includes(NO_STOPS_MESSAGE), 'the page says there is nothing to walk');
      assert.ok(!/id="btn-detour-(prev|next)"/.test(html), 'and neither walk control exists to be pressed');
      assert.ok(/id="btn-detour-back"/.test(html), 'but the way out is still there');
    }
  });

  test('no files says so rather than drawing an empty list', () => {
    assert.ok(renderNarratorHtml(stateAt(0, { detour: { ...fixtureDetour(), files: [] } }), FAKE_SKINS).includes(NO_FILES_MESSAGE));
    assert.ok(renderNarratorHtml(stateAt(0, { detour: { ...fixtureDetour(), files: poison<Detour['files']>(null) } }), FAKE_SKINS)
      .includes(NO_FILES_MESSAGE));
  });

  test('a `current` outside the walk is clamped, never thrown on', () => {
    const cases: Array<[unknown, number]> = [
      [-1, 0], [-99, 0], [3, 2], [999, 2], [1.5, 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0],
      ['1', 0], [null, 0], [undefined, 0], [{}, 0],
    ];
    for (const [current, expected] of cases) {
      const marked = stopRowClasses(renderNarratorHtml(stateAt(poison<number>(current)), FAKE_SKINS))
        .findIndex((c) => c.includes('stop-current'));
      assert.equal(marked, expected, `current=${JSON.stringify(current)} should land on stop ${expected}`);
    }
  });

  test('a field that is not a string says so, rather than drawing the word "undefined"', () => {
    const detour = {
      ...fixtureDetour(),
      title: poison<string>(42),
      domain: poison<string>(null),
      files: [{ path: poison<string>({}), content: '' }],
      stops: [{ file: poison<string>([]), startLine: 1, endLine: 2, text: poison<string>(undefined) }],
    };
    const html = renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS);
    assert.equal(textOfClass(html, 'detour-title'), NOT_TEXT_MESSAGE);
    assert.equal(textOfClass(html, 'stop-text'), NOT_TEXT_MESSAGE);
    assert.ok(!/undefined|\[object Object\]/.test(textOfClass(html, 'now-where') + fileList(html)),
      'and a non-string path is not stringified at a learner either');
  });

  test('a stop that is not an object at all still renders a row', () => {
    const detour = { ...fixtureDetour(), stops: poison<Detour['stops']>([null, 'x', 7]) };
    assert.doesNotThrow(() => renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS));
    assert.equal(stopRowClasses(renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS)).length, 3);
  });

  test('line numbers that are not line numbers say so, never "NaN" or "lines undefined"', () => {
    const ranges: Array<[unknown, unknown]> = [[0, 5], [-1, 2], [1.5, 2], [Number.NaN, 2], ['1', '2'], [null, null], [5, 2]];
    for (const [start, end] of ranges) {
      const detour = {
        ...fixtureDetour(),
        stops: [{ file: 'coins.ts', startLine: poison<number>(start), endLine: poison<number>(end), text: 'x' }],
      };
      const where = textOfClass(renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS), 'now-where');
      assert.ok(where.includes(BAD_RANGE_LABEL), `${JSON.stringify(start)}–${JSON.stringify(end)} is not a range`);
      assert.ok(!/NaN|undefined|null/.test(where));
    }
    assert.ok(linesLabel(7, 7).includes('7') && !linesLabel(7, 7).includes(BAD_RANGE_LABEL), 'a one-line range is a range');
    assert.ok(linesLabel(3, 9).includes('3') && linesLabel(3, 9).includes('9'));
  });

  test('a model string past the cap is CUT, with the marker left where the cut happened', () => {
    const longTitle = 'T'.repeat(MAX_LABEL_TEXT + 500);
    const longText = 'S'.repeat(MAX_STOP_TEXT + 500);
    const detour = {
      ...fixtureDetour(),
      title: longTitle,
      stops: [{ file: 'coins.ts', startLine: 1, endLine: 1, text: longText }],
    };
    const html = renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS);
    assert.equal(textOfClass(html, 'detour-title'), 'T'.repeat(MAX_LABEL_TEXT) + TRUNCATION_MARKER);
    assert.equal(textOfClass(html, 'stop-text'), 'S'.repeat(MAX_STOP_TEXT) + TRUNCATION_MARKER);
    assert.ok(!html.includes(longTitle), 'the whole of what the model wrote is NOT on the page');
    assert.ok(!html.includes(longText));
  });

  test('more rows than this page will draw are capped, and the page says how many it left out', () => {
    const stops = Array.from({ length: MAX_ROWS_RENDERED + 7 }, (_, i) => ({ file: 'coins.ts', startLine: 1, endLine: 1, text: `stop ${i}` }));
    const files = Array.from({ length: MAX_ROWS_RENDERED + 3 }, (_, i) => ({ path: `f${i}.ts`, content: '' }));
    const html = renderNarratorHtml(stateAt(0, { detour: { ...fixtureDetour(), stops, files } }), FAKE_SKINS);
    assert.equal(stopRowClasses(html).length, MAX_ROWS_RENDERED, 'the stop list stops at the cap');
    assert.ok(html.includes(rowsOmittedMessage(7, 'stop')), 'and counts what it did not draw');
    assert.ok(html.includes(rowsOmittedMessage(3, 'file')));
  });

  test('control and bidi characters are neutralised, not passed through', () => {
    // Trojan Source, in a file path a learner is matching against a real editor tab. The
    // stand-in is VISIBLE on purpose: a silent deletion would show a path that is not the one
    // on disk, which is the same lie by a quieter route.
    const detour = {
      ...fixtureDetour(),
      title: 'sto\u0000p\u202Egnp.exe',
      stops: [{ file: 'co\u200Bins.ts', startLine: 1, endLine: 1, text: 'a\u202Db\u2066c' }],
    };
    const html = renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS);
    for (const ch of ['\u0000', '\u202E', '\u202D', '\u200B', '\u2066']) {
      assert.ok(!html.includes(ch), `${JSON.stringify(ch)} must not reach the page`);
    }
    assert.equal(textOfClass(html, 'detour-title'), `sto${CONTROL_STAND_IN}p${CONTROL_STAND_IN}gnp.exe`);
    assert.equal(textOfClass(html, 'stop-text'), `a${CONTROL_STAND_IN}b${CONTROL_STAND_IN}c`);
    assert.ok(renderNarratorHtml(stateAt(0), FAKE_SKINS).includes('coins.ts'), 'and an ordinary path is untouched');
  });

  test('a newline in a stop’s prose survives — it is prose, not a control character', () => {
    const detour = { ...fixtureDetour(), stops: [{ file: 'coins.ts', startLine: 1, endLine: 1, text: 'one\ntwo' }] };
    assert.equal(textOfClass(renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS), 'stop-text'), 'one\ntwo');
  });
});

suite('the narrator’s client script, actually executed against a fake DOM', () => {
  test('the page inlines exactly one script, it parses, and it is what narratorScript() exports', () => {
    const html = renderNarratorHtml(stateAt(1), FAKE_SKINS);
    assert.equal([...html.matchAll(/<script[^>]*>/g)].length, 1, 'exactly one script block');
    const code = scriptOf(html);
    // Parse-only, never executed — the one legitimate use of the Function constructor eslint
    // warns about (test/unit/page.test.ts states the same rule for the same reason).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    assert.doesNotThrow(() => new Function(code), `the client script does not parse:\n${code}`);
    assert.ok(code.includes(narratorScript()), 'the harness below runs the script the page really ships');
  });

  test('each of the three buttons posts exactly the message parseNarratorMessage accepts for it', () => {
    const controls: Array<[string, string]> = [
      ['btn-detour-prev', 'detour:prev'], ['btn-detour-next', 'detour:next'], ['btn-detour-back', 'detour:back'],
    ];
    for (const [id, type] of controls) {
      const dom = buildFakeDom();
      runScript(dom, stateAt(1));
      dom.elements.get(id)!.dispatch('click');
      assert.deepEqual(dom.posted, [{ type, payload: {} }], `${id} should post ${type}`);
      // Through the REAL parser, so a drift between what the page sends and what the host
      // accepts fails here rather than silently, in a webview, at run time.
      assert.deepEqual(parseNarratorMessage(dom.posted[0]), { type });
    }
  });

  test('an inbound note lands in textContent — never as markup', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt(1));
    const onMessage = dom.windowListeners.get('message')?.[0];
    assert.ok(onMessage, 'the script should listen for the host’s messages');
    onMessage({ data: { type: 'detour:note', payload: { note: '<img src=x onerror="alert(1)">' } } });
    assert.equal(dom.elements.get('detour-note')!.textContent, '<img src=x onerror="alert(1)">',
      'the DOM API escapes it — which is the point of writing textContent rather than innerHTML');
  });

  test('the shipped script has no way to write markup at all', () => {
    // The client-side half of the escaping rule, asserted at the source: no innerHTML, no
    // insertAdjacentHTML, no document.write, no eval anywhere in it — so no host message and
    // no stored state can become an element.
    //
    // Over the CODE rather than the text, because the script's own comment names `innerHTML`
    // to say it is not used, and a scan that could not tell those two apart would push the
    // next person to delete the explanation instead of the sink.
    const code = narratorScript().replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\/\//.test(code) && code.length > 200, 'the comment strip really ran, on a non-trivial script');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'Function(']) {
      assert.ok(!code.includes(sink), `the client script must not contain ${sink}`);
    }
    // And `textContent` is what it uses instead — the positive half, so this cannot pass by
    // the script having stopped writing anything at all.
    assert.ok(code.includes('textContent'));
  });

  test('a malformed inbound message is ignored rather than thrown on', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt(1));
    const onMessage = dom.windowListeners.get('message')![0]!;
    const junk = [null, undefined, 'x', 7, {}, { type: 'detour:note' }, { type: 'detour:note', payload: null },
      { type: 'detour:note', payload: { note: 42 } }, { type: 'other', payload: { note: 'x' } }];
    for (const data of junk) assert.doesNotThrow(() => onMessage({ data }));
    assert.equal(dom.elements.get('detour-note')!.textContent, '', 'and nothing was written');
  });

  test('the note survives a teardown at the same stop, and is dropped at a different one', () => {
    const kept = buildFakeDom({ stop: '1', note: 'a sentence the host put on the page' });
    runScript(kept, stateAt(1));
    assert.equal(kept.elements.get('detour-note')!.textContent, 'a sentence the host put on the page');

    const dropped = buildFakeDom({ stop: '0', note: 'a sentence about the stop you left' });
    runScript(dropped, stateAt(1));
    assert.equal(dropped.elements.get('detour-note')!.textContent, '',
      'a note about another stop is not re-applied under this one');
  });

  test('a note is saved as it arrives, so it survives the next teardown', () => {
    const dom = buildFakeDom();
    runScript(dom, stateAt(2));
    dom.windowListeners.get('message')![0]!({ data: { type: 'detour:note', payload: { note: 'putting your build back…' } } });
    assert.deepEqual(dom.states[dom.states.length - 1], { stop: '2', note: 'putting your build back…' });
  });
});

suite('parseNarratorMessage — a webview message is untrusted input', () => {
  test('each of the three messages this page speaks parses', () => {
    for (const type of ['detour:prev', 'detour:next', 'detour:back'] as const) {
      assert.deepEqual(parseNarratorMessage({ type }), { type });
      assert.deepEqual(parseNarratorMessage({ type, payload: {} }), { type });
      assert.deepEqual(parseNarratorMessage({ type, payload: { junk: 1 } }), { type }, 'a payload it does not speak is dropped, not carried');
    }
  });

  test('anything else is null — the panel drops it rather than throwing inside a voided promise', () => {
    const junk = [
      null, undefined, 0, 1, '', 'detour:next', true, [], ['detour:next'], {},
      { type: null }, { type: 7 }, { type: 'detour:go' }, { type: 'step:next' }, { type: 'tutor:ask' },
      { type: ['detour:next'] }, { type: { toString: () => 'detour:next' } },
      { notType: 'detour:next' }, { type: 'DETOUR:NEXT' }, { type: ' detour:next' },
      { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' },
    ];
    for (const raw of junk) assert.equal(parseNarratorMessage(raw), null, `${JSON.stringify(raw)} should not parse`);
  });

  test('a prototype-pollution shape neither parses into one nor pollutes', () => {
    const raw = JSON.parse('{"type":"detour:next","payload":{"__proto__":{"polluted":true}}}') as unknown;
    assert.deepEqual(parseNarratorMessage(raw), { type: 'detour:next' });
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'nothing reached Object.prototype');
  });

  test('the parser returns a FRESH object — a caller is never handed the webview’s own', () => {
    const raw = { type: 'detour:back' as const, payload: {} };
    assert.notEqual(parseNarratorMessage(raw), raw);
  });
});

// ── the AC5 bar, re-earned: a model string can never become markup ──────────────────────────

/**
 * The hostile set, modelled on the 21 the T-6 security review drove through `answerHtml`.
 * Every one of these is something a model can and does emit while answering honestly — a
 * tutor asked about escaping quotes `<img onerror=…>` straight back — so this is not a
 * malicious-model threat model, it is an ordinary-output one.
 */
const PAYLOADS: Array<[string, string]> = [
  ['a script element', '<script>alert(1)</script>'],
  ['a closing script tag', '</script><script>alert(1)</script>'],
  ['an image handler', '<img src=x onerror="alert(1)">'],
  ['an attribute break-out', 'x" onmouseover="alert(1)'],
  ['a single-quoted break-out', "x' onmouseover='alert(1)"],
  ['a quote-then-bracket break', '"><script>alert(1)</script>'],
  ['an unclosed tag', '<img src=x onerror=alert(1)'],
  ['an unclosed comment', '<!--><script>alert(1)</script>'],
  ['a NUL byte', 'a\u0000<script>alert(1)</script>'],
  ['an RTL override', '\u202Eexe.gpj'],
  ['a bidi isolate', '\u2066harmless\u2069\u202E<script>x</script>'],
  ['a closing style tag', '</style><script>alert(1)</script>'],
  ['a closing title tag', '</title><script>alert(1)</script>'],
  ['an svg handler', '<svg/onload=alert(1)>'],
  ['an iframe with a javascript: url', '<iframe src="javascript:alert(1)"></iframe>'],
  ['a bare javascript: url', 'javascript:alert(1)'],
  ['CDATA', '<![CDATA[<script>alert(1)</script>]]>'],
  ['a structure break', '</code></li></ul><script>alert(1)</script><ul><li>'],
  ['an already-escaped payload', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['a fence info string', '```js" onload="alert(1)\nconst a = 1;\n```'],
  ['a traversal-shaped path', '../../etc/passwd'],
];

/** The four model-authored positions on this page, each as a whole state. Index order is
 *  load-bearing: the sweeps below address `title` as 0 and `stops[].text` as 2. */
function positions(payload: string): Array<[string, NarratorViewState]> {
  const base = fixtureDetour();
  return [
    ['title', stateAt(0, { detour: { ...base, title: payload } })],
    ['domain', stateAt(0, { detour: { ...base, domain: payload } })],
    ['stops[].text', stateAt(0, { detour: { ...base, stops: [{ file: 'coins.ts', startLine: 1, endLine: 1, text: payload }] } })],
    ['files[].path', stateAt(0, {
      detour: { ...base, files: [{ path: payload, content: '' }], stops: [{ file: payload, startLine: 1, endLine: 1, text: 'x' }] },
    })],
  ];
}

/** The benign string those four positions hold in the render whose tags are the ONLY tokens
 *  this renderer is allowed to emit. */
const BENIGN = 'benign';

suite('AC5 for the narrator — 21 payloads across four model-authored fields', () => {
  test('no payload in any field ever produces a tag the benign render did not (84 renders)', () => {
    const benigns = positions(BENIGN);
    let renders = 0;
    for (const [name, payload] of PAYLOADS) {
      for (const [where, state] of positions(payload)) {
        const benign = renderNarratorHtml(benigns.find(([w]) => w === where)![1], FAKE_SKINS);
        const hostile = renderNarratorHtml(state, FAKE_SKINS);
        renders += 1;

        // (1) T-6's own measure: strip the tokens this renderer may emit, assert no `<` is left.
        const leftover = strippedOfAllowedTokens(hostile, benign);
        assert.ok(!leftover.includes('<'), `${name} in ${where} left markup behind:\n${leftover.slice(0, 400)}`);

        // (2) The half a `<`-scan cannot see: an attribute break-out carries no angle bracket
        // at all and shows up only as a tag that changed shape.
        assert.deepEqual(tagSequence(hostile), tagSequence(benign), `${name} in ${where} changed the page's tags`);

        // (3) And no element anywhere carries a handler, however it might have got there.
        assert.ok(!tagSequence(hostile).some((tag) => /\son[a-z]+\s*=/i.test(tag)),
          `${name} in ${where} put a handler on an element`);
      }
    }
    assert.equal(renders, PAYLOADS.length * 4);
    assert.equal(renders, 84, 'the same 84 the T-6 review drove');
  });

  test('the learner still SEES what the model wrote — escaped, present, and escaped exactly once', () => {
    // Both directions. A page that simply DROPPED the payload would pass the measure above on
    // its own and be useless; a page that escaped twice would show `&amp;lt;` at a learner.
    const html = renderNarratorHtml(positions('<b>&</b>')[2]![1], FAKE_SKINS);
    assert.equal(textOfClass(html, 'stop-text'), '&lt;b&gt;&amp;&lt;/b&gt;');
    assert.ok(!html.includes('&amp;lt;'), 'escaped exactly once, never twice');
    assert.ok(!/<b>/.test(html), 'and it is not an element');

    const already = renderNarratorHtml(positions('&lt;script&gt;')[2]![1], FAKE_SKINS);
    assert.equal(textOfClass(already, 'stop-text'), '&amp;lt;script&amp;gt;', 'an already-escaped string is not UN-escaped');
  });

  test('a payload straddling each cap never assembles a tag across the cut (52 renders)', () => {
    // T-6 fuzzed a fence cut at every offset; the equivalent hazard here is a truncation that
    // lands inside a payload and leaves half a tag sitting beside the marker.
    const probe = '<script>alert(1)</script>';
    const sweeps: Array<[number, number]> = [[MAX_LABEL_TEXT, 0], [MAX_STOP_TEXT, 2]];
    let renders = 0;
    for (const [max, position] of sweeps) {
      for (let offset = 0; offset <= probe.length; offset += 1) {
        const filler = 'a'.repeat(Math.max(0, max - offset));
        const hostile = renderNarratorHtml(positions(filler + probe + 'tail')[position]![1], FAKE_SKINS);
        const benign = renderNarratorHtml(positions(filler + BENIGN + 'tail')[position]![1], FAKE_SKINS);
        renders += 1;
        assert.ok(!strippedOfAllowedTokens(hostile, benign).includes('<'),
          `a cut at offset ${offset} of the ${max}-cap left markup behind`);
        assert.ok(hostile.includes(TRUNCATION_MARKER), 'and the page still says it cut something');
      }
    }
    assert.equal(renders, 52);
  });

  test('every payload in every field AT ONCE still cannot make a tag', () => {
    const benign: Detour = {
      title: BENIGN, domain: BENIGN,
      files: [{ path: BENIGN, content: BENIGN }],
      stops: [{ file: BENIGN, startLine: 1, endLine: 1, text: BENIGN }],
    };
    const benignHtml = renderNarratorHtml(stateAt(0, { detour: benign }), FAKE_SKINS);
    for (const [name, payload] of PAYLOADS) {
      const detour: Detour = {
        title: payload, domain: payload,
        files: [{ path: payload, content: payload }],
        stops: [{ file: payload, startLine: 1, endLine: 1, text: payload }],
      };
      const hostile = renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS);
      assert.deepEqual(tagSequence(hostile), tagSequence(benignHtml), name);
      assert.ok(!strippedOfAllowedTokens(hostile, benignHtml).includes('<'), name);
    }
  });

  test('no model string reaches a script, a style, the title or an attribute — a whole-page sweep', () => {
    // The sweep T-6's reviewer ran by hand: mark the model's text with a sentinel and find
    // every place on the page it landed. Every hit must be inside a text node.
    const sentinel = 'zqSENTINELqz';
    const detour: Detour = {
      title: sentinel, domain: sentinel,
      files: [{ path: sentinel, content: sentinel }],
      stops: [{ file: sentinel, startLine: 1, endLine: 1, text: sentinel }],
    };
    const html = renderNarratorHtml(stateAt(0, { detour }), FAKE_SKINS);
    assert.ok(html.includes(sentinel), 'the model’s text really is drawn');
    assert.ok(!tagSequence(html).some((tag) => tag.includes(sentinel)), 'never inside a tag, so never in an attribute or a url');

    const regions = [/<script[^>]*>([\s\S]*?)<\/script>/g, /<style[^>]*>([\s\S]*?)<\/style>/g, /<title>([\s\S]*?)<\/title>/g];
    for (const region of regions) {
      for (const m of html.matchAll(region)) {
        assert.ok(!m[1]!.includes(sentinel), `the model’s text reached ${m[0].slice(0, 24)}…`);
      }
    }
    // Exactly where it is allowed to be, and nowhere else: the title, the domain sentence, the
    // stop row's "where", the current stop's heading, its text, and the file list's one path.
    // `files[].content` is NOT drawn — the real editor tab is what shows a file's contents.
    assert.equal([...html.matchAll(new RegExp(sentinel, 'g'))].length, 6);
  });

  test('the measure DISCRIMINATES — a renderer that interpolated raw WOULD be caught', () => {
    // Without this, every assertion above could be passing because the probe is blind.
    // Two deliberately broken renderers, measured the same way, must FAIL.
    const benign = renderNarratorHtml(positions(BENIGN)[2]![1], FAKE_SKINS);

    const rawIntoText = (payload: string) =>
      renderNarratorHtml(positions(payload)[2]![1], FAKE_SKINS)
        .replace(/<p class="stop-text">[\s\S]*?<\/p>/, `<p class="stop-text">${payload}</p>`);
    const broken = rawIntoText('<img src=x onerror="alert(1)">');
    assert.ok(strippedOfAllowedTokens(broken, benign).includes('<'), 'the `<` measure must catch a raw interpolation');
    assert.notDeepEqual(tagSequence(broken), tagSequence(benign), 'and so must the tag-sequence measure');

    // The other shape: a path interpolated into a `data-` attribute — the injection point the
    // header says this page does not have. The payload holds no `<` of its own, so what the
    // `<` measure sees is the `<li>` TAG itself failing to match the one it was allowed to
    // emit, which is why the tags are compared as a sequence rather than merely counted.
    const rawIntoAttr = (payload: string) =>
      renderNarratorHtml(positions(payload)[3]![1], FAKE_SKINS)
        .replace('<li class="stop stop-current">', `<li class="stop stop-current" data-file="${payload}">`);
    const attrBroken = rawIntoAttr('x" onmouseover="alert(1)');
    const attrBenign = renderNarratorHtml(positions(BENIGN)[3]![1], FAKE_SKINS);
    assert.ok(!attrBroken.includes('&quot;'), 'the broken renderer really did interpolate raw');
    assert.ok(strippedOfAllowedTokens(attrBroken, attrBenign).includes('<'), 'the `<` measure catches the changed tag');
    assert.notDeepEqual(tagSequence(attrBroken), tagSequence(attrBenign), 'and so does the tag-sequence measure');
    assert.ok(tagSequence(attrBroken).some((tag) => /\son[a-z]+\s*=/i.test(tag)), 'and so does the handler probe');
  });
});

// ── the aside is a PROMISE, and the code has to keep it ──────────────────────────────────────

/**
 * **T-7 security review finding 3.** The aside used to read *"These files live outside your
 * project. Going back closes them and deletes them."* — true of the tabs, true of the detour
 * directory, and **not true of the copy**: `detours/cache/<hash>.json` holds the same
 * model-written bytes, `removeDetourAt` refuses that folder by name (correctly), `dispose()`
 * does not touch it, and nothing pruned it. A 61-step plan fully detoured was ~16 MB of model
 * output sitting in global storage permanently, under a sentence saying it had been deleted.
 *
 * This repository's honest-controls rule does not allow a page to state something the code does
 * not do, so both halves moved: the sentence now says the copy exists and why, and the copy is
 * bounded (`MAX_CACHE_ENTRIES`, pinned in `detour-store.test.ts`).
 *
 * The test is about the CLAIM, not about the wording: a rewrite that dropped the second clause
 * would put the promise back.
 */
suite('DETOUR_ASIDE — the sentence on the page is one the code keeps', () => {
  test('it still says the files are outside the project and that going back removes them', () => {
    assert.match(DETOUR_ASIDE, /outside your project/, 'AC2 is the reason the detour exists; the page has to say it');
    assert.match(DETOUR_ASIDE, /deletes them/, 'AC3 is what the way out promises');
  });

  test('and it no longer claims that NOTHING is kept, because something is', () => {
    // The half that was untrue. What is asserted is that the page admits to the copy — a
    // rewrite that says "closes them and deletes them" and stops there fails here.
    assert.match(DETOUR_ASIDE, /copy/i, 'the page does not mention the cached copy that survives the return');
    assert.match(DETOUR_ASIDE, /free|retak/i, 'and does not say WHY it is kept, so it reads like a leak rather than AC5');
    assert.ok(
      /outside your project/.test(DETOUR_ASIDE.slice(DETOUR_ASIDE.indexOf('copy'))) || /extension/i.test(DETOUR_ASIDE),
      'and does not say WHERE it is kept, which is the thing a learner would want to know',
    );
  });

  test('the page draws it, verbatim, once', () => {
    const html = renderNarratorHtml(stateAt(0), FAKE_SKINS);
    assert.equal(textOfClass(html, 'detour-aside'), DETOUR_ASIDE);
  });
});
