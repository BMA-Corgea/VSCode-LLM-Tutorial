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
import { renderNoticeHtml, renderStepHtml, stepRenderKey } from '../../src/walk/step-view.js';
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

// ── T-44 ──────────────────────────────────────────────────────────────────────────────────

suite('T-44 — under System the road a step is on reads as selected, not found', () => {
  const css = (): string => cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));
  const SYSTEM = ':root:not([data-theme]) .option-taken';

  test('the row is drawn with the selection background and the foreground that goes with it', () => {
    const decls = declarationsFor(css(), SYSTEM);
    assert.match(decls, /(^|;)background:var\(--vscode-list-inactiveSelectionBackground\)(;|$)/, 'the selection colour, in the editor\'s own vocabulary');
    assert.match(decls, /(^|;)color:var\(--vscode-list-inactiveSelectionForeground,var\(--ink\)\)(;|$)/, 'its foreground, or the body ink where a theme sets none');
  });

  test('its edge is the high-contrast theme\'s own, drawn only where a theme sets that colour', () => {
    assert.match(declarationsFor(css(), SYSTEM), /(^|;)outline:1pxsolidvar\(--vscode-contrastActiveBorder\)(;|$)/, 'an unset variable makes this outline invalid, so dark and light draw none');
  });

  test('the search-match colour is gone from the System row, with no fallback that could bring it back', () => {
    const decls = declarationsFor(css(), SYSTEM);
    assert.ok(decls.length > 0, 'discriminates: the rule exists');
    assert.ok(!decls.includes('--hl'), 'a theme with no selection colour marks the row with its edge, never the search colour');
  });

  test('the consequence line takes the same foreground, so a theme that sets one never mixes two', () => {
    assert.match(declarationsFor(css(), `${SYSTEM} .option-consequence`), /color:var\(--vscode-list-inactiveSelectionForeground,var\(--ink\)\)/);
  });

  test('a badge on that row takes the editor\'s badge colours, so it stays readable on the new background', () => {
    const decls = declarationsFor(css(), `${SYSTEM} .badge`);
    assert.match(decls, /background:var\(--vscode-badge-background\)/, 'the accent on its translucent fill is 3.69:1 on the selection colour');
    assert.match(decls, /color:var\(--vscode-badge-foreground\)/);
  });

  test('that badge keeps its shape in high contrast, with the theme\'s own edge', () => {
    assert.match(declarationsFor(css(), `${SYSTEM} .badge`), /outline:1pxsolidvar\(--vscode-contrastBorder\)/, 'its fill is black on hc\'s black page');
  });

  test('those are the only rules that style the marked row, and none is inside an at-rule (re-review of T-44)', () => {
    // The pins above read each rule's text, so they cannot see a later rule that overrides one, or a
    // wrapper that stops one applying. This reads the sheet's own structure, by brace depth.
    const sheet = cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));
    const rules: Array<{ selector: string; depth: number }> = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < sheet.length; i++) {
      if (sheet[i] === '{') { rules.push({ selector: sheet.slice(start, i), depth }); depth += 1; start = i + 1; }
      if (sheet[i] === '}') { depth -= 1; start = i + 1; }
    }
    assert.ok(rules.length > 20, 'discriminates: the sheet was read');
    const marked = rules.filter((rule) => rule.selector.includes('.option-taken'));
    assert.deepEqual(marked.map((rule) => rule.selector).sort(), [
      '.option-taken',
      '.option-taken.option-consequence',
      ':root:not([data-theme]).option-taken',
      ':root:not([data-theme]).option-taken.badge',
      ':root:not([data-theme]).option-taken.option-consequence',
    ].sort());
    assert.deepEqual(marked.filter((rule) => rule.depth !== 0), [], 'a rule inside an @media or @supports may never apply');
  });

  test('a named skin keeps its own highlight and the blue edge stays for every skin', () => {
    const base = declarationsFor(css(), '.option-taken');
    assert.match(base, /background:var\(--hl\)/, 'the rule a named skin still uses');
    assert.match(base, /border-color:var\(--accent\)/, 'the marked row keeps its edge whichever skin draws it');
  });
});

// ── T-43 ──────────────────────────────────────────────────────────────────────────────────

suite('T-43 — the tutor box looks like an input, and Forget is away from Ask', () => {
  const page = (over: Partial<StepViewState> = {}): string => renderStepHtml(stateAt('st-2-file-parse', over), FAKE_SKINS);
  const turn = { role: 'user', content: 'why is this its own module?' } as const;

  test('F-08: the box is drawn from the input tokens, not the panel\'s', () => {
    const decls = declarationsFor(cssOf(page()), '.tutor-input');
    assert.match(decls, /border:1pxsolidvar\(--field-edge\)/, 'the input border, which is what hc shows as its edge');
    assert.match(decls, /background:var\(--field-bg\)/);
    assert.ok(!/var\(--line\)|background:var\(--bg\)/.test(decls), 'the panel tokens are gone');
  });

  test('F-08: a keyboard focus shows an outline in the theme\'s focus colour', () => {
    assert.match(declarationsFor(cssOf(page()), '.tutor-input:focus'), /outline:1pxsolidvar\(--focus\)/);
  });

  test('F-08: under System its text is the theme\'s input foreground; a named skin keeps its own ink', () => {
    const css = cssOf(page());
    assert.match(declarationsFor(css, ':root:not([data-theme]) .tutor-input'), /color:var\(--vscode-input-foreground,var\(--ink\)\)/);
    assert.match(declarationsFor(css, '.tutor-input'), /color:var\(--ink\)/, 'the unscoped rule stays on the skin\'s ink');
  });

  test('F-09: Forget is not in the row with Ask; it is the last thing after the log', () => {
    const html = page({ transcript: [turn] });
    const askRow = /<div class="tutor-controls">([\s\S]*?)<\/div>/.exec(html.slice(html.indexOf('id="outcome-tutor"')))?.[1] ?? '';
    assert.ok(askRow.includes('id="btn-tutor-ask"'), 'discriminates: this is the ask row');
    assert.ok(!askRow.includes('id="btn-tutor-clear"'), 'a control that deletes the conversation does not sit beside Ask');
    const log = html.indexOf('</ul>', html.indexOf('class="tutor-log"'));
    const forget = html.indexOf('id="btn-tutor-clear"');
    const ask = html.indexOf('id="outcome-tutor"');
    assert.ok(log >= 0 && log < forget && forget < ask, 'after the conversation, before the box');
  });

  test('F-08: the focus outline is inset, so it does not grow the box', () => {
    assert.match(declarationsFor(cssOf(page()), '.tutor-input:focus'), /outline-offset:-1px/);
  });

  test('F-09: Forget stays a quiet button, and its press brings the tutor section back into view', () => {
    const html = page({ transcript: [turn] });
    assert.match(html, /<button type="button" class="btn btn-quiet" id="btn-tutor-clear">/);
    const dom = runStepScript(html);
    dom.elements.get('btn-tutor-clear')!.dispatch('click');
    dom.elements.get('btn-tutor-clear')!.dispatch('click');
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, 'tutor');
  });

  test('F-08: the placeholder, the only place the Enter rule is written, is the theme\'s own colour', () => {
    assert.match(declarationsFor(cssOf(page()), ':root:not([data-theme]) .tutor-input::placeholder'), /color:var\(--vscode-input-placeholderForeground,var\(--muted\)\)/);
  });

  test('F-09: a failed question keeps its reason beside it; Forget comes after that line', () => {
    const html = page({ transcript: [turn], tutor: { thinking: false, note: 'the tutor did not answer' } });
    const reason = html.indexOf('the tutor did not answer');
    const forget = html.indexOf('id="btn-tutor-clear"');
    assert.ok(reason > html.indexOf('</ul>', html.indexOf('class="tutor-log"')), 'discriminates: the reason follows the log');
    assert.ok(reason < forget, 'the reason, then Forget');
    assert.ok(forget < html.indexOf('id="outcome-tutor"'), 'and Forget still comes before the box');
  });

  test('the detour row sits clear of Ask', () => {
    assert.match(declarationsFor(cssOf(page()), '.detour'), /margin-top:8px/);
  });

  test('F-09: Forget is still there only when there is a conversation, and never mid-ask', () => {
    assert.ok(!page().includes('id="btn-tutor-clear"'), 'no conversation, no control');
    assert.ok(!page({ transcript: [turn], tutor: { thinking: true } }).includes('id="btn-tutor-clear"'), 'never while an answer is landing');
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

function runStepScript(html: string, saved?: unknown, codeBlocks: El[] = [], scrollY?: number) {
  const elements = new Map<string, El>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) elements.set(m[1]!, new El());
  const stepId = /<main id="step-main" data-step-id="([^"]*)"/.exec(html)?.[1];
  assert.ok(stepId !== undefined);
  elements.get('step-main')!.setAttribute('data-step-id', stepId);
  const windowCalls: unknown[] = [];
  const windowListeners = new Map<string, Array<(e: unknown) => void>>();
  const fakeWindow: { scrollY?: number; addEventListener: (t: string, fn: (e: unknown) => void) => void; scrollTo: (...a: unknown[]) => void } = {
    ...(scrollY === undefined ? {} : { scrollY }),
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
    querySelectorAll: (sel: string) => (sel === 'pre.tutor-code' ? codeBlocks : []),
  };
  const [, code] = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html) ?? [];
  assert.ok(code);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- fake DOM, no untrusted input
  new Function('document', 'window', 'acquireVsCodeApi', code)(fakeDocument, fakeWindow, api);
  const send = (data: unknown) => { for (const fn of windowListeners.get('message') ?? []) fn({ data }); };
  const scroll = (y: number) => { fakeWindow.scrollY = y; for (const fn of windowListeners.get('scroll') ?? []) fn({}); };
  const setScrollY = (y: number) => { fakeWindow.scrollY = y; };
  return { elements, posted, states, windowCalls, send, scroll, setScrollY };
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

  test('a press of Choose this instead records its own outcome, and the repaint brings the answer into view (T-21, C8)', () => {
    const state = stateAt('st-4-symbol-render', { choiceNote: 'That press was refused.' });
    const html = renderStepHtml(state, FAKE_SKINS);
    const pressed = runStepScript(html);
    pressed.elements.get('choose-1')!.dispatch('click');
    assert.equal((pressed.states[pressed.states.length - 1] as { reveal?: string }).reveal, 'choice');
    const dom = runStepScript(html, { stepId: 'st-4-symbol-render', note: '', draft: '', reveal: 'choice', revealAt: Date.now() });
    assert.deepEqual(dom.elements.get('outcome-choice')!.scrolled, [{ block: 'nearest', behavior: 'auto' }]);
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, undefined, 'one-shot');
  });

  test('a refusal answered on a page for another step is brought into view there (T-21 re-review F1)', () => {
    const REFUSED = 'That press was for a step you have since left, so nothing was recorded.';
    const html = renderStepHtml(stateAt('st-2-file-parse', { choiceNote: REFUSED }), FAKE_SKINS);
    const dom = runStepScript(html, { stepId: 'st-4-symbol-render', note: '', draft: '', reveal: 'choice', revealAt: Date.now() }, [], 0);
    assert.deepEqual(dom.elements.get('outcome-choice')!.scrolled, [{ block: 'nearest', behavior: 'auto' }]);
    assert.deepEqual(dom.windowCalls, [[0, 1]], 'off 0, or VS Code restores the old page\'s position over it');
  });

  test('no refusal, or one on the page the press was made on, needs no extra reveal (F1 discriminates)', () => {
    const REFUSED = 'That press was refused.';
    const quiet = runStepScript(renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS), { stepId: 'st-4-symbol-render', note: '', draft: '' }, [], 0);
    assert.deepEqual(quiet.windowCalls, [], 'no refusal on the page, nothing to bring into view');
    const samePage = runStepScript(renderStepHtml(stateAt('st-2-file-parse', { choiceNote: REFUSED }), FAKE_SKINS), { stepId: 'st-2-file-parse', note: '', draft: '' }, [], 0);
    assert.deepEqual(samePage.elements.get('outcome-choice')!.scrolled, [], 'a press on this step arms its own reveal, or asks for none');
    assert.deepEqual(samePage.windowCalls, []);
  });

  test('a question left half typed on one step survives a press on another, and is not shown there (T-21 re-review F2)', () => {
    const on = (id: string, saved?: unknown) => runStepScript(renderStepHtml(stateAt(id), FAKE_SKINS), saved);
    const lastBlob = (dom: ReturnType<typeof runStepScript>): Record<string, unknown> => dom.states[dom.states.length - 1] as Record<string, unknown>;

    const typed = on('st-2-file-parse');
    typed.elements.get('tutor-input')!.value = 'half a question';
    typed.elements.get('tutor-input')!.dispatch('input');

    const elsewhere = on('st-4-symbol-render', lastBlob(typed));
    assert.equal(elsewhere.elements.get('tutor-input')!.value, '', 'a draft never appears under another step');
    elsewhere.elements.get('btn-check')!.dispatch('click');
    assert.deepEqual({ ...(lastBlob(elsewhere)['drafts'] as object) }, { 'st-2-file-parse': 'half a question' }, 'the press took the blob over and carried the draft along');

    const back = on('st-2-file-parse', lastBlob(elsewhere));
    assert.equal(back.elements.get('tutor-input')!.value, 'half a question', 'the draft is back on its own step');
    back.elements.get('btn-check')!.dispatch('click');
    assert.equal(lastBlob(back)['drafts'], undefined, 'and it is held once, not twice');
    assert.equal(lastBlob(back)['draft'], 'half a question');
  });

  test('a step id that spells an Object.prototype member is just a key in the drafts (F2)', () => {
    const blob = { stepId: '__proto__', note: '', draft: 'half a question' };
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html, blob);
    dom.elements.get('btn-check')!.dispatch('click');
    const saved = dom.states[dom.states.length - 1] as { drafts?: Record<string, unknown> };
    assert.ok(saved.drafts !== undefined && Object.prototype.hasOwnProperty.call(saved.drafts, '__proto__'), 'kept as an own key');
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  });

  test('the page after the repaint scrolls that outcome into view, once', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', CHECK_PASS), FAKE_SKINS);
    const dom = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: 'check', revealAt: Date.now() });
    assert.deepEqual(dom.elements.get('outcome-check')!.scrolled, [{ block: 'nearest', behavior: 'auto' }]);
    const last = dom.states[dom.states.length - 1] as { reveal?: string };
    assert.equal(last.reveal, undefined, 'a reveal is one-shot: the next repaint must not jump again');
  });

  test('a reveal saved on another step, or naming no known outcome, scrolls nothing', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', CHECK_PASS), FAKE_SKINS);
    const other = runStepScript(html, { stepId: 'st-1-shape-src', note: '', draft: '', reveal: 'check', revealAt: Date.now() });
    assert.deepEqual(other.elements.get('outcome-check')!.scrolled, []);
    for (const bogus of ['__proto__', 'step-main', 'check"', '']) {
      const dom = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: bogus, revealAt: Date.now() });
      assert.deepEqual(dom.elements.get('outcome-check')!.scrolled, [], `reveal ${JSON.stringify(bogus)} must be ignored`);
    }
    // An id the page does have, named by a key outside the list: only the list stops it
    // (code review 8: without this case the loop above could not fail).
    const evilHtml = html.replace('<main id="step-main"', '<span id="outcome-evil"></span><main id="step-main"');
    const dom = runStepScript(evilHtml, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: 'evil', revealAt: Date.now() });
    assert.deepEqual(dom.elements.get('outcome-evil')!.scrolled, [], 'a key outside the fixed list never reaches getElementById');
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

  test('the empty note an ACCEPTED ask posts keeps the reveal pending for the repaint that follows', () => {
    // step-protocol.ts answers an accepted ask with step:note '' (clearing an old note) and
    // THEN the session repaints to "thinking". The reveal must survive that empty note.
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.elements.get('tutor-input')!.value = 'why?';
    dom.elements.get('btn-tutor-ask')!.dispatch('click');
    dom.send({ type: 'step:note', payload: { note: '' } });
    assert.equal((dom.states[dom.states.length - 1] as { reveal?: string }).reveal, 'tutor');
    assert.deepEqual(dom.elements.get('step-note')!.scrolled, [], 'an empty note is not an answer to bring into view');
  });

  test('a reveal older than its lifetime is ignored: a press the host never answered cannot jump the page later', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse', CHECK_PASS), FAKE_SKINS);
    const stale = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: 'check', revealAt: Date.now() - 60000 });
    assert.deepEqual(stale.elements.get('outcome-check')!.scrolled, []);
    const undated = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '', reveal: 'check' });
    assert.deepEqual(undated.elements.get('outcome-check')!.scrolled, [], 'no time, no reveal');
  });

  test('scrolling on another step does not erase the draft left on the previous one', async () => {
    const left = { stepId: 'st-1-shape-src', note: '', draft: 'half a question' };
    const onB = runStepScript(renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS), left);
    onB.scroll(300);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(onB.states[onB.states.length - 1], left, 'a page that does not own the blob keeps its scroll in memory');
    const backOnA = runStepScript(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS), onB.states[onB.states.length - 1]);
    assert.equal(backOnA.elements.get('tutor-input')!.value, 'half a question');
  });

  test('scrolling a step this page owns saves where the learner is', async () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html, { stepId: 'st-2-file-parse', note: '', draft: '' });
    dom.scroll(480);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(dom.states[dom.states.length - 1], { stepId: 'st-2-file-parse', note: '', draft: '', y: 480 });
  });

  test('a press inside the scroll debounce saves the live position, not a stale one', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.setScrollY(512);
    dom.elements.get('btn-check')!.dispatch('click');
    assert.equal((dom.states[dom.states.length - 1] as { y?: number }).y, 512);
  });

  test('the note is the page\'s live region, so a refusal written into it is announced', () => {
    const dom = runStepScript(renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS));
    assert.equal(dom.elements.get('step-note')!.getAttribute('role'), 'status');
  });

  test('with nothing to reveal and nowhere to return to, the saved state keeps its old shape', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const dom = runStepScript(html);
    dom.elements.get('tutor-input')!.value = 'draft';
    dom.elements.get('tutor-input')!.dispatch('input');
    assert.deepEqual(dom.states[dom.states.length - 1], { stepId: 'st-2-file-parse', note: '', draft: 'draft' });
  });
});

// ── F-07 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-07 — under System the webviews use the editor\'s own fonts', () => {
  test('the bridge defines --mono as the editor font and sets the workbench font on body', () => {
    const css = cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));
    assert.match(declarationsFor(css, ':root:not([data-theme])'), /--mono:var\(--vscode-editor-font-family/);
    assert.match(declarationsFor(css, ':root:not([data-theme]) body'), /font-family:var\(--vscode-font-family/);
  });

  test('code on the step page reads --mono first, keeping the old stack for a named skin', () => {
    const css = cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));
    for (const sel of ['.check-name', '.turn-text pre.tutor-code']) {
      assert.match(declarationsFor(css, sel), /font-family:var\(--mono,ui-monospace/, `${sel} should take the editor font`);
    }
  });
});

// ── F-11 ─────────────────────────────────────────────────────────────────────────────────────

suite('T-16 F-11 — the step panel says where in the plan you are', () => {
  test('every step names its place as "Step N of M", in plan order', () => {
    const plan = fixturePlan();
    plan.steps.forEach((s, i) => {
      const html = renderStepHtml(stateAt(s.id), FAKE_SKINS);
      assert.match(html, new RegExp(`<p class="step-count">Step ${i + 1} of ${plan.steps.length}</p>`), `step ${s.id}`);
    });
  });

  test('a step the plan does not list gets no count rather than a wrong one', () => {
    const state = stateAt('st-1-shape-src');
    const html = renderStepHtml({ ...state, step: { ...state.step, id: 'not-in-the-plan' } }, FAKE_SKINS);
    assert.ok(!html.includes('class="step-count"'));
  });

  test('the count is part of the repaint key, so a changed plan repaints', () => {
    const state = stateAt('st-2-file-parse');
    const shorter = { ...state, plan: { ...state.plan, steps: state.plan.steps.slice(0, 2) } };
    assert.notEqual(stepRenderKey(state, FAKE_SKINS), stepRenderKey(shorter, FAKE_SKINS));
  });
});

// ── auto-review (visual) ─────────────────────────────────────────────────────────────────────

suite('T-16 visual review — headings stay at full strength; the missing chip has one signal', () => {
  test('narrator headings and the stop counter are not in the faint tier', () => {
    const css = cssOf(renderNarratorHtml(narratorState(1), FAKE_SKINS));
    for (const sel of ['h2', '.stop-progress']) {
      assert.doesNotMatch(declarationsFor(css, sel), /color:var\(--muted\)/, `${sel} should keep the body colour`);
    }
    assert.match(declarationsFor(css, '.detour-aside'), /color:var\(--muted\)/, 'the aside stays in the faint tier');
  });

  test('under System the missing chip takes the neutral chip fill and keeps its ring', () => {
    const css = cssOf(renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS));
    assert.match(declarationsFor(css, ':root:not([data-theme]) .check-missing .check-status'), /background:var\(--chip\)/);
    assert.match(declarationsFor(css, '.check-missing .check-status'), /outline:1pxsolidvar\(--status-bad\)/);
  });
});

suite('T-16 security review N-1 — keyboard stops on wide code are bounded', () => {
  class Block extends El { scrollWidth = 800; clientWidth = 300; }
  test('only the newest 12 overflowing code blocks take a tab stop, however many a reply carries', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const blocks = Array.from({ length: 30 }, () => new Block());
    runStepScript(html, undefined, blocks);
    const focusable = blocks.map((b) => b.getAttribute('tabindex'));
    assert.equal(focusable.filter((t) => t === '0').length, 12);
    assert.deepEqual(focusable.slice(18), Array(12).fill('0'), 'the newest blocks are the reachable ones');
  });

  test('a block that fits gets no tab stop', () => {
    const html = renderStepHtml(stateAt('st-2-file-parse'), FAKE_SKINS);
    const fits = Object.assign(new El(), { scrollWidth: 200, clientWidth: 300 });
    runStepScript(html, undefined, [fits]);
    assert.equal(fits.getAttribute('tabindex'), null);
  });
});
