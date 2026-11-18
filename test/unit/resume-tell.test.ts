// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-120: a declined Resume is told, as information, and not reported as an ending (review F5).
 *
 * `reportOutcome` is not injectable, so the host pin (`test/extension.test.ts`) sees `tell` and cannot see an error
 * toast shown beside it. This reads `resumeOnActivate` from the source instead: a declined outcome goes to `tell`, and
 * only every other outcome to `reportOutcome`. And both real seams carry their words through `neutraliseLinks`.
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');

function body(name: string): string {
  const at = SOURCE.search(new RegExp(`\\n(?:export )?async function ${name}\\(`));
  assert.ok(at >= 0, `src/extension.ts no longer declares ${name}`);
  const next = SOURCE.slice(at + 1).search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return next < 0 ? SOURCE.slice(at) : SOURCE.slice(at, at + 1 + next);
}

suite('T-120: a declined Resume is told, not reported', () => {
  test('resumeOnActivate tells a declined outcome and reports every other one, never both', () => {
    const text = body('resumeOnActivate');
    assert.match(text, /if \(outcome\?\.declined\) deps\.tell\(/, 'a declined outcome is not told');
    assert.match(text, /\n\s*else reportOutcome\(outcome, false\);/, 'a declined outcome is reported too, or nothing else is');
    assert.equal((text.match(/reportOutcome\(/g) ?? []).length, 1, 'resumeOnActivate reports in more than one place');
  });

  test('the real prompt and the real tell carry their words through neutraliseLinks', () => {
    const at = SOURCE.indexOf('const REAL_RESUME_DEPS');
    assert.ok(at >= 0, 'REAL_RESUME_DEPS is gone');
    const deps = SOURCE.slice(at, SOURCE.indexOf('};', at));
    assert.match(deps, /confirm: \(message\) => .*showInformationMessage\(neutraliseLinks\(message\)/, 'the Resume prompt skips neutraliseLinks');
    assert.match(deps, /tell: \(message\) => .*showInformationMessage\(neutraliseLinks\(message\)\)/, 'the tell skips neutraliseLinks');
  });
});
