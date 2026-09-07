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
 * the build and takes the whole unit suite with it — `src/dial/writer.ts`'s header spells this
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
 * **`--output` bounds MEMORY, and only memory** — this sentence used to claim more. Git
 * writes the WHOLE diff into that file before `readDiffOutput` reads 32 KB of it, so the file
 * is as big as the comparison is: the security review measured **26.0 MB** in `os.tmpdir()`
 * from a single ask on a 25 MB chapter directory, and a chapter carrying a real `node_modules`
 * would write hundreds. What bounds the DISK is the outbound contract below — git is never
 * asked at all unless both sides are ordinary files under `MAX_DIFF_INPUT_BYTES` — which also
 * removes the directory case that produced that measurement. The box is still deleted in a
 * `finally`, so this was always churn rather than a leak; it is now bounded churn.
 *
 * `cwd` is the deepest directory the two paths share, and the paths handed to git are
 * relative to it. Git echoes the names it was given straight into the `diff --git a/… b/…`
 * header, so this is the difference between three header lines that read
 * `a/reference/src/parse.ts` and three that read `a/home/<someone>/Coding Projects/…` — a
 * shorter prompt, and the learner's home directory not sent to a third party to be billed.
 *
 * ── Seven ways there is no diff, and FIVE different sentences ───────────────────────────────
 *
 * "No diff" is never one state, and collapsing them would leave the tutor guessing. Five of
 * the seven get a sentence; two are said with SILENCE, and the count is written this way round
 * because the earlier version of this line said "seven sentences" and there were never seven
 * (T-13 review finding 8). In this file the sentence count IS the design, so a number here
 * that disagrees with the list below is a defect in the same way a wrong constant would be —
 * `test/unit/tutor-context.test.ts` now fails when they drift apart.
 *
 *   - **They have not written the file yet** — `NO_FILE_YET`, in plain words. The ordinary
 *     state of every step in manual mode (`src/dial/writer.ts`: the extension writes nothing
 *     at all there), and the single most useful thing the tutor can know about a stuck
 *     learner, because the answer to "why doesn't it work" is then "start it".
 *   - **They have written it and it matches** — `NO_DIFFERENCE`. Git's own answer here is an
 *     empty string, which `buildContextBlock` would drop on the floor, leaving the tutor
 *     unable to tell a perfect reproduction from a question it was never given the material
 *     for. Said out loud instead, it changes the answer: they are not stuck on the code.
 *   - **The step does not point at one file** — `NOT_ONE_FILE`, and see the contract below.
 *     A `shape` step's `target.file` is the chapter DIRECTORY, so this is the first step of
 *     every chapter rather than an exotic case.
 *   - **One side is too big to compare** — `tooBigToDiff`, with the real size in it. Above
 *     `MAX_DIFF_INPUT_BYTES` the answer git would write to disk is orders of magnitude larger
 *     than the 8,000 characters that could ever be sent, so the comparison is not made.
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
 *   - **Git was STOPPED before it finished** — `DIFF_TIMED_OUT` (T-13). Split off from the
 *     line above on purpose: "git could not" is an answer git gave, and a subprocess killed at
 *     its bound gave none. Read as the previous case it would be silent, and the silence would
 *     be the harmful one — this is the state a slow disk or a network filesystem produces, so
 *     it recurs on every ask, and a model that is never told the comparison was abandoned will
 *     answer as though the learner's file were fine.
 *
 * ── `Outbound`: the one thing that decides what reaches a paid third party ───────────────────
 *
 * T-6's security review found four separate holes on this path (findings 1, 2, 6 and 8) and
 * they are one absence: `MAX_DIFF_CHARS` was the only bound anywhere on it, it was on one
 * field, and it bounded SIZE while the exposure that mattered was CONTENT. Four separate
 * patches would each have been defensible and would each have left the next field — the one
 * nobody has added yet — wide open. So there is one object instead, `Outbound`, and every
 * field of every `AskContext` this module builds goes through it. The answer to "what decides
 * what leaves this machine" is meant to be a name.
 *
 * Its five rules, each with the finding it closes:
 *
 *   1. **Only an ordinary file may be read for its contents** (finding 1, HIGH).
 *      `git diff --no-index <dirA> <dirB>` walks both trees recursively, descends
 *      dot-directories, includes dotfiles and **does not read `.gitignore`** — and a `shape`
 *      step's `target.file` is the chapter DIRECTORY (repo-tour's `build/plan.ts` writes it
 *      that way; `test/unit/walk-fixtures.ts` documents it), which makes this the FIRST step
 *      of every chapter and the one a stuck learner is most likely to ask about. The reviewer
 *      drove this repository's own fixture plan and got a `.gitignore`d `src/.env` — a live
 *      Stripe key — into the prompt. Containment was never the missing check: `<target>/.env`
 *      really is inside the target. What was missing is that a directory is not a file.
 *      Of the three fixes offered (refuse anything but a regular file; diff only the paths the
 *      plan teaches; run git with the plan's file list as a pathspec) this takes the first,
 *      for two reasons. The second and third need the PLAN, and `tutorContext` is handed one
 *      step — widening that seam means widening `session.ts`'s call too, for a field this
 *      module would then have to bound anyway. And they answer a directory with a smaller
 *      "everything under here", which is the same shape of answer: the honest reply to "what
 *      goes in this chapter" is the step's own words, not a walk of the learner's disk. The
 *      refusal is a SENTENCE (`NOT_ONE_FILE`), not a silent omission, so the tutor can say
 *      why it cannot see their work.
 *   2. **Every plan-sourced string is capped, and the cap announces itself** (finding 2).
 *      `question`, `why` and every option's `label`/`consequence` reached the prompt with no
 *      bound at all: a plan with a 5 MB `question` and a 5 MB `why` produced a measured
 *      **19,906,863-character prompt (~5M tokens) on one button press**. These are the same
 *      fields T-4's own security review capped for the RENDER, at `MAX_PLAN_TEXT` (20,000)
 *      and `MAX_OPTIONS_RENDERED` (24), one file away in `step-view.ts` — and the lesson the
 *      code reviewer drew from that is the rule this object exists to make true:
 *      **downstream caps are not your caps**. A cap in the renderer bounds a render; the
 *      prompt is billed by the token and needs its own. Where repo-tour clips a field itself
 *      (`fileMeaning` and `stopText` at 2,000, `learnerDiff` at 8,000), the budget here is
 *      ITS number, so its silent `… (truncated)` never fires and the announcement stays ours —
 *      which also keeps `fileMeaning`'s source label, the sentence that tells the tutor whose
 *      words the `why` is, from being the thing repo-tour cuts off.
 *   3. **A stored turn is capped by size, not only by count** (finding 4) — `Outbound.turn`,
 *      used by `src/tutor/transcript.ts`. `MAX_TURNS_KEPT` bounds how MANY turns are kept and
 *      nothing bounded how big one is; `trimMessages` re-sends the last thirty IN FULL on
 *      every later ask about the step, so one large reply is billed again on every follow-up.
 *   4. **The disk is bounded before git writes, not after** (finding 6) — `MAX_DIFF_INPUT_BYTES`,
 *      and the paragraph above on `--output`.
 *   5. **Every announcement sits where file content cannot forge it** (finding 8). The clip
 *      marker used to be appended INSIDE the diff body, where any reference or learner file
 *      containing that sentence puts it into an UN-clipped diff and lies to the model about
 *      the diff's size. The tutor's one sentence now goes ABOVE git's output, on a line
 *      content can never occupy — git's own first line is `diff --git …` — and it is present
 *      whether the diff was clipped or not, so its absence cannot be forged either. The rest
 *      of the block's structure was checked and holds: every diff body line carries a prefix,
 *      and git C-quotes a filename containing a newline even under `core.quotePath=false`.
 *
 * The budgets are stated as constants below with the measurement behind each, and
 * `MAX_CONTEXT_CHARS` is their sum: what one ask can put in front of a model from this module
 * is now arithmetic rather than whatever `plan.json` happened to contain.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitTimedOut, type GitRunner } from '../start/build.js';
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

/** What `learnerDiff` says when the two files match exactly — see the header's six states. */
export const NO_DIFFERENCE =
  'The learner’s file is already byte-for-byte identical to the author’s: this diff is empty.';

/**
 * What `learnerDiff` says when the step points at something that is not one ordinary file —
 * a chapter directory, which is what every `shape` step points at, or (far more rarely) a
 * device or a pipe. Rule 1 of the outbound contract; the header gives the full argument.
 *
 * A sentence rather than an omitted field, for the same reason `NO_FILE_YET` is one: the
 * tutor is about to answer a learner who may be stuck precisely BECAUSE this is the "what
 * goes in this part of the repository" step, and "I was not shown your work" is a true and
 * useful thing for it to know. It also says what it would have taken to see the diff, so the
 * model can ask for it in the learner's own words rather than apologising vaguely.
 */
export const NOT_ONE_FILE =
  'This step is about a whole part of the repository rather than one file, so there is no diff of the learner’s work here: comparing two directories would mean sending every file inside them — including files the learner never meant to share, which their own .gitignore would not stop. Ask them about one file in it if you need to see their code.';

/**
 * What `learnerDiff` says when one side is too big to be worth comparing — rule 4, and the
 * disk half of the `--output` correction in the header. The real size is in it for the same
 * reason `diffNote` carries one: a model told the file is enormous asks about part of it,
 * while a model told nothing answers confidently about a file it never saw.
 */
export function tooBigToDiff(bytes: number): string {
  return `One of the two copies of this file is ${bytes} bytes, which is too large for this tutor to diff: git would have to write the whole comparison to disk to show you a few thousand characters of it. Ask the learner about one part of the file instead.`;
}

/**
 * What `learnerDiff` says when the comparison was STOPPED at its bound rather than finished
 * (T-13). The seventh state, and it earns a sentence for the same reason the other four do:
 * the field's absence is read by the model as "nothing to see", and a tutor that quietly
 * believes a stuck learner has written nothing gives a confidently wrong answer.
 *
 * It also wins over whatever bytes are sitting in the `--output` box, and that is the point
 * rather than caution. Git writes the diff as it goes, so a killed `git diff` leaves a
 * TRUNCATED one behind — and this module has no way to tell a truncated diff from a complete
 * small one. Sending it would tell the model "here is the difference between their file and
 * the author's" about a comparison that never finished, which is exactly the forgeable-clip-
 * marker failure the security review's finding 8 named: a diff that lies about its own
 * completeness. So the partial answer is dropped and the reason is sent instead.
 */
export const DIFF_TIMED_OUT =
  'Comparing the learner’s file against the author’s took too long and was stopped, so no diff of their work is available here — this says nothing about whether they have written it or what is in it. Ask them what they have so far, or about one part of the file.';

/**
 * The largest `learnerDiff` this module will send, the tutor's own note line included —
 * `buildContextBlock`'s own budget for the field, so its silent `… (truncated)` never fires and
 * the announcement stays ours (rule 2). Sending more is not "more context": every character
 * above the line is one the learner is billed for and the model never sees. Retuning it moves
 * the tests with it; they assert against this constant rather than a copy of its value.
 */
export const MAX_DIFF_CHARS = 8000;

/**
 * How much of git's output is pulled into memory before anything is clipped. Four bytes per
 * character is UTF-8's own worst case, so this always yields more characters than the budget
 * can spend, and a pathological diff never becomes a pathological string.
 */
const MAX_DIFF_READ_BYTES = MAX_DIFF_CHARS * 4 + 4;

/**
 * The largest either copy of a file may be before the two are compared at all — rule 4.
 *
 * This is the DISK bound `--output` was mistaken for. Git writes the whole diff into the temp
 * box before `readDiffOutput` reads 32 KB of it, so the only number that bounds what lands in
 * `os.tmpdir()` is the size of what git is handed. Two files under this cap bound it at a
 * little over twice the cap: the worst case is that every line of both is emitted, each with a
 * one-character prefix, and two 2.4 MB files differing on every line measure 5.2 MB of diff —
 * 2.1×. Against the 26.0 MB one ask on a chapter directory produced, and the hundreds a
 * chapter carrying a real `node_modules` would.
 *
 * Measured, like every other number here. The largest hand-written source file across the
 * three repositories on hand is repo-tour's own `test/pipeline.test.ts` at 105,728 bytes, and
 * the largest VENDORED one a plan could legitimately name is sql-gauntlet's bundled
 * `codemirror.min.js` at 170,535. Two megabytes is roughly twelve times that, so nothing a
 * tutorial step honestly points at comes close — while a generated file, a checked-in
 * database or a media asset stops here instead of being copied through a temp file to show
 * the model 8,000 characters of it.
 */
export const MAX_DIFF_INPUT_BYTES = 2 * 1024 * 1024;

/**
 * How many characters of any ONE plan-sourced string reach the prompt — rule 2.
 *
 * `step-view.ts`'s `MAX_PLAN_TEXT`, deliberately the same 20,000 and for the same measured
 * reason (across 621 doc comments in the three repositories on hand the median is 146
 * characters, the 99th percentile 1,814 and the longest 5,121; the longest `why` in the real
 * 61-step sql-gauntlet plan is 279). Duplicated rather than imported, exactly as
 * `WHY_SOURCE_LABEL` below duplicates that file's copy and for the same reason: the panel's
 * constant is the PANEL's, this one is the PROMPT's, and the whole finding is that the first
 * was mistaken for the second. They are free to diverge the day one of them should.
 */
export const MAX_PROMPT_TEXT = 20000;

/**
 * The budget for the two fields repo-tour clips ITSELF — `fileMeaning` and `stopText`, both at
 * 2,000 in `buildContextBlock`. Sending more is not more context: it is billed on the way out
 * and dropped on arrival, with our own announcement dropped along with it. Matching its number
 * means its silent `… (truncated)` never fires and what the model is told about the cut is
 * ours. `fileMeaning` is the sharper case: the source label (`from the author's own comment`)
 * is APPENDED to the `why`, so a long `why` clipped downstream takes the label with it and the
 * tutor loses the one sentence that tells it whose words it is holding.
 */
export const MAX_PAGE_TEXT = 2000;

/**
 * How many of a step's options are sent — `step-view.ts`'s `MAX_OPTIONS_RENDERED`, the same 24
 * and duplicated for the same reason as `MAX_PROMPT_TEXT`. A plan built with no interpretation
 * gives every step exactly one option (all 61 steps of the real sql-gauntlet plan); a fully
 * interpreted step gives three. 24 is eight times what anything honest produces, and a hostile
 * `alternatives` array stops here rather than at fifty thousand.
 */
export const MAX_OPTIONS_SENT = 24;

/**
 * How many characters of ONE option's label or consequence are sent.
 *
 * Not `MAX_PROMPT_TEXT`, and the difference is arithmetic rather than taste: this budget is
 * spent up to 48 times in a single prompt, so 20,000 here would be 960,000 characters of one
 * ask — a quarter of a million tokens, billed, for a list. An option is a phrase and a
 * consequence is a sentence: in the real 61-step plan the longest label is 19 characters and
 * the longest consequence 84, and the fixture's longest is 95. 1,000 is more than ten times
 * what anything honest has produced while keeping the whole list under 48,000 characters.
 */
export const MAX_OPTION_TEXT = 1000;

/**
 * What one ask can put in front of a model from this module, worst case — the sum of every
 * budget above, plus a thousand characters for repo-tour's own labels and headings.
 *
 * It exists to be asserted. The security review's measurement was a 19,906,863-character
 * prompt from one button press, and the fix is only a fix if that number is now a function of
 * these constants rather than of `plan.json`; a test renders the real `buildContextBlock` on a
 * hostile plan and holds it to this ceiling. (The conversation is bounded separately, by
 * `MAX_TURNS_KEPT` × `MAX_TURN_CHARS` in `transcript.ts`, and repo-tour's `trimMessages`
 * sends at most the last thirty of those.)
 */
export const MAX_CONTEXT_CHARS =
  MAX_PROMPT_TEXT * 3 + // the question (twice — as the page's title and as the build step's) and the why
  MAX_PAGE_TEXT * 4 + // fileMeaning, stopText, the file path and the repository name
  MAX_OPTIONS_SENT * (MAX_OPTION_TEXT * 2 + 64) + // every option line, its `[author] … — …` frame included
  MAX_DIFF_CHARS +
  1000;

/**
 * The largest ONE stored turn may be — rule 3, applied in `src/tutor/transcript.ts`, which is
 * where the transcript is read and written and where `getTranscript` is already the single
 * enforcement point. The rule lives here because the reason for it is here: a stored turn is
 * replayed into the next prompt.
 *
 * 4,000 mirrors BOTH ends of what already exists. `MAX_ASK_TEXT` (`step-protocol.ts`) lets a
 * learner's question be 4,000 characters, so a legal question is never cut; `MAX_REPLY_TEXT`
 * (`step-view.ts`) draws at most 4,000 characters of a turn, so nothing a learner could ever
 * READ is lost to this cap either. What it does cut is text no human sees and every follow-up
 * pays for: `trimMessages` re-sends the last thirty turns in full, so an uncapped 2,000,000-
 * character reply — the reviewer stored and read one back — is billed again on every question
 * after it. The announcement (`turnCutNote`) fits inside the cap, so `step-view.ts`'s own
 * truncation marker never fires on top of it and the learner is told once, not twice.
 */
export const MAX_TURN_CHARS = 4000;

/**
 * The tutor's one sentence about the diff, and the only sentence in this whole field that the
 * tutor writes — rule 5.
 *
 * It sits ABOVE git's output rather than inside it. That is the entire fix for finding 8: a
 * marker appended after the cut lives among lines a reference or learner file controls, so any
 * file containing that sentence puts it into an un-clipped diff and tells the model a complete
 * diff was truncated. Git's own output begins with `diff --git …`, so a line above it is a
 * position content cannot occupy — and it is emitted whether the diff was clipped or not, so
 * content cannot forge its ABSENCE either, only add a line that visibly contradicts it.
 *
 * Phrased at the model rather than at the learner (it is the model that reads it) and with an
 * action in it, because a model that knows it is holding the top of a large diff asks about
 * one part of the file, while a model that merely sees `… (truncated)` answers confidently
 * about a file it has seen the first page of. Exported so a test asserts the sentence this
 * module really writes, never a copy of it that can drift.
 */
export function diffNote(fullBytes: number, clipped: boolean): string {
  const size = clipped
    ? `the whole diff is ${fullBytes} bytes and only its beginning is below — ask about one part of the file if you need more`
    : `the whole diff is ${fullBytes} bytes and all of it is below`;
  return `(the tutor, above git’s own output: ${size}. Only this first line is the tutor’s — every line under it is git’s output or a file’s own contents.)`;
}

/** What any other clipped field says about itself — rule 2's announcement, and the reason the
 *  budget rather than the receiver decides where the cut is. Exported to be asserted. */
export function textCutNote(fullLength: number): string {
  return `\n… (cut here by the tutor — this is the beginning of a field ${fullLength} characters long in the plan)`;
}

/** The line under a capped options list, with the COUNT in it rather than a vague "and more" —
 *  the same promise `step-view.ts`'s `optionsOmittedMessage` makes to the learner, made to the
 *  model. Exported to be asserted. */
export function optionsOmittedNote(omitted: number): string {
  return `(${omitted} more option${omitted === 1 ? '' : 's'} in this plan, not sent)`;
}

/** What a turn cut by `MAX_TURN_CHARS` says about itself. Read by BOTH the model (it is
 *  replayed into the next prompt) and the learner (the panel draws stored turns), so it names
 *  the real length and says who cut it. Exported to be asserted. */
export function turnCutNote(fullLength: number): string {
  return `\n… (cut here by the tutor — this turn was ${fullLength} characters and only its beginning is kept)`;
}

/** What stands in for a plan string that is not a string at all — `step-view.ts`'s
 *  `NOT_TEXT_MESSAGE`, word for word, so the page and the prompt say the same thing about the
 *  same field. Not an error and not a silent blank: "there is nothing readable in the plan at
 *  this spot" is a true sentence and `[object Object]` is not. */
export const NOT_TEXT_MESSAGE = '(the plan has nothing readable here)';

// ── the outbound contract ───────────────────────────────────────────────────────────────────

/** One option as it is SENT: repo-tour's `AskContext.build.options` entry, already through the
 *  contract, which is why `label` and `consequence` are `string` and not `unknown`. */
interface OutboundOption {
  label: string;
  consequence: string;
  taken: boolean;
}

/** Why a path may not be read for its contents — the three refusals `Outbound.fileToRead`
 *  distinguishes, because they are three different sentences (see the header's six states). */
export type DiffRefusal = { reason: 'gone' } | { reason: 'not-one-file' } | { reason: 'too-big'; bytes: number };

/**
 * **What may leave this machine.** Every field of every `AskContext` this module builds passes
 * through one of these five rules, and every one of them is a bound on the LEARNER'S MONEY or
 * on the learner's PRIVACY — the two things that changed when T-6 pointed a filesystem read at
 * a paid third-party model. The header states each rule with the finding it closes and the
 * measurement behind its number; what follows is only the code.
 *
 * It is an object rather than five loose functions on purpose. The failure being fixed is that
 * nobody owned the question, so four fields each answered it differently and a fifth answered
 * it not at all; a name is the part of the fix that survives the next field being added.
 * `src/tutor/transcript.ts` imports rule 3 from here rather than growing a cap of its own.
 */
export const Outbound = {
  /**
   * Rule 2 — one plan-sourced string, capped to `budget` INCLUDING the sentence that says it
   * was cut, so a receiver that clips at the same number never has to (and never silently
   * drops our announcement along with the tail).
   *
   * A non-string is answered with `NOT_TEXT_MESSAGE` rather than coerced: `plan.json` is
   * parsed and not validated, and `String({})` in a prompt is the model being told the
   * author wrote `[object Object]`.
   */
  text(value: unknown, budget: number): string {
    if (typeof value !== 'string') return NOT_TEXT_MESSAGE;
    if (value.length <= budget) return value;
    const note = textCutNote(value.length);
    return `${value.slice(0, Math.max(0, budget - note.length))}${note}`;
  },

  /**
   * Rule 2, for the one field that is a LIST — capped by count as well as by the text of each
   * entry, and reporting how many were left out so the caller can say so.
   *
   * The author's own option is kept even when it falls past the cap, exactly as
   * `step-view.ts` keeps it on the page: a list of 24 alternatives with the road actually
   * taken missing from it does not read as "some options are not shown", it reads as "the
   * author did none of these", which is a confident lie rather than a cut.
   */
  options(step: StepLike): { options: OutboundOption[]; omitted: number } {
    const all = optionsOf(step);
    const taken = takenIdsOf(step);
    const shown = all.slice(0, MAX_OPTIONS_SENT);
    const authorIndex = all.findIndex((o) => taken.has(o.id));
    if (authorIndex >= MAX_OPTIONS_SENT && shown.length === MAX_OPTIONS_SENT) {
      shown[MAX_OPTIONS_SENT - 1] = all[authorIndex]!;
    }
    return {
      options: shown.map((o) => ({
        label: Outbound.text(o.label, MAX_OPTION_TEXT),
        consequence: Outbound.text(o.consequence, MAX_OPTION_TEXT),
        taken: taken.has(o.id),
      })),
      omitted: Math.max(0, all.length - shown.length),
    };
  },

  /**
   * Rule 3 — one stored turn. Called from `src/tutor/transcript.ts`'s `sanitizeTranscript`,
   * which is the single function both the sole reader (`getTranscript`) and the sole writer
   * (`appendTurn`) go through, so a turn is cut on the way to disk AND on the way back off it.
   */
  turn(content: string): string {
    if (content.length <= MAX_TURN_CHARS) return content;
    const note = turnCutNote(content.length);
    return `${content.slice(0, Math.max(0, MAX_TURN_CHARS - note.length))}${note}`;
  },

  /**
   * Rules 1 and 4 — whether a path may be read for its CONTENTS at all, which is the question
   * containment was never asking. `null` means yes; anything else is a refusal with a sentence
   * behind it.
   *
   * `statSync` follows symlinks, which is right here and only because `insideRealRoot` has
   * already refused any link that leaves its root: the thing being asked is what kind of file
   * this is, not where it lives. `isFile()` is the check rather than `!isDirectory()` because
   * a fifo would block `git diff` for as long as nobody writes to it, and a device is not a
   * file a learner wrote.
   *
   * **A stat is a moment, not a lock**, and this is worth stating rather than leaving to be
   * discovered: between this answer and git opening the path, the path could become something
   * else. Closing that window would mean handing git an open descriptor, and git takes paths.
   * Whoever could win the race already has write access to the learner's own folder, which is
   * a strictly larger capability than the one this rule bounds — so the check is where the
   * value is, and the residue is named instead of implied.
   */
  fileToRead(abs: string): DiffRefusal | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { reason: 'gone' }; // not there, or a link to nothing
    }
    if (!stat.isFile()) return { reason: 'not-one-file' };
    if (stat.size > MAX_DIFF_INPUT_BYTES) return { reason: 'too-big', bytes: stat.size };
    return null;
  },

  /**
   * Rules 2 and 5 — git's output, under the tutor's own one-line note and inside
   * `MAX_DIFF_CHARS` with that note counted, so repo-tour's silent clip at the same number
   * never fires. `whole` is false when more of the file was written than `readDiffOutput`
   * pulled in, which is one of the two ways a diff can need cutting; `fullBytes` is always
   * git's real size, never the size of the prefix that was read.
   */
  diff(body: string, fullBytes: number, whole: boolean): string {
    const kept = `${diffNote(fullBytes, false)}\n`;
    if (whole && kept.length + body.length <= MAX_DIFF_CHARS) return `${kept}${body}`;
    const cut = `${diffNote(fullBytes, true)}\n`;
    return `${cut}${body.slice(0, Math.max(0, MAX_DIFF_CHARS - cut.length))}`;
  },
};

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
 *
 * Both halves come out of `Outbound.options`, so the cap cannot fire on one and not the other.
 * This half also carries the omitted COUNT, because it is the half that is free text —
 * `build.options` is a structured array with nowhere honest to put a sentence — and it is
 * assembled so that the count survives the whole-field budget: `MAX_PAGE_TEXT` is repo-tour's
 * own clip for this field, and an announcement that the receiver cuts off announces nothing.
 */
export function renderOptionsText(step: StepLike): string {
  const { options, omitted } = Outbound.options(step);
  const note = omitted > 0 ? `\n${optionsOmittedNote(omitted)}` : '';
  const lines = options.map((o) => `[${o.taken ? 'author' : 'alternative'}] ${o.label} — ${o.consequence}`).join('\n');
  return `${Outbound.text(lines, MAX_PAGE_TEXT - note.length)}${note}`;
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
  if (why.length === 0) return `(nothing was recorded for this step — ${source})`;
  // The label is what makes this field worth sending at all, so the `why` is budgeted around
  // it rather than the other way round: repo-tour clips this whole field at `MAX_PAGE_TEXT`
  // and would take the label — which is appended LAST — off the end of a long one.
  const label = `\n(${source})`;
  return `${Outbound.text(why, MAX_PAGE_TEXT - label.length)}${label}`;
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

/**
 * Which of the header's five sentences a refusal is — or `undefined`, which is how one of its
 * two silences is said: the AUTHOR's file being gone is nothing a learner or a tutor could act
 * on. The other silence, a path that escapes its tree, never reaches here — `learnerDiffFor`
 * answers it before building a `DiffRefusal` at all.
 *
 * The learner's own missing file is NOT one of these: it is `NO_FILE_YET`, the ordinary state
 * of every step in manual mode, and its caller answers it before asking this.
 */
function refusalSentence(refusal: DiffRefusal): string | undefined {
  switch (refusal.reason) {
    case 'gone':
      return undefined; // the AUTHOR's file is not there — a broken plan, and not the learner's to fix
    case 'not-one-file':
      return NOT_ONE_FILE;
    case 'too-big':
      return tooBigToDiff(refusal.bytes);
  }
}

/**
 * The learner's file against the author's, or one of the five "no diff" SENTENCES the header
 * lists, or `undefined` for the two states it says with silence. Never throws: this builds a
 * prompt, and no failure to describe a file is worth refusing to answer a stuck learner's
 * question over.
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

  // Rules 1 and 4, and the order matters: the learner's side is asked FIRST so that "you have
  // not written this yet" — manual mode's ordinary state, and the most useful thing the tutor
  // can be told — is never reported as something else. Everything after this point is two
  // ordinary files, both small enough to hand a subprocess, which is what makes the git call
  // below bounded on disk as well as in memory.
  const learnerRefusal = Outbound.fileToRead(learner);
  if (learnerRefusal?.reason === 'gone') return NO_FILE_YET;
  const refusal = learnerRefusal ?? Outbound.fileToRead(reference);
  if (refusal !== null) return refusalSentence(refusal);

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
    let timedOut = false;
    try {
      stdout = await git(
        ['diff', '--no-index', `--output=${output}`, '--', path.relative(cwd, reference), path.relative(cwd, learner)],
        cwd,
      );
    } catch (err) {
      // Exit 1 — "they differ" — is the case this whole module exists for, and it arrives
      // here as a rejection. What git actually produced is in the output file either way.
      //
      // A rejection because git was STOPPED is the one that must not be read that way (T-13):
      // "they differ" is an answer git gave, and a killed subprocess gave none. Read as exit 1
      // it would hand the model a truncated diff as though it were the whole comparison, or —
      // on the far commoner case of an empty box — return `undefined` and let the tutor answer
      // a stuck learner with no idea it was never shown their work.
      if (gitTimedOut(err)) timedOut = true;
      else exitedZero = false;
    }
    if (timedOut) return DIFF_TIMED_OUT;

    const written = readDiffOutput(output);
    if (written.text.length > 0) return Outbound.diff(written.text, written.bytes, written.whole);
    if (stdout.length > 0) return Outbound.diff(stdout, Buffer.byteLength(stdout, 'utf8'), true);
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
  const learnerDiff = await learnerDiffFor(step, refRoot, target, git);
  // Every field, without exception, and that is the point: `question` and `why` are the two
  // the review measured at five megabytes each, `file` is the one nobody had thought about,
  // and a field added tomorrow that skips this list is the finding again.
  return {
    repo: Outbound.text(path.basename(path.resolve(refRoot)), MAX_PAGE_TEXT),
    file: Outbound.text(step.target.file, MAX_PAGE_TEXT),
    fileMeaning: fileMeaningOf(step),
    stopTitle: Outbound.text(step.decision.question, MAX_PROMPT_TEXT),
    stopText: renderOptionsText(step),
    build: {
      question: Outbound.text(step.decision.question, MAX_PROMPT_TEXT),
      options: Outbound.options(step).options,
      why: Outbound.text(step.decision.why, MAX_PROMPT_TEXT),
      ...(learnerDiff === undefined ? {} : { learnerDiff }),
    },
  };
}
