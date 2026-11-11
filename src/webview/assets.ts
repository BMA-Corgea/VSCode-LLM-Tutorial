// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `vscode` half of T-40: turning the packaged icon font into what a page may load. The pure
 * half, the names and paths, is `./codicons.ts`; `./page.ts` writes these strings into the page.
 *
 * Every panel in this extension (the Start form, the Current Step view, the detour narrator) uses
 * BOTH functions here, so the folder a webview may read and the stylesheet it links can never
 * disagree: a link outside the root is a stylesheet VS Code refuses to serve, and a root wider
 * than the link is access nobody uses.
 */

import * as vscode from 'vscode';
import { CODICONS_DIST, CODICON_CSS } from './codicons.js';
import type { PageAssets } from './page.js';

function within(extensionUri: vscode.Uri, relative: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...relative.split('/'));
}

/**
 * The webview's ONLY `localResourceRoots` entry: the codicons' `dist/`, nothing above it.
 *
 * Each panel used to grant nothing at all (step view, narrator) or, by leaving the option unset,
 * VS Code's default, which is the extension's whole install plus every open workspace folder (the
 * Start form). Both are replaced by this one folder, which holds the font, its stylesheet and
 * nothing a repository the learner has open could have put there.
 */
export function codiconsRoot(extensionUri: vscode.Uri): vscode.Uri {
  return within(extensionUri, CODICONS_DIST);
}

/** What `renderPage` needs from a live webview to link the icon font. */
export function pageAssets(webview: vscode.Webview, extensionUri: vscode.Uri): PageAssets {
  return {
    cspSource: webview.cspSource,
    codiconCss: webview.asWebviewUri(within(extensionUri, CODICON_CSS)).toString(),
  };
}
