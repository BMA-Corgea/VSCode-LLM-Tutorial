// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs inside a real VS Code extension host (vscode-test). This is where T-2's actual bet
 * gets settled: does repo-tour's ESM core — including tree-sitter's WASM — load and run HERE,
 * not just in a plain Node script (spec §3, §10; T-1's "first thing to prove").
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveCoreRoot, loadCore } from '../src/core.js';
import { runDoctor } from '../src/doctor.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

function getExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return ext;
}

suite('build-tutorials extension', () => {
  test('activates and registers its two commands', async () => {
    const ext = getExtension();
    await ext.activate();
    assert.equal(ext.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('buildTutorials.doctor'), 'buildTutorials.doctor should be registered');
    assert.ok(commands.includes('buildTutorials.start'), 'buildTutorials.start should be registered');
  });

  test('loads the core from the sibling checkout and calls baseCss() (AC2)', async () => {
    const root = resolveCoreRoot('../repo-tour', getExtension().extensionUri.fsPath);
    const core = await loadCore(root);

    assert.equal(core.found, true, core.reason ?? 'core should be found at the sibling checkout');
    const skins = core.loaded['skins'] as { baseCss: () => string } | undefined;
    assert.ok(skins && typeof skins.baseCss === 'function', 'the skins module should have loaded');
    const css = skins.baseCss();
    assert.ok(css.length > 100, 'baseCss() should return real stylesheet text, not a stub');
  });

  test('doctor reports the real sibling core: found, modules, grammars, claude (AC3)', async () => {
    const root = resolveCoreRoot('../repo-tour', getExtension().extensionUri.fsPath);
    const report = await runDoctor(root);

    assert.equal(report.core.found, true, report.core.reason ?? 'core should be found');
    const okModules = report.modules.filter((m) => m.ok);
    assert.ok(
      okModules.length >= 6,
      `expected >= 6 ok modules, got ${okModules.length}: ${JSON.stringify(report.modules)}`,
    );

    // This is the whole bet: does web-tree-sitter initialise inside THIS extension host.
    assert.equal(report.grammars.ok, true, report.grammars.detail);
    assert.deepEqual([...report.grammars.loaded].sort(), ['javascript', 'python', 'tsx', 'typescript']);

    // The claude CLI may or may not be installed on a given machine — either answer is a
    // pass, as long as it IS an answer: never a throw, never silence.
    assert.equal(typeof report.claude.ok, 'boolean');
    if (!report.claude.ok) {
      assert.ok(report.claude.reason && report.claude.reason.length > 0, 'a missing claude must say why');
    }
  });

  test('doctor reports a missing core honestly when repoTourPath points nowhere (AC3)', async () => {
    const badRoot = path.join(getExtension().extensionUri.fsPath, 'this-path-does-not-exist');
    const report = await runDoctor(badRoot);

    assert.equal(report.core.found, false);
    assert.ok(report.core.reason?.includes(badRoot), 'the reason should name the exact path that was tried');
    assert.equal(report.grammars.ok, false);
    assert.equal(report.claude.ok, false);
  });
});
