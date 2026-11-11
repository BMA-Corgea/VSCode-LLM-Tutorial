// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/start/view.ts — pure (no `vscode`). Two different senses of "DOM assertion" for AC2,
 * on purpose, since they catch different bugs:
 *
 *   1. `renderStartHtml` output, inspected as markup: does the SERVER-rendered page put the
 *      honesty line under the idea field when state says it should. Catches a template bug.
 *   2. The REAL client script, executed against a minimal hand-built fake DOM (no jsdom
 *      dependency — just enough of `document`/`window`/`acquireVsCodeApi` for this one
 *      script): does the SHIPPED code actually write an incoming `form:problems` message
 *      into the right node's `textContent`. Catches exactly the repo-tour T-3 lesson this
 *      whole guard exists for — a script that parses fine and does nothing.
 *
 * A fake skins module stands in for repo-tour's real one so this suite never touches it.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyRequest, IDEA_FIRST_MESSAGE } from '../../src/start/request.js';
import { failedInARowAfter, handleStartMessage, type PanelState, type StartEffects } from '../../src/start/protocol.js';
import { FAILED_AGAIN, renderStartHtml, SUBMIT_NOTES, type SkinsModule } from '../../src/start/view.js';

const FAKE_SKINS: SkinsModule = {
  SKINS: [
    { name: 'system', label: 'System', note: 'follow the editor' },
    { name: 'dark', label: 'Dark', note: 'always dark' },
  ],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

function state(overrides: Partial<PanelState> = {}): PanelState {
  return { request: emptyRequest(), problems: {}, skin: 'system', building: false, refusedInARow: 0, ...overrides };
}

suite('renderStartHtml — markup-level DOM assertions (AC1, AC2)', () => {
  test('AC1: the idea textbox, recreate checkbox, repo field, target field and dial radios are all present', () => {
    const html = renderStartHtml(state(), FAKE_SKINS);
    assert.match(html, /<textarea id="idea" name="idea"/);
    assert.match(html, /<input type="checkbox" id="recreate" name="recreate">/);
    assert.match(html, /<input type="text" id="repo" name="repo"/);
    assert.match(html, /<input type="text" id="target" name="target"/);
    assert.equal([...html.matchAll(/<input type="radio" name="dial"/g)].length, 3, 'exactly three dial positions');
    assert.match(html, /<button type="submit"[^>]*>Build the plan<\/button>/);
  });

  test('AC2: the idea-first honesty line appears, verbatim, under the idea field — no silent decline', () => {
    const html = renderStartHtml(state({ problems: { idea: IDEA_FIRST_MESSAGE } }), FAKE_SKINS);
    assert.match(html, new RegExp(`id="problem-idea">${IDEA_FIRST_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</div>`));
  });

  test('with no problem, the same node is present but empty — the client only ever sets textContent', () => {
    const html = renderStartHtml(state(), FAKE_SKINS);
    assert.match(html, /<div class="problem" data-field="idea" id="problem-idea"><\/div>/);
  });

  test('previously typed values round-trip into value=/checked attributes (host re-renders from its own state)', () => {
    const html = renderStartHtml(
      state({ request: { idea: 'x', recreate: true, repo: '/r', target: '/t', dial: 'scaffolded' } }),
      FAKE_SKINS,
    );
    assert.match(html, /<textarea id="idea" name="idea"[^>]*>x<\/textarea>/);
    assert.match(html, /id="recreate" name="recreate" checked>/);
    assert.match(html, /id="repo" name="repo" value="\/r"/);
    assert.match(html, /id="target" name="target" value="\/t"/);
    assert.match(html, /value="scaffolded" checked>/);
  });

  test('the skin picker lists every row FAKE_SKINS provides, with the current one selected', () => {
    const html = renderStartHtml(state({ skin: 'dark' }), FAKE_SKINS);
    assert.match(html, /<option value="dark"[^>]*selected>Dark<\/option>/);
    assert.equal([...html.matchAll(/<option/g)].length, 2);
  });

  test('the real client script parses (AC7, on the actual shipped script, not a synthetic stand-in)', () => {
    const html = renderStartHtml(state(), FAKE_SKINS);
    const [, code] = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html) ?? [];
    assert.ok(code && code.length > 200, 'the script block should be present and non-trivial');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- parse-only, see test/unit/page.test.ts
    assert.doesNotThrow(() => new Function(code));
  });
});

// ── a minimal, dependency-free fake DOM: just enough of document/window/acquireVsCodeApi
// for THIS script. Deliberately not jsdom — the goal is to run the exact shipped code with
// as little else as possible standing between the assertion and the real script text.
class FakeElement {
  value = '';
  checked = false;
  textContent = '';
  disabled = false;
  focused = 0;
  private readonly attrs = new Map<string, string>();
  focus(): void { this.focused += 1; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | undefined { return this.attrs.get(name); }
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

class FakeForm extends FakeElement {
  radios: FakeElement[] = [];
  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'input[name="dial"]' ? this.radios : [];
  }
}

function radio(value: string, checked: boolean): FakeElement {
  const el = new FakeElement();
  el.value = value;
  el.checked = checked;
  return el;
}

function buildFakeDom() {
  const ids = ['idea', 'recreate', 'repo', 'target', 'problem-idea', 'problem-repo', 'problem-target', 'browse-repo', 'browse-target', 'skinpick', 'submit-note', 'build-btn'];
  const elements = new Map<string, FakeElement>();
  for (const id of ids) elements.set(id, new FakeElement());

  const form = new FakeForm();
  form.radios = [radio('manual', true), radio('scaffolded', false), radio('automated', false)];
  elements.set('start-form', form);

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
  const states: unknown[] = [];
  const acquireVsCodeApi = () => ({
    postMessage: (m: { type: string; payload: unknown }) => posted.push(m),
    getState: () => states[states.length - 1],
    setState: (s: unknown) => states.push(s),
  });

  return { elements, form, fakeDocument, fakeWindow, windowListeners, posted, states, docAttrs, acquireVsCodeApi };
}

/**
 * Runs the REAL shipped script — extracted from `renderStartHtml`'s own output, so this is
 * the bootstrap (`post`/`restore`/`save`, from `src/webview/page.ts`) combined with
 * `startScript()` exactly as `renderPage` combines them for the real webview, never
 * `startScript()` in isolation (which alone has no `post`/`save` and would throw the moment
 * either is called — caught by this fix itself, see the handoff). `document`, `window` and
 * `acquireVsCodeApi` are passed in as constructor-injected parameters — the only globals
 * this script touches. This is the one, deliberate, parse-and-execute use of the Function
 * constructor `no-implied-eval` warns about in this test file; every test below calls this
 * helper rather than repeating the disable.
 */
function runScript(dom: ReturnType<typeof buildFakeDom>): void {
  const html = renderStartHtml(state(), FAKE_SKINS);
  const [, code] = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html) ?? [];
  assert.ok(code, 'renderStartHtml should inline a <script> block');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- fake DOM, no untrusted input; see the doc comment above
  const fn = new Function('document', 'window', 'acquireVsCodeApi', code);
  fn(dom.fakeDocument, dom.fakeWindow, dom.acquireVsCodeApi);
}

suite('the start screen\'s client script, actually executed against a fake DOM (AC2, AC7)', () => {
  test('receiving a form:problems message writes the message into the right node\'s textContent', () => {
    const dom = buildFakeDom();
    runScript(dom);

    const messageHandlers = dom.windowListeners.get('message') ?? [];
    assert.equal(messageHandlers.length, 1, 'the script should register exactly one message listener');

    messageHandlers[0]!({ data: { type: 'form:problems', payload: { problems: { idea: IDEA_FIRST_MESSAGE } } } });

    assert.equal(dom.elements.get('problem-idea')?.textContent, IDEA_FIRST_MESSAGE);
    assert.equal(dom.elements.get('problem-repo')?.textContent, '', 'a field with no problem is cleared, not left stale');
  });

  test('a stale message is cleared on the NEXT form:problems that no longer names it (discriminates)', () => {
    const dom = buildFakeDom();
    runScript(dom);
    const [onMessage] = dom.windowListeners.get('message') ?? [];

    onMessage!({ data: { type: 'form:problems', payload: { problems: { repo: 'no folder found at /x' } } } });
    assert.equal(dom.elements.get('problem-repo')?.textContent, 'no folder found at /x');

    onMessage!({ data: { type: 'form:problems', payload: { problems: {} } } });
    assert.equal(dom.elements.get('problem-repo')?.textContent, '', 'fixed on the next message, not stuck forever');
  });

  test('a change event posts form:changed with the values actually read off the fake fields', () => {
    const dom = buildFakeDom();
    runScript(dom);

    dom.elements.get('idea')!.value = 'a chat app';
    dom.elements.get('recreate')!.checked = true;
    dom.elements.get('repo')!.value = '/tmp/r';
    dom.elements.get('target')!.value = '/tmp/t';
    dom.form.radios[1]!.checked = true; // scaffolded
    dom.form.radios[0]!.checked = false; // manual, was the initial default

    dom.form.dispatch('change');

    assert.equal(dom.posted.length, 1);
    assert.deepEqual(dom.posted[0], {
      type: 'form:changed',
      payload: { request: { idea: 'a chat app', recreate: true, repo: '/tmp/r', target: '/tmp/t', dial: 'scaffolded' } },
    });
    assert.equal(dom.states.length, 1, 'the current request is also saved to view state');
  });

  test('a field:set message (from a folder pick) updates the field\'s value AND its problem text', () => {
    const dom = buildFakeDom();
    runScript(dom);
    const [onMessage] = dom.windowListeners.get('message') ?? [];

    onMessage!({
      data: { type: 'field:set', payload: { field: 'target', value: '/picked/folder', problems: { repo: 'required when recreating' } } },
    });

    assert.equal(dom.elements.get('target')?.value, '/picked/folder');
    assert.equal(dom.elements.get('problem-repo')?.textContent, 'required when recreating');
    assert.equal(dom.elements.get('problem-target')?.textContent, '', 'target itself has no problem in this payload');
  });

  test('picking a skin sets data-theme on <html> INSTANTLY (no host round-trip needed to see it)', () => {
    const dom = buildFakeDom();
    runScript(dom);

    dom.elements.get('skinpick')!.value = 'dark';
    dom.elements.get('skinpick')!.dispatch('change');

    assert.equal(dom.docAttrs.get('data-theme'), 'dark');
    assert.deepEqual(dom.posted, [{ type: 'skin:set', payload: { skin: 'dark' } }]);
  });

  test('picking "system" REMOVES data-theme rather than setting it to the string "system"', () => {
    const dom = buildFakeDom();
    runScript(dom);

    dom.docAttrs.set('data-theme', 'dark'); // as if a skin was previously chosen
    dom.elements.get('skinpick')!.value = 'system';
    dom.elements.get('skinpick')!.dispatch('change');

    assert.equal(dom.docAttrs.has('data-theme'), false);
  });
});

/**
 * T-15 — the pin, and it deliberately asserts a PROPERTY rather than a sentence.
 *
 * The defect was not a missing message. Every problem was already named, under its own field, in
 * plain language — the page was *correct* and the press was still indistinguishable from being
 * ignored, because the reply to `form:submit` was byte-identical to the reply a keystroke had
 * already produced.
 *
 * So the thing that was false is: **the render after a press differs from the render before it.**
 * That is what these tests assert, for BOTH paths. A test asserting "the note says three things
 * need fixing" would pin today's wording and let a redesign satisfy it while reintroducing the
 * bug; this survives rewording every message on the page.
 *
 * `observable()` is deliberately a snapshot of what a person could SEE — every element's text,
 * plus the button's label and disabled state. Focus is counted too, but it is not what carries
 * the assertion: a note that changes is visible whether or not focus moved, and focus alone would
 * be invisible to a reader who was not watching the caret.
 */
suite('a press always changes something on the page (T-15)', () => {
  /**
   * **This drives the REAL protocol, not a hand-picked message**, and that distinction is the
   * whole value of the suite. A first version of this pin delivered `form:rejected` to the page
   * directly and asserted the page changed. It passed — and it *kept* passing when the defect was
   * reintroduced by hand, because the defect is in **which message the host chooses to send**, and
   * a test that hands the page the right message never exercises that choice. It was coverage
   * aimed at a path the bug does not live on.
   *
   * So: build a request, ask `handleStartMessage` what a `form:submit` produces, and feed **its
   * actual reply** to the page. That spans both halves — the protocol's choice and the view's
   * rendering — which is where the property actually lives.
   */
  const BAD = { ...emptyRequest(), idea: '', repo: '', target: '' };
  /**
   * **The first version of this fixture was not valid, and the ACCEPTED test was therefore a
   * second REJECTED test** (review finding 1). `emptyRequest()` leaves `recreate: false`, so an
   * idea typed without it trips the T-9 honesty line, and `/tmp/ref` does not exist — the reply
   * was `form:rejected` with `count: 2`, and the assertion passed because the *rejected* branch
   * fills the note. Proof it was checking nothing: renaming the `form:accepted` handler so the
   * message fell through unhandled left the whole suite green.
   *
   * Real directories and `recreate: true`, so the request is genuinely valid. If this ever stops
   * producing `form:accepted` the assertion below says so out loud rather than passing on the
   * other branch.
   */
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'start-view-'));
  const GOOD = { ...emptyRequest(), recreate: true, repo: tmp(), target: tmp() };

  const effects = (): StartEffects => ({
    // `Promise.resolve(...)` rather than an `async` arrow with no `await`: the lint rule that
    // catches a pointless `async` is right, and the seam only needs a thenable here.
    pickFolder: () => Promise.resolve(undefined),
    submit: () => undefined,
    persistSkin: () => undefined,
  });

  function observable(dom: ReturnType<typeof buildFakeDom>): string {
    const parts: string[] = [];
    for (const [id, el] of dom.elements) parts.push(`${id}:text=${el.textContent}:disabled=${String(el.disabled)}`);
    return parts.join('|');
  }

  /** The page as it really stands when a finger reaches the button: every edit has already been
   *  validated, so the problem lines are on screen before the press. Then press for real. */
  async function press(dom: ReturnType<typeof buildFakeDom>, request: typeof BAD): Promise<{ before: string; after: string }> {
    const handlers = dom.windowListeners.get('message') ?? [];
    assert.equal(handlers.length, 1);
    const typed = await handleStartMessage(state(), { type: 'form:changed', payload: { request } }, effects());
    if (typed.post) handlers[0]!({ data: typed.post });
    const before = observable(dom);
    const pressed = await handleStartMessage(typed.state, { type: 'form:submit', payload: { request } }, effects());
    assert.ok(pressed.post, 'a press must reply with something');
    handlers[0]!({ data: pressed.post });
    return { before, after: observable(dom) };
  }

  test('REJECTED: the page after a real rejected press differs from the page before it', async () => {
    const dom = buildFakeDom();
    runScript(dom);
    const { before, after } = await press(dom, BAD);
    assert.notEqual(after, before, 'a rejected press left the page byte-identical — the T-15 defect');
  });

  test('ACCEPTED: the page after a real accepted press differs from the page before it', async () => {
    const dom = buildFakeDom();
    runScript(dom);
    // Asserted FIRST, because the previous version of this test passed on the rejected branch
    // without ever exercising the one it is named for.
    const reply = await handleStartMessage(state(), { type: 'form:submit', payload: { request: GOOD } }, effects());
    assert.equal(reply.post?.type, 'form:accepted', 'the fixture must actually be valid, or this test proves nothing');

    const { before, after } = await press(dom, GOOD);
    assert.notEqual(after, before, 'an accepted press left the page unchanged — the worse half of T-15');
    assert.equal(dom.elements.get('build-btn')?.disabled, true, 'an accepted press must quiet the button');
  });

  test('every state of the note says something, and something different (the table the pins below read)', () => {
    // The ending pins compare the page with SUBMIT_NOTES rather than typing the words — so a table
    // of empty or repeated strings would let them pass while the note said nothing. This is what
    // stops that: five states, five non-empty, distinct sentences.
    const said = Object.values(SUBMIT_NOTES);
    assert.equal(said.length, 5);
    for (const line of said) assert.ok(line.trim().length > 0, 'a state whose note is empty is a state nobody can see');
    assert.equal(new Set(said).size, said.length, 'two states that say the same words look identical');
  });

  for (const ended of ['built', 'failed', 'cancelled'] as const) {
    test(`a build that ENDS (${ended}) gives the button back and the note says how it ended (review finding 2, AC4)`, () => {
      const dom = buildFakeDom();
      runScript(dom);
      const handlers = dom.windowListeners.get('message') ?? [];
      handlers[0]!({ data: { type: 'form:accepted' } });
      assert.equal(dom.elements.get('build-btn')?.disabled, true);
      assert.equal(dom.elements.get('submit-note')?.textContent, SUBMIT_NOTES.building);
      const building = observable(dom);

      handlers[0]!({ data: { type: 'form:idle', payload: { ended } } });
      assert.equal(dom.elements.get('build-btn')?.disabled, false, 'a failed or cancelled build must not strand a dead button');
      assert.equal(dom.elements.get('build-btn')?.textContent, 'Build the plan');
      // Read from the shipped table, never typed: the property is "the note says how it ended".
      assert.equal(dom.elements.get('submit-note')?.textContent, SUBMIT_NOTES[ended],
        'a button that silently comes back looks exactly like one that was never pressed');
      assert.notEqual(observable(dom), building);
    });
  }

  test('T-71: a failure that repeats itself changes the WORDS: the 2nd says so with its count, and the 3rd differs from the 2nd', () => {
    const dom = buildFakeDom();
    runScript(dom);
    const handlers = dom.windowListeners.get('message') ?? [];
    const notes: string[] = [];
    for (const inARow of [1, 2, 3]) {
      handlers[0]!({ data: { type: 'form:accepted' } });
      handlers[0]!({ data: { type: 'form:idle', payload: { ended: 'failed', inARow } } });
      notes.push(dom.elements.get('submit-note')?.textContent ?? '');
    }
    assert.equal(notes[0], SUBMIT_NOTES.failed);
    assert.equal(notes[1], FAILED_AGAIN.replace('{n}', '2'));
    assert.equal(notes[2], FAILED_AGAIN.replace('{n}', '3'));
    assert.equal(new Set(notes).size, 3, 'two failures in a row left the same words on screen');
    // An ending with no count (a host from before T-71) still says how it ended.
    handlers[0]!({ data: { type: 'form:idle', payload: { ended: 'failed' } } });
    assert.equal(dom.elements.get('submit-note')?.textContent, SUBMIT_NOTES.failed);
  });

  test('T-71: a re-render keeps the count, and the count is reset by an edit, a pick or any other ending', async () => {
    const html = renderStartHtml(state({ ended: 'failed', failedInARow: 2 }), FAKE_SKINS);
    assert.ok(html.includes(FAILED_AGAIN.replace('{n}', '2')), 'a tab switch forgot that it was the second failure');
    assert.ok(renderStartHtml(state({ ended: 'failed', failedInARow: 1 }), FAKE_SKINS).includes(SUBMIT_NOTES.failed));
    assert.deepEqual([failedInARowAfter(undefined, 'failed'), failedInARowAfter(1, 'failed'), failedInARowAfter(2, 'failed')], [1, 2, 3]);
    assert.deepEqual([failedInARowAfter(3, 'built'), failedInARowAfter(3, 'cancelled')], [0, 0]);
    const edited = await handleStartMessage(state({ ended: 'failed', failedInARow: 2 }), { type: 'form:changed', payload: { request: emptyRequest() } }, effects());
    assert.equal(edited.state.failedInARow, 0, 'an edit must reset the count');
    const picked = await handleStartMessage(state({ ended: 'failed', failedInARow: 2 }), { type: 'pick:target' }, { ...effects(), pickFolder: () => Promise.resolve('/a/folder') });
    assert.equal(picked.state.failedInARow, 0, 'a folder pick must reset the count');
  });

  test('a SECOND press with no edit changes the WORDS on screen, not an attribute nobody sees (review finding 3, AC2)', async () => {
    // September's version of this test asserted a data-press attribute, and passed, while a person
    // pressing twice saw nothing change at all (re-driven 2026-11-05 in a real webview). This one
    // compares what a person could see — `observable()`, every element's text and disabled state.
    const dom = buildFakeDom();
    runScript(dom);
    const handlers = dom.windowListeners.get('message') ?? [];
    const one = await handleStartMessage(state(), { type: 'form:submit', payload: { request: BAD } }, effects());
    handlers[0]!({ data: one.post });
    const afterFirst = observable(dom);
    const two = await handleStartMessage(one.state, { type: 'form:submit', payload: { request: BAD } }, effects());
    handlers[0]!({ data: two.post });
    const afterSecond = observable(dom);
    assert.notEqual(afterSecond, afterFirst, 'two identical presses left the screen identical — the defect, one press later');
    const three = await handleStartMessage(two.state, { type: 'form:submit', payload: { request: BAD } }, effects());
    handlers[0]!({ data: three.post });
    assert.notEqual(observable(dom), afterSecond, 'and the third differs from the second, not just from the first');
  });

  test('a press that reaches the host DURING a build starts nothing, and the note says so (AC3)', async () => {
    const dom = buildFakeDom();
    runScript(dom);
    const handlers = dom.windowListeners.get('message') ?? [];
    let started = 0;
    const counting: StartEffects = { ...effects(), submit: () => { started += 1; } };
    const first = await handleStartMessage(state(), { type: 'form:submit', payload: { request: GOOD } }, counting);
    handlers[0]!({ data: first.post });
    const afterFirst = observable(dom);
    // The second click of a double-click: it left the page before the first reply disabled the button.
    const second = await handleStartMessage(first.state, { type: 'form:submit', payload: { request: GOOD } }, counting);
    assert.equal(started, 1, 'a double-click started a second build of the same target');
    handlers[0]!({ data: second.post });
    assert.equal(dom.elements.get('submit-note')?.textContent, SUBMIT_NOTES.busy);
    assert.notEqual(observable(dom), afterFirst, 'the refused second press must change the screen too');
    assert.equal(dom.elements.get('build-btn')?.disabled, true);
  });

  test('an edit DURING a build leaves the building note alone — it is the only line saying so', () => {
    const dom = buildFakeDom();
    runScript(dom);
    const handlers = dom.windowListeners.get('message') ?? [];
    handlers[0]!({ data: { type: 'form:accepted' } });
    dom.elements.get('start-form')!.dispatch('change');
    assert.equal(dom.elements.get('submit-note')?.textContent, SUBMIT_NOTES.building);
  });

  test('a re-render after a build ended still says how it ended (code review finding 4)', () => {
    for (const ended of ['built', 'failed', 'cancelled'] as const) {
      const html = renderStartHtml(state({ ended }), FAKE_SKINS);
      assert.ok(html.includes(`data-kind="${ended}">${SUBMIT_NOTES[ended]}</p>`), `a re-render after "${ended}" forgot how the build ended`);
    }
    assert.ok(renderStartHtml(state(), FAKE_SKINS).includes('data-kind=""></p>'), 'and a fresh screen says nothing (discriminates)');
  });

  test('the note under the button is not drawn as a problem line (N5)', () => {
    const html = renderStartHtml(state({ building: true }), FAKE_SKINS);
    assert.match(html, /<p class="submit-note" id="submit-note"[^>]*data-kind="building"/);
    assert.doesNotMatch(html, /class="problem" id="submit-note"/);
  });

  test('a folder pick clears the note, so its count is never stale (review finding 4)', () => {
    const dom = buildFakeDom();
    runScript(dom);
    const handlers = dom.windowListeners.get('message') ?? [];
    handlers[0]!({ data: { type: 'form:rejected', payload: { problems: { repo: 'x', target: 'y' }, count: 2 } } });
    assert.notEqual(dom.elements.get('submit-note')?.textContent, '');
    handlers[0]!({ data: { type: 'field:set', payload: { field: 'target', value: '/somewhere', problems: { repo: 'x' } } } });
    assert.equal(dom.elements.get('submit-note')?.textContent, '', 'a note counting the OLD problems is a wrong note');
  });

  test('a re-render carries the in-flight build, so a tab switch cannot re-enable the button (review finding 5)', () => {
    const html = renderStartHtml(state({ building: true }), FAKE_SKINS);
    assert.match(html, /id="build-btn"[^>]*disabled/, 'the button must come back disabled after a re-render');
    assert.match(html, /Building…/);
    const idle = renderStartHtml(state({ building: false }), FAKE_SKINS);
    assert.doesNotMatch(idle, /id="build-btn"[^>]*disabled/, 'and enabled when no build is running (discriminates)');
  });

  test('THE DISCRIMINATOR: a keystroke on an unchanged request changes nothing, so the suite is not passing on drift', async () => {
    const dom = buildFakeDom();
    runScript(dom);
    const handlers = dom.windowListeners.get('message') ?? [];
    const first = await handleStartMessage(state(), { type: 'form:changed', payload: { request: BAD } }, effects());
    if (first.post) handlers[0]!({ data: first.post });
    const before = observable(dom);
    const again = await handleStartMessage(first.state, { type: 'form:changed', payload: { request: BAD } }, effects());
    if (again.post) handlers[0]!({ data: again.post });
    assert.equal(observable(dom), before, 'a repeated keystroke is idempotent; that is exactly why a press needed its own reply');
  });

  test('a SECOND rejected press is observable too — the note is cleared on edit', async () => {
    const dom = buildFakeDom();
    runScript(dom);
    const { after: afterFirst } = await press(dom, BAD);
    dom.elements.get('start-form')!.dispatch('change');
    assert.notEqual(observable(dom), afterFirst, 'editing must clear the note, or the next press cannot be seen');
  });
});
