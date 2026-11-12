// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `vscode` half of T-40: turning the packaged icon font into what a page may load. The pure
 * half, the names and paths, is `./codicons.ts`; `./page.ts` writes these strings into the page.
 *
 * Every panel in this extension (the Start form, the Current Step view, the detour narrator) uses
 * BOTH functions here, so the folder a webview may read and the font its page names can never
 * disagree: a font outside the root is one VS Code refuses to serve, and a root wider than the font
 * is access nobody uses.
 */

import * as vscode from 'vscode';
import { CODICONS_DIST, CODICON_FONT } from './codicons.js';
import type { PageAssets } from './page.js';

function within(extensionUri: vscode.Uri, relative: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...relative.split('/'));
}

/**
 * The webview's ONLY `localResourceRoots` entry: the codicons' `dist/`, nothing above it.
 *
 * Each panel used to grant nothing at all (step view, narrator) or, by leaving the option unset,
 * VS Code's default, which is the extension's whole install plus every open workspace folder (the
 * Start form). Both are replaced by this one folder: in the `.vsix`, the font and nothing else (in a
 * development checkout, the package's other built files too), and nothing a repository the learner
 * has open could have put there. The pages fetch the font alone (`./codicons.ts` says why its
 * stylesheet's rules are inlined rather than linked).
 */
export function codiconsRoot(extensionUri: vscode.Uri): vscode.Uri {
  return within(extensionUri, CODICONS_DIST);
}

/** What `renderPage` needs from a live webview to draw the icon font. */
export function pageAssets(webview: vscode.Webview, extensionUri: vscode.Uri): PageAssets {
  return {
    cspSource: webview.cspSource,
    codiconFont: webview.asWebviewUri(within(extensionUri, CODICON_FONT)).toString(),
  };
}
