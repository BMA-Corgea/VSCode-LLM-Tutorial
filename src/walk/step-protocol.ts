// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The step panel's message protocol (spec §5.3; locate T-4: `step:next`, `step:prev`,
 * `step:open`, `step:check`, `dial:set`, `skin:set`; T-5 adds `reproduce:run`; T-6 adds
 * `tutor:ask` and `tutor:cancel`) — pure data and a pure handler, deliberately separate from
 * `src/walk/step-panel.ts`'s real `vscode.WebviewView`, exactly the split
 * `src/start/protocol.ts` established for the start screen.
 *
 * `handleStepMessage` never imports `vscode`: navigating to a step, opening the target file,
 * running the structural check, copying the never-taught files, asking the tutor and
 * persisting the dial/skin are all `StepEffects` the real adapter (`WalkSession`) injects, so
 * this file — every message type, every reply — is testable with fake effects and no webview,
 * no extension host, at all. That matters most for the tutor: `ask` is the one effect in this
 * protocol that spends the learner's money, and it is behind the same seam as the rest
 * precisely so no test in this suite ever needs a provider.
 *
 * **`step:check` is now the real thing, and that is the whole point of T-5.** T-4 shipped it
 * as an honest placeholder: it replied `step:note` with the literal sentence "Check my work
 * arrives with T-5" and checked nothing, because a silent no-op or a fabricated pass is the
 * specific failure repo-tour taught this project to test for. T-5 is that ticket. The
 * placeholder constant and its reply are therefore GONE rather than kept beside the real
 * behaviour: a sentence promising a feature that has since shipped is no longer honest, it is
 * simply wrong, and the one thing worse than a missing message is a confidently stale one.
 * The button now calls `effects.runCheck()` — the same shape `goTo`/`openFile` already use —
 * and posts NO reply at all. The verdict does not come back through this protocol: it lands in
 * `progress.json`, comes round on the session's next push as `StepViewState.check`, and is
 * DRAWN, in full, by `./step-view.ts` (AC5). Whoever adds a reply here again should first ask
 * what it would say that the report on the page does not.
 *
 * `dial:set` and `skin:set` both persist and update local state but post NO reply, mirroring
 * `src/start/protocol.ts`'s own `skin:set` exactly: the client already reflects the
 * radio/picker it was just clicked on, instantly: the host's only job is to remember the
 * choice for the NEXT render (a hide/show, or a reopened window).
 *
 * **`reproduce:run` routes and does not second-guess.** `plan.reproduce` names the generated,
 * vendored and lockfile files that are never taught (AC6) — the panel offers to copy them
 * from the reference once, with the count, and this message is that offer being taken. The
 * handler does NOT check `state.reproduce` before calling the effect, deliberately: the
 * panel's snapshot can be one push out of date, the session cannot, and "is there anything
 * left to copy" is the session's question to answer — exactly as `goTo` hands over an id the
 * session is free to reject. The session's own `reproduce()` is therefore required to be
 * idempotent; a second press must be a no-op there, not a second copy.
 *
 * NOTHING reaches `handleStepMessage` without going through `parseStepMessage` first (the
 * same `src/start/protocol.ts` `parseInboundMessage` discipline, T-3 rework, review finding
 * 3): a webview's `postMessage` is untyped at run time, so the panel parses first and drops
 * anything that does not match rather than letting a malformed payload throw inside a
 * `void`-ed promise where nothing is listening for the rejection.
 */

import type { CheckOutcome } from '../dial/check.js';
import { DIALS, type Dial } from '../start/request.js';
import type { AskMessage } from '../tutor/core.js';
import { nextStepId, prevStepId, type PlanLike, type Progress, type StepLike } from './model.js';

/**
 * The longest question this panel will hand the tutor, in characters (T-6 AC2).
 *
 * It lives HERE rather than in `./step-view.ts` because it is a rule about what the host
 * accepts, not about what the page draws: `./step-view.ts` puts it on the textarea as a
 * `maxlength` so the browser stops a learner at the cap, and `handleStepMessage` below
 * enforces it again for the message that arrives anyway — a webview's `postMessage` is
 * untyped at run time and a `maxlength` is a courtesy to a person, never a guarantee about a
 * value. Both readings matter, because what gets past here is APPENDED TO `progress.json`
 * and then sent to a model that bills by the token: an unbounded string from the page would
 * be an unbounded file on the learner's disk and an unbounded bill.
 *
 * 4,000 is repo-tour's own order of magnitude for one turn and is far past any real question
 * about one tutorial step — the longest `why` in the real 61-step plan is 279 characters, and
 * a learner pasting their whole file into the box is asking the wrong question anyway, since
 * the diff of their file against the author's is already in the context (`src/tutor/
 * context.ts`). It is a cap on the LEARNER'S MONEY as much as on this panel's work, which is
 * why going over it is ANSWERED rather than silently dropped; see `handleStepMessage`.
 */
export const MAX_ASK_TEXT = 4000;

/** What the panel says when *Ask* is pressed with nothing in the box. Exported for the same
 *  reason every other visible string in this design is: one home, asserted rather than
 *  copied. A blank press is an ordinary slip — a stray Enter — and the honest answer is a
 *  sentence, not a control that quietly does nothing (conventions.md). */
export const NOTHING_TO_ASK_MESSAGE = 'There is nothing to ask yet — type a question first.';

/** The same, for a question past `MAX_ASK_TEXT`. The COUNT is in it, the way every other cap
 *  on this surface announces itself, so the learner can tell how much to cut rather than
 *  guessing at a limit the page never named. */
export function askTooLongMessage(length: number): string {
  return `That question is ${length} characters long and the tutor takes at most ${MAX_ASK_TEXT}. Nothing was sent — shorten it and ask again.`;
}

export interface StepViewState {
  plan: PlanLike;
  progress: Progress;
  /** the CURRENT step, already resolved — `renderStepHtml` never has to re-derive it. */
  step: StepLike;
  /** whether `<target>/<step.target.file>` exists yet (manual mode, nothing written yet). */
  fileExists: boolean;
  /**
   * The dial that actually applies to this step, ALREADY RESOLVED by the session: the step's
   * own override, else the global one from `request.json`, else `manual` (`model.ts`'s
   * `stepDial`). This is AC1's "global, and overridable per step", and it is resolved
   * upstream rather than here on purpose — T-4's panel re-derived it from
   * `progress.steps[step.id].dial` alone and so could only ever show the override half, which
   * meant a learner who set the dial on the START SCREEN saw "manual" checked on every step
   * they had not touched. Two places deciding what mode you are in is one place too many.
   */
  dial: Dial;
  /**
   * MANUAL mode only (AC2): the shape of the file the learner is about to write, read off the
   * reference by `src/dial/writer.ts`'s `fileShape` — the signature line of each load-bearing
   * range and the reference's own import lines. Absent in every other mode, and absent for a
   * step that has no file shape to show, which is what makes its PRESENCE the gate the view
   * renders on: manual mode is the one position where the extension writes nothing, so it is
   * the one position where the panel owes the learner a description of what to type.
   */
  shape?: { signatures: string[]; imports: string[] };
  /**
   * The last structural check, as `src/dial/check.ts` produced it — `undefined` means nobody
   * has pressed *Check my work* on this step yet, which the page must show differently from a
   * check that ran and found nothing wrong. Pushed by the session out of the same run that
   * writes `progress.steps[id].check`, so the panel and the tree cannot disagree about it.
   */
  check?: CheckOutcome;
  /**
   * What the dial just did to the learner's file, in their words: refused to overwrite, kept
   * theirs, wrote over it. Transient — the session sets it on the push that follows a write
   * and it is not in `progress.json` — but SERVER-rendered, unlike `note` below, because it is
   * the session's news and not the panel's, and because it must survive the panel's own
   * repaint decision (see `step-panel.ts`'s key).
   */
  writeNote?: string;
  /**
   * `plan.reproduce`'s never-taught files: how many there are, and whether they have already
   * been copied into the target. The offer is worth making exactly once — `done` is what turns
   * it off, and `progress.reproduced` is where that survives a reload.
   */
  reproduce?: { count: number; done: boolean };
  /**
   * T-6 (AC2): this STEP's conversation with the tutor, oldest turn first — every turn, as
   * `src/tutor/transcript.ts` sanitised it off `progress.steps[id].transcript`.
   *
   * Required rather than optional, unlike everything else the session sends: a step nobody
   * has asked about has an EMPTY conversation, which is a real and renderable state, while
   * `undefined` would be a second way of spelling the same thing and would then have to be
   * handled everywhere the array is. It arrives already validated — the session reads it only
   * through `getTranscript`, which is the enforcement point for a file on the learner's own
   * disk that anything could have written — so this array is exactly `AskMessage[]` and the
   * view may render it without re-checking each turn's shape.
   */
  transcript: AskMessage[];
  /**
   * T-6 (AC4): what the tutor is DOING, as opposed to what it has said.
   *
   * Declared inline rather than imported from `./session.js`'s `TutorView`, exactly as
   * `shape` is declared inline against `writer.ts`'s `FileShape`: this file is the pure
   * protocol and the panel builds its state by spreading a `WalkView`, so the two shapes are
   * structurally checked against each other on every push and a drift cannot compile.
   *
   *   - `thinking` — an ask is in flight FOR THIS STEP. It is what draws "thinking…" and the
   *     *Cancel* beside it, and it is `false` in every other case including a failed one.
   *     **Nothing may leave this `true` without a live ask behind it**: AC4 in one sentence is
   *     that no spinner is ever left running, and the session clears the ask before it decides
   *     what to say about it, so even an outcome nobody anticipated ends with the spinner off.
   *   - `unreachable` — the provider's OWN sentence about why it cannot be run here ("not
   *     found on PATH"), carried verbatim rather than replaced by a house phrasing that says
   *     less. Drawn where the input is, and it outlives one ask: a provider that is not
   *     installed is not installed for the rest of the session.
   *   - `note` — a sentence ABOUT the conversation that is not a turn IN it: unreachable,
   *     timed out, failed, cancelled. Kept out of `transcript` on purpose (`AskMessage` stays
   *     pure) so a model's failure is never stored as something the tutor said.
   *   - `stage` — WHICH half of the wait `thinking` is about. `preparing` is the availability
   *     probe and the diff, during which nothing has been sent and nothing is charged;
   *     `sending` is a request with a provider that is billing right now. Derived from the
   *     same field `thinking` is, so the two cannot disagree.
   *   - `elsewhere` — a live ask on a DIFFERENT step, so the page can offer to stop it from
   *     wherever the learner is standing rather than pointing at a *Cancel* on a page they
   *     have left (code review finding 3).
   *   - `spend` — what this walk has spent and what is spending right now, off
   *     `AskLedger.spend()`. `metered: false` means the figures are UNKNOWN, never free, and
   *     the page may not render them as a total (code review finding 5).
   *   - `accepted` — the question the host really sent, which is how the page knows its draft
   *     became a turn. The page keeps the learner's text until this says otherwise, so a
   *     refusal decided after the press leaves the question where they typed it (findings 1
   *     and 2).
   */
  tutor?: {
    thinking: boolean;
    unreachable?: string;
    note?: string;
    stage?: 'preparing' | 'sending';
    elsewhere?: { stepId: string; stage: 'preparing' | 'sending' };
    spend?: {
      preparing: number;
      sending: number;
      unwatched: number;
      replies: number;
      inputTokens: number;
      outputTokens: number;
      usd: number;
      metered: boolean;
    };
    accepted?: string;
  };
  /** the resolved skin name (never empty — see `src/skins.ts` `readSkin`). */
  skin: string;
  /**
   * The panel's own transient reply line, round-tripped through the webview's `setState`
   * (AC5) — the PANEL's, not the session's, and not persisted anywhere.
   *
   * **T-6 gave this channel its producer back, and the reason is the reason it was kept.**
   * `step:check`'s placeholder reply was its only producer until T-5 replaced it with the real
   * check, leaving a channel with nothing driving it — and its clearing-on-navigation
   * (`step-panel.ts`'s `setView`) therefore unreachable and untested. What refills it is
   * `tutor:ask` REFUSING to send: an empty box, or a question past `MAX_ASK_TEXT`. Those two
   * answers are exactly the shape this channel exists for, because they are the only sentences
   * on this page that must arrive WITHOUT a repaint. `step-panel.ts` keys repaints on what the
   * page draws, this node is written by the client script itself, and a repaint would tear the
   * iframe down and take the learner's half-typed question with it — telling somebody their
   * question is too long by deleting it is not an answer, it is a second failure. Every OTHER
   * tutor sentence is `tutor.note` above: those arrive with a repaint anyway, because the
   * transcript or the thinking state changed with them.
   *
   * See `writeNote` for the session-owned, server-rendered counterpart.
   */
  note?: string;
}

export type InboundMessage =
  | { type: 'step:next' }
  | { type: 'step:prev' }
  | { type: 'step:open' }
  | { type: 'step:check' }
  | { type: 'reproduce:run' }
  | { type: 'dial:set'; payload: { dial: Dial } }
  | { type: 'skin:set'; payload: { skin: string } }
  | { type: 'tutor:ask'; payload: { text: string } }
  | { type: 'tutor:cancel' }
  | { type: 'tutor:clear' };

export type OutboundMessage = { type: 'step:note'; payload: { note: string } };

export interface StepEffects {
  /** Navigates the WHOLE session (persists, refreshes the tree, reveals the editor, updates
   *  the status bar) — the same effect the decision tree's own click handler drives. */
  goTo(stepId: string): void;
  /** Brings the target file into focus, real editor tab. A no-op call is never made: the view
   *  layer disables this button entirely when `!fileExists` (honest controls). */
  openFile(): void;
  /**
   * *Check my work* (AC5). Runs the core's structural check against the learner's file,
   * records the verdict in `progress.json`, and refreshes — so the answer arrives back here as
   * `StepViewState.check` on the next push rather than as a reply to this message. `void`
   * rather than a promise for the same reason `goTo` is: this handler is called from a webview
   * message listener, where a rejected promise has nobody listening for it, so the session
   * owns the await and routes a failure to its own `reportError` channel.
   */
  runCheck(): void;
  /**
   * Copy `plan.reproduce`'s never-taught files from the reference into the target (AC6).
   * Required to be IDEMPOTENT — see the file header on why this protocol routes the message
   * rather than deciding for itself whether there is anything left to copy.
   */
  reproduce(): void;
  persistDial(stepId: string, dial: Dial): void;
  persistSkin(name: string): void;

  // ── T-6: the tutor ────────────────────────────────────────────────────────────────────

  /**
   * Send one question to the tutor (AC2, AC3). `void` for the same reason `runCheck` is, and
   * here it matters more than anywhere else on this surface: an ask waits on a MODEL, for as
   * long as `buildTutorials.tutorTimeoutSeconds` allows, and this method is called from a
   * webview message listener where a rejected promise has nobody listening for it. The
   * session owns the whole asynchronous life of the ask and reports every failure through its
   * own `reportError` channel; the answer comes back the way every other change does, as a
   * fresh `WalkView`.
   *
   * The `text` handed over has already been trimmed and length-checked here (see
   * `handleStepMessage`), so a session may append it to `progress.json` without re-deciding
   * whether it is a question at all.
   */
  ask(text: string): void;
  /**
   * Stop waiting for the ask in flight (AC4). It does NOT kill the model — repo-tour's
   * `killLlmChildren` kills every live child, so cancelling a tutor question while a build ran
   * in the background would kill the build (`src/tutor/ask.ts` argues it in full). It detaches
   * delivery: the panel leaves the thinking state at once and the answer, whenever it arrives,
   * has nowhere to land. The session says what that means out loud, including that the request
   * is still costing money.
   */
  cancelAsk(): void;
  /**
   * Forget this step's conversation (code review finding 6).
   *
   * `clearTranscript` shipped exported, with six unit tests and no caller in `src/` — the
   * capability was built and never wired to anything a learner could press. It is wired rather
   * than deleted because a stored conversation owes somebody a way to delete it: `progress.
   * json` holds their questions and a model's answers, on their own disk, in a folder this
   * extension `git init`s for them.
   *
   * Routed and not second-guessed, exactly like `reproduce:run`: whether there is anything to
   * forget is the session's question, and a panel one push out of date must not be the thing
   * that decides. The session answers a press on an empty conversation with a sentence rather
   * than with silence.
   */
  clearConversation(): void;
}

export interface HandleResult {
  state: StepViewState;
  post?: OutboundMessage;
}

export function handleStepMessage(state: StepViewState, message: InboundMessage, effects: StepEffects): HandleResult {
  switch (message.type) {
    case 'step:next': {
      const id = nextStepId(state.plan, state.progress);
      if (id) effects.goTo(id);
      return { state };
    }
    case 'step:prev': {
      const id = prevStepId(state.plan, state.progress);
      if (id) effects.goTo(id);
      return { state };
    }
    case 'step:open': {
      effects.openFile();
      return { state };
    }
    case 'step:check': {
      // No state change and no reply, deliberately — see the file header. The verdict comes
      // back through the session's own push, as `check`, and is drawn on the page.
      effects.runCheck();
      return { state };
    }
    case 'reproduce:run': {
      effects.reproduce();
      return { state };
    }
    case 'dial:set': {
      effects.persistDial(state.step.id, message.payload.dial);
      return { state };
    }
    case 'skin:set': {
      effects.persistSkin(message.payload.skin);
      return { state: { ...state, skin: message.payload.skin } };
    }
    case 'tutor:ask': {
      /*
       * The two refusals, decided HERE and answered through `note` — the one channel that
       * reaches the page without a repaint (see `StepViewState.note`).
       *
       * Both are about a question that must not be SENT, which is why they are the protocol's
       * business rather than the session's: nothing has been asked, nothing is in flight, and
       * there is no state for a session to own. Answering them here also means the learner's
       * text survives — `step-panel.ts` repaints when the page would change, a repaint tears
       * the iframe down, and a page that deleted somebody's too-long question while telling
       * them it was too long would have made the problem worse.
       *
       * Trimmed before both checks and before the effect, so trailing whitespace can neither
       * make a blank press look like a question nor push a question one character over the
       * cap. The length reported is the trimmed one, for the same reason: it is the number the
       * learner has to get under.
       */
      const text = message.payload.text.trim();
      if (text.length === 0) {
        return { state: { ...state, note: NOTHING_TO_ASK_MESSAGE }, post: { type: 'step:note', payload: { note: NOTHING_TO_ASK_MESSAGE } } };
      }
      if (text.length > MAX_ASK_TEXT) {
        const note = askTooLongMessage(text.length);
        return { state: { ...state, note }, post: { type: 'step:note', payload: { note } } };
      }
      // The previous refusal is cleared on a press that really does send: leaving "there is
      // nothing to ask yet" under a question the tutor is at that moment answering would be a
      // stale sentence stated confidently, which is the failure this whole panel is careful
      // about. `undefined` rather than `''` so `step-panel.ts`'s own `note` field goes back to
      // meaning "there is nothing to say".
      effects.ask(text);
      return { state: { ...state, note: undefined }, post: { type: 'step:note', payload: { note: '' } } };
    }
    case 'tutor:cancel': {
      effects.cancelAsk();
      return { state };
    }
    case 'tutor:clear': {
      // No reply and no state change here: what the conversation now is comes back on the
      // session's own push, as `transcript`, and is DRAWN — the same routing `step:check` uses
      // and for the same reason. A sentence composed here would be this file guessing at an
      // outcome the session has not decided yet.
      effects.clearConversation();
      return { state };
    }
    default: {
      const exhaustive: never = message;
      throw new Error(`unhandled step message: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ── validating what actually arrives from the webview (mirrors src/start/protocol.ts) ──────

const INBOUND_TYPES = [
  'step:next', 'step:prev', 'step:open', 'step:check', 'reproduce:run', 'dial:set', 'skin:set',
  'tutor:ask', 'tutor:cancel', 'tutor:clear',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInboundType(value: unknown): value is InboundMessage['type'] {
  return typeof value === 'string' && (INBOUND_TYPES as readonly string[]).includes(value);
}

/**
 * `null` for anything whose `type` is not one this panel knows, or whose payload is not
 * exactly the shape that type promises — a reviewer's null-payload / wrong-type-field probe
 * (T-3 rework, review finding 3) is exactly what this exists to survive. `dial` is checked
 * against `DIALS` itself, so a fourth dial position needs no edit here.
 *
 * `reproduce:run` joins the four other no-payload messages rather than growing a payload of
 * its own (a count, say, or a list of files). It has nothing to carry: WHICH files are copied
 * is `plan.reproduce`'s answer and the session reads it from the plan, so a payload here would
 * be a number the webview supplied about work the host is about to do on disk — the one shape
 * of message this file exists to refuse.
 *
 * **`tutor:ask` is checked for SHAPE here and for CONTENT in `handleStepMessage`, and the
 * split is deliberate.** A `text` that is not a string is a message this panel does not speak
 * and is dropped; a `text` that is empty or longer than `MAX_ASK_TEXT` is a message it speaks
 * perfectly well and must ANSWER, because a dropped message here is silent — the panel logs
 * one line to the output channel and the learner watches a button do nothing. That is the
 * exact failure mode this codebase tests for everywhere else, and it would be worst on the
 * one control that has just eaten a question somebody spent a minute writing.
 */
export function parseStepMessage(raw: unknown): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const type: unknown = raw['type'];
  if (!isInboundType(type)) return null;

  switch (type) {
    case 'step:next':
    case 'step:prev':
    case 'step:open':
    case 'step:check':
    case 'reproduce:run':
    case 'tutor:cancel':
    case 'tutor:clear':
      return { type };
    case 'dial:set': {
      const payload = raw['payload'];
      if (!isRecord(payload)) return null;
      const dial = payload['dial'];
      if (typeof dial !== 'string' || !(DIALS as readonly string[]).includes(dial)) return null;
      return { type, payload: { dial: dial as Dial } };
    }
    case 'skin:set': {
      const payload = raw['payload'];
      if (!isRecord(payload) || typeof payload['skin'] !== 'string') return null;
      return { type, payload: { skin: payload['skin'] } };
    }
    case 'tutor:ask': {
      const payload = raw['payload'];
      if (!isRecord(payload) || typeof payload['text'] !== 'string') return null;
      return { type, payload: { text: payload['text'] } };
    }
  }
}
