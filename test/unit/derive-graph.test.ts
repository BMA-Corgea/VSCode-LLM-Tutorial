// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/derive/graph.ts` — the replan's arithmetic, checked against a graph drawn by hand:
 *
 *     a ─────► a/x.mjs ─────► b/y.mjs ─────► c/w.mjs
 *     │                          ▲               ▲
 *     │        b ────────────────┤               │
 *     │        └──► b/z.mjs      │               │
 *     └──────► c ────────────────┼───────────────┘
 *
 *   a/x.mjs ← a          b/y.mjs ← b, a/x.mjs      b/z.mjs ← b
 *   c ← a (a shape step building on another chapter)     c/w.mjs ← c, b/y.mjs
 *
 * Every expected answer below was worked out on that drawing before the code was run.
 */

import * as assert from 'node:assert/strict';
import { ancestorsOf, downstreamOf, externalDependencies, insertInOrder, keptBy } from '../../src/derive/graph.js';
import type { DerivedNode } from '../../src/derive/types.js';

function node(kind: 'shape' | 'file', p: string, dependsOn: string[]): DerivedNode {
  const chapter = p.split('/')[0]!;
  return {
    kind, chapter, path: p, question: `q ${p}`, recommended: 'a', why: 'w', dependsOn,
    options: [{ id: 'a', label: 'A', consequence: 'ca' }, { id: 'b', label: 'B', consequence: 'cb' }],
  };
}

const NODES: DerivedNode[] = [
  node('shape', 'a', []),
  node('file', 'a/x.mjs', ['a']),
  node('shape', 'b', []),
  node('file', 'b/y.mjs', ['b', 'a/x.mjs']),
  node('file', 'b/z.mjs', ['b']),
  node('shape', 'c', ['a']),
  node('file', 'c/w.mjs', ['c', 'b/y.mjs']),
];

const sorted = (s: Iterable<string>): string[] => [...s].sort();

suite('the replan\'s graph arithmetic, on a graph drawn by hand', () => {
  test('downstream of a decision: everything its chain reaches, and NOT the decision itself', () => {
    assert.deepEqual(sorted(downstreamOf(NODES, 'a')), ['a/x.mjs', 'b/y.mjs', 'c', 'c/w.mjs']);
    assert.deepEqual(sorted(downstreamOf(NODES, 'a/x.mjs')), ['b/y.mjs', 'c/w.mjs']);
    assert.deepEqual(sorted(downstreamOf(NODES, 'b')), ['b/y.mjs', 'b/z.mjs', 'c/w.mjs']);
    assert.deepEqual(sorted(downstreamOf(NODES, 'c/w.mjs')), []);
  });

  test('ancestors: the paths and everything they stand on', () => {
    assert.deepEqual(sorted(ancestorsOf(NODES, ['c/w.mjs'])), ['a', 'a/x.mjs', 'b', 'b/y.mjs', 'c', 'c/w.mjs']);
    assert.deepEqual(sorted(ancestorsOf(NODES, ['b/z.mjs'])), ['b', 'b/z.mjs']);
  });

  test('a replan at a keeps what a does not reach, and replaces what it does', () => {
    const { kept, replaced } = keptBy(NODES, 'a', []);
    assert.deepEqual(sorted(kept), ['a', 'b', 'b/z.mjs']);
    assert.deepEqual(sorted(replaced), ['a/x.mjs', 'b/y.mjs', 'c', 'c/w.mjs']);
  });

  test('a walked step is kept even downstream of the decision, and so are its foundations', () => {
    const { kept, replaced } = keptBy(NODES, 'a', ['b/y.mjs']);
    assert.deepEqual(sorted(kept), ['a', 'a/x.mjs', 'b', 'b/y.mjs', 'b/z.mjs']);
    assert.deepEqual(sorted(replaced), ['c', 'c/w.mjs']);
  });

  test('the external dependencies a replan must be shown: what the old downstream stood on, outside the decision\'s own line', () => {
    const { replaced } = keptBy(NODES, 'a', []);
    assert.deepEqual(externalDependencies(NODES, 'a', replaced), ['b']);
    const atX = keptBy(NODES, 'a/x.mjs', []);
    assert.deepEqual(externalDependencies(NODES, 'a/x.mjs', atX.replaced), ['b', 'c']);
  });

  test('fresh steps go after their dependencies and after each other; kept steps keep their order', () => {
    const kept = NODES.filter((n) => ['a', 'b', 'b/z.mjs'].includes(n.path));
    const fresh = [node('file', 'a/q.mjs', ['a']), node('file', 'b/r.mjs', ['b', 'a/q.mjs'])];
    assert.deepEqual(insertInOrder(kept, fresh).map((n) => n.path), ['a', 'a/q.mjs', 'b', 'b/r.mjs', 'b/z.mjs']);
  });

  test('a fresh step with an early dependency still lands after an earlier fresh step', () => {
    const kept = NODES.filter((n) => ['a', 'b', 'b/z.mjs'].includes(n.path));
    const fresh = [node('file', 'b/r.mjs', ['b']), node('file', 'a/q.mjs', ['a'])];
    assert.deepEqual(insertInOrder(kept, fresh).map((n) => n.path), ['a', 'b', 'b/r.mjs', 'a/q.mjs', 'b/z.mjs']);
  });
});
