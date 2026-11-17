// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-141: a stranger never reads one of this project's internal ticket numbers ("T-9", "T-30").
 *
 * Every string this extension can put in front of someone comes from a string literal or a template
 * in `src/`: the webviews' text and the scripts that write into them, the notifications, the progress
 * lines, the reasons shown under a field, the output channel. The manifest adds the command and setting
 * titles, and the README is the page the Extensions view shows. So this reads all three, and fails on a
 * ticket number anywhere in them.
 *
 * What is not text on any screen is left out: comments in the TypeScript (the parser drops them), and
 * the comments inside the HTML, CSS and scripts that the page templates carry (`<!-- -->`, `/* *\/` and
 * a `//` comment line), which a webview never draws.
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = process.cwd();
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript') as typeof import('typescript');

/** "T-" and a number, as a word: what this project calls a ticket. */
export const TICKET_NUMBER = /\bT-\d+\b/;

/** What a page template carries that no screen draws: HTML, CSS and script comments. */
export function withoutEmbeddedComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Every string literal and template part in one TypeScript source, with its line. */
export function stringsIn(file: string, source: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: import('typescript').Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(p));
    else if (/\.(ts|mts|cts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Every string under a JSON value, with the path to it. */
function stringsOf(value: unknown, at: string): Array<{ at: string; text: string }> {
  if (typeof value === 'string') return [{ at, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOf(v, `${at}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => stringsOf(v, `${at}.${k}`));
  return [];
}

suite('T-141: no internal ticket number reaches a screen', () => {
  test('no string in src/ carries one: webview text, notifications, progress lines, reasons, the output channel', () => {
    const files = sourcesUnder(path.join(ROOT, 'src'));
    assert.ok(files.length >= 40, `read ${files.length} source files: this test is not reading src/`);
    const found: string[] = [];
    let strings = 0;
    for (const file of files) {
      for (const s of stringsIn(file, fs.readFileSync(file, 'utf8'))) {
        strings += 1;
        const shown = withoutEmbeddedComments(s.text);
        const match = TICKET_NUMBER.exec(shown);
        if (match) found.push(`${path.relative(ROOT, file)}:${s.line}: "${match[0]}" in ${JSON.stringify(shown.trim().slice(0, 140))}`);
      }
    }
    assert.ok(strings >= 1000, `read ${strings} strings: this test is not reading what src/ says`);
    assert.deepEqual(found, [], `a ticket number a stranger would read:\n${found.join('\n')}`);
  });

  test("no command or setting title, and nothing else the manifest shows, carries one", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    const shown = [
      ...stringsOf(manifest['displayName'], 'displayName'),
      ...stringsOf(manifest['description'], 'description'),
      ...stringsOf(manifest['contributes'], 'contributes'),
    ];
    assert.ok(shown.filter((s) => s.at.startsWith('contributes.commands')).length >= 3, 'the manifest\'s commands were not read');
    const found = shown.filter((s) => TICKET_NUMBER.test(s.text)).map((s) => `${s.at}: ${JSON.stringify(s.text)}`);
    assert.deepEqual(found, [], `a ticket number in the manifest:\n${found.join('\n')}`);
  });

  test('the README, which the Extensions view shows, carries none', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.length > 2_000, 'the README was not read');
    const found = readme.split('\n').flatMap((line, i) => (TICKET_NUMBER.test(withoutEmbeddedComments(line)) ? [`README.md:${i + 1}: ${line.trim()}`] : []));
    assert.deepEqual(found, [], `a ticket number in the README:\n${found.join('\n')}`);
  });

  test('the check can see one: in a plain string, a template, a reason, and not in a comment', () => {
    const seen = (source: string): string[] => stringsIn('probe.ts', source).filter((s) => TICKET_NUMBER.test(withoutEmbeddedComments(s.text))).map((s) => s.text);
    assert.deepEqual(seen("const a = 'arrive with T-9';"), ['arrive with T-9']);
    assert.deepEqual(seen('const b = `built in ${x} (T-30)`;'), [' (T-30)']);
    assert.deepEqual(seen('// T-9 in a comment\n/* T-30 */ const c = "plain";'), []);
    assert.deepEqual(seen('const css = `/* T-41: a rule */ .a { }`; const html = `<!-- T-15 --><p>hi</p>`;'), []);
    assert.deepEqual(seen('const js = `  // ── T-7: the detour ──\n  var x = 1;`;'), []);
    assert.deepEqual(seen('const url = "https://example.com/T-9";'), ['https://example.com/T-9'], 'a URL\'s // is not a comment');
    assert.deepEqual(seen("const notTicket = 'UTF-8, T-shirt, ST-12';"), []);
  });
});
