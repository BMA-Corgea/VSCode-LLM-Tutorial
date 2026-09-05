// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reads/writes the walk's on-disk state (spec §5.3 refinement notes). `plan.json` is
 * repo-tour's own output — read-only here, never written. `progress.json`, beside it, is this
 * extension's ONE write into the target (T-5 is where writing the learner's own files
 * happens) — atomic, via the exact temp-file-plus-rename helper `src/start/build.ts` already
 * proved out for `plan.json`/`request.json` (T-3 rework, review finding 2), reused rather than
 * re-implemented. No `vscode` import — same reasoning as `model.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildDir, writeJsonAtomic } from '../start/build.js';
import { emptyProgress, type PlanLike, type Progress } from './model.js';

export { buildDir };

function planPath(target: string): string {
  return path.join(buildDir(target), 'plan.json');
}

function progressPath(target: string): string {
  return path.join(buildDir(target), 'progress.json');
}

/** The one thing activation asks before paying for anything else (mirrors
 *  `src/start/build.ts`'s `readFreshMarker` — a plain `fs.existsSync`, nothing more). */
export function hasPlan(target: string): boolean {
  return fs.existsSync(planPath(target));
}

/** Throws if there is no plan at `target` — callers are expected to have checked `hasPlan`
 *  first; a plan that fails to parse is a genuinely exceptional, not a "nothing to do", case. */
export function loadPlan(target: string): PlanLike {
  return JSON.parse(fs.readFileSync(planPath(target), 'utf8')) as PlanLike;
}

/** Missing or unreadable progress is not an error — it is what a build that has never been
 *  walked yet looks like, so it is `emptyProgress(plan)`, never a throw. */
export function loadProgress(target: string, plan: PlanLike): Progress {
  try {
    return JSON.parse(fs.readFileSync(progressPath(target), 'utf8')) as Progress;
  } catch {
    return emptyProgress(plan);
  }
}

export function saveProgress(target: string, progress: Progress): void {
  writeJsonAtomic(progressPath(target), progress);
}
