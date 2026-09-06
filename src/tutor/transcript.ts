// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One conversation per step (T-6 AC2) — `progress.steps[id].transcript`, the slot
 * `src/walk/model.ts` declared back in T-4 precisely so this file would never have to migrate
 * it (`ProgressStep.transcript?: unknown[]`, same reasoning as repo-tour's own `Option[]`
 * floor). This module is what actually reads and writes that slot: pure functions over
 * `Progress`, returning a new object every time, matching `model.ts`'s own `setDial`/`setCheck`
 * field for field — including how they preserve a step entry's OTHER fields (`status`, `dial`,
 * `check`) untouched. A caller that already trusts `setDial` gets the identical guarantee here
 * for free, and a test that checks "the rest of the entry survived" is checking a pattern this
 * file shares with two others, not inventing a third contract.
 *
 * **Why a transcript per STEP, not one conversation for the whole walk.** The tutor's context
 * is the step in front of the learner — its question, its options, the diff of their file
 * against the reference (`context.ts`). One running conversation would carry yesterday's step
 * into today's question the moment the learner moved on; keying storage by step id makes
 * "switching steps switches transcripts, and returning restores" (AC2, verbatim) the ONLY
 * behaviour possible, rather than a rule the session has to remember to enforce every time it
 * changes `progress.current`.
 *
 * **`sanitizeTranscript` is a validator, not a trimmer, and the two must not be conflated.**
 * repo-tour's own `ask.trimMessages` also takes `unknown`, but its job is to hand the model
 * SOMETHING usable no matter what it is given: an unrecognised `role` is coerced to `'user'`,
 * a non-string `content` is coerced with `String(...)`, empty turns are dropped, and the result
 * is sliced to the last 30. Coercion is the right call there — a prompt tolerates a guessed
 * role far better than it tolerates a missing one, and the model never finds out either way.
 * It is exactly the wrong call here. This module decides what is safe to KEEP and RENDER BACK
 * to the learner as their own conversation history, read off `progress.json` — a file on the
 * learner's own disk, hand-editable, shared with other tools, and readable by a future version
 * of this extension that may have written a richer shape than this one understands. A coerced
 * role would silently misattribute a turn to the wrong speaker; a stringified object would
 * render as the literal text `"[object Object]"` and look exactly like a real reply.
 * `withCheckedVerdicts` in `src/walk/store.ts` drew this same line for `check` — a malformed
 * verdict is DROPPED, never guessed into a pass or a fail — and for the same reason: this is
 * untrusted input, and the honest answer to "I can't tell what this was supposed to be" is to
 * leave it out, not to invent something plausible-looking in its place.
 *
 * **`MAX_TURNS_KEPT` bounds growth, not conversation.** `progress.json` is written on the
 * learner's disk on every turn (`saveProgress`, `src/walk/store.ts`), so a transcript with no
 * ceiling grows for as long as a learner keeps asking about one step — across sessions, across
 * days, without end. The cap only ever removes the OLDEST turns, and only once a single step's
 * Q&A has gone on far longer than any real one plausibly would; see the constant's own comment
 * for the number and the reasoning. Note also that repo-tour's `trimMessages` already slices to
 * the last 30 turns before a prompt is ever built, regardless of how many this module keeps —
 * so this cap changes how much scrollback a learner can still read, never what the model sees.
 *
 * No `vscode` import: this extension's unit-test bundle (`esbuild.mjs`) marks `repo-tour` and
 * `mocha` external for `test/unit/*` but does NOT mark `vscode` external, so one import of it
 * here would fail that whole build rather than merely this file (same reasoning as `model.ts`
 * and `store.ts`, neither of which imports it either).
 */

import type { Progress } from '../walk/model.js';
import type { AskMessage } from './core.js';

/**
 * How many turns — one `AskMessage` each, either side speaking once — a single step's
 * transcript keeps, oldest dropped first.
 *
 * 200 is chosen to be a number no genuine single-step conversation plausibly reaches: at two
 * turns per question-and-answer round, that is 100 rounds of back-and-forth about ONE tutorial
 * decision, an order of magnitude past even an unusually persistent learner working through an
 * unusually hard step. Nothing downstream needs more than that either — repo-tour's own
 * `trimMessages` sends only the last 30 turns to the model no matter how many are stored — so
 * raising or lowering this constant only changes how much scrollback survives, never what the
 * model is shown. It exists purely to stop `progress.json` growing without limit over a
 * learner's whole history with one step, not to cut a real conversation short.
 */
export const MAX_TURNS_KEPT: number = 200;

/**
 * Same predicate as `src/walk/store.ts`'s private `isRecord`, duplicated rather than imported:
 * it is three lines, this module must not depend on `store.ts` for something this small, and
 * mirroring a tiny helper locally is the established pattern here (`walk-model.test.ts` does
 * the same with its schema checker, on purpose, for the same reason).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this actually an `AskMessage[]`, or merely something stored where one should be?
 *
 * Strict, and deliberately not `ask.trimMessages`'s job (see this file's header): anything that
 * is not EXACTLY `{ role: 'user' | 'assistant', content: string }` is dropped rather than
 * coerced, because what survives this function is rendered back to the learner as their own
 * conversation, not merely handed to a model that tolerates noise. A non-array `raw` — a
 * string, a number, `null`, a plain object — has nothing to iterate and comes back `[]`; a
 * `null` or non-record entry inside the array (including an array-shaped one — `isRecord`
 * excludes arrays on purpose, the mistake a bare `typeof x === 'object'` check would make) is
 * skipped; an entry whose `role` is anything but the two literal strings, or whose `content` is
 * not a string, is skipped whole. There is no partial turn, only a kept one or a dropped one —
 * and a kept one is rebuilt as exactly `{ role, content }`, so any extra field a hand-edited or
 * future-version entry carries is left behind rather than silently smuggled through.
 *
 * An empty `content` string is kept, not dropped — unlike `trimMessages`, which filters empty
 * turns because sending one to a model wastes the round trip. An empty turn here is still a
 * real thing that happened (the learner pressed *Ask* on a blank input, say), and this
 * function's job is fidelity to what was stored, not usefulness to a prompt.
 */
export function sanitizeTranscript(raw: unknown): AskMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AskMessage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const role = entry['role'];
    const content = entry['content'];
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * Every stored turn for one step, or `[]` — for a step id `progress.steps` has no entry for, a
 * step whose entry has no `transcript` yet, or a `transcript` that does not survive
 * `sanitizeTranscript`. Total on purpose, in all three cases: this is called on the RENDER
 * path — the panel asks for a step's transcript every time the learner opens or switches to
 * it — and a render path that can throw over a hand-edited file is a walk that stops opening,
 * which costs a learner their whole session over a single bad field, not a transcript that
 * merely looks empty.
 */
export function getTranscript(progress: Progress, stepId: string): AskMessage[] {
  return sanitizeTranscript(progress.steps[stepId]?.transcript);
}

/**
 * Appends one turn to a step's transcript and returns a new `Progress` — never a mutation of
 * the one passed in, and every other field already recorded against this step (`status`,
 * `dial`, `check`) survives untouched, the same promise `setDial`/`setCheck` make for each
 * other's fields (and the same three-part spread: a fresh `pending` entry when this step has
 * none yet, then `...existing` to carry its other fields forward, then the one field this
 * function actually changes, last, so it always wins).
 *
 * The existing transcript is re-validated through `sanitizeTranscript` before the new turn is
 * appended — never merely cast. `ProgressStep.transcript` is typed `unknown[]` precisely
 * because nothing has checked it since it was read off disk, and appending onto unchecked data
 * would carry forward whatever was already wrong with it. The result is capped to
 * `MAX_TURNS_KEPT` from the end (oldest first) on every call, so the stored transcript can
 * never grow past the cap by even one entry, and a transcript that somehow arrived here already
 * over the cap (a hand edit, a future version) is trimmed back down rather than left oversized.
 */
export function appendTurn(progress: Progress, stepId: string, turn: AskMessage): Progress {
  const existing = progress.steps[stepId];
  const transcript = [...sanitizeTranscript(existing?.transcript), turn].slice(-MAX_TURNS_KEPT);
  return {
    ...progress,
    steps: { ...progress.steps, [stepId]: { status: existing?.status ?? 'pending', ...existing, transcript } },
  };
}

/**
 * Empties one step's transcript back to `[]` — not an absent field, so a step that never had a
 * transcript and a step just cleared read back identically through `getTranscript`. Same
 * field-preserving shape as `appendTurn`/`setDial`/`setCheck`: a step with no entry yet gets a
 * fresh `pending` one rather than being left alone, for the same reason those two do — a caller
 * should never have to check whether a step already has an entry before updating it.
 */
export function clearTranscript(progress: Progress, stepId: string): Progress {
  const existing = progress.steps[stepId];
  return {
    ...progress,
    steps: { ...progress.steps, [stepId]: { status: existing?.status ?? 'pending', ...existing, transcript: [] } },
  };
}
