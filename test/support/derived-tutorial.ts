// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A derived tutorial, made the way the start screen will make one in T-20, for the vscode-tests
 * that open it: `test/derive.test.ts` (the walk's model) and `test/derive-screen.test.ts` (what is
 * on the page).
 *
 * The derivation is the real engine (`src/derive/engine.ts`) through the real `AskLedger` and
 * repo-tour's real `extract`, with a scripted fake model and `core.runLlm` poisoned, so nothing
 * here spends a token. The tutorial it produces is `plan.json` and a `request.json` whose
 * `referenceRoot` is the derived tree.
 *
 * Test-only. Nothing under `test/` ships (`.vscodeignore`).
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_REPO_TOUR_PATH, loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor } from '../../src/dial/core.js';
import { derivePlan } from '../../src/derive/engine.js';
import type { ExtensionApi } from '../../src/extension.js';
import { buildDir, writeJsonAtomic } from '../../src/start/build.js';
import { AskLedger } from '../../src/tutor/ask.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import { FIXTURE_IDEA, fixtureOutlineText } from '../unit/derive-fixtures.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';
export const STEP_VIEW_FOCUS = 'buildTutorials.step.focus';

const TALLY = 'export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
const MAIN = "import { total } from '../core/tally.mjs';\n\nconsole.log(`total: ${total([1, 2, 3])}`);\n";

const made: string[] = [];
const ledgers: AskLedger[] = [];

export async function getApi(): Promise<ExtensionApi> {
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

export interface DerivedTutorial {
  target: string;
  referenceRoot: string;
  /** in plan order */
  stepIds: string[];
  /** each step's own question, in plan order */
  questions: string[];
  files: string[];
}

/** The fixture idea, derived through the real engine, written as T-20 will write a tutorial. */
export async function derivedTutorial(): Promise<DerivedTutorial> {
  const loaded = await loadedCore();
  const real = tutorCoreFor(loaded.loaded);
  const core: TutorCore = {
    ...real,
    runLlm: () => Promise.reject(new Error('a derive vscode-test reached the real model')),
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
  const ordered = [...out.plan.steps].sort((a, b) => a.ordinal - b.ordinal);
  return {
    target,
    referenceRoot: out.referenceRoot,
    stepIds: ordered.map((s) => s.id),
    questions: ordered.map((s) => s.decision.question),
    files: out.files.map((f) => f.path),
  };
}

/** Closes every ledger and removes every folder made since the last call. */
export function cleanUpDerived(): void {
  for (const l of ledgers.splice(0)) l.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
