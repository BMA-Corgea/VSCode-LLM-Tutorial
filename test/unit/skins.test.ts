// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/skins.ts — pure (no `vscode`), so this runs under plain mocha. Three things checked:
 *
 *   1. The bridge sheet names every base token repo-tour's OWN `assets/skins/base.css`
 *      declares — exactly once each, and nothing else. Read from base.css itself (not a
 *      hand-copied list) so this test breaks the moment repo-tour adds a token this bridge
 *      does not yet know about, rather than silently missing it (the drift risk T-2's
 *      review flagged for EXPECTED_GRAMMARS/GRAMMAR_FOR — same shape of bug, closed here).
 *   2. `pickerHtml` renders one `<option>` per row it is handed, selects the current one,
 *      and escapes what it is given.
 *   3. AC6: a fixture skin file dropped into a TEMP COPY of repo-tour's assets (via
 *      `configureAssets` — never by editing the real repo-tour checkout) plus one more
 *      `SKINS` row (added in memory, at runtime — never a file edit) shows up in both
 *      repo-tour's own `alternateCss()` output and this extension's `pickerHtml()` output,
 *      with zero change to this extension's code.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAnyModule, resolveCoreRoot } from '../../src/core.js';
import { BRIDGE_TOKEN_MAP, bridgeCss, pickerHtml, type SkinRow } from '../../src/skins.js';

interface SkinsModule {
  SKINS: SkinRow[];
  baseCss(): string;
  alternateCss(): string;
}
interface AssetsModule {
  configureAssets(cfg: { assetsDir?: string; grammarsDir?: string }): void;
  resetAssets(): void;
}

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `--token:` DECLARATION in base.css (a use inside `var(--token)` never matches — no trailing colon). */
function tokensDeclaredIn(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) names.add(m[1]!);
  return names;
}

suite('bridgeCss', () => {
  test('names every base token repo-tour declares — exactly once each, nothing extra', () => {
    const baseCssPath = path.join(CORE_ROOT, 'assets', 'skins', 'base.css');
    const baseCssText = fs.readFileSync(baseCssPath, 'utf8');
    const declaredInBase = tokensDeclaredIn(baseCssText);
    assert.ok(declaredInBase.size > 10, 'sanity: base.css should declare a good number of tokens');

    const bridged = bridgeCss();
    const mappedTokens = new Set(Object.keys(BRIDGE_TOKEN_MAP));

    // Same SET of names on both sides — repo-tour adding or removing a base token should
    // fail this test until the bridge is updated to match, not pass silently.
    assert.deepEqual(
      [...mappedTokens].sort(),
      [...declaredInBase].sort(),
      'BRIDGE_TOKEN_MAP should cover exactly the tokens base.css declares',
    );

    for (const token of declaredInBase) {
      const occurrences = [...bridged.matchAll(new RegExp(`(^|[\\s;{])${escapeRegExp(token)}\\s*:`, 'g'))];
      assert.equal(occurrences.length, 1, `${token} should be declared exactly once in bridgeCss(), found ${occurrences.length}`);
    }

    assert.match(bridged, /:root:not\(\[data-theme\]\)/, 'the bridge must be scoped so a real skin overrides it');
  });
});

suite('pickerHtml', () => {
  const rows: SkinRow[] = [
    { name: 'system', label: 'System', note: 'Follows your OS.' },
    { name: 'dark', label: 'Dark', note: 'Always dark.' },
    { name: 'weird', label: 'A & B <em>weird</em>', note: 'quote " test' },
  ];

  test('renders one <option> per row, selects the current one', () => {
    const html = pickerHtml(rows, 'dark');
    const optionCount = [...html.matchAll(/<option/g)].length;
    assert.equal(optionCount, 3);
    assert.match(html, /<option value="dark"[^>]*selected>/);
    assert.ok(!/<option value="system"[^>]*selected>/.test(html), 'only the current row is selected');
    assert.ok(!/<option value="weird"[^>]*selected>/.test(html));
  });

  test('escapes a label/note that contains HTML-significant characters', () => {
    const html = pickerHtml(rows, 'system');
    assert.ok(!html.includes('<em>weird</em>'), 'the label must be escaped, not injected as markup');
    assert.match(html, /A &amp; B &lt;em&gt;weird&lt;\/em&gt;/);
    assert.match(html, /title="quote &quot; test"/);
  });
});

suite('AC6 — a fixture skin, via a temp copy of repo-tour\'s assets, no extension change', () => {
  test('a dropped-in css file + one more SKINS row show up in alternateCss() and pickerHtml()', async () => {
    const skinsMod = (await loadAnyModule(CORE_ROOT, 'skins')) as SkinsModule;
    const assetsMod = (await loadAnyModule(CORE_ROOT, 'assets')) as AssetsModule;

    const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-assets-fixture-'));
    fs.cpSync(path.join(CORE_ROOT, 'assets'), tmpAssets, { recursive: true });
    const marker = '#T3FIXTURE0swordfish';
    fs.writeFileSync(
      path.join(tmpAssets, 'skins', 'fixture.css'),
      `:root[data-theme="fixture"] { --bg: ${marker}; }\n`,
    );

    const originalLength = skinsMod.SKINS.length;
    try {
      assetsMod.configureAssets({ assetsDir: tmpAssets });
      // Simulating "repo-tour added a skin": one more row, added at runtime — never a file
      // edit to the real repo-tour checkout (DO-NOT-TOUCH).
      skinsMod.SKINS.push({ name: 'fixture', label: 'Fixture', note: 'a test-only skin' });

      const css = skinsMod.baseCss() + skinsMod.alternateCss();
      assert.ok(css.includes(marker), 'the fixture css file dropped into the temp assets dir should be inlined');

      // This extension's own picker, unmodified, driven by whatever SKINS now is.
      const html = pickerHtml(skinsMod.SKINS, 'fixture');
      assert.match(html, /<option value="fixture"[^>]*selected>Fixture<\/option>/);
      assert.equal([...html.matchAll(/<option/g)].length, originalLength + 1);
    } finally {
      // Both `SKINS` and the configured assets dir are process-wide module state — undo
      // both, in the same test, so no other test/unit file sharing this mocha process ever
      // observes the fixture row or the temp assets dir.
      skinsMod.SKINS.length = originalLength;
      assetsMod.resetAssets();
      fs.rmSync(tmpAssets, { recursive: true, force: true });
    }
  });
});
