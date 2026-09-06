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
 * The lexical half is all this can do — a contained path whose real location is elsewhere via
 * a symlink needs `realpath`, and T-4 put that gate in `src/extension.ts` beside its other
 * `fs` concerns. What this file *can* close, and does, is the write end of that hole: see the
 * note on rename below.
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
 * `renameSync` also closes the same hole at the *destination*: rename replaces a symlink
 * rather than following it, so a planted `src/parse.ts -> ~/.bashrc` ends up overwritten with
 * a normal file instead of writing through to the target. Both properties are pinned by
 * tests, because both are invisible when they work.
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
 * Nothing here consults the filesystem at the destination. Whether the file already exists,
 * and whether the learner has edited it, is the session's question (spec §5.4: never
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

  if (dial === 'automated') return { path: dest, content: read.text };

  const loadBearing = loadBearingOf(step);
  if (loadBearing === null) {
    return { refused: `the plan's load-bearing lines for ${label(file)} are not line ranges — nothing was written` };
  }
  // Nothing load-bearing means the plan says the whole file is boilerplate, and boilerplate is
  // copied verbatim in every position that writes at all. Short-circuiting also keeps a file
  // whose language has no grammar working in the one case where the grammar is irrelevant.
  if (loadBearing.length === 0) return { path: dest, content: read.text };

  const language = languageOf(file);
  if (language === undefined) {
    return {
      refused: `repo-tour has no grammar for ${label(file)}, so its load-bearing lines cannot be stubbed — scaffolding it would hand over the answer instead of hiding it`,
    };
  }

  const questions = stubQuestionsFor(step, symbolStepsOf(plan));
  return { path: dest, content: core.stubFile(read.text, loadBearing, language, questions) };
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

  return { signatures, imports: importLines(lines, languageOf(file)) };
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
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(from);
    } catch (err) {
      problems.push(`${label(entry)}: could not be read from the reference — ${messageOf(err)}`);
      continue;
    }
    try {
      writeBytesAtomic(to, bytes);
    } catch (err) {
      problems.push(`${label(entry)}: could not be written — ${messageOf(err)}`);
    }
  }

  return problems;
}

// ── the write primitive ─────────────────────────────────────────────────────────────────────

/**
 * Writes `content` to `absPath` durably: a temp file beside it, then a rename over the real
 * name. See this file's header for both halves of why (atomicity, and the two symlink holes
 * the random suffix and the rename close between them).
 *
 * Throws on a real filesystem failure — a full disk, a read-only folder — rather than
 * reporting, because unlike a refused path there is nothing to explain to the learner about
 * their plan and nothing they did wrong. The session catches it and says so through
 * `reportError`, which is what that adapter is for.
 */
export function writeTextAtomic(absPath: string, content: string): void {
  writeBytesAtomic(absPath, Buffer.from(content, 'utf8'));
}

function writeBytesAtomic(absPath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
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
