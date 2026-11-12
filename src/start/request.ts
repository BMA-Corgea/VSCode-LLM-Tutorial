// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The start screen's form, as data — spec §5.2. `BuildRequest` is what the webview submits;
 * `validateRequest` is the one place that decides whether it is buildable. Pure (no
 * `vscode` import) and unit-testable on its own: `src/start/panel.ts` calls it on every
 * `form:changed`/`form:submit` message so the SAME rules run whether a test drives the
 * webview's message protocol or calls this function directly.
 *
 * "Pure" here means "independent of VS Code," not "free of the filesystem" — the repo field's
 * existence check is a plain synchronous `fs` read, deliberately: catching a typo'd path the
 * instant a field loses focus is worth more than deferring it to a failed clone attempt, and a
 * local, synchronous stat call costs nothing worth avoiding.
 *
 * **A control that silently declines is a broken control** (repo-tour lesson, T-3,
 * 2026-08-26): every branch below either returns `ok: true` or names a problem under a
 * specific field. There is no path that swallows a request and does nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a build keeps its own files inside the target, `<target>/.repo-tour/build/`, and the name of
 * its write-ahead marker there. Here rather than in `build.ts`, which imports this file, so that
 * `validateTarget` can recognise a folder holding nothing but an unfinished build (T-71).
 */
export const BUILD_DIR = ['.repo-tour', 'build'] as const;
export const MARKER_FILE = 'building.json';
/** The temp file of an atomic write (`writeJsonAtomic`: `<name>.<12 hex>.tmp`) that a crash cut short. */
export const ATOMIC_TMP = /^(?:building|request|plan)\.json\.[0-9a-f]{12}\.tmp$/;

/**
 * The targets this extension host is building right now, resolved (T-71 review F1). A build adds its
 * target for as long as it runs, whether a press or a Resume started it: the panel's own "a build
 * is running" flag knows nothing of a Resume.
 */
export const BUILDING_NOW = new Set<string>();
/** How often a running build rewrites its marker's `heartbeatAt`, so that another window can tell. */
export const HEARTBEAT_MS = 30_000;
/** A heartbeat older than this belongs to a build that is not running any more (a reload, a crash). */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS;
/** A marker with no heartbeat (one written before T-71) is taken as a build in progress for this long. */
const NO_HEARTBEAT_STALE_MS = 6 * 60 * 60 * 1000;
const PHASES = ['digest', 'plan', 'interpret', 'write'];

export type Dial = 'manual' | 'scaffolded' | 'automated';

export const DIALS: readonly Dial[] = ['manual', 'scaffolded', 'automated'];

export const DEFAULT_DIAL: Dial = 'manual';

export interface BuildRequest {
  idea: string;
  recreate: boolean;
  /** What the learner TYPED — a local path, or a GitHub URL. Kept verbatim so the record says
   *  what was asked for; it is NOT a path anything can read from. See `referenceRoot`. */
  repo: string;
  target: string;
  dial: Dial;
  /**
   * Where the reference actually LIVES on this machine, resolved at build time.
   *
   * For a local path these are the same string. For a GitHub URL they are not: the clone
   * lands in `<globalStorage>/refs/<owner>-<name>` and, until T-5's security review, that
   * location was computed and then thrown away — `request.json` recorded only the URL. Every
   * consumer that tried to read the reference from it (the dial's writer, the structural
   * check, the reproduce copy) resolved a URL as a relative path, got ENOENT, and refused
   * SILENTLY. Scaffolded and automated wrote nothing, *Check my work* answered "nothing to
   * check", and the ACs about reproducing the reference did not hold on the flow the README
   * documents first.
   *
   * Optional only for `request.json` files written before this field existed; `loadRequest`
   * falls back to `repo` for those, which is correct precisely because a build old enough to
   * lack it could only have been a local path.
   */
  referenceRoot?: string;
}

export function emptyRequest(): BuildRequest {
  return { idea: '', recreate: false, repo: '', target: '', dial: DEFAULT_DIAL };
}

export type RequestField = 'idea' | 'repo' | 'target';

export interface ValidationResult {
  ok: boolean;
  problems: Partial<Record<RequestField, string>>;
}

/**
 * The exact honesty line AC2 names verbatim. Byte-for-byte from THIS ticket's own spec,
 * `.autodev/specs/T-3-start-screen.md` line 12 ("captured, not re-composed") — no quotes
 * around recreate, no trailing period. It had been copied from the older
 * `.autodev/specs/T-1-build-tutorials-v1.md` §5.2 wording instead, which quotes it; the two
 * spec documents disagree and the ticket's own text is canonical (T-3 rework, review
 * advisory 1). Exported so the panel's client-side fallback rendering (a fresh page, before
 * any message round-trip) and every test that checks this wording read it from one place
 * rather than retyping it.
 */
export const IDEA_FIRST_MESSAGE = 'Idea-first builds arrive with T-9 — tick recreate to build from a repo';

const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/;

/** `null` when `repo` is not a GitHub URL at all — not an error, just "try the local-path rule instead." */
export function parseGithubUrl(repo: string): { owner: string; name: string } | null {
  const m = GITHUB_URL_RE.exec(repo.trim());
  if (!m) return null;
  const owner = m[1];
  const name = m[2];
  if (!owner || !name) return null;
  return { owner, name };
}

function validateRepo(recreate: boolean, repo: string): string | null {
  const trimmed = repo.trim();
  if (recreate && !trimmed) return 'required when recreating';
  if (!trimmed) return null; // not recreating and nothing typed — not this field's problem
  if (parseGithubUrl(trimmed)) return null;
  if (!path.isAbsolute(trimmed)) {
    return 'use an absolute local path, or a https://github.com/<owner>/<repo> URL';
  }
  if (!fs.existsSync(trimmed)) return `no folder found at ${trimmed}`;
  if (!fs.statSync(trimmed).isDirectory()) return `${trimmed} is not a folder`;
  return null;
}

function validateIdea(recreate: boolean, idea: string): string | null {
  // Deliberately independent of whether `repo` is also filled in (broader than the literal
  // "&& !repo" shorthand in this ticket's plan): v1's BuildPlan.mode is ALWAYS 'recreate'
  // (T-1 spec §7), so unticking recreate can never produce a plan regardless of what else is
  // filled in — an idea typed alongside a repo, with recreate off, is exactly as much a dead
  // end as an idea typed alone, and deserves the same honest line rather than silence.
  if (recreate) return null;
  const trimmed = idea.trim();
  if (trimmed) return IDEA_FIRST_MESSAGE;
  return 'say what you want to build, or tick recreate';
}

function validateTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return 'pick an empty or new folder';
  if (!path.isAbsolute(trimmed)) return 'pick an absolute path for the target folder';
  // First, and whatever the folder holds yet: a Resume still cloning has written nothing (review F1).
  if (BUILDING_NOW.has(path.resolve(trimmed))) return `a build is running in ${trimmed} now — wait for it to finish, or pick an empty or new folder`;
  if (!fs.existsSync(trimmed)) return null; // a new folder — created when the build starts
  if (!fs.statSync(trimmed).isDirectory()) return `${trimmed} is not a folder`;
  if (fs.readdirSync(trimmed).length === 0) return null;
  // T-71: a folder holding nothing but a build of ours that failed or was interrupted is not in use.
  // The press builds there again, as Resume would (it re-runs from the start, and the model's answers
  // already paid for are cached), instead of sending the learner to find another folder.
  const unfinished = unfinishedBuildIn(trimmed);
  if (unfinished === 'build-again') return null;
  if (unfinished === 'maybe-running') {
    return `${trimmed} holds a build that was still working a moment ago, perhaps in another window — wait for it to finish, or pick an empty or new folder`;
  }
  return `${trimmed} is not empty — pick an empty or new folder`;
}

/**
 * Whether `target` holds NOTHING but one of this extension's own unfinished builds (T-71), and if it
 * does, whether a press here may build there again.
 *
 * Nothing but: `.repo-tour/` holding only `build/`, holding only the marker, the `request.json` a
 * write that got that far left, and the temp file of an atomic write a crash cut short. All of them
 * real directories and files, never a link, because the next build writes through them. No
 * `plan.json`: that is a FINISHED tutorial, and building over it would replace it.
 *
 * Again only when the marker's build cannot still be running, because two builds in one folder
 * would race each other's writes (review F1, F4). A running build rewrites `heartbeatAt` every
 * `HEARTBEAT_MS`, and one that ended writes `endedAt` as it leaves. So: ended, or a heartbeat older
 * than `HEARTBEAT_STALE_MS` (its window reloaded or crashed, on this machine or another): build
 * again. A fresh heartbeat: maybe running, perhaps in another window. A marker with no heartbeat
 * (written before T-71): maybe running for 6 hours from its start, then not. A build of THIS host
 * is refused before this is asked (`BUILDING_NOW`, in `validateTarget`).
 */
export function unfinishedBuildIn(target: string, now: number = Date.now()): 'build-again' | 'maybe-running' | null {
  const isDir = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  const isFile = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false })?.isFile() === true;
  try {
    const repoTour = path.join(target, BUILD_DIR[0]);
    const build = path.join(repoTour, BUILD_DIR[1]);
    const top = fs.readdirSync(target);
    if (top.length !== 1 || top[0] !== BUILD_DIR[0] || !isDir(repoTour)) return null;
    const middle = fs.readdirSync(repoTour);
    if (middle.length !== 1 || middle[0] !== BUILD_DIR[1] || !isDir(build)) return null;
    const names = fs.readdirSync(build);
    if (!names.includes(MARKER_FILE)) return null;
    for (const name of names) {
      if (name !== MARKER_FILE && name !== 'request.json' && !ATOMIC_TMP.test(name)) return null;
      if (!isFile(path.join(build, name))) return null;
    }
    const marker = JSON.parse(fs.readFileSync(path.join(build, MARKER_FILE), 'utf8')) as unknown;
    if (typeof marker !== 'object' || marker === null) return null;
    const { startedAt, phase, request } = marker as Record<string, unknown>;
    if (typeof startedAt !== 'string' || typeof phase !== 'string' || !PHASES.includes(phase) || typeof request !== 'object' || request === null) {
      return null;
    }
    return markerSaysRunning(marker as Record<string, unknown>, now) ? 'maybe-running' : 'build-again';
  } catch {
    return null; // unreadable, or a marker that does not parse: not something to build over
  }
}

/**
 * Whether the build that wrote `marker` may still be running (T-71 reviews F1, F4 and the re-review's
 * R1, R3). The one rule the form's press and the reload's Resume prompt both apply:
 *   - it says it ended (`endedAt`): not running;
 *   - its extension host was on THIS machine, among the same process ids (`pidSpace`, re-check N2),
 *     and that process is gone (a reload, a crash): not running, at once, whatever its heartbeat says.
 *     A pid only ever declares a build dead early; it never makes one alive (ids are reused), and a
 *     clock that jumped cannot keep a dead build alive;
 *   - otherwise its heartbeat decides: fresh, running (perhaps in another window, or on another
 *     machine sharing the folder); older than `HEARTBEAT_STALE_MS`, not;
 *   - a marker from before heartbeats: running for 6 hours from its start, then not, when a press
 *     asks (`withoutHeartbeat` 'running', the cautious default); not running when the reload's Resume
 *     prompt asks ('not-running'), which offered such a marker before T-71 and still does: it is the
 *     interrupted build that prompt exists for, and only a fresh heartbeat proves a build alive.
 */
export function markerSaysRunning(
  marker: Record<string, unknown>,
  now: number = Date.now(),
  withoutHeartbeat: 'running' | 'not-running' = 'running',
): boolean {
  if (typeof marker.endedAt === 'string') return false;
  if (pidIsAskable(marker) && !processAlive(marker.pid as number)) return false;
  const beat = typeof marker.heartbeatAt === 'string' ? Date.parse(marker.heartbeatAt) : Number.NaN;
  if (!Number.isNaN(beat)) return now - beat < HEARTBEAT_STALE_MS;
  if (withoutHeartbeat === 'not-running') return false;
  const started = typeof marker.startedAt === 'string' ? Date.parse(marker.startedAt) : Number.NaN;
  return Number.isNaN(started) || now - started < NO_HEARTBEAT_STALE_MS;
}

/**
 * Whether the extension host that wrote `marker` is a live process that this one can see by its pid
 * (T-71 re-check N1). True for the window whose build it is, and also, for up to 6 s after a reload,
 * for that window's old host while it closes.
 */
export function markerHostAlive(marker: Record<string, unknown>): boolean {
  return pidIsAskable(marker) && processAlive(marker.pid as number);
}

/**
 * Whether `marker.pid` names a process that THIS process can ask about (T-71 re-check N2). That holds
 * only on the same machine AND among the same set of process ids. WSL beside Windows, a host-network
 * container, and two machines with a stock hostname each share a hostname, not their pids: there, a
 * live build's pid reads as gone. A marker that does not say its pid space (one from before this rule,
 * or one written where it cannot be told) is left to its heartbeat.
 */
function pidIsAskable(marker: Record<string, unknown>): boolean {
  const here = pidSpace();
  return typeof marker.pid === 'number' && marker.host === os.hostname()
    && here !== undefined && marker.pidSpace === here;
}

let ownPidSpace: string | null | undefined;

/**
 * The set of process ids this process's own id belongs to (T-71 re-check N2), recorded with the pid in
 * a build's marker. On Linux that is this boot of this kernel (`boot_id`) and this pid namespace. Every
 * other platform has one set per machine; across platforms, as with WSL beside Windows, the names
 * differ. `undefined` when it cannot be told, and then the pid rule is not used at all.
 */
export function pidSpace(): string | undefined {
  if (ownPidSpace === undefined) {
    ownPidSpace = null;
    if (process.platform === 'linux') {
      try {
        const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        const namespace = fs.readlinkSync('/proc/self/ns/pid');
        if (boot !== '' && namespace !== '') ownPidSpace = `linux:${boot}:${namespace}`;
      } catch { /* not told: leave every marker to its heartbeat */ }
    } else {
      ownPidSpace = process.platform;
    }
  }
  return ownPidSpace ?? undefined;
}

/** Whether a process with this id exists. EPERM means it does, under another user. */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The request as a build is given it (T-71 re-review R4): the repository and the folder the form
 * validated, which are the trimmed ones, and the folder in one spelling (`path.resolve`). Applied once,
 * where a press enters (`form:submit`), so that the folder validated, the bookmark, the marker's
 * `request.target`, `BUILDING_NOW`'s key and the folder built in are one string. A trailing space used
 * to build `<folder> ` beside the folder the form had checked. The form keeps what was typed.
 */
export function normaliseRequest(req: BuildRequest): BuildRequest {
  const target = req.target.trim();
  return { ...req, repo: req.repo.trim(), target: target ? path.resolve(target) : target };
}

export function validateRequest(req: BuildRequest): ValidationResult {
  const problems: Partial<Record<RequestField, string>> = {};

  const repoProblem = validateRepo(req.recreate, req.repo);
  if (repoProblem) problems.repo = repoProblem;

  const ideaProblem = validateIdea(req.recreate, req.idea);
  if (ideaProblem) problems.idea = ideaProblem;

  const targetProblem = validateTarget(req.target);
  if (targetProblem) problems.target = targetProblem;

  return { ok: Object.keys(problems).length === 0, problems };
}
