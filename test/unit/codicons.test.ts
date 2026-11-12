// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-40: VS Code's own icons in the three webviews, and waits that visibly move (T-16's audit,
 * findings F-13 and F-14).
 *
 * What is pinned here, all of it pure (no `vscode`, no browser):
 *
 *   - `renderPage` inlines the icon sheet (naming the packaged `codicon.ttf`) only when the panel
 *     hands it the font's URI and its webview's `cspSource`, and then adds exactly one source list
 *     to the CSP: `font-src`, that origin. Styles stay the nonce alone; scripts are never touched.
 *   - The icons sit where VS Code would draw one: the spinner beside each wait, VS Code's pass and
 *     error marks on the check's verdict, the arrows on Previous and Next.
 *   - Every icon is decoration: hidden from a screen reader and carrying no text, so every word a
 *     test, a screen reader or a person reads is unchanged.
 *   - Every icon name drawn, and its code point, is the font's own (the shipped `codicon.css` says).
 *   - A spin stops under `body.vscode-reduce-motion` and `prefers-reduced-motion`, with a selector
 *     that outranks the spin rule.
 *
 * What is NOT pinned here, because no unit test can see it: that VS Code really loads the font
 * through the webview's resource root and CSP, and that the spinner really turns there. That is
 * `test/codicons-screen.test.ts`, in the real host.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderPage, type PageAssets } from '../../src/webview/page.js';
import { CODICON_GLYPHS } from '../../src/webview/codicons.js';
import { cssOf, declarationsFor } from './css-rules.js';
import {
  DETOUR_WAITING_MESSAGE, PREPARING_MESSAGE, THINKING_MESSAGE, renderNoticeHtml, renderStepHtml,
} from '../../src/walk/step-view.js';
import { NEXT_LABEL, PREV_LABEL, renderNarratorHtml, type NarratorViewState } from '../../src/detour/narrator.js';
import { renderStartHtml, type SkinsModule } from '../../src/start/view.js';
import { emptyRequest } from '../../src/start/request.js';
import { stepDial } from '../../src/walk/model.js';
import type { StepViewState } from '../../src/walk/step-protocol.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

/** What a real panel hands over: VS Code's own `cspSource` shape, and an `asWebviewUri` result. */
const ASSETS: PageAssets = {
  cspSource: "'self' https://*.vscode-cdn.net",
  codiconFont: 'https://file%2B.vscode-resource.vscode-cdn.net/ext/node_modules/%40vscode/codicons/dist/codicon.ttf',
};

/** The `@font-face` the page's own sheet declares, and the URL it names. */
function fontFaceOf(html: string): string | null {
  return /@font-face\{font-family:"codicon";font-display:block;src:url\("([^"]*)"\) format\("truetype"\);?\}/.exec(cssOf(html))?.[1] ?? null;
}

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

const QUESTION = { role: 'user' as const, content: 'Why an array?' };
const PASS_REPORT = { symbols: [{ name: 'tokenize', kind: 'function', status: 'present' }], imports: [], parseErrors: 0, ok: true };
const FAIL_REPORT = { symbols: [{ name: 'Token', kind: 'interface', status: 'missing' }], imports: [], parseErrors: 0, ok: false };

/** Every page these tests render with the assets handed over: one per state an icon belongs to. */
function pagesWithAssets(): Array<[string, string]> {
  return [
    ['step idle', renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS, ASSETS)],
    ['step preparing', renderStepHtml(stateAt('st-1-shape-src', { transcript: [QUESTION], tutor: { thinking: true, stage: 'preparing' } }), FAKE_SKINS, ASSETS)],
    ['step thinking', renderStepHtml(stateAt('st-1-shape-src', { transcript: [QUESTION], tutor: { thinking: true, stage: 'sending' } }), FAKE_SKINS, ASSETS)],
    ['step writing', renderStepHtml(stateAt('st-1-shape-src', { detour: { generating: true } }), FAKE_SKINS, ASSETS)],
    ['step check pass', renderStepHtml(stateAt('st-2-file-parse', { check: { summary: 'every part is there', report: PASS_REPORT } } as Partial<StepViewState>), FAKE_SKINS, ASSETS)],
    ['step check fail', renderStepHtml(stateAt('st-2-file-parse', { check: { summary: '1 export missing: Token', report: FAIL_REPORT } } as Partial<StepViewState>), FAKE_SKINS, ASSETS)],
    ['notice', renderNoticeHtml('No tutorial in this folder yet.', ASSETS)],
    ['start', renderStartHtml({ request: emptyRequest(), problems: {}, skin: 'system', building: false, refusedInARow: 0 }, FAKE_SKINS, ASSETS)],
    ['narrator', renderNarratorHtml(narratorState(1), FAKE_SKINS, ASSETS)],
  ];
}

/** The page's CSP, as a map from directive name to its value. */
function cspOf(html: string): Map<string, string> {
  const found = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(found, 'the page should carry a CSP meta tag');
  const out = new Map<string, string>();
  for (const part of found[1]!.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...value] = part.split(/\s+/);
    assert.ok(!out.has(name!), `the CSP names ${name} twice`);
    out.set(name!, value.join(' '));
  }
  return out;
}

function nonceOf(html: string): string {
  const n = /<style nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(n, 'the page should have a nonce');
  return n;
}

/* `cssOf` and `declarationsFor` come from `./css-rules.ts`, which keeps a selector's descendant spaces (the
   squeezing helpers this file first had erased them, so a selector typo passed: T-52's review, F1). */

/**
 * A selector's specificity as one comparable number (ids × 10 000 + classes, attributes and
 * pseudo-classes × 100 + types and pseudo-elements). Enough for the simple compound selectors this
 * file compares; not a general CSS parser.
 */
function specificity(selector: string): number {
  const s = selector.replace(/\[[^\]]*\]/g, () => ' .attr ');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/(^|[^:]):(?!:)[\w-]+/g) ?? []).length;
  const types = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
  return ids * 10_000 + classes * 100 + types;
}

/** The inner HTML of the `<tag>` with this id, its own nested `<tag>`s balanced (an icon is a span
 *  inside a span). */
function innerOf(html: string, id: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*\\sid="${id}"[^>]*>`).exec(html);
  assert.ok(open, `the page should have a <${tag}> #${id}`);
  const start = open.index + open[0].length;
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 1;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return assert.fail(`#${id} is never closed`);
}

function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

const ICON = /<span class="codicon codicon-([a-z0-9-]+)(?: codicon-modifier-([a-z]+))? icon-(?:lead|trail)" aria-hidden="true"><\/span>/g;

/** The packaged stylesheet, read from where the extension loads it in development. */
function shippedCodiconCss(): string {
  const candidates = [
    path.resolve(__dirname, '../../../node_modules/@vscode/codicons/dist/codicon.css'),
    path.resolve(__dirname, '../../node_modules/@vscode/codicons/dist/codicon.css'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  assert.ok(file, '@vscode/codicons should be installed: it is a dependency, and the .vsix ships its dist/');
  return fs.readFileSync(file, 'utf8');
}

function manifest(): { contributes: { commands: Array<{ command: string; icon?: string }> } } {
  const candidates = [path.resolve(__dirname, '../../../package.json'), path.resolve(__dirname, '../../package.json')];
  const file = candidates.find((p) => fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).name === 'build-tutorials');
  assert.ok(file, 'the extension manifest should be found above the test build');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

suite('T-40: renderPage carries VS Code\'s icon font, and nothing else', () => {
  const base = { title: 't', coreCss: '.a{}', bridgeCss: '.b{}', skin: 'system', body: '<p>hi</p>', script: '1;' };

  test('with the assets, the CSP gains font-src, the webview\'s own origin, and nothing else: NO new script or style source', () => {
    const html = renderPage({ ...base, assets: ASSETS });
    const csp = cspOf(html);
    const n = nonceOf(html);
    assert.deepEqual([...csp.keys()].sort(), ['default-src', 'font-src', 'script-src', 'style-src'], `directives: ${[...csp.keys()].join(', ')}`);
    assert.equal(csp.get('default-src'), "'none'");
    assert.equal(csp.get('style-src'), `'nonce-${n}'`, 'styles: the nonce alone, exactly as before (the icon sheet is inlined under it)');
    assert.equal(csp.get('font-src'), ASSETS.cspSource, 'fonts: the webview\'s own origin and nothing else');
    assert.equal(csp.get('script-src'), `'nonce-${n}'`, 'scripts: the nonce alone, exactly as before');
  });

  test('without the assets, the CSP is exactly what it was: no font source, no outside stylesheet', () => {
    const html = renderPage(base);
    const csp = cspOf(html);
    const n = nonceOf(html);
    assert.deepEqual([...csp.keys()].sort(), ['default-src', 'script-src', 'style-src']);
    assert.equal(csp.get('style-src'), `'nonce-${n}'`);
    assert.equal(csp.get('script-src'), `'nonce-${n}'`);
    assert.ok(!html.includes('<link'), 'nothing is linked');
  });

  test('the icon sheet is the page\'s own, under its nonce, ahead of every other sheet, and names the font the panel handed over', () => {
    const html = renderPage({ ...base, assets: ASSETS });
    assert.equal(fontFaceOf(html), ASSETS.codiconFont, 'the @font-face names exactly the URI the panel handed over');
    const sheets = [...html.matchAll(/<style nonce="([^"]+)">([\s\S]*?)<\/style>/g)];
    assert.ok(sheets[0]?.[2]?.includes('@font-face'), 'the icon sheet comes first, so a page\'s own rules can override it');
    assert.equal(sheets.filter((m) => m[2]!.includes('@font-face')).length, 1, 'declared once');
    for (const m of sheets) assert.equal(m[1], nonceOf(html), 'every sheet carries the page\'s nonce');
  });

  test('a cspSource that would widen the policy is refused, and the page renders without the icons', () => {
    for (const cspSource of ["https://x; script-src 'unsafe-inline'", 'https://x"><script>alert(1)</script>', 'https://x\nscript-src *', 'https://x, *', '']) {
      const html = renderPage({ ...base, assets: { ...ASSETS, cspSource } });
      const csp = cspOf(html);
      const n = nonceOf(html);
      assert.deepEqual([...csp.keys()].sort(), ['default-src', 'script-src', 'style-src'], `${JSON.stringify(cspSource)}: ${[...csp.keys()].join(', ')}`);
      assert.equal(csp.get('script-src'), `'nonce-${n}'`, JSON.stringify(cspSource));
      assert.equal(fontFaceOf(html), null, `${JSON.stringify(cspSource)}: no font is named under a policy that could not name its origin`);
      assert.ok(!html.includes('alert(1)'), JSON.stringify(cspSource));
    }
  });

  test('a font URI that could break out of its url(), its string or the <style> element is refused, and the page renders without the icons', () => {
    for (const codiconFont of ['https://x/a.ttf") format("x"); } body { display:none } /*', "https://x/a'b.ttf", 'https://x/a\\b.ttf',
      'https://x/a.ttf</style><script>alert(1)</script>', 'https://x/a (1).ttf', 'https://x/a.ttf\n}', '']) {
      const html = renderPage({ ...base, assets: { ...ASSETS, codiconFont } });
      assert.equal(fontFaceOf(html), null, JSON.stringify(codiconFont));
      assert.ok(!cspOf(html).has('font-src'), `${JSON.stringify(codiconFont)}: and the policy is the one with no font in it`);
      assert.ok(!html.includes('alert(1)') && !html.includes('display:none'), JSON.stringify(codiconFont));
    }
  });

  test('a spinning icon stops under body.vscode-reduce-motion and under prefers-reduced-motion, outranking the spin rule', () => {
    const css = cssOf(renderPage({ ...base, assets: ASSETS }));
    const spin = /([^{}]*\.codicon-modifier-spin[^{}]*)\{[^{}]*animation:codicon-spin/.exec(css);
    assert.ok(spin, 'the page\'s icon sheet should animate .codicon-modifier-spin');
    const strongest = Math.max(...spin[1]!.split(',').map(specificity));

    const editor = [...css.matchAll(/([^{}@]+)\{animation:none;?\}/g)].map((m) => m[1]!).flatMap((s) => s.split(','))
      .filter((s) => s.startsWith('body.vscode-reduce-motion') && s.includes('.codicon-modifier-spin'));
    for (const s of editor) assert.ok(s.startsWith('body.vscode-reduce-motion '), `${s}: the class is on the body and the icon is inside it (a descendant)`);
    assert.ok(editor.length > 0, 'a rule stops the spin when the editor asks for reduced motion');
    for (const s of editor) assert.ok(specificity(s) > strongest, `${s} must outrank the spin rule`);

    const media = /@media \(prefers-reduced-motion: reduce\)\{([^{}]+)\{animation:none;?\}\}/.exec(css);
    assert.ok(media, 'a rule stops the spin when the operating system asks for reduced motion');
    for (const s of media[1]!.split(',')) {
      assert.ok(s.includes('.codicon-modifier-spin'), s);
      assert.ok(specificity(s) > strongest, `${s} must outrank the spin rule`);
    }
  });

  test('without the assets, no icon rules are inlined either', () => {
    assert.ok(!cssOf(renderPage(base)).includes('codicon'), 'a page with no icon font carries no rules for one');
  });
});

suite('T-40: every panel\'s renderer hands the assets on', () => {
  test('the step page, the notice, the Start form and the narrator each carry the icon sheet and allow its font', () => {
    for (const [name, html] of pagesWithAssets()) {
      assert.equal(fontFaceOf(html), ASSETS.codiconFont, `${name}: the icon sheet names the packaged font`);
      assert.equal(cspOf(html).get('font-src'), ASSETS.cspSource, `${name}: the font is allowed`);
    }
  });

  test('without the assets each renderer draws the same page as before: no icon sheet, no font source', () => {
    const pages = [
      renderStepHtml(stateAt('st-1-shape-src'), FAKE_SKINS),
      renderNoticeHtml('No tutorial in this folder yet.'),
      renderStartHtml({ request: emptyRequest(), problems: {}, skin: 'system', building: false, refusedInARow: 0 }, FAKE_SKINS),
      renderNarratorHtml(narratorState(1), FAKE_SKINS),
    ];
    for (const html of pages) {
      assert.ok(!html.includes('<link'));
      assert.ok(!html.includes('@font-face'));
      assert.ok(!cspOf(html).has('font-src'));
    }
  });
});

suite('T-40: the icons, where VS Code would draw one', () => {
  const pages = new Map(pagesWithAssets());
  const page = (name: string): string => {
    const html = pages.get(name);
    assert.ok(html, name);
    return html;
  };

  test('both halves of a wait for the tutor show the spinning loading icon, and the words are unchanged', () => {
    for (const [name, words] of [['step preparing', PREPARING_MESSAGE], ['step thinking', THINKING_MESSAGE]] as const) {
      const inner = innerOf(page(name), 'tutor-thinking', 'span');
      assert.ok(inner.includes('<span class="codicon codicon-loading codicon-modifier-spin icon-lead" aria-hidden="true"></span>'), `${name}: ${inner}`);
      assert.equal(textOf(inner), words, `${name}: the icon adds no words`);
    }
  });

  test('writing an example shows the same spinner beside its words', () => {
    const inner = innerOf(page('step writing'), 'detour-waiting', 'span');
    assert.ok(inner.includes('<span class="codicon codicon-loading codicon-modifier-spin icon-lead" aria-hidden="true"></span>'), inner);
    assert.equal(textOf(inner), DETOUR_WAITING_MESSAGE);
  });

  test('nothing spins when nothing is being waited for', () => {
    // The drawn markup only: every page with the font also carries the rule that STOPS a spin.
    const drawn = (html: string): string => {
      const body = html.indexOf('<body>');
      return html.slice(body, html.indexOf('<script', body));
    };
    for (const name of ['step idle', 'step check pass', 'step check fail', 'notice', 'start', 'narrator']) {
      assert.ok(!drawn(page(name)).includes('codicon-modifier-spin'), `${name} has a spinner and nothing to wait for`);
      assert.ok(!drawn(page(name)).includes('codicon-loading'), name);
    }
    assert.ok(drawn(page('step thinking')).includes('codicon-modifier-spin'), 'and the check can see a spinner where there is one');
  });

  test('a passing check is marked with VS Code\'s pass icon and a failing one with its error icon, in the status colours', () => {
    const summary = (html: string): string => /<p class="check-summary [^"]*">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    const pass = summary(page('step check pass'));
    const fail = summary(page('step check fail'));
    assert.ok(pass.startsWith('<span class="codicon codicon-pass icon-lead" aria-hidden="true"></span>'), pass);
    assert.ok(fail.startsWith('<span class="codicon codicon-error icon-lead" aria-hidden="true"></span>'), fail);
    assert.ok(!pass.includes('codicon-error') && !fail.includes('codicon-pass'), 'one mark each');
    assert.equal(textOf(pass), 'every part is there', 'the verdict\'s words are unchanged');

    const css = cssOf(page('step check pass'));
    assert.match(declarationsFor(css, '.check-summary.check-pass .codicon'), /color:var\(--status-ok\)/);
    assert.match(declarationsFor(css, '.check-summary.check-fail .codicon'), /color:var\(--status-bad\)/);
  });

  test('Previous carries the left arrow before its word and Next the right arrow after it: the arrows its view title already uses', () => {
    const commands = manifest().contributes.commands;
    assert.equal(commands.find((c) => c.command === 'buildTutorials.prevStep')?.icon, '$(arrow-left)');
    assert.equal(commands.find((c) => c.command === 'buildTutorials.nextStep')?.icon, '$(arrow-right)');

    const step = page('step idle');
    assert.equal(innerOf(step, 'btn-prev', 'button'), '<span class="codicon codicon-arrow-left icon-lead" aria-hidden="true"></span>Previous');
    assert.equal(innerOf(step, 'btn-next', 'button'), 'Next<span class="codicon codicon-arrow-right icon-trail" aria-hidden="true"></span>');

    const narrator = page('narrator');
    assert.equal(innerOf(narrator, 'btn-detour-prev', 'button'), `<span class="codicon codicon-arrow-left icon-lead" aria-hidden="true"></span>${PREV_LABEL}`);
    assert.equal(innerOf(narrator, 'btn-detour-next', 'button'), `${NEXT_LABEL}<span class="codicon codicon-arrow-right icon-trail" aria-hidden="true"></span>`);
  });

  test('every icon is decoration: empty, and hidden from a screen reader', () => {
    for (const [name, html] of pagesWithAssets()) {
      const all = [...html.matchAll(/<span class="codicon[^"]*"[^>]*>[\s\S]*?<\/span>/g)].map((m) => m[0]);
      const decorative = [...html.matchAll(ICON)].length;
      assert.equal(decorative, all.length, `${name}: every icon is an empty, aria-hidden span: ${JSON.stringify(all)}`);
    }
  });

  test('every icon the pages draw is the shipped font\'s own glyph: its name, and the code point the page inlines for it', () => {
    const shipped = shippedCodiconCss();
    const drawn = new Set<string>();
    for (const [, html] of pagesWithAssets()) for (const m of html.matchAll(ICON)) drawn.add(m[1]!);
    assert.deepEqual([...drawn].sort(), ['arrow-left', 'arrow-right', 'error', 'loading', 'pass']);
    const page = cssOf(pagesWithAssets()[0]![1]);
    for (const name of drawn) {
      const own = new RegExp(`\\.codicon-${name}:before\\s*\\{\\s*content:\\s*"\\\\([0-9a-f]+)"`).exec(shipped)?.[1];
      assert.ok(own, `codicon.css has no glyph for ${name}`);
      assert.equal(CODICON_GLYPHS[name as keyof typeof CODICON_GLYPHS], own, `${name}: the code point this extension inlines is not the font's`);
      assert.ok(page.includes(`.codicon-${name}:before{content:"\\${own}";}`), `${name}: the page's sheet draws it with that code point`);
    }
  });

  test('the spinner turns as VS Code turns its own loading icon: the shipped stylesheet\'s duration and easing', () => {
    // The page inlines the spin rather than linking codicon.css (the review's F3). This keeps the copy
    // honest: a codicons update that changes how the loading icon turns fails HERE.
    const shipped = shippedCodiconCss().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
    const timing = /\.codicon-loading\{animation-duration:([^!;]+)!important;animation-timing-function:([^!;]+)!important;?\}/.exec(shipped);
    assert.ok(timing, 'codicon.css should time its loading icon');
    const page = cssOf(pagesWithAssets()[1]![1]);
    assert.ok(page.includes(`.codicon-loading.codicon-modifier-spin{animation:codicon-spin ${timing[1]} ${timing[2]} infinite;}`),
      `the page's spin should be ${timing[1]} ${timing[2]}, as VS Code's`);
  });
});

/**
 * The blind review's F2 and F3 (`.autodev/reviews/T-40-review.md`), which the real host's full `screen` label found
 * and nothing above did:
 *
 *   - F3: a stylesheet linked in `<head>` holds the page's one script until it has been fetched, so for that long
 *     every button is on the page with no listener, and a press on a freshly drawn page is lost. The pages must fetch
 *     nothing they wait for: the font alone, which holds neither the script nor the words.
 *   - F2: an icon's box was as wide as its glyph, so before the font arrived it was narrower, and its arrival
 *     re-wrapped rows after a press's outcome had been scrolled into view. The box must be a fixed 16 px, in the
 *     page's own sheet, so the layout the reveal measures is the layout the font leaves.
 */
suite('T-40 review: nothing on the page waits for the icon font, and nothing moves when it arrives', () => {
  test('F3: no page links a stylesheet, so its script never waits for a fetch', () => {
    for (const [name, html] of pagesWithAssets()) {
      assert.ok(!/<link\b[^>]*rel="stylesheet"/i.test(html),
        `${name}: a linked stylesheet holds the page's script until it arrives, and a press on a fresh page does nothing until then`);
    }
  });

  test('F3: styles come from the nonce alone; only the font comes from the webview\'s own origin', () => {
    for (const [name, html] of pagesWithAssets()) {
      const csp = cspOf(html);
      assert.equal(csp.get('style-src'), `'nonce-${nonceOf(html)}'`, `${name}: no outside stylesheet is needed, so none is allowed`);
      assert.equal(csp.get('font-src'), ASSETS.cspSource, `${name}: the font, from the webview's own origin`);
    }
  });

  test('F2: every icon is a 16 px inline block in the page\'s own sheet, whatever the font is doing', () => {
    for (const [name, html] of pagesWithAssets()) {
      const decl = declarationsFor(cssOf(html), ".codicon[class*='codicon-']");
      assert.match(decl, /display:inline-block/, `${name}: an inline span ignores its width until something makes it a block`);
      assert.match(decl, /width:16px/, `${name}: the box must not wait for the glyph to know its width`);
    }
  });
});
