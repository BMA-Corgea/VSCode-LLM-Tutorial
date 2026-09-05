// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * buildFromRequest — clone-or-path, the language refusal, the write-ahead marker, then
 * digest -> buildPlan -> interpretPlan -> plan.json (spec §5.2, T-1 §4).
 *
 * Deliberately NO `vscode` import, same house style as `src/core.ts`/`src/doctor.ts`: every
 * VS Code-specific thing (the progress notification, the cancellation token, the Resume/
 * Discard prompt, `globalStorageUri`, `workspaceState`) is a plain injected function, wired
 * by `src/extension.ts`. That means the write-ahead marker, the language refusal, and the
 * full end-to-end build against a fixture repo (AC3, AC4, AC5) all run under PLAIN MOCHA —
 * no extension host needed to prove any of it, only real `fs`/`child_process`.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseGithubUrl, type BuildRequest } from './request.js';

// ── the core surface this file actually calls (a duck-typed slice, not a full mirror of
// repo-tour's real types — see src/core.ts's header for why the boundary is typed this loosely). ──

export interface FileRecordLike {
  path: string;
  language: string | null;
  classification: string;
}
export interface DigestResultLike {
  inventory: { files: FileRecordLike[] };
  [key: string]: unknown;
}
export interface BuildPlanLike {
  chapters: unknown[];
  steps: unknown[];
  [key: string]: unknown;
}
export interface InterpretCostLike {
  metered: boolean;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  [key: string]: unknown;
}
export interface InterpretPlanResultLike {
  plan: BuildPlanLike;
  cost: InterpretCostLike;
}

export interface BuildCore {
  digest(root: string, opts?: { write?: boolean }): Promise<DigestResultLike>;
  buildPlan(digestResult: DigestResultLike, opts: { root: string; witness?: boolean }): Promise<BuildPlanLike>;
  interpretPlan(plan: BuildPlanLike, digestResult: DigestResultLike, opts: Record<string, unknown>): Promise<InterpretPlanResultLike>;
  defaultCacheDir(): string;
}

/** Builds a `BuildCore` from `CoreLoadResult.loaded` (src/core.ts) — the one cast site. */
export function coreFor(loaded: Partial<Record<string, unknown>>): BuildCore {
  const digestMod = loaded['digest'] as { digest: BuildCore['digest'] };
  const buildMod = loaded['build'] as { buildPlan: BuildCore['buildPlan']; interpretPlan: BuildCore['interpretPlan'] };
  const interpretMod = loaded['interpret'] as { defaultCacheDir: BuildCore['defaultCacheDir'] };
  return {
    digest: digestMod.digest,
    buildPlan: buildMod.buildPlan,
    interpretPlan: buildMod.interpretPlan,
    defaultCacheDir: interpretMod.defaultCacheDir,
  };
}

// ── cloning a GitHub URL, or using a local path as-is ──────────────────────────────────────

/** A plain `git` runner: real by default (`realGit`), swappable in tests. */
export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

export const realGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });

/**
 * `repo` is a local path (used as-is — `validateRequest` already confirmed it exists) or a
 * GitHub URL (cloned FULL — no `--depth` — into `<globalStorageRoot>/refs/<owner>-<name>`,
 * the witness needs history; reused with `git fetch` if already cloned there).
 */
export async function resolveRepo(
  repo: string,
  globalStorageRoot: string,
  git: GitRunner,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const gh = parseGithubUrl(repo);
  if (!gh) return repo;

  const dest = path.join(globalStorageRoot, 'refs', `${gh.owner}-${gh.name}`);
  if (fs.existsSync(path.join(dest, '.git'))) {
    onProgress?.(`fetching the latest history for ${gh.owner}/${gh.name}…`);
    await git(['-C', dest, 'fetch', '--all', '--tags']);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    onProgress?.(`cloning ${repo}…`);
    await git(['clone', repo, dest]);
  }
  return dest;
}

// ── the language refusal (AC3) ──────────────────────────────────────────────────────────────

/** repo-tour's shipped grammars (spec §10) — `PARSEABLE` in its own `src/inventory.ts`. */
const SUPPORTED_LANGUAGES = new Set(['python', 'javascript', 'typescript', 'tsx']);

/**
 * `null` when at least one `source` file's language is supported (or there are no `source`
 * files to judge at all — an empty/data-only repo is not what this check is for). Otherwise
 * the sorted, distinct list of languages actually found, for the refusal message.
 */
export function detectUnsupportedLanguages(digestResult: DigestResultLike): string[] | null {
  const sourceLanguages = new Set<string>();
  for (const f of digestResult.inventory.files) {
    if (f.classification === 'source' && f.language) sourceLanguages.add(f.language);
  }
  if (sourceLanguages.size === 0) return null;
  if ([...sourceLanguages].some((l) => SUPPORTED_LANGUAGES.has(l))) return null;
  return [...sourceLanguages].sort();
}

export function languageRefusalMessage(repoLabel: string, languages: string[]): string {
  return `${repoLabel} is ${languages.join(', ')}; the grammars repo-tour ships cover TS, JS, TSX and Python`;
}

// ── the write-ahead marker (AC4) ────────────────────────────────────────────────────────────

export type BuildPhase = 'digest' | 'plan' | 'interpret' | 'write';

export interface BuildMarker {
  startedAt: string;
  phase: BuildPhase;
  request: BuildRequest;
}

export function buildDir(target: string): string {
  return path.join(target, '.repo-tour', 'build');
}

export function markerPath(target: string): string {
  return path.join(buildDir(target), 'building.json');
}

/** Write-ahead: written to a temp file and renamed over the real one — never a half-written marker. */
function writeMarker(target: string, marker: BuildMarker): void {
  fs.mkdirSync(buildDir(target), { recursive: true });
  const tmp = `${markerPath(target)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
  fs.renameSync(tmp, markerPath(target));
}

export function readMarker(target: string): BuildMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(target), 'utf8')) as BuildMarker;
  } catch {
    return null;
  }
}

function deleteMarker(target: string): void {
  try {
    fs.unlinkSync(markerPath(target));
  } catch {
    /* already gone — fine */
  }
}

// ── the build itself ─────────────────────────────────────────────────────────────────────────

export interface BuildContext {
  core: BuildCore;
  globalStorageRoot: string;
  provider: string;
  model: string;
  /** Tests set this so the suite never spends tokens; the one live run is the orchestrator's. */
  cachedOnly: boolean;
  git?: GitRunner;
  onProgress?: (msg: string) => void;
  /** Fires once per phase transition, right after the marker is durably written — a test hook. */
  onPhase?: (phase: BuildPhase) => void;
  /** Polled between phases; returning true stops the build (cancelled from the progress notification). */
  isCancelled?: () => boolean;
}

export interface BuildOutcome {
  ok: boolean;
  cancelled?: boolean;
  plan?: BuildPlanLike;
  cost?: InterpretCostLike;
  /** set on a refusal or an error — the same text `onProblem` (panel wiring) shows in the form. */
  reason?: string;
}

/** Advances the marker to `phase`, durably (write-ahead), before that phase's own work runs. */
function runPhase(target: string, marker: BuildMarker, phase: BuildPhase, ctx: BuildContext): void {
  marker.phase = phase;
  writeMarker(target, marker);
  ctx.onPhase?.(phase);
}

export async function buildFromRequest(request: BuildRequest, ctx: BuildContext): Promise<BuildOutcome> {
  const target = request.target;
  const git = ctx.git ?? realGit;
  const marker: BuildMarker = { startedAt: new Date().toISOString(), phase: 'digest', request };

  let repoRoot: string;
  try {
    repoRoot = await resolveRepo(request.repo, ctx.globalStorageRoot, git, ctx.onProgress);
  } catch (err) {
    // Nothing was written yet — there is no marker to leave behind or clean up.
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }

  runPhase(target, marker, 'digest', ctx);
  if (ctx.isCancelled?.()) return cancel(target, 'before reading the repository');

  let digestResult: DigestResultLike;
  try {
    ctx.onProgress?.('reading the repository…');
    digestResult = await ctx.core.digest(repoRoot, { write: true });
  } catch (err) {
    return fail(err);
  }

  const unsupported = detectUnsupportedLanguages(digestResult);
  if (unsupported) {
    const reason = languageRefusalMessage(repoRoot, unsupported);
    deleteMarker(target); // deterministic — resuming can never make an unsupported repo supported
    return { ok: false, reason };
  }

  if (ctx.isCancelled?.()) return cancel(target, 'before deriving the build order');
  runPhase(target, marker, 'plan', ctx);

  let plan: BuildPlanLike;
  try {
    ctx.onProgress?.('deriving the build order…');
    plan = await ctx.core.buildPlan(digestResult, { root: repoRoot, witness: true });
  } catch (err) {
    return fail(err);
  }

  if (ctx.isCancelled?.()) return cancel(target, 'before asking about each decision');
  runPhase(target, marker, 'interpret', ctx);

  let interpreted: InterpretPlanResultLike;
  try {
    ctx.onProgress?.('asking about each decision…');
    interpreted = await ctx.core.interpretPlan(plan, digestResult, {
      root: repoRoot,
      provider: ctx.provider,
      model: ctx.model,
      cacheDir: ctx.core.defaultCacheDir(),
      cachedOnly: ctx.cachedOnly,
      onProgress: ctx.onProgress,
    });
  } catch (err) {
    return fail(err);
  }

  if (ctx.isCancelled?.()) return cancel(target, 'before writing the plan');
  runPhase(target, marker, 'write', ctx);

  try {
    ctx.onProgress?.('writing the plan…');
    fs.mkdirSync(buildDir(target), { recursive: true });
    fs.writeFileSync(path.join(buildDir(target), 'plan.json'), JSON.stringify(interpreted.plan, null, 2));
    fs.writeFileSync(path.join(buildDir(target), 'request.json'), JSON.stringify(request, null, 2));
  } catch (err) {
    return fail(err);
  }

  deleteMarker(target); // success — nothing left to resume
  return { ok: true, plan: interpreted.plan, cost: interpreted.cost };

  // The marker is deliberately LEFT on any of these failures (digest/buildPlan/interpretPlan/
  // write throwing) rather than deleted: unlike the language refusal above, a network blip, a
  // transient git or model error, or a full disk are not guaranteed to fail the same way
  // again, and digest + buildPlan cost nothing to redo while interpretPlan's finished stops
  // are cached by content hash either way — so a later Resume can retry for close to free.
  function fail(err: unknown): BuildOutcome {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
  function cancel(t: string, when: string): BuildOutcome {
    deleteMarker(t); // an explicit user cancel — not a crash — so there is nothing to resume
    return { ok: false, cancelled: true, reason: `build cancelled ${when}` };
  }
}

/** The human-readable line spec §5.2's "cost is shown on completion" asks for. */
export function costLine(cost: InterpretCostLike): string {
  return cost.metered
    ? `$${cost.usd.toFixed(2)}, ${cost.inputTokens + cost.outputTokens} tokens`
    : 'this provider does not report usage';
}

export function completionMessage(plan: BuildPlanLike, cost: InterpretCostLike): string {
  return `${plan.chapters.length} chapters · ${plan.steps.length} steps — ${costLine(cost)}`;
}

// ── resuming after a reload (AC4) ───────────────────────────────────────────────────────────

const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours (plan step 6e)

export interface ResumeContext extends BuildContext {
  now?: () => number;
  /** Prompts Resume/Discard; `undefined` = dismissed (leaves the marker for next time). */
  confirm(message: string): Promise<'Resume' | 'Discard' | undefined>;
}

/**
 * `target` is whatever `workspaceState.get('buildTutorials.currentBuild')` remembers — the
 * caller's job, not this function's, to keep this file free of a `vscode` import. `undefined`
 * (nothing remembered) and "no marker there" both mean nothing to do.
 */
export async function resumeIfMarked(target: string | undefined, ctx: ResumeContext): Promise<BuildOutcome | undefined> {
  if (!target) return undefined;
  const marker = readMarker(target);
  if (!marker) return undefined;

  const now = ctx.now ?? Date.now;
  const ageMs = now() - new Date(marker.startedAt).getTime();
  if (ageMs > STALE_AFTER_MS) return undefined; // old enough that we stay quiet about it

  const answer = await ctx.confirm(`A build for ${target} was interrupted (in progress: ${marker.phase}). Resume it?`);
  if (answer === 'Discard') {
    deleteMarker(target);
    return undefined;
  }
  if (answer !== 'Resume') return undefined; // dismissed — leave the marker for next time

  // Every finished interpretation is cached by content hash, so re-running from the start —
  // simpler and more honest than trying to resume mid-phase — is cheap, not wasteful.
  return buildFromRequest(marker.request, ctx);
}
