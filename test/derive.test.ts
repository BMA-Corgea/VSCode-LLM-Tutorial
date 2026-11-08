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
import path from 'node:path';
import * as vscode from 'vscode';
import { STEP_VIEW_FOCUS, cleanUpDerived, derivedTutorial, getApi } from './support/derived-tutorial.js';

suite('T-17 AC3 — the existing walk renders a derived plan unchanged', () => {
  teardown(async () => {
    const api = await getApi();
    api._walk.session()?.dispose();
    api._walk.decorator()?.clear();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    cleanUpDerived();
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
