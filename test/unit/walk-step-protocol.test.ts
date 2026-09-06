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
 *   - **`step:check` runs the REAL check now (AC5).** T-4's version replied a `step:note`
 *     carrying the honest sentence "Check my work arrives with T-5" and checked nothing. T-5
 *     is that ticket, so the sentence and its reply are gone and the button drives
 *     `effects.runCheck()`. Both halves are asserted: that the effect fires exactly once, and
 *     that NOTHING is posted back — the verdict returns as `StepViewState.check` on the
 *     session's next push and is drawn on the page, so a reply here would be a second, older
 *     answer to the same question. A test that only checked the effect would pass on a
 *     handler that also left the stale placeholder behind.
 *   - **`reproduce:run` routes and does not second-guess (AC6).** It calls `effects.reproduce()`
 *     whether or not the state it is holding still shows an outstanding offer, because the
 *     panel's snapshot can be one push out of date and the session cannot. The session's own
 *     `reproduce()` carries the idempotence.
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
import { currentStep, setCurrent, stepDial } from '../../src/walk/model.js';
import {
  MAX_ASK_TEXT, NOTHING_TO_ASK_MESSAGE, askTooLongMessage, handleStepMessage, parseStepMessage,
  type StepEffects, type StepViewState,
} from '../../src/walk/step-protocol.js';
import { fixturePlan, fixtureProgress } from './walk-fixtures.js';

interface Calls {
  goTo: string[];
  openFile: number;
  runCheck: number;
  reproduce: number;
  persistDial: Array<[string, Dial]>;
  persistSkin: string[];
  /** T-6: every question that actually reached the session, exactly as it was handed over —
   *  which is how the two refusals below are proved to be refusals and not merely quiet. */
  ask: string[];
  cancelAsk: number;
}

function noCalls(): Calls {
  return { goTo: [], openFile: 0, runCheck: 0, reproduce: 0, persistDial: [], persistSkin: [], ask: [], cancelAsk: 0 };
}

const NOTHING: Calls = noCalls();

function fakeEffects(): { effects: StepEffects; calls: Calls } {
  const calls = noCalls();
  const effects: StepEffects = {
    goTo: (stepId) => { calls.goTo.push(stepId); },
    openFile: () => { calls.openFile += 1; },
    runCheck: () => { calls.runCheck += 1; },
    reproduce: () => { calls.reproduce += 1; },
    persistDial: (stepId, dial) => { calls.persistDial.push([stepId, dial]); },
    persistSkin: (name) => { calls.persistSkin.push(name); },
    // The one effect in this protocol that can spend money, and it is a recorder here like
    // every other — nothing in this suite has a provider anywhere near it.
    ask: (text) => { calls.ask.push(text); },
    cancelAsk: () => { calls.cancelAsk += 1; },
  };
  return { effects, calls };
}

/** Nothing happened at all — the assertion the two "ends of the walk" tests need. Asserted
 *  against the WHOLE record, so a message that quietly grew a second effect fails here. */
function assertNothingCalled(calls: Calls): void {
  assert.deepEqual(calls, NOTHING);
}

/**
 * The exact state the real panel builds: the current step already resolved beside the plan,
 * and the dial already resolved by the session (AC1) rather than re-derived here — `stepDial`
 * is the same function `WalkSession.refresh` uses, so this fixture cannot disagree with what a
 * real push carries.
 */
function stateAt(stepId: string, overrides: Partial<StepViewState> = {}): StepViewState {
  const plan = fixturePlan();
  const progress = setCurrent(fixtureProgress(plan), stepId);
  const step = currentStep(plan, progress);
  assert.ok(step, `the fixture plan should contain a step ${stepId}`);
  return {
    plan, progress, step, fileExists: true, dial: stepDial(progress, stepId), skin: 'system',
    // T-6: a step nobody has asked about has an EMPTY conversation, which is the ordinary
    // state and the one every test below starts from unless it says otherwise.
    transcript: [], ...overrides,
  };
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

suite('handleStepMessage — step:check really checks now (AC5)', () => {
  test('drives runCheck exactly once, and drives nothing else', () => {
    const { effects, calls } = fakeEffects();
    handleStepMessage(stateAt('st-3-symbol-handle'), { type: 'step:check' }, effects);

    assert.deepEqual(calls, { ...NOTHING, runCheck: 1 });
  });

  test('posts NO reply and leaves the state alone — the verdict comes back as a fresh view', () => {
    // The half that fails if T-4's placeholder is left behind beside the real call. There is
    // nothing for a reply to say: `runCheck` records the verdict and refreshes, so the answer
    // arrives as `StepViewState.check` and is DRAWN, in full, rather than summarised into a
    // sentence the page would then be showing beside the report it duplicates.
    const { effects } = fakeEffects();
    const state = stateAt('st-3-symbol-handle');
    const result = handleStepMessage(state, { type: 'step:check' }, effects);

    assert.equal(result.post, undefined, 'no step:note — and in particular no "arrives with T-5"');
    assert.equal(result.state, state, 'the same object back, not a copy with a note bolted on');
    assert.equal(result.state.note, undefined);
  });

  test('the placeholder sentence is gone from the module entirely', async () => {
    // Asserted against the MODULE rather than against a string this file also owns: the
    // failure being guarded is a stale export surviving the rework, and `CHECK_NOTE` cannot
    // be imported by name any more without failing the build, so the honest probe is that the
    // namespace does not carry it.
    const protocol: Record<string, unknown> = await import('../../src/walk/step-protocol.js');
    assert.ok(!('CHECK_NOTE' in protocol), 'T-5 IS the ticket the placeholder promised; leaving it would be the lie');
  });
});

suite('handleStepMessage — reproduce:run (AC6)', () => {
  test('drives reproduce exactly once, changes nothing, and posts no reply', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-1-shape-src', { reproduce: { count: 12, done: false } });
    const result = handleStepMessage(state, { type: 'reproduce:run' }, effects);

    assert.deepEqual(calls, { ...NOTHING, reproduce: 1 });
    assert.equal(result.state, state);
    assert.equal(result.post, undefined);
  });

  test('routes even when the state it is holding shows no outstanding offer', () => {
    // Deliberate: the panel's snapshot can be one push out of date and the session cannot, so
    // "is there anything left to copy" is the session's question — exactly as `goTo` hands
    // over an id the session is free to reject. A guard here would drop a legitimate click
    // that raced a refresh, and would be a second opinion about the learner's own disk.
    for (const state of [
      stateAt('st-1-shape-src'),
      stateAt('st-1-shape-src', { reproduce: { count: 12, done: true } }),
      stateAt('st-1-shape-src', { reproduce: { count: 0, done: false } }),
    ]) {
      const { effects, calls } = fakeEffects();
      handleStepMessage(state, { type: 'reproduce:run' }, effects);
      assert.equal(calls.reproduce, 1);
    }
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

  test('reproduce:run is on the allowlist by NAME, and every near miss is refused', () => {
    // The message that makes this extension copy files into the learner's folder, so the
    // allowlist matters here more than anywhere else on the page. `reproduce:run` carries no
    // payload at all (WHICH files is `plan.reproduce`'s answer, read by the host), which is
    // what makes "exactly the shape it promises" so short a sentence — and every one of these
    // is a shape it does not promise.
    for (const raw of [
      { type: 'reproduce' },
      { type: 'reproduce:' },
      { type: 'reproduce:run ' },
      { type: ' reproduce:run' },
      { type: 'Reproduce:Run' },
      { type: 'reproduce:run:all' },
      { type: 'reproduce:runx' },
      { type: ['reproduce:run'] },
      { type: { toString: () => 'reproduce:run' } },
      [{ type: 'reproduce:run' }],
      'reproduce:run',
      { payload: { files: ['/etc/passwd'] } },
    ]) {
      assert.equal(parseStepMessage(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
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
  test('the six no-payload messages parse to exactly themselves, with or without an empty payload', () => {
    for (const type of ['step:next', 'step:prev', 'step:open', 'step:check', 'reproduce:run', 'tutor:cancel'] as const) {
      assert.deepEqual(parseStepMessage({ type }), { type });
      assert.deepEqual(parseStepMessage({ type, payload: {} }), { type }, 'the client sends an empty payload; the extra is dropped');
    }
  });

  test('a payload smuggled onto reproduce:run is DROPPED, not carried through', () => {
    // The parser returns a message it built itself, never the object it was handed — so a
    // crafted `files`/`root` field cannot ride along to whatever reads the message next, even
    // if something downstream one day starts looking for one.
    assert.deepEqual(
      parseStepMessage({ type: 'reproduce:run', payload: { files: ['../../etc/passwd'], root: '/' } }),
      { type: 'reproduce:run' },
    );
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

  test('and so do the two T-5 messages — parsed here, acted on there', () => {
    for (const [raw, field] of [
      [{ type: 'step:check' }, 'runCheck'],
      [{ type: 'reproduce:run' }, 'reproduce'],
    ] as const) {
      const { effects, calls } = fakeEffects();
      const parsed = parseStepMessage(raw);
      assert.ok(parsed, `${raw.type} should parse`);
      handleStepMessage(stateAt('st-2-file-parse'), parsed, effects);
      assert.deepEqual(calls, { ...NOTHING, [field]: 1 }, `${raw.type} drives ${field}, and only ${field}`);
    }
  });
});

// ── T-6: the tutor ─────────────────────────────────────────────────────────────────────────

suite('handleStepMessage — tutor:ask sends (AC2)', () => {
  test('hands the question to the session exactly once, and clears any previous refusal', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-2-file-parse', { note: NOTHING_TO_ASK_MESSAGE });
    const result = handleStepMessage(state, { type: 'tutor:ask', payload: { text: 'Why not keep it inline?' } }, effects);

    assert.deepEqual(calls, { ...NOTHING, ask: ['Why not keep it inline?'] });
    assert.equal(result.state.note, undefined, 'a refusal left under a question the tutor is answering would be a stale sentence stated confidently');
    assert.deepEqual(result.post, { type: 'step:note', payload: { note: '' } }, 'and the node on the page is cleared without a repaint');
  });

  test('the question is TRIMMED before it is sent — the session stores exactly what it is given', () => {
    const { effects, calls } = fakeEffects();
    handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:ask', payload: { text: '  \n why?  \n\n ' } }, effects);
    assert.deepEqual(calls.ask, ['why?']);
  });

  test('a question exactly at the cap goes through — the boundary is inclusive', () => {
    const { effects, calls } = fakeEffects();
    const text = 'q'.repeat(MAX_ASK_TEXT);
    const result = handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:ask', payload: { text } }, effects);

    assert.deepEqual(calls.ask, [text]);
    assert.equal(result.state.note, undefined);
  });

  test('the caller\'s state is not edited in place', () => {
    const { effects } = fakeEffects();
    const state = stateAt('st-2-file-parse', { note: NOTHING_TO_ASK_MESSAGE });
    handleStepMessage(state, { type: 'tutor:ask', payload: { text: 'why?' } }, effects);
    assert.equal(state.note, NOTHING_TO_ASK_MESSAGE, 'a new state is returned; the one handed in survives');
  });
});

suite('handleStepMessage — tutor:ask REFUSES, and says so (the note channel\'s producer)', () => {
  test('an empty box is answered, not swallowed — in the state AND in the posted message', () => {
    // Both halves, because the panel needs both. The FIELD is what a later repaint renders
    // (`step-panel.ts` mirrors it out of the returned state); the POST is what puts the
    // sentence on the page right now, without a repaint — which is the whole reason this
    // channel was kept when T-5 deleted its only other producer.
    const { effects, calls } = fakeEffects();
    const result = handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:ask', payload: { text: '' } }, effects);

    assert.deepEqual(calls, NOTHING, 'nothing was asked, so nothing was spent');
    assert.equal(result.state.note, NOTHING_TO_ASK_MESSAGE);
    assert.deepEqual(result.post, { type: 'step:note', payload: { note: NOTHING_TO_ASK_MESSAGE } });
  });

  test('whitespace alone is an empty box — a stray Enter is not a question', () => {
    for (const text of [' ', '\n', '\t\t', '   \n  \n ']) {
      const { effects, calls } = fakeEffects();
      const result = handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:ask', payload: { text } }, effects);
      assert.deepEqual(calls.ask, [], `${JSON.stringify(text)} is not a question`);
      assert.equal(result.state.note, NOTHING_TO_ASK_MESSAGE);
    }
  });

  test('a question past the cap is refused with the COUNT in it, and nothing is sent', () => {
    const { effects, calls } = fakeEffects();
    const text = 'q'.repeat(MAX_ASK_TEXT + 1);
    const result = handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:ask', payload: { text } }, effects);

    assert.deepEqual(calls, NOTHING, 'the cap is a cap on the learner\'s money as much as on this panel\'s work');
    assert.equal(result.state.note, askTooLongMessage(MAX_ASK_TEXT + 1));
    assert.deepEqual(result.post, { type: 'step:note', payload: { note: askTooLongMessage(MAX_ASK_TEXT + 1) } });
    // The exported sentence really does carry the two numbers — a vague "too long" would leave
    // the learner guessing at a limit the page never named.
    assert.match(result.state.note ?? '', new RegExp(String(MAX_ASK_TEXT + 1)));
    assert.match(result.state.note ?? '', new RegExp(String(MAX_ASK_TEXT)));
  });

  test('the LENGTH that is measured is the trimmed one, so padding cannot push a legal question over', () => {
    const { effects, calls } = fakeEffects();
    const text = `${'q'.repeat(MAX_ASK_TEXT)}${' '.repeat(50)}`;
    handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:ask', payload: { text } }, effects);
    assert.equal(calls.ask.length, 1, 'trailing whitespace is not part of the question');
  });
});

suite('handleStepMessage — tutor:cancel (AC4)', () => {
  test('drives cancelAsk once, changes nothing, and posts no reply', () => {
    const { effects, calls } = fakeEffects();
    const state = stateAt('st-2-file-parse', { tutor: { thinking: true } });
    const result = handleStepMessage(state, { type: 'tutor:cancel' }, effects);

    assert.deepEqual(calls, { ...NOTHING, cancelAsk: 1 });
    assert.equal(result.state, state, 'the spinner comes off on the session\'s push, which is the only thing that knows there was one');
    assert.equal(result.post, undefined);
  });

  test('routes even when the state it holds shows nothing in flight', () => {
    // Same rule as `reproduce:run`: the panel's snapshot can be one push out of date and the
    // session cannot. A guard here would drop a Cancel pressed the instant before a refresh.
    const { effects, calls } = fakeEffects();
    handleStepMessage(stateAt('st-2-file-parse'), { type: 'tutor:cancel' }, effects);
    assert.equal(calls.cancelAsk, 1);
  });
});

suite('parseStepMessage — the tutor\'s two messages', () => {
  test('tutor:ask carries the text through, and drops anything smuggled beside it', () => {
    assert.deepEqual(
      parseStepMessage({ type: 'tutor:ask', payload: { text: 'why?', provider: 'evil', model: 'expensive' } }),
      { type: 'tutor:ask', payload: { text: 'why?' } },
      'the parser returns a message it built itself — a crafted provider cannot ride along to whatever reads it next',
    );
  });

  test('a text that is not a string is null — SHAPE is what this function judges', () => {
    for (const raw of [
      { type: 'tutor:ask' },
      { type: 'tutor:ask', payload: null },
      { type: 'tutor:ask', payload: {} },
      { type: 'tutor:ask', payload: { text: 42 } },
      { type: 'tutor:ask', payload: { text: null } },
      { type: 'tutor:ask', payload: { text: ['why?'] } },
      { type: 'tutor:ask', payload: { text: { toString: 'why?' } } },
    ]) {
      assert.equal(parseStepMessage(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });

  test('an empty or oversized text still PARSES — the refusal belongs to the handler, not here', () => {
    // The split this pair exists to pin. If the parser rejected these, the panel would log one
    // line to an output channel and the learner would watch the button do nothing; because it
    // accepts them, `handleStepMessage` gets to answer with a sentence.
    for (const text of ['', '   ', 'q'.repeat(MAX_ASK_TEXT + 1000)]) {
      assert.deepEqual(parseStepMessage({ type: 'tutor:ask', payload: { text } }), { type: 'tutor:ask', payload: { text } });
    }
  });

  test('and both parse straight into the handler (the two ends line up)', () => {
    const { effects, calls } = fakeEffects();
    const ask = parseStepMessage({ type: 'tutor:ask', payload: { text: 'why?' } });
    assert.ok(ask);
    handleStepMessage(stateAt('st-2-file-parse'), ask, effects);
    assert.deepEqual(calls, { ...NOTHING, ask: ['why?'] });

    const { effects: e2, calls: c2 } = fakeEffects();
    const cancel = parseStepMessage({ type: 'tutor:cancel', payload: {} });
    assert.ok(cancel);
    handleStepMessage(stateAt('st-2-file-parse'), cancel, e2);
    assert.deepEqual(c2, { ...NOTHING, cancelAsk: 1 });
  });
});
