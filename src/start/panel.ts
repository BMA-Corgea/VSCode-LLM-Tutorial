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
import { emptyRequest, type BuildRequest, type RequestField } from './request.js';
import {
  handleStartMessage, type InboundMessage, type OutboundMessage, type PanelState, type PickTarget, type StartEffects,
} from './protocol.js';
import { renderStartHtml, type SkinsModule } from './view.js';

const VIEW_TYPE = 'buildTutorials.start';
const VIEW_TITLE = 'Build Tutorials: Start';

export interface StartPanelDeps {
  /** repo-tour's own skins module (SKINS, DEFAULT_SKIN, baseCss, alternateCss), loaded via loadCore. */
  skins: SkinsModule & { DEFAULT_SKIN: string };
  /** Called on a validated form:submit. Fire-and-forget from the panel's own point of view. */
  onSubmit(request: BuildRequest): void;
}

export class StartPanel {
  private static current: StartPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly effects: StartEffects;
  private state: PanelState;

  private constructor(context: vscode.ExtensionContext, private readonly deps: StartPanelDeps) {
    const skin = readSkin(context.globalState, deps.skins.DEFAULT_SKIN);
    this.state = { request: emptyRequest(), problems: {}, skin };

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
      submit: (request) => this.deps.onSubmit(request),
      persistSkin: (name) => { void writeSkin(context.globalState, name); },
    };

    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, VIEW_TITLE, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    this.render();

    this.panel.webview.onDidReceiveMessage((message: InboundMessage) => { void this.onMessage(message); }, undefined, context.subscriptions);
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

  private render(): void {
    this.panel.webview.html = renderStartHtml(this.state, this.deps.skins);
  }

  private async onMessage(message: InboundMessage): Promise<OutboundMessage | undefined> {
    const { state, post } = await handleStartMessage(this.state, message, this.effects);
    this.state = state;
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
   */
  dispatchForTest(message: InboundMessage): Promise<OutboundMessage | undefined> {
    return this.onMessage(message);
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
