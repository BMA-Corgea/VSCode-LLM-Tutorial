// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The step panel's message protocol (spec §5.3; locate T-4: `step:next`, `step:prev`,
 * `step:open`, `step:check`, `dial:set`, `skin:set`) — pure data and a pure handler,
 * deliberately separate from `src/walk/step-panel.ts`'s real `vscode.WebviewView`, exactly
 * the split `src/start/protocol.ts` established for the start screen.
 *
 * `handleStepMessage` never imports `vscode`: navigating to a step, opening the target file,
 * and persisting the dial/skin are all `StepEffects` the real adapter (`WalkSession`) injects,
 * so this file — every message type, every reply — is testable with fake effects and no
 * webview, no extension host, at all.
 *
 * `step:check` is the honest control the ticket asks for by name: it replies `step:note` with
 * the literal sentence "Check my work arrives with T-5" — never a silent no-op, never a
 * fabricated pass. `dial:set` and `skin:set` both persist and update local state but post NO
 * reply, mirroring `src/start/protocol.ts`'s own `skin:set` exactly: the client already
 * reflects the radio/picker it was just clicked on, instantly: the host's only job is to
 * remember the choice for the NEXT render (a hide/show, or a reopened window).
 *
 * NOTHING reaches `handleStepMessage` without going through `parseStepMessage` first (the
 * same `src/start/protocol.ts` `parseInboundMessage` discipline, T-3 rework, review finding
 * 3): a webview's `postMessage` is untyped at run time, so the panel parses first and drops
 * anything that does not match rather than letting a malformed payload throw inside a
 * `void`-ed promise where nothing is listening for the rejection.
 */

import { DIALS, type Dial } from '../start/request.js';
import { nextStepId, prevStepId, type PlanLike, type Progress, type StepLike } from './model.js';

/** Verbatim — the honest reply AC5/the refinement notes name. `Check my work` and the dial's
 *  actual effect both arrive with T-5; this ticket only shows them, truthfully. */
export const CHECK_NOTE = 'Check my work arrives with T-5';

export interface StepViewState {
  plan: PlanLike;
  progress: Progress;
  /** the CURRENT step, already resolved — `renderStepHtml` never has to re-derive it. */
  step: StepLike;
  /** whether `<target>/<step.target.file>` exists yet (manual mode, nothing written yet). */
  fileExists: boolean;
  /** the resolved skin name (never empty — see `src/skins.ts` `readSkin`). */
  skin: string;
  /** the panel's own transient reply line (`step:check`'s honesty note) — never persisted;
   *  cleared by the adapter whenever the CURRENT STEP actually changes. */
  note?: string;
}

export type InboundMessage =
  | { type: 'step:next' }
  | { type: 'step:prev' }
  | { type: 'step:open' }
  | { type: 'step:check' }
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
      return { state: { ...state, note: CHECK_NOTE }, post: { type: 'step:note', payload: { note: CHECK_NOTE } } };
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

const INBOUND_TYPES = ['step:next', 'step:prev', 'step:open', 'step:check', 'dial:set', 'skin:set'] as const;

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
