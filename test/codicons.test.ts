// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-40, in the extension host: what each panel GRANTS its webview, and the page it hands it.
 *
 * `test/codicons-screen.test.ts` proves the font really arrives. It cannot prove that nothing ELSE
 * can: a panel whose `localResourceRoots` were the whole install plus every workspace folder (VS
 * Code's default when the option is left unset, which is what the Start form did before T-40) would
 * load the font just as well. So this reads each panel's real webview options and markup: exactly
 * one root, the packaged codicons' `dist/`; a page whose own icon sheet names that folder's font
 * through `asWebviewUri`; and a CSP that adds `font-src` (the webview's own `cspSource`) and nothing
 * else: no linked stylesheet, so styles stay the nonce alone (T-40's review, F3).
 *
 * All three panels, the narrator included (the review's F5): it is the one that draws
 * model-authored text, so its root is pinned here rather than only shown to load the font.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot } from '../src/core.js';
import { detoursRoot } from '../src/detour/store.js';
import type { ExtensionApi } from '../src/extension.js';
import { StartPanel, type StartPanelDeps } from '../src/start/panel.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';
const REFERENCE_FILES = ['src/parse.ts', 'src/api/routes.ts', 'src/api/render.ts'];

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

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return ext.activate();
}

async function until(what: string, ok: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The one folder every panel may read, composed here from the extension's own path rather than
 *  imported, so a wrong constant in src/ cannot agree with itself. */
function expectedRoot(context: vscode.ExtensionContext): string {
  return path.join(context.extensionUri.fsPath, 'node_modules', '@vscode', 'codicons', 'dist');
}

function assertGrantsOnlyTheFont(where: string, webview: vscode.Webview, context: vscode.ExtensionContext): void {
  const roots = (webview.options.localResourceRoots ?? null)?.map((u) => u.fsPath);
  assert.deepEqual(roots, [expectedRoot(context)], `${where}: exactly one root, the packaged codicons' dist/`);
  assert.ok(fs.existsSync(path.join(roots[0]!, 'codicon.ttf')), `${where}: and that folder holds the font`);

  const html = webview.html;
  const font = webview.asWebviewUri(vscode.Uri.file(path.join(expectedRoot(context), 'codicon.ttf'))).toString();
  assert.ok(html.includes(`src:url("${font}") format("truetype")`), `${where}: the page's own sheet names the packaged font through asWebviewUri (${font})`);
  assert.ok(!/<link\b[^>]*rel="stylesheet"/i.test(html), `${where}: no stylesheet is linked, so the page's script never waits for one`);

  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
  const directives = csp.split(';').map((d) => d.trim());
  assert.ok(directives.includes(`font-src ${webview.cspSource}`), `${where}: fonts from the webview's own origin: ${csp}`);
  assert.match(/style-src ([^;]+)/.exec(csp)?.[1] ?? '', /^'nonce-[^']+'$/, `${where}: styles stay the nonce alone: ${csp}`);
  assert.match(/script-src ([^;]+)/.exec(csp)?.[1] ?? '', /^'nonce-[^']+'$/, `${where}: scripts stay the nonce alone: ${csp}`);
}

suite('T-40: each panel grants its webview the icon font and nothing else', function () {
  this.timeout(60_000);

  test('the Current Step view', async () => {
    const api = await getApi();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 't40-host-target-'));
    try {
      writeFixtureTarget(target);
      await api._walk.openAt(target);
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      const panel = api._walk.panel();
      assert.ok(panel, 'the step view provider is registered');
      await until('the step view to draw a step', () => panel.webview?.html.includes('id="step-main"') === true);
      assert.ok(panel.webview, 'the step view resolved in this host');
      assertGrantsOnlyTheFont('step view', panel.webview, api._context);
    } finally {
      api._walk.session()?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('the detour narrator, the panel that draws what a model wrote', async () => {
    const api = await getApi();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 't40-host-target-'));
    const reference = fs.mkdtempSync(path.join(os.tmpdir(), 't40-host-reference-'));
    try {
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
      await api._walk.openAt(target);
      const session = api._walk.session();
      const panel = api._walk.panel();
      assert.ok(session && panel, 'the walk opened');
      await session.settled();
      const core = await api._walk.tutorCore();
      assert.ok(core, 'repo-tour should load, or there is no model to stand in for');
      api._walk.useTutorCore({
        ...core,
        availability: () => Promise.resolve({ ok: true, detail: 'a stubbed provider probe' }),
        runLlm: () => Promise.resolve({ text: CANNED_DETOUR, inputTokens: 0, outputTokens: 0, usd: 0, metered: false }),
      });
      panel.dispatchForTest({ type: 'detour:start' });
      await until('the narrator to open', () => api._walk.narrator()?.webview?.html.includes('id="detour-main"') === true);
      const narrator = api._walk.narrator()?.webview;
      assert.ok(narrator, 'the narrator is open');
      assertGrantsOnlyTheFont('narrator', narrator, api._context);
      api._walk.session()?.returnFromDetour();
    } finally {
      api._walk.useTutorCore(undefined);
      api._walk.session()?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(reference, { recursive: true, force: true });
      try { fs.rmSync(detoursRoot(api._context.globalStorageUri.fsPath), { recursive: true, force: true }); } catch { /* none taken */ }
    }
  });

  test('the Start form, which left its roots to VS Code\'s default (the whole install and every workspace folder) before T-40', async () => {
    const api = await getApi();
    const core = await loadCore(resolveCoreRoot('../repo-tour', api._context.extensionUri.fsPath));
    assert.equal(core.found, true, core.reason ?? 'the sibling repo-tour checkout should be found');
    const panel = StartPanel.show(api._context, { skins: core.loaded['skins'] as StartPanelDeps['skins'], onSubmit: () => undefined });
    try {
      assertGrantsOnlyTheFont('Start form', panel.webview, api._context);
    } finally {
      panel.dispose();
    }
  });
});
