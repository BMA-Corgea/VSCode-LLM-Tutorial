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
import { handleStartMessage, parseInboundMessage, type PanelState, type StartEffects } from '../../src/start/protocol.js';

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

// ── T-3 rework, review finding 3: nothing reaches handleStartMessage unparsed ──────────────
//
// The three probes below are the reviewer's own, verbatim: fed to the real compiled
// `handleStartMessage` they threw `TypeError: repo.trim is not a function`, threw from the
// exhaustive `default` branch, and threw `Cannot read properties of null`. Dispatched from a
// real `onDidReceiveMessage` (which calls `void this.onMessage(...)`) each became an
// unhandled promise rejection. `parseInboundMessage` is the gate that now stops all three.

const VALID_REQUEST = { idea: '', recreate: true, repo: '/tmp/x', target: '/tmp/y', dial: 'manual' };

suite('parseInboundMessage — the reviewer\'s three probes (review finding 3)', () => {
  test('probe 1: a non-string field in the request -> null (never a TypeError from validateRepo)', () => {
    assert.equal(
      parseInboundMessage({ type: 'form:submit', payload: { request: { ...VALID_REQUEST, repo: 12345, target: { evil: true } } } }),
      null,
    );
  });

  test('probe 2: a null payload/request -> null (never "Cannot read properties of null")', () => {
    assert.equal(parseInboundMessage({ type: 'form:submit', payload: { request: null } }), null);
    assert.equal(parseInboundMessage({ type: 'form:submit', payload: null }), null);
    assert.equal(parseInboundMessage({ type: 'form:changed' }), null, 'a missing payload entirely');
  });

  test('probe 3: an unknown message type -> null (never a throw from the default branch)', () => {
    assert.equal(parseInboundMessage({ type: 'evil:message' }), null);
    assert.equal(parseInboundMessage({ type: 'evil:message', payload: { request: VALID_REQUEST } }), null);
  });

  test('nothing at all, or the wrong kind of thing entirely, is also just null', () => {
    for (const raw of [null, undefined, 42, 'form:submit', [], [{ type: 'form:submit' }], { }, { type: 7 }]) {
      assert.equal(parseInboundMessage(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });

  test('a field of the right NAME but the wrong type is caught, field by field', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...VALID_REQUEST, idea: 1 },
      { ...VALID_REQUEST, recreate: 'true' },  // a string, not a boolean
      { ...VALID_REQUEST, repo: null },
      { ...VALID_REQUEST, target: ['/tmp'] },
      { ...VALID_REQUEST, dial: 'turbo' },     // not one of the three
      { ...VALID_REQUEST, dial: 3 },
      { idea: '', recreate: true, repo: '/tmp/x', target: '/tmp/y' }, // dial missing entirely
    ];
    for (const request of bad) {
      assert.equal(
        parseInboundMessage({ type: 'form:submit', payload: { request } }), null,
        `expected null for request ${JSON.stringify(request)}`,
      );
    }
  });
});

suite('parseInboundMessage — every real message still gets through (discriminates)', () => {
  test('form:submit / form:changed with a well-formed request parse to exactly that message', () => {
    for (const type of ['form:submit', 'form:changed'] as const) {
      assert.deepEqual(
        parseInboundMessage({ type, payload: { request: VALID_REQUEST } }),
        { type, payload: { request: VALID_REQUEST } },
      );
    }
  });

  test('each dial position is accepted', () => {
    for (const dial of ['manual', 'scaffolded', 'automated']) {
      const parsed = parseInboundMessage({ type: 'form:submit', payload: { request: { ...VALID_REQUEST, dial } } });
      assert.equal(parsed?.type === 'form:submit' ? parsed.payload.request.dial : undefined, dial);
    }
  });

  test('unknown extra keys are dropped, not carried into the request (request.json stays clean)', () => {
    const parsed = parseInboundMessage({
      type: 'form:changed',
      payload: { request: { ...VALID_REQUEST, __proto__hack: 'x', extra: { deep: true } }, alsoIgnored: 1 },
    });
    assert.deepEqual(parsed, { type: 'form:changed', payload: { request: VALID_REQUEST } });
  });

  test('pick:repo / pick:target parse with or without the empty payload the client actually sends', () => {
    assert.deepEqual(parseInboundMessage({ type: 'pick:repo', payload: {} }), { type: 'pick:repo' });
    assert.deepEqual(parseInboundMessage({ type: 'pick:target' }), { type: 'pick:target' });
  });

  test('skin:set needs a string skin, and only a string skin', () => {
    assert.deepEqual(parseInboundMessage({ type: 'skin:set', payload: { skin: 'gunmetal' } }), {
      type: 'skin:set', payload: { skin: 'gunmetal' },
    });
    assert.equal(parseInboundMessage({ type: 'skin:set', payload: { skin: 42 } }), null);
    assert.equal(parseInboundMessage({ type: 'skin:set', payload: {} }), null);
  });

  test('a parsed message really is accepted by handleStartMessage (the two ends line up)', async () => {
    const effects = fakeEffects();
    const parsed = parseInboundMessage({
      type: 'form:submit',
      payload: { request: { ...VALID_REQUEST, repo: tmpEmptyDir(), target: tmpEmptyDir() } },
    });
    assert.ok(parsed);
    const result = await handleStartMessage(freshState(), parsed, effects);
    assert.deepEqual(result.post, { type: 'form:problems', payload: { problems: {} } });
    assert.equal(effects.submitted.length, 1);
  });
});
