// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Text from outside this extension, made safe to show in a VS Code notification (T-72 security
 * review, finding 1).
 *
 * VS Code reads an extension's notification text for links. A `[label](target)` whose target starts
 * `command:`, `http://`, `https://` or `file:` is drawn as a link, and a click on a `command:` link
 * runs that command with the arguments the text chose. So a sentence that quotes a name a reference
 * repository chose can carry a live command. That was driven in the pinned 1.145.2: a nested folder
 * named `[Remove the link for me](command:…)` was quoted in T-72's refusal, the notification drew it
 * as a link, and one click on it ran the command.
 *
 * VS Code's parser is one regular expression (`parseLinkedText` in `vs/base/common/linkedText.ts`;
 * `jk` in the 1.145.2 bundle):
 *
 *   /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi
 *
 * Before it runs, `NotificationViewItem.parseNotificationMessage` cuts the text to 1,000 characters,
 * turns each line break into one space and trims the ends. Every link the expression can find has a
 * `]` directly followed by a `(`, and none of those three steps puts one there. So a zero-width space
 * between every `]` and the `(` after it leaves the words looking the same and leaves the parser
 * nothing to find.
 *
 * Only for notifications. A webview line set with `textContent`, such as the start screen's problem
 * lines, is never parsed, and gets the text as it is.
 */

/** U+200B ZERO WIDTH SPACE: invisible, and not something VS Code removes before it parses. */
const BREAK = '​';

/** `text` with no `](` left in it, so no part of it can become a link in a notification. */
export function neutraliseLinks(text: string): string {
  return text.replaceAll('](', `]${BREAK}(`);
}
