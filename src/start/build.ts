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
 *
 * In the extension itself, `digest` and `buildPlan` run on a worker thread (`off-thread.ts`, T-30),
 * behind the same `BuildCore`. Everything in this file still runs on the host.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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

/**
 * What a phase that runs somewhere else needs in order to be stopped while it runs (T-30). A core
 * that runs its phases on the calling thread ignores it: nothing can run there until the phase
 * returns, so there is nothing to poll with.
 */
export interface PhaseControl {
  isCancelled?: () => boolean;
}

export interface BuildCore {
  digest(root: string, opts?: { write?: boolean; outDir?: string }, control?: PhaseControl): Promise<DigestResultLike>;
  buildPlan(digestResult: DigestResultLike, opts: { root: string; witness?: boolean }, control?: PhaseControl): Promise<BuildPlanLike>;
  interpretPlan(plan: BuildPlanLike, digestResult: DigestResultLike, opts: Record<string, unknown>): Promise<InterpretPlanResultLike>;
  defaultCacheDir(): string;
  /** Lets go of anything this core holds for the build that just ended. Absent on a core that
   *  holds nothing. Called on every path out of `buildFromRequest`; must not throw. */
  release?(): void;
}

/**
 * What a phase rejects with when Cancel stopped it while it was running (T-30). Recognised by an own
 * property and never by its words, for the reasons `gitTimedOut` gives: class identity does not
 * survive esbuild's separate bundles, and a sentence can carry text from a repository.
 */
export class BuildPhaseCancelled extends Error {
  readonly buildPhaseCancelled = true;
  constructor() {
    super('the build was cancelled while this phase was running');
    this.name = 'BuildPhaseCancelled';
  }
}

/** Whether a phase's rejection is Cancel having stopped it, rather than the phase failing. */
export function phaseCancelled(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { buildPhaseCancelled?: unknown }).buildPhaseCancelled === true;
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

/**
 * ## Every git subprocess is bounded, and the bound comes in two sizes (T-13)
 *
 * `maxBuffer` bounds MEMORY. It does not bound TIME, and until this ticket nothing did: a
 * `git` that never returned was never ended, on a path that reaches every feature this
 * extension has. T-6's security review drove it — a gated git runner in front of the tutor's
 * pre-flight produced zero pushes, `tutor.thinking` never set and a *Cancel* that did nothing
 * at all — and the finding then rode across three tickets' fences as a note.
 *
 * The owner's decision (2026-09-07) is **two tiers**, not one global bound and not a timeout
 * per call site:
 *
 *   - **`short`, 30 seconds** — the default, and it is the default deliberately. `rev-parse`,
 *     `init`, `config`, `add`, `commit` and the tutor's `diff --no-index` are sub-second local
 *     operations; thirty seconds is already far past "something is wrong", and every one of
 *     them sits under a control a learner has just pressed.
 *   - **`long`, 10 minutes** — the two operations that can legitimately take minutes on a
 *     healthy machine: the FULL clone (no `--depth`; the witness needs history) and the
 *     `fetch --all --tags` that refreshes it. A single bound generous enough for those would
 *     leave a learner staring at a dead *Check my work* for ten minutes, which closes the
 *     ticket without fixing the experience.
 *
 * A bound at each call site was rejected on the record for the reason this defect exists: a
 * call site added later gets no bound unless somebody remembers. So the tier is a parameter of
 * the RUNNER with a working default, which makes "bounded" the thing you get by doing nothing
 * and the long tier the thing you have to ask for. `gitTimeoutMs` re-checks even that, because
 * `GitRunner` is handed across a `vscode` boundary where TypeScript's promises stop being
 * enforced: an unrecognised tier resolves to `short` rather than to `undefined`, which is what
 * `execFile` reads as "no bound at all".
 *
 * **A tier is a number of milliseconds, not a promise that a child dies when asked.** What
 * turns the number into an actual bound is the escalation in `gitRunnerWith` — read that
 * before trusting either figure, and read its stated limit before quoting "always".
 */
export const GIT_TIMEOUT_MS = {
  short: 30_000,
  long: 10 * 60_000,
} as const;

/** Which of `GIT_TIMEOUT_MS`'s two bounds a call wants. Omitted means `short`. */
export type GitTier = keyof typeof GIT_TIMEOUT_MS;

/**
 * The bound for `tier`, and never `undefined` — see `GIT_TIMEOUT_MS`. The cast is the whole
 * point of the function rather than a shortcut around it: the value TypeScript says cannot
 * arrive is exactly the one a JavaScript caller, a stale bundle or a hand-written runner can
 * hand over, and `execFile` treats an absent `timeout` as "run forever".
 */
export function gitTimeoutMs(tier: GitTier | undefined): number {
  const ms = tier === undefined ? undefined : (GIT_TIMEOUT_MS as Record<string, number | undefined>)[tier];
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : GIT_TIMEOUT_MS.short;
}

/** `30 seconds` / `10 minutes` — a bound as a person would say it, for the sentences below. */
function durationPhrase(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/**
 * What a `GitRunner` rejects with when the bound above stopped the subprocess.
 *
 * A DISTINCT type, because "git was killed for taking too long" is not "git said no". Every
 * caller in this repository already reads a `GitRunner` rejection as git's ordinary way of
 * answering a question — `rev-parse` rejecting means "not a repository", `config` rejecting
 * means "that key is unset", `diff --no-index` rejecting means "the files differ" — and every
 * one of those readings is WRONG for a timeout, in the direction that does harm: it would
 * `git init` a nested repository inside one that already exists, report a perfectly good
 * identity as missing, and tell a model the learner's file is identical to the author's. So
 * the shape is recognisable rather than new-and-unannounced.
 *
 * `gitTimedOutAfterMs` is a plain own property and `gitTimedOut` duck-types it rather than
 * using `instanceof`: each esbuild entry point bundles its own copy of this module, so a class
 * identity does not survive the trip between two of them, and a hand-written test fake can
 * produce the shape without importing anything.
 */
export class GitTimeoutError extends Error {
  readonly gitTimedOutAfterMs: number;
  constructor(args: readonly string[], ms: number) {
    super(`git ${args.join(' ')} timed out after ${durationPhrase(ms)} and was stopped`);
    this.name = 'GitTimeoutError';
    this.gitTimedOutAfterMs = ms;
  }
}

/**
 * Whether a `GitRunner` rejection is the timeout above rather than git answering "no".
 *
 * The own property is the WHOLE test, and the string form this used to fall through to is gone
 * (T-13 review finding 3). The runner composes an ordinary failure's message as
 * `git ${args.join(' ')} failed: …` — **the argv is in it** — and two call sites put text from
 * `plan.json` into that argv: `commitStep` runs `git commit -m <ordinal: question — label>`,
 * and `learnerDiffFor` passes the step's own target path. `plan.json` is, in this module's own
 * words, "a repository someone else pointed the build at". Driven: a plan whose question read
 * `timed out after 1 second and was stopped` routed an ordinary exit-1 commit into the timeout
 * branch. A classifier that reads a string carrying untrusted text is not a classifier, so
 * this one reads a property only the runner can set.
 */
export function gitTimedOut(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && typeof (err as { gitTimedOutAfterMs?: unknown }).gitTimedOutAfterMs === 'number';
}

/** A plain `git` runner: real by default (`realGit`), swappable in tests. */
export type GitRunner = (args: string[], cwd?: string, tier?: GitTier) => Promise<string>;

/** The handle `exec` hands back, as far as `gitRunnerWith` needs it — every member optional,
 *  because a hand-written test seam may return nothing at all and the escalation below must
 *  degrade to "settle anyway" rather than throw on a missing method. */
export interface SpawnedChild {
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  unref?: () => void;
}

/** The `execFile` shape `gitRunnerWith` needs — one seam, so a test can see the options that
 *  reach the child process without spawning one, the way `FsWriteOps` does for `fs`. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; maxBuffer: number; timeout: number; killSignal: NodeJS.Signals },
  callback: (err: (Error & { killed?: boolean; code?: number | string | null }) | null, stdout: string, stderr: string) => void,
) => SpawnedChild | undefined;

/**
 * How long the runner waits, after the bound's own `SIGTERM`, before it stops asking politely
 * and stops waiting at all. Five seconds is long enough that a healthy `git` finishes its
 * signal handling — which is how it removes its own `.git/*.lock` files — and short enough
 * that it is not a second wait a learner can notice on top of the first.
 */
export const GIT_KILL_GRACE_MS = 5_000;

/**
 * The two numbers `gitRunnerWith` would otherwise take as constants, exposed for the same
 * reason `exec` is: a test that wants to watch the escalation happen cannot sit out thirty
 * real seconds and then five more, once per case.
 *
 * `boundMs` REPLACES the tier's bound rather than shortening it behind the runner's back —
 * which matters, because the runner now has a timer of its own. A seam that rewrote
 * `options.timeout` on the way to the child would leave the runner escalating against the
 * bound it thinks it set and the child dying against a different one, so the test would be
 * measuring a runner that does not exist. Both numbers are guarded exactly as `gitTimeoutMs`
 * guards a tier: an override that is not a finite positive number is ignored, so nothing
 * passed here can produce the "no bound at all" that this ticket exists to remove.
 */
export interface GitRunnerTuning {
  boundMs?: number;
  killGraceMs?: number;
}

/** A caller-supplied millisecond override, or `fallback` — never `undefined`, never zero. */
function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The one place in `src/` that spawns a git subprocess (pinned by a source scan in
 * `test/unit/build.test.ts`, because a second one would be unbounded by default and nothing
 * else would notice). `exec` is injected so the options handed to the child — the `timeout`
 * above all — are observable without a real process.
 *
 * `killed` distinguishes the timeout from git's ordinary non-zero exit, which is the whole
 * reason the option is safe to add: on a timeout Node sends `SIGTERM`, `stderr` is empty and
 * `err.message` is a bare `Command failed: git …`, so without this branch a stopped git would
 * reach three callers wearing the costume of git having answered. `maxBuffer` also kills the
 * child, so its own error code is excluded by name rather than by hoping it looks different.
 *
 * ## The bound is not one signal, and the promise settles whatever the child does (T-13 rev. f1)
 *
 * `execFile`'s `timeout` sends `killSignal` **once** and then waits for `close`. The first
 * version of this ticket stopped there, which meant the bound was only as good as the child's
 * willingness to die: driven, a `SIGTERM`-ignoring child at a 600 ms bound left this promise
 * `*** NEVER SETTLED after 6s ***` with the child alive and node itself unable to exit. That
 * is not a weaker bound than the one advertised, it is *no* bound — and on the walk's
 * serialised chain it is every other control silent forever, i.e. exactly the T-6 finding this
 * ticket exists to close. The trigger the ticket names for itself, a network filesystem, is
 * precisely the case that survives `SIGTERM`: a process in uninterruptible sleep does not
 * handle a signal until its syscall returns.
 *
 * So there are three parts, and the third is the load-bearing one:
 *
 *   1. `killSignal: 'SIGTERM'` — stated rather than defaulted, because the next two lines are
 *      about what it does not do.
 *   2. `SIGKILL` after `GIT_KILL_GRACE_MS`. `SIGTERM` first and not instead: git registers its
 *      lock files with `sigchain` and removes them when it is asked politely, and a `SIGKILL`d
 *      git does not get to. Driven, that is the difference between a repository the learner's
 *      next commit works in and one holding a stale `.git/index.lock`.
 *   3. **The promise settles on OUR timer, not on the child's `close`.** This is what makes
 *      "always settles" true rather than likely: whether the second signal lands, whether the
 *      child is reapable at all, whether `exec` even returned a handle, at `timeout + grace`
 *      this promise rejects with the same `GitTimeoutError` and the caller moves on. The
 *      abandoned child is then `unref`'d, and that call earns its line: driven against a child
 *      the second signal is withheld from — the shape of a process `SIGKILL` cannot reap
 *      either — node stayed alive indefinitely without it (killed at 124 by an external
 *      `timeout`) and exited on its own with it. Not waiting for something is not the same as
 *      being free of it.
 *
 * **The stated limit: a grandchild.** Node signals the child, not its process group, so a
 * `git` that is a wrapper — a shim script, a credential or `lfs` helper that outlives its
 * parent — leaves a subprocess running after this promise has correctly rejected. Driven, it
 * does. Killing the group instead would need `detached: true` at spawn — `process.kill(-pid)`
 * on a child that is not a group leader is at best an `ESRCH` and at worst a signal to whatever
 * group has since taken that id — and that trade was declined on purpose: `detached` makes
 * every git this extension runs survive the extension host's own exit (a ten-minute clone
 * outliving the window that asked for it), and Node documents that on Windows such a child
 * "will have its own console window", which cannot then be disabled. Real `git` propagates
 * signals to its own helpers and unwinds its own destination — driven here, a `clone` killed
 * mid-transfer left no `git-upload-pack`, no `index-pack` and no partial directory, with both
 * helpers observed alive beforehand so the check was real — so the exposure is a wrapped `git`,
 * and it is written down here rather than papered over.
 */
export function gitRunnerWith(exec: ExecFileLike, tuning: GitRunnerTuning = {}): GitRunner {
  const killGraceMs = positiveMs(tuning.killGraceMs, GIT_KILL_GRACE_MS);
  return (args, cwd, tier) =>
    new Promise((resolve, reject) => {
      const timeout = positiveMs(tuning.boundMs, gitTimeoutMs(tier));
      // Declared before the timer that reads it and assigned after it: the escalation has to be
      // armed BEFORE the spawn (see below), so this cannot be a `const` initialised by `exec`.
      let child: SpawnedChild | undefined;
      let done = false;

      /** First one wins: the child's callback and the escalation timer race by design. */
      function settle(act: () => void): void {
        if (done) return;
        done = true;
        clearTimeout(escalation);
        act();
      }

      // Armed BEFORE the spawn, so a seam that calls back synchronously finds a timer to clear
      // rather than leaving one running behind a promise that is already settled.
      const escalation = setTimeout(() => {
        // `SIGTERM` was sent at `timeout` and did not end it. Stop asking, then stop waiting —
        // in that order, so the rejection below is not contingent on either call working.
        try { child?.kill?.('SIGKILL'); } catch { /* it exited between the two signals */ }
        try { child?.unref?.(); } catch { /* nothing to release */ }
        settle(() => reject(new GitTimeoutError(args, timeout)));
      }, timeout + killGraceMs);

      try {
        child = exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGTERM' },
          (err, stdout, stderr) => {
            if (!err) { settle(() => resolve(stdout)); return; }
            if (err.killed === true && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              settle(() => reject(new GitTimeoutError(args, timeout)));
              return;
            }
            settle(() => reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`)));
          });
      } catch (spawnErr) {
        // A seam, or a `spawn` that refuses the arguments outright, can throw where Node
        // normally reports through the callback. The promise would settle either way — a throw
        // inside a `Promise` executor rejects it — but only this clears the escalation timer,
        // and "settles" is a promise this runner makes about every path, not most of them.
        settle(() => reject(spawnErr instanceof Error ? spawnErr : new Error(String(spawnErr))));
      }
    });
}

export const realGit: GitRunner = gitRunnerWith(execFile);

/**
 * `repo` is a local path (used as-is — `validateRequest` already confirmed it exists) or a
 * GitHub URL (cloned FULL — no `--depth` — into `<globalStorageRoot>/refs/<owner>-<name>`,
 * the witness needs history; reused with `git fetch` if already cloned there).
 *
 * **These two calls, and only these two, take the `long` tier** (`GIT_TIMEOUT_MS`). They are
 * the only git this extension runs that talks to a network, and a full clone of a large
 * repository over a slow link legitimately takes minutes — a 30-second bound here would turn
 * a working clone into a failed build. Everything else stays on the short default, so the
 * generous bound buys the clone its time without lending it to a `git commit`.
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
    await git(['-C', dest, 'fetch', '--all', '--tags'], undefined, 'long');
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    onProgress?.(`cloning ${repo}…`);
    await git(['clone', repo, dest], undefined, 'long');
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

/** How long an interrupted build stays worth offering to resume (plan step 6e). */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

export function buildDir(target: string): string {
  return path.join(target, '.repo-tour', 'build');
}

export function markerPath(target: string): string {
  return path.join(buildDir(target), 'building.json');
}

/**
 * The three filesystem calls every durable write in this file makes, as one swappable
 * record. Real by default; a test injects a version whose `renameSync` throws to prove what
 * a crash at the worst possible instant actually leaves on disk (`BuildContext.writeOps`).
 */
export interface FsWriteOps {
  mkdirSync(dir: string): void;
  writeFileSync(file: string, data: string): void;
  renameSync(from: string, to: string): void;
}

export const realFsWriteOps: FsWriteOps = {
  mkdirSync: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
  writeFileSync: (file, data) => { fs.writeFileSync(file, data); },
  renameSync: (from, to) => { fs.renameSync(from, to); },
};

/**
 * Every durable write this file makes goes through here: serialise to `<file>.tmp` in the
 * SAME directory, then rename it over the real name. A rename within one filesystem is
 * atomic, so a crash leaves either the previous file or the complete new one — never a
 * truncated half file. Used for the write-ahead marker AND (T-3 rework, review finding 2)
 * for `plan.json`/`request.json`, which used to be plain `writeFileSync` calls: a crash
 * mid-write could leave a corrupt plan behind for T-4's walk to trip over.
 */
export function writeJsonAtomic(filePath: string, value: unknown, ops: FsWriteOps = realFsWriteOps): void {
  ops.mkdirSync(path.dirname(filePath));
  // The suffix is RANDOM, not a fixed `.tmp` (T-4 security review, finding 4). `writeFileSync`
  // follows symlinks, so a repository that commits `progress.json.tmp` as a symlink pointing
  // anywhere the user can write gets that file truncated and overwritten on the learner's very
  // first click — git recreates the symlink on clone, so it costs an attacker nothing. A name
  // the attacker cannot predict cannot be pre-planted, which closes that path without changing
  // the injected `FsWriteOps` shape every caller and test already depends on.
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  ops.writeFileSync(tmp, JSON.stringify(value, null, 2));
  ops.renameSync(tmp, filePath);
}

/** Write-ahead: temp file + rename, so there is never a half-written marker. */
function writeMarker(target: string, marker: BuildMarker, ops: FsWriteOps = realFsWriteOps): void {
  writeJsonAtomic(markerPath(target), marker, ops);
}

export function readMarker(target: string): BuildMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(target), 'utf8')) as BuildMarker;
  } catch {
    return null;
  }
}

/**
 * The marker at `target`, but only while it is still worth offering to resume (the same
 * 6-hour rule `resumeIfMarked` applies). A plain `fs` read and a clock comparison — no core
 * load, no notification — so activation can ask "is there anything to resume here?" before
 * paying for either (T-3 rework, review finding 1; see `src/extension.ts`).
 */
export function readFreshMarker(target: string, now: () => number = Date.now): BuildMarker | null {
  const marker = readMarker(target);
  if (!marker) return null;
  const ageMs = now() - new Date(marker.startedAt).getTime();
  if (ageMs > STALE_AFTER_MS) return null; // old enough that we stay quiet about it
  return marker;
}

function deleteMarker(target: string): void {
  try {
    fs.unlinkSync(markerPath(target));
  } catch {
    /* already gone — fine */
  }
  // And the folders the marker needed, when nothing else is in them (T-30). `validateTarget` refuses
  // a folder with anything in it, so an empty `.repo-tour/build/` left by a cancel or a refusal
  // turned the next press on the very same form into "not empty — pick an empty or new folder".
  // `rmdir`, not `rm -r`: it can only ever remove a directory that is already empty. And only real
  // directories: `rmdir` refuses a link at the end of a path but walks through one in the middle,
  // so a `.repo-tour` that is a symlink would have this removing `build` wherever it points
  // (T-30 security review, finding 5).
  const build = buildDir(target);
  const parent = path.dirname(build);
  try {
    if (!fs.lstatSync(parent).isDirectory() || !fs.lstatSync(build).isDirectory()) return;
    fs.rmdirSync(build);
    fs.rmdirSync(parent);
  } catch {
    /* not empty (a finished plan is in there), or already gone */
  }
}

/**
 * Where `digest` is told its cache lives: a path nothing creates. `digest` reads
 * `<outDir>/inventory.json` whether or not it writes, and by default that is
 * `<reference>/.repo-tour/inventory.json`, a file inside the repository being read: a symlink
 * committed there is followed out of the tree, or to `/dev/zero` (T-30 security review, findings 1
 * and 4). Nothing here uses what that read produces, so it is pointed at nothing.
 */
function noDigestCache(target: string): string {
  return path.join(buildDir(target), 'no-digest-cache');
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
  /** Polled between phases, and while `digest` and `buildPlan` run on a worker (T-30); returning
   *  true stops the build (cancelled from the progress notification). `interpretPlan` is not
   *  stopped by it, only followed by it: see T-70. */
  isCancelled?: () => boolean;
  /** Swappable filesystem writes — a test makes `renameSync` fail exactly where a crash
   *  would hurt most and asserts what is left on disk. Defaults to `realFsWriteOps`. */
  writeOps?: FsWriteOps;
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
  writeMarker(target, marker, ctx.writeOps ?? realFsWriteOps);
  ctx.onPhase?.(phase);
}

export async function buildFromRequest(request: BuildRequest, ctx: BuildContext): Promise<BuildOutcome> {
  try {
    return await runThePhases(request, ctx);
  } finally {
    ctx.core.release?.(); // a refusal after the digest, a failure, a cancel: nothing may keep a worker alive
  }
}

async function runThePhases(request: BuildRequest, ctx: BuildContext): Promise<BuildOutcome> {
  const target = request.target;
  const git = ctx.git ?? realGit;
  const marker: BuildMarker = { startedAt: new Date().toISOString(), phase: 'digest', request };

  let repoRoot: string;
  try {
    repoRoot = await resolveRepo(request.repo, ctx.globalStorageRoot, git, ctx.onProgress);
  } catch (err) {
    // Nothing was written yet — there is no marker to leave behind or clean up.
    const reason = err instanceof Error ? err.message : String(err);
    // The FIRST of the four sentences a stopped git gets, and the only one that is about
    // waiting rather than about a repository (T-13). `git ${args} timed out after 10 minutes`
    // is true and unreadable as the whole answer: what the person in front of the form needs
    // is that the ten minutes were the bound rather than the network's own answer, that
    // nothing has been written, and that pressing the button again is a reasonable thing to do.
    //
    // The learner-facing sentence is right; the reason once given for it here was not (review
    // finding 5). It said a half-finished clone is reused with `fetch`, so a retry is not a
    // fresh download. Driven twice — a clone from a path that does not exist, and a real
    // `file://` clone killed mid-transfer — `git clone` UNWINDS the destination it created:
    // the directory is gone, so `resolveRepo`'s `fs.existsSync(dest/.git)` is false and the
    // retry is a full fresh clone. That costs the download again and is worth knowing; what it
    // does not cost is any cleanup, which is what "Nothing was written" actually promises and
    // is exactly why git removing its own partial clone is the behaviour we want.
    if (gitTimedOut(err)) {
      return {
        ok: false,
        reason: `${reason}. Nothing was written, so nothing needs cleaning up — try again when the network is behaving, `
          + 'or clone the repository yourself and point Build Tutorials at the folder.',
      };
    }
    return { ok: false, reason };
  }

  runPhase(target, marker, 'digest', ctx);
  if (ctx.isCancelled?.()) return cancel(target, 'before reading the repository');

  let digestResult: DigestResultLike;
  try {
    ctx.onProgress?.('reading the repository…');
    // `write: false` (T-30). With `true`, repo-tour ends the digest by writing some 20,000 files of
    // cache into the REFERENCE repository, one `writeFileSync` at a time; a Cancel landing there
    // leaves a set of files from two runs. Nothing in this extension reads that cache (every path
    // it reads is under `<target>/.repo-tour/build/`), so the promise "Cancel leaves nothing
    // half-written" is true here by there being nothing written.
    digestResult = await ctx.core.digest(repoRoot, { write: false, outDir: noDigestCache(target) }, { isCancelled: ctx.isCancelled });
  } catch (err) {
    if (phaseCancelled(err)) return cancel(target, 'while reading the repository');
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
    plan = await ctx.core.buildPlan(digestResult, { root: repoRoot, witness: true }, { isCancelled: ctx.isCancelled });
  } catch (err) {
    if (phaseCancelled(err)) return cancel(target, 'while deriving the build order');
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
    // Atomic, and in this order on purpose: `request.json` first, then `plan.json`, then the
    // marker goes. At every instant in between, what is on disk is either a marker (so a
    // Resume finishes the job) or a COMPLETE plan — never a half-written file with nothing
    // left to signal that it is broken (T-3 rework, review finding 2).
    const writeOps = ctx.writeOps ?? realFsWriteOps;
    // `repoRoot`, not `request.repo`: for a GitHub URL those differ, and the one worth
    // recording is where the clone actually landed. Writing only the URL is what made the
    // dial silently refuse on every URL-built tutorial (T-5 security review, finding 2).
    writeJsonAtomic(path.join(buildDir(target), 'request.json'), { ...request, referenceRoot: repoRoot }, writeOps);
    writeJsonAtomic(path.join(buildDir(target), 'plan.json'), interpreted.plan, writeOps);
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
  const marker = readFreshMarker(target, ctx.now ?? Date.now);
  if (!marker) return undefined;

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
