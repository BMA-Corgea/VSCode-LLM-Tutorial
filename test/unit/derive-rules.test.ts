// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `DeriveRules`-style parameters (T-22): the same parsers and checks, held to a real repository's
 * rules instead of Mode A's. Mode A's values are the defaults, and the other derive suites pin those.
 */

import * as assert from 'node:assert/strict';
import { REPO_IMPORTS, unsoundFileReason, type ImportRules } from '../../src/derive/engine.js';
import { parseNode, parseReplanReply, unsafeDerivedFileReason, type PathRules } from '../../src/derive/prompt.js';
import { isDeriveRefusal } from '../../src/derive/types.js';

const repoPaths: PathRules = {
  chapterDir: (alias) => (alias === 'c1' ? 'src/lib' : alias === 'c2' ? null : alias),
  extensions: ['.ts', '.tsx'],
  maxSegments: 12,
};
const repoImports = (known: string[]): ImportRules => ({ ...REPO_IMPORTS, allowsPackage: (name) => known.includes(name) });

const extract = (path: string, imports: Array<{ raw: string; resolved: string | null }>) => ({ path, imports, symbols: [], parseErrors: 0 });
const options = [{ id: 'a', label: 'A', consequence: 'x' }, { id: 'b', label: 'B', consequence: 'y' }];
const fileStep = (chapter: string, path: string) => ({ kind: 'file', chapter, path, question: 'q?', options, recommended: 'a', why: 'w', dependsOn: [] });

suite('the rules as parameters: a real repository\'s paths', () => {
  test('a file lies inside the REAL directory of the chapter its alias names', () => {
    assert.equal(unsafeDerivedFileReason('src/lib/a.ts', 'c1', 'typescript', repoPaths), null);
    assert.match(String(unsafeDerivedFileReason('src/other/a.ts', 'c1', 'typescript', repoPaths)), /not inside its chapter's directory/);
  });

  test('a chapter with no directory of its own (`@misc`) does not constrain the path', () => {
    assert.equal(unsafeDerivedFileReason('scripts/a.ts', 'c2', 'typescript', repoPaths), null);
  });

  test('the extensions are the repository\'s, and a hostile path is refused exactly as in Mode A', () => {
    assert.equal(unsafeDerivedFileReason('src/lib/a.tsx', 'c1', 'tsx', repoPaths), null);
    assert.match(String(unsafeDerivedFileReason('src/lib/a.py', 'c1', 'typescript', repoPaths)), /must end in \.ts or \.tsx/);
    assert.match(String(unsafeDerivedFileReason('src/lib/../../x.ts', 'c1', 'typescript', repoPaths)), /climbs out/);
    assert.match(String(unsafeDerivedFileReason('src/lib/.git/x.ts', 'c1', 'typescript', repoPaths)), /segment beginning with a dot/);
  });

  test('a real repository may nest deeper than a Mode A app, and the depth is still bounded', () => {
    assert.equal(unsafeDerivedFileReason('src/lib/a/b/c/d.ts', 'c1', 'typescript', repoPaths), null);
    assert.match(String(unsafeDerivedFileReason(`src/lib/${'a/'.repeat(12)}d.ts`, 'c1', 'typescript', repoPaths)), /nested more than 12/);
  });

  test('parseNode and parseReplanReply carry the rules through', () => {
    assert.ok(!isDeriveRefusal(parseNode(fileStep('c1', 'src/lib/a.ts'), 0, 'typescript', repoPaths)));
    const reply = JSON.stringify({ steps: [fileStep('c1', 'src/lib/a.ts')] });
    const out = parseReplanReply(reply, 'typescript', repoPaths);
    assert.ok(!isDeriveRefusal(out), isDeriveRefusal(out) ? out.refused : '');
  });
});

suite('the rules as parameters: a real repository\'s imports', () => {
  test('a package this repository already uses is allowed, and a new one is refused', () => {
    const rules = repoImports(['lodash']);
    assert.equal(unsoundFileReason(extract('src/a.ts', [{ raw: 'lodash', resolved: null }]), new Set(), 'typescript', new Set(), rules), null);
    assert.match(String(unsoundFileReason(extract('src/a.ts', [{ raw: 'left-pad', resolved: null }]), new Set(), 'typescript', new Set(), rules)), /would need installing/);
  });

  test('a scoped package and a subpath are judged by the package', () => {
    const rules = repoImports(['@scope/pkg', 'lodash']);
    assert.equal(unsoundFileReason(extract('src/a.ts', [{ raw: '@scope/pkg/deep', resolved: null }, { raw: 'lodash/fp', resolved: null }]), new Set(), 'typescript', new Set(), rules), null);
  });

  test('a built-in is the language\'s own, in TypeScript too', () => {
    assert.equal(unsoundFileReason(extract('src/a.ts', [{ raw: 'node:fs', resolved: null }, { raw: 'path', resolved: null }]), new Set(), 'typescript', new Set(), repoImports([])), null);
  });

  test('a specifier need not be exact: resolving it is the repository\'s own business', () => {
    assert.equal(unsoundFileReason(extract('src/a.ts', [{ raw: './b', resolved: 'src/b.ts' }]), new Set(['src/b.ts']), 'typescript', new Set(['src/b.ts']), repoImports([])), null);
  });

  test('an undeclared file of the app is still refused, in a real repository as in Mode A', () => {
    assert.match(String(unsoundFileReason(extract('src/a.ts', [{ raw: './b', resolved: 'src/b.ts' }]), new Set(), 'typescript', new Set(['src/b.ts']), repoImports([]))), /a file it does not depend on/);
  });

  test('Python: a bare name beside the file is allowed in a repository that runs its files directly', () => {
    const planned = new Set(['cli/helper.py']);
    assert.equal(unsoundFileReason(extract('cli/main.py', [{ raw: 'helper', resolved: null }]), new Set(), 'python', planned, repoImports(['helper'])), null);
  });

  test('Python: a new package is refused, the standard library is the language\'s own', () => {
    assert.match(String(unsoundFileReason(extract('cli/main.py', [{ raw: 'requests', resolved: null }]), new Set(), 'python', new Set(), repoImports([]))), /would need installing/);
    assert.equal(unsoundFileReason(extract('cli/main.py', [{ raw: 'json', resolved: null }]), new Set(), 'python', new Set(), repoImports([])), null);
  });
});
