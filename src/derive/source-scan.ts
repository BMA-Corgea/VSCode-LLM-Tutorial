// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A file's code with its comments gone and the inside of its strings blanked (T-17), so a check
 * that looks for a word in code does not read the word in a sentence, and a `//` inside a string
 * does not hide the code after it. Quotes are kept: `import('')` still says "one plain string".
 *
 * Lexical on purpose and not a parser: a regular expression holding a quote can confuse it for the
 * rest of that line, or, with a backtick, further. It errs towards reading less, and what it serves
 * is a correctness check, never a sandbox.
 *
 * No `vscode` import — see `./types.ts`.
 */

import type { DeriveLanguage } from './types.js';

function javaScriptCode(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < s.length && s[i] !== c && (c === '`' || s[i] !== '\n')) i += s[i] === '\\' ? 2 : 1;
      if (s[i] === c) {
        out += c;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function pythonCode(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      out += `${c}${c}`;
      i += quote.length;
      while (i < s.length) {
        if (s.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        if (quote.length === 1 && s[i] === '\n') break;
        i += s[i] === '\\' ? 2 : 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function codeOnly(content: string, language: DeriveLanguage): string {
  return language === 'python' ? pythonCode(content) : javaScriptCode(content);
}
