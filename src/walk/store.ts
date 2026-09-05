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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this actually a `Progress`, or merely something that parsed?
 *
 * The distinction is the whole point. A `try/catch` around `JSON.parse` only catches text
 * that is not JSON; `null`, `[]`, `42` and `{}` all parse perfectly and are all fatal one
 * property access later (`progress.current` on `null`, `Object.keys(progress.steps)` on
 * anything without `steps`). `{}` is the likeliest of them in real life — a truncated write
 * that was repaired, a hand edit, another tool sharing the folder — and this file is read on
 * ACTIVATION, before anything is on screen, so the failure would be a walk that never opens
 * rather than a visible error. The same parse-then-check discipline `step-protocol.ts`
 * applies to webview messages (T-3 rework, review finding 3), applied to disk.
 *
 * `schemaVersion` is deliberately NOT checked. Reading a future version's file leniently
 * costs nothing here — the fields this walk reads are the ones it validates — whereas
 * rejecting it would silently discard a learner's real progress, which is the worse of the
 * two failures by a wide margin.
 */
function isProgressShape(value: unknown): value is Progress {
  if (!isRecord(value)) return false;
  const current = value['current'];
  if (current !== null && typeof current !== 'string') return false;
  return isRecord(value['steps']);
}

/** Missing, unreadable, or not actually shaped like progress at all — none of those are an
 *  error; each is what a build that has never been usefully walked looks like, so each comes
 *  back as `emptyProgress(plan)`, never a throw. */
export function loadProgress(target: string, plan: PlanLike): Progress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(progressPath(target), 'utf8'));
  } catch {
    return emptyProgress(plan);
  }
  return isProgressShape(parsed) ? parsed : emptyProgress(plan);
}

export function saveProgress(target: string, progress: Progress): void {
  writeJsonAtomic(progressPath(target), progress);
}
