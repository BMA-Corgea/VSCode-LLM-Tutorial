// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reading a page's CSS rules in a unit test, without erasing what a selector means.
 *
 * The helpers this replaces squeezed out EVERY space, which also erases the descendant combinator:
 * `:root:not([data-theme]) .field textarea` and `:root:not([data-theme]).fieldtextarea` became the same
 * string, so a rule whose selector a typo had broken (it matches no element) still passed every test that
 * asked for it (T-52's blind review, F1, proved it with two mutants). Here whitespace is collapsed to one
 * space and removed only where it carries no meaning: around `{`, `}`, `;` and `,`, and after a
 * declaration's `:`. A selector keeps its spaces.
 */

/** Every `<style>` block of a page, joined, comments dropped, whitespace normalised as above. */
export function cssOf(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .trim();
}

/** A selector written the way `cssOf` leaves one. */
export function normalSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
}

/**
 * The declarations of every top-level rule whose selector list contains `selector` exactly (normalised as
 * `cssOf` does), joined with `;`, each written `property:value` with no space after the colon.
 */
export function declarationsFor(css: string, selector: string): string {
  const wanted = normalSelector(selector);
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    if (selectors.includes(wanted)) out.push(m[2]!.replace(/\s*:\s*/g, ':'));
  }
  return out.join(';');
}
