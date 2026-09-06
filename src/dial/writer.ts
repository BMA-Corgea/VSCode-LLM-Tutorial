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
 * Bytes, never a string: this is the one path that carries files that are not text at all, so
 * a `Buffer` goes in at one end and out at the other with no decode in between.
 */
export function reproduceFiles(plan: PlanLike, refRoot: string, target: string): string[] {
  const problems: string[] = [];

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

  return problems;
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
