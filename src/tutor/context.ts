// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the tutor is TOLD — the factual half of the prompt, assembled from the one step the
 * learner is stuck on (T-6, AC1). `src/tutor/ask.ts` sends it; nothing here talks to a model,
 * and nothing here can: this module has no runner, no provider and no timeout, only a `git`
 * and two directories. A prompt builder that cannot spend money is a prompt builder you can
 * unit-test at full strength, which is exactly what AC1's check asks for.
 *
 * The shape is repo-tour's `AskContext` (`src/tutor/core.ts` pins the slice this extension
 * fills), not a format invented here, and that is the whole design. repo-tour's
 * `buildContextBlock` already knows how to flatten a page into labelled lines a model reads
 * well, and its T-13 added the `build` block — `{ question, options, why, learnerDiff }` —
 * for this consumer specifically. Re-rendering the same facts our own way would produce a
 * second prompt format to keep in step with a persona that lives in another repository.
 *
 * **No `vscode` import, value or type.** `esbuild.mjs`'s `test/unit/*.test.ts` bundle marks
 * `repo-tour` and `mocha` external and deliberately NOT `vscode`, so one such import fails
 * the build and takes all 479 unit tests with it — `src/dial/writer.ts`'s header spells this
 * out and it applies here word for word.
 *
 * ── What the tutor is given, and why each piece ─────────────────────────────────────────────
 *
 *   - **`repo`** — the reference repository's own folder name. The learner is rebuilding
 *     somebody else's project and the model should say its name, not "the reference".
 *   - **`file`** — `step.target.file`, the plan's own relative path, never the absolute one.
 *     What the learner sees in their editor's tab is what a citation should match.
 *   - **`fileMeaning`** — the step's `why` WITH ITS SOURCE NAMED. This is the field that most
 *     changes the quality of an answer, and it is the one an unwary version would flatten.
 *     `whySource: 'docstring'` means the sentence is the author's own words; `'interpret'`
 *     means a model read the code and guessed; `'none'` means nobody could tell. A tutor that
 *     cannot see which of the three it is holding will quote an inference back at the learner
 *     as though the author had said it — and the author is the only authority this walk has.
 *   - **`stopTitle` / `stopText`** — the question, and the options as text. These are the
 *     fields repo-tour's persona describes as "the page they can see", so they carry what the
 *     step panel is actually showing. The options therefore appear twice in the finished
 *     block, once as the page and once inside `--- THE BUILD STEP ---`; that costs a few
 *     hundred characters and buys the distinction between "what is on their screen" and "the
 *     decision, structured", which the persona leans on.
 *   - **`build.learnerDiff`** — their file against the author's. Everything above describes
 *     the step; this is the only field that describes THEM, and "why doesn't mine work" is
 *     unanswerable without it.
 *
 * ── The diff is `git diff --no-index`, and exit code 1 is the ANSWER ────────────────────────
 *
 * `git diff --no-index -- <reference file> <target file>` compares two files in two unrelated
 * trees, which is precisely the comparison here and one no repository-scoped `git diff` can
 * make. It also **exits 1 whenever the files differ** — the ordinary case, the case this
 * whole feature exists for — and `GitRunner` (`src/start/build.ts`) rejects on any non-zero
 * exit. So the rejection is caught and read as a result, not reported as a failure. Treating
 * it as an error would mean the tutor was handed a diff exactly when the two files were
 * IDENTICAL and nothing at all the rest of the time.
 *
 * There is a second half to that surprise, and it is the reason for `--output` below.
 * `realGit` builds its rejection from `stderr` and **discards `stdout`**, so on exit 1 the
 * diff itself is gone before the `catch` runs — the text is in the child's stdout, and the
 * only thing that reaches this module is `Command failed: git diff …`. Git is therefore asked
 * to write the diff to a file (`--output=<tmp>`), which it does on both exit paths, and the
 * file is what is read. Two things fall out of that for free: a diff larger than `execFile`'s
 * 64 MB `maxBuffer` can no longer reject with an unrelated error, and only a bounded prefix
 * of the file is ever pulled into memory (`readDiffOutput`). A runner that ignores `--output`
 * and simply resolves with the diff on stdout — the shape a hand-written test fake naturally
 * takes — still works: the resolved string is the fallback.
 *
 * `cwd` is the deepest directory the two paths share, and the paths handed to git are
 * relative to it. Git echoes the names it was given straight into the `diff --git a/… b/…`
 * header, so this is the difference between three header lines that read
 * `a/reference/src/parse.ts` and three that read `a/home/<someone>/Coding Projects/…` — a
 * shorter prompt, and the learner's home directory not sent to a third party to be billed.
 *
 * ── Four ways there is no diff, and four different sentences ────────────────────────────────
 *
 * "No diff" is never one state, and collapsing them would leave the tutor guessing:
 *
 *   - **They have not written the file yet** — `NO_FILE_YET`, in plain words. The ordinary
 *     state of every step in manual mode (`src/dial/writer.ts`: the extension writes nothing
 *     at all there), and the single most useful thing the tutor can know about a stuck
 *     learner, because the answer to "why doesn't it work" is then "start it".
 *   - **They have written it and it matches** — `NO_DIFFERENCE`. Git's own answer here is an
 *     empty string, which `buildContextBlock` would drop on the floor, leaving the tutor
 *     unable to tell a perfect reproduction from a question it was never given the material
 *     for. Said out loud instead, it changes the answer: they are not stuck on the code.
 *   - **The path escapes its tree** — the field is omitted. `plan.json` is generated from a
 *     repository the learner pointed us at, so `target.file` is untrusted input
 *     (`src/walk/paths.ts` gives the full argument); a step naming `../../.ssh/id_rsa` gets
 *     no diff, and gets it silently, because the learner did nothing wrong and the plan is
 *     not theirs to fix. Both ends are checked, lexically and through `realpath`, because
 *     **the destination of what is read here is a paid third-party model** — this module
 *     never writes a byte, and reading is the entire exposure.
 *   - **Git could not do the comparison** — the field is omitted. A reference file that is no
 *     longer there is the common cause; there is nothing to say about it that a learner or a
 *     tutor could act on, and an ask is not worth failing over.
 *
 * ── The clip, and why exactly 8,000 ─────────────────────────────────────────────────────────
 *
 * `MAX_DIFF_CHARS` is 8,000 because that is `buildContextBlock`'s OWN budget for this field.
 * Sending more is not "more context": repo-tour clips it back to 8,000 on arrival with a bare
 * `… (truncated)`, so every character above the line is one the learner is billed to send and
 * the model never sees, announced — if at all — in someone else's terser words. Clipping here
 * to a total that includes our marker means repo-tour's clip never fires, the model is told
 * how big the real diff is, and the announcement is ours. The cap is a cap on the LEARNER'S
 * MONEY, which is why it is announced twice over rather than applied quietly: a reply is
 * billed by the token, and a diff is the one field in this context with no natural ceiling
 * (a `shape` step compares two whole directories).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitRunner } from '../start/build.js';
import type { OptionLike, StepLike, WhySource } from '../walk/model.js';
import { resolveInsideTarget } from '../walk/paths.js';
import type { AskContext } from './core.js';

/**
 * What `learnerDiff` says when the learner has not created the file yet.
 *
 * A sentence rather than an empty string, and a sentence that answers the question
 * `buildContextBlock` puts above it ("The learner's file against the author's:"), because an
 * empty string is dropped from the block entirely and the tutor would then be answering
 * without knowing whether the learner has started.
 */
export const NO_FILE_YET =
  'The learner has not created this file yet, so there is nothing of theirs to compare against the author’s version.';

/** What `learnerDiff` says when the two files match exactly — see the header's four states. */
export const NO_DIFFERENCE =
  'The learner’s file is already byte-for-byte identical to the author’s: this diff is empty.';

/**
 * The largest `learnerDiff` this module will send, marker included — `buildContextBlock`'s own
 * budget for the field, for the reasons the header gives at length. Retuning it moves the
 * tests with it; they assert against this constant rather than a copy of its value.
 */
export const MAX_DIFF_CHARS = 8000;

/**
 * How much of git's output is pulled into memory before anything is clipped. Four bytes per
 * character is UTF-8's own worst case, so this always yields more characters than the budget
 * can spend, and a pathological diff never becomes a pathological string.
 */
const MAX_DIFF_READ_BYTES = MAX_DIFF_CHARS * 4 + 4;

/**
 * What a clipped diff says about itself, with the real size in it — the same shape
 * `src/walk/step-view.ts` uses for `optionsOmittedMessage`, and exported for the same reason:
 * a test should assert the sentence this module really appends, never a copy that can drift.
 *
 * Phrased at the model rather than at the learner (it is the model that reads it) and with an
 * action in it, because a model that knows it is holding the top of a large diff asks about
 * one part of the file, while a model that merely sees `… (truncated)` answers confidently
 * about a file it has seen the first page of.
 */
export function clipMarker(fullBytes: number): string {
  return `\n… (clipped — the whole diff is ${fullBytes} bytes and you are seeing only its beginning; ask about one part of the file if you need more)`;
}

/**
 * The three labels the step panel puts under `why`, word for word.
 *
 * Duplicated from `src/walk/step-view.ts` rather than imported, exactly as that file
 * duplicates `src/start/view.ts`'s `DIAL_LABEL` and gives the same reason: the panel's copy
 * is module-private and this ticket does not own that file. Kept identical so the tutor is
 * told what the learner is being shown — a model and a learner disagreeing about where a
 * sentence came from is a worse failure than either of them being unsure.
 */
const WHY_SOURCE_LABEL: Record<WhySource, string> = {
  interpret: 'from the model, reading the code',
  docstring: "from the author's own comment",
  none: 'not inferable from the source',
};

/** The panel's own fallback wording, for a `whySource` no label covers. */
const UNKNOWN_WHY_SOURCE = "this plan names a source we don't recognise";

/**
 * `WHY_SOURCE_LABEL[whySource]`, made TOTAL — the same hole `step-view.ts`'s `whySourceLabel`
 * was hardened against in T-4's security review, and it is a hole here for the same reason:
 * `whySource` is typed `WhySource` but its value is whatever `plan.json` said, so
 * `'constructor'` and `'__proto__'` index to inherited members rather than to `undefined`.
 * A function reaching a template literal is not a label, and guessing at one of the three
 * real ones would be a confident lie about whose words the tutor is about to be handed.
 */
function whySourceLabel(source: unknown): string {
  if (typeof source !== 'string' || !Object.hasOwn(WHY_SOURCE_LABEL, source)) return UNKNOWN_WHY_SOURCE;
  const label: unknown = (WHY_SOURCE_LABEL as Record<string, unknown>)[source];
  return typeof label === 'string' ? label : UNKNOWN_WHY_SOURCE;
}

/** The step's options, or none — `plan.json` is parsed, not validated, so the declared array
 *  type is a promise about the schema rather than about the bytes on this learner's disk. */
function optionsOf(step: StepLike): OptionLike[] {
  const options: unknown = step.decision.options;
  return Array.isArray(options) ? (options as OptionLike[]) : [];
}

/**
 * Which option ids are the road the author actually took.
 *
 * `taken` is the schema's own flag and is trusted first. The fallback to `authorChoice` is
 * there because the two can disagree in a hand-edited or half-generated plan, and the failure
 * that produces is the quiet one: every line renders `[alternative]`, the tutor is never told
 * which road was taken, and it answers about the decision as though it were still open. When
 * neither says anything, nothing is marked — an honest "we do not know" beats a guess that
 * would put the author's name on somebody else's idea.
 */
function takenIdsOf(step: StepLike): Set<string> {
  const options = optionsOf(step);
  const flagged = options.filter((o) => o.taken === true).map((o) => o.id);
  if (flagged.length > 0) return new Set(flagged);
  const author: unknown = step.decision.authorChoice;
  if (typeof author === 'string' && options.some((o) => o.id === author)) return new Set([author]);
  return new Set<string>();
}

/**
 * The step's options as one line each, the author's road marked differently from the rest.
 *
 * This is the sentence that tells the tutor which way the story actually went, and the format
 * is repo-tour's own — `buildContextBlock` renders `ctx.build.options` as
 * `[author] <label> — <consequence>` — so the page half of the context and the structured
 * half read the same rather than contradicting each other inside one prompt. Both halves are
 * marked from `takenIdsOf`, once, for the same reason.
 *
 * Empty for a step with no options recorded, which the block then simply leaves out.
 */
export function renderOptionsText(step: StepLike): string {
  const taken = takenIdsOf(step);
  return optionsOf(step)
    .map((o) => `[${taken.has(o.id) ? 'author' : 'alternative'}] ${String(o.label)} — ${String(o.consequence)}`)
    .join('\n');
}

/**
 * The `why` with the source of the `why` named under it — see the header.
 *
 * When `whySource` is `none` this can read almost twice, since repo-tour's own fallback `why`
 * for an uninferable step is the phrase "not inferable from the source". `step-view.ts` lives
 * with the same overlap on screen, and the alternative — suppressing the label when it looks
 * like the sentence — would drop the label in exactly the case where the tutor most needs to
 * know that nobody actually said this.
 */
function fileMeaningOf(step: StepLike): string {
  const raw: unknown = step.decision.why;
  const why = typeof raw === 'string' ? raw.trim() : '';
  const source = whySourceLabel(step.decision.whySource);
  return why.length > 0 ? `${why}\n(${source})` : `(nothing was recorded for this step — ${source})`;
}

// ── the paths, both ends ────────────────────────────────────────────────────────────────────

function realOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null; // not there, or a dangling link — `insideRealRoot` says what that means
  }
}

/**
 * Whether `absPath` really lives inside `root` once symlinks are followed — the filesystem
 * half of containment, which `resolveInsideTarget` states out loud that it does not do.
 *
 * Duplicated from `src/dial/writer.ts`, where it is module-private and guards the WRITE side.
 * The read side needs it just as badly here, and for a reason the write side does not have:
 * a committed `vendor -> /home/you/.ssh` directory symlink is lexically contained and resolves
 * outside, and what this module does with a file it resolves is put its contents in a prompt
 * and pay a third party to read it. A path that will not resolve is answered `true` — the read
 * is about to fail on its own terms and say so better — but a root that will not resolve while
 * the file does is refused, because a comparison against nothing must never come back
 * "contained".
 */
function insideRealRoot(root: string, absPath: string): boolean {
  const real = realOrNull(absPath);
  if (real === null) return true;
  const realRoot = realOrNull(root);
  if (realRoot === null) return false;
  return resolveInsideTarget(realRoot, real) !== null;
}

/** Where `file` is allowed to be, under `root`: lexically contained AND really contained. */
function containedPath(root: string, file: string): string | null {
  const abs = resolveInsideTarget(root, file);
  if (abs === null) return null;
  return insideRealRoot(root, abs) ? abs : null;
}

/** The deepest directory two absolute paths share — see the header for why git is run there. */
function commonRoot(a: string, b: string): string {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return left.slice(0, shared).join(path.sep) || path.sep;
}

// ── the diff ────────────────────────────────────────────────────────────────────────────────

/** Git's output file, read as at most a bounded prefix. `whole` is false when there was more
 *  of it than `MAX_DIFF_READ_BYTES`, which is one of the two ways a diff can need clipping. */
function readDiffOutput(file: string): { text: string; bytes: number; whole: boolean } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { text: '', bytes: 0, whole: true }; // git never got as far as writing one
  }
  try {
    const bytes = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(bytes, MAX_DIFF_READ_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, read).toString('utf8'), bytes, whole: read >= bytes };
  } finally {
    fs.closeSync(fd);
  }
}

/** `text` if it fits the budget whole, otherwise its beginning plus a marker that says so —
 *  and the total never exceeds `MAX_DIFF_CHARS`, so repo-tour's own silent clip never fires. */
function clipDiff(text: string, bytes: number, whole: boolean): string {
  if (whole && text.length <= MAX_DIFF_CHARS) return text;
  const marker = clipMarker(bytes);
  return `${text.slice(0, Math.max(0, MAX_DIFF_CHARS - marker.length))}${marker}`;
}

/**
 * The learner's file against the author's, or one of the four "no diff" answers the header
 * lists. Never throws: this builds a prompt, and no failure to describe a file is worth
 * refusing to answer a stuck learner's question over.
 */
async function learnerDiffFor(
  step: StepLike,
  refRoot: string,
  target: string,
  git: GitRunner,
): Promise<string | undefined> {
  const file = step.target.file;
  const reference = containedPath(refRoot, file);
  const learner = containedPath(target, file);
  if (reference === null || learner === null) return undefined;
  if (!fs.existsSync(learner)) return NO_FILE_YET;

  let box: string;
  try {
    box = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-tutor-diff-'));
  } catch {
    return undefined; // nowhere to put git's answer; the ask goes on without it
  }
  const output = path.join(box, 'learner.diff');
  const cwd = commonRoot(reference, learner);
  try {
    let stdout = '';
    let exitedZero = true;
    try {
      stdout = await git(
        ['diff', '--no-index', `--output=${output}`, '--', path.relative(cwd, reference), path.relative(cwd, learner)],
        cwd,
      );
    } catch {
      // Exit 1 — "they differ" — is the case this whole module exists for, and it arrives
      // here as a rejection. What git actually produced is in the output file either way.
      exitedZero = false;
    }

    const written = readDiffOutput(output);
    if (written.text.length > 0) return clipDiff(written.text, written.bytes, written.whole);
    if (stdout.length > 0) return clipDiff(stdout, Buffer.byteLength(stdout, 'utf8'), true);
    return exitedZero ? NO_DIFFERENCE : undefined;
  } catch {
    return undefined; // an unreadable answer is still no reason to fail the ask
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

// ── the context ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the tutor is told about the step the learner is stuck on, ready for
 * `buildAskPrompt(messages, ctx)`.
 *
 * `refRoot` is the author's repository, `target` the learner's folder, and `step` the one
 * decision they are inside of — never the whole plan, which is the boundary repo-tour's
 * `AskContext.build` draws in its own comment: the tutor is answering about this step, not
 * auditing the tutorial.
 */
export async function tutorContext(
  step: StepLike,
  refRoot: string,
  target: string,
  git: GitRunner,
): Promise<AskContext> {
  const taken = takenIdsOf(step);
  const learnerDiff = await learnerDiffFor(step, refRoot, target, git);
  return {
    repo: path.basename(path.resolve(refRoot)),
    file: step.target.file,
    fileMeaning: fileMeaningOf(step),
    stopTitle: step.decision.question,
    stopText: renderOptionsText(step),
    build: {
      question: step.decision.question,
      options: optionsOf(step).map(({ id, label, consequence }) => ({
        label: String(label),
        consequence: String(consequence),
        taken: taken.has(id),
      })),
      why: step.decision.why,
      ...(learnerDiff === undefined ? {} : { learnerDiff }),
    },
  };
}
