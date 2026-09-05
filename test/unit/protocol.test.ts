// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/start/protocol.ts's handleStartMessage — pure (no `vscode`), driven entirely through
 * fake `StartEffects`. This IS "form validation tests via the webview's message protocol"
 * (AC1): every message type, exercised with no webview, no extension host, at all.
 *
 * `validateRequest` really does stat the filesystem (see request.ts), so every "this
 * request is valid" case below points `repo`/`target` at REAL temp directories rather than
 * a plausible-looking `/tmp/x` — a request that is only valid because the test forgot to
 * make its paths real would be testing the wrong thing.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyRequest, IDEA_FIRST_MESSAGE, type BuildRequest } from '../../src/start/request.js';
import { handleStartMessage, type PanelState, type StartEffects } from '../../src/start/protocol.js';

function tmpEmptyDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-protocol-'));
}

function freshState(overrides: Partial<PanelState> = {}): PanelState {
  return { request: emptyRequest(), problems: {}, skin: 'system', ...overrides };
}

function fakeEffects(overrides: Partial<StartEffects> = {}): StartEffects & { submitted: BuildRequest[]; persisted: string[] } {
  const submitted: BuildRequest[] = [];
  const persisted: string[] = [];
  return {
    pickFolder: () => Promise.resolve(undefined),
    submit: (req) => { submitted.push(req); },
    persistSkin: (name) => { persisted.push(name); },
    submitted,
    persisted,
    ...overrides,
  };
}

suite('handleStartMessage — form:submit (AC1 protocol test)', () => {
  test('recreate ticked, no repo -> form:problems names repo, and the build is NOT started', async () => {
    const effects = fakeEffects();
    const request: BuildRequest = { ...emptyRequest(), recreate: true, repo: '' };
    const result = await handleStartMessage(freshState(), { type: 'form:submit', payload: { request } }, effects);

    assert.equal(result.post?.type, 'form:problems');
    assert.equal(result.post?.type === 'form:problems' && result.post.payload.problems.repo, 'required when recreating');
    assert.equal(effects.submitted.length, 0, 'an invalid submit must never start a build');
  });

  test('idea typed, recreate off -> form:problems names idea with the exact T-9 line (AC2)', async () => {
    const effects = fakeEffects();
    const request: BuildRequest = { ...emptyRequest(), idea: 'a chat app', recreate: false };
    const result = await handleStartMessage(freshState(), { type: 'form:submit', payload: { request } }, effects);

    assert.equal(result.post?.type === 'form:problems' ? result.post.payload.problems.idea : undefined, IDEA_FIRST_MESSAGE);
    assert.equal(effects.submitted.length, 0);
  });

  test('a fully valid request -> no problems, and the build IS started with exactly that request', async () => {
    const effects = fakeEffects();
    const request: BuildRequest = { idea: '', recreate: true, repo: tmpEmptyDir(), target: tmpEmptyDir(), dial: 'manual' };
    const result = await handleStartMessage(freshState(), { type: 'form:submit', payload: { request } }, effects);

    assert.deepEqual(result.post, { type: 'form:problems', payload: { problems: {} } });
    assert.deepEqual(effects.submitted, [request]);
  });
});

suite('handleStartMessage — form:changed', () => {
  test('replies with form:problems but never starts a build, even when the request is valid', async () => {
    const effects = fakeEffects();
    const request: BuildRequest = { idea: '', recreate: true, repo: tmpEmptyDir(), target: tmpEmptyDir(), dial: 'manual' };
    const result = await handleStartMessage(freshState(), { type: 'form:changed', payload: { request } }, effects);

    assert.deepEqual(result.post, { type: 'form:problems', payload: { problems: {} } });
    assert.equal(effects.submitted.length, 0, 'form:changed must never itself start a build (discriminates against form:submit)');
    assert.deepEqual(result.state.request, request, 'the state should carry forward the latest typed values');
  });
});

suite('handleStartMessage — pick:repo / pick:target', () => {
  test('a chosen folder replies field:set with the path and recomputed problems', async () => {
    const pickedRepo = tmpEmptyDir();
    const effects = fakeEffects({ pickFolder: (which) => Promise.resolve(which === 'repo' ? pickedRepo : undefined) });
    const result = await handleStartMessage(
      freshState({ request: { ...emptyRequest(), recreate: true } }),
      { type: 'pick:repo' },
      effects,
    );

    assert.deepEqual(result.post, {
      type: 'field:set',
      // target is still unset at this point, so it is the one remaining problem.
      payload: { field: 'repo', value: pickedRepo, problems: { target: 'pick an empty or new folder' } },
    });
    assert.equal(result.state.request.repo, pickedRepo);
  });

  test('cancelling the dialog (undefined) changes nothing and posts no reply', async () => {
    const effects = fakeEffects({ pickFolder: () => Promise.resolve(undefined) });
    const before = freshState();
    const result = await handleStartMessage(before, { type: 'pick:target' }, effects);

    assert.equal(result.post, undefined, 'a cancelled pick must not post anything (discriminates against a real pick)');
    assert.equal(result.state, before, 'state is returned unchanged, not a new object, on cancel');
  });

  test('pick:target updates target, not repo (discriminates the two message types)', async () => {
    const pickedTarget = tmpEmptyDir();
    const effects = fakeEffects({ pickFolder: () => Promise.resolve(pickedTarget) });
    const result = await handleStartMessage(freshState(), { type: 'pick:target' }, effects);
    assert.equal(result.state.request.target, pickedTarget);
    assert.equal(result.state.request.repo, '');
  });
});

suite('handleStartMessage — skin:set', () => {
  test('persists the skin and updates state, but posts NO reply (the client already applied it)', async () => {
    const effects = fakeEffects();
    const result = await handleStartMessage(freshState(), { type: 'skin:set', payload: { skin: 'gunmetal' } }, effects);

    assert.equal(result.post, undefined);
    assert.equal(result.state.skin, 'gunmetal');
    assert.deepEqual(effects.persisted, ['gunmetal']);
  });
});
