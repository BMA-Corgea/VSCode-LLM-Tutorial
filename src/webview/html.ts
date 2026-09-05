// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The only place this extension escapes text into HTML. Every webview (start screen now;
 * the step panel and tutor later — T-4 … T-6) renders host-controlled strings — a folder
 * path, an idea's free text, a skin's label — into markup it also has to keep safe from
 * breaking out of an attribute or a text node. One pair of pure functions, reused everywhere,
 * beats each webview inventing its own escaping and one of them getting it wrong.
 */

/** Safe inside a text node (between tags). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Safe inside a double-quoted attribute value. */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
