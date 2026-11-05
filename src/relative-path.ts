// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The LEXICAL rule for a relative path a MODEL chose, which is about to become a real file —
 * one rule, shared by every writer of model-chosen paths (T-17 hoist).
 *
 * It started life as the detour's `unsafeDetourPathReason` (T-7), and every word of its
 * reasoning is still the detour's, recorded at `src/detour/prompt.ts`. The header and the tests
 * there are what this function answers to. It moved here, unchanged except for three arguments,
 * because the derivation engine (T-17) is a second writer of model-chosen paths. **Two writers
 * must not hold two attack lists**: the day one list learns a new attack, the other is the hole.
 * The three arguments are the only things that ever differed between the two callers:
 *
 *   - `folder`   — the name a refusal uses for where the file would have gone ("detour folder"),
 *                  so the sentence a learner reads still names the right place;
 *   - `maxChars` / `maxSegments` — each caller's own bounds, each with its own reason at its
 *                  definition.
 *
 * The named attacks are checked before the allowlist so the sentence names what was actually
 * wrong; the allowlist is the backstop and would refuse every one of them on its own.
 *
 * **This is the lexical half of containment and only that half.** It cannot see a symlink. Every
 * caller pairs it with a filesystem check (`realpath` on the destination's parent) before it
 * writes, and T-5's merge-blocking HIGH is what happens when one is mistaken for the other.
 *
 * No `vscode` import: the plain-mocha unit bundle marks `vscode` as NOT external, so one import
 * would break the whole suite (`src/dial/writer.ts`'s header).
 */

import path from 'node:path';
import { resolveInsideTarget } from './walk/paths.js';

/** Windows opens these as devices whatever the extension, so `CON` and `nul.txt` are a write
 *  to the console rather than to a file. Cheap to refuse and never a legitimate file name. */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** The allowlist. Underscore leads legitimately (`__init__.py`); a dash does not, because a
 *  leading dash is how a filename becomes a command-line flag. */
const SEGMENT_ALLOWED = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** What each caller decides for itself — see the header. */
export interface RelativePathRules {
  /** How a refusal names the place the file would have gone, e.g. `'detour folder'`. */
  folder: string;
  maxChars: number;
  maxSegments: number;
}

/** What a non-string is, in words — never `String(value)`, which runs a `toString` a model
 *  supplied and would print `[object Object]` at best. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Why `value` may not become a file under the caller's folder, or `null` if it may — the LEXICAL
 * half. See the header for what it does not cover.
 */
export function unsafeRelativePathReason(value: unknown, rules: RelativePathRules): string | null {
  if (typeof value !== 'string') return `is ${describe(value)}, not a string`;
  if (value.length === 0) return 'is empty';
  if (value.trim().length === 0) return 'is only whitespace';
  if (value.length > rules.maxChars) return `is longer than ${rules.maxChars} characters`;
  if (value.includes('\u0000')) return 'contains a NUL byte';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'contains a control character';
  }
  if (/^[A-Za-z]:/.test(value)) return 'names a Windows drive letter';
  if (/^(?:\/\/|\\\\)/.test(value)) return 'is a UNC path';
  if (value.startsWith('/') || path.isAbsolute(value)) return 'is an absolute path';
  if (value.includes('\\')) return 'contains a backslash, which is a path separator on Windows';
  if (value.endsWith('/')) return 'ends with a path separator, so it names a directory rather than a file';

  const segments = value.split('/');
  if (segments.length > rules.maxSegments) return `is nested more than ${rules.maxSegments} directories deep`;
  for (const segment of segments) {
    if (segment.length === 0) return 'has an empty path segment';
    if (segment === '..') return `contains a ".." segment, which climbs out of the ${rules.folder}`;
    if (segment === '.') return 'contains a "." segment';
    if (segment.startsWith('.')) return 'has a segment beginning with a dot';
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'has a segment ending in a dot or a space, which Windows silently strips';
    if (RESERVED_DEVICE_NAMES.has((segment.split('.')[0] ?? '').toLowerCase())) return 'names a reserved Windows device';
    if (!SEGMENT_ALLOWED.test(segment)) return 'has a segment with characters outside letters, digits, dot, dash and underscore';
  }

  // Belt and braces. Nothing that survived the allowlist can escape a root arithmetically —
  // but this is the repository's own containment check, it is free, and the day a rule above
  // is loosened it is the one that still says no. The root's name is irrelevant to the
  // arithmetic; only the caller's word for it reaches a sentence.
  if (resolveInsideTarget(path.resolve('/contained'), value) === null) return `does not resolve inside the ${rules.folder}`;
  return null;
}
