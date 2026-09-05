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

// ── AC3: a build-time refusal is shown IN THE FORM, not only as a transient notification ──

suite('StartPanel.reportProblem — a build-time refusal surfaces in the form (AC3)', () => {
  let panel: StartPanel | undefined;

  teardown(() => {
    panel?.dispose();
    panel = undefined;
  });

  test('posts a form:problems message and merges onto whatever was already there', async () => {
    const context = await getContext();
    const skins = await realSkins(context);
    panel = StartPanel.show(context, { skins, onSubmit: () => {} });

    const first = panel.reportProblem({ repo: 'go is not one of the languages repo-tour ships grammars for' });
    assert.deepEqual(first, {
      type: 'form:problems',
      payload: { problems: { repo: 'go is not one of the languages repo-tour ships grammars for' } },
    });

    const second = panel.reportProblem({ target: 'not empty' });
    assert.deepEqual(second, {
      type: 'form:problems',
      payload: {
        problems: {
          repo: 'go is not one of the languages repo-tour ships grammars for',
          target: 'not empty',
        },
      },
    });
  });

  test('end to end: submitting a Go-only fixture through the panel surfaces the refusal under repo, in the form', async () => {
    // Mirrors exactly what src/extension.ts's runBuild + reportOutcome do — buildFromRequest,
    // then panel.reportProblem on a non-ok, non-cancelled outcome — without depending on
    // extension.ts's own private functions, which are not exported for a test to call.
    const { buildFromRequest, coreFor } = await import('../src/start/build.js');
    const context = await getContext();
    const root = resolveCoreRoot('../repo-tour', context.extensionUri.fsPath);
    const core = await loadCore(root);
    assert.equal(core.found, true, core.reason ?? 'core should be found');
    const skins = core.loaded['skins'] as StartPanelDeps['skins'];

    const goRepo = tmpDir('start-test-go-fixture-');
    fs.writeFileSync(path.join(goRepo, 'main.go'), 'package main\n\nfunc main() {}\n');
    const target = tmpDir('start-test-go-target-');

    let submittedRequest: BuildRequest | undefined;
    let buildDone: Promise<void> | undefined;
    panel = StartPanel.show(context, {
      skins,
      onSubmit: (request) => {
        submittedRequest = request;
        // `onSubmit` is fire-and-forget in production (StartEffects.submit returns void) —
        // captured here so the test can await the SAME promise rather than guessing when
        // the asynchronous build (and its reportProblem call) has actually finished.
        buildDone = buildFromRequest(request, {
          core: coreFor(core.loaded),
          globalStorageRoot: context.globalStorageUri.fsPath,
          provider: 'claude',
          model: 'claude-sonnet-5',
          cachedOnly: true,
        }).then((outcome) => {
          assert.equal(outcome.ok, false, 'a Go-only fixture must be refused');
          panel!.reportProblem({ repo: outcome.reason ?? 'refused' });
        });
      },
    });

    const request: BuildRequest = { idea: '', recreate: true, repo: goRepo, target, dial: 'manual' };
    // dispatchForTest awaits handleStartMessage in full, which calls effects.submit
    // synchronously inside its form:submit branch — by the time this resolves, `onSubmit`
    // has already run and `buildDone` is assigned (though not yet settled).
    const submitReply = await panel.dispatchForTest({ type: 'form:submit', payload: { request } });
    assert.deepEqual(submitReply, { type: 'form:problems', payload: { problems: {} } }, 'the form itself is valid at submit time');
    assert.deepEqual(submittedRequest, request);
    assert.ok(buildDone, 'onSubmit should have run synchronously within dispatchForTest');

    await buildDone;

    // Read the panel's OWN state directly — never by dispatching another message, which
    // would recompute `problems` from scratch via validateRequest and silently overwrite
    // (not read) whatever reportProblem had just set (a real bug this test caught while
    // being written; see .autodev/handoffs/T-3.md).
    const problems = panel.getStateForTest().problems;
    assert.match(problems.repo ?? '', /is go; the grammars repo-tour ships cover TS, JS, TSX and Python/);
  });
});
