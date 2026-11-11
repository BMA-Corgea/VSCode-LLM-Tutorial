// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The detour's `vscode` half (T-7, ACs 2 and 3): the narrator webview panel, the real editor
 * tabs the example is read in, and the one thing in this extension that CLOSES a tab.
 *
 * It is to `./session.ts` what `src/walk/step-panel.ts` is to `src/walk/step-view.ts` — the
 * adapter that owns the API surface the pure half deliberately cannot import. `DetourSession`
 * has no `vscode` in it, value or type, so that it can be driven from `test/unit/`; everything
 * that needs a window is a plain function on `DetourAdapters` and lives here.
 *
 * ── `window.tabGroups`, and why the matching is done this way ────────────────────────────────
 *
 * This is the extension's first use of `window.tabGroups`, which the plan named as its
 * write-ahead risk, so the three decisions behind it are written down rather than left to be
 * re-derived:
 *
 *   - **Only `TabInputText` tabs are considered.** A tab's `input` is a union — text, notebook,
 *     diff, custom, webview, terminal — and only the text arm carries a `uri` at all. A diff
 *     tab has TWO uris and neither is "the file this tab is", so a detour file opened as one
 *     side of a diff is deliberately not matched: closing it would take the learner's own file
 *     down with it. It is reported as a tab that did not close, which is the honest outcome.
 *   - **The comparison is on `fsPath`, under a directory prefix, with a separator.** A plain
 *     `startsWith(dir)` matches `…/detours/abc123-notes.md` as though it were inside
 *     `…/detours/abc123`, which is the classic prefix bug and here it would mean closing a tab
 *     that is not the detour's. So the prefix compared against is `dir + path.sep`.
 *   - **Both spellings of the directory are matched.** `DetourSession.tabPrefixes` explains it
 *     in full: the tabs are opened at paths under the RESOLVED storage directory, the composed
 *     one is what `store.ts` hands out, and on macOS those genuinely differ for every honest
 *     detour. `removeDetourAt` compares against both for the same reason.
 *
 * **`tabGroups.close` is not a guarantee.** It resolves `false` when a tab declines to close —
 * an unsaved buffer raising the modal save prompt is the ordinary way — so this re-reads the
 * open tabs afterwards and reports what is still there. `DetourSession.closeOpen` turns that
 * into a sentence naming the tab. A `void`-returning "close them" adapter would have made the
 * honest-controls rule unimplementable one layer up.
 *
 * ── The narrator ────────────────────────────────────────────────────────────────────────────
 *
 * One `WebviewPanel`, beside the code rather than over it, rendering `renderNarratorHtml` —
 * model-authored text, escaped there, under `renderPage`'s nonce CSP with `localResourceRoots`
 * set to one folder, the packaged icon font's (T-40), for the reason `step-panel.ts` gives at
 * length: unset does not mean "no roots", it means the extension directory plus every open
 * workspace folder, and this page draws strings a model wrote about a repository the learner
 * pointed us at.
 *
 * Its three messages (`detour:prev`, `detour:next`, `detour:back`) are parsed by
 * `parseNarratorMessage` before anything acts on them, never read off the raw event — the same
 * rule `step-panel.ts`'s `onMessage` follows, and for the same reason: a `postMessage` is
 * untyped at run time.
 *
 * The learner closing the narrator tab by hand is `onDidDispose`, and it is routed to the same
 * `back` the button posts. A narrator closed with the detour's files still open would leave
 * five tabs of an example with nothing to explain them and no way back but the panel — which
 * is a control that stopped working rather than a control that was never there.
 */

import path from 'node:path';
import * as vscode from 'vscode';
import type { SkinsModule } from '../start/view.js';
import { codiconsRoot, pageAssets } from '../webview/assets.js';
import { parseNarratorMessage, renderNarratorHtml, type NarratorViewState } from './narrator.js';
import type { DetourAdapters } from './session.js';

/** Must not collide with `StepViewProvider.viewType` or the start screen's. */
const NARRATOR_VIEW_TYPE = 'buildTutorials.detour';

const NARRATOR_TAB_TITLE = 'Detour';

/** What the narrator's buttons ask the walk to do. Named rather than passed as three
 *  callbacks so a caller cannot wire *Next* to *Back* by argument order. */
export interface NarratorHandlers {
  prev(): void;
  next(): void;
  back(): void;
}

/**
 * The narrator webview, created on first show and reused afterwards.
 *
 * Reused rather than recreated per stop because a fresh panel per *Next* would steal focus and
 * flash on every press; `webview.html` is reassigned instead, which is what every other
 * surface in this extension does.
 */
export class NarratorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  /**
   * Panels THIS object disposed, so the `onDidDispose` each one raises is not routed back as
   * the learner having pressed *Back to my build* — which would re-enter a return that is
   * already running.
   *
   * A set keyed on the panel rather than a `closing` boolean around the `dispose()` call, and
   * the difference is not style: VS Code does not promise `onDidDispose` fires synchronously,
   * so a flag cleared in a `finally` is cleared before the event it was guarding against
   * arrives. Keying on the object is true whenever the event turns up. A `WeakSet` because
   * the panel is dead either way and nothing here should keep it alive.
   */
  private readonly selfClosed = new WeakSet<vscode.WebviewPanel>();

  /** `extensionUri` (T-40): where the packaged icon font is, the one folder the narrator may read. */
  constructor(
    private readonly handlers: NarratorHandlers,
    private readonly skins: () => SkinsModule | undefined,
    private readonly extensionUri: vscode.Uri,
  ) {}

  show(state: NarratorViewState): void {
    const skins = this.skins();
    // Without repo-tour there is no skin sheet, and a narrator with no styling is not worth
    // opening halfway. The detour's files are still on screen; the session's note says why
    // there is nothing narrating them.
    if (!skins) return;

    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        NARRATOR_VIEW_TYPE,
        NARRATOR_TAB_TITLE,
        // Beside, so the example's own files keep column one and the narration sits next to
        // the code it is about. `preserveFocus` is deliberately NOT set: the narrator is the
        // thing the learner is meant to be reading and driving.
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          // The icon font's folder and nothing else — see `step-panel.ts`. Everything else on
          // this page is inlined by `renderPage`.
          localResourceRoots: [codiconsRoot(this.extensionUri)],
        },
      );
      this.panel = panel;
      this.subscriptions.push(
        panel.webview.onDidReceiveMessage((raw: unknown) => { this.onMessage(raw); }),
        panel.onDidDispose(() => {
          if (this.panel === panel) this.panel = undefined;
          this.disposeSubscriptions();
          // The learner closed the narrator tab themselves. That is *Back to my build* by
          // another gesture, and answering it any other way would leave the example's files
          // open with nothing to explain them.
          if (!this.selfClosed.has(panel)) this.handlers.back();
        }),
      );
    }
    this.panel.webview.html = renderNarratorHtml(state, skins, pageAssets(this.panel.webview, this.extensionUri));
  }

  /**
   * The live narrator's webview, or `undefined` when none is open. For vscode-test only, as
   * `StepViewProvider.webview` is: it is the one way a test can read what this panel GRANTS its page
   * (`options.localResourceRoots`). This panel draws model-authored text, which is why its root has to
   * be pinned and not merely shown to load the font (T-40's review, F5).
   */
  get webview(): vscode.Webview | undefined {
    return this.panel?.webview;
  }

  /** Close it, without the dispose being read as the learner asking to go back. */
  close(): void {
    const panel = this.panel;
    if (!panel) return;
    // Marked BEFORE the dispose, and never unmarked: the event may arrive on this tick or a
    // later one, and the answer is the same whenever it does.
    this.selfClosed.add(panel);
    this.panel = undefined;
    try {
      panel.dispose();
    } finally {
      this.disposeSubscriptions();
    }
  }

  dispose(): void {
    this.close();
  }

  /** Parse, then act — never the other way round (`step-panel.ts`'s rule). Anything that is
   *  not one of the three messages this page speaks is dropped: no throw, because a rejection
   *  raised inside a webview listener has nobody catching it, and no reply. */
  private onMessage(raw: unknown): void {
    const message = parseNarratorMessage(raw);
    if (!message) return;
    if (message.type === 'detour:prev') this.handlers.prev();
    else if (message.type === 'detour:next') this.handlers.next();
    else this.handlers.back();
  }

  private disposeSubscriptions(): void {
    for (const sub of this.subscriptions.splice(0)) sub.dispose();
  }
}

// ── the tabs ────────────────────────────────────────────────────────────────────────────────

/** Is `absPath` inside `dir`? A directory prefix WITH its separator, so `…/abc` never matches
 *  `…/abc-notes.md` — see this file's header. Equality is deliberately not a match: the
 *  directory itself is not one of its files. */
function isUnder(dir: string, absPath: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return absPath.startsWith(prefix);
}

/** Every open text tab whose file sits under one of `prefixes`, paired with its path. Only
 *  `TabInputText` — the one arm of the union that names exactly one file. */
function detourTabs(prefixes: string[]): Array<{ tab: vscode.Tab; fsPath: string }> {
  const found: Array<{ tab: vscode.Tab; fsPath: string }> = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (!(input instanceof vscode.TabInputText)) continue;
      const fsPath = input.uri.fsPath;
      if (prefixes.some((prefix) => isUnder(prefix, fsPath))) found.push({ tab, fsPath });
    }
  }
  return found;
}

/**
 * The real `DetourAdapters` — everything `DetourSession` cannot do without a window.
 *
 * `decorate` is handed in rather than created here so the detour's highlight is the SAME
 * decoration type the walk uses on the learner's own file: one handle for the window's life,
 * and one `clear()` that really clears, which is the whole argument `StepDecorator` makes for
 * owning exactly one.
 */
export function detourAdaptersFor(opts: {
  globalStorageRoot: string;
  narrator: NarratorPanel;
  skin: () => string;
  /** Reveal `startLine`–`endLine` (1-based, inclusive) in `absPath` and highlight it. */
  revealRange: (absPath: string, startLine: number, endLine: number) => Promise<void>;
}): DetourAdapters {
  return {
    globalStorageRoot: opts.globalStorageRoot,

    /**
     * `preview: false` so the tabs STACK. In preview mode VS Code reuses one italic tab, so a
     * three-file example would end as a single tab showing the third file — which is not a
     * worked example, it is a file. `preserveFocus` because the learner is meant to be reading
     * the narrator, not the file that happened to open last.
     */
    openDetourTab: async (absPath: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.One,
      });
    },

    revealDetourStop: (absPath: string, startLine: number, endLine: number) =>
      opts.revealRange(absPath, startLine, endLine),

    /**
     * Close the detour's tabs and nobody else's, and report what would not go.
     *
     * `tabGroups.close` answers `false` when a tab declines — an unsaved buffer is the ordinary
     * way — so the answer is not trusted: the open tabs are re-read and what is still there is
     * returned. That is what lets the session name the tab the learner has to close by hand
     * rather than promising a clean return it did not achieve.
     */
    closeTabsUnder: async (prefixes: string[]) => {
      const tabs = detourTabs(prefixes);
      if (tabs.length > 0) {
        try {
          await vscode.window.tabGroups.close(tabs.map((entry) => entry.tab), true);
        } catch {
          // Whatever went wrong, the re-read below is the authority on what is still open.
        }
      }
      return detourTabs(prefixes).map((entry) => entry.fsPath);
    },

    showNarrator: (state: NarratorViewState) => { opts.narrator.show(state); },
    closeNarrator: () => { opts.narrator.close(); },
    skin: opts.skin,
  };
}
