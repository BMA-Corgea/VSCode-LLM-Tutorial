// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * StartPanel — the webview EDITOR TAB for building a new tutorial's plan (spec §5.1, §5.2).
 *
 * A thin adapter, on purpose: every actual decision (what a message means, what the reply
 * should be, what the markup looks like) lives in `./protocol.js` and `./view.js`, neither of
 * which import `vscode` — this file is where those pure pieces meet a real
 * `vscode.WebviewPanel`. `retainContextWhenHidden: false` means a hidden tab's webview is
 * torn down; there is no re-render-from-the-view-side path here at all, because the host
 * NEVER trusts the view's own memory (spec §5.1) — `onDidChangeViewState` re-renders from
 * `this.state`, the same state every message handler already updates, every time the tab
 * becomes visible again.
 */

import * as vscode from 'vscode';
import { readSkin, writeSkin } from '../skins.js';
import { codiconsRoot, pageAssets } from '../webview/assets.js';
import { emptyRequest, type BuildRequest, type RequestField } from './request.js';
import {
  handleStartMessage, parseInboundMessage, type BuildEnding, type OutboundMessage, type PanelState, type PickTarget,
  type StartEffects,
} from './protocol.js';
import { renderStartHtml, type SkinsModule } from './view.js';

const VIEW_TYPE = 'buildTutorials.start';
const VIEW_TITLE = 'Build Tutorials: Start';

/** A one-line, length-capped rendering of an ignored message, for the output channel. */
function describe(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? String(raw);
  } catch {
    text = Object.prototype.toString.call(raw); // circular, a BigInt, …
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export interface StartPanelDeps {
  /** repo-tour's own skins module (SKINS, DEFAULT_SKIN, baseCss, alternateCss), loaded via loadCore. */
  skins: SkinsModule & { DEFAULT_SKIN: string };
  /** Called on a validated form:submit. Fire-and-forget from the panel's own point of view. */
  onSubmit(request: BuildRequest): void;
  /** Where an ignored message gets mentioned — `src/extension.ts` wires the "Build Tutorials"
   *  output channel. Optional so a test can observe it (or leave it silent). */
  log?: (line: string) => void;
}

export class StartPanel {
  private static current: StartPanel | undefined;
  /**
   * A build started from the start screen is running (T-15). THE one record of it: WINDOW-wide, not
   * per panel, because the tab can be closed and reopened while a build runs and a fresh panel that
   * believed nothing was running offered a live button for a second build.
   *
   * Set SYNCHRONOUSLY inside `submit`, before any `await`, so a second press handled in the same
   * tick already sees it (review: the gate was not atomic). Cleared only by `buildFinished`. And
   * never written from a `PanelState` snapshot: `onMessage` awaits the handler — for a folder pick
   * that is the native dialog, open for as long as the person likes — and a snapshot taken before
   * the dialog said "building" after the build had ended, which wedged every start screen in the
   * window at "Building…" until a reload (code review finding 2, security review finding 2).
   */
  private static running = false;

  private readonly panel: vscode.WebviewPanel;
  private readonly effects: StartEffects;
  /** Where the packaged icon font is (T-40): the one folder this panel's webview may read. */
  private readonly extensionUri: vscode.Uri;
  private state: PanelState;
  /** See `onMessage`: the channel gets one line about ignored messages, not one per message. */
  private loggedIgnoredMessage = false;

  private constructor(context: vscode.ExtensionContext, private readonly deps: StartPanelDeps) {
    const skin = readSkin(context.globalState, deps.skins.DEFAULT_SKIN);
    this.state = { request: emptyRequest(), problems: {}, skin, building: StartPanel.running, refusedInARow: 0 };

    this.effects = {
      pickFolder: async (which: PickTarget) => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: which === 'repo' ? 'Use as reference repo' : 'Build the tutorial here',
        });
        return picked?.[0]?.fsPath;
      },
      submit: (request) => {
        StartPanel.running = true;
        this.deps.onSubmit(request);
      },
      persistSkin: (name) => { void writeSkin(context.globalState, name); },
    };

    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, VIEW_TITLE, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      // T-40: the packaged icon font's folder and nothing else. Left unset, as it was, VS Code
      // grants the extension's whole install plus every open workspace folder (see
      // `src/walk/step-panel.ts`); this page inlines everything except the font's stylesheet.
      localResourceRoots: [codiconsRoot(context.extensionUri)],
    });
    this.extensionUri = context.extensionUri;
    this.render();

    // `raw`, not `InboundMessage`: what arrives here is whatever the webview posted, and a
    // compile-time annotation is not a run-time guarantee about a value from outside the
    // compiler's reach. `onMessage` parses it (T-3 rework, review finding 3).
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.onMessage(raw); }, undefined, context.subscriptions);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) this.render();
    }, undefined, context.subscriptions);
    this.panel.onDidDispose(() => {
      if (StartPanel.current === this) StartPanel.current = undefined;
    }, undefined, context.subscriptions);
  }

  /** Reveals the existing tab if one is already open; otherwise creates it. */
  static show(context: vscode.ExtensionContext, deps: StartPanelDeps): StartPanel {
    if (StartPanel.current) {
      StartPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return StartPanel.current;
    }
    StartPanel.current = new StartPanel(context, deps);
    return StartPanel.current;
  }

  /** The real webview — read `.html` to inspect the current render, or dispose the panel. */
  get webview(): vscode.Webview {
    return this.panel.webview;
  }

  dispose(): void {
    this.panel.dispose();
  }

  /**
   * Surfaces a BUILD-TIME problem (a language refusal, a clone failure) under a field, the
   * same "in the form, where the eye already is" channel `form:submit` itself replies
   * through (AC3: "refused with the reason shown in the form") — never only a transient
   * notification, which the caller (`src/extension.ts`) also shows for anyone not currently
   * looking at this tab, but which is not itself "in the form." Merges onto whatever
   * problems are already there rather than replacing them, and returns the message posted
   * so a test can assert on it directly (see the `dispatchForTest` doc comment above for why
   * that is necessary at all).
   */
  reportProblem(problems: Partial<Record<RequestField, string>>): OutboundMessage {
    this.state = { ...this.state, problems: { ...this.state.problems, ...problems } };
    const post: OutboundMessage = { type: 'form:problems', payload: { problems: this.state.problems } };
    void this.panel.webview.postMessage(post);
    return post;
  }

  /**
   * The build ended — however it ended (T-15 review finding 2) — and the note says how.
   *
   * Called for EVERY outcome, including a failure and a cancel, because the button was disabled
   * on submit and nothing else brings it back. A cancel posts nothing else at all, so without
   * this the only way out of a dead "Building…" button was to switch tabs and back.
   *
   * STATIC, and it reaches the panel that is open NOW (T-15, 2026-11-05). The September version was
   * an instance method on the panel captured when the build started; if the learner closed that tab
   * mid-build, `this.panel.webview` threw "Webview is disposed" from inside `reportOutcome`, and the
   * build's ending — the error, the completion, opening the walk — was swallowed whole. `current`
   * is cleared on dispose, so it is never a disposed panel; with no start screen open, this is a
   * no-op and returns `undefined`.
   */
  static buildFinished(ended: BuildEnding): OutboundMessage | undefined {
    StartPanel.running = false;
    const open = StartPanel.current;
    if (!open) return undefined;
    open.state = { ...open.state, building: false, refusedInARow: 0, ended };
    const post: OutboundMessage = { type: 'form:idle', payload: { ended } };
    void open.panel.webview.postMessage(post);
    return post;
  }

  /** `reportProblem` on the start screen that is open now, if any — never a disposed one (see `buildFinished`). */
  static reportBuildProblem(problems: Partial<Record<RequestField, string>>): OutboundMessage | undefined {
    return StartPanel.current?.reportProblem(problems);
  }

  private render(): void {
    this.panel.webview.html = renderStartHtml(
      { ...this.state, building: StartPanel.running }, this.deps.skins, pageAssets(this.panel.webview, this.extensionUri),
    );
  }

  /**
   * Parse, then act — never the other way round. Anything that is not a message this screen
   * knows, in exactly the shape that message promises, is IGNORED: no throw (this is called
   * from a `void`-ed promise, where a rejection has nobody listening and becomes an unhandled
   * rejection), no reply, no state change. The output channel gets ONE line about it per
   * panel — enough to explain a webview that has silently stopped working, without handing a
   * misbehaving (or malicious) page a way to fill the log.
   */
  private async onMessage(raw: unknown): Promise<OutboundMessage | undefined> {
    const message = parseInboundMessage(raw);
    if (!message) {
      if (!this.loggedIgnoredMessage) {
        this.loggedIgnoredMessage = true;
        this.deps.log?.(
          `ignored a start-screen message that did not match any known message shape: ${describe(raw)} ` +
          '(further ignored messages will not be logged)',
        );
      }
      return undefined;
    }
    const { state, post } = await handleStartMessage({ ...this.state, building: StartPanel.running }, message, this.effects);
    // Everything the message decided, EXCEPT whether a build is running: that is read live, after
    // the await (see `running`).
    this.state = { ...state, building: StartPanel.running };
    if (post) void this.panel.webview.postMessage(post);
    return post;
  }

  /**
   * Test-only seam: VS Code gives an extension no public way to observe a message it just
   * posted TO its own webview (that is the renderer's job to receive), so a test that wants
   * to prove the wiring — not just `handleStartMessage` in isolation, which
   * `test/unit/protocol.test.ts` already covers with no webview at all — calls this instead
   * of simulating a real `postMessage` from inside the iframe. It runs the exact same
   * `onMessage` the real `webview.onDidReceiveMessage` listener calls.
   *
   * `unknown`, deliberately: the real listener's argument is untyped too, and a malformed
   * message is exactly the case worth proving is survivable (T-3 rework, review finding 3).
   */
  dispatchForTest(raw: unknown): Promise<OutboundMessage | undefined> {
    return this.onMessage(raw);
  }

  /**
   * Test-only seam, read-only: a way to observe `this.state` (in particular, the current
   * `problems`) WITHOUT dispatching a message — `form:changed`/`form:submit` recompute
   * `problems` from scratch via `validateRequest`, so probing with one of those would
   * overwrite (not merely read) whatever `reportProblem` had just set, which is exactly the
   * kind of test-observation bug this getter avoids.
   */
  getStateForTest(): PanelState {
    return this.state;
  }
}
