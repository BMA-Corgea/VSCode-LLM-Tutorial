// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which folder a step's code is read from (T-22, AC5): the one answer, so no reader of the reference
 * can disagree with another about it.
 *
 * Until a learner diverges there is one root, the repository (`referenceRoot`). After a divergence a
 * re-derived step's code lives in a tree of its own (`derivedRoot`, written once under the extension's
 * storage). The question is asked PER STEP, as AC5 states it: a step that says it is re-derived
 * (`derivedFrom`) reads the tree, and every other step reads the repository, even for a file the tree
 * also holds (T-22's code review, MF3: on a symbol press the file's own step stays, walked, and is
 * still the author's). A re-derived step whose file the tree does not really hold has NO root: its code
 * is missing, and the author's file is never read in its place (the code review's SF5: storage cleared,
 * another profile, another machine). A path that climbs out, a planted link or a folder is not "held".
 *
 * No `vscode` import — same reasoning as `model.ts`.
 */

import fs from 'node:fs';
import { resolveInsideTarget } from './paths.js';

export interface ReferenceRoots {
  referenceRoot: string;
  derivedRoot?: string;
}

/** What the answer reads of a step: whether it is re-derived, and its file. */
export interface ReferenceStep {
  kind: string;
  derivedFrom?: string;
  target: { file: string };
}

/** The folder this step's code is read from, or `undefined` when it is re-derived and its code cannot be found. */
export function referenceRootFor(request: ReferenceRoots, step: ReferenceStep): string | undefined {
  // A chapter step reads no file of its own; any other step that is not re-derived is the author's.
  if (step.derivedFrom === undefined || step.kind === 'shape') return request.referenceRoot;
  const derived = request.derivedRoot;
  if (derived === undefined) return undefined;
  const abs = resolveInsideTarget(derived, step.target.file);
  if (abs === null) return undefined;
  try {
    return fs.lstatSync(abs).isFile() ? derived : undefined;
  } catch {
    return undefined;
  }
}

/** True when `step` is re-derived and its code cannot be found: what a reader says instead of reading anything. */
export function derivedCodeMissing(request: ReferenceRoots, step: ReferenceStep): boolean {
  return step.derivedFrom !== undefined && step.kind !== 'shape' && referenceRootFor(request, step) === undefined;
}

/** The two roots the engine is handed for a press: the repository, and the tree a plan already has. */
export function rootsForEngine(request: ReferenceRoots): { referenceRoot: string; derivedRoot: string | null } {
  return { referenceRoot: request.referenceRoot, derivedRoot: request.derivedRoot ?? null };
}

/** The repository itself, for what only a repository has: `plan.reproduce`'s never-taught files. */
export function repositoryRootOf(request: ReferenceRoots): string {
  return request.referenceRoot;
}

/** Said wherever a re-derived step's code is needed and cannot be found (T-22's code review, SF5). */
export const DERIVED_CODE_MISSING_MESSAGE = 'The code the model wrote for this step cannot be found: the tree it was kept in is not in this editor\'s storage (another machine, another profile, or storage that was cleared). Nothing is read from the author\'s repository in its place.';
