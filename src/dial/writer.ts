// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the dial actually WRITES — the three positions turned into bytes in the learner's
 * folder (spec §5.4; ACs 2, 3, 4, 6).
 *
 * This module PLANS a write and, separately, performs one. It never decides *when* to write:
 * that is `src/walk/session.ts`'s job, because only the session knows which step the learner
 * is on, which dial applies to it, and whether the learner has already edited the file it is
 * about to replace. Keeping the two apart is what makes ACs 2/3/4/6 provable under plain
 * mocha — `planWrite` is a pure function of (step, dial, the reference tree), so its answer
 * can be compared byte-for-byte against the reference with no extension host, no webview and
 * no learner in the loop.
 *
 * **No `vscode` import, value or type**, and here that is load-bearing rather than stylistic:
 * `esbuild.mjs`'s `test/unit/*.test.ts` bundle is built with `external: ['repo-tour',
 * 'mocha']` and deliberately NOT `vscode`, so a single such import anywhere reachable from a
 * unit test fails the BUILD and takes the whole unit suite with it (`src/walk/session.ts`'s
 * header spells this out at length).
 *
 * ## The three positions — and why "nothing" is a real answer
 *
 *   - **manual** (AC2) — the extension writes nothing at all. Not "writes an empty file",
 *     not "creates the folder": nothing. The learner creates the file themselves, which is
 *     the entire point of the position, and the acceptance check is literally that the target
 *     tree is unchanged after opening the step. What the panel shows instead comes from
 *     `fileShape` — the first line of each load-bearing range plus the reference's imports —
 *     which is enough to know what to write and never the answer.
 *   - **scaffolded** (AC3) — the reference file with its boilerplate ranges copied verbatim
 *     and its load-bearing ranges replaced by repo-tour's own `stubFile`. The stub is the
 *     core's to produce, never ours: it is the one piece of this that has to emit
 *     language-correct syntax, it already knows the three ways a TS/JS body can open and the
 *     two shapes a Python body can take, and every fallback in it resolves toward "leave the
 *     range alone" rather than toward a guess. AC3's own check — the written file parses with
 *     zero tree-sitter ERROR nodes — is asserted against the real core in
 *     `test/unit/dial-writer.test.ts` for TS, JS and Python, because a scaffold that does not
 *     parse is worse than no scaffold at all: it greets the learner with red squiggles they
 *     did not cause and cannot read past.
 *   - **automated** (AC4/AC6) — the reference file, byte for byte.
 *
 * ## Byte-for-byte is an acceptance criterion, not an aspiration
 *
 * AC6 is checked by `diff -r`ing a fully walked target against the reference repository, so
 * *nothing here normalises anything*: no line-ending translation, no appended trailing
 * newline, no re-indentation, no re-encoding. A file read and written back must produce the
 * identical bytes, and `readReference` proves that rather than assuming it — it re-encodes
 * what it decoded and compares buffers, refusing a file that does not survive the round trip.
 * That single check is what stops a stray binary or Latin-1 file that slipped into a `file`
 * step from being silently rewritten as U+FFFD replacement characters and surfacing hours
 * later as an unreadable diff in the acceptance run. Files that genuinely are not text belong
 * in `plan.reproduce`, which never goes through a string at all.
 *
 * (Scaffolded output is the one exception, and it is repo-tour's exception rather than ours:
 * `stubFile` splits on `/\r?\n/` and rejoins with `\n`. A scaffold has no byte-equality
 * requirement — it is deliberately not the reference file — so this is left exactly as the
 * core produces it instead of being "corrected" behind the core's back.)
 *
 * ## AC6 has a SECOND exception since T-12, and it is a real one
 *
 * **A withheld `reproduce` entry is a file the reference has and the target never will, so
 * `diff -r` reports it — and AC6, read literally, is conditionally false.** `withheldReason`
 * (below `reproduceEntries`) refuses to copy a file whose NAME says it carries credentials or
 * configures an agent that would then run in the learner's folder, which means a fully walked
 * target cannot come back clean against any reference carrying one. **repo-tour is such a
 * reference** — it commits `.claude/settings.json` — so this is the default demo path and not
 * a corner: measured, repo-tour's real reproduce list is 27 entries with exactly one withheld,
 * and this repository's is 22 with two.
 *
 * The criterion still means what it was written to mean, and the exact restatement is: *a
 * fully walked target reproduces the reference byte for byte, except for the entries the
 * withholding rule refuses, each of which is named to the learner as it is refused.* That is a
 * deliberate, announced subtraction rather than a silent one — there is a problem line per
 * refusal and the learner is told to copy the file in if they want it — but a reader checking
 * AC6 with `diff -r` against a repository like repo-tour will see output, and must not read it
 * as a regression.
 *
 * `test/dial.test.ts`'s AC6 pair still passes unmodified, and the reason is worth knowing
 * rather than relying on: its fixture's never-taught files (`data/seed.bin`, `data/seed.json`,
 * `src/generated.ts`) happen to carry no withheld name. That is a property of the fixture, not
 * a property of the criterion. **The AC6 text itself needs this same note**; it is stated here
 * because this is the file that makes the exception.
 *
 * ## Containment, on BOTH ends of every copy
 *
 * `step.target.file` and every `plan.reproduce` entry come out of `plan.json`, which is
 * generated from a repository the learner merely pointed us at — untrusted input that usually
 * looks like an ordinary relative path. `path.join` is not a containment check and never was
 * (`src/walk/paths.ts` carries the full argument). T-4 added `resolveInsideTarget` *because*
 * T-5 turns its read primitive into a write primitive, so every path in this file goes
 * through it: the destination under `<target>`, and the source under the reference root too,
 * since a `../../..` entry in `reproduce` would otherwise copy any file the learner can read
 * into their project.
 *
 * That is the LEXICAL half, and on its own it is NOT containment. `resolveInsideTarget` is
 * pure `path` arithmetic — it has to be, since `src/walk/session.ts` cannot import `fs` — so
 * it answers "does this string stay under that string", and a string can lie about where it
 * lands. A repository that commits a directory symlink, which git recreates on clone for free:
 *
 *     up -> ../outside
 *     resolveInsideTarget(target, 'up/victim.txt')  ->  <target>/up/victim.txt   (contained!)
 *     write there                                   ->  <outside>/victim.txt     (overwritten)
 *
 * gets past every lexical check intact, and `mkdirSync(…, { recursive: true })` then accepts
 * the symlinked directory without complaint. That is T-5's security review finding 1, and it
 * is not only a question of hostile repositories: pnpm makes every `node_modules/<pkg>` a
 * directory symlink into a global store, and repo-tour classifies `node_modules` as vendored,
 * which puts it straight into `plan.reproduce`. An ordinary learner with an ordinary lockfile
 * can walk into this.
 *
 * So there is a second, FILESYSTEM half here, and it is the one that actually contains.
 * `prepareDirectory` creates the destination's own directory and then asks the filesystem
 * where that directory really is, requiring `realpath(dir)` to sit inside `realpath(target)`;
 * `insideRealRoot` is its read-only twin for the reference side, which must not create
 * anything. Creating the directory FIRST is the whole point rather than an implementation
 * detail: a path that does not exist yet can only be guessed at, and the only directory worth
 * an answer is the one the write is about to use.
 *
 * The two halves are kept apart rather than merged because they fail differently and are
 * needed in different places. The lexical one is cheap, total, and available to code that
 * cannot touch a disk — the session, the model, the panel — and it is what rejects `..` and an
 * absolute path before anything is created at all. The filesystem one costs syscalls, can only
 * answer about paths that exist, and belongs exactly here. Neither is redundant: a lexical
 * pass with no `realpath` is the hole above, and a `realpath` pass with no lexical pass would
 * cheerfully `mkdir -p` its way out of the target before it ever thought to look.
 *
 * A symlinked TARGET stays legitimate, and deliberately so — `/tmp` is a symlink on macOS and
 * `os.tmpdir()` sits under one, so a learner building in a temp folder is the ordinary case,
 * not the attack. The target is realpath'd too, and only links BELOW it are refused.
 *
 * ## Containment answers WHERE. It never asks WHAT
 *
 * Everything above is about the destination and the source: does this path stay inside the two
 * roots, on the disk as well as in the string. Both halves are sound and both were re-verified
 * — and a file can pass every one of them and still be a file that has no business being copied
 * into somebody's project. `plan.reproduce` is generated from a repository the learner merely
 * pointed us at, repo-tour classifies anything it cannot parse as `data`, and `data` is the
 * reproduce bucket, so a reference repo's committed `.env`, `.mcp.json` or `.claude/settings.json`
 * arrives here looking exactly like a lockfile. `withheldReason`, below `reproduceEntries`, is
 * the check that asks the other question, and its own comment carries the rule in prose. This
 * paragraph exists because the last time this header described a defence it stopped one step
 * short and said so with confidence, and that sentence cost more than the missing code did.
 *
 * ## A refusal is a VALUE, never a throw
 *
 * When a path is refused the write does not happen — but "did not happen" must reach the
 * learner, and it must not reach them as an exception. This code runs from the session's
 * navigation path, which is a `void`ed promise: a throw there is swallowed in silence, and
 * `src/walk/store.ts` already carries the scar from exactly that failure mode. So `planWrite`
 * returns a third thing, `{ refused }`, alongside a plan and a `null`. It is a separate type
 * rather than another `null` for one reason worth stating plainly: `null` already means
 * "there is nothing to write here, and that is correct" (manual mode, a non-`file` step), and
 * a caller that cannot tell those apart will report a security refusal as a normal quiet
 * no-op. Being a distinct member of the union also means TypeScript will not let a caller
 * reach `.content` without narrowing first, so the check cannot be forgotten — it does not
 * compile. `reproduceFiles` answers the same way, with a list of problem lines meant to be
 * shown, one per entry that did not make it.
 *
 * ## The write itself: temp file, then rename, under a name nobody can guess
 *
 * `writeTextAtomic` is the text sibling of `src/start/build.ts`'s `writeJsonAtomic`, and it
 * is a sibling rather than a caller because that one JSON-stringifies — handing it source
 * text would write a quoted JSON string into the learner's `.ts` file. Everything else about
 * it is deliberately identical, including both reasons for the shape:
 *
 *   - **temp + rename is atomic**, so a crash mid-write leaves either the previous file or
 *     the complete new one, never a truncated half of the learner's next step;
 *   - **the temp suffix is random** (T-4 security review, finding 4): `writeFileSync` follows
 *     symlinks, so a repository that commits `parse.ts.tmp` as a symlink pointing anywhere
 *     the user can write gets that file truncated on the learner's first click, and git
 *     recreates the symlink on clone so it costs the attacker nothing. A name that cannot be
 *     predicted cannot be pre-planted.
 *
 * `renameSync` closes the same hole at the *destination*, and precisely that much: rename(2)
 * replaces a symlink rather than following it, so a planted `src/parse.ts -> ~/.bashrc` ends
 * up overwritten with an ordinary file instead of writing through to the target.
 *
 * That is the FINAL component, and nothing else. It says nothing about a symlinked DIRECTORY
 * on the way there, because `mkdirSync(…, { recursive: true })` accepts one happily and
 * rename(2) is then asked to replace a name that is already outside the folder — where it
 * does its job perfectly and the file still lands in the wrong place. This header claimed the
 * rename "closes the same hole" full stop until T-5's security review found otherwise, and
 * the wrong sentence was the more expensive half of the bug: half a defence that documents
 * itself as whole is worse than none, because it stops the next reader looking. The directory
 * components are `prepareDirectory`'s job, above; the final component is rename's; neither
 * covers the other, and all three properties are pinned by tests, because all three are
 * invisible when they work.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Dial } from '../start/request.js';
import type { PlanLike, RangeLike, StepLike } from '../walk/model.js';
import { resolveInsideTarget } from '../walk/paths.js';
import { languageOf, stubQuestionsFor, type DialCore } from './core.js';

/** A write that is ready to happen: an absolute path inside the target, and its exact bytes. */
export interface PlannedWrite {
  path: string;
  content: string;
}

/** Why nothing will be written — a sentence meant to be shown to the learner as-is. */
export interface WriteRefusal {
  refused: string;
}

/** The result of `planWrite`: a write, a refusal, or `null` for "nothing to write, correctly". */
export type WritePlan = PlannedWrite | WriteRefusal | null;

/** Narrows a `WritePlan`; a caller cannot reach `.content` without calling this first. */
export function isRefusal(plan: WritePlan): plan is WriteRefusal {
  return plan !== null && 'refused' in plan;
}

/** An untrusted path, shortened for a message. A plan is generated data, and a message that
 *  quotes a ten-kilobyte path back at the learner is its own small denial of service. */
function label(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 119)}…`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── containment, the half that needs a filesystem ───────────────────────────────────────────

/**
 * Where `p` really is, or `null` when the filesystem will not say — a broken link, a loop, a
 * path that is not there, a directory nobody may traverse.
 *
 * `null` is deliberately not distinguished from any other failure here. Every caller below
 * treats "cannot resolve" as a reason to stop rather than as an error to classify, because
 * there is exactly one safe answer to "I could not find out where this write would land" and
 * it is the same for all of them.
 */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * CREATES the directory `absPath` will be written into and proves it is really inside `root`.
 * `null` means it is; anything else is a predicate phrase saying what is wrong, ready to be
 * dropped into a caller's own sentence.
 *
 * This is the half `resolveInsideTarget` cannot do, and the failure it prevents is precise: a
 * repository commits `up -> ../outside`, the plan names `up/victim.txt`, every lexical check
 * agrees the path is contained, and the write lands in `outside/victim.txt` — overwriting
 * whatever was there. `realpath` is the only thing that can tell those two apart, because the
 * difference between them is not in the path, it is on the disk.
 *
 * **The order is the design**, and it is three steps rather than two:
 *
 *   1. the deepest ancestor that ALREADY exists is resolved and checked FIRST, before anything
 *      is created. Skipping this would still refuse the write, but only after `mkdirSync(…,
 *      { recursive: true })` had followed the planted link and made `<outside>/deep/` on its
 *      way down. No bytes, but a hostile plan should not get to create so much as an empty
 *      directory outside the folder the learner named, and a check that has already had a side
 *      effect by the time it says no is not much of a check;
 *   2. the directory is then created, because `realpath` can only answer about a path that
 *      exists, and the question is not "where would a directory of that name be" but "where is
 *      the directory I am about to write into";
 *   3. and it is resolved AGAIN and used immediately, because anything resolved earlier is a
 *      different question with the same shape. A check against a path the caller worked out
 *      before it went off to ask the learner something is a check against the past. Step 3 is
 *      the authoritative one; step 1 exists to keep step 2 from doing damage.
 *
 * Creating a directory is not writing the learner's file, and that distinction is what keeps
 * this compatible with AC2: manual mode never reaches here at all (`planWrite` returns before
 * it), and every caller that does reach it is one instruction away from writing. A refused
 * destination therefore leaves at most an empty directory inside the learner's own folder —
 * never anything at all outside it, which is the property that matters.
 *
 * Every filesystem failure is a refusal, not a shrug. `mkdirSync` throwing means the write was
 * never going to work anyway; `realpath` throwing means we do not know where the write would
 * go, and "somewhere I cannot name" is not a place to put a file.
 */
function prepareDirectory(root: string, absPath: string): string | null {
  const dir = path.dirname(absPath);
  const realRoot = realOrNull(root);
  if (realRoot === null) {
    return 'is meant for a folder the filesystem could not resolve, so where it would land is unknown';
  }

  // Step 1 — look before creating. Both sides are realpath'd, which is also what keeps a
  // symlinked TARGET legitimate: `/tmp` is a symlink on macOS and `os.tmpdir()` sits under
  // one, so comparing a resolved directory against an UNRESOLVED root would refuse every
  // ordinary build in a temp folder and teach the next reader to delete the check.
  const anchor = deepestExisting(dir);
  const realAnchor = realOrNull(anchor);
  if (realAnchor === null || resolveInsideTarget(realRoot, realAnchor) === null) {
    return 'reaches outside the folder you are building in through a symlink';
  }

  // Step 2.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return `needs a folder that could not be created — ${messageOf(err)}`;
  }

  // Step 3 — the one that counts, on the directory that now exists.
  const realDir = realOrNull(dir);
  if (realDir === null) {
    return 'has a destination the filesystem could not resolve, so where it would land is unknown';
  }
  if (resolveInsideTarget(realRoot, realDir) === null) {
    return 'reaches outside the folder you are building in through a symlink';
  }
  return null;
}

/**
 * The deepest ancestor of `dir` (including `dir`) that is there right now.
 *
 * `existsSync` rather than `lstatSync` on purpose: this is asked in order to be `realpath`'d,
 * and a dangling symlink — which exists as a link but resolves to nothing — is a path
 * `realpath` cannot answer about either. Walking past it lands on the last real directory
 * above, which is checked instead, and `mkdirSync` then fails on the link with EEXIST and is
 * reported. The loop terminates because `path.dirname` is its own fixed point at the root.
 */
function deepestExisting(dir: string): string {
  let at = dir;
  for (;;) {
    if (fs.existsSync(at)) return at;
    const up = path.dirname(at);
    if (up === at) return at;
    at = up;
  }
}

/**
 * Whether `absPath` really lives inside `root` — the READ-side twin of `prepareDirectory`,
 * which must not create anything, since the reference repository is the learner's clone of
 * somebody else's project and we have no business adding directories to it.
 *
 * The failure this prevents is the mirror image of the write one: a `reproduce` entry or a
 * `target.file` of `vendor -> /home/you/.ssh` reads a file the learner can read and copies it
 * into a project they are about to commit and push. Lexical containment cannot see it, for
 * the same reason it cannot see the write.
 *
 * A path that will not resolve is answered `true`, and that is not a hole: `realpath` fails
 * where `open` fails, so the caller's own read is about to fail too and will say so in words
 * that are more use to a learner than this function's would be ("that file is not in the
 * reference" beats "that file could not be resolved"). The one case that IS refused here is a
 * root that will not resolve while the file does, because then there is nothing to compare
 * against and a comparison against nothing must not come back "contained".
 */
function insideRealRoot(root: string, absPath: string): boolean {
  const realPath = realOrNull(absPath);
  if (realPath === null) return true;
  const realRoot = realOrNull(root);
  if (realRoot === null) return false;
  return resolveInsideTarget(realRoot, realPath) !== null;
}

/**
 * The name `absPath` really has inside `root` — the path its symlinks resolve to, expressed
 * relative to the root, or `null` when either end will not resolve.
 *
 * The read-side twin of `insideRealRoot` asks WHERE a path lands; this asks WHAT it is called
 * once it has landed, and the two are different questions about the same `realpath`. It exists
 * for one job: `reproduceFiles` judges an entry by its name, and a reference repository is free
 * to commit `config.json -> .env`, at which point the name the plan spells and the name of the
 * file it delivers are not the same string. Both stay inside the reference, so containment is
 * satisfied and silent.
 *
 * `null` on any failure, for the same reason `realOrNull` gives one: the caller's own read is
 * about to fail on an unresolvable path and will say so in better words. A caller must treat
 * `null` as "no second opinion", never as "cleared".
 */
function realNameInside(root: string, absPath: string): string | null {
  const realPath = realOrNull(absPath);
  const realRoot = realOrNull(root);
  if (realPath === null || realRoot === null) return null;
  if (resolveInsideTarget(realRoot, realPath) === null) return null;
  const relative = path.relative(realRoot, realPath);
  return relative.length === 0 ? null : relative;
}

// ── reading the reference ───────────────────────────────────────────────────────────────────

type ReferenceRead = { text: string } | WriteRefusal;

/**
 * The reference file's text, or why there is none. Contained (the source end of the copy is
 * as untrusted as the destination end) and proven to survive the UTF-8 round trip, so every
 * caller below can treat `text` as "exactly these bytes, decoded".
 */
function readReference(refRoot: string, file: string): ReferenceRead {
  const abs = resolveInsideTarget(refRoot, file);
  if (abs === null) {
    return { refused: `${label(file)} points outside the reference repository, so there is nothing to copy from` };
  }
  // The lexical check above and this one are two different questions, and only the pair of
  // them is containment: `vendor/keys` may sit under `refRoot` as a string while `vendor` is a
  // symlink to somewhere in the learner's home directory, and the answer would then be shown
  // in the panel and written into a folder that is about to be committed.
  if (!insideRealRoot(refRoot, abs)) {
    return { refused: `${label(file)} leaves the reference repository through a symlink, so there is nothing to copy from` };
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
  } catch (err) {
    return { refused: `the reference file ${label(file)} could not be read — ${messageOf(err)}` };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { refused: `${label(file)} is not UTF-8 text — a file like that is reproduced from the plan's reproduce list, never taught as a step` };
  }
  return { text };
}

// ── planning a write ────────────────────────────────────────────────────────────────────────

function isRange(value: unknown): value is RangeLike {
  if (typeof value !== 'object' || value === null) return false;
  const range = value as Record<string, unknown>;
  const start = range['startLine'];
  const end = range['endLine'];
  return typeof start === 'number' && typeof end === 'number'
    && Number.isInteger(start) && Number.isInteger(end)
    && start >= 1 && end >= start;
}

/**
 * The step's load-bearing ranges, or `null` if what the plan carries is not a list of ranges.
 *
 * Returned in the plan's OWN order, never sorted or filtered, because `stubQuestionsFor` maps
 * over the same array and `stubFile` indexes its questions by each range's original position
 * — reordering here would silently attach step 9's question to step 4's stub. A malformed
 * range is refused for the whole file rather than dropped for exactly that reason: dropping
 * one shifts every question after it, and `stubFile`'s own handling of a `NaN` line number
 * quietly truncates the rest of the file.
 */
function loadBearingOf(step: StepLike): RangeLike[] | null {
  const ranges: unknown = step.scaffold?.loadBearing;
  if (!Array.isArray(ranges)) return null;
  return ranges.every(isRange) ? ranges : null;
}

function symbolStepsOf(plan: PlanLike): StepLike[] {
  return Array.isArray(plan.steps) ? plan.steps.filter((s) => s?.kind === 'symbol') : [];
}

/**
 * What this step's dial position writes — or `null` when the honest answer is "nothing".
 *
 * `null` covers the two cases where writing nothing is correct: a `shape` or `symbol` step
 * (neither owns a file — a shape step's `target.file` is a DIRECTORY, and a symbol step lives
 * inside a file some earlier `file` step already wrote), and manual mode, which is the
 * position's entire meaning. A `{ refused }` means something was wrong enough that writing
 * anything would be a lie: the destination leaves the learner's folder, the reference is
 * unreadable or is not text, the plan's ranges are not ranges, or repo-tour has no grammar
 * for this file and a "scaffold" of it would hand over the answer rather than hide it.
 *
 * The ONE thing this consults the filesystem for at the destination is containment: the last
 * act before handing back a write is `prepareDirectory`, which creates the destination's
 * directory and proves that directory is really inside the target (see the header — the
 * lexical check above cannot see a symlink, and a symlinked directory is how a repository
 * turns a contained path into a write outside the folder). It is the last act rather than the
 * first so that a plan refused for any OTHER reason — an unreadable reference, ranges that are
 * not ranges, a language repo-tour cannot stub — leaves the learner's folder exactly as it
 * found it.
 *
 * Nothing else here consults the filesystem at the destination. Whether the file already
 * exists, and whether the learner has edited it, is the session's question (spec §5.4: never
 * overwrite a learner's edits silently) and it needs a prompt, which needs `vscode`.
 */
export function planWrite(
  step: StepLike,
  dial: Dial,
  refRoot: string,
  target: string,
  plan: PlanLike,
  core: DialCore,
): WritePlan {
  if (step.kind !== 'file') return null;
  if (dial === 'manual') return null;

  const file = step.target.file;
  const dest = resolveInsideTarget(target, file);
  if (dest === null) {
    return { refused: `${label(String(file))} points outside the folder you are building in — nothing was written` };
  }

  const read = readReference(refRoot, file);
  if ('refused' in read) return read;

  // Every `return` below that carries bytes goes through here and none may go around it: this
  // is the filesystem half of containment, and the reason it is a closure rather than three
  // copies of two lines is that three copies is how the fourth return gets added without one.
  const settled = (content: string): WritePlan => {
    const wrong = prepareDirectory(target, dest);
    if (wrong !== null) {
      return { refused: `${label(String(file))} ${wrong} — nothing was written` };
    }
    return { path: dest, content };
  };

  if (dial === 'automated') return settled(read.text);

  const loadBearing = loadBearingOf(step);
  if (loadBearing === null) {
    return { refused: `the plan's load-bearing lines for ${label(file)} are not line ranges — nothing was written` };
  }
  // Nothing load-bearing means the plan says the whole file is boilerplate, and boilerplate is
  // copied verbatim in every position that writes at all. Short-circuiting also keeps a file
  // whose language has no grammar working in the one case where the grammar is irrelevant.
  if (loadBearing.length === 0) return settled(read.text);

  const language = languageOf(file);
  if (language === undefined) {
    return {
      refused: `repo-tour has no grammar for ${label(file)}, so its load-bearing lines cannot be stubbed — scaffolding it would hand over the answer instead of hiding it`,
    };
  }

  const questions = stubQuestionsFor(step, symbolStepsOf(plan));
  return settled(core.stubFile(read.text, loadBearing, language, questions));
}

// ── the shape of a file the learner is about to write themselves (AC2) ──────────────────────

export interface FileShape {
  /** the first line of each load-bearing range, in file order */
  signatures: string[];
  /** the reference's import statements, one per entry, continuations folded in */
  imports: string[];
}

/** A JS-like import: `import …`, a re-export with a source, or a `require` binding. */
const JS_IMPORT = /^\s*import\b/;
const JS_REEXPORT = /^\s*export\b.*\bfrom\s*['"`]/;
const JS_REQUIRE = /^\s*(?:const|let|var)\b.*\brequire\s*\(/;
/** Python: `import x`, `import x as y`, `from . import x`, `from a.b import c`. */
const PY_IMPORT = /^\s*(?:import\s+\S|from\s+\S+\s+import\b)/;
/** How far a single import statement may run before we stop folding lines into it. */
const MAX_IMPORT_LINES = 20;

/**
 * The imports, read lexically rather than through the core's `extract`.
 *
 * `extract` is async, needs an inventory-shaped `FileRecord` and a loaded grammar, and would
 * make the panel's manual block wait on a parser; this is a list of lines to show a person
 * who is about to type them, not a fact anything downstream computes with, so a line scan is
 * the proportionate tool. It deliberately mirrors what repo-tour's own `jsImports` counts as
 * an import — `import_statement`, an `export_statement` carrying a source, and `require(…)` —
 * so the two do not disagree about what the file depends on.
 *
 * A JS import broken across lines (`import {`, a name per line, `} from './x.js'`) is folded
 * back into one entry, since that is one thing for the learner to write. The fold ends at the
 * first quote, which is where the module specifier is — and it is JS-only for exactly that
 * reason: `import json` has no quote to stop at.
 */
function importLines(lines: string[], language: string | undefined): string[] {
  const python = language === 'python';
  const starts = python ? [PY_IMPORT] : [JS_IMPORT, JS_REEXPORT, JS_REQUIRE];
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!starts.some((re) => re.test(line))) continue;

    let statement = line.trim();
    let last = i;
    // Only a JS `import` is ever folded. Python's two spellings are complete on their own
    // line, and `import json` has no quote to stop a fold at — it would swallow the next
    // import whole. A `require` binding or a re-export always carries its specifier already.
    if (!python && JS_IMPORT.test(line)) {
      while (!/['"`]/.test(statement) && last + 1 < lines.length && last - i < MAX_IMPORT_LINES) {
        last++;
        statement = `${statement} ${(lines[last] ?? '').trim()}`;
      }
    }
    i = last;
    out.push(statement.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * How long one line of a shape may be, and how many lines a list may hold (T-5 security
 * review, finding 6).
 *
 * Both lists are lifted VERBATIM off a file in a repository nobody here has read, and neither
 * has a natural bound. "The first line of a load-bearing range" is a whole minified bundle
 * when the file is minified — one line, megabytes long — and `plan.json` decides how many
 * ranges there are. The panel renders both lists at the PROSE cap of 20,000 characters across
 * up to 200 rows, so an uncapped shape hands `src/walk/step-view.ts` up to eight megabytes of
 * HTML to build, escape and push through a webview message, for one manual step.
 *
 * Capping it at the SOURCE is the fix rather than capping it at the panel, because the panel
 * is not the only consumer — the step protocol carries a `shape`, `stepRenderKey` hashes one,
 * and every future reader of a `FileShape` would need to remember the same cap. A value that
 * cannot be enormous is easier to hold than a rule that it must not be rendered enormous.
 *
 * 400 characters is `step-view.ts`'s `MAX_CHECK_TEXT`, the cap it already uses for a line of
 * code rather than a paragraph of prose, and a signature that does not fit in 400 characters
 * was not going to teach anybody anything anyway. 100 lines is comfortably more than any real
 * file's imports or load-bearing ranges and comfortably under the panel's own 200-row cap, so
 * the announcement below survives the panel's slice instead of being the row it drops.
 *
 * Both caps are ANNOUNCED, never silent, which is the same rule `MAX_OPTIONS_RENDERED` and
 * `MAX_NAMES_LISTED` follow: a learner comparing the panel against the reference must be able
 * to see that they are looking at part of it. Silence here would read as "that is the whole
 * import list", and they would go looking for their mistake in the wrong place.
 */
const MAX_SHAPE_LINE = 400;
const MAX_SHAPE_LINES = 100;

/** One list of shape lines, bounded in both directions, saying so where it had to cut. */
function boundShape(lines: string[]): string[] {
  const shown = lines.slice(0, MAX_SHAPE_LINES).map((line) => (
    line.length <= MAX_SHAPE_LINE
      ? line
      : `${line.slice(0, MAX_SHAPE_LINE)}… (${line.length} characters in the reference, shortened here)`
  ));
  if (lines.length > MAX_SHAPE_LINES) {
    shown.push(`… and ${lines.length - MAX_SHAPE_LINES} more, not shown`);
  }
  return shown;
}

/**
 * What manual mode shows instead of a file (AC2): the signature line of each load-bearing
 * range, and the imports the reference file opens with.
 *
 * The line and no more is the whole discipline here. It tells the learner what they are being
 * asked to write — the name, the parameters, the return type — and stops exactly where the
 * decision starts, so the panel can be honest about the shape without becoming a place to
 * read the answer. A range that is not a range, an unreadable reference, and a file that
 * leaves the reference root all produce an empty shape rather than a throw: nothing to show
 * is a state the panel renders, and this is called while the learner is looking at it.
 */
export function fileShape(refRoot: string, step: StepLike): FileShape {
  const empty: FileShape = { signatures: [], imports: [] };
  const file = step.target.file;
  const read = readReference(refRoot, file);
  if ('refused' in read) return empty;

  const lines = read.text.split(/\r?\n/);
  const ranges = loadBearingOf(step);
  const signatures = (ranges ?? [])
    .map((range) => range.startLine)
    .sort((a, b) => a - b)
    .map((startLine) => (lines[startLine - 1] ?? '').trim())
    .filter((line) => line.length > 0);

  return {
    signatures: boundShape(signatures),
    imports: boundShape(importLines(lines, languageOf(file))),
  };
}

// ── the files that are never taught (AC6) ───────────────────────────────────────────────────

/**
 * The plan's `reproduce` list, validated. Exported because the panel needs the COUNT before
 * it offers to copy anything (spec §5.4 refinement notes), and because this is the one place
 * that decides what a usable entry is — `PlanLike` types the key as `unknown`, deliberately,
 * since it comes back from `JSON.parse` like everything else in the plan.
 */
export function reproduceEntries(plan: PlanLike): string[] {
  const entries: unknown = plan['reproduce'];
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

// ── what the entry IS, which containment never asks (T-12) ──────────────────────────────────

/**
 * **THE RULE, in prose, because everything below is an example of it and not the thing itself:**
 *
 *   A `reproduce` entry is withheld when its NAME says the file carries credentials, or that
 *   it configures an agent, editor or tool that would then run in the folder the learner is
 *   building in. Everything else is copied.
 *
 * That sentence is the specification. The predicates under it are how far it has been written
 * down so far, and **the next file in the category will have a name nobody here has thought
 * of** — so a reader extending this should ask "does this file carry a secret, or does it tell
 * something that runs in that folder what to do?" and add it, rather than pattern-matching on
 * the examples. Each predicate carries its own note saying what its boundary is and why, which
 * is the part that makes it extendable; a single regular expression matching today's names
 * would be shorter and would not survive its first surprise.
 *
 * ## Why a name check belongs in a function that already proves containment
 *
 * Every path here is checked twice over, lexically and against the filesystem, and both halves
 * are sound: the entry really is inside the reference repository and the copy really does land
 * inside the learner's folder. **Containment answers WHERE. It never asks WHAT**, and until
 * T-12 nothing else did either.
 *
 * The gap is not hypothetical and it is not a stranger's repository. repo-tour is the
 * reference repo this extension is defined against — the sibling checkout, the source of the
 * core, the thing anyone would point it at first — and repo-tour itself commits
 * `.claude/settings.json`. repo-tour's walker descends dot-directories (it skips only `.git`),
 * `.json` is not `PARSEABLE`, so it falls through to `data`, and `data` IS the reproduce
 * bucket. The default demo path therefore copies a reference repository's agent configuration
 * into a folder the learner did not put it in. It is a copy and not a transmission — that file
 * was already readable to anyone who cloned that repo — but it is a copy nobody asked for, into
 * the one folder this extension has been teaching the learner to trust.
 *
 * ## Over-refusing is the other way to be wrong
 *
 * `reproduce` exists precisely to deliver the files no step names — the lockfiles, the vendored
 * bundles, the binary assets — and AC6's byte-for-byte `diff -r` can only come back clean
 * because those and the `file` steps together cover the whole inventory. A rule that eats
 * `.gitignore`, `id_rsa.pub` or `.github/workflows/ci.yml` breaks that to buy nothing. This is
 * why the fix is a rule rather than a blocklist and why every predicate below draws its
 * boundary explicitly: the public half of a key pair is not key material, a certificate is not
 * a private key, a signature is not a secret, a directory merely named `keys` is not `.ssh`,
 * a committed `.env.example` is a placeholder rather than the secret it is a template for, and
 * a CI WORKFLOW runs on a build server somewhere else rather than in the folder in front of
 * the learner — which is a statement about `.github/workflows/` and not about `.github/`,
 * whose agent-configuration files are caught by their own names instead.
 *
 * **This half is not symmetric with the other one, and that is why it is measured rather than
 * reasoned about.** Under-refusal is found by asking "what gets through", which every security
 * instinct already does; over-refusal is found only by running the finished rule over a REAL
 * inventory and reading the whole list rather than the matches — because the files it eats
 * (`.env.example`, `dist/app.tar.gz.asc`) are files a project commits ON PURPOSE, and no
 * adversarial test would ever plant one. Both of T-12's over-refusals were found that way and
 * neither would have been found any other.
 *
 * The cost this rule DOES accept, so the next reader does not re-audit it: `.vscode` is a
 * DIRECTORY judgement with a per-file price. A learner rebuilding this very extension does not
 * get `.vscode/launch.json`, because `.vscode` is in the set for `tasks.json`'s sake and
 * `launch.json` rides along with the directory. Measured on this repository the whole cost is
 * two entries of twenty-two, and on repo-tour — the default demo path — it is one of twenty-seven.
 * A per-file `.vscode` split would be a second rule to maintain for one file's convenience; the
 * refusal names the file and tells the learner to copy it in, which is the better trade.
 *
 * ## What this is NOT
 *
 * It is not a content scan. Nothing here opens the file, and a `config.json` genuinely full of
 * live API keys is copied exactly as before — the honest boundary of a name rule, worth stating
 * so the next reader does not mistake this for more than it is (T-5's finding 1 cost more in
 * its comment than in its code). A `config.json` that is a LINK to `.env` is a different case
 * and is refused, because that is still a question about a name: the one the file has once the
 * link is followed, which `reproduceFiles` asks separately. It also does not touch `planWrite`: a file the plan turns into a
 * taught STEP is a different decision, made where a learner is being asked to write it.
 */

/** The three reasons, as predicate phrases — each one completes "refused — it …". */
const AGENT_CONFIG_REASON = 'is configuration for an agent, editor or tool that would then run in the folder you are building in';
const CREDENTIAL_REASON = 'is shaped like a credentials file';
const KEY_MATERIAL_REASON = 'is shaped like private key material';

/**
 * Dot-directories an agent, editor or tool reads **out of its working directory**, which is
 * exactly the folder this function is copying into. That is the whole membership test, and
 * every name below is here because something reads it from `.` and then acts in `.`:
 *
 *   - `.vscode` and `.idea` are in for the same reason `.claude` is, not by analogy: a
 *     committed `tasks.json` can carry `"runOn": "folderOpen"`, so opening the folder runs it
 *     — in the very editor this extension lives in;
 *   - `.husky` is a hook MANAGER's directory, in a folder where `buildTutorials.commitPerStep`
 *     defaults to true and `src/dial/commit.ts` runs `git commit` once per completed step with
 *     no `--no-verify`. It needs one more link than the rest (husky's `prepare` script has to
 *     point `core.hooksPath` at it) and it is a path git carries in a tree without complaint,
 *     which is why it arrives through the ordinary pipeline;
 *   - `.git` is the one T-5's security review named by name. A `.git/config` carries
 *     `core.fsmonitor`, `core.hooksPath` and aliases — commands git runs in that folder — and
 *     `.git/hooks/` is the same category `.husky` is. Its reachability is narrow and worth
 *     stating rather than implying: repo-tour's walker skips `.git` outright, and git refuses
 *     a `.git` path component inside a tree, so no cloned reference can carry one. It takes a
 *     shipped `.repo-tour/build/plan.json` over a non-git reference folder — itself gated by
 *     Workspace Trust, since `package.json` sets `untrustedWorkspaces.supported: false`. It is
 *     one word here and it closes a write that was confirmed to land, so it is one word here.
 *
 * **`.github` is deliberately absent, and the reason is about `workflows/` rather than about
 * the directory.** A workflow file configures a build server somewhere else, `.github/` is a
 * large and load-bearing part of ordinary projects, and refusing it whole would cost a learner
 * their CI for no gain here. What that argument does NOT cover is
 * `.github/copilot-instructions.md`, which is agent configuration read in the editor, in that
 * folder — so it is caught by its own NAME below instead, and the directory keeps landing.
 * A reader extending this should keep the two apart: a directory joins this set only when
 * everything in it is read from `.`.
 */
const AGENT_DIRECTORIES = new Set([
  'claude', 'cursor', 'aider', 'continue', 'codeium', 'copilot', 'windsurf', 'gemini',
  'opencode', 'cline', 'roo', 'goose', 'vscode', 'idea', 'devcontainer',
  'codex', 'zed', 'junie', 'kiro', 'trae', 'amazonq', 'qodo', 'helix',
  'husky', 'git',
]);

/**
 * Dot-directories whose entire job is to hold credentials for a tool. These belong in a home
 * directory and are startling in a repository — which is the point: if one has been committed,
 * everything under it is a secret, `known_hosts` and `config` included.
 */
const CREDENTIAL_DIRECTORIES = new Set([
  'ssh', 'gnupg', 'gpg', 'aws', 'azure', 'gcloud', 'kube', 'docker', 'chef',
]);

/**
 * Single files that ARE an agent's or a tool's configuration, with no directory to give them
 * away. `.mcp.json` is the one confirmed present in repo-tour's real reproduce list; the rest
 * are its kin, and `isAgentManifest` below covers the `.local` spellings besides.
 *
 * Three of these are worth a sentence each, because each one is a boundary:
 *
 *   - **`.envrc`** is direnv's configuration and it is SHELL — direnv executes it on entering
 *     the directory. It is one letter past the `.env` family it is named after and belongs to
 *     a different category than the family does: not a file that holds a secret, a file that
 *     runs. It is in `plan.reproduce` through the ordinary pipeline.
 *   - **`copilot-instructions.md`** is caught here rather than by a directory precisely so
 *     that `.github/` can keep landing whole. It is agent configuration wherever it sits.
 *   - **`.clinerules`, `.roomodes` and `opencode.json`** are the single-file spellings of
 *     agents whose directories (`.cline`, `.roo`, `opencode`) this rule already withholds.
 *     The set had already decided those agents count; these are the same decision, spelled the
 *     other way.
 */
const AGENT_MANIFESTS = new Set([
  '.mcp.json', 'mcp.json', '.clauderc', '.cursorrules', '.windsurfrules', '.aiderrc',
  '.aider.conf.yml', '.goosehints', 'claude.md', 'agents.md', 'gemini.md',
  '.envrc', 'copilot-instructions.md', '.clinerules', '.roomodes', 'opencode.json',
]);

/**
 * Name ENDINGS that make a file agent configuration wherever it sits — the three formats VS
 * Code reads as instructions to an agent (`.github/instructions/*.instructions.md` and its
 * siblings), and Sublime's project files, which carry `build_systems` with a `cmd` that runs
 * in the folder they sit in.
 *
 * A suffix rather than a directory for the same reason `copilot-instructions.md` is a name:
 * these live under `.github/`, which stays deliverable. The known cost is a prose document
 * that happens to end `.prompt.md` and is not one; the refusal names it and says to copy it in.
 */
const AGENT_FILE_SUFFIXES = [
  '.instructions.md', '.prompt.md', '.chatmode.md', '.sublime-project', '.sublime-workspace',
];

/**
 * Files named after the credential store they are, rather than after a secret-sounding word.
 * `.nvmrc` is not here and `.npmrc` is: the difference is one letter and the whole point of an
 * exact set rather than a prefix. `.yarnrc` is Yarn v1's, which carries `_auth`, and
 * `.yarnrc.yml` is Yarn v2's, which carries `npmAuthToken` — two files, one job, both here.
 */
const CREDENTIAL_FILES = new Set([
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '_netrc', '.pgpass', '.htpasswd', '.git-credentials',
  '.dockercfg', '.pypirc', '.boto', '.s3cfg', '.terraformrc', 'credentials', '.credentials',
  'auth.json',
]);

/**
 * Words that say a file's JOB is to hold a secret, matched anywhere in the base name so
 * `db-password.txt`, `ops/secrets.yml` and `aws_credentials.ini` are all caught without three
 * entries each. Every one of them is unambiguous in the middle of a word, which is the test
 * for this list and the reason it is short.
 */
const SECRET_WORDS = ['secret', 'credential', 'password', 'passwd', 'apikey'];

/**
 * Words that say the same thing only when they are a WHOLE word — bounded by `-`, `_`, `.` or
 * the edge of the name.
 *
 * The naked-substring test these were once kept out of really would have eaten
 * `tokenizer.json` (a file in this repo's own fixture), `authors.txt`, `authentication.md`,
 * `keyboard.json`, `monkey.txt` and `i18n/keys.json` — the evidence for excluding them was
 * right. The conclusion drawn from it was not: `SECRET_WORDS` had already reached for the
 * answer one line above by spelling `apikey`, `api-key` and `api_key` three times. Bounding
 * the match instead keeps every one of those near-misses AND catches `github_token.txt`,
 * `access_token.json`, `auth.json`, `gcp-key.json` and `id_token` — and it lets the three
 * `api*key` spellings collapse back into one, since `api-key` is now just `key` with a
 * delimiter in front of it.
 *
 * The question a word has to answer to be here is about the MATCH, not about the word: not
 * "is a file carrying this more likely a secret than not", which `key` fails and which is what
 * kept it out, but "is a file whose name contains this as a whole word more likely a secret
 * than not", which `key` passes. The cost is real and bounded — `auth-provider.ts` and
 * `key-map.json` are refused with a sentence that names them — and it is the trade the review
 * asked for by measuring it in both directions.
 */
const SECRET_SEGMENT_WORDS = ['token', 'auth', 'key'];

/**
 * Two-word names for a credential file, matched with the delimiters taken OUT, so
 * `service-account.json`, `service_account.json` and `serviceAccountKey.json` are one entry
 * here rather than six. Separate from `SECRET_WORDS` on purpose: removing delimiters can join
 * two innocent words into a third (`bypass-words.txt` squashes to something containing
 * `password`), so only the phrases that need it are matched that way.
 *
 * The known miss this leaves is the camelCase spelling of a SINGLE bounded word — `authToken.json`
 * squashes to `authtokenjson`, which no phrase here covers. Splitting camelCase into
 * delimiters would catch it and would also eat `AuthProvider.ts` and `KeyMap.ts`, which is a
 * worse trade; it is written down rather than left to be rediscovered.
 */
const SECRET_PHRASES = ['serviceaccount'];

/**
 * Extensions that are private key material by definition. The PUBLIC halves are deliberately
 * not here — `.pub`, `.crt`, `.cer`, `.der` and `.asc` are meant to be handed out, and a
 * repository that ships a certificate or a signature for its own release should keep shipping
 * it. `.asc` is the ASCII-ARMORED format, so in a repository it is overwhelmingly a detached
 * signature (`dist/app.tar.gz.asc`) or an exported public key (`KEYS.asc`); it sat on the
 * wrong side of the sentence directly above until T-12's review drove it.
 *
 * `.key` is the one knowingly imperfect member (a Keynote deck ends in it too). In a source
 * repository a `.key` is a private key far more often than a slide deck, the refusal names the
 * file, and the learner can copy a deck in by hand; the reverse mistake cannot be undone.
 */
const KEY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.gpg', '.pgp', '.ppk']);

/**
 * The env-file family: `.env`, `.env.local`, `.env.production.local`, and the `prod.env`
 * spelling — minus the placeholders, which are a different file with a different job.
 */
function isEnvFile(base: string): boolean {
  if (isEnvPlaceholder(base)) return false;
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

/**
 * `.env.example` and its family — the file a project commits **on purpose**.
 *
 * This is the over-refusal half of the rule and it is not a near-miss dreamed up for a test.
 * A placeholder exists to be committed: it is the one document that tells the next person
 * which variables the build wants, it is present in a large fraction of real repositories, and
 * it is exactly the "files no step names" scaffolding `reproduce` exists to deliver. A prefix
 * test cannot tell it from the secret it is a template for, so this is an exact set of the
 * words a placeholder is spelled with — the same "an exact set rather than a prefix" argument
 * `.nvmrc` versus `.npmrc` makes one list up.
 *
 * Either end of the name counts, because both spellings are in the wild: `.env.example` and
 * `example.env`, and `.env.production.example` for a project with stages. `.env.local` and
 * `deploy/prod.env` are neither, and stay withheld.
 *
 * The cost, stated: a project that puts a real secret in a file called `.env.template` gets it
 * copied. That is a file lying about what it is, and the alternative — withholding every
 * placeholder from every learner — was measured and is worse.
 */
const ENV_PLACEHOLDER_WORDS = new Set(['example', 'sample', 'template', 'dist', 'defaults', 'placeholder']);

/**
 * The leading spelling is a SMALLER set than the trailing one, and the two names it leaves out
 * are why it is separate: `.env.dist` and `.env.defaults` are placeholder conventions, while
 * `dist.env` and `defaults.env` read as "the env file for the dist build" — a real one. Where
 * a word is ambiguous by position, the withheld reading wins.
 */
const ENV_PLACEHOLDER_PREFIXES = new Set(['example', 'sample', 'template', 'placeholder']);

function isEnvPlaceholder(base: string): boolean {
  const parts = base.split('.').filter((part) => part.length > 0);
  if (parts.length < 2) return false;
  return ENV_PLACEHOLDER_WORDS.has(parts[parts.length - 1] ?? '') || ENV_PLACEHOLDER_PREFIXES.has(parts[0] ?? '');
}

/** An agent's or a tool's configuration with no directory to give it away. The `.mcp.` prefix
 *  is there because `.mcp.local.json` and its siblings keep being invented, and `.local` is
 *  stripped for the same reason: `CLAUDE.local.md` is `CLAUDE.md` with the same power. */
function isAgentManifest(base: string): boolean {
  if (AGENT_MANIFESTS.has(base) || base.startsWith('.mcp.')) return true;
  if (AGENT_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  const withoutLocal = base.replace(/\.local(?=\.[^.]+$)/, '');
  return withoutLocal !== base && AGENT_MANIFESTS.has(withoutLocal);
}

/** A file whose JOB is to hold a secret — by exact name, by a word in the name, or by a whole
 *  word between delimiters. See each list above for which match it gets and why. */
function isCredentialStore(base: string): boolean {
  if (CREDENTIAL_FILES.has(base)) return true;
  if (SECRET_WORDS.some((word) => base.includes(word))) return true;
  const squashed = base.replace(/[-_.]+/g, '');
  if (SECRET_PHRASES.some((phrase) => squashed.includes(phrase))) return true;
  return base.split(/[-_.]+/).some((segment) => SECRET_SEGMENT_WORDS.includes(segment));
}

/**
 * A private key, by SSH's naming shape or by extension.
 *
 * The last clause is not redundant: `path.extname` calls a leading dot no extension at all, so
 * `.pem` comes back as the empty string, and a file spelled that way would otherwise walk
 * straight through a set that contains `.pem`.
 */
function isKeyMaterial(base: string): boolean {
  return isSshPrivateKey(base) || KEY_EXTENSIONS.has(path.extname(base)) || KEY_EXTENSIONS.has(base);
}

/**
 * OpenSSH writes a private key as `id_<type>` with **no extension** and its public half as
 * `id_<type>.pub`. Testing the shape rather than listing `id_rsa`, `id_dsa`, `id_ecdsa`,
 * `id_ed25519` covers the key type invented after this was written, which is the point; the
 * "no dot" half is what keeps `id_rsa.pub` — and `id_map.json` — deliverable.
 *
 * `id_token` matches this shape and is a JWT rather than key material, which is why
 * `isCredentialStore` is asked FIRST in `withheldReason`: the refusal is right either way and
 * the reason a learner is given should be the true one.
 */
function isSshPrivateKey(base: string): boolean {
  return base.startsWith('id_') && !base.includes('.');
}

/** A path segment that is one of the dot-directories in `set` — `.claude`, `.ssh`, and so on. */
function isDotDirectoryIn(segment: string, set: ReadonlySet<string>): boolean {
  return segment.startsWith('.') && set.has(segment.slice(1));
}

/**
 * One path segment as the filesystem it lands on would understand it, lower-cased.
 *
 * Case is folded because the answer must not depend on the filesystem the copy happens to
 * land on — macOS and Windows treat `.ENV` and `.env` as the same file, and a rule that
 * disagreed with the filesystem about that would be a hole on exactly two of the three
 * platforms this runs on.
 *
 * The other two normalisations are Windows' and are the same argument one step further. NTFS
 * resolves `name::$DATA` (and `name:stream:$DATA`) to the file's default stream, and Win32
 * strips trailing dots and spaces from a component before it ever reaches the filesystem — so
 * `.env `, `.npmrc.`, `id_rsa.`, `.claude./` and `.env::$DATA` all DENOTE the withheld file
 * there, and a rule that read them literally would be a hole on the platform this file's own
 * comment names as one of the three it runs on.
 *
 * On POSIX those names are genuinely different files, so this over-refuses there — in the safe
 * direction, with a sentence that names the entry, and knowingly, which is the same trade the
 * `\` in the split below makes.
 */
function windowsName(segment: string): string {
  return segment
    .replace(/:{1,2}[^:]*:?\$data$/i, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
}

/**
 * The segments an entry actually denotes: separators folded, `.` and `..` resolved, each
 * segment normalised.
 *
 * `..` is resolved rather than left alone because the rule is about the file the entry names,
 * not about the string: `.claude/../.env` is `.env`, and reporting it as agent configuration —
 * which is what walking through the `.claude` segment did — is a right refusal for a wrong
 * reason. An entry that climbs out of its root entirely keeps its leading `..`, and never
 * reaches here in `reproduceFiles` anyway: containment refuses it two checks earlier.
 *
 * The split takes `\` as well as `/` because on Windows it IS a separator. A POSIX file
 * genuinely named `.claude\settings.json` is one legal filename and is refused as a directory
 * match — over-refusal, in the safe direction, on a name nobody has created.
 */
function pathSegments(entry: string): string[] {
  const out: string[] = [];
  for (const piece of entry.split(/[\\/]+/)) {
    // `.` and `..` are recognised BEFORE the Windows normalisation below, which would
    // otherwise strip `..` down to nothing and leave the directory it was cancelling in place.
    // Trailing spaces come off first because Windows takes `.. ` for `..` as well.
    const raw = piece.replace(/ +$/, '');
    if (raw.length === 0 || raw === '.') continue;
    if (raw === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    const segment = windowsName(raw);
    // A segment that normalises away entirely — `...`, a bare stream name — is dropped rather
    // than treated as a `..`, which errs toward keeping the directory above it in the list.
    if (segment.length === 0) continue;
    out.push(segment);
  }
  return out;
}

/**
 * Why this entry will not be copied, or `null` for the ordinary case — a lockfile, a vendored
 * bundle, a binary asset, which is nearly everything and must stay that way.
 *
 * Answered from a NAME with no filesystem at all, and asked by `reproduceFiles` before the
 * file is opened or a directory is created for it, so an entry in the category is refused
 * without ever being read. It is asked twice there: once about the entry as the plan spells
 * it, and once about the name the entry resolves to, which is not always the same file.
 *
 * Exported for `src/walk/session.ts`, which needs the same answer without doing the copy: the
 * panel's offer counts `reproduceEntries` and the overwrite prompt filters it, and both are
 * now wrong by exactly the entries this function withholds (T-12 review, findings 1 and 8).
 *
 * Every segment is examined by the two DIRECTORY tests, not just the base name, because
 * `.claude/settings.json` gives itself away in the directory — the leaf is an innocent
 * `settings.json` — and a repository is free to put one at
 * `packages/api/.claude/settings.local.json`. The three tests below them read the BASE NAME
 * only, and that is the boundary that makes a bounded `auth` affordable: `src/auth/index.ts`
 * and everything else under an ordinary `auth/` directory keeps landing, because a directory
 * named after a subject is not a file named after a secret.
 *
 * The order of the last three lines is the one place a right refusal can carry a wrong reason,
 * so it is chosen rather than incidental: a credential-shaped name is asked about before an
 * SSH-shaped one, because `id_token` matches both and is a JWT.
 */
export function withheldReason(entry: string): string | null {
  const segments = pathSegments(entry);
  const base = segments[segments.length - 1] ?? '';

  if (segments.some((s) => isDotDirectoryIn(s, AGENT_DIRECTORIES))) return AGENT_CONFIG_REASON;
  if (segments.some((s) => isDotDirectoryIn(s, CREDENTIAL_DIRECTORIES))) return CREDENTIAL_REASON;
  if (isAgentManifest(base)) return AGENT_CONFIG_REASON;
  if (isEnvFile(base) || isCredentialStore(base)) return CREDENTIAL_REASON;
  if (isKeyMaterial(base)) return KEY_MATERIAL_REASON;
  return null;
}

/**
 * Copies every `plan.reproduce` entry from the reference into the target, byte for byte,
 * creating directories as it goes. Returns the PROBLEMS — one shown-to-a-person line per
 * entry that did not make it, empty when everything landed.
 *
 * These are the generated, vendored, lockfile, data and binary files repo-tour deliberately
 * never turns into steps: there is no decision in a lockfile and nothing to learn from
 * retyping a minified bundle. They matter anyway, and they matter to an acceptance criterion
 * — AC6's `diff -r` between a fully walked target and the reference can only come back clean
 * because the `file` steps and this list together cover every file the inventory saw. Skipping
 * them would not merely leave the project un-runnable; it would make byte-for-byte
 * reproduction impossible in principle.
 *
 * **Every entry `withheldReason` refuses is an exception to that sentence**, and against a
 * reference that commits one — repo-tour does — `diff -r` will report it. This file's header
 * states the exception in full, under "AC6 has a SECOND exception since T-12"; it is named
 * here as well because this is the function the criterion is actually about.
 *
 * Bytes, never a string: this is the one path that carries files that are not text at all, so
 * a `Buffer` goes in at one end and out at the other with no decode in between.
 */
/**
 * What a reproduce pass produced. Two arrays rather than one, and the split is the point
 * (T-12 review finding 8): `problems` is "something went wrong and you should know", `withheld`
 * is "the rule did its job". They were one array, and a refusal the feature exists to make
 * therefore reached the learner as a red error box on the very first, most ordinary path.
 */
export interface ReproduceOutcome {
  /** Real failures: an escape, an unreadable source, a write that did not land. */
  problems: string[];
  /** Entries the name rule deliberately did not copy. Expected, and not an error. */
  withheld: string[];
}

/**
 * The entries that will actually be written — `reproduceEntries` minus what the rule withholds.
 *
 * Anything COUNTING or PROMPTING about the reproduce list must use this rather than
 * `reproduceEntries`, which answers "what does the plan name" and not "what will land". T-12
 * review finding 1 is what happens otherwise: the overwrite prompt was computed from the raw
 * list, so a withheld file the learner already had blocked the whole copy on the first press
 * and then drew "…was replaced with this project's own version, as you asked" over a file that
 * was never touched. Driven A/B against the previous behaviour, where the sentence was true.
 */
export function deliverableEntries(plan: PlanLike): string[] {
  return reproduceEntries(plan).filter((entry) => withheldReason(entry) === null);
}

export function reproduceFiles(plan: PlanLike, refRoot: string, target: string): ReproduceOutcome {
  const problems: string[] = [];
  // T-12 review finding 8. A withheld entry is the feature WORKING, and it used to leave through
  // the same array as "could not be read" — so on the default demo path (repo-tour, which commits
  // `.claude/settings.json`) every learner met a red error box for a refusal that is correct and
  // expected. Two arrays, because they are two different sentences to two different moods: one is
  // "something went wrong", the other is "this was deliberately left for you to copy yourself".
  const withheldEntries: string[] = [];

  for (const entry of reproduceEntries(plan)) {
    const from = resolveInsideTarget(refRoot, entry);
    if (from === null) {
      problems.push(`${label(entry)}: refused — it points outside the reference repository`);
      continue;
    }
    const to = resolveInsideTarget(target, entry);
    if (to === null) {
      problems.push(`${label(entry)}: refused — it points outside the folder you are building in`);
      continue;
    }
    // The read end, on the filesystem this time. This list is where the non-adversarial case
    // actually bites: pnpm makes `node_modules/<pkg>` a directory symlink into a global store
    // and repo-tour classifies `node_modules` as vendored, so `reproduce` is the entry point a
    // perfectly ordinary project walks in through.
    if (!insideRealRoot(refRoot, from)) {
      problems.push(`${label(entry)}: refused — it leaves the reference repository through a symlink`);
      continue;
    }
    // WHAT the file is — the question every check above this one leaves unasked (T-12). It
    // runs AFTER the three containment checks above and BEFORE the file is opened or a
    // directory is made for it, and BOTH halves of that position are chosen rather than
    // incidental. Above: those three name a plan escaping its roots, which is a worse thing
    // than a secret-shaped name and is the message a containment regression would announce
    // itself in, so an entry that is both an escape AND a bad name is reported as the escape.
    // Below: `prepareDirectory` is the FOURTH containment check and it sits under this one, so
    // an entry with a withheld name whose destination escapes through a symlink planted in the
    // TARGET is reported as the polite name refusal instead — driven, and deliberate, because
    // nothing may be created on disk for an entry that is never going to be copied, and
    // running the name check last would `mkdir` the learner's `.claude` to say so. There is no
    // security loss in either arrangement: nothing is written and nothing outside the target is
    // touched. Only the sentence differs, and this comment now claims exactly as much as the
    // ordering delivers — the same file, one ticket after a comment that claimed a defence was
    // complete when three quarters of it were.
    //
    // It is asked TWICE, and the second ask is the one a symlink cannot walk past. The first
    // reads the entry as the plan spells it; the second reads the name the entry RESOLVES to,
    // because a reference repo carrying `config.json -> .env` delivers the secret verbatim
    // under an innocent name, and `settings/settings.json` where `settings -> .claude`
    // delivers the agent configuration. Containment has nothing to say about either — both
    // links stay inside the reference, which is exactly what `insideRealRoot` just proved —
    // and the rule's own sentence is about the name of the file, which under an alias is a
    // name the plan never wrote down. Its reachability is narrow and is written here rather
    // than left implied: repo-tour's walker skips symlinks unless `followSymlinks` is set, so
    // this needs a shipped `.repo-tour/build/plan.json`, itself gated by Workspace Trust. It
    // was confirmed at the copy, it costs one `realpath` on a list that is already doing one
    // per entry, and the alternative was recording a known hole.
    //
    // What neither ask does is open the file. A `config.json` genuinely full of live API keys
    // is copied exactly as before — the honest boundary of a NAME rule, and the reason the
    // second ask is a resolution rather than a ban on links: an alias for a lockfile is a
    // lockfile, and still lands.
    const withheld = withheldReason(entry);
    // Lazy on purpose: an entry already refused by its own name never has its path resolved,
    // so the promise that nothing in the category is touched on disk holds exactly.
    const aliased = withheld === null ? realNameInside(refRoot, from) : null;
    const withheldAlias = aliased !== null && aliased !== entry ? withheldReason(aliased) : null;
    if (withheld !== null || withheldAlias !== null) {
      // Advice the containment refusals do not offer, because this refusal is different in
      // kind: those name an attack, this one can land on a file somebody genuinely wants.
      const reason = withheld !== null ? `it ${withheld}` : `it is a link to a file that ${withheldAlias}`;
      withheldEntries.push(`${label(entry)}: refused — ${reason}; copy it in yourself if you want it`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(from);
    } catch (err) {
      problems.push(`${label(entry)}: could not be read from the reference — ${messageOf(err)}`);
      continue;
    }
    // And the write end. Refusing ONE entry rather than abandoning the list is the whole shape
    // of this function: a single vendored symlink in a lockfile's neighbourhood must not cost
    // the learner every other file they are owed.
    const wrong = prepareDirectory(target, to);
    if (wrong !== null) {
      problems.push(`${label(entry)}: refused — it ${wrong}`);
      continue;
    }
    try {
      // `target` again, on purpose. `prepareDirectory` has just answered the question, and
      // `writeBytesAtomic` asks it a second time immediately before the bytes move — see its
      // own note on why the second ask is the one that counts.
      writeBytesAtomic(to, bytes, target);
    } catch (err) {
      problems.push(`${label(entry)}: could not be written — ${messageOf(err)}`);
    }
  }

  return { problems, withheld: withheldEntries };
}

// ── the write primitive ─────────────────────────────────────────────────────────────────────

/**
 * Writes `content` to `absPath` durably: a temp file beside it, then a rename over the real
 * name. See this file's header for every half of why — atomicity, the random suffix, and
 * exactly how much of the symlink problem the rename does and does not solve.
 *
 * `root` is the folder `absPath` must really be inside, and passing it is what makes this the
 * LAST word on containment rather than a repetition of an earlier one. `prepareDirectory` runs
 * again here, after the directory exists and immediately before the bytes move, because a
 * containment answer has a shelf life: `planWrite` proves the destination and then the session
 * may go and ask the learner whether to overwrite their own file, and a human takes as long as
 * a human takes. Re-asking at the last instant costs two syscalls and closes that window.
 *
 * It is optional only because a caller may honestly not have a root to name — a test writing
 * into its own temp folder, say — and a parameter that could be filled in with a lie would be
 * worse than one that can be left out. Every caller that HAS a root passes it: `reproduceFiles`
 * does, directly below. `src/walk/session.ts` calls this with the destination `planWrite`
 * already proved and no root, so its writes are covered by that proof plus rename(2)'s
 * protection of the final component — everything a committed symlink can do — and are open
 * only to a concurrent local process swapping a directory inside the target during the prompt.
 * Handing `this.target` in as the third argument closes that too, and should.
 *
 * Throws on a real filesystem failure — a full disk, a read-only folder — and on a refused
 * destination, rather than reporting, because this is the primitive and not the decision: the
 * session catches it, shows the learner the sentence and reports through `reportError`, which
 * is what that adapter is for. The decision that a learner is *entitled to a refusal in words*
 * is made where the destination is chosen, in `planWrite` and `reproduceFiles`, both of which
 * hand back a value rather than throwing into a `void`ed promise.
 */
export function writeTextAtomic(absPath: string, content: string, root?: string): void {
  writeBytesAtomic(absPath, Buffer.from(content, 'utf8'), root);
}

function writeBytesAtomic(absPath: string, bytes: Buffer, root?: string): void {
  if (root === undefined) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
  } else {
    const wrong = prepareDirectory(root, absPath);
    // Deliberately not silent, and deliberately not clamped into the target either. A write
    // that lands somewhere else is the failure; a write that lands somewhere else *than the
    // caller was told* is the same failure with the evidence removed.
    if (wrong !== null) throw new Error(`${path.basename(absPath)} ${wrong} — nothing was written`);
  }
  const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, absPath);
  } catch (err) {
    // A failed write must not leave its scratch file in the learner's project, where it would
    // show up in their editor, their git status, and eventually their commit.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already gone — either way there is nothing to clean up */
    }
    throw err;
  }
}
