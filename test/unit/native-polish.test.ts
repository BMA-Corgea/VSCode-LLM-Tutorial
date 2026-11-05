// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-16 — native polish. One suite per finding from the design-polish audit, each written to
 * fail on the code it guards before the fix landed (red before green):
 *
 *   F-03  the taken option's consequence text is drawn in --ink, not --muted (dark: 4.09:1)
 *   F-04  the narrator dims text with the theme's muted colour, never with opacity
 *   F-02  pass, fail and the "news" lines carry a status marker from status tokens
 *   F-05  no palette title repeats its own category
 *   F-06  an empty Decisions tree shows a welcome with the first action; the notice page has an h1
 *   F-01  a press's outcome is brought into view after the repaint the press causes
 *
 * The rendered numbers (contrast, consecutive first screens) are measured headless by the
 * design-polish probe, outside this suite. These tests pin the source shape that produces them,
 * so a later edit cannot quietly undo the fix.
 *
 * Kept in its own file, not in walk-step-view.test.ts, so a ticket that later rewrites the
 * options list (T-21) does not have to rebase through it.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type SkinsModule } from '../../src/start/view.js';
import { stepDial } from '../../src/walk/model.js';
import type { StepViewState } from '../../src/walk/step-protocol.js';
import { renderNoticeHtml, renderStepHtml } from '../../src/walk/step-view.js';
import { renderNarratorHtml, type NarratorViewState } from '../../src/detour/narrator.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

const FAKE_SKINS: SkinsModule = {
  SKINS: [
    { name: 'system', label: 'System', note: 'follow the editor' },
    { name: 'dark', label: 'Dark', note: 'always dark' },
  ],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

function stateAt(id: string, overrides: Partial<StepViewState> = {}): StepViewState {
  const plan = fixturePlan();
  const progress = fixtureProgress(plan);
  const step = plan.steps.find((s) => s.id === id);
  assert.ok(step, `the fixture plan should have a step ${id}`);
  return {
    plan, progress, step, fileExists: true, dial: stepDial(progress, id), skin: 'system',
    transcript: [], detour: { generating: false }, ...overrides,
  };
}

function narratorState(current = 1): NarratorViewState {
  return {
    current,
    skin: 'system',
    detour: {
      title: 'A vending machine that makes change',
      domain: 'coin-operated hardware',
      files: [{ path: 'coins.ts', content: 'export const COINS = [200, 100, 50];\n' }],
      stops: [
        { file: 'coins.ts', startLine: 1, endLine: 1, text: 'The denominations, largest first.' },
        { file: 'coins.ts', startLine: 1, endLine: 1, text: 'One coin at a time.' },
        { file: 'coins.ts', startLine: 1, endLine: 1, text: 'Why greedy is enough.' },
      ],
    },
  };
}

/** Every `<style>` block of a page, joined, with whitespace squeezed out so a rule can be
 *  matched without caring how the source sheet happens to be formatted. */
function cssOf(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}

/** The declarations of every rule whose selector list contains `selector` exactly. */
function declarationsFor(css: string, selector: string): string {
  const squeezed = selector.replace(/\s+/g, '');
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    if (selectors.includes(squeezed)) out.push(m[2]!);
  }
  return out.join(';');
}

function manifest(): {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
  };
} {
  // The unit build runs from dist/test/unit/, so the manifest is three levels up from here.
  const candidates = [path.resolve(__dirname, '../../../package.json'), path.resolve(__dirname, '../../package.json')];
  const file = candidates.find((p) => fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).name === 'build-tutorials');
  assert.ok(file, 'the extension manifest should be found above the test build');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── F-03 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-03 — the taken option keeps its text readable on its highlight', () => {
  test('the consequence inside the taken option is drawn in --ink, not the muted grey', () => {
    const css = cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));
    const decls = declarationsFor(css, '.option-taken .option-consequence');
    assert.match(decls, /color:var\(--ink\)/, 'muted text on the search-match orange is 4.09:1 in Dark Modern');
  });
});

// ── F-04 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-04 — the narrator dims text with the theme, never with opacity', () => {
  test('no text rule in the narrator sheet uses opacity (only a disabled button may)', () => {
    const html = renderNarratorHtml(narratorState(1), FAKE_SKINS);
    const pageCss = /<style[^>]*>([^<]*\.stop-list[\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    assert.ok(pageCss.length > 0, 'the narrator page sheet should be inlined');
    const offenders = [...pageCss.replace(/\s+/g, '').matchAll(/([^{}]+)\{([^{}]*opacity:[^{}]*)\}/g)]
      .map((m) => m[1]!)
      .filter((sel) => sel !== '.btn[disabled]');
    assert.deepEqual(offenders, [], 'opacity over text fails contrast in Light Modern (3.38:1) and HC Light (3.94:1)');
  });

  test('the current stop still differs from the others, so two states never look the same', () => {
    const css = cssOf(renderNarratorHtml(narratorState(1), FAKE_SKINS));
    const current = declarationsFor(css, '.stop-list .stop-current');
    assert.match(current, /font-weight:600/);
    assert.match(current, /border-left-color:/);
    assert.match(declarationsFor(css, '.stop-list .stop'), /color:var\(--muted\)/);
  });
});

// ── F-02 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-02 — pass and fail are told apart by a status marker from status tokens', () => {
  const css = cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));

  test('under System the status roles come from VS Code status colours, not symbol-icon colours', () => {
    const system = declarationsFor(css, ':root:not([data-theme])');
    assert.match(system, /--status-ok:var\(--vscode-testing-iconPassed/);
    assert.match(system, /--status-bad:var\(--vscode-testing-iconFailed/);
    assert.match(system, /--status-news:var\(--vscode-notificationsInfoIcon-foreground/);
    assert.doesNotMatch(system, /--status-[a-z]+:var\(--vscode-symbolIcon/,
      'symbolIcon.* is plain foreground in every default theme — the reason pass and fail looked alike');
  });

  test('the summary carries a marker in its own status colour, pass and fail different', () => {
    assert.match(declarationsFor(css, '.check-summary.check-pass'), /border-left-color:var\(--status-ok\)/);
    assert.match(declarationsFor(css, '.check-summary.check-fail'), /border-left-color:var\(--status-bad\)/);
    assert.match(declarationsFor(css, '.check-summary'), /border-left:3pxsolid/);
  });

  test('every "news" line carries the news marker', () => {
    // :not(:empty) — the open-file hint is always on the page, empty when the file exists, and
    // an empty line must not grow a stray mark.
    for (const sel of ['.hint', '.write-note', '.tutor-note', '.detour-note', '.detour-open', '.tutor-elsewhere', '.tutor-spend']) {
      assert.match(declarationsFor(css, `${sel}:not(:empty)`), /border-left:2pxsolidvar\(--status-news\)/, `${sel} should carry the news marker`);
    }
  });
});

// ── F-05 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-05 — the palette shows each command once, as "<category>: <title>"', () => {
  test('no command title repeats its own category', () => {
    const repeats = manifest().contributes.commands
      .filter((c) => c.category && c.title.startsWith(`${c.category}:`))
      .map((c) => c.command);
    assert.deepEqual(repeats, [], 'VS Code prints the category in front of the title: "Build Tutorials: Build Tutorials: Start"');
  });

  test('the palette still reads "Build Tutorials: Start", the string every notice and the README quote', () => {
    const start = manifest().contributes.commands.find((c) => c.command === 'buildTutorials.start');
    assert.ok(start);
    assert.equal(`${start.category}: ${start.title}`, 'Build Tutorials: Start');
  });
});

// ── F-06 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-06 — the first run offers the first action where the eye is', () => {
  test('the empty Decisions view shows a welcome whose button runs a real, contributed command', () => {
    const m = manifest();
    const welcome = (m.contributes.viewsWelcome ?? []).find((w) => w.view === 'buildTutorials.decisions');
    assert.ok(welcome, 'an empty tree view should carry welcome content (VS Code views guideline)');
    const linked = [...welcome.contents.matchAll(/\(command:([A-Za-z0-9_.]+)\)/g)].map((x) => x[1]);
    assert.deepEqual(linked, ['buildTutorials.start']);
    assert.ok(m.contributes.commands.some((c) => c.command === 'buildTutorials.start'));
  });

  test('the notice page has exactly one h1, and still says the notice', () => {
    const notice = 'No tutorial in this folder yet. Run "Build Tutorials: Start" to build one.';
    const html = renderNoticeHtml(notice);
    assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1);
    assert.ok(html.includes('No tutorial in this folder yet. Run &quot;Build Tutorials: Start&quot; to build one.')
      || html.includes('No tutorial in this folder yet. Run "Build Tutorials: Start" to build one.'));
  });
});

// ── F-01 ─────────────────────────────────────────────────────────────────────────────────────

/** A minimal stand-in for the webview DOM: only what the step script touches, plus a spy for
 *  `scrollIntoView` and `scrollTo`. Elements are created for every id the page renders. */
class El {
  value = '';
  textContent = '';
  scrolled: unknown[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  addEventListener(t: string, fn: (e: unknown) => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  dispatch(t: string, e: unknown = {}): void { for (const fn of this.listeners.get(t) ?? []) fn(e); }
  scrollIntoView(opts: unknown): void { this.scrolled.push(opts); }
}

function runStepScript(html: string, saved?: unknown) {
  const elements = new Map<string, El>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) elements.set(m[1]!, new El());
  const stepId = /<main id="step-main" data-step-id="([^"]*)"/.exec(html)?.[1];
  assert.ok(stepId !== undefined);
  elements.get('step-main')!.setAttribute('data-step-id', stepId);
  const windowCalls: unknown[] = [];
  const windowListeners = new Map<string, Array<(e: unknown) => void>>();
  const fakeWindow = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { windowListeners.set(t, [...(windowListeners.get(t) ?? []), fn]); },
    scrollTo: (...args: unknown[]) => { windowCalls.push(args); },
  };
  const posted: Array<{ type: string }> = [];
  const states: unknown[] = saved === undefined ? [] : [saved];
  const api = () => ({
    postMessage: (m: { type: string }) => posted.push(m),
    getState: () => states[states.length - 1],
    setState: (s: unknown) => states.push(s),
  });
  const fakeDocument = {
    documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined },
    getElementById: (id: string) => elements.get(id) ?? null,
  };
  const [, code] = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html) ?? [];
  assert.ok(code);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- fake DOM, no untrusted input
  new Function('document', 'window', 'acquireVsCodeApi', code)(fakeDocument, fakeWindow, api);
  const send = (data: unknown) => { for (const fn of windowListeners.get('message') ?? []) fn({ data }); };
  return { elements, posted, states, windowCalls, send };
}

const CHECK_PASS: Partial<StepViewState> = {
  check: {
    summary: 'every part is there: 1 export present',
    report: { symbols: [{ name: 'tokenize', kind: 'function', status: 'present' }], imports: [], parseErrors: 0, ok: true },
  },
};

suite('T-16 F-01 — a press\'s outcome is brought into view after the repaint it causes', () => {
  test('each outcome region has the id the script reveals by', () => {
    const checked = renderStepHtml(stateAt('st-2-file-parse', CHECK_PASS), FAKE_SKINS);
    assert.match(checked, /<section class="check" id="outcome-check">/);
    const idle = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    assert.match(idle, /<div class="tutor-ask" id="outcome-tutor">/);
    assert.match(idle, /<div class="detour" id="outcome-detour">/);
  });

  test('pressing Check my work records the outcome to reveal before it posts', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.elements.get('btn-check')!.dispatch('click');
    assert.deepEqual(dom.posted.map((p) => p.type), ['step:check']);
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, 'check');
  });

  test('asking and the detour controls record their own outcomes', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.elements.get('tutor-input')!.value = 'why?';
    dom.elements.get('btn-tutor-ask')!.dispatch('click');
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, 'tutor');
    dom.elements.get('btn-detour-start')!.dispatch('click');
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, 'detour');
  });

  test('the page after the repaint scrolls that outcome into view, once', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', CHECK_PASS), FAKE_SKINS);
    const dom = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: 'check' });
    assert.deepEqual(dom.elements.get('outcome-check')!.scrolled, [{ block: 'nearest', behavior: 'auto' }]);
    const last = dom.states[dom.states.length - 1] as { reveal?: string };
    assert.equal(last.reveal, undefined, 'a reveal is one-shot: the next repaint must not jump again');
  });

  test('a reveal saved on another step, or naming no known outcome, scrolls nothing', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', CHECK_PASS), FAKE_SKINS);
    const other = runStepScript(html, { stepId: 'st-1-shape-src', note: '', draft: '', reveal: 'check' });
    assert.deepEqual(other.elements.get('outcome-check')!.scrolled, []);
    for (const bogus of ['__proto__', 'step-main', 'check"', '']) {
      const dom = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: bogus });
      assert.deepEqual(dom.elements.get('outcome-check')!.scrolled, [], `reveal ${JSON.stringify(bogus)} must be ignored`);
    }
  });

  test('a repaint on the same step returns to where the learner was', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', y: 640 });
    assert.deepEqual(dom.windowCalls, [[0, 640]]);
    const fresh = runStepScript(html, { stepId: 'st-1-shape-src', note: '', draft: '', y: 640 });
    assert.deepEqual(fresh.windowCalls, [], 'a new step starts at its top');
  });

  test('a press the host answers with a note and no repaint: the note comes into view, the reveal is dropped', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.elements.get('tutor-input')!.value = '';
    dom.elements.get('btn-tutor-ask')!.dispatch('click');
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, 'tutor');
    dom.send({ type: 'step:note', payload: { note: 'There is nothing to ask yet — type a question first.' } });
    assert.equal(dom.elements.get('step-note')!.textContent, 'There is nothing to ask yet — type a question first.');
    assert.deepEqual(dom.elements.get('step-note')!.scrolled, [{ block: 'nearest', behavior: 'auto' }]);
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, undefined);
  });

  test('with nothing to reveal and nowhere to return to, the saved state keeps its old shape', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.elements.get('tutor-input')!.value = 'draft';
    dom.elements.get('tutor-input')!.dispatch('input');
    assert.deepEqual(dom.states[dom.states.length - 1], { stepId: 'st-2-file-parse', note: '', draft: 'draft' });
  });
});
