// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * VS Code's own icons (codicons) for every webview in this extension (T-40; T-16's audit, F-13
 * and F-14). Pure: no `vscode` here, so the pages, the panels (`./assets.ts`) and the packaging
 * check (`src/publish/disclosure.ts`) all read the same names and paths.
 *
 * **Shipped inside the extension, never fetched from the network.** The font is the
 * `@vscode/codicons` npm package's own `dist/codicon.ttf`, packaged in the `.vsix` (`.vscodeignore`
 * trims the package to the files below) and served from the webview's own resource origin.
 *
 * **The font is the only thing a page loads, and nothing waits for it** (T-40's review, F2 and
 * F3). The package's `codicon.css` is NOT linked: a stylesheet in `<head>` holds the page's one
 * script until it has been fetched, and for that long every button is on screen with no listener,
 * so a press on a freshly drawn page was lost. Instead the few rules the pages need, adapted from
 * that stylesheet (MIT, its `LICENSE-CODE` ships beside the font), are inlined into the page's own
 * nonce'd `<style>` by `codiconPageCss`. A font holds neither the script nor the words, and every
 * icon's box is a fixed 16 px, so its arrival moves nothing on the page either.
 *
 * **Every icon is decoration.** The words beside it carry the meaning, so an icon is an empty,
 * `aria-hidden` span: a screen reader reads "Previous", never a private-use character, and every
 * `textContent` a test or a script reads is exactly what it was before the icon arrived. The one
 * exception to "no meaning" is the spinner, whose meaning is that something is still happening;
 * the waiting words beside it ("thinking…") already say so.
 */

/** Where the package's built files live, relative to the extension's root. The webview may read
 *  this folder and nothing else (`localResourceRoots`). */
export const CODICONS_DIST = 'node_modules/@vscode/codicons/dist';
/** The font every icon is drawn in, relative to the extension's root. */
export const CODICON_FONT = `${CODICONS_DIST}/codicon.ttf`;
/** CC-BY-4.0, the icons' and the font's licence, which asks that it travel with them. */
export const CODICONS_LICENCE = 'node_modules/@vscode/codicons/LICENSE';
/** MIT, the licence of `codicon.css`, which the rules in `codiconPageCss` are adapted from. */
export const CODICONS_CODE_LICENCE = 'node_modules/@vscode/codicons/LICENSE-CODE';

/**
 * The icons these pages draw, by codicon name, and each one's code point in the font. A closed list
 * on purpose: a name that is not in the font renders as nothing at all, silently, so every name AND
 * code point here is checked against the shipped `codicon.css` (`test/unit/codicons.test.ts`): a
 * codicons update that moved a glyph fails there, not on a learner's screen. The choices follow VS
 * Code's own:
 *
 *   - `loading` + spin: the workbench's own busy indicator (`$(loading~spin)`);
 *   - `pass` and `error`: the Testing view's marks for a passed and a failed test;
 *   - `arrow-left` and `arrow-right`: this extension's own Previous and Next in the view title
 *     (`package.json`), so the panel's buttons and the title bar's arrows are the same icon.
 */
export const CODICON_GLYPHS = {
  loading: 'eb19',
  pass: 'eba4',
  error: 'ea87',
  'arrow-left': 'ea9b',
  'arrow-right': 'ea9c',
} as const;

export type CodiconName = keyof typeof CODICON_GLYPHS;

/** Which side of its words an icon sits on: `lead` before them, `trail` after (Next's arrow). */
export type CodiconSide = 'lead' | 'trail';

export interface CodiconOptions {
  /** Turns, for a wait. Stopped by `codiconPageCss` wherever motion is unwelcome. */
  spin?: boolean;
}

/** One decorative icon, for the caller to put on the `side` of the words it decorates. */
export function codicon(name: CodiconName, side: CodiconSide, options: CodiconOptions = {}): string {
  const spin = options.spin === true ? ' codicon-modifier-spin' : '';
  return `<span class="codicon codicon-${name}${spin} icon-${side}" aria-hidden="true"></span>`;
}

/**
 * The page's icon sheet, inlined by `renderPage` (so it carries the page's nonce) on every page that
 * may draw an icon. `fontUri` is the font's `asWebviewUri`; `renderPage` has already refused one that
 * could break out of its `url("…")`.
 *
 * **From `codicon.css`, adapted** (MIT): the `@font-face` (with `font-display: block`, so a glyph
 * never shows as the wrong character while the font is on its way), the base rule, the spin and the
 * five glyphs this extension draws. The spin's timing is the one VS Code gives its loading icon
 * (`codicon.css` sets it with `!important`; here nothing competes with it, so nothing needs that).
 *
 * **A fixed box** (the review's F2): `width:16px` and `line-height:12px` on an inline block, so an
 * icon takes the same room before its glyph has loaded as after, and a row of buttons never re-wraps
 * when the font lands. 16 px is every glyph's own width; the 12 px line keeps an iconed button exactly
 * as tall as the buttons beside it (measured: the font's own 16 px line made it 0.93 px taller), with
 * the glyph still drawn at 16 px, centred in the box, so a spin turns about the glyph's own centre.
 * `-3px` puts its centre on the centre of 12 and 13 px words. It sits 4 px from them (a spacing value
 * every iconed page already uses); `lead` and `trail` say which side.
 *
 * **Reduced motion.** `body.vscode-reduce-motion` is VS Code's own signal (the `workbench.reduceMotion`
 * setting, which follows the operating system when it is `auto`; VS Code sets it on a live page);
 * `prefers-reduced-motion` is the operating system's, for a host that does not set the class. Either
 * one stops every spin, with selectors that outrank the spin rule's (three classes to its two), so no
 * `!important`. The icon still shows, still beside its words: only the motion goes.
 */
export function codiconPageCss(fontUri: string): string {
  const glyphs = Object.entries(CODICON_GLYPHS)
    .map(([name, point]) => `.codicon-${name}:before { content:"\\${point}"; }`)
    .join('\n');
  return `
@font-face { font-family:"codicon"; font-display:block; src:url("${fontUri}") format("truetype"); }
.codicon[class*='codicon-'] {
  font:normal normal normal 16px/1 codicon; display:inline-block; width:16px; line-height:12px; vertical-align:-3px;
  text-decoration:none; text-rendering:auto; text-align:center; text-transform:none;
  -webkit-font-smoothing:antialiased; user-select:none; -webkit-user-select:none;
}
${glyphs}
.codicon[class*='codicon-'].icon-lead { margin-right:4px; }
.codicon[class*='codicon-'].icon-trail { margin-left:4px; }
@keyframes codicon-spin { 100% { transform:rotate(360deg); } }
.codicon-loading.codicon-modifier-spin { animation:codicon-spin 1s cubic-bezier(0.53, 0.21, 0.29, 0.67) infinite; }
body.vscode-reduce-motion .codicon[class*='codicon-'].codicon-modifier-spin { animation:none; }
@media (prefers-reduced-motion: reduce) {
  .codicon[class*='codicon-'].codicon-modifier-spin { animation:none; }
}
`;
}
