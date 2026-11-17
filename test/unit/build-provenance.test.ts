// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-92 (b), at the build: the build writes the record a walk believes `request.json` by.
 *
 * Against the REAL core, `cachedOnly`, on a synthetic TypeScript fixture, exactly as
 * `build.test.ts` drives it: no model is called. The two halves of the contract are the two
 * ways it can fail: a finished build whose own walk would then refuse its reference (the honest
 * path broken), and a build that cannot write its record but writes `request.json` anyway (a
 * folder holding a request nothing stands behind).
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { buildDir, buildFromRequest, coreFor, type BuildContext, type BuildCore } from '../../src/start/build.js';
import { emptyRequest, type BuildRequest } from '../../src/start/request.js';
import { NOT_BUILT_HERE, NOT_THE_BUILDS_REQUEST, believeRequest, isWithheld } from '../../src/walk/provenance.js';
import { loadRequest } from '../../src/walk/store.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

let realCore: BuildCore;
let defaultModel: string;
const made: string[] = [];

suiteSetup(async () => {
  const core: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(core.found, true, core.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = coreFor(core.loaded);
  defaultModel = (core.loaded['interpret'] as { DEFAULT_MODEL: string }).DEFAULT_MODEL;
});

suiteTeardown(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Two TypeScript files, one importing the other: enough for repo-tour to plan. */
function tsFixture(): string {
  const root = tmpDir('t92-build-fixture-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), "import { add } from './util.js';\n\nexport function twice(a: number): number {\n  return add(a, a);\n}\n");
  return root;
}

function context(storage: string): BuildContext {
  return { core: realCore, globalStorageRoot: storage, provider: 'claude', model: defaultModel, cachedOnly: true };
}

function requestFor(repo: string, target: string): BuildRequest {
  return { ...emptyRequest(), recreate: true, repo, target };
}

suite('T-92: the build writes the record its walk believes the reference root by', () => {
  test('a finished build\'s own request is believed, and its root is the one the build resolved', async () => {
    const repo = tsFixture();
    const target = tmpDir('t92-build-target-');
    const storage = tmpDir('t92-build-storage-');
    const outcome = await buildFromRequest(requestFor(repo, target), context(storage));
    assert.equal(outcome.ok, true, outcome.reason);
    const answer = believeRequest(target, storage, loadRequest);
    assert.ok(answer !== null, 'the build wrote no readable request.json');
    assert.ok(!isWithheld(answer), `a tutorial built here was not believed: ${isWithheld(answer) ? answer.withheld : ''}`);
    assert.equal(answer.referenceRoot, fs.realpathSync(repo));
  });

  test('the same plan in another editor\'s storage is not believed', async () => {
    const repo = tsFixture();
    const target = tmpDir('t92-build-target-');
    const outcome = await buildFromRequest(requestFor(repo, target), context(tmpDir('t92-build-storage-')));
    assert.equal(outcome.ok, true, outcome.reason);
    const elsewhere = believeRequest(target, tmpDir('t92-other-editor-'), loadRequest);
    assert.ok(elsewhere !== null && isWithheld(elsewhere));
    assert.equal(elsewhere.withheld, NOT_BUILT_HERE);
  });

  test('the record is bound to the request the build wrote: a request edited afterwards is not believed', async () => {
    const repo = tsFixture();
    const target = tmpDir('t92-build-target-');
    const storage = tmpDir('t92-build-storage-');
    const outcome = await buildFromRequest(requestFor(repo, target), context(storage));
    assert.equal(outcome.ok, true, outcome.reason);
    const file = path.join(buildDir(target), 'request.json');
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...written, dial: 'automated' }, null, 2));
    const answer = believeRequest(target, storage, loadRequest);
    assert.ok(answer !== null && isWithheld(answer), 'a request edited after the build was believed');
    assert.equal(answer.withheld, NOT_THE_BUILDS_REQUEST);
  });

  test('a build that cannot write its record fails, says why, and writes no plan: the folder holds no walk', async () => {
    const repo = tsFixture();
    const target = tmpDir('t92-build-target-');
    const storage = tmpDir('t92-build-storage-');
    const outside = tmpDir('t92-build-outside-');
    fs.symlinkSync(outside, path.join(storage, 'built'), 'dir');
    const outcome = await buildFromRequest(requestFor(repo, target), context(storage));
    assert.equal(outcome.ok, false, 'a build with no record behind it reported success');
    assert.match(outcome.reason ?? '', /could not be recorded in the extension's storage/);
    // The request is written first, so the record can be bound to its bytes; the plan, the one thing
    // a walk opens on, is not, so this folder never opens a walk the record does not stand behind.
    assert.equal(fs.existsSync(path.join(buildDir(target), 'plan.json')), false, 'a plan was written with no record behind it');
    assert.deepEqual(fs.readdirSync(outside), [], 'the record was written through the link');
  });
});
