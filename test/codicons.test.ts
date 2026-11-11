// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-40, in the extension host: what each panel GRANTS its webview, and the page it hands it.
 *
 * `test/codicons-screen.test.ts` proves the font really arrives. It cannot prove that nothing ELSE
 * can: a panel whose `localResourceRoots` were the whole install plus every workspace folder (VS
 * Code's default when the option is left unset, which is what the Start form did before T-40) would
 * load the font just as well. So this reads each panel's real webview options and markup: exactly
 * one root, the packaged codicons' `dist/`; and the page links that folder's stylesheet through
 * `asWebviewUri`, with the CSP naming the webview's own `cspSource` for fonts.
 *
 * The narrator is covered by the screen test only: it is created inside the walk and this suite has
 * no handle on it, while its root comes from the same `codiconsRoot` call as the two below.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot } from '../src/core.js';
import type { ExtensionApi } from '../src/extension.js';
import { StartPanel, type StartPanelDeps } from '../src/start/panel.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return ext.activate();
}

/** The one folder every panel may read, composed here from the extension's own path rather than
 *  imported, so a wrong constant in src/ cannot agree with itself. */
function expectedRoot(context: vscode.ExtensionContext): string {
  return path.join(context.extensionUri.fsPath, 'node_modules', '@vscode', 'codicons', 'dist');
}

function assertGrantsOnlyTheFont(where: string, webview: vscode.Webview, context: vscode.ExtensionContext): void {
  const roots = (webview.options.localResourceRoots ?? null)?.map((u) => u.fsPath);
  assert.deepEqual(roots, [expectedRoot(context)], `${where}: exactly one root, the packaged codicons' dist/`);
  assert.ok(fs.existsSync(path.join(roots[0]!, 'codicon.css')) && fs.existsSync(path.join(roots[0]!, 'codicon.ttf')),
    `${where}: and that folder holds the stylesheet and the font`);

  const css = webview.asWebviewUri(vscode.Uri.file(path.join(expectedRoot(context), 'codicon.css'))).toString();
  const html = webview.html;
  assert.ok(html.includes(`<link rel="stylesheet" href="${css.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`),
    `${where}: the page links the packaged stylesheet through asWebviewUri (${css})`);
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
  assert.ok(csp.split(';').map((d) => d.trim()).includes(`font-src ${webview.cspSource}`), `${where}: ${csp}`);
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
      const deadline = Date.now() + 15_000;
      while (!panel.webview?.html.includes('id="step-main"') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(panel.webview, 'the step view resolved in this host');
      assertGrantsOnlyTheFont('step view', panel.webview, api._context);
    } finally {
      api._walk.session()?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      fs.rmSync(target, { recursive: true, force: true });
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
