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
import { DEFAULT_DIAL, DIALS, type BuildRequest, type Dial } from '../start/request.js';
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

/**
 * Throws if there is no plan at `target`, if it does not parse, or if what parsed is not
 * shaped like a plan — callers are expected to have checked `hasPlan` first, and to CATCH
 * (see `src/extension.ts`, which turns a throw here into a visible notice).
 *
 * The shape check earns its place by moving the failure (T-4 code + security review). Without
 * it, `{}` reached `orderedSteps` as `plan.steps is not iterable` and `null` reached
 * `treeModel` as `Cannot read properties of null` — thrown deep inside a render, from a
 * `void`ed activation promise, where nothing was listening. Same class as `progress.json`'s,
 * and the same reasoning: this is read on activation, before anything is on screen, so an
 * unhandled throw here is invisible rather than loud. The message is written to be shown to
 * a person, because it is.
 */
export function loadPlan(target: string): PlanLike {
  const raw: unknown = JSON.parse(fs.readFileSync(planPath(target), 'utf8'));
  if (!isRecord(raw) || !Array.isArray(raw['steps']) || !Array.isArray(raw['chapters'])) {
    throw new Error('plan.json is not a build plan (it needs a "chapters" array and a "steps" array) — rebuild it with Build Tutorials: Start');
  }
  return raw as unknown as PlanLike;
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

function requestPath(target: string): string {
  return path.join(buildDir(target), 'request.json');
}

/**
 * What was ASKED for when this tutorial was built — `<target>/.repo-tour/build/request.json`,
 * written by the start screen (T-3) beside the plan.
 *
 * Two things in it are load-bearing for the dial (T-5) and nothing had read either of them
 * until now:
 *
 *   - **`repo`** is the REFERENCE ROOT. Scaffolded and automated mode both write from the
 *     reference's own source, so without this there is nothing to copy from — the plan
 *     records decisions, never file contents.
 *   - **`dial`** is the GLOBAL setting. T-4 rendered and persisted a per-step override and
 *     deliberately went no further, so `statusText` falls back to `manual` for any step
 *     without one. AC1's "global, overridable per step" is only half true until this is read.
 *
 * Shape-checked and `null` on anything unusable, for the reason `loadProgress` is: this is
 * read on the interaction path, and a `request.json` that is valid JSON but not a request
 * would otherwise throw one property access later. A tutorial with no readable request is a
 * real state — it can be walked, it just cannot be written into — so `null` is an answer
 * callers must handle, not an error.
 */
export type ResolvedRequest = BuildRequest & { referenceRoot: string };

export function loadRequest(target: string): ResolvedRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(requestPath(target), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const repo = parsed['repo'];
  const dial = parsed['dial'];
  if (typeof repo !== 'string') return null;

  // Where the reference actually lives. `referenceRoot` is what the build resolved; `repo` is
  // only a fallback for `request.json` files written before that field existed — correct
  // precisely because a build old enough to lack it could only have been a local path.
  const recorded = parsed['referenceRoot'];
  const root = typeof recorded === 'string' && recorded.length > 0 ? recorded : repo;

  // And it must be a DIRECTORY that exists. `repo` is whatever was typed, so it can be a
  // GitHub URL, a path that has since been deleted, or a file — and every consumer of it
  // (the writer, the check, the reproduce copy) does `path.resolve(root, relative)`, which
  // turns a URL into a nonsense path relative to the process's cwd and then fails one read
  // at a time, silently. Answering `null` once, here, is the honest version of that: the
  // caller already knows how to say "this tutorial can be walked but not written into".
  let referenceRoot: string;
  try {
    if (!fs.statSync(root).isDirectory()) return null;
    referenceRoot = root;
  } catch {
    return null;
  }
  return {
    idea: typeof parsed['idea'] === 'string' ? parsed['idea'] : '',
    recreate: parsed['recreate'] === true,
    repo,
    referenceRoot,
    target: typeof parsed['target'] === 'string' ? parsed['target'] : target,
    // An unrecognised dial is the global default, never a guess: a value outside `DIALS`
    // means the file was hand-edited or written by a future version, and "manual" is the
    // only fallback that cannot overstate what has happened to the learner's files.
    dial: typeof dial === 'string' && (DIALS as readonly string[]).includes(dial) ? (dial as Dial) : DEFAULT_DIAL,
  };
}

export function saveProgress(target: string, progress: Progress): void {
  writeJsonAtomic(progressPath(target), progress);
}
