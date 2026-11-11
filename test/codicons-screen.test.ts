// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-40: VS Code's own icons, in the REAL panels (the `screen` host; see `test/support/screen.ts`).
 *
 * `test/unit/codicons.test.ts` pins the markup and the CSP string. It cannot see whether VS Code
 * actually serves the font, and that takes three things agreeing inside the real host: the panel's
 * `localResourceRoots`, the page's CSP (`style-src` and `font-src` naming `webview.cspSource`), and
 * the URI `asWebviewUri` produced. Get any one wrong and every icon is blank while every word is
 * still there, which no screenshot of the words would catch. So each test reads, from inside the
 * real page: the codicon `FontFace`'s status once a load is asked for (`loaded`, not `error`, and
 * not absent), what the stylesheet did to an icon (its font family, its glyph, its drawn width),
 * and the CSP the page is running under.
 *
 * And the point of F-13: a wait VISIBLY moves. The spinner beside "thinking…" must be running an
 * animation whose transform changes between two readings, and must stop when the editor is told
 * to reduce motion (`workbench.reduceMotion`, which VS Code passes to a webview as
 * `body.vscode-reduce-motion`).
 *
 * What is real: the panels, their pages, the webview host and its resource loader. What is not:
 * the model, which is the tutor stand-in (`_walk.useTutorCore`), so nothing here spends a token.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { LlmReply, TutorCore } from '../src/tutor/core.js';
import { detoursRoot } from '../src/detour/store.js';
import { Screen, sleep } from './support/screen.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const STEP_TITLE = 'Build Tutorials: Step';
const NARRATOR_TITLE = 'Build Tutorials: Detour';
const START_TITLE = 'Build Tutorials: Start';
const STEP = 'st-1-shape-src';
const REFERENCE_FILES = ['src/parse.ts', 'src/api/routes.ts', 'src/api/render.ts'];

/** The glyphs codicon.css gives the icons these panels draw, as `getComputedStyle(…, '::before').content` reports them. */
const GLYPH = {
  arrowLeft: `"${String.fromCodePoint(0xea9b)}"`,
  arrowRight: `"${String.fromCodePoint(0xea9c)}"`,
  loading: `"${String.fromCodePoint(0xeb19)}"`,
};

/** A canned example the stand-in answers with: three files and three stops (the parser's minimum). */
const CANNED_DETOUR = JSON.stringify({
  title: 'A vending machine',
  domain: 'vending machines',
  files: [
    { path: 'coins.ts', content: 'export const VALUES = [5, 10, 25];\n' },
    { path: 'tray.ts', content: 'export const EMPTY: string[] = [];\n' },
    { path: 'machine.ts', content: 'import { VALUES } from "./coins";\nexport const n = VALUES.length;\n' },
  ],
  stops: [
    { file: 'coins.ts', startLine: 1, endLine: 1, text: 'The coins are their own module.' },
    { file: 'tray.ts', startLine: 1, endLine: 1, text: 'The tray knows nothing about coins.' },
    { file: 'machine.ts', startLine: 2, endLine: 2, text: 'Only the machine joins them.' },
  ],
});

interface Icon { family: string; glyph: string; width: number }
interface FontReading {
  /** Every codicon FontFace on the page and its status, after `document.fonts.load` was asked. */
  faces: string[];
  href: string | null;
  csp: string | null;
  icons: Record<string, Icon | null>;
}

/** Reads the page's font, stylesheet and CSP, and what codicon.css did to each selector's icon. */
function FONTS(selectors: Record<string, string>): string {
  return `(async () => {
    try { await document.fonts.load('16px codicon'); } catch (e) { /* the status below says what happened */ }
    const faces = [];
    document.fonts.forEach((f) => { if (f.family.replace(/["']/g, '') === 'codicon') faces.push(f.status); });
    const link = document.querySelector('link[rel="stylesheet"]');
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const icon = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { family: getComputedStyle(el).fontFamily, glyph: getComputedStyle(el, '::before').content, width: Math.round(el.getBoundingClientRect().width) };
    };
    const icons = {};
    for (const [name, sel] of Object.entries(${JSON.stringify(selectors)})) icons[name] = icon(sel);
    return { faces, href: link ? link.href : null, csp: meta ? meta.getAttribute('content') : null, icons };
  })()`;
}

/** The font really arrived, through this page's own CSP, from the packaged folder. */
function assertFontServed(where: string, r: FontReading): void {
  assert.deepEqual(r.faces, ['loaded'], `${where}: the codicon font did not load (statuses ${JSON.stringify(r.faces)}): ${JSON.stringify(r)}`);
  assert.match(r.href ?? '', /\/node_modules\/(%40|@)vscode\/codicons\/dist\/codicon\.css$/, `${where}: the stylesheet is the packaged one`);
  assert.match(r.href ?? '', /^https:\/\//, `${where}: served by the webview's resource origin, not a file or a CDN path`);
  const csp = r.csp ?? '';
  const directive = (name: string): string[] =>
    (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);
  assert.deepEqual(directive('script-src').length, 1, `${where}: scripts are still the nonce and nothing else: ${csp}`);
  assert.match(directive('script-src')[0] ?? '', /^'nonce-[^']+'$/, `${where}: scripts are still the nonce and nothing else: ${csp}`);
  // VS Code's own cspSource (1.145: `'self' https://*.vscode-cdn.net`): fonts may come from exactly
  // the origins a stylesheet may, which is that and nothing else.
  const styleOrigins = directive('style-src').filter((s) => !s.startsWith("'nonce-"));
  assert.ok(styleOrigins.some((s) => s.startsWith('https://')), `${where}: styles may come from the webview's resource origin: ${csp}`);
  assert.deepEqual(directive('font-src'), styleOrigins, `${where}: fonts come from the webview's own origins and nowhere else: ${csp}`);
}

function assertIcon(where: string, icon: Icon | null, glyph: string): void {
  assert.ok(icon, `${where}: the icon is not on the page`);
  assert.match(icon.family, /codicon/, `${where}: codicon.css did not reach the icon: ${JSON.stringify(icon)}`);
  assert.equal(icon.glyph, glyph, `${where}: the wrong glyph, or none: ${JSON.stringify(icon)}`);
  assert.equal(icon.width, 16, `${where}: the glyph is not drawn at the font's own width: ${JSON.stringify(icon)}`);
}

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
  assert.ok(ext);
  return ext.activate();
}

/** A tutorial the tutor can be asked about and a detour taken from: the fixture beside a reference. */
function tutorial(dirs: string[]): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 't40-target-'));
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), 't40-reference-'));
  dirs.push(target, reference);
  writeFixtureTarget(target);
  for (const rel of REFERENCE_FILES) {
    const to = path.join(reference, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(target, rel), to);
  }
  fs.writeFileSync(
    path.join(target, '.repo-tour', 'build', 'request.json'),
    `${JSON.stringify({ idea: '', recreate: true, repo: reference, referenceRoot: reference, target, dial: 'manual' }, null, 2)}\n`,
  );
  return target;
}

suite('T-40: VS Code\'s own icons, in the real panels', function () {
  this.timeout(180_000);

  async function inAWalk(body: (ctx: { api: ExtensionApi; screen: Screen; reply: (how: () => Promise<LlmReply>) => void }) => Promise<void>): Promise<void> {
    const api = await getApi();
    const screen = await Screen.open(api._context);
    const dirs: string[] = [];
    try {
      await api._walk.openAt(tutorial(dirs));
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      const session = api._walk.session();
      assert.ok(session, 'opening the walk should leave a session behind');
      await session.settled();
      session.goTo(STEP);
      await session.settled();
      const core: TutorCore | undefined = await api._walk.tutorCore();
      assert.ok(core, 'repo-tour should load, or there is no tutor to stand in for');
      let answer: () => Promise<LlmReply> = () => Promise.reject(new Error('T-40: a test forgot to say what the model does'));
      api._walk.useTutorCore({
        ...core,
        availability: () => Promise.resolve({ ok: true, detail: 'a stubbed provider probe' }),
        runLlm: () => answer(),
      });
      await body({ api, screen, reply: (how) => { answer = how; } });
    } finally {
      api._walk.useTutorCore(undefined);
      api._walk.session()?.dispose();
      screen.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
      try { fs.rmSync(detoursRoot(api._context.globalStorageUri.fsPath), { recursive: true, force: true }); } catch { /* none taken */ }
    }
  }

  test('the step panel: the font arrives through its own root and CSP, and Previous and Next draw the arrows', () => inAWalk(async ({ screen }) => {
    const read = screen.reader<FontReading>(STEP_TITLE, FONTS({ prev: '#btn-prev .codicon', next: '#btn-next .codicon' }));
    const deadline = Date.now() + 20_000;
    let r = await read();
    while ((!r.icons['prev'] || r.faces[0] !== 'loaded') && Date.now() < deadline) { await sleep(200); r = await read(); }
    assertFontServed('step panel', r);
    assertIcon('Previous', r.icons['prev'] ?? null, GLYPH.arrowLeft);
    assertIcon('Next', r.icons['next'] ?? null, GLYPH.arrowRight);
  }));

  test('a wait moves: the spinner beside "thinking…" turns, and stops when the editor is told to reduce motion', () => inAWalk(async ({ screen, reply }) => {
    reply(() => new Promise<LlmReply>(() => undefined)); // the tutor never answers: the wait lasts
    const page = (expression: string): Promise<unknown> => screen.reader<unknown>(STEP_TITLE, expression)();
    await page(`(() => { document.getElementById('tutor-input').value = 'why this?'; document.getElementById('btn-tutor-ask').click(); })()`);

    const SPIN = `(async () => {
      const el = document.querySelector('#tutor-thinking .codicon-loading.codicon-modifier-spin');
      if (!el) return null;
      const first = getComputedStyle(el).transform;
      await new Promise((r) => setTimeout(r, 300));
      const second = getComputedStyle(el).transform;
      return {
        glyph: getComputedStyle(el, '::before').content,
        reduce: document.body.classList.contains('vscode-reduce-motion'),
        animations: el.getAnimations().map((a) => a.animationName + ':' + a.playState),
        first, second,
      };
    })()`;
    type Spin = { glyph: string; reduce: boolean; animations: string[]; first: string; second: string } | null;
    const spin = (): Promise<Spin> => screen.reader<Spin>(STEP_TITLE, SPIN)();

    let moving = await spin();
    const deadline = Date.now() + 30_000;
    while ((moving === null || moving.glyph !== GLYPH.loading) && Date.now() < deadline) { await sleep(200); moving = await spin(); }
    assert.ok(moving, 'the waiting line has no spinner');
    assert.equal(moving.glyph, GLYPH.loading, `the spinner's glyph did not arrive: ${JSON.stringify(moving)}`);
    assert.equal(moving.reduce, false, 'this host starts with motion allowed');
    assert.deepEqual(moving.animations, ['codicon-spin:running'], `the spinner is not turning: ${JSON.stringify(moving)}`);
    assert.notEqual(moving.second, moving.first, `two readings 300 ms apart drew the same angle: ${JSON.stringify(moving)}`);

    const workbench = vscode.workspace.getConfiguration('workbench');
    const was = workbench.inspect<string>('reduceMotion')?.globalValue;
    try {
      await workbench.update('reduceMotion', 'on', vscode.ConfigurationTarget.Global);
      let still = await spin();
      const stopBy = Date.now() + 20_000;
      while ((still === null || !still.reduce) && Date.now() < stopBy) { await sleep(200); still = await spin(); }
      assert.ok(still?.reduce, `VS Code never told the page to reduce motion: ${JSON.stringify(still)}`);
      assert.deepEqual(still.animations, [], `the spinner still turns under reduced motion: ${JSON.stringify(still)}`);
      assert.equal(still.second, still.first, `the spinner still moves under reduced motion: ${JSON.stringify(still)}`);
      assert.equal(still.glyph, GLYPH.loading, 'the icon itself stays, beside its words');
    } finally {
      await workbench.update('reduceMotion', was, vscode.ConfigurationTarget.Global);
    }
  }));

  test('the narrator: the font arrives, and its Previous and Next draw the arrows', () => inAWalk(async ({ api, screen, reply }) => {
    reply(() => Promise.resolve({ text: CANNED_DETOUR, inputTokens: 0, outputTokens: 0, usd: 0, metered: false }));
    const panel = api._walk.panel();
    assert.ok(panel, 'the step view provider is registered');
    panel.dispatchForTest({ type: 'detour:start' });
    const read = screen.reader<FontReading>(NARRATOR_TITLE, FONTS({ prev: '#btn-detour-prev .codicon', next: '#btn-detour-next .codicon' }));
    let r = await read();
    const deadline = Date.now() + 20_000;
    while ((!r.icons['next'] || r.faces[0] !== 'loaded') && Date.now() < deadline) { await sleep(200); r = await read(); }
    assertFontServed('narrator', r);
    assertIcon('the narrator\'s Previous', r.icons['prev'] ?? null, GLYPH.arrowLeft);
    assertIcon('the narrator\'s Next', r.icons['next'] ?? null, GLYPH.arrowRight);
    api._walk.session()?.returnFromDetour();
  }));

  test('the Start form: the font arrives through its own root and CSP (it draws no icon, and it can)', async () => {
    const api = await getApi();
    const screen = await Screen.open(api._context);
    try {
      await vscode.commands.executeCommand('buildTutorials.start');
      const read = screen.reader<FontReading>(START_TITLE, FONTS({}));
      let r = await read();
      const deadline = Date.now() + 20_000;
      while (r.faces[0] !== 'loaded' && Date.now() < deadline) { await sleep(200); r = await read(); }
      assertFontServed('Start form', r);
    } finally {
      screen.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
