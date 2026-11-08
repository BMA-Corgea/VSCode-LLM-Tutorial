// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-30's acceptance in the REAL extension host: what the build does to the whole window while the
 * repository is read. The measurements have to be taken here, on this thread, because this is the
 * thread every other extension in the window runs on (AC1, AC2).
 *
 * What is real: the host's event loop, a real RPC to the renderer, the window's own log, repo-tour,
 * `runBuild` and `buildContextFor` (AC1), and a real worker thread. Nothing spends a token: AC1 ends
 * at the language refusal, before any model call, and AC2 runs with `cachedOnly: true`.
 *
 * Fixtures are generated at test time under `os.tmpdir()` and removed; none is committed.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../src/core.js';
import { runBuild, type ExtensionApi } from '../src/extension.js';
import { buildFromRequest, coreFor, type BuildOutcome } from '../src/start/build.js';
import { offThreadCore } from '../src/start/off-thread.js';
import { emptyRequest, type BuildRequest } from '../src/start/request.js';
import { BUILD_WORKER_RELATIVE } from '../src/start/worker-protocol.js';
import { STALL_BOUND_MS } from './support/stall-bound.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function requestFor(repo: string, target: string): BuildRequest {
  return { ...emptyRequest(), recreate: true, repo, target };
}

function goFixture(dirs: number, each: number): string {
  const root = tmpDir('t30-host-go-');
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `pkg${d}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < each; i++) fs.writeFileSync(path.join(dir, `f${i}.go`), `package pkg${d}\n\nfunc F${i}() int { return ${i} }\n`);
  }
  return root;
}

function tsFixture(dirs: number, each: number): string {
  const root = tmpDir('t30-host-ts-');
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `pkg${d}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < each; i++) {
      const next = (i + 1) % each;
      fs.writeFileSync(path.join(dir, `f${i}.ts`), `import { f${next} } from './f${next}.js';\n\n/** doc ${i} */\nexport function f${i}(a: number): number {\n  return a + ${i};\n}\nexport const v${i} = f${next};\n`);
    }
  }
  return root;
}

interface Watched {
  ticks: number;
  longestStallMs: number;
  rpcCalls: number;
  longestRpcMs: number;
}

/** The longest this thread stalled, and the longest a real round trip to the renderer took, while `body` ran. */
async function watchTheHost<T>(body: () => Promise<T>): Promise<{ result: T; watched: Watched }> {
  let last = performance.now();
  let longestStallMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longestStallMs = Math.max(longestStallMs, now - last);
    last = now;
    ticks += 1;
  }, 20);
  let polling = true;
  let longestRpcMs = 0;
  let rpcCalls = 0;
  const rpc = (async () => {
    while (polling) {
      const sent = performance.now();
      await vscode.commands.getCommands(true);
      longestRpcMs = Math.max(longestRpcMs, performance.now() - sent);
      rpcCalls += 1;
      await sleep(20);
    }
  })();
  let result: T;
  try {
    result = await body();
  } finally {
    // A stall that ended with the body has had no tick after it. Count it, or the longest one is lost.
    longestStallMs = Math.max(longestStallMs, performance.now() - last);
    clearInterval(timer);
    polling = false;
    await rpc;
  }
  return { result, watched: { ticks, longestStallMs: Math.round(longestStallMs), rpcCalls, longestRpcMs: Math.round(longestRpcMs) } };
}

/** The file this window's own warnings land in: `.../window1/renderer.log`, beside `exthost/<extension>`. */
function rendererLogOf(context: vscode.ExtensionContext): string {
  return path.resolve(context.logUri.fsPath, '..', '..', 'renderer.log');
}

function unresponsiveLines(log: string): number {
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('is unresponsive')).length;
}

/** The checks a real measurement has to pass before anything is concluded from a quiet result. */
function assertTheWatcherRan(watched: Watched): void {
  assert.ok(watched.ticks >= 1, 'the watcher never ran: no stall measured is not no stall');
  assert.ok(watched.rpcCalls >= 1, 'no RPC round trip completed');
}

async function context(): Promise<vscode.ExtensionContext> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
  assert.ok(ext, 'the extension is not installed in the test host');
  return (await ext.activate())._context;
}

suite('the build off the host thread, in the real extension host (T-30)', function () {
  this.timeout(240_000);
  let ctx: vscode.ExtensionContext;
  let core: CoreLoadResult;

  suiteSetup(async () => {
    ctx = await context();
    core = await loadCore(resolveCoreRoot('../repo-tour', ctx.extensionUri.fsPath));
    assert.equal(core.found, true, core.reason ?? 'core');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  test('AC1: 20,000 files, through the real runBuild: the host never stalls past the bound, nothing warns', async () => {
    const repo = goFixture(200, 100);
    const target = tmpDir('t30-host-target-');
    try {
      const log = rendererLogOf(ctx);
      assert.equal(fs.existsSync(log), true, `this window's log is not at ${log}: nothing could be concluded from its silence`);
      assert.ok(fs.statSync(log).size > 0, 'the window log is empty: it is not the log this window writes to');
      const warningsBefore = unresponsiveLines(log);

      let outcome: BuildOutcome | undefined;
      const { watched } = await watchTheHost(() => runBuild(ctx, core, requestFor(repo, target), async (r, c) => {
        outcome = await buildFromRequest(r, c);
        return outcome;
      }));
      // VS Code writes its log asynchronously: give a warning that was going to appear the chance to.
      await sleep(1_500);
      console.log(`T-30 AC1 measured: ${JSON.stringify(watched)}`);

      assertTheWatcherRan(watched);
      assert.ok(watched.longestStallMs <= STALL_BOUND_MS, `the extension host's thread stalled for ${watched.longestStallMs} ms while the repository was read (bound ${STALL_BOUND_MS} ms)`);
      assert.ok(watched.longestRpcMs <= STALL_BOUND_MS, `a real RPC round trip took ${watched.longestRpcMs} ms while the repository was read (bound ${STALL_BOUND_MS} ms)`);
      assert.equal(unresponsiveLines(log), warningsBefore, 'VS Code logged the extension host as unresponsive during the build');

      assert.equal(outcome?.ok, false);
      assert.equal(outcome?.cancelled, undefined);
      assert.equal(outcome?.reason, `${repo} is go; the grammars repo-tour ships cover TS, JS, TSX and Python`);
      assert.equal(fs.existsSync(path.join(repo, '.repo-tour')), false, 'the build must not write its digest cache into the reference folder');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('AC2: 5,000 TS files, digest and buildPlan and both hand-backs: the same bound', async () => {
    const repo = tsFixture(50, 100);
    const target = tmpDir('t30-host-target-');
    const storage = tmpDir('t30-host-storage-');
    try {
      const interpretMod = core.loaded['interpret'] as { DEFAULT_MODEL: string };
      const { result: outcome, watched } = await watchTheHost(() => buildFromRequest(requestFor(repo, target), {
        core: offThreadCore({
          workerFile: path.join(ctx.extensionUri.fsPath, BUILD_WORKER_RELATIVE),
          coreRoot: core.root,
          inProcess: coreFor(core.loaded),
        }),
        globalStorageRoot: storage,
        provider: 'claude',
        model: interpretMod.DEFAULT_MODEL,
        cachedOnly: true,
      }));
      console.log(`T-30 AC2 measured: ${JSON.stringify(watched)}`);

      assertTheWatcherRan(watched);
      assert.ok(watched.longestStallMs <= STALL_BOUND_MS, `the extension host's thread stalled for ${watched.longestStallMs} ms across digest and buildPlan (bound ${STALL_BOUND_MS} ms)`);
      assert.ok(watched.longestRpcMs <= STALL_BOUND_MS, `a real RPC round trip took ${watched.longestRpcMs} ms across digest and buildPlan (bound ${STALL_BOUND_MS} ms)`);
      assert.equal(outcome.ok, true, outcome.reason);
      assert.ok((outcome.plan?.steps.length ?? 0) > 0, 'a plan has to have arrived');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});
