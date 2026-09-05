// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs inside a real VS Code extension host (vscode-test). This is where T-2's actual bet
 * gets settled: does repo-tour's ESM core — including tree-sitter's WASM — load and run HERE,
 * not just in a plain Node script (spec §3, §10; T-1's "first thing to prove").
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveCoreRoot, loadCore, type CoreLoadResult } from '../src/core.js';
import { runDoctor } from '../src/doctor.js';
import { resumeOnActivate, type ExtensionApi, type ResumeDeps } from '../src/extension.js';
import { buildDir, markerPath, readMarker, type BuildMarker } from '../src/start/build.js';
import { emptyRequest } from '../src/start/request.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';
const CURRENT_BUILD_KEY = 'buildTutorials.currentBuild';

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
    // T-3 adds 'build' (repo-tour/build: buildPlan, interpretPlan, check, stubFile) to the
    // tracked set, so the doctor now reports exactly 8 modules, all ok.
    assert.equal(report.modules.length, 8, `expected 8 modules, got: ${JSON.stringify(report.modules)}`);
    const okModules = report.modules.filter((m) => m.ok);
    assert.ok(
      okModules.length >= 6,
      `expected >= 6 ok modules, got ${okModules.length}: ${JSON.stringify(report.modules)}`,
    );
    const buildModule = report.modules.find((m) => m.name === 'build');
    assert.ok(buildModule?.ok, `the "build" module should load: ${JSON.stringify(buildModule)}`);
    assert.match(buildModule.detail, /buildPlan/, 'build module detail should name buildPlan');
    assert.match(buildModule.detail, /interpretPlan/, 'build module detail should name interpretPlan');

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

// ── T-3 rework, review finding 1: resume-on-activate must be CHEAP when there is nothing
// to resume, and must clear its own bookmark rather than re-asking forever. ──────────────
//
// This needs a real `ExtensionContext` (`workspaceState` is not fake-able and not
// constructible outside an extension host), which is why it lives here and not in
// `test/unit/`. `resumeOnActivate`'s `deps` are the seam: `loadCore` and `withProgress` are
// counted, so "no core load happened, no notification opened" is an assertion and not a
// claim. `Extension.activate()` is idempotent within one process, so a second REAL
// activation is not something a test can stage — calling the exported function with the
// same real context is as close as the platform allows.

async function getContext(): Promise<vscode.ExtensionContext> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  const api = await ext.activate();
  return api._context;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMarkerAt(target: string, ageMs: number): BuildMarker {
  const marker: BuildMarker = {
    startedAt: new Date(Date.now() - ageMs).toISOString(),
    phase: 'plan',
    request: { ...emptyRequest(), recreate: true, repo: tmpDir('resume-repo-'), target },
  };
  fs.mkdirSync(buildDir(target), { recursive: true });
  fs.writeFileSync(markerPath(target), JSON.stringify(marker, null, 2));
  return marker;
}

/** Enough of a `CoreLoadResult` for `buildContextFor` (`coreFor` + `resolveLlmSettings`) to
 *  build a context from — the Discard path never actually calls any of these. */
function fakeCore(): CoreLoadResult {
  const unused = () => { throw new Error('the Discard path must never touch the core'); };
  return {
    found: true,
    root: '/fake/repo-tour',
    version: '0.0.0-test',
    via: null,
    modules: [],
    reason: null,
    loaded: {
      digest: { digest: unused },
      build: { buildPlan: unused, interpretPlan: unused },
      interpret: { defaultCacheDir: unused, DEFAULT_MODEL: 'test-model' },
    },
  };
}

interface CountingDeps extends ResumeDeps {
  loadCoreCalls: number;
  progressCalls: number;
  confirmed: string[];
}

function countingDeps(answer: 'Resume' | 'Discard' | undefined): CountingDeps {
  const deps: CountingDeps = {
    loadCoreCalls: 0,
    progressCalls: 0,
    confirmed: [],
    loadCore: () => { deps.loadCoreCalls++; return Promise.resolve(fakeCore()); },
    withProgress: (task) => {
      deps.progressCalls++;
      const source = new vscode.CancellationTokenSource();
      return task({ report: () => {} }, source.token).finally(() => { source.dispose(); });
    },
    confirm: (message) => { deps.confirmed.push(message); return Promise.resolve(answer); },
  };
  return deps;
}

suite('resumeOnActivate (T-3 rework, review finding 1)', () => {
  let context: vscode.ExtensionContext;

  suiteSetup(async () => { context = await getContext(); });
  teardown(async () => { await context.workspaceState.update(CURRENT_BUILD_KEY, undefined); });

  test('a remembered target with NO marker: clears the key, loads no core, opens no progress UI', async () => {
    const target = tmpDir('resume-no-marker-');
    await context.workspaceState.update(CURRENT_BUILD_KEY, target);
    const deps = countingDeps('Resume');

    await resumeOnActivate(context, deps);

    assert.equal(deps.loadCoreCalls, 0, 'the core must not be loaded when there is nothing to resume');
    assert.equal(deps.progressCalls, 0, 'no progress notification may be opened for nothing');
    assert.equal(deps.confirmed.length, 0);
    assert.equal(
      context.workspaceState.get<string>(CURRENT_BUILD_KEY), undefined,
      'the bookmark must be cleared, or every future activation pays this cost again',
    );
  });

  test('a marker older than 6 hours is treated the same way: cleared, nothing loaded', async () => {
    const target = tmpDir('resume-stale-marker-');
    writeMarkerAt(target, 7 * 60 * 60 * 1000);
    await context.workspaceState.update(CURRENT_BUILD_KEY, target);
    const deps = countingDeps('Resume');

    await resumeOnActivate(context, deps);

    assert.equal(deps.loadCoreCalls, 0, 'a stale marker must not cost a core load either');
    assert.equal(deps.progressCalls, 0);
    assert.equal(context.workspaceState.get<string>(CURRENT_BUILD_KEY), undefined);
    assert.ok(readMarker(target), 'a stale marker is left on disk, not deleted — only the bookmark goes');
  });

  test('no remembered target at all: does nothing, loads nothing', async () => {
    await context.workspaceState.update(CURRENT_BUILD_KEY, undefined);
    const deps = countingDeps('Resume');

    await resumeOnActivate(context, deps);

    assert.equal(deps.loadCoreCalls, 0);
    assert.equal(deps.progressCalls, 0);
  });

  test('a FRESH marker DOES offer Resume/Discard (discriminates against the three cases above)', async () => {
    const target = tmpDir('resume-fresh-marker-');
    writeMarkerAt(target, 60 * 1000);
    await context.workspaceState.update(CURRENT_BUILD_KEY, target);
    const deps = countingDeps(undefined); // dismissed — the offer appeared, nobody answered

    await resumeOnActivate(context, deps);

    assert.equal(deps.loadCoreCalls, 1, 'a fresh marker is exactly when loading the core is worth it');
    assert.equal(deps.progressCalls, 1);
    assert.equal(deps.confirmed.length, 1, 'the Resume/Discard offer must actually appear');
    assert.match(deps.confirmed[0]!, /^A build for .+ was interrupted \(in progress: plan\)\. Resume it\?$/);
    assert.ok(readMarker(target), 'a dismissed prompt leaves the marker for next time');
    assert.equal(
      context.workspaceState.get<string>(CURRENT_BUILD_KEY), target,
      'and so keeps the bookmark pointing at it',
    );
  });

  test('Discard removes the marker AND clears the key', async () => {
    const target = tmpDir('resume-discard-');
    writeMarkerAt(target, 60 * 1000);
    await context.workspaceState.update(CURRENT_BUILD_KEY, target);
    const deps = countingDeps('Discard');

    await resumeOnActivate(context, deps);

    assert.equal(deps.confirmed.length, 1);
    assert.equal(readMarker(target), null, 'Discard removes the marker');
    assert.equal(context.workspaceState.get<string>(CURRENT_BUILD_KEY), undefined, 'and the key with it');
  });
});
