// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `resolveCoreRoot`, driven through THE DEFAULT THAT SHIPS rather than through a literal
 * (T-8 review, finding 1).
 *
 * Why this file exists at all. Every other suite in this repository resolves the core with
 * `resolveCoreRoot('../repo-tour', …)` — a literal that used to equal the default and stopped
 * being it the moment T-8 changed the manifest to `''`. Ten call sites went on passing the old
 * value, so the ONE property the doctor is built on — "a missing core is a report, never a
 * throw" — quietly moved onto a branch nothing tested: `''` asks Node to resolve the
 * `repo-tour` dependency, and `require.resolve` throws `MODULE_NOT_FOUND` when there is none.
 * 1,212 green tests did not see it, because none of them asked for the default.
 *
 * So the default here is READ OUT OF `package.json` — the same string a real VS Code window
 * hands `getConfiguration().get()` — and never typed into this file. A test that hard-codes
 * what the default used to be is not testing the default; it is testing a historical
 * coincidence (kb/wiki/lessons.md, T-8).
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO_TOUR_PATH, loadCore, resolveCoreRoot } from '../../src/core.js';
import { formatReport, runDoctor } from '../../src/doctor.js';

/** The default a real editor would apply, read from the manifest that ships. */
const MANIFEST_DEFAULT: string = (() => {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  const value = manifest.contributes.configuration.properties['buildTutorials.repoTourPath']?.default;
  assert.equal(typeof value, 'string', 'the manifest must declare a string default for repoTourPath');
  return value as string;
})();

/**
 * An extension root with NO repo-tour anywhere on Node's resolution chain: the shape of a fresh
 * clone before `npm install`, and of a half-built .vsix. `os.tmpdir()` is chosen because nothing
 * above it carries a `node_modules/repo-tour`, which is exactly the condition under test.
 */
function rootWithNoCore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-no-core-'));
}

suite('resolveCoreRoot: the default, as shipped', () => {
  test('there is ONE default: the manifest and the code agree on it', () => {
    // Three copies of this string used to exist (package.json, src/extension.ts's
    // getConfiguration fallback, scripts/doctor-cli.mjs) and a fourth in test/dial.test.ts,
    // one of which was left behind by T-8. A second, invisible answer to the same question is
    // how the first one gets to be wrong for a while without anybody noticing.
    assert.equal(DEFAULT_REPO_TOUR_PATH, MANIFEST_DEFAULT);
  });

  test('the shipped default, with no core anywhere, REPORTS — it does not throw', async () => {
    const nowhere = rootWithNoCore();
    try {
      // The whole finding in one line: this used to throw MODULE_NOT_FOUND.
      const root = resolveCoreRoot(MANIFEST_DEFAULT, nowhere);
      assert.equal(path.isAbsolute(root), true, 'a resolved root is always absolute');

      const core = await loadCore(root);
      assert.equal(core.found, false);
      assert.ok(core.reason, 'a not-found core always says why');
      assert.ok(core.reason.includes(root), `the reason names the exact path tried: ${core.reason}`);
      assert.ok(!core.reason.includes('Cannot find module'), 'a resolver error is not a report');
    } finally {
      fs.rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('the doctor on the shipped default is plain sentences, never a stack trace', async () => {
    // README: "A missing or misconfigured anything is a report in plain sentences, never a
    // stack trace." This is that sentence, pinned at the layer the CLI doctor actually calls —
    // `scripts/doctor-cli.mjs` runs exactly `runDoctor(resolveCoreRoot(<default>, root))`.
    const nowhere = rootWithNoCore();
    try {
      const report = await runDoctor(resolveCoreRoot(MANIFEST_DEFAULT, nowhere));
      assert.equal(report.core.found, false);

      const text = formatReport(report).join('\n');
      assert.ok(text.includes('core NOT found'), text);
      assert.ok(text.includes('(none attempted — core was not found)'), text);
      assert.ok(text.includes('grammars: FAILED'), text);
      for (const stackish of ['MODULE_NOT_FOUND', 'Cannot find module', 'node:internal/', '    at ']) {
        assert.ok(!text.includes(stackish), `the report must not read like a stack trace: ${stackish}`);
      }
    } finally {
      fs.rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('the fallback names where Node actually looked, so the report is actionable', () => {
    const nowhere = rootWithNoCore();
    try {
      const root = resolveCoreRoot(DEFAULT_REPO_TOUR_PATH, nowhere);
      assert.equal(root, path.join(nowhere, 'node_modules', 'repo-tour'));
    } finally {
      fs.rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('no setting a person could type makes this throw', () => {
    // The function is TOTAL. Every call site in src/extension.ts is un-guarded (the Doctor
    // command, Start, resumeOnActivate — which is floated with `void`, so a rejection there is
    // an unhandled rejection on any window carrying a build bookmark), and that is only safe
    // while this holds.
    const nowhere = rootWithNoCore();
    try {
      for (const setting of ['', '   ', '\t\n', '../repo-tour', './nope', 'repo-tour', path.join(nowhere, 'x')]) {
        assert.doesNotThrow(() => resolveCoreRoot(setting, nowhere), `setting ${JSON.stringify(setting)}`);
      }
    } finally {
      fs.rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('a non-empty setting is still purely lexical, and still wins', () => {
    const nowhere = rootWithNoCore();
    try {
      assert.equal(resolveCoreRoot('/somewhere/repo-tour', nowhere), '/somewhere/repo-tour');
      assert.equal(resolveCoreRoot('../repo-tour', nowhere), path.resolve(nowhere, '../repo-tour'));
      assert.equal(resolveCoreRoot('  ../repo-tour  ', nowhere), path.resolve(nowhere, '../repo-tour'));
    } finally {
      fs.rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('when the dependency IS installed, the default resolves to it', async () => {
    // The other half: this repository's own node_modules has repo-tour linked, so the default
    // must find it — a fix that made the empty setting always fall back would pass every test
    // above and ship an extension that never finds its own core.
    const root = resolveCoreRoot(DEFAULT_REPO_TOUR_PATH, process.cwd());
    const core = await loadCore(root);
    assert.equal(core.found, true, core.reason ?? '');
    assert.equal(path.basename(root), 'repo-tour');
  });
});
