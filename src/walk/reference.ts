// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which folder a step's file is read from (T-22, AC5): the one answer, so no reader of the
 * reference can disagree with another about it.
 *
 * Until a learner diverges there is one root, the repository (`referenceRoot`). After a divergence
 * a re-derived step's code lives in a tree of its own (`derivedRoot`, written once under the
 * extension's storage), and every step the divergence did not touch still reads the repository.
 * So the question is asked per file, and the answer is: the derived tree when it really holds that
 * file, the repository otherwise. A path that climbs out or a planted link is not "held".
 *
 * No `vscode` import — same reasoning as `model.ts`.
 */

import fs from 'node:fs';
import { resolveInsideTarget } from './paths.js';

export interface ReferenceRoots {
  referenceRoot: string;
  derivedRoot?: string;
}

export function referenceRootFor(request: ReferenceRoots, file: string): string {
  const derived = request.derivedRoot;
  if (derived === undefined) return request.referenceRoot;
  const abs = resolveInsideTarget(derived, file);
  if (abs === null) return request.referenceRoot;
  try {
    return fs.lstatSync(abs).isFile() ? derived : request.referenceRoot;
  } catch {
    return request.referenceRoot;
  }
}

/** The repository itself, for what only a repository has: `plan.reproduce`'s never-taught files. */
export function repositoryRootOf(request: ReferenceRoots): string {
  return request.referenceRoot;
}
