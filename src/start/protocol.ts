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
 * `form:changed` replies `form:problems` — "the message is shown under the field, where the eye
 * is, never a silent disable" (repo-tour lesson, T-3, 2026-08-26; plan step 5). **`form:submit`
 * used to share that reply and no longer does (T-15).** It was the right message for a keystroke
 * and the wrong one for a press: the page validates on every `change`, so those lines were
 * already on screen, and re-sending them meant a press produced no observable difference at all.
 * A press now gets `form:rejected`, `form:accepted` or `form:busy`, and each one changes what
 * the page SAYS. A refused press repeated with nothing edited between carries `inARow`, so the
 * second refusal's words differ from the first's (review finding 3: the September fix moved an
 * invisible `data-press` attribute instead, and a person pressing twice saw nothing change). A
 * press that reaches the host while a build is running starts nothing (a double-click used to start
 * two builds). A folder pick additionally has to tell the webview the path it
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
  /**
   * A build is in flight (T-15 review findings 2 and 5).
   *
   * It lives HERE rather than only in the page because the panel re-renders from this state on
   * `onDidChangeViewState`, and a flag the page owns alone is a flag a tab switch silently
   * discards — `panel.ts`'s own doc says the host "NEVER trusts the view's own memory", and a
   * disabled button that only the DOM remembers is exactly that. It is also what lets a finished
   * build re-enable the button: the first version disabled it on submit and nothing anywhere
   * ever undid that, so a FAILED build left the screen reading "Building…" for ever.
   */
  building: boolean;
  /**
   * How many presses in a row were refused with nothing edited between them (T-15, review finding
   * 3). Every edit and every folder pick resets it, because after an edit the note has already been
   * cleared and the next refusal is a change on its own. Without it a second identical refusal
   * replies with identical words — the defect again, one press later.
   */
  refusedInARow: number;
  /**
   * How the last build ended, until the next edit or press (code review finding 4). Without it a
   * re-render — every tab switch re-renders, since the page is not kept while hidden — wiped the
   * note, and a screen whose build had been built or cancelled became byte-identical to one never
   * pressed.
   */
  ended?: BuildEnding;
}

/** How a build that the start screen started came to an end — what its note says afterwards. */
export type BuildEnding = 'built' | 'failed' | 'cancelled';

export type PickTarget = 'repo' | 'target';

export type InboundMessage =
  | { type: 'form:changed'; payload: { request: BuildRequest } }
  | { type: 'form:submit'; payload: { request: BuildRequest } }
  | { type: 'pick:repo' }
  | { type: 'pick:target' }
  | { type: 'skin:set'; payload: { skin: string } };

export type OutboundMessage =
  | { type: 'form:problems'; payload: { problems: ValidationResult['problems'] } }
  // T-15. A PRESS gets its own two replies, and they exist because `form:problems` could not
  // serve as one: the page validates on every `change`, so the problem lines are already on
  // screen before the button is touched. Replying `form:problems` to a rejected press therefore
  // re-sent bytes the page was already showing, and the press was indistinguishable from being
  // ignored. What was missing was never information — it was a DIFFERENCE.
  | { type: 'form:rejected'; payload: { problems: ValidationResult['problems']; count: number; inARow: number } }
  | { type: 'form:accepted' }
  // A press that reached the host while a build was already running. The button is disabled by
  // then on the page, but only after a round trip: two clicks in one instant both arrive, and
  // until this existed the second one started a second build of the same target.
  | { type: 'form:busy' }
  // The other half of `form:accepted`, and the reason it is a pair rather than a one-way flip:
  // every build ends, including the ones that fail and the ones the learner cancels, and the
  // button has to come back — and the note says how it ended, because a button that silently
  // re-enables after a failure looks exactly like one that was never pressed.
  // Posted by `StartPanel.buildFinished` from `reportOutcome`.
  | { type: 'form:idle'; payload: { ended: BuildEnding } }
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
    case 'form:changed': {
      const { problems } = validateRequest(message.payload.request);
      const next: PanelState = { ...state, request: message.payload.request, problems, refusedInARow: 0, ended: undefined };
      return { state: next, post: { type: 'form:problems', payload: { problems } } };
    }
    // T-15: split from `form:changed`, which it used to share a case with. The old shared
    // `return` was the whole defect — a rejected press replied with the identical message a
    // keystroke had already sent, so nothing on the page moved. Both arms below now say
    // something the page was NOT already saying.
    case 'form:submit': {
      // Before anything else, and before validating: a build is running, so this press must not
      // start another one — whatever the form says now. The page has disabled the button by the
      // time a person can see it, but a double-click lands both clicks before that reply arrives.
      if (state.building) return { state, post: { type: 'form:busy' } };
      const { ok, problems } = validateRequest(message.payload.request);
      const next: PanelState = { ...state, request: message.payload.request, problems, refusedInARow: 0, ended: undefined };
      if (ok) {
        effects.submit(message.payload.request);
        next.building = true;
        // Said BEFORE the build's own progress notification, and on the surface the eye is
        // actually on. `runBuild` awaits a `workspaceState.update` and only then raises a
        // notification in the corner — so without this the START SCREEN is unchanged on an
        // accepted press too. That case is the worse one: there are no problem lines to
        // misread as a response, and a slow accepted submit looks exactly like a dead button.
        return { state: next, post: { type: 'form:accepted' } };
      }
      next.refusedInARow = state.refusedInARow + 1;
      return {
        state: next,
        post: {
          type: 'form:rejected',
          payload: { problems, count: Object.values(problems).filter(Boolean).length, inARow: next.refusedInARow },
        },
      };
    }
    case 'pick:repo':
    case 'pick:target': {
      const field: PickTarget = message.type === 'pick:repo' ? 'repo' : 'target';
      const picked = await effects.pickFolder(field);
      if (picked === undefined) return { state }; // cancelled — nothing changed
      const request: BuildRequest = { ...state.request, [field]: picked };
      const { problems } = validateRequest(request);
      return { state: { ...state, request, problems, refusedInARow: 0, ended: undefined }, post: { type: 'field:set', payload: { field, value: picked, problems } } };
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
