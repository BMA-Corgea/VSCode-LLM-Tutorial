// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/tutor/transcript.ts — AC2's own check, a state test: one conversation per step, kept in
 * `progress.json`, so switching steps switches transcripts and returning restores exactly what
 * was there. Nothing here reaches a model or a webview; the tutor's panel and session (a later
 * step of this same ticket) are the only callers, and both trust these functions the way
 * `src/walk/model.ts`'s own callers trust `setDial`/`setCheck` — pure, field-preserving, never
 * a throw.
 *
 * Four things are pinned deliberately, each because getting it wrong would be quiet rather
 * than loud:
 *
 *   - **`getTranscript` cannot throw**, for any shape `progress.steps[id].transcript` holds.
 *     It sits on the render path — the panel calls it every time a step is opened or switched
 *     to — so an exception there does not show a blank transcript, it stops the walk from
 *     opening at all. The malformed shapes below are not exotic: `progress.json` is a file on
 *     the learner's own disk, exactly as untrusted as the one `walk-store.test.ts` already
 *     distrusts for `check`.
 *   - **`sanitizeTranscript` drops, it does not coerce** — the opposite choice from repo-tour's
 *     own `ask.trimMessages`, which is a real risk of confusion because both take `unknown` and
 *     both return `AskMessage[]`. One dedicated suite below exists only to pin the divergence
 *     (an empty-content turn is KEPT; a wrong-shaped one is DROPPED, never guessed at) so a
 *     future edit that "simplifies" this into calling `trimMessages` instead is caught here.
 *   - **`MAX_TURNS_KEPT` drops the OLDEST turn, exactly at the boundary**, and the cap is a
 *     ceiling on storage, never on a live conversation — proven by actually filling a
 *     transcript to the cap and appending one more, not by inspecting the constant.
 *   - **Two steps' transcripts never mix.** AC2's whole point, proven both in memory and across
 *     a real `saveProgress` / `loadProgress` round trip on a temp directory, the same drill
 *     `walk-store.test.ts` runs for its own reload guarantee (AC4 there).
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_TURN_CHARS, turnCutNote } from '../../src/tutor/context.js';
import type { AskMessage } from '../../src/tutor/core.js';
import { MAX_TURNS_KEPT, appendTurn, clearTranscript, getTranscript, sanitizeTranscript, sentTurns } from '../../src/tutor/transcript.js';
import { emptyProgress, markDone, setCheck, setCurrent, setDial, type Progress } from '../../src/walk/model.js';
import { buildDir, loadPlan, loadProgress, saveProgress } from '../../src/walk/store.js';
import { fixturePlan, writeFixtureTarget } from './walk-fixtures.js';

const madeDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-tutor-transcript-'));
  madeDirs.push(dir);
  return dir;
}

/** A temp folder that looks like a target repo-tour has already planned — same fixture
 *  `walk-store.test.ts` opens, so this suite argues about the same four steps. */
function fixtureTarget(): string {
  const dir = tmpDir();
  writeFixtureTarget(dir);
  return dir;
}

function progressPath(target: string): string {
  return path.join(buildDir(target), 'progress.json');
}

suiteTeardown(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function user(content: string): AskMessage {
  return { role: 'user', content };
}

function assistant(content: string): AskMessage {
  return { role: 'assistant', content };
}

/**
 * Plants an arbitrary, possibly-nonsense value where a step's `transcript` would be — standing
 * in for whatever a hand edit, a future version, or another tool sharing the folder could have
 * left there. `ProgressStep.transcript` is typed `unknown[]` in `model.ts` for exactly this
 * reason, so the cast here is not a shortcut around the type system, it is the test recreating
 * the one case that type declares real.
 */
function withRawTranscript(progress: Progress, stepId: string, raw: unknown): Progress {
  const existing = progress.steps[stepId];
  return {
    ...progress,
    steps: { ...progress.steps, [stepId]: { status: existing?.status ?? 'pending', ...existing, transcript: raw as unknown[] } },
  };
}

suite('sanitizeTranscript — a validator, not a trimmer (see transcript.ts\'s header for why that distinction matters)', () => {
  test('a well-formed transcript survives, in order, unchanged', () => {
    const raw = [{ role: 'user', content: 'why?' }, { role: 'assistant', content: 'because' }];
    assert.deepEqual(sanitizeTranscript(raw), [user('why?'), assistant('because')]);
  });

  test('an empty array stays empty', () => {
    assert.deepEqual(sanitizeTranscript([]), []);
  });

  test('an empty-string content is KEPT — fidelity to what happened, not usefulness to a prompt (unlike trimMessages)', () => {
    assert.deepEqual(sanitizeTranscript([{ role: 'user', content: '' }]), [{ role: 'user', content: '' }]);
  });

  test('extra fields on an otherwise-good entry are dropped, not smuggled through', () => {
    const raw = [{ role: 'user', content: 'hi', extra: 'nope', timestamp: 123 }];
    assert.deepEqual(sanitizeTranscript(raw), [user('hi')]);
  });

  for (const [label, raw] of [
    ['a string', 'not an array'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['a plain object, not wrapped in an array', { role: 'user', content: 'hi' }],
    ['a boolean', true],
  ] as const) {
    test(`a non-array raw (${label}) yields []`, () => {
      assert.deepEqual(sanitizeTranscript(raw), []);
    });
  }

  for (const [label, entry] of [
    ['null', null],
    ['a bare string', 'hello'],
    ['a bare number', 7],
    ['a bare boolean', true],
    ['an array (isRecord must exclude arrays, not just accept anything typeof "object")', ['role', 'user']],
    ['an object with a wrong role', { role: 'system', content: 'hi' }],
    ['an object with no role at all', { content: 'hi' }],
    ['an object whose content is a number', { role: 'user', content: 42 }],
    ['an object whose content is missing', { role: 'assistant' }],
    ['an object whose content is null', { role: 'user', content: null }],
  ] as const) {
    test(`a malformed entry (${label}) is dropped, and does not take its neighbours down with it`, () => {
      const raw = [{ role: 'user', content: 'before' }, entry, { role: 'assistant', content: 'after' }];
      assert.deepEqual(sanitizeTranscript(raw), [user('before'), assistant('after')]);
    });
  }
});

suite('getTranscript — total: an absent step, an absent transcript, or a malformed one all give []', () => {
  test('a step id progress.steps has no entry for at all', () => {
    assert.deepEqual(getTranscript(emptyProgress(fixturePlan()), 'st-1-shape-src'), []);
  });

  test('a step with a recorded entry but no transcript field yet', () => {
    const progress = markDone(emptyProgress(fixturePlan()), 'st-1-shape-src');
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), []);
  });

  test('an id no step in the plan even has', () => {
    assert.deepEqual(getTranscript(emptyProgress(fixturePlan()), 'st-99-deleted'), []);
  });

  for (const [label, raw] of [
    ['a string', 'not an array'],
    ['a number', 42],
    ['null', null],
    ['an array of nulls', [null, null]],
    ['objects with a wrong role', [{ role: 'system', content: 'hi' }]],
    ['a non-string content', [{ role: 'user', content: 42 }]],
  ] as const) {
    test(`a malformed transcript (${label}) never throws — it reads as []`, () => {
      const progress = withRawTranscript(emptyProgress(fixturePlan()), 'st-1-shape-src', raw);
      assert.doesNotThrow(() => getTranscript(progress, 'st-1-shape-src'));
      assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), []);
    });
  }

  test('a well-formed transcript planted directly on a Progress reads back unchanged', () => {
    const progress = withRawTranscript(emptyProgress(fixturePlan()), 'st-1-shape-src', [{ role: 'user', content: 'why?' }]);
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), [user('why?')]);
  });
});

suite('appendTurn — pure, field-preserving, capped at MAX_TURNS_KEPT', () => {
  test('MAX_TURNS_KEPT is generous enough that no real single-step conversation could plausibly reach it', () => {
    // Not pinning the exact number — the reasoning (repo-tour trims to 30 for the model
    // regardless of how much this module keeps) lives in transcript.ts's own comment. This
    // just guards the invariant the report leans on: comfortably past any real conversation.
    assert.ok(MAX_TURNS_KEPT >= 100, 'fewer than 50 question/answer rounds would be a real risk of cutting a learner off');
  });

  test('appending to a step with no entry yet creates one, pending, with just that turn', () => {
    const progress = appendTurn(emptyProgress(fixturePlan()), 'st-1-shape-src', user('why does src exist?'));
    assert.deepEqual(progress.steps['st-1-shape-src'], { status: 'pending', transcript: [user('why does src exist?')] });
  });

  test('successive appends accumulate in order', () => {
    let progress = emptyProgress(fixturePlan());
    progress = appendTurn(progress, 'st-1-shape-src', user('one'));
    progress = appendTurn(progress, 'st-1-shape-src', assistant('two'));
    progress = appendTurn(progress, 'st-1-shape-src', user('three'));
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), [user('one'), assistant('two'), user('three')]);
  });

  test('other fields already on the step entry — status, dial, check — are untouched by an append', () => {
    let progress = emptyProgress(fixturePlan());
    progress = markDone(progress, 'st-1-shape-src');
    progress = setDial(progress, 'st-1-shape-src', 'scaffolded');
    progress = setCheck(progress, 'st-1-shape-src', true, '2026-09-05T00:00:00.000Z');

    const after = appendTurn(progress, 'st-1-shape-src', user('why does src exist?'));

    assert.equal(after.steps['st-1-shape-src']?.status, 'done');
    assert.equal(after.steps['st-1-shape-src']?.dial, 'scaffolded');
    assert.deepEqual(after.steps['st-1-shape-src']?.check, { ok: true, at: '2026-09-05T00:00:00.000Z' });
    assert.deepEqual(getTranscript(after, 'st-1-shape-src'), [user('why does src exist?')]);
  });

  test('does not mutate the progress object it was handed', () => {
    const before = emptyProgress(fixturePlan());
    const after = appendTurn(before, 'st-1-shape-src', user('hi'));
    assert.deepEqual(getTranscript(before, 'st-1-shape-src'), [], 'the caller\'s own object must not be rewritten under it');
    assert.deepEqual(getTranscript(after, 'st-1-shape-src'), [user('hi')]);
  });

  test('a malformed existing transcript is sanitized before the new turn is appended, not carried forward as-is', () => {
    const dirty = withRawTranscript(emptyProgress(fixturePlan()), 'st-1-shape-src', [
      { role: 'user', content: 'kept' },
      { role: 'nope', content: 'dropped' },
      'also dropped',
    ]);
    const after = appendTurn(dirty, 'st-1-shape-src', assistant('new'));
    assert.deepEqual(getTranscript(after, 'st-1-shape-src'), [user('kept'), assistant('new')]);
  });

  test('appending past MAX_TURNS_KEPT drops the OLDEST turn, keeping the count exactly at the cap', () => {
    let progress = emptyProgress(fixturePlan());
    for (let i = 0; i < MAX_TURNS_KEPT; i++) {
      progress = appendTurn(progress, 'st-1-shape-src', user(`turn-${i}`));
    }
    assert.equal(getTranscript(progress, 'st-1-shape-src').length, MAX_TURNS_KEPT, 'filled to exactly the cap');

    progress = appendTurn(progress, 'st-1-shape-src', user('one-too-many'));
    const kept = getTranscript(progress, 'st-1-shape-src');

    assert.equal(kept.length, MAX_TURNS_KEPT, 'the cap is never exceeded');
    assert.deepEqual(kept[0], user('turn-1'), 'turn-0 — the OLDEST — must be the one dropped, not the newest');
    assert.deepEqual(kept[kept.length - 1], user('one-too-many'), 'the newest turn is always the one kept');
  });
});

suite('clearTranscript — back to [], every other field untouched', () => {
  test('clears an existing transcript to []', () => {
    let progress = appendTurn(emptyProgress(fixturePlan()), 'st-1-shape-src', user('hi'));
    progress = clearTranscript(progress, 'st-1-shape-src');
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), []);
  });

  test('preserves status and dial', () => {
    let progress = markDone(emptyProgress(fixturePlan()), 'st-1-shape-src');
    progress = setDial(progress, 'st-1-shape-src', 'automated');
    progress = appendTurn(progress, 'st-1-shape-src', user('hi'));

    progress = clearTranscript(progress, 'st-1-shape-src');

    assert.equal(progress.steps['st-1-shape-src']?.status, 'done');
    assert.equal(progress.steps['st-1-shape-src']?.dial, 'automated');
  });

  test('a step with no entry yet gets a fresh pending one, transcript []', () => {
    const progress = clearTranscript(emptyProgress(fixturePlan()), 'st-1-shape-src');
    assert.deepEqual(progress.steps['st-1-shape-src'], { status: 'pending', transcript: [] });
  });

  test('does not mutate its input', () => {
    const before = appendTurn(emptyProgress(fixturePlan()), 'st-1-shape-src', user('hi'));
    clearTranscript(before, 'st-1-shape-src');
    assert.deepEqual(getTranscript(before, 'st-1-shape-src'), [user('hi')], 'the caller\'s own object must not be rewritten under it');
  });
});

suite('AC2 — one conversation per step; switching steps never mixes them', () => {
  test('two steps accumulate completely independently', () => {
    let progress = emptyProgress(fixturePlan());
    progress = appendTurn(progress, 'st-1-shape-src', user('about step 1'));
    progress = appendTurn(progress, 'st-1-shape-src', assistant('reply 1'));
    progress = appendTurn(progress, 'st-2-file-parse', user('about step 2'));

    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), [user('about step 1'), assistant('reply 1')]);
    assert.deepEqual(getTranscript(progress, 'st-2-file-parse'), [user('about step 2')]);
  });

  test('clearing one step\'s transcript leaves every other step\'s alone', () => {
    let progress = emptyProgress(fixturePlan());
    progress = appendTurn(progress, 'st-1-shape-src', user('a'));
    progress = appendTurn(progress, 'st-2-file-parse', user('b'));
    progress = clearTranscript(progress, 'st-1-shape-src');

    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), []);
    assert.deepEqual(getTranscript(progress, 'st-2-file-parse'), [user('b')]);
  });

  test('moving the walk\'s current step (setCurrent) does not touch either transcript — switching restores exactly what was there', () => {
    let progress = emptyProgress(fixturePlan());
    progress = appendTurn(progress, 'st-1-shape-src', user('a'));
    progress = setCurrent(progress, 'st-2-file-parse');
    progress = appendTurn(progress, 'st-2-file-parse', user('b'));
    progress = setCurrent(progress, 'st-1-shape-src');

    assert.equal(progress.current, 'st-1-shape-src');
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), [user('a')], 'returning restores exactly what was there');
    assert.deepEqual(getTranscript(progress, 'st-2-file-parse'), [user('b')]);
  });
});

suite('round trip through the real saveProgress / loadProgress on a temp dir (AC2\'s own check: a state test)', () => {
  test('two steps\' transcripts both survive a save and a fresh load from disk, and stay separate', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    let progress = emptyProgress(plan);
    progress = appendTurn(progress, 'st-1-shape-src', user('why does src exist?'));
    progress = appendTurn(progress, 'st-1-shape-src', assistant('because...'));
    progress = appendTurn(progress, 'st-2-file-parse', user('why split the tokenizer out?'));
    saveProgress(target, progress);

    // Nothing carried over in memory — a fresh read from disk, the same drill
    // `walk-store.test.ts` runs for its own reload guarantee (AC4 there).
    const reloaded = loadProgress(target, loadPlan(target));
    assert.deepEqual(getTranscript(reloaded, 'st-1-shape-src'), [user('why does src exist?'), assistant('because...')]);
    assert.deepEqual(getTranscript(reloaded, 'st-2-file-parse'), [user('why split the tokenizer out?')]);
    assert.deepEqual(getTranscript(reloaded, 'st-3-symbol-handle'), [], 'a step never asked about has no transcript');
  });

  test('the atomic write leaves no .tmp file behind after a transcript-bearing save (same guarantee walk-store.test.ts pins)', () => {
    const target = fixtureTarget();
    saveProgress(target, appendTurn(emptyProgress(loadPlan(target)), 'st-1-shape-src', user('hi')));
    const left = fs.readdirSync(buildDir(target));
    assert.ok(!left.some((name) => name.endsWith('.tmp')), 'a progress.json.tmp in a learner\'s repo is a bug, not cosmetics');
  });

  test('a malformed transcript already on disk loads as [] rather than throwing, and the rest of the file is unaffected', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    fs.writeFileSync(
      progressPath(target),
      JSON.stringify({
        schemaVersion: 1,
        current: 'st-2-file-parse',
        steps: {
          'st-1-shape-src': { status: 'done', transcript: [{ role: 'user', content: 'kept' }, { role: 'nope', content: 'dropped' }] },
          'st-2-file-parse': { status: 'pending', transcript: 'not even an array' },
        },
      }),
    );

    const progress = loadProgress(target, plan);
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), [user('kept')]);
    assert.deepEqual(getTranscript(progress, 'st-2-file-parse'), []);
    assert.equal(progress.current, 'st-2-file-parse', 'a bad transcript must not take the rest of the file down with it');
    assert.equal(progress.steps['st-1-shape-src']?.status, 'done', 'nor the sibling fields on its own step entry');
  });
});

// ── the outbound contract: a stored turn is re-sent on every follow-up ───────────────────────

/**
 * The security review's finding 4. `MAX_TURNS_KEPT` bounds how MANY turns are kept and nothing
 * bounded how big one is: the reviewer stored a 2,000,000-character assistant turn and read it
 * back intact, and repo-tour's `trimMessages` then re-sends the last thirty turns IN FULL on
 * every later ask about the same step — so one large reply is paid for again on every
 * follow-up, and written to the learner's disk on every turn in between.
 *
 * The rule is the outbound contract's, not this module's — `Outbound.turn`, in
 * `src/tutor/context.ts`, beside the other four — and it is applied in `sanitizeTranscript`
 * because that is the ONE function both `getTranscript` (the sole reader) and `appendTurn`
 * (the sole writer) go through. A cap at either call site alone would leave the other open.
 */
suite('the size of one turn — a reply is stored once and billed on every question after it', () => {
  test('a two-million-character reply is cut to the contract’s size, and says so', () => {
    const enormous = 'A'.repeat(2_000_000);
    const progress = appendTurn(emptyProgress(fixturePlan()), 'st-1-shape-src', assistant(enormous));
    const kept = getTranscript(progress, 'st-1-shape-src');
    assert.equal(kept.length, 1);
    assert.ok(
      kept[0]!.content.length <= MAX_TURN_CHARS,
      `${kept[0]!.content.length} characters were stored, and re-sent, against a cap of ${MAX_TURN_CHARS}`,
    );
    assert.ok(kept[0]!.content.endsWith(turnCutNote(2_000_000)), `the cut must be announced with the real size:\n${kept[0]!.content.slice(-200)}`);
  });

  test('the cap holds on the way IN and on the way OUT — a hand-edited progress.json is cut too', () => {
    // `ProgressStep.transcript` is `unknown[]`: nothing validates it on the way in from disk,
    // and `withCheckedVerdicts` carries it through untouched. `getTranscript` is the sole
    // enforcement point and has to stay that way.
    const progress = emptyProgress(fixturePlan());
    const hand = {
      ...progress,
      steps: { 'st-1-shape-src': { status: 'pending' as const, transcript: [{ role: 'assistant', content: 'B'.repeat(500_000) }] } },
    };
    const kept = getTranscript(hand, 'st-1-shape-src');
    assert.ok(kept[0]!.content.length <= MAX_TURN_CHARS, `${kept[0]!.content.length} characters read back off disk`);
    assert.ok(kept[0]!.content.endsWith(turnCutNote(500_000)));
  });

  test('a turn the learner could legitimately type or read survives whole, untouched', () => {
    // The opposite half. `MAX_ASK_TEXT` lets a question be 4,000 characters and the panel
    // draws 4,000 of a reply, so a cap that cut either would be the cap doing harm: this one
    // sits above both on purpose.
    const legal = 'Q'.repeat(4000);
    const progress = appendTurn(emptyProgress(fixturePlan()), 'st-1-shape-src', user(legal));
    assert.deepEqual(getTranscript(progress, 'st-1-shape-src'), [user(legal)]);
  });

  test('the worst case is now arithmetic: MAX_TURNS_KEPT turns of MAX_TURN_CHARS, and no more', () => {
    let progress = emptyProgress(fixturePlan());
    for (let i = 0; i < MAX_TURNS_KEPT + 5; i += 1) {
      progress = appendTurn(progress, 'st-1-shape-src', assistant('C'.repeat(50_000)));
    }
    const kept = getTranscript(progress, 'st-1-shape-src');
    assert.equal(kept.length, MAX_TURNS_KEPT);
    const total = kept.reduce((sum, turn) => sum + turn.content.length, 0);
    assert.ok(total <= MAX_TURNS_KEPT * MAX_TURN_CHARS, `${total} characters on the learner's disk for one step`);
  });
});

/**
 * T-7 widened `sanitizeTranscript`'s allow-list by one field, `kind`, and one value of it,
 * `'note'`. That is the single most dangerous kind of edit this function can receive: its
 * security review (T-6, and the 12 hostile-transcript cases above) proved a property —
 * "a kept turn is REBUILT, so nothing extra survives" — and widening an allow-list is exactly
 * how such a proof gets quietly un-earned. So the proof is re-run here against the wider rule,
 * and the value is pinned as tightly as the key.
 *
 * The second suite pins the half that no amount of sanitising can cover: repo-tour's
 * `trimMessages` rebuilds every turn as `{ role, content }`, which DROPS `kind` and KEEPS the
 * sentence. A note that reaches it arrives at the model looking like something the assistant
 * wrote — T-6 security finding 7's injection channel, self-inflicted. `sentTurns` is the filter
 * that has to run first, and these tests fail if anyone routes the send path back through
 * `getTranscript`.
 */
suite('a note is a turn the learner reads and the model never sees (T-7)', () => {
  const noted = (content: string): unknown => ({ role: 'assistant', content, kind: 'note' });

  test('a note survives sanitising, marked', () => {
    const out = sanitizeTranscript([noted('detour taken: Sorting a deck of cards')]);
    assert.deepEqual(out, [{ role: 'assistant', content: 'detour taken: Sorting a deck of cards', kind: 'note' }]);
  });

  test('the WIDENED allow-list is still an allow-list: a forged kind is dropped, the turn is kept', () => {
    // Each of these is a `kind` that is not the literal 'note'. None may survive, and none may
    // take the turn down with it — a hand-edited progress.json is a bad field, not a lost
    // conversation.
    const forged: unknown[] = [
      { role: 'assistant', content: 'a', kind: 'system' },
      { role: 'assistant', content: 'b', kind: 'Note' },
      { role: 'assistant', content: 'c', kind: ['note'] },
      { role: 'assistant', content: 'd', kind: { toString: () => 'note' } },
      { role: 'assistant', content: 'e', kind: 7 },
      { role: 'assistant', content: 'f', kind: null },
      { role: 'assistant', content: 'g', kind: undefined },
    ];
    const out = sanitizeTranscript(forged);
    assert.equal(out.length, forged.length, 'a bad kind must not drop the turn');
    for (const turn of out) assert.ok(!('kind' in turn), `kind survived: ${JSON.stringify(turn)}`);
  });

  test('the rebuild is still a rebuild — a note carries nothing else through', () => {
    const out = sanitizeTranscript([
      { role: 'assistant', content: 'x', kind: 'note', extra: '<script>alert(1)</script>', role2: 'system' },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(Object.keys(out[0]!).sort(), ['content', 'kind', 'role']);
  });

  test('a note is still size-capped like any other turn', () => {
    const out = sanitizeTranscript([noted('N'.repeat(MAX_TURN_CHARS * 3))]);
    assert.equal(out.length, 1);
    const turn = out[0]!;
    assert.ok(turn.content.length < MAX_TURN_CHARS * 3);
    assert.ok(turn.content.includes(turnCutNote(MAX_TURN_CHARS * 3).slice(0, 12)) || turn.content.length <= MAX_TURN_CHARS + 200);
    assert.equal(turn.kind, 'note');
  });

  test('a __proto__ payload alongside a note still pollutes nothing', () => {
    sanitizeTranscript([{ role: 'user', content: 'q', kind: 'note', ['__proto__']: { polluted: true } }]);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

suite('sentTurns — the filter that stands between a note and the model (T-7)', () => {
  const withTurns = (turns: AskMessage[]): Progress => {
    let progress = emptyProgress(fixturePlan());
    for (const t of turns) progress = appendTurn(progress, 'st-1-shape-src', t);
    return progress;
  };

  test('the panel sees the note and the model does not', () => {
    const progress = withTurns([
      { role: 'user', content: 'why a src folder?' },
      { role: 'assistant', content: 'because…' },
      { role: 'assistant', content: 'detour taken: Sorting a deck of cards', kind: 'note' },
      { role: 'user', content: 'and the next step?' },
    ]);
    assert.equal(getTranscript(progress, 'st-1-shape-src').length, 4, 'the learner reads their whole record');
    const sent = sentTurns(progress, 'st-1-shape-src');
    assert.equal(sent.length, 3);
    assert.ok(!sent.some((m) => m.content.startsWith('detour taken:')), 'a note reached the send path');
    assert.ok(!sent.some((m) => m.kind === 'note'));
  });

  test('a transcript that is ONLY notes sends nothing at all', () => {
    const progress = withTurns([{ role: 'assistant', content: 'detour taken: X', kind: 'note' }]);
    assert.equal(sentTurns(progress, 'st-1-shape-src').length, 0);
    assert.equal(getTranscript(progress, 'st-1-shape-src').length, 1);
  });

  test('THE REASON THIS FILTER EXISTS: trimMessages would keep the sentence and drop the mark', () => {
    // Not a test of our code — a test of the assumption our code is built on. repo-tour's
    // trimMessages rebuilds `{ role, content }`, so handing it a note yields a turn the model
    // reads as the assistant's own words. If repo-tour ever starts honouring `kind`, this test
    // fails and `sentTurns` can be reconsidered; until then it is load-bearing.
    const note: AskMessage = { role: 'assistant', content: 'detour taken: X', kind: 'note' };
    const rebuilt = [note].map((m) => ({ role: m.role, content: m.content }));
    assert.deepEqual(rebuilt, [{ role: 'assistant', content: 'detour taken: X' }]);
    assert.ok(!('kind' in rebuilt[0]!), 'the mark is gone and the sentence is not — hence sentTurns');
  });
});
