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
 * NOTHING reaches `handleStartMessage` without going through `parseInboundMessage` first
 * (T-3 rework, review finding 3). A webview's `postMessage` is untyped at run time — the
 * `InboundMessage` annotation on the listener was a compile-time promise about a value that
 * arrives from outside the compiler's reach — so the panel parses first and drops anything
 * that does not match, rather than letting a malformed payload throw inside a `void`-ed
 * promise where nothing is listening for the rejection.
 *
 * `form:submit` and `form:changed` both reply with `form:problems` — "the message is shown
 * under the field, where the eye is, never a silent disable" (repo-tour lesson, T-3,
 * 2026-08-26; plan step 5). A folder pick additionally has to tell the webview the path it
 * chose, so it replies `field:set` (value + the same problems, recomputed). `skin:set` gets
 * no reply: the client already applied the skin instantly (see `src/start/panel.ts`'s client
 * script) for zero flash; the host's only job there is to persist the choice.
 */

import { DIALS, validateRequest, type BuildRequest, type Dial, type ValidationResult } from './request.js';

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

// ── validating what actually arrives from the webview (T-3 rework, review finding 3) ───────

const INBOUND_TYPES = ['form:changed', 'form:submit', 'pick:repo', 'pick:target', 'skin:set'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInboundType(value: unknown): value is InboundMessage['type'] {
  return typeof value === 'string' && (INBOUND_TYPES as readonly string[]).includes(value);
}

/**
 * A `BuildRequest` with every field present and of the right type — `dial` in particular
 * checked against `DIALS` itself, so a fourth dial position added to `request.ts` needs no
 * edit here. Returns a FRESH object carrying exactly the five known fields: whatever else
 * the sender put in the payload never reaches `validateRequest`, `plan.json`'s neighbouring
 * `request.json`, or the panel's own state.
 */
function parseRequest(value: unknown): BuildRequest | null {
  if (!isRecord(value)) return null;
  const { idea, recreate, repo, target, dial } = value;
  if (typeof idea !== 'string' || typeof repo !== 'string' || typeof target !== 'string') return null;
  if (typeof recreate !== 'boolean') return null;
  if (typeof dial !== 'string' || !(DIALS as readonly string[]).includes(dial)) return null;
  return { idea, recreate, repo, target, dial: dial as Dial };
}

/**
 * The one gate between a real `webview.onDidReceiveMessage` and `handleStartMessage`: `null`
 * for anything whose `type` is not one this screen knows or whose payload is not exactly the
 * shape that type promises. Never throws — a caller that cannot trust its input cannot be
 * asked to catch, either (see `src/start/panel.ts`, which ignores and logs a `null`).
 *
 * `handleStartMessage` keeps its typed signature and its exhaustive `default` branch: with
 * this in front of it, that branch is genuinely unreachable rather than a runtime guard.
 */
export function parseInboundMessage(raw: unknown): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const type: unknown = raw['type'];
  if (!isInboundType(type)) return null;

  switch (type) {
    case 'form:changed':
    case 'form:submit': {
      const payload = raw['payload'];
      if (!isRecord(payload)) return null;
      const request = parseRequest(payload['request']);
      return request ? { type, payload: { request } } : null;
    }
    case 'pick:repo':
    case 'pick:target':
      // No payload in the type at all, and none is read: the chosen path always comes from
      // `showOpenDialog`'s own result, never from the message (the client does send `{}`).
      return { type };
    case 'skin:set': {
      const payload = raw['payload'];
      if (!isRecord(payload) || typeof payload['skin'] !== 'string') return null;
      return { type, payload: { skin: payload['skin'] } };
    }
  }
}
