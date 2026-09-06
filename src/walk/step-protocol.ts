// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The step panel's message protocol (spec §5.3; locate T-4: `step:next`, `step:prev`,
 * `step:open`, `step:check`, `dial:set`, `skin:set`; T-5 adds `reproduce:run`) — pure data and
 * a pure handler, deliberately separate from `src/walk/step-panel.ts`'s real
 * `vscode.WebviewView`, exactly the split `src/start/protocol.ts` established for the start
 * screen.
 *
 * `handleStepMessage` never imports `vscode`: navigating to a step, opening the target file,
 * running the structural check, copying the never-taught files and persisting the dial/skin
 * are all `StepEffects` the real adapter (`WalkSession`) injects, so this file — every message
 * type, every reply — is testable with fake effects and no webview, no extension host, at all.
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
import { nextStepId, prevStepId, type PlanLike, type Progress, type StepLike } from './model.js';

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
  /** the resolved skin name (never empty — see `src/skins.ts` `readSkin`). */
  skin: string;
  /**
   * The panel's own transient reply line, round-tripped through the webview's `setState`
   * (AC5) — the PANEL's, not the session's, and not persisted anywhere.
   *
   * No message in this protocol produces one today: `step:check`'s placeholder reply was the
   * only producer and T-5 replaced it with the real check, whose verdict is rendered from
   * `check` above instead. The channel is kept rather than removed because it is the one way
   * the host can put a sentence on the page WITHOUT a repaint — `step-panel.ts` keys repaints
   * on what the page draws, and this node is updated by the client script itself — which is
   * exactly what T-6's tutor needs for a reply that arrives while the learner is typing. See
   * `writeNote` for the session-owned, server-rendered counterpart.
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
  | { type: 'skin:set'; payload: { skin: string } };

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
    default: {
      const exhaustive: never = message;
      throw new Error(`unhandled step message: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ── validating what actually arrives from the webview (mirrors src/start/protocol.ts) ──────

const INBOUND_TYPES = [
  'step:next', 'step:prev', 'step:open', 'step:check', 'reproduce:run', 'dial:set', 'skin:set',
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
  }
}
