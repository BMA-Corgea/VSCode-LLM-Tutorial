// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/derive/tree.ts` — the one writer of model-written files to disk in the engine (AC9).
 * Every test makes its own storage root and target with `mkdtemp` and removes only those.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DERIVED_TREES_DIR } from '../../src/derive/storage.js';
import { treeContentKey, treeSlug, tutorialKey, writeReferenceTree, type DerivedFile } from '../../src/derive/tree.js';
import { isDeriveRefusal } from '../../src/derive/types.js';

const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

teardown(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FILES: DerivedFile[] = [
  { path: 'core/tally.mjs', content: 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n' },
  { path: 'cli/main.mjs', content: "import { total } from '../core/tally.mjs';\nconsole.log(total([1, 2, 3]));\n" },
];

/** Every file under `dir`, as relative path → bytes, for before/after comparisons. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else out.set(r, fs.readFileSync(path.join(dir, r)).toString('base64'));
    }
  };
  walk('');
  return out;
}

function mustWrite(gs: string, target: string, files: readonly DerivedFile[] = FILES): string {
  const out = writeReferenceTree(gs, target, 'Tally', files);
  if (isDeriveRefusal(out)) assert.fail(`expected a tree, got: ${out.refused}`);
  return out.root;
}

suite('the reference tree — written whole, once, and only where it belongs (AC9)', () => {
  test('the files land under <gs>/derived/<tutorial>/<slug>-<content key>, byte for byte', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    const root = mustWrite(gs, target);
    assert.equal(root, path.join(fs.realpathSync(gs), DERIVED_TREES_DIR, tutorialKey(target), `tally-${treeContentKey(FILES)}`));
    for (const f of FILES) assert.equal(fs.readFileSync(path.join(root, f.path), 'utf8'), f.content);
    assert.ok(!fs.readdirSync(path.dirname(root)).some((n) => n.startsWith('.staging-')), 'no staging folder is left behind');
  });

  test('the learner\'s target folder is byte-identical before and after', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    fs.writeFileSync(path.join(target, 'mine.txt'), 'the learner\'s own file');
    const before = snapshot(target);
    mustWrite(gs, target);
    assert.deepEqual(snapshot(target), before);
  });

  test('the same files give the same tree, reused rather than rewritten', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    const first = mustWrite(gs, target);
    const inode = fs.statSync(path.join(first, 'core/tally.mjs')).ino;
    const second = mustWrite(gs, target);
    assert.equal(second, first);
    assert.equal(fs.statSync(path.join(second, 'core/tally.mjs')).ino, inode, 'not rewritten');
  });

  test('different files give a different tree, and the first stays exactly as it was (immutable)', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    const first = mustWrite(gs, target);
    const before = snapshot(first);
    const second = mustWrite(gs, target, [FILES[0]!, { path: 'cli/main.mjs', content: 'console.log("other");\n' }]);
    assert.notEqual(second, first);
    assert.deepEqual(snapshot(first), before);
  });

  test('a tree edited after it was written is replaced by the bytes its key promises', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    const root = mustWrite(gs, target);
    fs.writeFileSync(path.join(root, 'cli/main.mjs'), 'console.log("tampered");\n');
    fs.writeFileSync(path.join(root, 'extra.mjs'), 'planted\n');
    assert.equal(mustWrite(gs, target), root);
    assert.equal(fs.readFileSync(path.join(root, 'cli/main.mjs'), 'utf8'), FILES[1]!.content);
    assert.equal(fs.existsSync(path.join(root, 'extra.mjs')), false);
  });

  test('two targets never share a tree folder, even with identical files', () => {
    const gs = tempDir('derive-tree-gs-');
    const a = mustWrite(gs, tempDir('derive-tree-target-'));
    const b = mustWrite(gs, tempDir('derive-tree-target-'));
    assert.notEqual(path.dirname(a), path.dirname(b));
  });

  for (const [name, bad, pattern] of [
    ['a climb out', '../../escape.mjs', /climbs out of the reference tree/],
    ['a git hook', '.git/hooks/pre-commit', /segment beginning with a dot/],
    ['an absolute path', '/etc/passwd', /absolute path/],
  ] as Array<[string, string, RegExp]>) {
    test(`a file path that is ${name} is refused and nothing is written`, () => {
      const gs = tempDir('derive-tree-gs-');
      const out = writeReferenceTree(gs, tempDir('derive-tree-target-'), 'Tally', [...FILES, { path: bad, content: 'x\n' }]);
      assert.ok(isDeriveRefusal(out));
      assert.match(out.refused, pattern);
      assert.equal(fs.existsSync(path.join(gs, DERIVED_TREES_DIR)), false, 'refused before anything was created');
    });
  }

  test('a derived folder planted as a link to somewhere else is refused; the far end stays empty', () => {
    const gs = tempDir('derive-tree-gs-');
    const outside = tempDir('derive-tree-outside-');
    fs.symlinkSync(outside, path.join(gs, DERIVED_TREES_DIR));
    const out = writeReferenceTree(gs, tempDir('derive-tree-target-'), 'Tally', FILES);
    assert.ok(isDeriveRefusal(out));
    assert.match(out.refused, /link to somewhere else/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('a tutorial folder planted as a link is refused; the far end stays empty', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    const outside = tempDir('derive-tree-outside-');
    fs.mkdirSync(path.join(gs, DERIVED_TREES_DIR));
    fs.symlinkSync(outside, path.join(gs, DERIVED_TREES_DIR, tutorialKey(target)));
    const out = writeReferenceTree(gs, target, 'Tally', FILES);
    assert.ok(isDeriveRefusal(out));
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('the slug is a readable folder name, never a model\'s raw text', () => {
    assert.equal(treeSlug('Tally — the Counter!'), 'tally-the-counter');
    assert.equal(treeSlug('../../etc'), 'etc');
    assert.equal(treeSlug(''), 'app');
    assert.equal(treeSlug(42), 'app');
  });
  test('a staging folder swapped for a link mid-write puts nothing outside the store', () => {
    const gs = tempDir('derive-tree-gs-');
    const outside = tempDir('derive-tree-outside-');
    const realMkdir = fs.mkdirSync;
    let swapped = false;
    const patched = (p: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode | null): string | undefined => {
      const made = realMkdir(p, options as fs.MakeDirectoryOptions & { recursive: true });
      if (!swapped && String(p).includes('.staging-')) {
        swapped = true;
        fs.rmdirSync(p);
        fs.symlinkSync(outside, p);
      }
      return made;
    };
    (fs as unknown as { mkdirSync: unknown }).mkdirSync = patched;
    let out: ReturnType<typeof writeReferenceTree>;
    try {
      out = writeReferenceTree(gs, tempDir('derive-tree-target-'), 'Tally', FILES);
    } finally {
      (fs as unknown as { mkdirSync: unknown }).mkdirSync = realMkdir;
    }
    assert.ok(swapped, 'the swap has to have happened, or this test proves nothing');
    assert.ok(isDeriveRefusal(out), 'a staging folder that turned into a link must not be written through');
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing landed outside the store');
  });

  test('a link planted inside an existing tree means the tree is replaced, and the link is never followed', () => {
    const gs = tempDir('derive-tree-gs-');
    const target = tempDir('derive-tree-target-');
    const root = mustWrite(gs, target);
    const outside = path.join(tempDir('derive-tree-outside-'), 'victim.txt');
    fs.writeFileSync(outside, 'mine');
    fs.symlinkSync(outside, path.join(root, 'core', 'planted.mjs'));
    assert.equal(mustWrite(gs, target), root);
    assert.deepEqual([...snapshot(root).keys()].sort(), FILES.map((f) => f.path).sort(), 'the tree holds exactly its files again');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'mine', 'the link was removed, not followed');
  });
});
