// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-51, in the extension host: *Previous step* and *Next step* at the ends of the plan.
 *
 * In the UI they cannot be pressed there (each command's `enablement` greys its title-bar arrow and leaves it
 * out of the palette; `test/plan-ends-screen.test.ts` reads that off the real workbench). Every other way in
 * (a keybinding, another extension's `executeCommand`) still reaches the handler, and there it must say so
 * rather than do nothing, and say something NEW on the repeat: VS Code collapses a notification identical to
 * one it is showing, so the same sentence twice would look like a press that was ignored.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { atEndMessage, type ExtensionApi } from '../src/extension.js';
import { writeFixtureTarget } from './unit/walk-fixtures.js';

const FIRST = 'st-1-shape-src';
const LAST = 'st-4-symbol-render';

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
  assert.ok(ext);
  return ext.activate();
}

function recordingNotices(): { said: string[]; restore: () => void } {
  const said: string[] = [];
  const original = vscode.window.showInformationMessage;
  (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string) => { said.push(message); return Promise.resolve(undefined); };
  return { said, restore: () => { (vscode.window as { showInformationMessage: unknown }).showInformationMessage = original; } };
}

suite('T-51: Previous step and Next step at the ends of the plan', function () {
  this.timeout(60_000);

  async function atStep(stepId: string, body: (api: ExtensionApi) => Promise<void>): Promise<void> {
    const api = await getApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't51-host-'));
    try {
      writeFixtureTarget(dir);
      await api._walk.openAt(dir);
      const session = api._walk.session();
      assert.ok(session, 'the walk opened');
      await session.settled();
      session.goTo(stepId);
      await session.settled();
      assert.equal(session.getView()?.step.id, stepId, 'discriminates: the walk stands where the test says');
      await body(api);
    } finally {
      api._walk.session()?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('Next at the last step says so, says something new on the repeat, and stays where it is', () => atStep(LAST, async (api) => {
    const { said, restore } = recordingNotices();
    try {
      await vscode.commands.executeCommand('buildTutorials.nextStep');
      await vscode.commands.executeCommand('buildTutorials.nextStep');
    } finally {
      restore();
    }
    assert.deepEqual(said, [atEndMessage('last', 1), atEndMessage('last', 2)]);
    assert.notEqual(said[0], said[1], 'the repeat is not the same sentence');
    assert.equal(api._walk.session()?.getView()?.step.id, LAST, 'no wrap, no move');
  }));

  test('Previous at the first step says so, and says something new on the repeat', () => atStep(FIRST, async (api) => {
    const { said, restore } = recordingNotices();
    try {
      await vscode.commands.executeCommand('buildTutorials.prevStep');
      await vscode.commands.executeCommand('buildTutorials.prevStep');
    } finally {
      restore();
    }
    assert.deepEqual(said, [atEndMessage('first', 1), atEndMessage('first', 2)]);
    assert.equal(api._walk.session()?.getView()?.step.id, FIRST);
  }));

  test('a move away and back starts the count again: the first press at an end is never "still"', () => atStep(LAST, async () => {
    const { said, restore } = recordingNotices();
    try {
      await vscode.commands.executeCommand('buildTutorials.nextStep');
      await vscode.commands.executeCommand('buildTutorials.prevStep'); // moves: says nothing
      await vscode.commands.executeCommand('buildTutorials.nextStep'); // moves back to the last step: says nothing
      await vscode.commands.executeCommand('buildTutorials.nextStep');
    } finally {
      restore();
    }
    assert.deepEqual(said, [atEndMessage('last', 1), atEndMessage('last', 1)]);
  }));

  test('a move made another way (the panel\'s buttons, the tree) resets the count too', () => atStep(LAST, async (api) => {
    const session = api._walk.session()!;
    const { said, restore } = recordingNotices();
    try {
      await vscode.commands.executeCommand('buildTutorials.nextStep');
      session.goTo('st-3-symbol-handle'); // what a press of the panel's Previous or a click in the tree does
      await session.settled();
      session.goTo(LAST);
      await session.settled();
      await vscode.commands.executeCommand('buildTutorials.nextStep');
    } finally {
      restore();
    }
    assert.deepEqual(said, [atEndMessage('last', 1), atEndMessage('last', 1)], 'back at the end after a move, the first press is the first again');
  }));
});
