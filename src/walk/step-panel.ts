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
 *   - `note` is the panel's transient reply line — today, the two answers `tutor:ask` gives
 *     when it refuses to send (an empty box, a question past the cap). It took `step:check`'s
 *     place there when T-5 made that button real. Writing a UI message into `progress.json`
 *     would make it outlive the window that produced it and reappear, stale, on a walk
 *     reopened next week.
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
 * **A push is not automatically a repaint** (T-4 code review, finding 1). `setView` is
 * called on EVERY session refresh, and a refresh is not always a change to anything on
 * screen: `WalkSession.setDial` persists the learner's dial and refreshes so the STATUS BAR's
 * `· <dial>` can update (AC6), which pushes the very step already rendered here back at this
 * panel. Assigning `webview.html` is never free and never idempotent — `renderPage` mints a
 * fresh nonce per call, so the string is different every time and VS Code's identical-html
 * short-circuit can never fire — and the assignment tears the iframe down and rebuilds it.
 * The learner who tabbed into the dial and pressed Down loses the radio that had focus (focus
 * drops to the document, so a second Down does nothing) and the panel scrolls back to the
 * top; a mouse user gets a flash and the same scroll reset on every click. `src/start/panel.ts`
 * never re-renders inside a message round trip at all; this is the first surface in the
 * extension that can, so it is the first that has to decide when NOT to. `keyFor` below is
 * the whole of that decision; the enumeration of exactly what the page displays lives with
 * the page, in `./step-view.js`'s `stepRenderKey` (T-5 moved it there — see `keyFor`).
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
import { renderNoticeHtml, renderStepHtml, stepRenderKey } from './step-view.js';

/** The two "nothing to render" pages, hoisted so `page()` is the ONLY place that chooses
 *  between them and `keyFor` can key on the chosen text rather than re-deriving the choice. */
const CORE_MISSING_NOTICE =
  "repo-tour's core isn't loaded, so there is nothing to render a step with. Run \"Build Tutorials: Doctor\" to see why.";
const NO_WALK_NOTICE = 'No tutorial in this folder yet. Run "Build Tutorials: Start" to build one.';

/**
 * Which of the three pages this view is currently showing, decided ONCE.
 *
 * `render` (what to paint) and `keyFor` (whether painting would change anything) must never
 * disagree about which page is on screen — if they did, the panel would either skip a repaint
 * it needed or, worse, believe it had painted something it had not. Both go through `page()`,
 * so there is one answer rather than two that can drift.
 */
type StepPage =
  | { kind: 'step'; state: StepViewState; skins: SkinsModule }
  | { kind: 'notice'; notice: string };

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
 * hand this provider a small fake and assert what the buttons actually drive without standing
 * up a whole session.
 *
 * Only the methods the panel's own controls reach for are here. `next()`/`prev()` are absent
 * on purpose: `handleStepMessage` resolves `step:next`/`step:prev` to a concrete id via
 * `nextStepId`/`prevStepId` and calls `goTo`, so there is one navigation path through this
 * panel rather than two that could drift.
 *
 * `runCheck` and `reproduce` are T-5's two: *Check my work* (AC5) and the offer to copy
 * `plan.reproduce`'s never-taught files (AC6). Both return `void` rather than a promise, and
 * that is deliberate rather than lazy — they are called from a webview message listener,
 * where a rejected promise has nobody listening for it, so the SESSION owns the await and
 * routes any failure to its own `reportError` channel. Their answers come back the same way
 * every other change does: as a fresh `WalkView` through `setView`.
 */
export interface WalkSessionLike {
  goTo(stepId: string): void;
  openFile(): void;
  runCheck(): void;
  reproduce(): void;
  setDial(stepId: string, dial: Dial): void;
  /**
   * T-6's two: one question for the tutor (AC2, AC3) and the press that stops waiting for it
   * (AC4). `void` like the four above, and for a sharper version of the same reason — an ask
   * waits on a MODEL, and a rejected promise raised inside a webview message listener has
   * nobody listening for it, so the session owns the whole asynchronous life of the ask and
   * routes any failure to its own `reportError`. Its answers come back the way every other
   * change does: as a fresh `WalkView` through `setView`.
   */
  ask(text: string): void;
  cancelAsk(): void;
  /** T-6 review: forget this step's conversation. `clearTranscript` shipped exported with six
   *  unit tests and no caller — a stored conversation owes somebody a way to delete it. */
  clearConversation(): void;
  /** T-7: write and open an unrelated worked example, and come back from one. `void` like the
   *  rest, and for the sharper version of `ask`'s reason — this waits on a model and then
   *  writes files and opens tabs, and a rejected promise raised inside a webview message
   *  listener has nobody listening for it. */
  startDetour(): void;
  returnFromDetour(): void;
}

export interface StepPanelDeps {
  /**
   * repo-tour's own skins module (SKINS, DEFAULT_SKIN, baseCss, alternateCss).
   *
   * A FUNCTION, and allowed to answer `undefined`, for the same reason `session` is one: this
   * provider must be REGISTERED during `activate()`, which is synchronous, while the core is
   * loaded with an `await` that has not happened yet — and may never succeed, if repo-tour is
   * missing. Registering late instead would leave the view with no provider at all and
   * nothing to explain itself with; this way the panel is always live and always says
   * something true (see `renderNoticeHtml`).
   */
  skins: () => (SkinsModule & { DEFAULT_SKIN: string }) | undefined;
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

export class StepViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
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
  /**
   * The panel's own transient reply line. Never persisted anywhere, and produced by exactly
   * one message: `tutor:ask` refusing to send (an empty box, or a question past
   * `MAX_ASK_TEXT`). It took `step:check`'s place as this channel's producer when T-5 made
   * that button real, and the reason those two answers use this channel rather than the
   * server-rendered `tutor.note` is the same reason the channel exists at all: they are the
   * only sentences on this page that must reach the learner WITHOUT a repaint, because a
   * repaint tears the iframe down and takes the question they are still holding with it.
   */
  private note: string | undefined;
  /** The panel's own skin choice, read once from `globalState` and written through on change. */
  private skin: string;
  /** See `onMessage`: the channel gets one line about ignored messages, not one per message. */
  private loggedIgnoredMessage = false;
  /**
   * Why the walk could not be opened at all, in words meant for the learner — set by
   * `src/extension.ts` when `loadPlan` throws on a malformed `plan.json` (T-4 code review
   * finding 2 / security review finding 5). It outranks both standing notices because it is
   * the only one of the three that is TRUE in that situation: the panel used to say "No
   * tutorial in this folder yet" while a `plan.json` sat right there, which is not a missing
   * message but a confidently wrong one. `undefined` means "nothing has failed", which is
   * also what a successful open restores.
   */
  private notice: string | undefined;
  /**
   * `keyFor(page())` as of the last time this provider actually assigned `webview.html`, or
   * `undefined` if it never has (there was no resolved view to paint into). It is the answer
   * to "is what is on screen still what the state says?", and `setView` skips the repaint
   * when it has not moved — see `keyFor` for what counts as movement and what deliberately
   * does not.
   *
   * The invariant that makes this safe: nothing else in this file writes `webview.html`, and
   * every path that does goes through `render`, which refreshes this in the same breath. The
   * fields `keyFor` deliberately leaves out are exactly the ones the PAGE keeps up to date
   * itself, so leaving them out cannot make this a lie about what is on screen.
   */
  private paintedKey: string | undefined;
  /**
   * The listeners hooked in `resolveWebviewView`, owned HERE rather than pushed into
   * `context.subscriptions` (T-4 code review, finding 9). VS Code re-resolves a webview view
   * whenever it is dragged to another container, and the old code appended three more
   * disposables to the extension-wide array on every resolve, none of which was ever removed:
   * an array that only grows for as long as the window is open. Nothing leaked functionally —
   * the old view's emitters die with the view — but "it grows without bound and nothing reads
   * it" is not a property worth keeping. Replaced wholesale on each resolve; the provider
   * itself is what `src/extension.ts` registers in `context.subscriptions`, once.
   */
  private resolved: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext, private readonly deps: StepPanelDeps) {
    // `'system'` when the core has not loaded yet — it is repo-tour's own `DEFAULT_SKIN`
    // value, so this fallback agrees with the real one rather than guessing at it, and a skin
    // the learner has actually chosen is read from `globalState` either way.
    this.skin = readSkin(context.globalState, deps.skins()?.DEFAULT_SKIN ?? 'system');

    // Built here, exactly as `StartPanel` builds its own `StartEffects`: the pure protocol
    // says WHAT should happen, this adapter says HOW. Every session-dependent effect goes
    // through `deps.session()` with an optional call, so a click that lands between two
    // sessions (or before the first one) is a no-op rather than a crash — the same tolerance
    // `WalkSession` itself extends to an unknown step id.
    this.effects = {
      goTo: (stepId: string) => { this.deps.session()?.goTo(stepId); },
      openFile: () => { this.deps.session()?.openFile(); },
      runCheck: () => { this.deps.session()?.runCheck(); },
      reproduce: () => { this.deps.session()?.reproduce(); },
      ask: (text: string) => { this.deps.session()?.ask(text); },
      cancelAsk: () => { this.deps.session()?.cancelAsk(); },
      clearConversation: () => { this.deps.session()?.clearConversation(); },
      startDetour: () => { this.deps.session()?.startDetour(); },
      returnFromDetour: () => { this.deps.session()?.returnFromDetour(); },
      persistDial: (stepId: string, dial: Dial) => { this.deps.session()?.setDial(stepId, dial); },
      persistSkin: (name: string) => {
        // Updated here, not merely taken from `handleStepMessage`'s returned state: `setView`
        // rebuilds that state from scratch on the session's next refresh, so the field is
        // what has to carry the choice forward. `writeSkin` is fire-and-forget for the same
        // reason it is on the start screen — the page already applied the skin itself, with
        // no flash, and nothing on screen is waiting on the `globalState` write.
        //
        // The name is already known to be one repo-tour ships — `onMessage` refuses the
        // message otherwise, before the protocol ever sees it, and that check is what keeps
        // an arbitrary webview-supplied string out of `globalState` (security review,
        // informational). It matters more than it looks: `globalState` is GLOBAL, so a value
        // written from one workspace's panel is read back by every other project on this
        // machine, forever, and `readSkin`'s fallback only covers "nothing stored yet", not
        // "something nonsensical stored".
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

    // The state above is updated UNCONDITIONALLY and the repaint is what is conditional —
    // that order is the whole safety of this optimisation. The host stays the truth whether
    // or not the page is redrawn, so the next visibility re-render, the next resolve and
    // `getStateForTest` all still see the newest push (AC5). All that is skipped is an
    // `webview.html` assignment that would have produced the same page the learner is already
    // looking at, at the cost of their keyboard focus and their scroll position.
    if (this.keyFor(this.page()) === this.paintedKey) return;
    this.render();
  }

  /**
   * `src/extension.ts` calls this when OPENING the walk failed — a `plan.json` that is not a
   * build plan — and with `undefined` when a walk opens successfully.
   *
   * It exists because the alternative failure is the one this panel was actually shipping:
   * `loadPlan` throws, the throw escapes `openWalkAt` → `openWalkOnActivate` → the `void` at
   * the `activate()` call site as an unhandled rejection, and the panel — which was never
   * given a view, so it falls through to its standing "no tutorial here" notice — tells the
   * learner there is no tutorial in a folder that visibly contains one. A silent failure is
   * bad; a silent failure that produces a confident wrong answer is worse. `renderNoticeHtml`
   * already renders exactly this shape of page (it takes no `SkinsModule`, so it works even
   * when the core is the thing that is missing), so the reason is shown where the eye already
   * is rather than only in a toast that has since vanished.
   */
  setNotice(notice: string | undefined): void {
    if (this.notice === notice) return;
    this.notice = notice;
    if (this.keyFor(this.page()) === this.paintedKey) return;
    this.render();
  }

  /**
   * Disposes the per-resolve listeners. `src/extension.ts` registers this provider itself in
   * `context.subscriptions` (finding 9), so the window's teardown reaches them through here
   * instead of through three entries appended per resolve and never removed.
   */
  dispose(): void {
    this.disposeResolved();
  }

  private disposeResolved(): void {
    for (const disposable of this.resolved.splice(0)) disposable.dispose();
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

    // Whatever a PREVIOUS resolve hooked is dropped here, not merely left to die with its
    // view: this is the "one batch, replaced" half of finding 9, and it also means a late
    // `onDidDispose` on the outgoing view cannot fire at all once the new one is live.
    this.disposeResolved();

    this.webviewView = view;
    view.webview.options = {
      enableScripts: true,
      // Explicitly EMPTY, not merely unset (security review, informational). Unset does not
      // mean "no roots": VS Code defaults `localResourceRoots` to the extension's own install
      // directory plus every open workspace folder, so the page would be allowed to load
      // `vscode-webview-resource:` URLs for any file in a repository the learner has open —
      // and this page is rendering strings that came out of exactly such a repository. It
      // needs none of it: every stylesheet and every script on this page is INLINED by
      // `renderPage`, and there is no `<img>`, `<link>` or `<iframe>` in `./step-view.ts` at
      // all. Nothing to grant, so nothing is granted.
      localResourceRoots: [],
    };
    this.render();

    // `raw`, not `InboundMessage`: what arrives here is whatever the webview posted, and a
    // compile-time annotation is not a run-time guarantee about a value from outside the
    // compiler's reach. `onMessage` parses it (T-3 rework, review finding 3).
    this.resolved.push(view.webview.onDidReceiveMessage((raw: unknown) => { this.onMessage(raw); }));

    // AC5. The view is hidden by collapsing it, by switching container, by closing the
    // sidebar — and with `retainContextWhenHidden` at its default `false` the webview's own
    // DOM and script are gone by the time it comes back. Re-render from the host's state, the
    // only copy that was never torn down.
    //
    // `render`, NOT the `setView` repaint check: coming back from a teardown is the one case
    // where the page on screen is genuinely gone rather than merely up to date, so this must
    // paint unconditionally. `render` refreshes `paintedKey` afterwards, which is what keeps
    // the two mechanisms agreeing.
    this.resolved.push(view.onDidChangeVisibility(() => {
      if (view.visible) this.render();
    }));

    // A `WebviewView` is disposed when it is dragged to another container or its container is
    // removed, and `resolveWebviewView` is then called again with a NEW view. Dropping the
    // reference keeps `render` from writing `.html` onto a disposed object, and clearing
    // `paintedKey` records the truth that nothing is painted any more, so the next resolve
    // repaints rather than deciding the page is already correct. The identity guard stays:
    // VS Code promises no order between disposing the old view and resolving the new one, so
    // a late disposal must not unhook a view that has already replaced it.
    this.resolved.push(view.onDidDispose(() => {
      if (this.webviewView !== view) return;
      this.webviewView = undefined;
      this.paintedKey = undefined;
    }));
  }

  /**
   * Which of the three pages this view should be showing, in priority order — and the order
   * is the learner's, not the code's:
   *
   *   1. **the walk failed to open** (`setNotice`) — the most specific thing anyone can be
   *      told, and the only one of the three that is true when a `plan.json` is malformed;
   *   2. **the core is missing** — nothing can render a STEP at all, whatever else is true;
   *   3. **a step**, with the core to draw it with;
   *   4. **no walk here** — the standing, honest default.
   */
  private page(): StepPage {
    if (this.notice !== undefined) return { kind: 'notice', notice: this.notice };
    const skins = this.deps.skins();
    if (!skins) return { kind: 'notice', notice: CORE_MISSING_NOTICE };
    if (this.state) return { kind: 'step', state: this.state, skins };
    return { kind: 'notice', notice: NO_WALK_NOTICE };
  }

  /**
   * Whether a repaint would change anything on screen, as one comparable string.
   *
   * The step page's half of the answer is `stepRenderKey` in `./step-view.ts`, deliberately:
   * it enumerates what that file's markup draws, so it belongs beside that markup rather than
   * here, one file away — and one file away is exactly the distance a drift needs, silently
   * (a field rendered there and missing from the key is stored on the host and never appears
   * on screen). Keeping it there also puts it inside the pure, `vscode`-free half of this
   * design, where `test/unit/walk-step-view.test.ts` can prove by mutation that changing a
   * rendered field really does change the key. **A new field on the page is a new entry
   * there, in the same commit** — that function's own doc comment carries the full list, and
   * the four fields deliberately left out of it with the reason for each.
   *
   * What is left here is the only part `./step-view.ts` cannot know: which of this view's
   * FOUR pages is on screen. `render` (what to paint) and this (whether painting would change
   * anything) must never disagree about that — if they did, the panel would either skip a
   * repaint it needed or believe it had painted something it had not — so both take the
   * already-decided `page()` rather than re-deriving the choice. The `notice:`/`step:` prefix
   * keeps the two namespaces from colliding on a plan whose text happens to spell a notice.
   */
  private keyFor(page: StepPage): string {
    if (page.kind === 'notice') return `notice:${page.notice}`;
    return `step:${stepRenderKey(page.state, page.skins)}`;
  }

  /**
   * The one place `webview.html` is ever assigned — see `page()` for the four things this view
   * can be, all of them said out loud rather than left blank.
   *
   * UNCONDITIONAL by design: every caller that reaches here has already decided a paint is
   * needed (`setView`/`setNotice` through the `paintedKey` check, `resolveWebviewView` and
   * `onDidChangeVisibility` because the page they would be checking against no longer
   * exists). Recording the key here rather than at each call site is what guarantees
   * `paintedKey` describes the page that is actually on screen, including the paints no key
   * check was consulted for. When there is no resolved view, nothing is painted and the key
   * is deliberately left alone — claiming a paint that never happened would let the next real
   * push be skipped.
   */
  private render(): void {
    const view = this.webviewView;
    if (!view) return;
    const page = this.page();
    view.webview.html = page.kind === 'step'
      ? renderStepHtml(page.state, page.skins)
      : renderNoticeHtml(page.notice);
    this.paintedKey = this.keyFor(page);
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
   * A `skin:set` naming a skin the loaded core does not ship is refused HERE, before
   * `handleStepMessage` can put the name into the state and before `persistSkin` can write it
   * (security review, informational). `parseStepMessage` cannot do it — it is pure, and the
   * skin registry arrives at run time from repo-tour — so this is the first place that knows
   * the answer. It matters because the value does not stay in this window: `writeSkin` puts it
   * in `globalState`, which is per-person and CROSS-PROJECT, so an arbitrary string posted by
   * one page is read back by every other workspace on this machine until something overwrites
   * it. Rendered, an unknown name is merely an inert `data-theme` (`escapeAttr` has always
   * covered the injection half) — the reason to refuse it is that it is durable, global, and
   * not a skin.
   *
   * Nothing here re-renders, deliberately. `tutor:ask`'s refusal is POSTED to the page, which
   * writes it into the note node itself — the whole point of that channel, since a repaint
   * would destroy the question the learner is being told to shorten; `dial:set`/`skin:set`
   * are already reflected in the control the learner just touched; and everything else
   * (`step:next`, `step:prev`, `step:open`, `step:check`, `reproduce:run`, `tutor:ask` when
   * it really does send, `tutor:cancel`) drives the session, which comes back through
   * `setView` with a fresh view and re-renders then. A render here would duplicate that or
   * race it.
   */
  private onMessage(raw: unknown): OutboundMessage | undefined {
    const message = parseStepMessage(raw);
    if (!message) {
      this.logIgnored(`did not match any known message shape: ${describe(raw)}`);
      return undefined;
    }
    if (message.type === 'skin:set' && !this.isKnownSkin(message.payload.skin)) {
      this.logIgnored(`named a skin the loaded core does not ship: ${describe(message.payload.skin)}`);
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

  /** repo-tour's own registry is the authority, read through the getter every time: the core
   *  can finish loading after this provider is constructed, and a skin is one `SKINS` row in
   *  repo-tour, so nothing here may hold a copy. No core loaded means no known skins, which is
   *  the right answer — the page that offers the picker cannot be rendered without one. */
  private isKnownSkin(name: string): boolean {
    return this.deps.skins()?.SKINS.some((row) => row.name === name) ?? false;
  }

  /** ONE line per panel, whatever the reason. See `onMessage`: enough to explain a page that
   *  has quietly stopped working, without handing a misbehaving (or malicious) webview a way
   *  to fill the output channel. */
  private logIgnored(reason: string): void {
    if (this.loggedIgnoredMessage) return;
    this.loggedIgnoredMessage = true;
    this.deps.log?.(`ignored a step-panel message that ${reason} (further ignored messages will not be logged)`);
  }

  /**
   * The REAL webview this provider resolved, or `undefined` before VS Code has resolved one —
   * `src/start/panel.ts` exposes its own the same way, for the same reason.
   *
   * It is the only honest way to check AC5's actual promise. `getStateForTest()` proves the
   * state a re-render WOULD paint from survives a hide/show; it cannot prove the page was
   * repainted, and "the host kept the right state but never redrew" is exactly the failure
   * AC5 is about. Reading `.html` back off the live webview proves what is on screen, not
   * what we intended to put there.
   */
  get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
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
