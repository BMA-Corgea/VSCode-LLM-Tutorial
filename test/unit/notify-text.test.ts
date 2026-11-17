// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-72 security review, finding 1: text from outside the extension must never become a link in a
 * notification. A folder named `[Remove the link for me](command:…)` in a reference repository was
 * quoted in T-72's refusal, VS Code drew it as a link in the error notification, and one click on it
 * ran a command the repository chose.
 *
 * These pins check `neutraliseLinks` against VS Code's own parsing, copied below from the pinned
 * 1.145.2 bundle. The screen test "T-72: a name the reference repository chose …" checks the same
 * thing in the real notification centre.
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutraliseLinks } from '../../src/notify-text.js';
import { gitAttributesRefusal } from '../../src/start/gitattributes.js';

/**
 * The links VS Code 1.145.2 draws in an extension's notification text, found its way. First the
 * normalising that `NotificationViewItem.parseNotificationMessage` does (`normalizeLinkedText`: cut to
 * `MAX_MESSAGE_LENGTH`, each line break to one space, the ends trimmed), then `parseLinkedText`'s
 * regular expression. Both are copied from `resources/app/out/vs/workbench/workbench.desktop.main.js`
 * (`MAX_MESSAGE_LENGTH=1e3`, `r4r` and `jk`).
 */
// eslint-disable-next-line no-useless-escape -- kept character for character as VS Code has it, so it can be checked against the bundle
const VSCODE_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
const MAX_MESSAGE_LENGTH = 1000;

function linksVsCodeDraws(message: string): Array<{ label: string; href: string }> {
  let text = message.substring(0, MAX_MESSAGE_LENGTH).replace(/\r\n|\n|\r/g, ' ');
  if (message.length > MAX_MESSAGE_LENGTH) text += '...';
  text = text.trimStart().trimEnd();
  return [...text.matchAll(VSCODE_LINK)].map((m) => ({ label: m[1]!, href: m[2]! }));
}

/** The words as a person reads them: the zero-width spaces taken out. */
const read = (text: string): string => text.replaceAll('​', '');

/** A small seeded generator, so the generated messages are the same on every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

suite('T-72 security review, finding 1: no text from outside becomes a link in a notification', () => {
  test("the reviewer's folder name, in the real refusal, is a link to VS Code before and plain words after", () => {
    const where = '/r/[Remove the link for me](command:t72review.probe?%5B%22chosen-by-the-repository%22%5D)/.gitattributes';
    const message = `Build Tutorials: ${gitAttributesRefusal('/r', { file: where, why: 'link' })}`;
    assert.deepEqual(linksVsCodeDraws(message),
      [{ label: 'Remove the link for me', href: 'command:t72review.probe?%5B%22chosen-by-the-repository%22%5D' }],
      'the fixture has to be one VS Code draws as a link, or this pin proves nothing');
    assert.deepEqual(linksVsCodeDraws(neutraliseLinks(message)), [], 'a name the repository chose is still a link in the notification');
    assert.equal(read(neutraliseLinks(message)), message, 'the words have to stay as they were');
  });

  test('every scheme and shape VS Code parses is left with nothing to find', () => {
    const shapes = [
      '[a](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)',
      '[a](https://example.invalid/x)',
      '[a](http://example.invalid/x)',
      '[a](file:///etc/hostname)',
      '[a](COMMAND:upper.case)',
      '[a](command:x "a title")',
      "[a](command:x 'a title')",
      'two: [a](command:x) and [b](command:y)',
      'nested: [[a](command:x)](command:y)',
      'adjacent: [a](command:x)[b](command:y)',
      `${'x'.repeat(MAX_MESSAGE_LENGTH - 40)}[near the cut](command:x)`,
    ];
    for (const shape of shapes) {
      assert.notDeepEqual(linksVsCodeDraws(shape), [], `the fixture ${JSON.stringify(shape)} has to be a link to VS Code`);
      assert.deepEqual(linksVsCodeDraws(neutraliseLinks(shape)), [], `still a link: ${JSON.stringify(shape)}`);
      assert.equal(read(neutraliseLinks(shape)), shape);
    }
  });

  test('2,000 generated messages: VS Code finds no link in any of them, and the words are unchanged', () => {
    const random = seeded(72);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    const noise = ['[', ']', '(', ')', '](', ' ', '\n', '\r\n', '\r', '"', "'", 'x', '/', '?', '%22', 'command:', 'https://', '​'];
    const link = (): string =>
      `[${pick(['a', 'Remove it', '[', '(x)', 'a b'])}](${pick(['command:', 'https://', 'http://', 'file:', 'Command:'])}`
      + `${pick(['x', 'a.b?%5B%5D', 'x/y'])}${pick(['', ' "t"', " 't'"])})`;
    let hostile = 0;
    for (let i = 0; i < 2_000; i++) {
      let message = '';
      const parts = 1 + Math.floor(random() * 8);
      for (let p = 0; p < parts; p++) message += random() < 0.4 ? link() : pick(noise);
      if (linksVsCodeDraws(message).length > 0) hostile += 1;
      const safe = neutraliseLinks(message);
      assert.deepEqual(linksVsCodeDraws(safe), [], `a link survived in ${JSON.stringify(message)}`);
      assert.equal(read(safe), read(message), `the words changed in ${JSON.stringify(message)}`);
    }
    assert.ok(hostile > 500, `only ${hostile} of the generated messages were links to VS Code to begin with`);
  });

  test("text with no link in it is passed through as it is: the extension's own words", () => {
    for (const text of [
      'Build Tutorials: .gitattributes is a link, which repo-tour would follow: remove it from the reference repository, or build from a copy without it',
      'Build Tutorials: build cancelled while reading the repository',
      'Build Tutorials: 3 chapters · 12 steps — $0.04, 1200 tokens',
      'a [bracket] and (parens), apart',
    ]) assert.equal(neutraliseLinks(text), text);
  });

  /** src/extension.ts with comments removed, so a comment that names a call is not mistaken for one. */
  function extensionCode(): string {
    const code = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(code, /^import \{ neutraliseLinks \} from '\.\/notify-text\.js';$/m, 'src/extension.ts has to use the helper from src/notify-text.ts');
    return code;
  }

  /** The body of the function `name` in `code`, braces balanced. */
  function bodyOf(code: string, name: string): string {
    const at = code.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} is not in src/extension.ts`);
    const open = code.indexOf('{', code.indexOf(')', at));
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      if (code[end] === '{') depth += 1;
      else if (code[end] === '}' && --depth === 0) break;
    }
    return code.slice(open, end + 1);
  }

  for (const [name, least, what] of [
    ['reportOutcome', 3, 'three (built, failed, cancelled)'],
    ['reportWalkFailure', 1, "one (the walk's failure, which quotes the plan's paths)"],
  ] as const) {
    test(`${name} sends every notification through neutraliseLinks (static, src/extension.ts)`, () => {
      const body = bodyOf(extensionCode(), name);
      const calls = [...body.matchAll(/\bshow(?:Information|Error|Warning)Message\(\s*([\w$]*)/g)];
      assert.ok(calls.length >= least, `found ${calls.length} notifications in ${name}; it sends ${what}`);
      for (const call of calls) {
        assert.equal(call[1], 'neutraliseLinks',
          `${name} sends a notification that does not go through neutraliseLinks: ${body.slice(call.index, call.index + 100).replace(/\s+/g, ' ')}`);
      }
    });
  }

  test("every progress line goes through neutraliseLinks: repo-tour's own lines name the repository's files (static, src/extension.ts)", () => {
    const code = extensionCode();
    const reports = [...code.matchAll(/\.report\(\s*\{\s*message:\s*([\w$]*)/g)];
    assert.ok(reports.length >= 1, 'found no progress.report({ message }) in src/extension.ts');
    for (const report of reports) {
      assert.equal(report[1], 'neutraliseLinks',
        `a progress line does not go through neutraliseLinks: ${code.slice(report.index, report.index + 80).replace(/\s+/g, ' ')}`);
    }
  });
});
