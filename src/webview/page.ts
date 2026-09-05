// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * renderPage — the one HTML shell every webview in this extension uses (spec §5.1, §5.7).
 *
 * Every webview inlines repo-tour's own `baseCss()` + `alternateCss()` UNCHANGED, plus this
 * extension's bridge sheet (`src/skins.ts` `bridgeCss()`) so `System` follows the editor
 * theme, plus whatever the page itself needs. `data-theme` is stamped onto `<html>` by the
 * HOST — the caller passes the already-resolved skin name — so the very first paint already
 * carries the right theme; there is no client-side "apply the stored skin" step to race
 * (contrast repo-tour's own `skinScript()`, which has to do this in the browser because it
 * has no server-side session to read a stored choice from before sending the page).
 *
 * A nonce CSP (`default-src 'none'`, style/script scoped to one nonce reused for every
 * inline tag on the page) keeps this a normal, safe VS Code webview: no external network,
 * no unscoped inline script.
 *
 * Client script lives inside a TS template literal (repo-tour lesson, T-3, 2026-08-26: a
 * stray escape here renders a page that does nothing and says nothing about why) — every
 * caller's script is parsed with `new Function` in test/unit/page.test.ts.
 */

import { randomBytes } from 'node:crypto';
import { escapeAttr, escapeHtml } from './html.js';

export interface RenderPageOptions {
  title: string;
  /** repo-tour's `baseCss() + alternateCss()`, unmodified. */
  coreCss: string;
  /** this extension's own bridge sheet — `src/skins.ts` `bridgeCss()`. */
  bridgeCss: string;
  /** page-specific component CSS this page alone needs, inlined after the two above. */
  pageCss?: string;
  /** the resolved skin name. `'system'` (repo-tour's own `DEFAULT_SKIN`) omits `data-theme` entirely. */
  skin: string;
  /** the `<body>` markup. */
  body: string;
  /**
   * This page's own client script SOURCE (not wrapped in `<script>` — `renderPage` does
   * that). The bootstrap below (`acquireVsCodeApi`, `post`/`restore`/`save`) is prepended
   * automatically, so every page's script can call those with no setup of its own.
   */
  script: string;
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Prepended to every page's own script. `post` sends a typed message to the extension host;
 * `restore`/`save` wrap `getState`/`setState` — the per-view scratch a webview keeps for
 * itself, so something survives a hidden view being torn down
 * (`retainContextWhenHidden: false`) before the host's own re-render arrives. The host's
 * re-render is still authoritative (spec §5.1: "the host re-renders ... never from the
 * view") — this is a convenience for a view's own transient bits, never a second source of
 * truth for form field values, which this extension always re-derives host-side.
 */
function bootstrapScript(): string {
  return [
    'const vscode = acquireVsCodeApi();',
    'function post(type, payload) { vscode.postMessage({ type: type, payload: payload }); }',
    'function restore() { return vscode.getState() || {}; }',
    'function save(state) { vscode.setState(state); }',
  ].join('\n');
}

export function renderPage(opts: RenderPageOptions): string {
  const n = nonce();
  const themeAttr = opts.skin && opts.skin !== 'system' ? ` data-theme="${escapeAttr(opts.skin)}"` : '';
  const csp = ["default-src 'none'", `style-src 'nonce-${n}'`, `script-src 'nonce-${n}'`].join('; ');
  const script = `${bootstrapScript()}\n${opts.script}`;

  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style nonce="${n}">${opts.coreCss}</style>
<style nonce="${n}">${opts.bridgeCss}</style>
${opts.pageCss ? `<style nonce="${n}">${opts.pageCss}</style>` : ''}
</head>
<body>
${opts.body}
<script nonce="${n}">
${script}
</script>
</body>
</html>`;
}
