// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * *Check my work* (spec §5.4 AC5, T-1 §4.4) — the learner presses one button, and this is
 * what runs behind it.
 *
 * The comparison itself is repo-tour's, not ours: `check(learnerSource, referenceExtract,
 * language, relPath)` in its `src/build/check.ts`. What lives HERE is everything that
 * comparison needs and cannot get for itself — the reference file's extract, the learner's
 * source out of their own target folder, and one sentence a person can actually read —
 * because the core is handed a repository, not an editor, and knows nothing about targets,
 * plans, dials or panels.
 *
 * ## The check is structural, and that is a decision — not a gap to be closed later
 *
 * Three axes, and no more: which exported symbols exist (by name and kind), which imports are
 * declared (by raw specifier), and whether the file parses at all. Nothing about what a
 * function *does* is ever inspected. `CheckReport` cannot even express "the body does
 * something different" — there is no field for it — and that shape is the promise, not an
 * oversight (T-1 §4.4; this ticket's own out-of-scope note defers semantic comparison to the
 * tutor, on request, and only on request).
 *
 * The reason is the learner. A tutorial that accepts only the author's implementation is a
 * typing exercise; the premise of this whole extension is that the learner writes their own
 * body and is told whether the *shape* is right. So a renamed local variable must pass. A
 * `for` loop where the author wrote `.map` must pass. An early return must pass. AC5 names
 * the renamed-local case out loud precisely because it is the one a cleverer check gets wrong
 * first, and `test/unit/dial-check.test.ts` pins it.
 *
 * So: whoever comes here next wanting to make this smarter — a body diff, an AST similarity
 * score, a model asked "is this the same function?" — that trade is expensive, it spends a
 * token on every button press, and it is *wrong about correct work*, which is the one failure
 * a teaching tool cannot afford. Nothing in this module or its tests calls a model. Keep it
 * that way; if a learner wants to know whether their body is any good, that is a question for
 * the tutor (T-6), asked deliberately, not a verdict stapled to a green tick.
 *
 * ## Two roots, both untrusted in exactly the same way
 *
 * A check straddles two trees: the reference repository (`request.json`'s repo, whatever the
 * learner pointed the build at) and the learner's target folder. `relPath` comes from
 * `plan.json`, which was generated from that reference repository, so it is untrusted input
 * on BOTH sides — and both sides end up `path.join`-ing it onto a root. `extract()` joins it
 * onto the reference root to read; the core's `check()` joins it onto a throwaway directory
 * to *write* the learner's source before parsing it. `resolveInsideTarget` (T-4 security
 * review, finding 2) is therefore applied to both roots here rather than only the learner's,
 * and a refusal comes back as `null` — never an error shown to the learner, who did nothing
 * wrong and cannot fix a plan they did not write.
 *
 * ## `null` is an ordinary answer; a throw is not
 *
 * `null` means "there is nothing to check here", which is the commonest state this module
 * sees, not a failure: manual mode writes nothing, so until the learner creates the file
 * there is no file. It also covers a language repo-tour has no grammar for, a `shape` step
 * whose target is a directory, a path that escapes its root, and a reference file that has
 * since moved. None of those belongs in `reportError`, and none of them should mark a step ✗.
 *
 * An exception out of the core is the opposite case and is deliberately NOT swallowed into
 * that same `null`. A missing grammar, an unreadable temp directory, a core that failed to
 * load — those are real breakage, and answering them with "nothing to check" would leave a
 * learner pressing the button forever against a silent module. The session (`src/walk/
 * session.ts`) awaits this and routes failures to its `reportError` adapter; that is the
 * honest channel, so callers must await and catch rather than `void` the promise.
 */

import fs from 'node:fs';
import type { StepLike } from '../walk/model.js';
import { resolveInsideTarget } from '../walk/paths.js';
import { languageOf, type CheckReport, type DialCore, type FileExtract, type FileRecord } from './core.js';

/** A report plus the one line the panel puts above it — see `summarize`. */
export interface CheckOutcome {
  report: CheckReport;
  summary: string;
}

/**
 * How many names one line will say before it stops being a summary. A file missing forty
 * exports produces a sentence nobody reads; the honest tail (`… and 34 more`) says the same
 * thing in the space of one. The full list is in `report.symbols` and the panel renders it —
 * this cap only ever bounds the sentence, never the report.
 */
const MAX_NAMES_LISTED = 6;

/**
 * The reference file's `FileExtract` — the thing `check()` compares against.
 *
 * Built the way repo-tour's own `test/build.test.ts` builds one (`extractOf`): an
 * inventory-shaped `FileRecord` for the single file, then `extract()` on it. That is the
 * documented route and the only public one — `extract()`'s parser map is module-private, so
 * there is no way to parse one file except to describe it as if an inventory had found it.
 * The fields that matter to `extract()` are `path`, `language`, `binary` and
 * `classification` (it skips binaries, unknown languages, vendored and generated files);
 * `repo` and `sha256` are inventory bookkeeping this call has no use for, and repo-tour's own
 * harness leaves them empty in exactly the same way.
 *
 * `null` — never a throw — for every ordinary way this can come to nothing: a language
 * `languageOf` does not recognise, a `relPath` that escapes `refRoot`, a file that is not
 * there or cannot be read, and an `extract()` that produced no entry at all.
 */
// `FileExtract` is `unknown` today (it is an opaque handle — see `./core.ts`), so eslint is
// right that the union adds no information to the TYPE. It adds all of it to the CONTRACT:
// this function has a documented `null` answer, callers are written against it, and the day
// repo-tour's extract shape is worth mirroring here the signature should not have to change.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- the `| null` is the contract, not a type refinement
export async function referenceExtract(core: DialCore, refRoot: string, relPath: string): Promise<FileExtract | null> {
  const language = languageOf(relPath);
  if (language === undefined) return null;

  const abs = resolveInsideTarget(refRoot, relPath);
  if (abs === null) return null;

  let source: string;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch {
    return null; // gone, renamed, or a directory — the reference has simply moved on
  }

  const record: FileRecord = {
    path: relPath,
    repo: '',
    bytes: Buffer.byteLength(source, 'utf8'),
    loc: source.split(/\r?\n/).length,
    language,
    sha256: '',
    classification: 'source',
    signals: ['build-tutorials-check'],
    binary: false,
  };

  const { extracts } = await core.extract(refRoot, [record]);
  return extracts[0] ?? null;
}

/**
 * Run the structural check for one step: the learner's file as it stands on disk, against the
 * reference file the plan was generated from.
 *
 * `null` whenever there is nothing to compare — see this file's header. In particular a
 * missing learner file is the *expected* state in manual mode, where the extension writes
 * nothing at all, so it is answered here and never surfaced as a failure.
 *
 * Note that the learner's source is read BEFORE the reference is parsed. That ordering is not
 * incidental: the commonest call by far is "the file is not written yet", and it should cost
 * a failed `readFileSync`, not a tree-sitter parse of the reference.
 */
export async function runCheck(
  core: DialCore,
  refRoot: string,
  target: string,
  step: StepLike,
): Promise<CheckOutcome | null> {
  const relPath = step.target.file;
  const language = languageOf(relPath);
  if (language === undefined) return null;

  const learnerPath = resolveInsideTarget(target, relPath);
  if (learnerPath === null) return null;

  let learnerSource: string;
  try {
    learnerSource = fs.readFileSync(learnerPath, 'utf8');
  } catch {
    return null; // nothing written yet — manual mode's ordinary state, not an error
  }

  const reference = await referenceExtract(core, refRoot, relPath);
  if (reference === null) return null;

  const report = await core.check(learnerSource, reference, language, relPath);
  return { report, summary: summarize(report) };
}

/**
 * The one line a learner actually reads.
 *
 * A report is a table; a table is what you study once you already know something is wrong.
 * The sentence above it has to carry the finding on its own, so:
 *
 *   - **A file that did not parse leads with the core's own `reason`.** `parseErrors: 3` says
 *     a file did not parse but never why, and "why" is the entire content of the answer to
 *     someone staring at a red tick. That field exists in `CheckReport` for this sentence.
 *   - **A failure names what is missing.** "missing export: rank" is a next action; "1
 *     missing" is a riddle. Names only, not kinds — the report itself carries the kind of
 *     every symbol and the panel renders it, so repeating `(function)` here buys nothing and
 *     costs the line's readability.
 *   - **A pass counts what was there.** "every part is there" alone reads like the check did
 *     not run; the counts are the evidence that it did, and they are also how a learner
 *     notices they have checked an empty file.
 *
 * Extras are reported and never scolded: an export the reference never had does not fail the
 * check (repo-tour's `compare` only fails on `missing`), so the sentence says so out loud
 * rather than leaving a learner to wonder whether their helper broke something.
 */
function summarize(report: CheckReport): string {
  if (report.parseErrors > 0) {
    // `reason` is documented as present exactly when `parseErrors > 0`, but this module reads
    // the core across a duck-typed boundary (`./core.ts`), so it never *assumes* a field.
    return report.reason ?? `this file did not parse — ${countOf(report.parseErrors, 'error')} — so its shape could not be compared yet`;
  }

  const missingSymbols = report.symbols.filter((s) => s.status === 'missing').map((s) => s.name);
  const missingImports = report.imports.filter((i) => i.status === 'missing').map((i) => i.raw);
  if (missingSymbols.length > 0 || missingImports.length > 0) {
    const parts: string[] = [];
    if (missingSymbols.length > 0) parts.push(`missing ${missingSymbols.length === 1 ? 'export' : 'exports'}: ${listOf(missingSymbols)}`);
    if (missingImports.length > 0) parts.push(`missing ${missingImports.length === 1 ? 'import' : 'imports'}: ${listOf(missingImports)}`);
    return parts.join(' · ');
  }

  // Nothing missing and it parsed, yet the core still says no. Unreachable against today's
  // repo-tour, where `ok` is exactly those two conditions — but `ok` is the core's verdict and
  // this is a duck-typed boundary, so the sentence defers to it instead of overruling it with
  // a cheerful count. Better a vague true line than a confident false one.
  if (!report.ok) return 'the check did not pass, though nothing is missing and the file parsed — see the report below';

  const present = report.symbols.filter((s) => s.status === 'present').length;
  const extras = report.symbols.filter((s) => s.status === 'extra').map((s) => s.name);
  const imports = report.imports.length;

  let line: string;
  if (present === 0 && imports === 0) {
    line = 'nothing structural to compare here — the reference file declares no exports and no imports';
  } else if (imports === 0) {
    line = `every part is there: ${countOf(present, 'export')} present, and no imports to match`;
  } else if (present === 0) {
    line = `every part is there: ${countOf(imports, 'import')} present, and no exports to match`;
  } else {
    line = `every part is there: ${countOf(present, 'export')} and ${countOf(imports, 'import')} present`;
  }

  if (extras.length === 0) return line;
  return `${line} · plus ${countOf(extras.length, 'export')} of your own (${listOf(extras)}) — extras never fail the check`;
}

/** "1 export" / "3 exports" — the count is the point, so it always leads. */
function countOf(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Names, comma-separated, capped at `MAX_NAMES_LISTED` with an honest tail. */
function listOf(names: readonly string[]): string {
  if (names.length <= MAX_NAMES_LISTED) return names.join(', ');
  return `${names.slice(0, MAX_NAMES_LISTED).join(', ')} … and ${names.length - MAX_NAMES_LISTED} more`;
}
