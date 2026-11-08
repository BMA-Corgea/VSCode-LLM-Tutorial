// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The graph arithmetic a replan stands on (T-17 step 6b-2's substrate): what is downstream of a
 * decision, what a replan keeps, what it is shown, and where its new steps go. Pure functions over
 * the nodes' declared `dependsOn` (paths), so each answer is checkable by hand on a drawn graph.
 *
 * These are the ENGINE's own definitions. T-19's AC-A1 harness computes "downstream of D" for
 * itself, from the assembled plan's `dependsOn`, on purpose: a wrong engine must not be able to
 * agree with a wrong test by sharing one function (T-19's spec).
 *
 * No `vscode` import — see `./types.ts`.
 */

import type { DerivedNode } from './types.js';

/**
 * Every node whose `dependsOn` chain reaches `decision` — NOT including the decision itself. A
 * decision is not "downstream of itself": its own answer changing is the input, and counting it
 * would let a derivation that changes nothing but `chosen` look as though it had responded.
 */
export function downstreamOf(nodes: readonly DerivedNode[], decision: string): Set<string> {
  const out = new Set<string>();
  // Plan order is a topological order (every dependency is an earlier node), so one forward pass
  // sees each node after everything it depends on.
  for (const n of nodes) {
    if (n.dependsOn.some((d) => d === decision || out.has(d))) out.add(n.path);
  }
  return out;
}

/** `paths` and everything they depend on, transitively. */
export function ancestorsOf(nodes: readonly DerivedNode[], paths: Iterable<string>): Set<string> {
  const byPath = new Map(nodes.map((n) => [n.path, n] as const));
  const out = new Set<string>();
  const stack = [...paths];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    for (const d of byPath.get(p)?.dependsOn ?? []) stack.push(d);
  }
  return out;
}

/**
 * What a replan at `decision` keeps VERBATIM, decision and code: everything not downstream of
 * it, the walked `prefix` even where it IS downstream, and every ancestor of the prefix (a walked
 * step's foundations cannot be pulled out from under it). The rest of its downstream is replaced.
 */
export function keptBy(nodes: readonly DerivedNode[], decision: string, prefix: Iterable<string>): { kept: Set<string>; replaced: Set<string> } {
  const downstream = downstreamOf(nodes, decision);
  const anchored = ancestorsOf(nodes, prefix);
  const kept = new Set<string>();
  const replaced = new Set<string>();
  for (const n of nodes) {
    if (!downstream.has(n.path) || anchored.has(n.path)) kept.add(n.path);
    else replaced.add(n.path);
  }
  return { kept, replaced };
}

/**
 * The kept nodes the replaced ones depended on, other than the decision and its own ancestors:
 * the outside facts the old downstream was built on, which the replan must therefore be shown.
 * Under the honesty rule each new step is then given these as dependencies too, because it was
 * shown them.
 */
export function externalDependencies(nodes: readonly DerivedNode[], decision: string, replaced: ReadonlySet<string>): string[] {
  const inside = ancestorsOf(nodes, [decision]);
  const out: string[] = [];
  for (const n of nodes) {
    if (!replaced.has(n.path)) continue;
    for (const d of n.dependsOn) {
      if (!replaced.has(d) && !inside.has(d) && !out.includes(d)) out.push(d);
    }
  }
  // In plan order, so the prompt and the added edges never depend on the order of a loop.
  const order = new Map(nodes.map((n, i) => [n.path, i] as const));
  return out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * The kept nodes in their own order, with each fresh node at the earliest position after all of
 * its dependencies. Fresh nodes keep their own relative order. Deterministic: the same inputs
 * always give the same plan order, which is what lets a fold of replans equal a derivation.
 *
 * A replan's fresh steps can therefore interleave chapters: the tree groups steps by chapter while
 * the walk's Next follows plan order, so Next can step back into an earlier chapter's group. The
 * walk still runs, in plan order. Whether that is acceptable is T-22's to rule on.
 */
export function insertInOrder(kept: readonly DerivedNode[], fresh: readonly DerivedNode[]): DerivedNode[] {
  const out = [...kept];
  // Where the last fresh node went: a later fresh node never jumps ahead of an earlier one, since
  // the model's own order among them is a teaching order too.
  let previous = -1;
  for (const node of fresh) {
    let place = previous + 1;
    out.forEach((n, i) => { if (node.dependsOn.includes(n.path)) place = Math.max(place, i + 1); });
    out.splice(place, 0, node);
    previous = place;
  }
  return out;
}
