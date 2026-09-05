// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The start screen's message protocol (spec §5.2; locate T-3: `form:changed`, `form:submit`,
 * `pick:repo`, `pick:target`, `skin:set`) — as PURE data and a pure handler, deliberately
 * separate from `src/start/panel.ts`'s real `vscode.WebviewPanel`.
 *
 * `handleStartMessage` never imports `vscode`: every side effect it needs (opening a native
 * folder picker, persisting the skin choice, actually starting a build) comes in through
 * `StartEffects`, so a test can drive the ENTIRE protocol — every message type, every
 * validation rule's effect on the reply — by calling this function with fake effects and no
 * webview at all. `panel.ts` is then a thin adapter: `webview.onDidReceiveMessage` calls
 * this, and posts back whatever it returns.
 *
 * `form:submit` and `form:changed` both reply with `form:problems` — "the message is shown
 * under the field, where the eye is, never a silent disable" (repo-tour lesson, T-3,
 * 2026-08-26; plan step 5). A folder pick additionally has to tell the webview the path it
 * chose, so it replies `field:set` (value + the same problems, recomputed). `skin:set` gets
 * no reply: the client already applied the skin instantly (see `src/start/panel.ts`'s client
 * script) for zero flash; the host's only job there is to persist the choice.
 */

import { validateRequest, type BuildRequest, type ValidationResult } from './request.js';

export interface PanelState {
  request: BuildRequest;
  problems: ValidationResult['problems'];
  /** the resolved skin name (never empty — defaults to repo-tour's own DEFAULT_SKIN). */
  skin: string;
}

export type PickTarget = 'repo' | 'target';

export type InboundMessage =
  | { type: 'form:changed'; payload: { request: BuildRequest } }
  | { type: 'form:submit'; payload: { request: BuildRequest } }
  | { type: 'pick:repo' }
  | { type: 'pick:target' }
  | { type: 'skin:set'; payload: { skin: string } };

export type OutboundMessage =
  | { type: 'form:problems'; payload: { problems: ValidationResult['problems'] } }
  | { type: 'field:set'; payload: { field: PickTarget; value: string; problems: ValidationResult['problems'] } };

export interface StartEffects {
  /** Wraps `vscode.window.showOpenDialog` (folders only). `undefined` = the user cancelled. */
  pickFolder(which: PickTarget): Promise<string | undefined>;
  /** Kicks off the real build. Fire-and-forget from the protocol's own point of view. */
  submit(request: BuildRequest): void;
  /** Persists the skin choice (globalState) — never re-renders; the client already applied it. */
  persistSkin(name: string): void;
}

export interface HandleResult {
  state: PanelState;
  post?: OutboundMessage;
}

export async function handleStartMessage(
  state: PanelState,
  message: InboundMessage,
  effects: StartEffects,
): Promise<HandleResult> {
  switch (message.type) {
    case 'form:changed':
    case 'form:submit': {
      const { ok, problems } = validateRequest(message.payload.request);
      const next: PanelState = { ...state, request: message.payload.request, problems };
      if (message.type === 'form:submit' && ok) effects.submit(message.payload.request);
      return { state: next, post: { type: 'form:problems', payload: { problems } } };
    }
    case 'pick:repo':
    case 'pick:target': {
      const field: PickTarget = message.type === 'pick:repo' ? 'repo' : 'target';
      const picked = await effects.pickFolder(field);
      if (picked === undefined) return { state }; // cancelled — nothing changed
      const request: BuildRequest = { ...state.request, [field]: picked };
      const { problems } = validateRequest(request);
      return { state: { ...state, request, problems }, post: { type: 'field:set', payload: { field, value: picked, problems } } };
    }
    case 'skin:set': {
      effects.persistSkin(message.payload.skin);
      return { state: { ...state, skin: message.payload.skin } };
    }
    default: {
      const exhaustive: never = message;
      throw new Error(`unhandled start-screen message: ${JSON.stringify(exhaustive)}`);
    }
  }
}
