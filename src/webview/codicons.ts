// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * VS Code's own icons (codicons) for every webview in this extension (T-40; T-16's audit, F-13
 * and F-14). Pure: no `vscode` here, so the pages, the panels (`./assets.ts`) and the packaging
 * check (`src/publish/disclosure.ts`) all read the same names and paths.
 *
 * **Shipped inside the extension, never fetched.** The font and its stylesheet are the
 * `@vscode/codicons` npm package's own `dist/`, packaged in the `.vsix` (`.vscodeignore` trims the
 * package to the files below) and served from the webview's own resource origin. A page never
 * names a CDN, and its CSP could not reach one if it tried (`./page.ts`).
 *
 * **Every icon is decoration.** The words beside it carry the meaning, so an icon is an empty,
 * `aria-hidden` span: a screen reader reads "Previous", never a private-use character, and every
 * `textContent` a test or a script reads is exactly what it was before the icon arrived. The one
 * exception to "no meaning" is the spinner, whose meaning is that something is still happening;
 * the waiting words beside it ("thinking…") already say so.
 */

/** Where the package lives, relative to the extension's root. The webview may read this folder and
 *  nothing else (`localResourceRoots`). */
export const CODICONS_DIST = 'node_modules/@vscode/codicons/dist';
/** The stylesheet a page links, relative to the extension's root. */
export const CODICON_CSS = `${CODICONS_DIST}/codicon.css`;
/** The font that stylesheet loads, relative to it (`./codicon.ttf`). */
export const CODICON_FONT = `${CODICONS_DIST}/codicon.ttf`;
/** CC-BY-4.0, the icons' and the font's licence, which asks that it travel with them. */
export const CODICONS_LICENCE = 'node_modules/@vscode/codicons/LICENSE';
/** MIT, the stylesheet's licence (its header says so), which asks the same. */
export const CODICONS_CODE_LICENCE = 'node_modules/@vscode/codicons/LICENSE-CODE';

/**
 * The icons these pages draw, by codicon name. A closed list on purpose: a name that is not in the
 * font renders as nothing at all, silently, so every name here is checked against the shipped
 * `codicon.css` (`test/unit/codicons.test.ts`). The choices follow VS Code's own:
 *
 *   - `loading` + spin: the workbench's own busy indicator (`$(loading~spin)`);
 *   - `pass` and `error`: the Testing view's marks for a passed and a failed test;
 *   - `arrow-left` and `arrow-right`: this extension's own Previous and Next in the view title
 *     (`package.json`), so the panel's buttons and the title bar's arrows are the same icon.
 */
export type CodiconName = 'loading' | 'pass' | 'error' | 'arrow-left' | 'arrow-right';

/** Which side of its words an icon sits on: `lead` before them, `trail` after (Next's arrow). */
export type CodiconSide = 'lead' | 'trail';

export interface CodiconOptions {
  /** Turns, for a wait. Stopped by `CODICON_PAGE_CSS` wherever motion is unwelcome. */
  spin?: boolean;
}

/** One decorative icon, for the caller to put on the `side` of the words it decorates. */
export function codicon(name: CodiconName, side: CodiconSide, options: CodiconOptions = {}): string {
  const spin = options.spin === true ? ' codicon-modifier-spin' : '';
  return `<span class="codicon codicon-${name}${spin} icon-${side}" aria-hidden="true"></span>`;
}

/**
 * Inlined by `renderPage` on every page that links the font, so no page can draw a spinner without
 * the rule that stops it.
 *
 * **Reduced motion.** `body.vscode-reduce-motion` is VS Code's own signal (the
 * `workbench.reduceMotion` setting, which follows the operating system when it is `auto`);
 * `prefers-reduced-motion` is the operating system's, for any host that does not set the class.
 * Either one stops every spin. The selectors carry three classes, one more than codicon.css's own
 * spin rule (`.codicon-loading.codicon-modifier-spin`), so they win on specificity and need no
 * `!important`. The icon still shows, still beside its words: only the motion goes.
 *
 * **Placement.** An icon sits 4 px from its words (a spacing value every page with an icon
 * already uses) and centred on them, as the workbench centres the icons in its own buttons.
 * Measured headless on these pages, not guessed: a 16 px icon at its own line height made every
 * button that carries one 0.93 px taller than the buttons beside it, and `vertical-align: middle`
 * sat it 1.5 px below its words. A 12 px line height keeps the line, and so the button, exactly as
 * tall as before; the glyph still draws at 16 px, centred in that box (so a spin turns about the
 * glyph's own centre: no wobble), and `-3px` puts its centre on the centre of 12 and 13 px words.
 * `lead` and `trail` say which side of the words it is on.
 */
export const CODICON_PAGE_CSS = `
.codicon[class*='codicon-'] { vertical-align:-3px; line-height:12px; }
.codicon[class*='codicon-'].icon-lead { margin-right:4px; }
.codicon[class*='codicon-'].icon-trail { margin-left:4px; }
body.vscode-reduce-motion .codicon[class*='codicon-'].codicon-modifier-spin { animation:none; }
@media (prefers-reduced-motion: reduce) {
  .codicon[class*='codicon-'].codicon-modifier-spin { animation:none; }
}
`;
