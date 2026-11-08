// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/walk/reference.ts` and `derivedRoot` (T-22, AC5): one answer to "which root does this step
 * read from", and a `request.json` that cannot point the walk anywhere it should not read.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlanLike } from '../../src/walk/model.js';
import { referenceRootFor } from '../../src/walk/reference.js';
import { loadRequest } from '../../src/walk/store.js';

const made: string[] = [];

teardown(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(root: string, rel: string, text = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

suite('referenceRootFor — the one answer to which root a step reads from (AC5)', () => {
  test('a file the derived tree holds is read from there, and any other from the repository', () => {
    const referenceRoot = tempDir('ref-repo-');
    const derivedRoot = tempDir('ref-derived-');
    write(derivedRoot, 'src/new.ts');
    assert.equal(referenceRootFor({ referenceRoot, derivedRoot }, 'src/new.ts'), derivedRoot);
    assert.equal(referenceRootFor({ referenceRoot, derivedRoot }, 'src/old.ts'), referenceRoot);
  });

  test('with no derived tree, everything is the repository', () => {
    const referenceRoot = tempDir('ref-repo-');
    assert.equal(referenceRootFor({ referenceRoot }, 'src/a.ts'), referenceRoot);
  });

  test('a path that climbs out, or a planted link, never reads from the derived tree', () => {
    const referenceRoot = tempDir('ref-repo-');
    const derivedRoot = tempDir('ref-derived-');
    const outside = tempDir('ref-outside-');
    write(outside, 'secret.ts');
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(derivedRoot, 'link.ts'));
    assert.equal(referenceRootFor({ referenceRoot, derivedRoot }, '../secret.ts'), referenceRoot);
    assert.equal(referenceRootFor({ referenceRoot, derivedRoot }, 'link.ts'), referenceRoot);
  });

  test('a folder in the derived tree is not a file it holds', () => {
    const referenceRoot = tempDir('ref-repo-');
    const derivedRoot = tempDir('ref-derived-');
    write(derivedRoot, 'src/a.ts');
    assert.equal(referenceRootFor({ referenceRoot, derivedRoot }, 'src'), referenceRoot);
  });
});

suite('loadRequest and a plan\'s tree: only a tree in the extension\'s own store is believed (AC5)', () => {
  function request(target: string, repo: string, extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.join(target, '.repo-tour', 'build'), { recursive: true });
    fs.writeFileSync(path.join(target, '.repo-tour', 'build', 'request.json'), JSON.stringify({ idea: '', recreate: true, repo, target, dial: 'manual', referenceRoot: repo, ...extra }));
  }

  /** A plan whose divergences are exactly these, as `plan.json` could say. */
  function planWith(divergences: unknown): PlanLike {
    return { chapters: [], steps: [], divergences };
  }

  function naming(tree: unknown): PlanLike {
    return planWith([{ stepId: 'd', answer: 'a', staleDependents: [], at: 't', tree }]);
  }

  function setup(): { target: string; repo: string; store: string; outside: string } {
    const target = tempDir('ref-target-');
    const repo = tempDir('ref-repo-');
    const store = tempDir('ref-store-');
    const outside = tempDir('ref-outside-');
    request(target, repo);
    return { target, repo, store, outside };
  }

  test('the tree the plan names, inside the store, is believed', () => {
    const { target, store } = setup();
    fs.mkdirSync(path.join(store, 'k', 'app-1'), { recursive: true });
    assert.equal(loadRequest(target, { plan: naming('k/app-1'), store })?.derivedRoot, fs.realpathSync(path.join(store, 'k', 'app-1')));
  });

  test('it is the tree of the LAST divergence that counts', () => {
    const { target, store } = setup();
    fs.mkdirSync(path.join(store, 'k', 'old'), { recursive: true });
    fs.mkdirSync(path.join(store, 'k', 'new'), { recursive: true });
    const plan = planWith([{ tree: 'k/old' }, { tree: 'k/new' }]);
    assert.equal(loadRequest(target, { plan, store })?.derivedRoot, fs.realpathSync(path.join(store, 'k', 'new')));
  });

  for (const [name, plant] of [
    ['a path that climbs out of the store', (store: string, outside: string): unknown => path.relative(store, outside)],
    ['an absolute path outside', (_store: string, outside: string): unknown => outside],
    ['the store itself', (): unknown => '.'],
    ['a link inside the store that leads out', (store: string, outside: string): unknown => { fs.mkdirSync(path.join(store, 'k'), { recursive: true }); fs.symlinkSync(outside, path.join(store, 'k', 'link')); return 'k/link'; }],
    ['a folder that is not there', (): unknown => 'k/gone'],
    ['not a string', (): unknown => 7],
  ] as Array<[string, (store: string, outside: string) => unknown]>) {
    test(`a tree that is ${name} is ignored`, () => {
      const { target, repo, store, outside } = setup();
      const loaded = loadRequest(target, { plan: naming(plant(store, outside)), store });
      assert.ok(loaded !== null, 'the request itself is still good');
      assert.equal(loaded.derivedRoot, undefined);
      assert.equal(loaded.referenceRoot, repo);
    });
  }

  test('a plan that has not diverged has no derived tree', () => {
    const { target, store } = setup();
    for (const plan of [planWith(undefined), planWith([]), planWith('nonsense'), planWith([null])]) {
      assert.equal(loadRequest(target, { plan, store })?.derivedRoot, undefined);
    }
  });

  test('a derivedRoot planted in request.json is not believed, even a real tree inside the store', () => {
    const { target, repo, store } = setup();
    const tree = path.join(store, 'k', 'app-1');
    fs.mkdirSync(tree, { recursive: true });
    request(target, repo, { derivedRoot: tree });
    assert.equal(loadRequest(target, { plan: planWith([]), store })?.derivedRoot, undefined);
    assert.equal(loadRequest(target)?.derivedRoot, undefined);
  });

  test('no file in the walk reads the reference except through the one function', () => {
    const dirs = ['src/walk', 'src/tutor', 'src/detour', 'src/dial'];
    const allowed = new Set(['src/walk/reference.ts', 'src/walk/store.ts']);
    const code = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const dir of dirs) {
      for (const name of fs.readdirSync(path.join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`;
        if (!name.endsWith('.ts') || allowed.has(rel)) continue;
        assert.ok(!/\.referenceRoot\b/.test(code(path.join(process.cwd(), rel))), `${rel} reads referenceRoot directly`);
      }
    }
  });
});
