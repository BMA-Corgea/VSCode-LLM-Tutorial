// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a step's `target.file` is allowed to point (T-4 security review, finding 2).
 *
 * `step.target.file` arrives from `plan.json`, which is generated from a repository the
 * learner pointed us at — so it is untrusted input even though it usually looks like an
 * ordinary relative path. `path.join(target, file)` is NOT a containment check and never
 * was: `path.join('/home/you/repo', '../../../.ssh/id_rsa')` is `/home/.ssh/id_rsa`, on
 * every platform and with either separator style. Absolute values happen to be neutralised
 * by `join` (`/etc/passwd` becomes `<target>/etc/passwd`), but the `..` case is not, and the
 * walk reveals the current step's file automatically on activation — no user gesture between
 * a crafted plan and an opened file.
 *
 * Today the worst of that is reading a file into an editor tab. The reason it is fixed now
 * rather than filed: **T-5 writes the learner's files at these same paths**, which turns the
 * identical unvalidated value into a write target one ticket from here.
 *
 * Deliberately pure `path`, no `fs`: `src/walk/session.ts` cannot import `fs` (it must stay
 * loadable under the plain-mocha unit bundle), and this is the check it needs. The symlink
 * half — a contained path whose real location is elsewhere — needs `realpath` and therefore
 * lives with the `fs` gate in `src/extension.ts`.
 */

import path from 'node:path';

/**
 * The absolute path `file` denotes inside `target`, or `null` if it escapes — which callers
 * must treat exactly as "there is nothing to open here", never as an error to report to the
 * learner, since they did not do anything wrong and the plan is not theirs to fix.
 */
export function resolveInsideTarget(target: string, file: unknown): string | null {
  if (typeof file !== 'string' || file.length === 0) return null;
  const root = path.resolve(target);
  const resolved = path.resolve(root, file);
  if (resolved === root) return root;
  return resolved.startsWith(root + path.sep) ? resolved : null;
}
