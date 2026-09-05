// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/webview/page.ts's renderPage() — pure, no `vscode`. AC7's guard (repo-tour lesson,
 * T-3, 2026-08-26: client script lives inside a TS template literal — a bad escape renders
 * a page that parses fine and does nothing) plus the CSP and data-theme stamping this
 * extension's whole skin contract depends on.
 */

import * as assert from 'node:assert/strict';
import { renderPage } from '../../src/webview/page.js';

function scriptBlocks(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

suite('renderPage', () => {
  test('every inlined <script> block parses as JavaScript (AC7)', () => {
    const html = renderPage({
      title: 'Build Tutorials: Start',
      coreCss: '.x{color:red}',
      bridgeCss: ':root:not([data-theme]){--bg:var(--vscode-editor-background)}',
      skin: 'system',
      body: '<form id="f"></form>',
      script: "post('form:changed', { idea: 'a \\\\n b' });\nfunction weird() { return `template ${1+1}`; }",
    });
    const blocks = scriptBlocks(html);
    assert.equal(blocks.length, 1, 'renderPage should inline exactly one <script> block');
    for (const [i, code] of blocks.entries()) {
      // Parse-only, never executed (repo-tour's own guard, test/pipeline.test.ts, does the
      // same): this is the one legitimate use of the Function constructor eslint warns
      // about — proving the STRING is syntactically valid JavaScript, nothing more.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      assert.doesNotThrow(() => new Function(code), `script block ${i} does not parse:\n${code}`);
    }
  });

  test('a script that WOULD fail to parse is actually caught by this guard (discriminates)', () => {
    // A regex missing a backslash — exactly the T-3 repo-tour incident this lesson is from
    // — emits a real newline inside the regex literal, which is a syntax error, not a typo
    // that happens to still run.
    const html = renderPage({
      title: 't', coreCss: '', bridgeCss: '', skin: 'system', body: '',
      script: 'var re = /\\r?\n/;',
    });
    const [code] = scriptBlocks(html);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- parse-only, see above
    assert.throws(() => new Function(code!), SyntaxError);
  });

  test('a nonce CSP meta tag is present, and every style/script tag carries the same nonce', () => {
    const html = renderPage({
      title: 't', coreCss: '.a{}', bridgeCss: '.b{}', skin: 'system', body: '<p>hi</p>', script: 'post("x", 1);',
    });
    const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    assert.ok(cspMatch, 'a CSP meta tag should be present');
    assert.match(cspMatch[1]!, /default-src 'none'/);
    const nonceInCsp = /nonce-([A-Za-z0-9+/=]+)/.exec(cspMatch[1]!)?.[1];
    assert.ok(nonceInCsp, 'the CSP should name a nonce');

    const tagNonces = [...html.matchAll(/<(?:style|script) nonce="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(tagNonces.length >= 3, 'style x2 + script x1 should all carry a nonce');
    for (const n of tagNonces) assert.equal(n, nonceInCsp, 'every tag nonce must match the CSP nonce');
  });

  test('a fresh render never reuses the previous nonce (discriminates against a hardcoded nonce)', () => {
    const a = renderPage({ title: 't', coreCss: '', bridgeCss: '', skin: 'system', body: '', script: '1;' });
    const b = renderPage({ title: 't', coreCss: '', bridgeCss: '', skin: 'system', body: '', script: '1;' });
    const nonceOf = (html: string) => /nonce="([^"]+)"/.exec(html)?.[1];
    assert.notEqual(nonceOf(a), nonceOf(b));
  });

  test('data-theme is stamped on <html> by the host for a named skin', () => {
    const html = renderPage({ title: 't', coreCss: '', bridgeCss: '', skin: 'gunmetal', body: '', script: '1;' });
    assert.match(html, /<html lang="en" data-theme="gunmetal">/);
  });

  test('"system" (and no skin at all) omits data-theme entirely — the bridge sheet decides instead', () => {
    const html = renderPage({ title: 't', coreCss: '', bridgeCss: '', skin: 'system', body: '', script: '1;' });
    assert.match(html, /<html lang="en">/);
    assert.ok(!html.includes('data-theme'), 'System must not stamp a data-theme attribute');
  });

  test('title and body text are HTML-escaped', () => {
    const html = renderPage({
      title: '<script>x</script>', coreCss: '', bridgeCss: '', skin: 'system', body: '', script: '1;',
    });
    assert.ok(!html.includes('<title><script>'), 'the title must be escaped');
    assert.match(html, /<title>&lt;script&gt;x&lt;\/script&gt;<\/title>/);
  });
});
