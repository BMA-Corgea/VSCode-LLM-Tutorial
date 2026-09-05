// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vscode-test suite for the start screen (T-3): a REAL `vscode.WebviewPanel`, constructed via
 * `StartPanel` against the sibling repo-tour checkout's real `skins` module. The message
 * protocol itself (every validation rule's effect on the reply) is already thoroughly covered
 * with no webview at all in `test/unit/protocol.test.ts`; what only a real extension host can
 * prove is that `StartPanel` actually wires a real `WebviewPanel` to that protocol correctly
 * and renders a real page. The full end-to-end build against a synthetic fixture (AC3-AC5,
 * schema-validated) lives in `test/unit/build.test.ts` — `src/start/build.ts` has no `vscode`
 * import, so that suite exercises the REAL repo-tour core under plain mocha, faster and with
 * no extension host required; see `.autodev/handoffs/T-3.md` for why.
 *
 * Deliberately does NOT call `vscode.commands.executeCommand('buildTutorials.start')`:
 * `StartPanel` is a module-level singleton, and the command's own panel would not be
 * reachable from here to `dispose()` between tests, leaking state into whichever test runs
 * next. Every test below constructs its own `StartPanel` directly and disposes it in
 * `teardown`, which is enough to prove the wiring — the command itself just calls
 * `StartPanel.show`, already covered by "activates and registers its two commands" in
 * `test/extension.test.ts`.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot } from '../src/core.js';
import type { ExtensionApi } from '../src/extension.js';
import { StartPanel, type StartPanelDeps } from '../src/start/panel.js';
import { emptyRequest, IDEA_FIRST_MESSAGE, type BuildRequest } from '../src/start/request.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

async function getContext(): Promise<vscode.ExtensionContext> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  const api = await ext.activate();
  return api._context;
}

async function realSkins(context: vscode.ExtensionContext): Promise<StartPanelDeps['skins']> {
  const root = resolveCoreRoot('../repo-tour', context.extensionUri.fsPath);
  const core = await loadCore(root);
  assert.equal(core.found, true, core.reason ?? 'the sibling repo-tour checkout should be found');
  return core.loaded['skins'] as StartPanelDeps['skins'];
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

suite('the start screen — real WebviewPanel wiring (AC1, AC2, AC6)', () => {
  let panel: StartPanel | undefined;

  teardown(() => {
    panel?.dispose();
    panel = undefined;
  });

  test('AC1: form:submit with recreate ticked and no repo replies form:problems naming repo', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    panel = StartPanel.show(context, { skins, onSubmit: () => { throw new Error('an invalid submit must not start a build'); } });

    const reply = await panel.dispatchForTest({
      type: 'form:submit',
      payload: { request: { ...emptyRequest(), recreate: true, repo: '' } },
    });

    assert.equal(reply?.type, 'form:problems');
    assert.equal(reply?.type === 'form:problems' ? reply.payload.problems.repo : undefined, 'required when recreating');
  });

  test('AC2: idea typed without recreate replies form:problems with the exact T-9 honesty line', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    panel = StartPanel.show(context, { skins, onSubmit: () => { throw new Error('must not be called'); } });

    const reply = await panel.dispatchForTest({
      type: 'form:submit',
      payload: { request: { ...emptyRequest(), idea: 'a chat app', recreate: false } },
    });

    assert.equal(reply?.type === 'form:problems' ? reply.payload.problems.idea : undefined, IDEA_FIRST_MESSAGE);
  });

  test('a fully valid submit calls onSubmit with exactly that request, and clears all problems', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    let submitted: BuildRequest | undefined;
    panel = StartPanel.show(context, { skins, onSubmit: (req) => { submitted = req; } });

    const request: BuildRequest = { idea: '', recreate: true, repo: tmpDir('start-test-repo-'), target: tmpDir('start-test-target-'), dial: 'manual' };
    const reply = await panel.dispatchForTest({ type: 'form:submit', payload: { request } });

    assert.deepEqual(reply, { type: 'form:problems', payload: { problems: {} } });
    assert.deepEqual(submitted, request);
  });

  test('form:changed never starts a build, even with a fully valid request (discriminates against form:submit)', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    let called = false;
    panel = StartPanel.show(context, { skins, onSubmit: () => { called = true; } });

    const request: BuildRequest = { idea: '', recreate: true, repo: tmpDir('start-test-repo-'), target: tmpDir('start-test-target-'), dial: 'manual' };
    await panel.dispatchForTest({ type: 'form:changed', payload: { request } });

    assert.equal(called, false);
  });

  test('AC6: the initial render carries the form fields and every real SKINS row', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    panel = StartPanel.show(context, { skins, onSubmit: () => {} });

    const html = panel.webview.html;
    assert.match(html, /<textarea id="idea" name="idea"/);
    assert.match(html, /<input type="checkbox" id="recreate" name="recreate">/);
    assert.match(html, /<select class="skinpick" id="skinpick"/);
    for (const row of skins.SKINS) {
      assert.match(html, new RegExp(`<option value="${row.name}"`), `missing a <option> for real SKINS row "${row.name}"`);
    }
  });

  test('is a singleton: calling show() again while open reveals the SAME panel, not a new one', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    panel = StartPanel.show(context, { skins, onSubmit: () => {} });
    const again = StartPanel.show(context, { skins, onSubmit: () => { throw new Error('deps from the second show() must not be used'); } });

    assert.equal(again, panel);
    // Proves it is really the first instance's deps still in effect, not the second's.
    const reply = await again.dispatchForTest({
      type: 'form:submit',
      payload: { request: { ...emptyRequest(), recreate: true, repo: tmpDir('x-'), target: tmpDir('y-') } },
    });
    assert.deepEqual(reply, { type: 'form:problems', payload: { problems: {} } });
  });

  test('after dispose(), the NEXT show() creates a genuinely fresh panel (discriminates against the singleton case)', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    const first = StartPanel.show(context, { skins, onSubmit: () => {} });
    first.dispose();

    panel = StartPanel.show(context, { skins, onSubmit: () => {} });
    assert.notEqual(panel, first);
  });
});
