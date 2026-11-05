// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vscode-test for T-17's AC3: the EXISTING walk renders a derived plan unchanged, in a real
 * Extension Development Host. One walk, not two code paths (T-1 §9 criterion 2). This suite
 * changes nothing in `src/walk` or `src/dial`, and the branch's diff against `main` there is
 * empty.
 *
 * The derivation is the real engine (`src/derive/engine.ts`) through the real `AskLedger` and
 * repo-tour's real `extract`, with a scripted fake model and `core.runLlm` poisoned, so nothing
 * here spends a token. The tutorial it produces is written exactly as the start screen will write
 * one in T-20: `plan.json`, and a `request.json` whose `referenceRoot` is the derived tree. The
 * walk is then opened through the extension's own `_walk.openAt`, the same door
 * `test/walk.test.ts` and `test/dial.test.ts` use, and driven through the REGISTERED tree, panel
 * and session.
 *
 * What this proves, and what it does not: the walk loads, lists, renders and writes a Mode A plan
 * with no change to the walk. It does NOT prove that the walk ASKS before showing, because it
 * shows the recommendation as it shows an author's choice. That is T-18's job, and Mode A is not
 * reachable from the UI until T-20.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_REPO_TOUR_PATH, loadCore, resolveCoreRoot, type CoreLoadResult } from '../src/core.js';
import { dialCoreFor } from '../src/dial/core.js';
import { derivePlan } from '../src/derive/engine.js';
import type { ExtensionApi } from '../src/extension.js';
import { buildDir, writeJsonAtomic } from '../src/start/build.js';
import { AskLedger } from '../src/tutor/ask.js';
import { tutorCoreFor, type TutorCore } from '../src/tutor/core.js';
import { FIXTURE_IDEA, fixtureOutlineText } from './unit/derive-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';
const STEP_VIEW_FOCUS = 'buildTutorials.step.focus';

const TALLY = 'export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
const MAIN = "import { total } from '../core/tally.mjs';\n\nconsole.log(`total: ${total([1, 2, 3])}`);\n";

const made: string[] = [];
const ledgers: AskLedger[] = [];

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return await ext.activate();
}

/** repo-tour, resolved the way the extension resolves it (`test/dial.test.ts`'s own helper). */
let coreOnce: Promise<CoreLoadResult> | undefined;
function loadedCore(): Promise<CoreLoadResult> {
  coreOnce ??= (async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
    const setting = vscode.workspace.getConfiguration('buildTutorials').get<string>('repoTourPath', DEFAULT_REPO_TOUR_PATH);
    const loaded = await loadCore(resolveCoreRoot(setting, ext.extensionUri.fsPath));
    assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should load from the configured checkout');
    return loaded;
  })();
  return coreOnce;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** The fixture idea, derived through the real engine, written as T-20 will write a tutorial. */
async function derivedTutorial(): Promise<{ target: string; referenceRoot: string; stepIds: string[]; files: string[] }> {
  const loaded = await loadedCore();
  const real = tutorCoreFor(loaded.loaded);
  const core: TutorCore = {
    ...real,
    runLlm: () => Promise.reject(new Error('a test in derive.test.ts reached the real model')),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
  };
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '))!;
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    const text = input['task'] === 'outline'
      ? fixtureOutlineText()
      : JSON.stringify({ content: (input['node'] as Record<string, unknown>)['path'] === 'core/tally.mjs' ? TALLY : MAIN });
    return Promise.resolve({ text, inputTokens: 0, outputTokens: 0, usd: 0, metered: true });
  };
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const target = tmpDir('derive-ehd-target-');
  const out = await derivePlan({ idea: FIXTURE_IDEA }, {
    ledger, globalStorageRoot: tmpDir('derive-ehd-gs-'), target, dialCore: dialCoreFor(loaded.loaded),
    settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run },
  });
  if (!out.ok) assert.fail(out.reason);
  writeJsonAtomic(path.join(buildDir(target), 'request.json'), {
    idea: FIXTURE_IDEA, recreate: false, repo: '', target, dial: 'automated', referenceRoot: out.referenceRoot,
  });
  writeJsonAtomic(path.join(buildDir(target), 'plan.json'), out.plan);
  return {
    target,
    referenceRoot: out.referenceRoot,
    stepIds: [...out.plan.steps].sort((a, b) => a.ordinal - b.ordinal).map((s) => s.id),
    files: out.files.map((f) => f.path),
  };
}

suite('T-17 AC3 — the existing walk renders a derived plan unchanged', () => {
  teardown(async () => {
    const api = await getApi();
    api._walk.session()?.dispose();
    api._walk.decorator()?.clear();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const l of ledgers.splice(0)) l.close();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the walk opens it: the tree lists every chapter and step, in plan order', async () => {
    const { target, stepIds } = await derivedTutorial();
    const api = await getApi();
    await api._walk.openAt(target);
    const session = api._walk.session();
    const tree = api._walk.tree();
    assert.ok(session && tree, 'opening the walk should leave a live session and a tree behind');
    await session.settled();
    const chapters = tree.getChildren();
    assert.deepEqual(chapters.map((n) => (n.kind === 'chapter' ? n.chapter.key : `not a chapter: ${n.step.id}`)), ['core', 'cli']);
    const steps = chapters.flatMap((c) => tree.getChildren(c));
    assert.deepEqual(steps.map((n) => (n.kind === 'step' ? n.step.id : `not a step: ${n.chapter.key}`)), stepIds);
  });

  test('every step renders in the real step panel, and automated mode writes each file with the tree\'s bytes', async () => {
    const { target, referenceRoot, stepIds, files } = await derivedTutorial();
    const api = await getApi();
    await api._walk.openAt(target);
    const session = api._walk.session();
    const panel = api._walk.panel();
    assert.ok(session && panel);
    await session.settled();
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    for (const id of stepIds) {
      await vscode.commands.executeCommand('buildTutorials.goToStep', id);
      await session.settled();
      assert.equal(panel.getStateForTest()?.step.id, id, 'the panel shows the step the walk is on');
    }
    for (const rel of files) {
      assert.equal(
        fs.readFileSync(path.join(target, rel), 'utf8'),
        fs.readFileSync(path.join(referenceRoot, rel), 'utf8'),
        `${rel}: the automated dial wrote the derived tree's bytes`,
      );
    }
  });
});
