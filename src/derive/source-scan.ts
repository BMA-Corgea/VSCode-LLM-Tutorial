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

import type { CodeLanguage } from './types.js';

function javaScriptCode(s: string): string {
  return scanJavaScript(s, 0, false).out;
}

/**
 * Reads JavaScript from `start`. A template literal's `${ ... }` is code, read the same way (T-61's code review, SF3):
 * with `inField`, it stops after the `}` that closes the field, counting the braces in between.
 */
function scanJavaScript(s: string, start: number, inField: boolean): { out: string; end: number } {
  let out = '';
  let i = start;
  let depth = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (inField && c === '}') {
      if (depth === 0) return { out, end: i + 1 };
      depth -= 1;
    } else if (inField && c === '{') depth += 1;
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
      while (i < s.length && s[i] !== c && (c === '`' || s[i] !== '\n')) {
        if (c === '`' && s[i] === '$' && s[i + 1] === '{') {
          const field = scanJavaScript(s, i + 2, true);
          out += `\${${field.out}}`;
          i = field.end;
          continue;
        }
        i += s[i] === '\\' ? 2 : 1;
      }
      if (s[i] === c) {
        out += c;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return { out, end: i };
}

function pythonCode(s: string): string {
  return scanPython(s, 0, false).out;
}

/**
 * Reads Python from `start`. An f-string's `{ ... }` field is code, read the same way, and `{{` is a literal brace
 * (SF3): with `inField`, it stops after the `}` that closes the field, counting the braces in between.
 */
function scanPython(s: string, start: number, inField: boolean): { out: string; end: number } {
  let out = '';
  let i = start;
  let depth = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (inField && c === '}') {
      if (depth === 0) return { out, end: i + 1 };
      depth -= 1;
    } else if (inField && c === '{') depth += 1;
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const fString = /(?:^|[^\w])(?:[rR]?[fF]|[fF][rR])$/.test(s.slice(Math.max(0, i - 3), i));
      out += c;
      i += quote.length;
      while (i < s.length) {
        if (s.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        if (quote.length === 1 && s[i] === '\n') break;
        if (fString && s[i] === '{') {
          if (s[i + 1] === '{') {
            i += 2;
            continue;
          }
          const field = scanPython(s, i + 1, true);
          out += `{${field.out}}`;
          i = field.end;
          continue;
        }
        i += s[i] === '\\' ? 2 : 1;
      }
      out += c;
      continue;
    }
    out += c;
    i += 1;
  }
  return { out, end: i };
}

export function codeOnly(content: string, language: CodeLanguage): string {
  return language === 'python' ? pythonCode(content) : javaScriptCode(content);
}
