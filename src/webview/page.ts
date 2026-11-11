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
 * **The one thing a page loads instead of inlining** (T-40): VS Code's own icon font. A panel
 * that hands over `assets` gets `codicon.css` linked from the extension's own install, and the
 * CSP widened by exactly the webview's own origin (`webview.cspSource`) for styles and fonts:
 * nothing else, and never for scripts. A panel that hands over nothing gets the page this shell
 * always drew. See `./codicons.ts` for what ships and why every icon is decoration.
 *
 * Client script lives inside a TS template literal (repo-tour lesson, T-3, 2026-08-26: a
 * stray escape here renders a page that does nothing and says nothing about why) — every
 * caller's script is parsed with `new Function` in test/unit/page.test.ts.
 */

import { randomBytes } from 'node:crypto';
import { CODICON_PAGE_CSS } from './codicons.js';
import { escapeAttr, escapeHtml } from './html.js';

/**
 * What a page may load from the extension's own install (T-40), built by the panel from its live
 * `vscode.Webview` (`./assets.ts`) and handed in as two strings, so this module stays pure.
 */
export interface PageAssets {
  /** `webview.cspSource`: the one origin this page may take a stylesheet or a font from. */
  cspSource: string;
  /** `webview.asWebviewUri(…)` of the packaged `codicon.css`, as a string. */
  codiconCss: string;
}

/**
 * What a `cspSource` may look like: one or more CSP source expressions (`https://*.vscode-cdn.net`,
 * `'self'`), separated by single spaces. Anything else (a `;`, a quote that is not a keyword's, a
 * comma, a newline) could close the directive and open another, so the page is drawn without the
 * icons rather than under a policy nobody wrote. VS Code's own value always matches.
 */
const CSP_SOURCE_LIST = /^[A-Za-z0-9*+.:/'_-]+(?: [A-Za-z0-9*+.:/'_-]+)*$/;

/** The assets this page will actually use: all of them, or none when either string is unusable. */
function usableAssets(assets: PageAssets | undefined): PageAssets | undefined {
  if (!assets) return undefined;
  if (typeof assets.cspSource !== 'string' || !CSP_SOURCE_LIST.test(assets.cspSource)) return undefined;
  if (typeof assets.codiconCss !== 'string' || assets.codiconCss === '') return undefined;
  return assets;
}

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
  /**
   * T-40: the icon font, when the panel has a webview to serve it from. Optional so a page
   * rendered with no webview at all (a unit test, the design-polish harness) is the page it always
   * was: every icon is decoration, so a page without the font loses no words.
   */
  assets?: PageAssets;
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
  const assets = usableAssets(opts.assets);
  // With the icon font: styles and fonts may also come from the webview's own origin, which is
  // where codicon.css and the codicon.ttf it names are served from. Scripts never may.
  const csp = (assets
    ? ["default-src 'none'", `style-src 'nonce-${n}' ${assets.cspSource}`, `font-src ${assets.cspSource}`, `script-src 'nonce-${n}'`]
    : ["default-src 'none'", `style-src 'nonce-${n}'`, `script-src 'nonce-${n}'`]
  ).join('; ');
  const script = `${bootstrapScript()}\n${opts.script}`;
  // Ahead of every inlined sheet, so a page's own rules override codicon.css's at equal specificity.
  const icons = assets
    ? `<link rel="stylesheet" href="${escapeAttr(assets.codiconCss)}">\n<style nonce="${n}">${CODICON_PAGE_CSS}</style>\n`
    : '';

  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${icons}<style nonce="${n}">${opts.coreCss}</style>
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
