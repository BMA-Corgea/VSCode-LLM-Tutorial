// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The extension side of the skin contract (spec §5.7, T-1). repo-tour's own `src/skins.ts`
 * ships `baseCss()` + `alternateCss()` (the tokens, the component layer, every named skin)
 * and `SKINS` / `DEFAULT_SKIN` (the registry) — this extension inlines those UNCHANGED into
 * every webview, exactly as repo-tour's own pages do (T-1 §5.7: "one file, both front ends").
 *
 * What THIS file adds, on top of what repo-tour ships:
 *
 *   - `bridgeCss()` — a stylesheet repo-tour has no reason to know about: it redefines every
 *     one of repo-tour's own base tokens (the names `assets/skins/base.css` declares on its
 *     bare `:root`) to point at VS Code's own `--vscode-*` theme variables, scoped under
 *     `:root:not([data-theme])`. A real skin (`dark`, `gunmetal`, …) sets `data-theme` and
 *     that attribute selector beats this one on specificity — untouched. Only when NO skin
 *     is chosen (`System`, the default) does this sheet win, which is what makes System mean
 *     "follow the editor theme" rather than "repo-tour's own light/dark media query."
 *   - `readSkin` / `writeSkin` — the choice lives in `globalState` (per person, on this
 *     machine, across every project — the same scope repo-tour's own choice has via
 *     localStorage), never in a workspace setting.
 *   - `pickerHtml` — this extension's own switcher markup. It is driven entirely by
 *     whatever `SKINS` rows repo-tour hands it: a new skin is one CSS file in
 *     `repo-tour/assets/skins/` plus one `SKINS` row, and it appears here with no change to
 *     this file (AC6).
 */

import { escapeAttr, escapeHtml } from './webview/html.js';

/** The shape `repo-tour/skins`' `SKINS` rows have — duck-typed so this file never imports repo-tour. */
export interface SkinRow {
  readonly name: string;
  readonly label: string;
  readonly note: string;
}

/** Structurally `vscode.Memento` — duck-typed so this file stays testable with no `vscode` import. */
export interface SkinStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** `vscode.Memento.update` returns this; declared locally to avoid importing `vscode` for one type. */
type Thenable<T> = PromiseLike<T>;

const SKIN_KEY = 'buildTutorials.skin';

/** The stored choice, or `fallback` (pass repo-tour's own `DEFAULT_SKIN`) when nothing is stored yet. */
export function readSkin(store: SkinStore, fallback: string): string {
  return store.get(SKIN_KEY, fallback);
}

export function writeSkin(store: SkinStore, name: string): Thenable<void> {
  return store.update(SKIN_KEY, name);
}

/**
 * Every base token `assets/skins/base.css` declares on its bare `:root`, mapped to a real
 * `--vscode-*` theme variable (or, for the handful with no sensible theme analogue, a plain
 * static value — `--radius`, the two shadow tokens). Exported (not just used internally) so
 * a test can walk it directly rather than re-parsing `bridgeCss()`'s own output.
 *
 * Most entries carry a `var(--vscode-X, var(--vscode-Y))` fallback chain rather than a bare
 * reference: several of the VS Code theme colours used here (`button.border`,
 * `input.border`, `editor.findMatchHighlightBorder`) are legitimately unset in many themes,
 * and an unset custom property makes the PROPERTY USING it invalid at computed-value time —
 * silently dropping, say, a border colour — rather than merely rendering as transparent. The
 * fallback keeps every one of these landing on a variable that VS Code always defines.
 *
 * Where repo-tour uses a token for source-code syntax colour (`--kw` keyword, `--str`
 * string, `--num` number, `--fn` function, `--dec` decorator), the closest VS Code analogue
 * is one of the `symbolIcon.*Foreground` theme colours — designed for outline/breadcrumb
 * icons, not syntax highlighting, but the only per-kind colours VS Code themes commit to.
 * `--com` (comment) has no symbol-kind analogue at all — a comment is not a symbol — so it
 * borrows `editorLineNumber.foreground`, chosen for the same quiet, de-emphasised role.
 */
export const BRIDGE_TOKEN_MAP: Readonly<Record<string, string>> = Object.freeze({
  // surfaces
  '--bg': 'var(--vscode-editor-background)',
  '--canvas': 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
  '--chip': 'var(--vscode-list-hoverBackground, var(--vscode-editorWidget-background))',
  // text
  '--ink': 'var(--vscode-foreground)',
  '--muted': 'var(--vscode-descriptionForeground, var(--vscode-foreground))',
  '--line': 'var(--vscode-panel-border, var(--vscode-widget-border, var(--vscode-foreground)))',
  '--accent': 'var(--vscode-textLink-foreground)',
  // highlight (a "your eye goes here" background + its edge)
  '--hl': 'var(--vscode-editor-findMatchHighlightBackground, var(--vscode-list-hoverBackground))',
  '--hl-line': 'var(--vscode-editor-findMatchHighlightBorder, var(--vscode-focusBorder))',
  // syntax colour — see file header for why these are the closest real analogues
  '--kw': 'var(--vscode-symbolIcon-keywordForeground, var(--vscode-textLink-foreground))',
  '--str': 'var(--vscode-symbolIcon-stringForeground, var(--vscode-terminal-ansiGreen, var(--vscode-foreground)))',
  '--com': 'var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))',
  '--num': 'var(--vscode-symbolIcon-numberForeground, var(--vscode-terminal-ansiCyan, var(--vscode-foreground)))',
  '--fn': 'var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground))',
  '--dec': 'var(--vscode-symbolIcon-constantForeground, var(--vscode-terminal-ansiMagenta, var(--vscode-foreground)))',
  // form fields
  '--field-bg': 'var(--vscode-input-background)',
  '--field-edge': 'var(--vscode-input-border, var(--vscode-panel-border, var(--vscode-foreground)))',
  '--focus': 'var(--vscode-focusBorder)',
  '--focus-ring': 'color-mix(in srgb, var(--vscode-focusBorder) 25%, transparent)',
  // buttons — repo-tour's plain `.btn` maps to VS Code's SECONDARY button; `.btn.primary`
  // (the `--accent-solid*` tokens below) maps to VS Code's primary (colour-filled) button.
  '--btn-bg': 'var(--vscode-button-secondaryBackground, var(--vscode-button-background))',
  '--btn-bg-hover': 'var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground))',
  '--btn-edge': 'var(--vscode-button-border, transparent)',
  '--btn-edge-hover': 'var(--vscode-focusBorder)',
  '--btn-ink': 'var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))',
  // VS Code's own buttons are flat — no drop shadow in any shipped theme — so the bridge
  // follows that convention rather than inventing a shadow VS Code itself never draws.
  '--btn-shadow': 'none',
  '--btn-shadow-primary': 'none',
  '--accent-solid': 'var(--vscode-button-background)',
  '--accent-solid-hover': 'var(--vscode-button-hoverBackground)',
  '--accent-solid-edge': 'var(--vscode-button-border, var(--vscode-button-background))',
  '--accent-solid-ink': 'var(--vscode-button-foreground)',
  '--accent-soft': 'color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent)',
  // shape — VS Code defines no corner-radius theme colour (it is not a colour); a small,
  // native-feeling static value stands in.
  '--radius': '4px',
});

/**
 * The bridge sheet: every `BRIDGE_TOKEN_MAP` entry, once, under `:root:not([data-theme])`.
 * Meant to be inlined AFTER repo-tour's own `baseCss()` + `alternateCss()` (source order
 * decides ties at equal specificity — see the file header) — `renderPage` does this.
 */
export function bridgeCss(): string {
  const decls = Object.entries(BRIDGE_TOKEN_MAP)
    .map(([token, value]) => `  ${token}: ${value};`)
    .join('\n');
  return `/* T-3: bridges repo-tour's base tokens to VS Code's theme so System follows the editor. */\n:root:not([data-theme]) {\n${decls}\n}\n`;
}

/**
 * This extension's switcher markup — repo-tour's own `skinPicker()`, minus the localStorage
 * wiring (the choice round-trips through `globalState` on the extension host instead; see
 * `src/webview/page.ts`'s client script for the `skin:set` message this posts on change).
 * Reuses repo-tour's own `.skinpick` class so it is styled by `baseCss()` for free.
 */
export function pickerHtml(skins: readonly SkinRow[], current: string): string {
  const options = skins
    .map((s) => {
      const selected = s.name === current ? ' selected' : '';
      return `<option value="${escapeAttr(s.name)}" title="${escapeAttr(s.note)}"${selected}>${escapeHtml(s.label)}</option>`;
    })
    .join('');
  return `<select class="skinpick" id="skinpick" name="skin" aria-label="Skin">${options}</select>`;
}
