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
import { emptyRequest, IDEA_FIRST_MESSAGE } from '../../src/start/request.js';
import type { PanelState } from '../../src/start/protocol.js';
import { renderStartHtml, type SkinsModule } from '../../src/start/view.js';

const FAKE_SKINS: SkinsModule = {
  SKINS: [
    { name: 'system', label: 'System', note: 'follow the editor' },
    { name: 'dark', label: 'Dark', note: 'always dark' },
  ],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

function state(overrides: Partial<PanelState> = {}): PanelState {
  return { request: emptyRequest(), problems: {}, skin: 'system', ...overrides };
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
  const ids = ['idea', 'recreate', 'repo', 'target', 'problem-idea', 'problem-repo', 'problem-target', 'browse-repo', 'browse-target', 'skinpick'];
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
