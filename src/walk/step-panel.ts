// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * StepViewProvider — the webview VIEW inside the `buildTutorials` activity-bar container that
 * shows the step the learner is standing on (spec §5.3; AC2 is what it renders, AC5 is what
 * it must survive).
 *
 * A thin adapter, on purpose, exactly like `src/start/panel.ts`: every real decision — what a
 * message means, what the reply should be, what the markup looks like — lives in
 * `./step-protocol.js` and `./step-view.js`, neither of which imports `vscode`, so both are
 * unit-testable under plain mocha with no extension host. This file is only where those pure
 * pieces meet a real `vscode.WebviewView`.
 *
 * **The one shape that differs from the start screen: where state comes from.** `StartPanel`
 * owns its `PanelState` outright — it is the only thing that ever changes it. This provider
 * does not: `WalkSession` is the walk's single truth (see `./session.ts`), and it pushes a
 * `WalkView` here through `setView`, which `src/extension.ts` wires as
 * `WalkAdapters.setPanel`. So the state this panel renders is assembled, per push, out of two
 * halves: the session's four fields (`plan`, `progress`, `step`, `fileExists`) and this
 * panel's own two.
 *
 * **Those two fields — `note` and `skin` — are deliberately the PANEL's and not the
 * session's** (handoff T-4 item 2), mirroring `StartPanel`'s `problems`/`skin` one for one:
 *
 *   - `skin` is a per-person, cross-project UI preference living in `globalState` (see
 *     `src/skins.ts`). It says nothing about this tutorial, so it has no business in
 *     `<target>/.repo-tour/build/progress.json`, which is a record of the learner's progress
 *     through a specific plan and is read back by every future session.
 *   - `note` is the panel's transient reply line — today only `step:check`'s honest "arrives
 *     with T-5" sentence. Writing a UI message into `progress.json` would make it outlive the
 *     window that produced it and reappear, stale, on a walk reopened next week.
 *
 * **The note's lifetime is the subtle part.** It is cleared when the learner actually
 * NAVIGATES (the pushed view names a different step) and it SURVIVES a same-step refresh,
 * because a same-step refresh is a real and frequent event, not a redundant one: clicking a
 * dial radio calls `WalkSession.setDial`, which persists and refreshes every surface so the
 * status bar's `· <dial>` can update (AC6) — and that refresh calls `setPanel` with the very
 * step already on screen. Clearing the note there would erase a reply the learner is still
 * reading, for a reason they cannot see. Hence the comparison is on `step.id`, against the
 * PREVIOUS pushed view, before the new one is stored.
 *
 * **AC5, and why there is nothing to switch off here.** A webview view's context is not
 * retained while hidden unless the registration explicitly asks for it — VS Code's default
 * for `WebviewViewProviderOptions.webviewOptions.retainContextWhenHidden` is `false`, and
 * `resolveWebviewView` has no access to that option at all, so the honest way to hold AC5 is
 * to leave the default alone at the `registerWebviewViewProvider` call in `src/extension.ts`
 * and to make this provider correct under teardown. It is: `onDidChangeVisibility` re-renders
 * from `this.state` every time the view becomes visible again, the same `this.state` every
 * message handler and every `setView` already updates.
 *
 * **The host is the only truth** (spec §5.1). This provider never reads
 * `WebviewViewResolveContext.state` — the blob a previous incarnation of the view saved with
 * `setState()` — and never re-renders from anything the webview reports about itself. (The
 * client script in `./step-view.js` does re-apply exactly one saved value, the note, keyed by
 * step id: that is the page redrawing something the host had already sent it, inside the page,
 * and the host's next render still overwrites it. It is not a second source of truth, and
 * nothing in this file consults it.)
 */

import * as vscode from 'vscode';
import { readSkin, writeSkin } from '../skins.js';
import type { Dial } from '../start/request.js';
import type { SkinsModule } from '../start/view.js';
import type { WalkView } from './session.js';
import {
  handleStepMessage, parseStepMessage, type OutboundMessage, type StepEffects, type StepViewState,
} from './step-protocol.js';
import { renderStepHtml } from './step-view.js';

/**
 * A one-line, length-capped rendering of an ignored message, for the output channel.
 *
 * Byte-for-byte `src/start/panel.ts`'s own helper. Duplicated rather than shared: it is not
 * exported there, and `src/start/**` is out of bounds for this ticket (locate T-4,
 * DO-NOT-TOUCH) — the same trade `./step-view.ts` already made for `DIAL_LABEL`, and for the
 * same reason: six lines here beats widening another screen's public surface for one caller.
 */
function describe(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? String(raw);
  } catch {
    text = Object.prototype.toString.call(raw); // circular, a BigInt, …
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * What the panel needs from the walk, and nothing more. A structural subset of `WalkSession`,
 * so the real session satisfies it with no adapter and no cast, while `test/walk.test.ts` can
 * hand this provider a three-method fake and assert what the buttons actually drive without
 * standing up a whole session.
 *
 * Only the three methods the panel's own controls reach for are here. `next()`/`prev()` are
 * absent on purpose: `handleStepMessage` resolves `step:next`/`step:prev` to a concrete id via
 * `nextStepId`/`prevStepId` and calls `goTo`, so there is one navigation path through this
 * panel rather than two that could drift.
 */
export interface WalkSessionLike {
  goTo(stepId: string): void;
  openFile(): void;
  setDial(stepId: string, dial: Dial): void;
}

export interface StepPanelDeps {
  /** repo-tour's own skins module (SKINS, DEFAULT_SKIN, baseCss, alternateCss), loaded via loadCore. */
  skins: SkinsModule & { DEFAULT_SKIN: string };
  /**
   * The walk this panel drives. A FUNCTION, not a value, and that is load-bearing: a
   * `WebviewViewProvider` is registered once at activation, long before any session exists
   * (there may never be one — the workspace may hold no plan at all), and the session is
   * REPLACED whenever the learner opens a different target while the same provider, the same
   * view and the same webview stay put. A captured `WalkSession` value would pin the first
   * one forever; a getter asks the extension who is running right now, every time.
   */
  session: () => WalkSessionLike | undefined;
  /** Where an ignored message gets mentioned — `src/extension.ts` wires the "Build Tutorials"
   *  output channel. Optional so a test can observe it (or leave it silent). */
  log?: (line: string) => void;
}

export class StepViewProvider implements vscode.WebviewViewProvider {
  /** Must match `package.json`'s `views.buildTutorials` entry; `src/extension.ts` registers
   *  the provider under it, and `<viewType>.focus` is the auto-generated reveal command. */
  static readonly viewType = 'buildTutorials.step';

  /** The live view, or `undefined` before the first `resolveWebviewView` and after a dispose.
   *  Everything that paints goes through `render`, which no-ops when this is unset — a walk
   *  can refresh many times before the learner ever opens the container. */
  private webviewView: vscode.WebviewView | undefined;
  private readonly effects: StepEffects;
  /** What `render` paints: the last pushed `WalkView` combined with this panel's own two
   *  fields, or `undefined` when there is no walk. Also what the message handler updates. */
  private state: StepViewState | undefined;
  /** The previous push, kept only to answer "did the current step actually change?" — see the
   *  file header on why a same-step refresh must not clear the note. */
  private lastView: WalkView | undefined;
  /** The panel's own transient reply line (`step:check`). Never persisted anywhere. */
  private note: string | undefined;
  /** The panel's own skin choice, read once from `globalState` and written through on change. */
  private skin: string;
  /** See `onMessage`: the channel gets one line about ignored messages, not one per message. */
  private loggedIgnoredMessage = false;
  /** `context.subscriptions`, kept because `resolveWebviewView` — where the listeners are
   *  hooked — runs long after the constructor. Narrower than holding the whole context: the
   *  only other thing this provider ever wanted from it, `globalState`, is closed over by the
   *  effects below. `StartPanel` reads the same array; it just happens to do all its wiring
   *  inside its own constructor, where `context` is still in scope. */
  private readonly subscriptions: vscode.Disposable[];

  constructor(context: vscode.ExtensionContext, private readonly deps: StepPanelDeps) {
    this.skin = readSkin(context.globalState, deps.skins.DEFAULT_SKIN);
    this.subscriptions = context.subscriptions;

    // Built here, exactly as `StartPanel` builds its own `StartEffects`: the pure protocol
    // says WHAT should happen, this adapter says HOW. Every session-dependent effect goes
    // through `deps.session()` with an optional call, so a click that lands between two
    // sessions (or before the first one) is a no-op rather than a crash — the same tolerance
    // `WalkSession` itself extends to an unknown step id.
    this.effects = {
      goTo: (stepId: string) => { this.deps.session()?.goTo(stepId); },
      openFile: () => { this.deps.session()?.openFile(); },
      persistDial: (stepId: string, dial: Dial) => { this.deps.session()?.setDial(stepId, dial); },
      persistSkin: (name: string) => {
        // Updated here, not merely taken from `handleStepMessage`'s returned state: `setView`
        // rebuilds that state from scratch on the session's next refresh, so the field is
        // what has to carry the choice forward. `writeSkin` is fire-and-forget for the same
        // reason it is on the start screen — the page already applied the skin itself, with
        // no flash, and nothing on screen is waiting on the `globalState` write.
        this.skin = name;
        void writeSkin(context.globalState, name);
      },
    };
  }

  /**
   * `WalkAdapters.setPanel` — the session pushes its current view here, and this is the only
   * way the walk's half of the state ever changes.
   *
   * `undefined` means there is no walk running (a disposed session, or a plan whose chapters
   * produced no steps at all). The panel then holds no state and paints an empty page: it
   * must not keep showing the step it happened to be on, which would be a confident claim
   * about a walk that is not running. It stays empty rather than saying so in words because
   * every scrap of this view's markup lives in `./step-view.js`, which exports one renderer
   * and takes a state with a real step in it — a second, bespoke page built by hand in this
   * adapter would be exactly the split this ticket's design exists to avoid.
   */
  setView(view: WalkView | undefined): void {
    // Before storing the new view, and against the PREVIOUS one: the note belongs to the step
    // it was produced on. See the file header for why a same-step push is not a redundant one.
    if (this.lastView?.step.id !== view?.step.id) this.note = undefined;
    this.lastView = view;
    this.state = view ? { ...view, skin: this.skin, note: this.note } : undefined;
    this.render();
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    ctx: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken,
  ): void {
    // The resolve can be cancelled while it is in flight (the view was closed again, the
    // window is going away). Nothing below is worth doing for a view that is already gone.
    if (token.isCancellationRequested) return;

    // `ctx.state` — whatever the previous incarnation of this view last passed to
    // `setState()` — is read here and then deliberately dropped on the floor. AC5's whole
    // claim is that this panel "never holds truth of its own": what comes back on screen is
    // `renderStepHtml(this.state, …)` and nothing else, so the one honest use for the
    // restored blob is to name it and refuse it. See the file header.
    void ctx.state;

    this.webviewView = view;
    view.webview.options = { enableScripts: true };
    this.render();

    // `raw`, not `InboundMessage`: what arrives here is whatever the webview posted, and a
    // compile-time annotation is not a run-time guarantee about a value from outside the
    // compiler's reach. `onMessage` parses it (T-3 rework, review finding 3).
    view.webview.onDidReceiveMessage((raw: unknown) => { this.onMessage(raw); }, undefined, this.subscriptions);

    // AC5. The view is hidden by collapsing it, by switching container, by closing the
    // sidebar — and with `retainContextWhenHidden` at its default `false` the webview's own
    // DOM and script are gone by the time it comes back. Re-render from the host's state, the
    // only copy that was never torn down.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.render();
    }, undefined, this.subscriptions);

    // A `WebviewView` is disposed when it is dragged to another container or its container is
    // removed, and `resolveWebviewView` is then called again with a NEW view. Dropping the
    // reference keeps `render` from writing `.html` onto a disposed object; the identity guard
    // keeps a late disposal of the OLD view from unhooking the new one.
    view.onDidDispose(() => {
      if (this.webviewView === view) this.webviewView = undefined;
    }, undefined, this.subscriptions);
  }

  private render(): void {
    const view = this.webviewView;
    if (!view) return;
    view.webview.html = this.state ? renderStepHtml(this.state, this.deps.skins) : '';
  }

  /**
   * Parse, then act — never the other way round. Anything that is not a message this panel
   * knows, in exactly the shape that message promises, is IGNORED: no throw (a rejection or an
   * exception raised inside a webview message listener has nobody listening for it), no reply,
   * no state change. The output channel gets ONE line about it per panel — enough to explain a
   * webview that has silently stopped working, without handing a misbehaving (or malicious)
   * page a way to fill the log.
   *
   * A well-formed message that arrives while there is no walk is dropped too, silently and
   * without spending that one log line: it is not malformed, and it has an ordinary cause —
   * a click already in flight when the session was disposed. There is nothing to act on,
   * because `handleStepMessage` transforms a state and there is no state.
   *
   * Nothing here re-renders, deliberately. `step:check`'s reply is posted to the page, which
   * writes it into the note node itself; `dial:set`/`skin:set` are already reflected in the
   * control the learner just touched; and `step:next`/`step:prev`/`step:open` drive the
   * session, which comes back through `setView` with a fresh view and re-renders then. A
   * render here would either duplicate that or race it.
   */
  private onMessage(raw: unknown): OutboundMessage | undefined {
    const message = parseStepMessage(raw);
    if (!message) {
      if (!this.loggedIgnoredMessage) {
        this.loggedIgnoredMessage = true;
        this.deps.log?.(
          `ignored a step-panel message that did not match any known message shape: ${describe(raw)} ` +
          '(further ignored messages will not be logged)',
        );
      }
      return undefined;
    }
    const before = this.state;
    if (!before) return undefined;

    const { state, post } = handleStepMessage(before, message, this.effects);

    /*
     * Adopt the returned state ONLY if nothing overtook it while the effects ran — and
     * something regularly does, synchronously, on the very messages that matter most.
     * `step:next` resolves to an id and calls `effects.goTo`, which is `WalkSession.goTo`,
     * which persists and refreshes, which calls `WalkAdapters.setPanel`, which is `setView`
     * on this object — all before `handleStepMessage` has even returned. `setView` has by
     * then installed the state for the step the learner just moved TO. Assigning the
     * handler's result unconditionally would overwrite it with the step they moved FROM
     * (`step:next` returns its input state untouched, since navigating is entirely an
     * effect), leaving `getStateForTest` and the next visibility re-render both a step
     * behind — an AC5 failure produced by an AC2 message.
     *
     * The rule is the same one the whole design rests on: the session is the truth, and the
     * newer answer is its. An identity check is exactly the right test because `setView`
     * always installs a freshly built object, so `this.state === before` means, precisely,
     * "no push happened during the effects" — which is the case for `step:check`,
     * `skin:set` and `step:open`, the three messages whose result this panel must keep.
     */
    if (this.state === before) {
      this.state = state;
      // `note` is the one panel-owned field the protocol expresses as a pure state transition
      // rather than as an effect (there is no `StepEffects` member for it), so it is mirrored
      // back out of the returned state here. Without this, the next `setView` — which rebuilds
      // the state from the FIELDS — would silently drop a note that is still on screen. When
      // a push DID overtake us, `setView` has already decided the note's fate correctly
      // (cleared on a real navigation, kept on a same-step refresh) and must not be second-
      // guessed with a value read before the navigation happened.
      this.note = state.note;
    }
    if (post) void this.webviewView?.webview.postMessage(post);
    return post;
  }

  /**
   * Test-only seam: VS Code gives an extension no public way to observe a message it just
   * posted TO its own webview (that is the renderer's job to receive), so a test that wants to
   * prove the wiring — not just `handleStepMessage` in isolation, which
   * `test/unit/walk-step-protocol.test.ts` covers with no webview at all — calls this instead
   * of trying to simulate a real `postMessage` from inside the iframe. It runs the exact same
   * `onMessage` the real `webview.onDidReceiveMessage` listener calls, and works whether or
   * not the view has ever been resolved.
   *
   * `unknown`, deliberately: the real listener's argument is untyped too, and a malformed
   * message is exactly the case worth proving is survivable (T-3 rework, review finding 3).
   * Synchronous, unlike `StartPanel`'s, because nothing this panel's protocol does is async —
   * `handleStepMessage` returns a value, it does not await one.
   */
  dispatchForTest(raw: unknown): OutboundMessage | undefined {
    return this.onMessage(raw);
  }

  /**
   * Test-only seam, read-only: `this.state` as it stands, without dispatching anything.
   *
   * It exists because the two fields worth asserting on are precisely the two that no message
   * round-trip will show you honestly. `note` is cleared by `setView`, so probing for it by
   * sending another message would be testing the probe; and the whole hide/show drill (AC5)
   * is about state surviving with NO message traffic at all, which is only observable by
   * looking. `undefined` here is the real answer to "the walk is not running", not a
   * not-resolved-yet artefact: it is set by `setView`, which the session calls long before
   * anyone opens the container.
   */
  getStateForTest(): StepViewState | undefined {
    return this.state;
  }
}
