// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-92 (b) in the real extension host: a folder whose `.repo-tour/build/` came with it.
 *
 * The unit suites drive `believeRequest` and the session with fakes; this one drives the wiring
 * itself, `src/extension.ts`'s `walkAdaptersFor`, which is the one place the walk's `loadRequest`
 * is bound to the disk. A cloned repository ships `plan.json` and a `request.json` naming a folder
 * of the learner's as the reference, with the dial at automated. The walk must open, copy nothing,
 * and say why. With the build's own record for the same folder, the same walk copies the file, so
 * the refusal is about the record and nothing else.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import { NOT_BUILT_HERE } from '../src/walk/provenance.js';
import { fixturePlan, writeFixtureTarget } from './unit/walk-fixtures.js';
import { recordBuiltHere } from './support/built-here.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';
const STEP = 'st-2-file-parse';
const FILE = 'notes/plan.ts';
const MARKER = 'HOME-SECRET-host-3c71';
const made: string[] = [];

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return ext.activate();
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A cloned folder carrying its own plan, parked on a file step, and a request naming `home`. */
function shipped(): { target: string; home: string } {
  const home = tmpDir('t92-host-home-');
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(home, FILE), `export const diary = '${MARKER}';\n`);
  const target = tmpDir('t92-host-cloned-');
  const plan = fixturePlan();
  plan.steps = plan.steps.map((s) => (s.id === STEP ? { ...s, target: { ...s.target, file: FILE } } : s));
  writeFixtureTarget(target, plan);
  const build = path.join(target, '.repo-tour', 'build');
  fs.writeFileSync(path.join(build, 'request.json'), JSON.stringify({
    idea: '', recreate: true, repo: home, referenceRoot: home, target, dial: 'automated',
  }));
  // Parked on the file step with no override of its own, so the request's global dial applies.
  fs.writeFileSync(path.join(build, 'progress.json'), JSON.stringify({
    schemaVersion: 1, current: STEP, steps: { 'st-1-shape-src': { status: 'done' } },
  }));
  return { target, home };
}

suite('T-92: a tutorial this editor did not build reads no reference (the real extension)', () => {
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the walk opens on a shipped plan, copies nothing in, and the page says why', async () => {
    const api = await getApi();
    const { target } = shipped();
    await api._walk.openAt(target);
    const session = api._walk.session();
    assert.ok(session, 'the walk did not open on a shipped plan');
    await session.settled();
    assert.equal(session.getView()?.step.id, STEP, 'the walk is not on the file step');
    assert.equal(fs.existsSync(path.join(target, FILE)), false, `${FILE} was copied in from a folder the repository chose`);
    assert.equal(session.getView()?.referenceNote, NOT_BUILT_HERE, 'the page does not say why nothing is written');
    assert.equal(session.getView()?.dial, 'manual');
  });

  test('the control: the same folder with the build\'s own record copies the file, as before', async () => {
    const api = await getApi();
    const { target, home } = shipped();
    await recordBuiltHere(target, home);
    await api._walk.openAt(target);
    const session = api._walk.session();
    assert.ok(session);
    await session.settled();
    assert.equal(session.getView()?.referenceNote, undefined);
    assert.equal(fs.readFileSync(path.join(target, FILE), 'utf8'), `export const diary = '${MARKER}';\n`,
      'a tutorial built here did not write its step');
  });
});
