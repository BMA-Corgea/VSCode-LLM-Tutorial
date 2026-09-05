// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/walk/step-protocol.ts — every message the step panel can send, driven through fake
 * `StepEffects` with no webview and no extension host, exactly the split
 * `test/unit/protocol.test.ts` established for the start screen.
 *
 * What these tests are actually guarding:
 *
 *   - **The ends of the walk.** `step:next` on the last step and `step:prev` on the first must
 *     call NOTHING — no wraparound to the other end, no `goTo(null)` sneaking through as a
 *     crash. Each of those tests asserts the whole effects record is still empty, not merely
 *     that `goTo` was not called with some particular id.
 *   - **`step:check` is honest (AC5).** It answers with the exact `CHECK_NOTE` sentence, in the
 *     panel, and performs no check — a silent no-op or a fabricated pass is the specific
 *     failure repo-tour taught this project to test for. The assertions read the exported
 *     constant rather than a copied string, so the sentence has exactly one home.
 *   - **`dial:set` and `skin:set` post NO reply.** The client already shows the radio it was
 *     just clicked on; the host's only job is to remember the choice for the NEXT render. A
 *     reply here would be a second source of truth for something the webview already knows,
 *     and `src/start/protocol.ts`'s own `skin:set` made the same call.
 *   - **Nothing reaches the handler unparsed.** A webview's `postMessage` is untyped at run
 *     time and the panel dispatches into a `void`-ed promise, so a payload that throws inside
 *     the handler becomes an unhandled rejection nobody is listening for. `parseStepMessage`
 *     has to return `null` for every malformed shape below — never throw, never let one past.
 */

import * as assert from 'node:assert/strict';
import { DIALS, type Dial } from '../../src/start/request.js';
import { currentStep, setCurrent } from '../../src/walk/model.js';
import {
  CHECK_NOTE, handleStepMessage, parseStepMessage, type StepEffects, type StepViewState,
} from '../../src/walk/step-protocol.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

interface Calls {
  goTo: string[];
  openFile: number;
  persistDial: Array<[string, Dial]>;
  persistSkin: string[];
}

function fakeEffects(): { effects: StepEffects; calls: Calls } {
  const calls: Calls = { goTo: [], openFile: 0, persistDial: [], persistSkin: [] };
  const effects: StepEffects = {
    goTo: (stepId) => { calls.goTo.push(stepId); },
    openFile: () => { calls.openFile += 1; },
    persistDial: (stepId, dial) => { calls.persistDial.push([stepId, dial]); },
    persistSkin: (name) => { calls.persistSkin.push(name); },
  };
  return { effects, calls };
}

/** Nothing happened at all — the assertion the two "ends of the walk" tests need. */
function assertNothingCalled(calls: Calls): void {
  assert.deepEqual(calls, { goTo: [], openFile: 0, persistDial: [], persistSkin: [] });
}

/** The exact state the real panel builds: the current step already resolved beside the plan. */
function stateAt(stepId: string, overrides: Partial<StepViewState> = {}): StepViewState {
  const plan = fixturePlan();
  const progress = setCurrent(fixtureProgress(plan), stepId);
  const step = currentStep(plan, progress);
  assert.ok(step, `the fixture plan should contain a step ${stepId}`);
  return { plan, progress, step, fileExists: true, skin: 'system', ...overrides };
}

suite('handleStepMessage — step:next / step:prev (AC2\'s Next and Previous)', () => {
  test('step:next asks the session to go to the next step by ordinal, and does nothing else', () => {
    const { effects, calls } = fakeEffects();
    const result = handleStepMessage(stateAt('st-2-file-parse'), { type: 'step:next' }, effects);

    assert.deepEqual(calls.goTo, ['st-3-symbol-handle']);
    assert.equal(calls.openFile, 0);
    assert.equal(result.post, undefined, 'navigation is the session\'s job to push back, not a reply from here');
  });

  test('step:prev asks for the previous step by ordinal', () => {
    const { effects, calls } = fakeEffects();
    handleStepMessage(stateAt('st-3-symbol-handle'), { type: 'step:prev' }, effects);
    assert.deepEqual(calls.goTo, ['st-2-file-parse']);
  });

  test('at the LAST step, step:next calls nothing at all — no wraparound, no goTo(null)', () => {
    const { effects, calls } = fakeEffects();
    const result = handleStepMessage(stateAt('st-4-symbol-render'), { type: 'step:next' }, effects);

    assertNothingCalled(calls);
    assert.equal(result.post, undefined);
  });

  test('at the FIRST step, step:prev calls nothing at all either', () => {
    const { effects, calls } = fakeEffects();
    const result = handleStepMessage(stateAt('st-1-shape-src'), { type: 'step:prev' }, effects);

    assertNothingCalled(calls);
    assert.equal(result.post, undefined);
  });

  test('neither one edits the panel\'s state — the session re-pushes it after the move', () => {
    const { effects } = fakeEffects();
    const state = stateAt('st-2-file-parse');
    assert.equal(handleStepMessage(state, { type: 'step:next' }, effects).state, state, 'the same object back, not a copy');
    assert.equal(handleStepMessage(state, { type: 'step:prev' }, effects).state, state);
  });
});

suite('handleStepMessage — step:open', () => {
  test('opens the file once, changes nothing, and posts no reply', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-2-file-parse');
    const result = handleStepMessage(state, { type: 'step:open' }, effects);

    assert.equal(calls.openFile, 1);
    assert.deepEqual(calls.goTo, []);
    assert.equal(result.state, state);
    assert.equal(result.post, undefined);
  });
});

suite('handleStepMessage — step:check, the honest control (AC5)', () => {
  test('answers with CHECK_NOTE in both the new state and the posted message', () => {
    const { effects } = fakeEffects();
    const state = stateAt('st-3-symbol-handle');
    const result = handleStepMessage(state, { type: 'step:check' }, effects);

    assert.equal(result.state.note, CHECK_NOTE);
    assert.deepEqual(result.post, { type: 'step:note', payload: { note: CHECK_NOTE } });
    assert.deepEqual(result.state, { ...state, note: CHECK_NOTE }, 'nothing else about the panel changes');
  });

  test('checks nothing, persists nothing, navigates nowhere — it only says so', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-3-symbol-handle');
    handleStepMessage(state, { type: 'step:check' }, effects);

    assertNothingCalled(calls);
    assert.equal(state.note, undefined, 'the caller\'s state is not edited in place; a new one is returned');
  });
});

suite('handleStepMessage — dial:set / skin:set (persist, reply with nothing)', () => {
  test('dial:set persists against the CURRENT step\'s id and posts NO reply', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-2-file-parse');
    const result = handleStepMessage(state, { type: 'dial:set', payload: { dial: 'automated' } }, effects);

    assert.deepEqual(calls.persistDial, [['st-2-file-parse', 'automated']]);
    assert.equal(result.post, undefined, 'the radio the learner just clicked is already showing — a reply is a second truth');
    assert.equal(result.state, state, 'the new dial reaches the panel on the session\'s next push, from progress.json');
  });

  test('every dial position goes through, against whichever step is current', () => {
    for (const dial of DIALS) {
      const { effects, calls } = fakeEffects();
      handleStepMessage(stateAt('st-4-symbol-render'), { type: 'dial:set', payload: { dial } }, effects);
      assert.deepEqual(calls.persistDial, [['st-4-symbol-render', dial]]);
    }
  });

  test('skin:set updates state.skin, persists it, and posts NO reply', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-1-shape-src');
    const result = handleStepMessage(state, { type: 'skin:set', payload: { skin: 'gunmetal' } }, effects);

    assert.equal(result.state.skin, 'gunmetal');
    assert.deepEqual(calls.persistSkin, ['gunmetal']);
    assert.equal(result.post, undefined);
    assert.equal(state.skin, 'system', 'the state handed in is left alone');
  });
});

// ── the gate: nothing reaches handleStepMessage unparsed ────────────────────────────────────

suite('parseStepMessage — malformed input is null, never a throw', () => {
  test('nothing at all, or the wrong kind of thing entirely', () => {
    for (const raw of [null, undefined, 42, 'step:next', true, [], [{ type: 'step:next' }], {}, { type: 7 }, { type: null }]) {
      assert.equal(parseStepMessage(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });

  test('an unknown type, even carrying a payload that would otherwise be fine', () => {
    assert.equal(parseStepMessage({ type: 'step:delete-everything' }), null);
    assert.equal(parseStepMessage({ type: 'dial:reset', payload: { dial: 'manual' } }), null);
    assert.equal(parseStepMessage({ type: 'step:next ' }), null, 'not even a near miss on the type string');
  });

  test('dial:set needs a payload, a real one, carrying a dial that is actually in DIALS', () => {
    for (const raw of [
      { type: 'dial:set' },                                  // no payload at all
      { type: 'dial:set', payload: null },                   // the reviewer's null-payload probe
      { type: 'dial:set', payload: [] },
      { type: 'dial:set', payload: {} },                     // payload, but no dial
      { type: 'dial:set', payload: { dial: 'turbo' } },      // a fourth position that does not exist
      { type: 'dial:set', payload: { dial: 3 } },
      { type: 'dial:set', payload: { dial: null } },
      { type: 'dial:set', payload: { dial: ['manual'] } },
    ]) {
      assert.equal(parseStepMessage(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });

  test('skin:set needs a string skin, and only a string skin', () => {
    for (const raw of [
      { type: 'skin:set' },
      { type: 'skin:set', payload: null },
      { type: 'skin:set', payload: {} },
      { type: 'skin:set', payload: { skin: 42 } },
      { type: 'skin:set', payload: { skin: { name: 'gunmetal' } } },
    ]) {
      assert.equal(parseStepMessage(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });
});

suite('parseStepMessage — every real message still gets through (discriminates)', () => {
  test('the four no-payload messages parse to exactly themselves, with or without an empty payload', () => {
    for (const type of ['step:next', 'step:prev', 'step:open', 'step:check'] as const) {
      assert.deepEqual(parseStepMessage({ type }), { type });
      assert.deepEqual(parseStepMessage({ type, payload: {} }), { type }, 'the client sends an empty payload; the extra is dropped');
    }
  });

  test('dial:set parses each real dial, and skin:set any string skin', () => {
    for (const dial of DIALS) {
      assert.deepEqual(parseStepMessage({ type: 'dial:set', payload: { dial } }), { type: 'dial:set', payload: { dial } });
    }
    assert.deepEqual(parseStepMessage({ type: 'skin:set', payload: { skin: 'gunmetal', extra: 1 } }), {
      type: 'skin:set', payload: { skin: 'gunmetal' },
    });
  });

  test('a parsed message really is accepted by handleStepMessage (the two ends line up)', () => {
    const { effects, calls } = fakeEffects();
    const parsed = parseStepMessage({ type: 'dial:set', payload: { dial: 'scaffolded' } });
    assert.ok(parsed);

    handleStepMessage(stateAt('st-3-symbol-handle'), parsed, effects);
    assert.deepEqual(calls.persistDial, [['st-3-symbol-handle', 'scaffolded']]);
  });
});
