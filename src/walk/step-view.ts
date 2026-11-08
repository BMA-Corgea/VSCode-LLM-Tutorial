// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The step panel's markup and client script (spec §5.3, AC2, AC5) — pure (no `vscode`),
 * mirroring `src/start/view.ts`'s split exactly: a `PAGE_CSS` sheet, a `bodyHtml()` builder,
 * a `CLIENT_SCRIPT` template literal, and the two functions `src/walk/step-panel.ts` (the
 * real `vscode.WebviewViewProvider`, not written yet) will call. `StepViewState` — the whole
 * input this file renders — is defined in `./step-protocol.ts`, not here: that file also owns
 * `handleStepMessage`, so the message SHAPES this script posts and the shapes the host parses
 * live in one place and cannot drift apart.
 *
 * **The options list is where the learner takes a road (T-21).** The road this step is on is
 * the highlighted row; every other option that a press could name has a real *Choose this
 * instead* button, and the road the step is already on has none. A press records the learner's
 * choice beside the plan, and until the replan (T-22) exists the list says in one line that the
 * rest of the walk has not changed. A step with one option offers nothing — nothing to choose is
 * not drawn as a dead control. What is drawn, and what a press may name, is `optionsTable`'s
 * answer (`./model.ts`), the same one the session accepts by, so a control can never promise what
 * the host would refuse.
 *
 * **Which option IS the author's** is read from `option.taken` FIRST and from `option.id ===
 * decision.authorChoice` as a fallback (T-4 code review, finding 6). repo-tour's own builder
 * keeps the two in agreement — the real 61-step sql-gauntlet plan carries exactly one `taken`
 * on every step — which is why reading only `taken` looked sufficient, and is exactly the trap:
 * a plan from an older builder, a hand-edited one, or one half-migrated by a future schema can
 * carry `authorChoice: 'author'` with no `taken` anywhere. Nothing would then be marked, and AC2
 * ("the author's choice marked among the options") would be silently unmet on a page that still
 * looked perfectly fine. Do not "simplify" the fallback away. It is resolved ONCE, to a single
 * index, rather than tested per option: two options can only both light up if the question is
 * asked twice, and "the author did two of these" is never a true sentence.
 *
 * **Why's source label** is a fixed three-line map, not repo-tour's own `why` text: the ticket
 * pins the exact wording (`interpret` → "from the model, reading the code", `docstring` →
 * "from the author's own comment", `none` → "not inferable from the source"). When
 * `whySource === 'none'`, this can read almost the same as `why` itself, since repo-tour's own
 * `why` value in that case already IS that sentence — confirmed against a real build's plan,
 * not a bug to "fix" by hiding one of the two lines.
 *
 * **The witness fallback text is asserted byte-for-byte** ("no history to show" — see
 * `NO_HISTORY_MESSAGE`) the same way `src/start/request.ts`'s `IDEA_FIRST_MESSAGE` is: a
 * constant, exported, so a test and this file's own rendering can never quote it differently.
 * `FILE_MISSING_MESSAGE` gets the same treatment for the exact reason `problemDiv` exists on
 * the start screen — repo-tour's lesson, restated in this repo's own conventions: "a feature
 * that is not built yet says so where the eye is ... never a disabled button with no
 * explanation." The hint node beside "Open the file" is always present in the markup, empty
 * when there is nothing to say, so nothing ever has to create or remove it.
 *
 * **The dial** reuses `DIALS`/`Dial` from `../start/request.js` (the plan-level `model.ts`
 * already does the same), but needs its OWN `DIAL_LABEL` — `src/start/view.ts`'s copy is a
 * `const`, not exported, and `src/start/**` is out of bounds for this ticket. Duplicating
 * three short lines here is cheaper than widening that file's public surface for one caller.
 * `FALLBACK_DIAL` used to be duplicated the same way and is NOT the same case: it is now
 * imported from `./model.js`, which exports it, because both files sit inside this ticket's
 * own boundary and the `src/start/**` DO-NOT-TOUCH argument above simply does not reach it
 * (T-4 code review, the quality row). Two copies of "what a step with no recorded dial falls
 * back to" is one copy too many the moment a single edit can legitimately reach both. The
 * checked radio comes from `progress.steps[step.id]?.dial`, falling back to that constant
 * exactly like `model.ts`'s own `statusText` does, and for the same reason: a step with no
 * per-step override yet has had nothing done to it, and "manual" is the one answer that can
 * never overstate that.
 *
 * **The caps and the fallbacks below are security fixes. A future reader must not tidy
 * either away.** Both come from T-4's security review, and both defend the same doorway.
 *
 * *The caps — security finding 3 (Medium-Low, confirmed).* `webview.html = renderStepHtml(...)`
 * is a SYNCHRONOUS assignment on the extension host: whatever this function builds, the whole
 * window waits for. Everything it builds from is third-party text — a docstring, a commit
 * subject, a sentence a model wrote while reading someone else's code — and repo-tour caps
 * almost none of it. Its `parseAnswer` clamps `summary` to 400 characters and stops there:
 * `parseAlternatives` keeps every entry the model emitted, at whatever length and in whatever
 * number, and `why` passes through untouched (repo-tour `src/interpret.ts`). So a docstring
 * that prompt-injects the interpreter into emitting thousands of very long options lands
 * unclamped in a `plan.json`. **This is the one T-4 path Workspace Trust does not gate** — the
 * victim never opens the attacker's repo, they paste its URL into the start screen and this
 * extension builds the plan for them, inside their own trusted folder. `MAX_OPTIONS_RENDERED`
 * and `MAX_PLAN_TEXT` bound the work one render can be made to do; both are ANNOUNCED on the
 * page, because a cap that quietly swallowed content would trade a hang for a lie and this
 * codebase does not make that trade. An option not shown is counted in a line under the list
 * (`optionsOmittedMessage`); a string that had to be cut ends in `TRUNCATION_MARKER`. The two
 * numbers are argued at their own declarations, against a real plan's measured sizes.
 *
 * *The fallbacks — security finding 5 (Low, confirmed).* `WHY_SOURCE_LABEL[whySource]` is a
 * lookup TypeScript believes is total and is not. `whySource` is TYPED `WhySource`, but the
 * value arrives from a `JSON.parse` that was cast, so `'nonsense'` yields `undefined`, and
 * `'constructor'`, `'toString'` and `'__proto__'` yield inherited members of
 * `Object.prototype` — a function, a function, an object. All four then throw inside
 * `escapeHtml`, which calls `.replace` on them, from a render, inside a promise the activation
 * path voids: the panel simply never appears and no error reaches anybody. `whySourceLabel`,
 * `planText`, `planId` and `stepDial` below make every such lookup total — own-property only,
 * and type-checked at the VALUE rather than trusted at the key.
 *
 * **The note line and AC5.** `state.note` is the panel's own transient reply text (today,
 * only `step:check`'s honest "arrives with T-5" line) — never part of `progress.json`, never
 * plan data. It is rendered server-side when present, same as everything else on this page,
 * but it ALSO round-trips through the webview's own `getState()`/`setState()` (`restore()`/
 * `save()` from `src/webview/page.ts`'s bootstrap): when a `step:note` message arrives, the
 * script writes it into the node's `textContent` AND saves it, and on the very first tick of a
 * fresh script load it re-applies whatever was last saved. This is deliberately narrow — it
 * exists ONLY so a reply already on screen survives this one view being torn down while
 * hidden (`retainContextWhenHidden: false`) and shown again on the SAME step, per this
 * ticket's AC5. It is not a second source of truth for which step is current, and it is not
 * keyed by step id: the host re-render (which DOES know the current step, and clears `note`
 * on a real navigation — see `step-panel.ts`, not this file) is still the only authority for
 * everything else on the page, exactly as `src/webview/page.ts`'s own doc comment requires.
 *
 * **What T-5 added, and the one way to get it wrong.** Four new things reach this page from
 * the session — the check report (AC5), the manual-mode shape block (AC2), the write note,
 * and the reproduce offer — and every one of them is drawn from `StepViewState` fields that
 * did not exist in T-4. `step-panel.ts` does NOT repaint on every push: it keys repaints on
 * what this file actually draws, so a field rendered here and missing from that key is
 * STORED AND NEVER SHOWN — no test fails, nothing throws, and the button simply looks dead.
 * T-4 kept that key in the panel, one file away from the render it describes, which is
 * exactly the distance a drift needs. It now lives HERE, as `stepRenderKey`, beside the
 * markup it enumerates, so the two are read together and a unit test can prove by mutation
 * that changing a rendered field changes the key. `step-panel.ts` calls it and adds only its
 * own notice/step page choice.
 *
 * **The check report (AC5) leads with the summary, and on a parse failure says nothing else.**
 * `src/dial/check.ts` already composes the one line a learner actually reads; this file draws
 * it prominently and then the per-symbol and per-import detail underneath. A file that did not
 * parse is the exception: repo-tour's `check` finds no symbols in a tree it could not build,
 * so EVERY export comes back `missing` and a "missing" list there would be a confident lie
 * about work that may be entirely correct bar one stray brace. So the parse case renders the
 * core's own `reason` and an honest sentence about why there is no list, and no list.
 *
 * **A report is plan-adjacent, third-party text and is capped like one.** It is derived from
 * the reference repository the learner pointed the build at — the same untrusted source as
 * `why` and the option labels — and a hostile file can declare ten thousand exports as easily
 * as three. `MAX_LIST_ROWS` bounds the rows and `MAX_CHECK_TEXT` the strings inside them,
 * announced the same visible, counted way `MAX_OPTIONS_RENDERED` is (`listOmittedMessage`).
 * Rows are ordered `missing` → `extra` → `present` BEFORE the cut, for the same reason the
 * author's own option survives the options cap: what a learner has to act on must not be the
 * thing a cap drops.
 *
 * **The shape block tells the learner what to write and must never become the answer.** It
 * renders `view.shape` — the signature LINE of each load-bearing range and the reference's
 * import lines — and nothing else. No bodies. It appears only when the session sends one,
 * which it does only in manual mode, so the block's PRESENCE is the mode gate; this file does
 * not re-derive "am I in manual" from the dial, because two places deciding that is how the
 * page ends up disagreeing with what was actually written to disk.
 *
 * **What T-6 added, and the one rule it is built on.** The tutor section under the step (AC2)
 * — the conversation, a box, *Ask* — plus the honest lines AC4 asks for and the escaping rule
 * AC5 is entirely about.
 *
 * *AC5 is a security fix, not a formatting choice.* A model's answer is untrusted text and it
 * is drawn HERE, so this is where it is made safe: every character escaped, ``` fences and
 * NOTHING else honoured as markup, the fence's own language tag discarded rather than put in
 * an attribute. repo-tour's `askpanel.ts` states the same rule for the same reason, and the
 * reason is ordinary rather than exotic — a tutor explaining generics writes angle brackets in
 * the normal course of its work, and a tutor asked about this very panel will quote an
 * `<img onerror=…>` back at the learner. `answerHtml` is where that holds or fails.
 *
 * *A reply is unbounded text and gets the same announced treatment as everything else.*
 * `src/tutor/ask.ts` deliberately does no clipping and says so: clipping belongs next to the
 * escaping. Hence `MAX_REPLY_TEXT` and `MAX_TURNS_RENDERED`, both announced on the page, both
 * argued at their own declarations.
 *
 * *AC4 in one sentence: no spinner is ever left running.* The page's half of that is that the
 * thinking state is DERIVED from `state.tutor.thinking` and never from anything the page keeps
 * for itself, so there is no local flag anyone can forget to clear — and that `thinking` is in
 * `stepRenderKey`, without which the session would clear it and the page would never find out.
 *
 * The client script itself lives inside a TS template literal for the same reason
 * `src/start/view.ts`'s does (repo-tour lesson, T-3, 2026-08-26: a bad escape here ships a
 * page that parses and does nothing) and touches nothing beyond `document.getElementById`,
 * `addEventListener`, `.value`/`.checked`/`.textContent`, and `window`'s `message` event — the
 * same small vocabulary `test/unit/start-view.test.ts`'s fake DOM already fakes, so whoever
 * writes this file's own unit test can build an analogous harness with no surprises.
 */

import type { CheckOutcome } from '../dial/check.js';
import { type SkinsModule } from '../start/view.js';
import { DIALS, type Dial } from '../start/request.js';
import { bridgeCss, pickerHtml, type SkinRow } from '../skins.js';
import { renderPage } from '../webview/page.js';
import { escapeAttr, escapeHtml } from '../webview/html.js';
import type { AskMessage } from '../tutor/core.js';
import { FALLBACK_DIAL, MAX_OPTIONS_RENDERED, optionsTable, type OptionLike, type StepLike, type WhySource } from './model.js';
import { MAX_ASK_TEXT, type StepViewState } from './step-protocol.js';

export { MAX_OPTIONS_RENDERED };

/** What `TutorView.spend` looks like once it has reached the page — named here so the two
 *  functions that read it (`spendHtml` and `stepRenderKey`) share one shape rather than each
 *  spelling out an inline object that could drift from the other. */
type TutorSpendView = NonNullable<NonNullable<StepViewState['tutor']>['spend']>;

/** Verbatim — a test asserts this exact phrase when `step.witness.sha` is `null`. */
export const NO_HISTORY_MESSAGE = 'no history to show';

/** Verbatim — the honest reason "Open the file" is disabled (repo-tour lesson: never a
 *  disabled control with no explanation). Rendered in a node that is always present. */
export const FILE_MISSING_MESSAGE = "you haven't created this file yet";

/** Exactly the mapping the ticket pins — see the file header for why `none` can look like it
 *  duplicates `why` itself sometimes. Not exported: nothing outside this file needs to quote
 *  it, only the rendered text (which a test reads off the markup, same as `DIAL_LABEL` below). */
const WHY_SOURCE_LABEL: Record<WhySource, string> = {
  interpret: 'from the model, reading the code',
  docstring: "from the author's own comment",
  none: 'not inferable from the source',
};

/** What the source line says when the plan names a source this panel has no words for.
 *  Exported so a test asserts the phrase this file really renders, never a copy of it. */
export const UNKNOWN_WHY_SOURCE_MESSAGE = "this plan names a source this panel doesn't recognise";

/**
 * `WHY_SOURCE_LABEL[step.decision.whySource]`, made TOTAL — T-4 security review, finding 5.
 *
 * The plain index looked safe because `whySource` is typed `WhySource`, and it is not: the
 * type is a cast over `JSON.parse`, so the value at run time is whatever `plan.json` said.
 * `'nonsense'` indexes to `undefined`; `'constructor'` and `'toString'` reach
 * `Object.prototype`'s own members and index to FUNCTIONS; `'__proto__'` indexes to an
 * OBJECT. Every one of those four then reaches `escapeHtml`, which calls `.replace` on it and
 * throws — from a render, inside a promise the activation path `void`s, so the failure mode
 * is not an error message, it is a step panel that never appears at all.
 *
 * Hence `Object.hasOwn` rather than `in` or a bare index (inherited members are the whole
 * bug), and a `typeof` check on the VALUE rather than trust in the key's declared type. The
 * fallback names the problem out loud instead of guessing at one of the three real labels:
 * telling a learner "from the author's own comment" about a source we could not read would
 * be a confident lie, and the honest line costs nothing.
 */
function whySourceLabel(source: unknown): string {
  if (typeof source !== 'string' || !Object.hasOwn(WHY_SOURCE_LABEL, source)) return UNKNOWN_WHY_SOURCE_MESSAGE;
  const label: unknown = (WHY_SOURCE_LABEL as Record<string, unknown>)[source];
  return typeof label === 'string' ? label : UNKNOWN_WHY_SOURCE_MESSAGE;
}

/** `src/start/view.ts` keeps the identical three lines as an unexported `const` — duplicated
 *  here rather than exported from there, per this ticket's own boundary (`src/start/**` is
 *  out of bounds). Kept word-for-word the same so the dial reads identically on both screens. */
const DIAL_LABEL: Record<Dial, string> = {
  manual: "I'll type it",
  scaffolded: 'Scaffold it for me',
  automated: 'Watch me build it',
};

/** Exported for the same reason `CHECK_NOTE` and `IDEA_FIRST_MESSAGE` are: a test should
 *  assert the string this page actually uses, never a copy of it that can drift. */
export const AUTHOR_BADGE = 'What the author did';
/** T-21: the learner's own road, once it differs from the author's. */
export const CHOSEN_BADGE = 'Your choice';
/** T-21: the control on every option that is not the road this step is on. */
export const CHOOSE_LABEL = 'Choose this instead';
/** T-21: the line that says a choice has changed nothing else yet (T-22 is the replan). */
export const DIVERGED_NOTE = 'You chose a different road. The rest of the walk still follows the author \u2014 re-planning from your choice isn\u2019t built yet.';

// ── the render caps (T-4 security review, finding 3) ───────────────────────────────────────
// See the file header for the threat: `webview.html = ...` is synchronous on the extension
// host, every string here is third-party, repo-tour caps almost none of it, and this is the
// one path Workspace Trust does not gate. Both numbers are picked to sit far above anything a
// real plan has ever produced, so neither can plausibly cut a learner off mid-sentence, and
// far below anything that could make one render take meaningful time. `MAX_OPTIONS_RENDERED`
// lives in `./model.ts` beside `optionsTable`, the one place that applies it.

/**
 * How many characters of any one plan-sourced string this panel will draw.
 *
 * Measured too, and deliberately generous, because the string most likely to be long is a
 * `why` taken straight from someone's docstring and cutting a real one would be the wrong
 * fix. Across 621 doc comments in the three repos on hand, the median is 146 characters, the
 * 99th percentile 1,814, and the single longest — this file's own header — 5,121. repo-tour's
 * own `SUMMARY_MAX` clamp, the only cap it applies to anything, is 400. So 20,000 is roughly
 * four times the longest real docstring measured, fifty times repo-tour's own clamp, and
 * seventy times the longest `why` in the real plan (279). Nothing honest reaches it.
 *
 * With `MAX_OPTIONS_RENDERED`, this bounds one render at roughly a megabyte of HTML rather
 * than at whatever `plan.json` happened to contain — which is the entire point: bounded.
 */
export const MAX_PLAN_TEXT = 20000;

/** Left exactly where a string was cut, so the page never pretends it showed the whole thing.
 *  Exported: a test asserts the marker this file really appends, not a copy of it. */
export const TRUNCATION_MARKER = '… (cut off here — this text is longer in the plan)';

/** What stands in for a plan string that is not a string at all. Not an error, and not a
 *  silent blank: "there is nothing readable in the plan at this spot" is a true sentence and
 *  a blank line is not. */
export const NOT_TEXT_MESSAGE = '(the plan has nothing readable here)';

/** The line under a capped options list. A COUNT, not a vague "and more" — the learner can
 *  tell from the page how much of the plan this panel decided not to draw. */
export function optionsOmittedMessage(omitted: number): string {
  return `${omitted} more option${omitted === 1 ? '' : 's'} in this plan, not shown here`;
}

/**
 * How many rows any of this page's OTHER lists will draw — the check report's exports and
 * imports (AC5) and the manual-mode shape block's signatures and imports (AC2).
 *
 * A separate number from `MAX_OPTIONS_RENDERED`, because it bounds a completely different
 * population and 24 would fire on honest data. An option list is legitimately three long;
 * an export list is as long as the file's public surface, and measured across the three
 * repos on hand the widest is 28 (`src/start/build.ts` in this extension) with the widest
 * import list 21 (repo-tour's `src/cli.ts`). Capping a report at 24 would therefore tell a
 * learner working on a real barrel module that four of their exports were "not shown here",
 * which is the cap doing harm rather than work. 200 is roughly seven times the widest real
 * file measured and still bounds a hostile report — repo-tour's `check` reports every symbol
 * a tree-sitter parse found, and a generated file can declare tens of thousands — at a size
 * one synchronous `webview.html =` assignment can build without the window noticing.
 */
export const MAX_LIST_ROWS = 200;

/**
 * How many characters of one check-report string this panel will draw.
 *
 * `MAX_PLAN_TEXT`'s 20,000 is sized for prose — a `why` lifted from someone's docstring —
 * and these are not prose: a symbol name is an identifier and an import is a module
 * specifier. The longest exported identifier in the three repos on hand is 26 characters and
 * the longest import specifier 20, so 400 (repo-tour's own `SUMMARY_MAX`, borrowed for the
 * symmetry rather than for any deep reason) is more than ten times what anything honest
 * needs, while keeping a full report's worst case at a few hundred kilobytes rather than the
 * sixteen megabytes `MAX_LIST_ROWS` × `MAX_PLAN_TEXT` would allow. The report's own SUMMARY
 * is prose and keeps the prose cap.
 */
export const MAX_CHECK_TEXT = 400;

/** `optionsOmittedMessage` for every other capped list on the page — same promise (a COUNT,
 *  never a vague "and more"), with the noun the list is actually made of. Exported so a test
 *  asserts the sentence this file renders rather than a copy of it. */
export function listOmittedMessage(omitted: number, noun: string): string {
  return `${omitted} more ${noun}${omitted === 1 ? '' : 's'}, not shown here`;
}

/**
 * Why a check report that failed to PARSE shows no missing list.
 *
 * repo-tour's `check` compares the symbols a tree-sitter parse found, and a file that did not
 * parse yields no symbols at all — so every single export the reference declares comes back
 * `missing`. Rendered, that is a wall of red naming work the learner may have done perfectly,
 * about a file that is one stray brace from correct. The summary already leads with the
 * core's own `reason` (see `src/dial/check.ts`); this line is the page saying out loud why
 * the detail underneath it is absent, rather than leaving a suspiciously empty section.
 */
export const CHECK_PARSE_MESSAGE =
  'nothing below it could be compared: in a file that did not parse every export looks missing, which would not be true';

/** The heading over each half of the report, and over each half of the shape block. Exported
 *  for the same reason every other visible string here is: one home, asserted not copied. */
export const EXPORTS_HEADING = 'Exports';
export const IMPORTS_HEADING = 'Imports';

/** The check report's own heading. Deliberately NOT "Check my work": that phrase is already
 *  on the button three lines above, and a section repeating a button's label reads as the
 *  button rather than as its answer. This one names what the block contains. */
export const CHECK_HEADING = 'What the check found';

/** The shape block's heading (AC2) — an instruction, because that is what the block is. */
export const SHAPE_HEADING = 'What to write';

/**
 * The shape block's own caption (AC2). It is the one line standing between "here is what to
 * write" and "here is the answer", so it says which of the two this is, out loud: the block
 * carries signature LINES and import lines and never a body, and a learner who reads only the
 * caption should not expect one.
 */
export const SHAPE_NOTE_MESSAGE = 'the shape of this file, not its contents — every body is yours to write';

/** What the shape block says when the reference file has neither imports nor load-bearing
 *  signatures to show. Manual mode still owes the learner a sentence: an empty section with a
 *  heading over it reads as a bug, and "there is nothing to describe" is the truth. */
export const SHAPE_EMPTY_MESSAGE = 'this file declares no imports and no load-bearing signatures — there is no shape to show';

/** The offer to copy `plan.reproduce`'s never-taught files (AC6), with the count in it. A
 *  count, again, rather than "some files": the learner is being asked to let this extension
 *  write into their folder, and how much is exactly what they need to decide that. */
export function reproduceOfferMessage(count: number): string {
  return count === 1
    ? '1 file here is generated, vendored or locked — never taught, and not yours to type'
    : `${count} files here are generated, vendored or locked — never taught, and not yours to type`;
}

/** The label on the offer's button. Exported so the test asserts the control the page ships. */
export const REPRODUCE_BUTTON_LABEL = 'Copy them in';

// ── T-6: the tutor (AC2, AC4, AC5) ─────────────────────────────────────────────────────────

/** The section's heading, and the two control labels. Exported like every other visible
 *  string on this page: one home, asserted rather than copied. */
export const TUTOR_HEADING = 'Ask the tutor';
/** T-16: the notice page's heading. True of every notice it heads (no tutorial in this folder;
 *  the core not loaded; this folder's tutorial could not be opened), so it never claims a
 *  cause, or a wait, that the sentence under it does not give. */
export const NOTICE_HEADING = 'No step to show';
export const ASK_BUTTON_LABEL = 'Ask';
export const CANCEL_BUTTON_LABEL = 'Cancel';
/** The retention control's label (code review finding 6). "Forget" rather than "Clear",
 *  because what it does is delete somebody's own words off their own disk and the verb should
 *  say so. */
export const CLEAR_BUTTON_LABEL = 'Forget this conversation';
/** What that button says after one press (T-43, code review F1): it sits on the keyboard route into the box, so one stray key must not delete anybody's words. */
export const CLEAR_CONFIRM_LABEL = 'Press again to forget it';

/**
 * The two speakers, named on the page rather than distinguished by colour alone.
 *
 * Which of them said a thing is the single most important fact about a transcript — the
 * learner is reading a model's claims about their own code, and "this is the part I wrote" has
 * to survive a narrow sidebar, a high-contrast theme and a screen reader. A bubble that relies
 * on an alignment or a background tint says nothing to any of the three.
 */
export const USER_TURN_LABEL = 'You';
export const TUTOR_TURN_LABEL = 'Tutor';
/**
 * T-7 (AC4). A third label, for a turn NEITHER of them said.
 *
 * `AskMessage.kind === 'note'` is the walk's own record — "detour taken: <title>" — stored in
 * the conversation because that is where a learner looks for what happened in it, and kept off
 * the send path by `sentTurns` so no model is ever told the assistant wrote it. Drawing it as
 * a tutor turn would undo half of that: the learner would read a sentence the tutor never
 * said, attributed to the tutor, in the one place on this page where attribution is the whole
 * point. So it is named, and it is styled apart — see `.tutor-turn.turn-note`.
 */
export const NOTE_TURN_LABEL = 'This tutorial';

/** T-7: the second button beside *Ask*, its waiting line, and the way out. Exported like every
 *  other visible string here — one home, asserted rather than copied. */
export const DETOUR_BUTTON_LABEL = 'Show me an unrelated example';
export const DETOUR_WAITING_MESSAGE = 'writing an example…';
export const DETOUR_BACK_LABEL = 'Back to my build';
/**
 * The spec's "regenerate" control (refinement notes; T-7 code review finding 9). Worded as
 * what it DOES rather than as a verb from this codebase's own vocabulary: a learner reading an
 * example that is not landing wants a different one, and "regenerate" is a word about a cache.
 */
export const DETOUR_REGENERATE_LABEL = 'Write a new example';
/** What the second button costs, said where it is offered. `Show me an unrelated example` is
 *  free on a retake and this one never is, and a control that spends money without saying so
 *  is the shape T-6's AC4 rules out by name. */
export const DETOUR_REGENERATE_HINT =
  'Not happy with this example? Writing a new one asks the model again, so it is not free.';

/** Why the button cannot act, when it cannot (conventions.md: never a disabled control with no
 *  explanation). The provider's own sentence is drawn beside it by `tutor.unreachable`; this
 *  is the part that says what the button in particular would have done. */
export const DETOUR_UNREACHABLE_MESSAGE =
  'An unrelated example needs the model, which cannot be reached right now — see above.';

/** What the way out says when the detour belongs to a step the learner has walked away from.
 *  `stepNumber` is 1-based, because it is read by a person. */
export function detourElsewhereMessage(stepNumber: number | undefined): string {
  const where = stepNumber === undefined ? 'another step' : `step ${stepNumber}`;
  return `An unrelated example is open on ${where}.`;
}

/** What the section says before anybody has asked anything about this step. It names what the
 *  tutor can already see, because the commonest first question is one the context has already
 *  answered ("what file am I in?"), and a learner who knows what it was told asks better. */
export const TUTOR_EMPTY_MESSAGE =
  'Nothing asked about this step yet. The tutor is told this step’s question, its options, why the author chose as they did, and how your file differs from theirs.';

/** The placeholder in the box — and the one place the Enter/Shift+Enter rule is stated to the
 *  person it is a rule for. A keyboard shortcut nobody is told about is not a feature. */
export const ASK_PLACEHOLDER = 'Ask about this step — Enter sends, Shift+Enter for a new line';

/** What stands where the button was while an ask is in flight (AC4). Lower case and with the
 *  ellipsis, because it is a state and not a heading. */
export const THINKING_MESSAGE = 'thinking…';

/**
 * What stands there during the PRE-FLIGHT — the availability probe and the diff — before
 * anything has been sent (security review finding 5).
 *
 * The two halves of the wait are different promises. Until the ask is sent nothing has left
 * this machine and nothing is being charged, and calling a fifteen-second `claude --version`
 * "thinking…" would be a small lie told at the exact moment a learner is deciding whether the
 * button worked at all. It ends in an ellipsis and lower case for the same reason
 * `THINKING_MESSAGE` does: it is a state, not a heading.
 */
export const PREPARING_MESSAGE = 'getting ready to ask…';

/**
 * How many turns of one step's conversation this panel draws, newest last.
 *
 * 30 is repo-tour's own number, borrowed on purpose rather than invented: `ask.trimMessages`
 * sends the last thirty turns to the model however many are stored, so what this panel draws
 * is exactly what the tutor can still see. A learner scrolling back past it would be reading
 * conversation the model has already forgotten — and would then ask a follow-up about it and
 * get an answer that made no sense. `src/tutor/transcript.ts` keeps 200 on disk, so nothing is
 * destroyed by this cap; the count of what is not drawn is printed under the log, the same way
 * every other cap on this page announces itself.
 */
export const MAX_TURNS_RENDERED = 30;

/**
 * How many characters of any ONE turn this panel draws.
 *
 * `src/tutor/ask.ts` deliberately does no clipping — it says so in its own header — because
 * clipping belongs next to the escaping, and the escaping is here. A model reply is unbounded
 * text arriving from outside this extension, exactly like a `why` lifted from a stranger's
 * docstring, and `webview.html = renderStepHtml(...)` is still a synchronous assignment the
 * whole window waits for (T-4 security review, finding 3).
 *
 * It is not `MAX_PLAN_TEXT`'s 20,000, and the difference is arithmetic rather than taste: a
 * `why` appears ONCE per render and a turn appears up to `MAX_TURNS_RENDERED` times, so the
 * prose cap would put six hundred thousand characters on one page and the same again into the
 * repaint key that is computed on every push. 4,000 mirrors `MAX_ASK_TEXT` — a question may be
 * four thousand characters and so may its answer be drawn — which is roughly six hundred words,
 * comfortably past any real answer about one tutorial decision, and bounds the whole log at
 * 120,000 characters however large the file on disk is.
 */
export const MAX_REPLY_TEXT = 4000;

/**
 * `TRUNCATION_MARKER`'s counterpart for a turn, and a separate string because it makes a
 * different claim. That one says the text "is longer in the plan"; this text is not in a plan
 * at all — it is what the tutor said, or what the learner asked — and telling somebody their
 * own question is longer in the plan would be a confident piece of nonsense.
 */
export const REPLY_TRUNCATION_MARKER = '… (cut off here — this turn is longer than the panel will draw)';

/** The count under a capped conversation. Older turns are dropped rather than newer ones, so
 *  the sentence says "earlier": a learner who reads it knows which end was cut and that the
 *  turns are still in `progress.json`. */
export function turnsOmittedMessage(omitted: number): string {
  return `${omitted} earlier turn${omitted === 1 ? '' : 's'} in this conversation, not shown here`;
}

/**
 * One plan-sourced string, made safe to BUILD with. (Not safe to INJECT with — that is still
 * `escapeHtml`/`escapeAttr`'s job, and every caller below still escapes.) Two failures, both
 * from the security review, both invisible to `tsc` because `StepLike` is a cast over
 * `JSON.parse` and the compiler has been told these fields are strings:
 *
 *   1. It is not a string (a number, `null`, an object, missing). `.trim()` and `.replace()`
 *      throw on it, from inside a voided activation promise where nothing is listening, and
 *      the panel just never appears (finding 5, the same failure as the `whySource` lookup).
 *      A non-string is not content, so `NOT_TEXT_MESSAGE` says so rather than rendering the
 *      word "undefined" at a learner as though the plan had written it.
 *   2. It is enormous (finding 3 — see `MAX_PLAN_TEXT`, and `MAX_CHECK_TEXT` for the report's
 *      identifiers, which `max` selects — the guard is one function because the two failures
 *      above are one pair of failures whichever string is being drawn). Cut, with `TRUNCATION_MARKER` left
 *      exactly where the cut happened, because a panel that quietly shortened someone's
 *      docstring would be misrepresenting what the plan says. Whoever next reads this: the
 *      marker is the fix, not decoration on it. A silent `.slice()` is the wrong cap.
 */
function planText(value: unknown, max: number = MAX_PLAN_TEXT): string {
  if (typeof value !== 'string') return NOT_TEXT_MESSAGE;
  if (value.length <= max) return value;
  return value.slice(0, max) + TRUNCATION_MARKER;
}

/**
 * The same non-string guard for an id — but no truncation and no stand-in text, on purpose.
 *
 * An id is a KEY, not prose: it rides in `data-step-id`/`data-option-id`, is never read by
 * the learner, and is what the client script keys its saved note by. So `NOT_TEXT_MESSAGE`
 * would be worse than useless there (it would invent a key that could then collide with a
 * real one) and an empty attribute states the truth: this plan gave no id here.
 *
 * Length is deliberately NOT capped. An id appears once per render rather than once per
 * option, so a huge one costs the same O(n) the surrounding `JSON.parse` has already paid —
 * it is not the multiplication finding 3 is about — and cutting one COULD make two distinct
 * steps share a note key, which is a worse bug than the one it would fix.
 */
function planId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Which dial position is checked — `state.dial`, which the SESSION has already resolved
 * (step override → the global one from `request.json` → `manual`; `model.ts`'s `stepDial`).
 *
 * T-4 resolved it here instead, from `progress.steps[step.id]?.dial` alone, and could
 * therefore only ever show the override half of AC1: a learner who set the dial on the start
 * screen and then opened a step they had not touched saw "manual" checked, on a walk that was
 * about to scaffold their files. Reading one already-resolved value is not merely tidier, it
 * is the only way this page and the status bar can agree about what mode the walk is in.
 *
 * Still total, for the reason `whySourceLabel` is (T-4 security review, finding 5): the value
 * has travelled through `progress.json` and `request.json`, both `JSON.parse`d and cast, so
 * `'turbo'` is a value this function can really be handed — and it matches no radio at all,
 * which renders a fieldset with NOTHING checked and no hint that anything was wrong.
 * `FALLBACK_DIAL` catches it: a step whose recorded position is not a position has had
 * nothing done to it, and "manual" is the one answer that can never overstate that.
 */
function resolvedDial(dial: unknown): Dial {
  return DIALS.some((d) => d === dial) ? (dial as Dial) : FALLBACK_DIAL;
}

const PAGE_CSS = `
.notice-only { padding:20px 16px; }
.notice-only .notice { opacity:0.85; margin:0; }
main { max-width:640px; margin:0 auto; padding:20px 24px 40px; }
.step-head { margin-bottom:18px; }
.step-head h1 { font-size:16px; margin:0; }
/* T-41: the skin picker's place. A control used about once does not get the panel's second row. */
.panel-foot { margin-top:20px; }
section { margin-bottom:20px; }
section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 8px; }
.options { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.option { border:1px solid var(--line); border-radius:var(--radius); padding:10px 14px; }
.option-taken { border-color:var(--accent); background:var(--hl); }
.option-label { display:block; font-weight:600; }
.option-consequence { margin:4px 0 0; color:var(--muted); }
.badge { display:inline-block; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; padding:2px 8px; border-radius:999px; margin-bottom:6px; }
.badge-taken, .badge-chosen { background:var(--accent-soft); color:var(--accent); }
.option-choose { margin-top:8px; }
/* T-21: what the last press did, above the rows so a page that has just been drawn shows it
   without a scroll. The refusal takes the note colour, like the write note: it is news. */
.options-outcome { margin:0 0 10px; }
.options-refused { color:var(--kw); font-size:12px; margin:0 0 6px; }
.options-diverged { font-size:12px; margin:0; }
.why-text { margin:0 0 4px; }
.why-source, .witness-text { color:var(--muted); font-size:12px; margin:0; }
/* The honest count under a capped options list — see MAX_OPTIONS_RENDERED. Styled like the
   other muted asides rather than like a warning: nothing has gone wrong, this panel has
   simply decided how much of a very large plan it is willing to draw at once. */
.options-omitted { color:var(--muted); font-size:12px; margin:8px 0 0; }
section h3 { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; margin:12px 0 6px; }
/* One monospace stack, declared once. T-16 (F-07): under System the bridge sheet defines --mono
   as the editor's own font; a named skin has no --mono and keeps this plain stack. */
.check-name, .shape-line { font-family:var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:12px; }
.check-list, .shape-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
.check-row { display:flex; align-items:baseline; gap:8px; }
/* The verdict colours the SUMMARY and nothing else. A red section would read as "everything
   here is wrong" when most of a failing report is rows that are perfectly present, and the
   summary is the line the learner actually reads (src/dial/check.ts's own doc comment). */
.check-summary { font-weight:600; margin:0 0 10px; }
.check-pass { color:var(--str); }
.check-fail { color:var(--kw); }
.check-reason, .check-aside, .shape-note, .list-omitted { color:var(--muted); font-size:12px; margin:0 0 8px; }
.check-status { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; padding:2px 8px; border-radius:999px; background:var(--chip); color:var(--muted); flex:none; }
.check-missing .check-status { background:var(--accent-soft); color:var(--kw); }
.check-kind { color:var(--muted); font-size:12px; }
/* The write note is the session's news about the learner's OWN file — a refused overwrite, a
   kept edit — so it takes the same colour as the open-file hint rather than the muted asides:
   it is the one line on this page about something that just happened to their disk. Note that
   this sheet is inlined into every page, so nothing in these comments may quote a string a
   test asserts the ABSENCE of — a comment is markup here, not commentary. */
.write-note { color:var(--kw); font-size:12px; margin:0 0 14px; }
.reproduce { display:flex; align-items:center; gap:10px; flex-wrap:wrap; color:var(--muted); font-size:12px; margin:18px 0 0; }
fieldset.dial { border:1px solid var(--line); border-radius:var(--radius); padding:10px 14px; margin:0 0 20px; }
fieldset.dial legend { font-weight:600; padding:0 4px; }
fieldset.dial label { display:inline-flex; align-items:center; gap:6px; margin:6px 18px 2px 0; font-weight:400; }
.actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
.open-wrap { display:inline-flex; align-items:center; gap:8px; }
.hint { color:var(--kw); font-size:12px; min-height:14px; }
.note { color:var(--muted); font-size:12px; min-height:14px; }

/* T-6, the tutor. The log is a plain list with a NAMED speaker per row rather than left/right
   bubbles: this page lives in a ~300px sidebar where an alignment cue has no room to read, and
   "who said this" is the one fact a learner must never have to infer about a model's claims
   regarding their own code. The border on the left carries the same distinction a second way,
   for anyone reading in a theme where the muted label is hard to pick out. */
.tutor-log { list-style:none; margin:0 0 12px; padding:0; display:flex; flex-direction:column; gap:10px; }
.tutor-turn { border-left:2px solid var(--line); padding:0 0 0 10px; }
.tutor-turn.turn-user { border-left-color:var(--accent); }
/* T-7: a note is neither speaker. Dashed rather than solid, and the whole row muted, so it
   reads as marginalia in the conversation instead of as something somebody said — which is
   exactly what it is. The LABEL is what carries the distinction for a screen reader and in a
   high-contrast theme; this is the second, visual half of the same fact. */
.tutor-turn.turn-note { border-left-style:dashed; color:var(--muted); font-size:12px; }
.turn-who { display:block; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); margin-bottom:3px; }
/* pre-wrap, so a model's own line breaks survive without this page turning them into markup —
   the whole of AC5 is that a fence and nothing else becomes an element, and a newline is
   presentation rather than structure. (No backticks anywhere in this sheet: it lives inside a
   TS template literal, so one would end the string and ship a page that does not parse.) */
.turn-text { white-space:pre-wrap; }
/* A fenced block is the ONE construct this page renders from a reply. It scrolls inside itself
   rather than widening the panel: code has no wrap opportunities, and overflow-wrap:anywhere
   on an example would break identifiers across lines, which is worse than a scrollbar. */
.turn-text pre.tutor-code { white-space:pre; overflow-x:auto; margin:8px 0; padding:8px 10px; background:var(--chip); border-radius:var(--radius); font-family:var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:12px; }
.tutor-empty { color:var(--muted); font-size:12px; margin:0 0 12px; }
/* The note takes the same colour as the write note — both are news about something that just
   happened, and both are the panel's answer to a control the learner pressed. The unreachable
   line is muted instead: it is a standing condition of their machine, not an event. */
.tutor-note { color:var(--kw); font-size:12px; margin:0 0 8px; }
/* T-7: the detour's own line and its controls sit under the ask, in the same section, because
   they are the second rung of one escalation ladder rather than a feature of their own. */
.detour-note { color:var(--kw); font-size:12px; margin:0 0 8px; }
.detour-open { color:var(--kw); font-size:12px; margin:8px 0 0; }
.detour-hint { color:var(--muted); font-size:12px; margin:0; }
.detour-waiting { color:var(--muted); font-size:12px; }
.tutor-unreachable { color:var(--muted); font-size:12px; margin:0 0 8px; }
.tutor-ask { display:flex; flex-direction:column; gap:8px; }
.tutor-input { width:100%; box-sizing:border-box; font:inherit; font-size:13px; padding:8px 10px; border:1px solid var(--field-edge); border-radius:var(--radius); background:var(--field-bg); color:var(--ink); resize:vertical; }
.tutor-input:focus { outline:1px solid var(--focus); outline-offset:-1px; }
.tutor-input:disabled { opacity:0.6; }
.tutor-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.tutor-thinking { color:var(--muted); font-size:12px; }
/* The live-ask-elsewhere line and the spend line are both news about MONEY, so they take the
   note's colour rather than the muted one: a request that is billing right now, and what this
   walk has paid, are not background information. btn-quiet is a secondary button — the
   controls beside them stop something or delete something, and neither should read as the
   primary action of the section, which is asking. */
.tutor-elsewhere { color:var(--kw); font-size:12px; margin:0 0 8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.tutor-spend { color:var(--kw); font-size:12px; margin:10px 0 0; }
.btn.btn-quiet { font-weight:400; opacity:0.85; }

/* This page lives in a SIDEBAR, and everything on it is someone else's text — a docstring,
   a commit subject, a generated sentence. The real plan already ships a \`why\` that is a
   docstring beginning with a rule of box-drawing characters
   (\`── tokenizer ─────────────────\`), which has no wrap opportunity in it at all and pushes
   the whole panel sideways. Long URLs and long identifiers do the same. \`anywhere\` is the
   right strength here: break mid-token only when there is no other option. */
main, section, .option { min-width:0; }
.step-head h1, .option-label, .option-consequence, .why-text, .why-source, .witness-text,
.note, .hint, .check-summary, .check-reason, .check-aside, .check-name, .shape-line,
.write-note, .reproduce, .turn-text, .tutor-note, .tutor-unreachable, .tutor-empty,
.tutor-elsewhere, .tutor-spend, .detour-note, .detour-open, .detour-hint,
.options-refused, .options-diverged { overflow-wrap:anywhere; }

/* The sidebar is narrow — often ~300px, not the 640px an editor tab gets. Below that, 48px of
   horizontal padding stops eating a sixth of the width. */
@media (max-width: 480px) {
  main { padding:16px 12px 32px; }
  fieldset.dial label { margin-right:12px; }
}

/* T-16, native polish. Additions only, so the rules above read as they did.
   F-03: muted text on the marked option's highlight measured 4.09:1 in Dark Modern. Inside the
   highlight, the consequence takes the full ink colour; the badge, border and background still
   set the marked option apart from the others. Unscoped on purpose: in a named skin, ink on the
   highlight is only ever more contrast. Coupled to the option markup's class names. */
.option-taken .option-consequence { color:var(--ink); }
/* T-44, the owner's call: under System the road this step is on reads as SELECTED, in the
   editor's own words, not as a search hit, which is what the highlight above says. Its
   background is the theme's inactive-selection colour, with the foreground that goes with it.
   The outline is the edge a high-contrast theme asks for: both default high-contrast themes set
   that colour and neither default dark nor light does, and an unset colour draws no outline. No
   fallback to the search colour: a theme with no selection colour marks the row with its edge
   and the blue border instead. A named skin keeps its palette. */
:root:not([data-theme]) .option-taken {
  background:var(--vscode-list-inactiveSelectionBackground);
  color:var(--vscode-list-inactiveSelectionForeground, var(--ink));
  outline:1px solid var(--vscode-contrastActiveBorder);
}
:root:not([data-theme]) .option-taken .option-consequence { color:var(--vscode-list-inactiveSelectionForeground, var(--ink)); }
/* On that row a badge takes the editor's own badge colours and edge, as VS Code's badges do: the
   accent on its translucent fill measured 3.69:1 on the selection background in Dark Modern and
   4.03:1 in Light Modern. The edge keeps its pill's shape in high contrast, where its fill is
   the page's black. */
:root:not([data-theme]) .option-taken .badge { background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); outline:1px solid var(--vscode-contrastBorder); outline-offset:-1px; }
/* F-02: status roles. Under System, --kw and --str resolve to symbolIcon colours that every
   default theme sets to plain foreground, so a pass, a fail and every "news" line rendered as
   body text. The text keeps its colour; a MARKER (a left rule) carries the status, in VS Code's
   own status colours. A named skin keeps its own palette for the marker. */
:root { --status-ok:var(--str); --status-bad:var(--kw); --status-news:var(--accent); }
:root:not([data-theme]) {
  --status-ok:var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-foreground)));
  --status-bad:var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--vscode-foreground)));
  --status-news:var(--vscode-notificationsInfoIcon-foreground, var(--vscode-textLink-foreground, var(--vscode-foreground)));
}
.check-summary { border-left:3px solid transparent; padding-left:8px; }
.check-summary.check-pass { border-left-color:var(--status-ok); }
.check-summary.check-fail { border-left-color:var(--status-bad); }
.check-missing .check-status { outline:1px solid var(--status-bad); outline-offset:-1px; }
/* Under System the missing chip takes the same neutral fill as the others, so the ring alone
   says "missing" (a blue fill under a red ring read as two signals at once). */
:root:not([data-theme]) .check-missing .check-status { background:var(--chip); color:var(--ink); }
/* F-01: a revealed outcome stops short of the panel's edge instead of sitting flush on it. */
#outcome-check, #outcome-tutor, #outcome-detour { scroll-margin:12px 0 16px; }
/* :not(:empty) because the open-file hint is always on the page, empty when the file exists,
   and an empty line must not grow a stray mark. */
.hint:not(:empty), .write-note:not(:empty), .tutor-note:not(:empty), .detour-note:not(:empty),
.detour-open:not(:empty), .tutor-elsewhere:not(:empty), .tutor-spend:not(:empty),
.options-refused:not(:empty), .options-diverged:not(:empty) {
  border-left:2px solid var(--status-news); padding-left:8px;
}
.notice-only h1 { font-size:13px; font-weight:600; margin:0 0 16px; }
/* T-43 (F-08): the input background is the theme's, so its text is too. A named skin keeps its own ink. */
:root:not([data-theme]) .tutor-input { color:var(--vscode-input-foreground, var(--ink)); }
/* The placeholder is the only place the Enter / Shift+Enter rule is written, and the browser's own
   grey measured 2.82:1 on Dark Modern's input background (T-43's visual review). */
:root:not([data-theme]) .tutor-input::placeholder { color:var(--vscode-input-placeholderForeground, var(--muted)); }
/* T-43 (F-09): the foot of the conversation, away from Ask. */
.tutor-foot { margin:0 0 12px; }
/* With Forget gone from the row, the detour button sat flush against Ask. */
.detour { margin-top:8px; }
/* F-11: where in the plan this step sits. */
.step-count { color:var(--muted); font-size:12px; margin:0 0 4px; }
/* F-10: keyboard focus on a code block that scrolls sideways (the script adds the tabindex). */
.turn-text pre.tutor-code:focus-visible { outline:1px solid var(--focus); outline-offset:2px; }
`;

/**
 * The options, as a list the learner can act on (T-21): the road this step is on highlighted, a
 * *Choose this instead* on every other road a press could name, and above them what the last press
 * did: a press can come from any row, and the words have one place the client script can always
 * bring into view (`outcome-choice`), including on a page drawn for a different step (see the
 * stale-press reveal in `CLIENT_SCRIPT`).
 *
 * Three review fixes still live here, and each is load-bearing:
 *
 *   - **The rows, the marked road and every control come from `optionsTable`** (T-4 code review,
 *     finding 6; T-21's reviews). Resolved once, so a plan cannot mark two options, and so the
 *     page never offers what the session would refuse.
 *   - **The list is capped** at `MAX_OPTIONS_RENDERED` (security, finding 3) — and the count of
 *     what is NOT drawn is printed under it. Never delete that line to tidy the markup: the cap is
 *     only defensible because the page admits to it.
 *   - **Nothing here trusts a field's declared type.** `opt.label.trim()` threw on a plan whose
 *     label was not a string, in a render nobody was listening to (security, finding 5).
 *     `planText`/`planId` make every read total.
 */
function optionsHtml(step: StepLike, choiceNote: unknown): string {
  const table = optionsTable(step);

  const items = table.rows
    .map((opt, i) => {
      const isAuthors = i === table.author;
      const isOn = i === table.on;
      const cls = isOn ? 'option option-taken' : 'option option-alt';
      const label = planText(opt?.label);
      const id = planId(opt?.id);
      // The badge is suppressed when it would only repeat the option's own label. That is
      // not a rare tidy-up: a plan built with no interpretation gives every step exactly one
      // option, labelled "What the author did" by repo-tour itself, so the badge said it
      // twice in a row on all 61 steps of the first real plan we rendered. The author's
      // choice is still marked — `.option-taken` carries the accent border and highlight —
      // and the badge comes back the moment a plan has options whose labels differ.
      const authorBadge = isAuthors && label.trim().toLowerCase() !== AUTHOR_BADGE.toLowerCase()
        ? `<span class="badge badge-taken">${AUTHOR_BADGE}</span>`
        : '';
      const chosenBadge = isOn && table.diverged ? `<span class="badge badge-chosen">${CHOSEN_BADGE}</span>` : '';
      const choose = table.choosable[i] === true
        ? `<button type="button" class="btn option-choose" id="choose-${i}" data-option-id="${escapeAttr(id)}">${CHOOSE_LABEL}</button>`
        : '';
      return `<li class="${cls}" data-option-id="${escapeAttr(id)}">${authorBadge}${chosenBadge}<span class="option-label">${escapeHtml(label)}</span><p class="option-consequence">${escapeHtml(planText(opt?.consequence))}</p>${choose}</li>`;
    })
    .join('');

  const omittedNote = table.omitted > 0
    ? `<p class="options-omitted">${escapeHtml(optionsOmittedMessage(table.omitted))}</p>`
    : '';
  const refusedNote = typeof choiceNote === 'string' && choiceNote !== ''
    ? `<p class="options-refused" id="choice-note" role="note">${escapeHtml(planText(choiceNote))}</p>`
    : '';
  const divergedNote = table.diverged ? `<p class="options-diverged" role="note">${escapeHtml(DIVERGED_NOTE)}</p>` : '';
  const outcome = refusedNote !== '' || divergedNote !== ''
    ? `<div class="options-outcome" id="outcome-choice">${refusedNote}${divergedNote}</div>`
    : '';
  return `${outcome}<ul class="options">${items}</ul>${omittedNote}`;
}

/** `NO_HISTORY_MESSAGE`, verbatim, when there is nothing to show — gated on `sha`, matching
 *  how a real build with no interpretation ever populates this triple (see `model.ts`'s own
 *  `WhySource` doc comment and this ticket's handoff: every field of `witness` is `null`
 *  together, never just one). Otherwise a short, readable sentence — no format here is pinned
 *  by the ticket beyond the null case, so this stays a plain, honest rendering of what's there. */
function witnessSentence(witness: StepLike['witness'] | null | undefined): string {
  // `typeof === 'string'` rather than a bare truthiness test (security, finding 5): a `sha`
  // that is a number, an object, or missing entirely used to reach `.slice()` and throw out
  // of a render nobody was listening to. A witness with no USABLE sha has nothing to show,
  // which is precisely what NO_HISTORY_MESSAGE already says — no new sentence needed.
  if (!witness || typeof witness.sha !== 'string' || witness.sha === '') return NO_HISTORY_MESSAGE;
  // `subject` and `date` are genuinely `null` on every step of a real uninterpreted plan, so
  // the `??` is the normal path, not a guard; `planText` then covers the abnormal one — a
  // non-string, or a commit subject long enough to matter (security, finding 3).
  const subject = planText(witness.subject ?? 'no message');
  const shortSha = witness.sha.slice(0, 7);
  const date = witness.date === null || witness.date === undefined ? '' : planText(witness.date);
  return date === '' ? `${subject} — ${shortSha}` : `${subject} — ${shortSha} (${date})`;
}

function dialFieldset(current: Dial): string {
  const inputs = DIALS.map((d) => {
    const checked = d === current ? ' checked' : '';
    return `<label><input type="radio" name="dial" id="dial-${d}" value="${d}"${checked}> ${escapeHtml(DIAL_LABEL[d])}</label>`;
  }).join('');
  return `<fieldset class="dial"><legend>How much do you want to type?</legend>${inputs}</fieldset>`;
}

/** Always present, beside the button it explains — `problemDiv`'s pattern in
 *  `src/start/view.ts`, restated: never a disabled control with no reason given. */
function openFileHint(fileExists: boolean): string {
  return `<span class="hint" id="open-hint">${fileExists ? '' : escapeHtml(FILE_MISSING_MESSAGE)}</span>`;
}

// ── the check report (AC5) ─────────────────────────────────────────────────────────────────

/**
 * The three statuses repo-tour's `check` reports, and the CLASS each one gets.
 *
 * A map to a fixed class name, never the status interpolated into the attribute. `report`
 * crosses a duck-typed boundary (`src/dial/core.ts`) from a core loaded at run time, so
 * `status` is whatever that module put there — and `class="check-${status}"` on a status of
 * `a" onclick="…` is an attribute injection that `escapeHtml` on the surrounding text would
 * never see. Naming the three classes here means no untrusted string ever reaches a class
 * attribute at all.
 */
const CHECK_STATUS_CLASS: Record<string, string> = {
  missing: 'check-missing',
  extra: 'check-extra',
  present: 'check-present',
};

/** What a row whose status this panel has no words for is labelled. Not an error and not a
 *  blank: a row exists, we simply cannot say which of the three it is. */
export const UNKNOWN_CHECK_STATUS_MESSAGE = 'unrecognised';

/**
 * Sort order for a report's rows: what the learner must ACT on first, then what is merely
 * interesting, then the bulk.
 *
 * This is not cosmetic — it is what makes `MAX_LIST_ROWS` safe. A file with three hundred
 * present exports and one missing one would, in report order, push the missing row past the
 * cap and render a page that says "every part is there" nowhere and names the one thing that
 * is not, nowhere either. The same reasoning as `optionsHtml`'s "AC2 outranks the cap": a cap
 * may drop rows, but never the row the acceptance criterion is about. Extras rank above
 * present because they are news (repo-tour's `compare` never fails on one, so a learner
 * seeing an extra listed learns their helper is safe); an unrecognised status ranks last
 * because today's core cannot produce one at all.
 */
function checkStatusRank(status: unknown): number {
  if (status === 'missing') return 0;
  if (status === 'extra') return 1;
  if (status === 'present') return 2;
  return 3;
}

function checkStatusLabel(status: unknown): string {
  return typeof status === 'string' && Object.hasOwn(CHECK_STATUS_CLASS, status)
    ? status
    : UNKNOWN_CHECK_STATUS_MESSAGE;
}

function checkStatusClass(status: unknown): string {
  if (typeof status !== 'string' || !Object.hasOwn(CHECK_STATUS_CLASS, status)) return 'check-unknown';
  const cls: unknown = CHECK_STATUS_CLASS[status];
  return typeof cls === 'string' ? cls : 'check-unknown';
}

/**
 * One half of the report — the symbols, or the imports — sorted news-first, capped, and
 * honest about what the cap left out.
 *
 * `rows` is deliberately typed loosely and read defensively at every field: everything here
 * arrives from a core this extension duck-types rather than compiles against, so `symbols`
 * being an array at all, and each row being an object with the fields its type claims, are
 * run-time questions and not compile-time ones. Nothing throws; a row with nothing readable
 * in it renders `NOT_TEXT_MESSAGE`, which is a true statement about that row.
 */
function checkListHtml(rows: unknown, noun: string, kindField: boolean): string {
  const all = Array.isArray(rows) ? (rows as unknown[]) : [];
  if (all.length === 0) return '';

  const ordered = [...all].sort((a, b) => checkStatusRank(rowField(a, 'status')) - checkStatusRank(rowField(b, 'status')));
  const shown = ordered.slice(0, MAX_LIST_ROWS);
  const omitted = ordered.length - shown.length;

  const items = shown
    .map((row) => {
      const status = rowField(row, 'status');
      // `raw` for an import, `name` for a symbol — one row shape reads whichever it has, so
      // this function serves both halves rather than being written twice.
      const primary = kindField ? rowField(row, 'name') : rowField(row, 'raw');
      const kind = kindField
        ? `<span class="check-kind">${escapeHtml(planText(rowField(row, 'kind'), MAX_CHECK_TEXT))}</span>`
        : '';
      return `<li class="check-row ${checkStatusClass(status)}"><span class="check-status">${escapeHtml(checkStatusLabel(status))}</span><code class="check-name">${escapeHtml(planText(primary, MAX_CHECK_TEXT))}</code>${kind}</li>`;
    })
    .join('');

  const omittedNote = omitted > 0
    ? `<p class="list-omitted">${escapeHtml(listOmittedMessage(omitted, noun))}</p>`
    : '';
  const heading = kindField ? EXPORTS_HEADING : IMPORTS_HEADING;
  return `<h3>${escapeHtml(heading)}</h3><ul class="check-list">${items}</ul>${omittedNote}`;
}

/** One field off a row that is only BELIEVED to be an object — `undefined` for anything that
 *  is not, which `planText`/`checkStatusLabel` then turn into an honest stand-in. */
function rowField(row: unknown, field: string): unknown {
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[field] : undefined;
}

/**
 * *Check my work*'s answer, drawn (AC5).
 *
 * The summary first and on its own line, because `src/dial/check.ts` composed it to carry the
 * whole finding for someone who reads nothing else; then present / missing / extra per symbol
 * and per import underneath it.
 *
 * **Except on a parse failure**, which leads with the core's own `reason` and shows no lists
 * at all — see `CHECK_PARSE_MESSAGE` for why a "missing" list about a file that did not parse
 * is a lie. The reason is rendered again here only when it is not already the summary
 * (`summarize` leads with it, so usually it is); this file re-derives nothing and simply
 * declines to say the same sentence twice.
 */
function checkHtml(outcome: CheckOutcome): string {
  const report = outcome.report;
  const summary = planText(outcome.summary);
  const ok = report.ok === true;
  const summaryHtml = `<p class="check-summary ${ok ? 'check-pass' : 'check-fail'}">${escapeHtml(summary)}</p>`;

  // A number, checked as one: `parseErrors` crosses the same duck-typed boundary as the rows,
  // and `NaN > 0` is false while `'3' > 0` is true — neither is an answer worth acting on.
  const parseErrors = typeof report.parseErrors === 'number' && Number.isFinite(report.parseErrors) ? report.parseErrors : 0;
  if (parseErrors > 0) {
    const reason = typeof report.reason === 'string' ? report.reason : '';
    const reasonHtml = reason === '' || reason === outcome.summary
      ? ''
      : `<p class="check-reason">${escapeHtml(planText(reason))}</p>`;
    return `<section class="check" id="outcome-check"><h2>${escapeHtml(CHECK_HEADING)}</h2>${summaryHtml}${reasonHtml}<p class="check-aside">${escapeHtml(CHECK_PARSE_MESSAGE)}</p></section>`;
  }

  const symbols = checkListHtml(report.symbols, 'export', true);
  const imports = checkListHtml(report.imports, 'import', false);
  return `<section class="check" id="outcome-check"><h2>${escapeHtml(CHECK_HEADING)}</h2>${summaryHtml}${symbols}${imports}</section>`;
}

// ── the manual-mode shape block (AC2) ──────────────────────────────────────────────────────

/** One list of source LINES — imports, or signatures. Capped and counted like everything else
 *  on this page; `planText` keeps the prose cap here rather than `MAX_CHECK_TEXT`'s, because a
 *  real generic signature line runs long in a way an identifier never does. */
function shapeListHtml(heading: string, lines: unknown, noun: string): string {
  const all = Array.isArray(lines) ? (lines as unknown[]) : [];
  if (all.length === 0) return '';
  const shown = all.slice(0, MAX_LIST_ROWS);
  const omitted = all.length - shown.length;
  const items = shown.map((line) => `<li><code class="shape-line">${escapeHtml(planText(line))}</code></li>`).join('');
  const omittedNote = omitted > 0
    ? `<p class="list-omitted">${escapeHtml(listOmittedMessage(omitted, noun))}</p>`
    : '';
  return `<h3>${escapeHtml(heading)}</h3><ul class="shape-list">${items}</ul>${omittedNote}`;
}

/**
 * What the learner has to write, in manual mode and only in manual mode (AC2) — imports
 * first, then signatures, which is the order a file is written in.
 *
 * It shows LINES the session read off the reference, never bodies, and says so in its own
 * caption: the whole premise of manual mode is that the extension writes nothing, and a block
 * that quietly grew into the finished file would defeat the position of the dial the learner
 * deliberately chose. Whoever extends this: adding "and here is the body" is not a feature.
 */
function shapeHtml(shape: NonNullable<StepViewState['shape']>): string {
  const imports = shapeListHtml(IMPORTS_HEADING, shape.imports, 'import');
  const signatures = shapeListHtml(EXPORTS_HEADING, shape.signatures, 'signature');
  const body = imports === '' && signatures === ''
    ? `<p class="check-aside">${escapeHtml(SHAPE_EMPTY_MESSAGE)}</p>`
    : `<p class="shape-note">${escapeHtml(SHAPE_NOTE_MESSAGE)}</p>${imports}${signatures}`;
  return `<section class="shape"><h2>${escapeHtml(SHAPE_HEADING)}</h2>${body}</section>`;
}

// ── the write note, and the reproduce offer (AC6) ──────────────────────────────────────────

/**
 * What the dial just did to the learner's own file — refused to overwrite, kept theirs, wrote
 * over it — where the eye already is, in the run of the page rather than in a toast that has
 * since vanished (conventions.md: a surface that can have something to say, says it).
 *
 * Rendered only when there is really a sentence: unlike `#step-note` this node is not written
 * by the client script, so an always-present empty one would serve nobody and would put an
 * empty paragraph's margin under the dial on every ordinary step.
 */
function writeNoteHtml(note: unknown): string {
  if (typeof note !== 'string' || note === '') return '';
  return `<p class="write-note" id="write-note">${escapeHtml(planText(note))}</p>`;
}

/**
 * The one-line offer to copy `plan.reproduce`'s never-taught files (AC6).
 *
 * Gated three ways, and all three matter. No `reproduce` at all means the session has not
 * worked out whether there is anything to copy; a count that is not a positive, finite number
 * means the plan said something unusable and offering "NaN files" would be worse than
 * offering nothing; and `done` — anything truthy, not only `true`, because the conservative
 * direction here is to under-offer — means it has already happened. Once done, no offer: an
 * offer that stays on the page after being taken invites a second press that either copies
 * over the learner's edits or does nothing, and neither is a good answer to a button.
 */
function reproduceHtml(offer: StepViewState['reproduce']): string {
  if (!offer || offer.done) return '';
  const count = offer.count;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return '';
  const message = reproduceOfferMessage(Math.floor(count));
  return `<p class="reproduce" id="reproduce-offer"><span>${escapeHtml(message)}</span><button type="button" class="btn" id="btn-reproduce">${escapeHtml(REPRODUCE_BUTTON_LABEL)}</button></p>`;
}

// ── T-6: the tutor section (AC2, AC4) and its escaping rule (AC5) ──────────────────────────

/**
 * One turn's text, capped and marked — `planText`'s job for a string that did not come from a
 * plan. Separate rather than a fourth `max` argument to that function because the STAND-IN and
 * the MARKER both have to differ: a turn that is somehow not a string is not "the plan has
 * nothing readable here", it is a transcript entry that should never have survived
 * `sanitizeTranscript`, and saying so out loud is how anyone would ever find that out.
 *
 * The non-string branch is genuinely unreachable through the session — `getTranscript` drops
 * any entry whose `content` is not a string, and `WalkView.transcript` is typed from its
 * output — and it is here anyway for the reason every other total lookup on this page is: the
 * type is a promise made by a function, `renderStepHtml` is also called by tests and by
 * `test/walk.test.ts` with hand-built states, and a `.slice` on `undefined` inside a render
 * throws out of a voided activation promise where the only symptom is a panel that never
 * appears.
 */
function replyText(value: unknown): string {
  if (typeof value !== 'string') return '(this turn holds nothing readable)';
  if (value.length <= MAX_REPLY_TEXT) return value;
  return value.slice(0, MAX_REPLY_TEXT) + REPLY_TRUNCATION_MARKER;
}

/**
 * **AC5, and it is the security one: a model's answer is untrusted text.**
 *
 * repo-tour's `src/askpanel.ts` states the rule and this is the same rule, moved server-side:
 * escape everything, and honour ``` fences and NOTHING else as markup. The threat is not
 * hypothetical and is not about a malicious model in particular — it is about ANY text a model
 * emits. A tutor answering "why does `<T>` need a constraint?" writes angle brackets in the
 * ordinary course of its work, and a tutor asked about this very panel will happily quote
 * `<img onerror=...>` back at a learner reading about escaping. If that reached the page as
 * markup it would execute inside a webview holding this extension's `postMessage` bridge.
 *
 * Three properties make the rule hold, and each is a line somebody could delete:
 *
 *   1. **Every character of `text` passes through `escapeHtml` exactly once.** The slices
 *      between fences are escaped; the body inside each fence is escaped; the tail after the
 *      last fence is escaped. There is no branch that emits a substring raw.
 *   2. **The fence's INFO STRING is discarded, not rendered.** ```` ```js ```` produces a
 *      bare `<pre class="tutor-code">` — the language is never interpolated into a class, an
 *      attribute or anything else. An attribute injection is precisely the hole that escaping
 *      the surrounding TEXT would not close (the same reasoning as `CHECK_STATUS_CLASS`), and
 *      the cheapest way to have no such hole is to have no such attribute.
 *   3. **An unclosed fence is not a fence.** The pattern requires the closing ```` ``` ````,
 *      so a reply that opens one and stops stays entirely escaped text. That is the safe
 *      direction: the failure of a "helpful" version that closed the fence for you is a `<pre>`
 *      swallowing the rest of the answer, and the failure of this one is a visible ```` ``` ````
 *      in the prose.
 *
 * The cap is applied BEFORE the scan, deliberately. A cut that lands inside a fence leaves its
 * closer behind and the fence stops being one, so the tail renders as escaped text rather than
 * as markup — again the safe direction — and the marker that says the text was cut can never
 * end up inside a `<pre>` pretending to be part of the code.
 *
 * Nothing else is markup. No bold, no links, no lists, no inline `code` spans. The rule is
 * deliberately the narrowest one that keeps a code example readable, because every construct
 * added here is another parser between a model's output and a learner's webview.
 */
function answerHtml(text: unknown): string {
  const source = replyText(text);
  // Local to the call: a `g`-flagged regex carries `lastIndex` between uses, and a shared one
  // would make the second turn on a page start scanning where the first left off.
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let out = '';
  let pos = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(source)) !== null) {
    out += escapeHtml(source.slice(pos, match.index));
    out += `<pre class="tutor-code">${escapeHtml(match[1] ?? '')}</pre>`;
    pos = match.index + match[0].length;
  }
  return out + escapeHtml(source.slice(pos));
}

/**
 * The conversation so far (AC2) — one `<li>` per turn, each naming who spoke.
 *
 * The tail rather than the head is what survives the cap, which is the opposite of every other
 * capped list on this page and is right for the same reason those are: what a learner has to
 * act on must not be the thing the cap drops. In an options list that is the author's own
 * choice; in a conversation it is the last thing said. `optionsHtml`'s cap keeps the marked
 * option by moving it into the window, and this one keeps the newest turns by taking the window
 * from the other end — same rule, different end of the list.
 */
function transcriptHtml(turns: AskMessage[]): string {
  const all = Array.isArray(turns) ? turns : [];
  if (all.length === 0) return `<p class="tutor-empty">${escapeHtml(TUTOR_EMPTY_MESSAGE)}</p>`;

  const shown = all.slice(-MAX_TURNS_RENDERED);
  const omitted = all.length - shown.length;
  const omittedNote = omitted > 0
    ? `<p class="list-omitted">${escapeHtml(turnsOmittedMessage(omitted))}</p>`
    : '';

  const items = shown
    .map((turn) => {
      // The role picks between two FIXED class names and two fixed labels — never interpolated,
      // for the reason `CHECK_STATUS_CLASS` exists: `transcript` reaches this page from
      // `progress.json`, and `class="turn-${role}"` on a role of `a" onclick="…` is an
      // attribute injection that escaping the surrounding text would never see. Anything that
      // is not one of the two known roles is drawn as the tutor's, which is the conservative
      // direction: mislabelling the learner's own words as the model's costs a moment of
      // confusion, while labelling a model's words as the learner's own would hand a stranger's
      // sentence the authority of something they wrote themselves.
      //
      // T-7 adds a THIRD case ahead of the other two, and its order matters: a note is stored
      // with `role: 'assistant'` (that is what `sanitizeTranscript` allow-lists), so asking
      // about the role first would draw it as something the tutor said — the one attribution
      // this page may not get wrong. `kind` is compared against the literal `'note'`, never
      // interpolated, for the reason the roles are not: it reaches this page from
      // `progress.json`.
      const isNote = turn?.kind === 'note';
      const mine = !isNote && turn?.role === 'user';
      const klass = isNote ? 'turn-note' : mine ? 'turn-user' : 'turn-tutor';
      const who = isNote ? NOTE_TURN_LABEL : mine ? USER_TURN_LABEL : TUTOR_TURN_LABEL;
      return `<li class="tutor-turn ${klass}">`
        + `<span class="turn-who">${escapeHtml(who)}</span>`
        // A note is the WALK's own sentence, not a model's, so it is escaped and drawn FLAT —
        // no fence pass. `answerHtml` honours ``` because a tutor writes code in the normal
        // course of its work; a note is `detour taken: <title>`, whose only variable part is a
        // model-authored TITLE, and letting a title open a `<pre>` would hand a string a
        // formatting capability for no reason at all. Both arms escape everything (AC5); they
        // differ only in whether one construct survives that escaping.
        + `<div class="turn-text">${isNote ? escapeHtml(replyText(turn?.content)) : answerHtml(turn?.content)}</div>`
        + '</li>';
    })
    .join('');

  return `${omittedNote}<ul class="tutor-log">${items}</ul>`;
}

/**
 * The whole tutor section: the conversation, the honest lines about it, and either an input
 * with *Ask* or "thinking…" with *Cancel* (ACs 2, 4).
 *
 * **The controls are swapped, not disabled, and that is AC4's shape rather than a style
 * choice.** While an ask is in flight there is no `#btn-ask` in the markup at all — the same
 * "a control that was never rendered cannot be pressed by accident" argument the options list
 * makes — and the textarea is `disabled` with `thinking…` written beside it, which is the
 * explanation this codebase requires next to every disabled control. When nothing is in flight
 * there is no `#btn-cancel`, because there is nothing to cancel and a button that would do
 * nothing is worse than no button.
 *
 * **An unreachable provider does not take the input away.** The reason goes where the input is
 * and the box stays exactly where it was (the ticket's own wording: "the panel shows the reason
 * where the input is and disables nothing silently"). A learner who installs `claude` in the
 * next terminal over should be able to press *Ask* again without reloading the window, and a
 * box that had vanished would tell them the feature was gone rather than that a binary was
 * missing.
 *
 * The section is drawn on EVERY step, with or without a `tutor` block, because "you can ask
 * about this" is true of every step. A missing block is read as nothing in flight — the same
 * total-lookup discipline the rest of this file uses, since `state` crosses a `JSON.parse`d
 * boundary in tests and a hand-built state in `test/walk.test.ts`.
 */
function tutorHtml(state: StepViewState): string {
  const tutor = state.tutor;
  const thinking = tutor?.thinking === true;

  const unreachable = typeof tutor?.unreachable === 'string' && tutor.unreachable !== ''
    ? `<p class="tutor-unreachable">${escapeHtml(planText(tutor.unreachable, MAX_CHECK_TEXT))}</p>`
    : '';
  const note = typeof tutor?.note === 'string' && tutor.note !== ''
    ? `<p class="tutor-note" id="tutor-note">${escapeHtml(planText(tutor.note))}</p>`
    : '';

  // `maxlength` is the browser's half of `MAX_ASK_TEXT`: it stops a learner AT the cap instead
  // of letting them write past it and be told afterwards. The host's half
  // (`handleStepMessage`) is not redundant — a `maxlength` is a courtesy to a person and never
  // a guarantee about a value arriving from a webview.
  //
  // `data-accepted` is the host telling this page which question it really SENT (code review
  // findings 1 and 2). The script keeps the learner's draft until it matches — see
  // `CLIENT_SCRIPT` — so a refusal decided after the press leaves the question in the box. It
  // is the learner's own text going into an attribute, so `escapeAttr` rather than
  // `escapeHtml`: this is the one place on this page where a `"` would matter.
  const accepted = typeof tutor?.accepted === 'string' && tutor.accepted !== ''
    ? ` data-accepted="${escapeAttr(planText(tutor.accepted, MAX_ASK_TEXT))}"`
    : '';
  const input = `<textarea class="tutor-input" id="tutor-input" rows="3" maxlength="${MAX_ASK_TEXT}"`
    + ` placeholder="${escapeAttr(ASK_PLACEHOLDER)}"${accepted}${thinking ? ' disabled' : ''}></textarea>`;

  const controls = thinking
    ? `<span class="tutor-thinking" id="tutor-thinking">${escapeHtml(waitingMessage(tutor?.stage))}</span>`
      + `<button type="button" class="btn" id="btn-tutor-cancel">${escapeHtml(CANCEL_BUTTON_LABEL)}</button>`
    : `<button type="button" class="btn" id="btn-tutor-ask">${escapeHtml(ASK_BUTTON_LABEL)}</button>`;

  return `<section class="tutor"><h2>${escapeHtml(TUTOR_HEADING)}</h2>`
    + transcriptHtml(state.transcript)
    + note
    + unreachable
    + elsewhereHtml(state)
    // After the lines about the conversation, so a failed question's reason stays next to it.
    + (thinking ? '' : clearButtonHtml(state))
    + `<div class="tutor-ask" id="outcome-tutor">${input}<div class="tutor-controls">${controls}</div></div>`
    + spendHtml(tutor?.spend)
    + detourHtml(state)
    + '</section>';
}

/**
 * T-7: *Show me an unrelated example*, and the way back from one.
 *
 * **Inside the tutor section, under *Ask*, and that is the spec's own shape**: an escalation
 * ladder rather than two unrelated features. A learner who cannot follow the explanation asks;
 * a learner the explanation is not reaching gets shown the same idea somewhere else entirely.
 * Putting the second rung in its own section would make it look like an alternative to the
 * first rather than the next thing to try.
 *
 * **The button is on every step, always** (the spec: "visible always, honest when
 * unreachable"). It is never removed and never silently inert:
 *
 *   - while an example is being written it is REPLACED by a sentence and *Cancel*, which is
 *     the shape *Ask* already uses for the same state and for the same reason — a control that
 *     was never rendered cannot be pressed by accident, and the press that stops it has to be
 *     on the page;
 *   - while an example is OPEN it is replaced by *Back to my build*, because that is the only
 *     thing a learner in a detour wants from this panel, and offering a second example on top
 *     of the first would be offering to lose their place;
 *   - when the provider cannot be reached it stays exactly where it is, with the reason under
 *     it. `tutor.unreachable` already carries the provider's own sentence a few lines up;
 *     `DETOUR_UNREACHABLE_MESSAGE` is the part that says what THIS button would have done. A
 *     box that vanished would tell somebody the feature was gone rather than that a binary was
 *     missing — the identical argument the ask input's own comment makes.
 *
 * A detour open on ANOTHER step names that step and still offers the way out, exactly as
 * `elsewhereHtml` does for a live ask: a control that names something it cannot act on is the
 * one thing this repository's conventions rule out, and the session's return works from
 * wherever the learner is standing.
 */
function detourHtml(state: StepViewState): string {
  const detour = state.detour;
  const open = detour?.open;

  const note = typeof detour?.note === 'string' && detour.note !== ''
    ? `<p class="detour-note" id="detour-note">${escapeHtml(planText(detour.note))}</p>`
    : '';

  if (open) {
    const here = open.stepId === state.step.id;
    const steps = Array.isArray(state.plan.steps) ? state.plan.steps : [];
    const index = steps.findIndex((step) => step?.id === open.stepId);
    const where = here
      ? ''
      : `<p class="detour-hint">${escapeHtml(detourElsewhereMessage(index >= 0 ? index + 1 : undefined))}</p>`;
    // *Write a new example* is offered only where the learner is standing in the example it
    // would replace — on THIS step, with a detour open. Its presence is a pure function of
    // `state.step.id` and `open.stepId`, both already in `stepRenderKey`, so it adds no field
    // to the key and no mutation to its sweep.
    const regenerate = here
      ? `<button type="button" class="btn btn-quiet" id="btn-detour-regenerate">${escapeHtml(DETOUR_REGENERATE_LABEL)}</button>`
      : '';
    const cost = here ? `<p class="detour-hint">${escapeHtml(DETOUR_REGENERATE_HINT)}</p>` : '';
    return '<div class="detour" id="outcome-detour">'
      + note
      + where
      + `<p class="detour-open">${escapeHtml(planText(open.title, MAX_CHECK_TEXT))}</p>`
      + `<div class="tutor-controls"><button type="button" class="btn" id="btn-detour-back">${escapeHtml(DETOUR_BACK_LABEL)}</button>`
      + regenerate
      + '</div>'
      + cost
      + '</div>';
  }

  if (detour?.generating === true) {
    return '<div class="detour" id="outcome-detour">'
      + note
      + `<div class="tutor-controls"><span class="detour-waiting" id="detour-waiting">${escapeHtml(DETOUR_WAITING_MESSAGE)}</span>`
      + `<button type="button" class="btn" id="btn-tutor-cancel-detour">${escapeHtml(CANCEL_BUTTON_LABEL)}</button></div>`
      + '</div>';
  }

  const unreachable = typeof state.tutor?.unreachable === 'string' && state.tutor.unreachable !== ''
    ? `<p class="detour-hint">${escapeHtml(DETOUR_UNREACHABLE_MESSAGE)}</p>`
    : '';
  return '<div class="detour" id="outcome-detour">'
    + note
    + `<div class="tutor-controls"><button type="button" class="btn btn-quiet" id="btn-detour-start">${escapeHtml(DETOUR_BUTTON_LABEL)}</button></div>`
    + unreachable
    + '</div>';
}

/**
 * *Forget this conversation* — but only when there is one (code review finding 6).
 *
 * The control is absent rather than disabled on a step nobody has asked about, which is the
 * same "a control that was never rendered cannot be pressed by accident" rule the options list
 * and *Cancel* follow. It is also absent while an ask is in flight: deleting the conversation
 * a question is at that moment being answered into is a race with nothing to gain, and *Cancel*
 * is the control that belongs there.
 */
function clearButtonHtml(state: StepViewState): string {
  const turns = Array.isArray(state.transcript) ? state.transcript.length : 0;
  if (turns === 0) return '';
  // At the foot of the conversation, not in the row with *Ask* (T-43, F-09): a control that deletes
  // somebody's own words does not belong beside the one they press most.
  return `<div class="tutor-foot"><button type="button" class="btn btn-quiet" id="btn-tutor-clear">${escapeHtml(CLEAR_BUTTON_LABEL)}</button></div>`;
}

/**
 * A live ask on a step the learner is not looking at, with a control that really stops it
 * (code review finding 3).
 *
 * The old page said "press Cancel" on a step whose markup has no *Cancel* in it: `thinking` is
 * per-step, so navigating away mid-ask left a billing request with no control anywhere in the
 * UI to stop it. The button here posts the same `tutor:cancel` — the session's cancel goes
 * through `AskLedger.abandonAll()`, which reaches every live ask rather than the one the page
 * happens to know about — and the sentence names the step rather than pointing at a control
 * the learner cannot see.
 */
function elsewhereHtml(state: StepViewState): string {
  const away = state.tutor?.elsewhere;
  if (!away || typeof away.stepId !== 'string') return '';
  const steps = Array.isArray(state.plan.steps) ? state.plan.steps : [];
  const index = steps.findIndex((s) => s?.id === away.stepId);
  const where = index >= 0 ? `step ${index + 1}` : 'another step';
  const what = away.stage === 'sending'
    ? `A question you asked on ${where} is still with the tutor, and it is still being billed.`
    : `A question you asked on ${where} is still being prepared — nothing has been sent yet.`;
  return `<p class="tutor-elsewhere" id="tutor-elsewhere">${escapeHtml(what)} `
    + `<button type="button" class="btn btn-quiet" id="btn-tutor-cancel-elsewhere">${escapeHtml(CANCEL_BUTTON_LABEL)}</button></p>`;
}

/**
 * What this walk has spent — the half of `AskCost` that was computed on every reply and drawn
 * nowhere (code review finding 5).
 *
 * **`metered: false` is rendered as UNKNOWN, never as zero.** `src/tutor/core.ts` is emphatic
 * about it and so is `AskCost`: a provider that cannot report what it spent says so with a
 * flag, and a panel showing `$0.00` to somebody who was in fact billed is the dishonest half of
 * carrying the numbers at all. So a walk whose provider does not meter gets a sentence saying
 * how many answers it has paid for and that nobody reported the price — which is the true
 * statement — rather than a total.
 *
 * `unwatched` is the money half of the cancel story (code review finding 10): a request the
 * learner stopped waiting for is still running and still costing them, and this is where that
 * is said out loud rather than only in the note that scrolls away.
 */
function spendHtml(spend: TutorSpendView | undefined): string {
  if (!spend) return '';
  // Total, like every other lookup on this page (T-4 security review, finding 5): a throw from
  // inside a render takes down a PUSH rather than merely a paragraph, and `stepRenderKey` reads
  // the same fields on every push to decide whether to paint at all. The numbers are the
  // ledger's own and are already guarded there — this is the same rule applied twice, which is
  // what the rest of this file does with plan text.
  const replies = counted(spend.replies);
  const sending = counted(spend.sending);
  const unwatched = counted(spend.unwatched);
  const lines: string[] = [];

  if (replies > 0) {
    const answers = `${replies} ${replies === 1 ? 'answer' : 'answers'}`;
    lines.push(spend.metered === true
      ? `This walk has spent ${formatUsd(spend.usd)} on ${answers} — ${counted(spend.inputTokens).toLocaleString('en-US')} tokens in, ${counted(spend.outputTokens).toLocaleString('en-US')} out.`
      : `This walk has paid for ${answers}. Your provider does not report what they cost, so this is not a total — it is a count.`);
  }
  if (sending > 0) {
    const requests = `${sending} ${sending === 1 ? 'request is' : 'requests are'}`;
    lines.push(unwatched > 0
      ? `${requests} with the tutor right now, and ${unwatched === sending ? (unwatched === 1 ? 'it is one you stopped waiting for' : 'they are ones you stopped waiting for') : `${unwatched} of them you stopped waiting for`} — still running, still billing.`
      : `${requests} with the tutor right now.`);
  } else if (counted(spend.preparing) > 0) {
    lines.push('A question is being prepared. Nothing has been sent yet, so nothing is being charged.');
  }

  if (lines.length === 0) return '';
  return `<p class="tutor-spend" id="tutor-spend">${lines.map((line) => escapeHtml(line)).join(' ')}</p>`;
}

/** A count this page is willing to print. Anything that is not a finite number is zero, which
 *  reads as "nothing to report" — the honest answer, and never a `NaN` on the page. */
function counted(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A dollar figure with enough places to be true.
 *
 * One question costs fractions of a cent, and `$0.00` next to an answer somebody paid for is
 * the exact sentence this whole section exists not to print — so small amounts keep four
 * decimal places, and anything under a hundredth of a cent says so in words rather than
 * rounding itself away to nothing.
 */
function formatUsd(usd: unknown): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return 'an amount the provider did not report';
  if (usd === 0) return 'nothing the provider could put a price on';
  if (usd < 0.0001) return 'less than $0.0001';
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** What stands where the button was, told apart by which half of the wait it is (AC4, and
 *  security review finding 5 — a fifteen-second `claude --version` probe described as
 *  "thinking…" is a small lie at the exact moment somebody is deciding whether the button
 *  worked). A missing stage reads as the model call, which is what `thinking` used to mean on
 *  its own and is the safe way round: it never under-claims what is being spent. */
function waitingMessage(stage: unknown): string {
  return stage === 'preparing' ? PREPARING_MESSAGE : THINKING_MESSAGE;
}

/**
 * T-16 (F-11): "Step N of M", from the plan's own order. Empty when the plan does not list this
 * step: a count that might be wrong is worse than none. Shared by the markup and
 * `stepRenderKey`, so a plan whose length changes repaints.
 */
function stepCountText(state: StepViewState): string {
  const steps = Array.isArray(state.plan.steps) ? state.plan.steps : [];
  const index = steps.findIndex((s) => s?.id === state.step.id);
  return index >= 0 ? `Step ${index + 1} of ${steps.length}` : '';
}

function bodyHtml(state: StepViewState, skins: SkinsModule): string {
  const step = state.step;
  const currentDial: Dial = resolvedDial(state.dial);
  const count = stepCountText(state);

  return `
<main id="step-main" data-step-id="${escapeAttr(planId(step.id))}">
  ${count ? `<p class="step-count">${escapeHtml(count)}</p>` : ''}
  <div class="step-head">
    <h1>${escapeHtml(planText(step.decision.question))}</h1>
  </div>

  <section>
    <h2>Options</h2>
    ${optionsHtml(step, state.choiceNote)}
  </section>

  <section>
    <h2>Why</h2>
    <p class="why-text">${escapeHtml(planText(step.decision.why))}</p>
    <p class="why-source">${escapeHtml(whySourceLabel(step.decision.whySource))}</p>
  </section>

  <section>
    <h2>Witness</h2>
    <p class="witness-text">${escapeHtml(witnessSentence(step.witness))}</p>
  </section>

  ${state.shape ? shapeHtml(state.shape) : ''}

  ${dialFieldset(currentDial)}

  ${writeNoteHtml(state.writeNote)}

  <div class="actions">
    <button type="button" class="btn" id="btn-prev">Previous</button>
    <span class="open-wrap">
      <button type="button" class="btn" id="btn-open"${state.fileExists ? '' : ' disabled'}>Open the file</button>
      ${openFileHint(state.fileExists)}
    </span>
    <button type="button" class="btn" id="btn-check">Check my work</button>
    <button type="button" class="btn primary" id="btn-next">Next</button>
  </div>

  <div class="note" id="step-note">${escapeHtml(state.note ?? '')}</div>

  ${state.check ? checkHtml(state.check) : ''}

  ${reproduceHtml(state.reproduce)}

  ${tutorHtml(state)}

  <div class="panel-foot">${pickerHtml(skins.SKINS, state.skin)}</div>
</main>`;
}

/**
 * The client script (repo-tour lesson, T-3, 2026-08-26 — see the file header). Every handler
 * re-reads the DOM through `document.getElementById` rather than trusting an event's own
 * `target` (the fake-DOM harness this is tested against does not simulate bubbling or
 * populate synthetic events, exactly like `src/start/view.ts`'s own script never relies on
 * `event.target` either), and the dial's three ids are spelled out rather than discovered
 * with `querySelectorAll`, so this script needs nothing from a fake `document` beyond
 * `getElementById` — the same minimal surface `test/unit/start-view.test.ts` already fakes.
 */
const CLIENT_SCRIPT = `
(function () {
  // WHICH step this page is rendering. The host's markup is the only place that knows, and
  // it is the key the note below is saved under — see the restore guard.
  var mainEl = document.getElementById('step-main');
  var stepId = mainEl ? mainEl.getAttribute('data-step-id') : null;

  // AC5, and ONLY AC5: re-apply what the host already sent us — and what the learner was in
  // the middle of typing — after this view was torn down while hidden
  // (retainContextWhenHidden: false). The saved blob is scoped to the whole VIEW, not to a
  // step, so it is keyed by step id and dropped when it does not match what is on screen —
  // navigate away while hidden and the note that comes back belongs to the step you left,
  // which would be a lie told confidently, while the DRAFT that comes back would be a
  // question about one step typed into the box under another. The host's own render stays
  // authoritative for everything else (spec §5.1).
  var savedNote = '';
  var savedDraft = '';
  // T-16 (F-01): every press re-renders this whole page, so the result of a press below the
  // fold (the check report, the tutor, the detour line) used to arrive out of sight. Two
  // values ride in the same saved blob as the draft, and only when set:
  // y, where the learner was on THIS step, and reveal, the one outcome the last press asked
  // to see. reveal is checked against a fixed list and is only ever used to find an element
  // by id; it never reaches markup.
  var REVEALS = ['check', 'tutor', 'detour', 'choice'];
  // A reveal is honoured only by a repaint within this long of its press. A press the host
  // answers with no repaint and no note (a second identical check) must not leave a reveal
  // armed for some unrelated repaint much later (code review 2).
  var REVEAL_LIFETIME_MS = 20000;
  var savedY = 0;
  var revealKey = '';
  var revealAt = 0;
  var restored = false;
  var initial = restore();
  // The blob is ONE per view, written for one step. This page owns it when it was written for
  // this step, or once the learner does something here. Until then a scroll on this page keeps
  // y in memory only (code review 3). A press does take the blob over, so the question left half
  // typed on another step rides along in \`drafts\`, by step, and comes back when that step does
  // (T-21 re-review F2): a press on one step must not cost the learner their words on another.
  var owns = !!(initial && initial.stepId === stepId);
  var otherDrafts = Object.create(null);
  if (initial && typeof initial.drafts === 'object' && initial.drafts !== null) {
    Object.keys(initial.drafts).forEach(function (key) {
      if (typeof initial.drafts[key] === 'string') { otherDrafts[key] = initial.drafts[key]; }
    });
  }
  if (initial && typeof initial.stepId === 'string' && initial.stepId !== stepId && typeof initial.draft === 'string' && initial.draft !== '') {
    otherDrafts[initial.stepId] = initial.draft;
  }
  if (typeof otherDrafts[stepId] === 'string') {
    savedDraft = otherDrafts[stepId];
    delete otherDrafts[stepId];
  }
  if (initial && initial.stepId === stepId) {
    if (typeof initial.note === 'string') { savedNote = initial.note; }
    if (typeof initial.draft === 'string') { savedDraft = initial.draft; }
    if (typeof initial.y === 'number' && isFinite(initial.y) && initial.y > 0) { savedY = Math.round(initial.y); }
    var age = typeof initial.revealAt === 'number' && isFinite(initial.revealAt) ? Date.now() - initial.revealAt : Infinity;
    if (typeof initial.reveal === 'string' && REVEALS.indexOf(initial.reveal) >= 0 && age >= -1000 && age <= REVEAL_LIFETIME_MS) {
      revealKey = initial.reveal;
      revealAt = initial.revealAt;
    }
  }
  // ONE blob, written whole every time. Two writers each calling save() with only their own
  // field would each erase the other's — the note would eat the draft on the next reply, and
  // the draft would eat the note on the next keystroke.
  function persist() {
    owns = true;
    // After the restore below, the live position wins over the debounced one, so a press
    // within the scroll debounce still saves where the learner really is (code review 7).
    if (restored && typeof window.scrollY === 'number') { savedY = window.scrollY > 0 ? Math.round(window.scrollY) : 0; }
    var blob = { stepId: stepId, note: savedNote, draft: savedDraft };
    if (Object.keys(otherDrafts).length > 0) { blob.drafts = otherDrafts; }
    if (savedY > 0) { blob.y = savedY; }
    if (revealKey) { blob.reveal = revealKey; blob.revealAt = revealAt; }
    save(blob);
  }
  function reveal(key) { revealKey = key; revealAt = Date.now(); persist(); }

  var initialNoteEl = document.getElementById('step-note');
  if (savedNote && initialNoteEl) { initialNoteEl.textContent = savedNote; }

  // T-6. The box is empty in the markup — the host does not know what somebody is halfway
  // through typing — so this is the only thing that can put a draft back. It matters far more
  // here than the note does: the panel REPAINTS when the transcript grows, which is exactly
  // the moment the tutor answers, which is exactly when a learner is most likely to be typing
  // their follow-up. Without this, every answer would delete the next question.
  //
  // ── The draft is dropped ONLY when the host says it took the question ──────────────────
  //
  // This used to clear on the press, and that destroyed the learner's question on every path
  // that refuses AFTER the press — an unreachable provider, no request.json, a core that will
  // not load, one ask already in flight. On a machine with no \`claude\` it was the first thing
  // the tutor ever did: gone from the box, gone from this blob, and deliberately not in the
  // transcript. It was nowhere.
  //
  // \`data-accepted\` is the host naming the question it really SENT. Compared rather than
  // merely present, because it survives the answer's repaint too: on the page that draws the
  // reply the attribute still holds that question, and re-applying the draft there would show
  // the learner their question twice — once in the conversation and once in the box.
  var inputEl = document.getElementById('tutor-input');
  var acceptedText = inputEl ? inputEl.getAttribute('data-accepted') : null;
  if (savedDraft && acceptedText !== null && acceptedText === savedDraft) {
    savedDraft = '';
    persist();
  }
  if (inputEl && savedDraft) { inputEl.value = savedDraft; }

  // T-16 (F-01): back to where the learner was on this step, then the outcome of their last
  // press into view. block 'nearest' moves only as far as needed and not at all when the
  // outcome is already visible; behavior 'auto' never animates. One-shot: the reveal is
  // cleared here, so a later repaint on the same step does not jump again.
  if (savedY > 0 && typeof window.scrollTo === 'function') { window.scrollTo(0, savedY); }
  restored = true;
  if (revealKey) {
    var outcome = document.getElementById('outcome-' + revealKey);
    if (outcome && typeof outcome.scrollIntoView === 'function') {
      outcome.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    revealKey = '';
    persist();
  }
  // T-21 re-review F1: a press from a page for a step already left is answered on the page drawn
  // for the step the learner is on, and the old page's reveal is keyed to the old step, so this is
  // the page that has to bring the words into view. VS Code then puts the OLD page's scroll
  // position on a new page at its load, but only a page still at 0 (\`setInitialScrollPosition\` in
  // its webview pre/index.html), which is why 1 px matters: words already in view stay in view.
  var choiceWords = document.getElementById('choice-note');
  if (choiceWords && !(initial && initial.stepId === stepId)) {
    var choiceOutcome = document.getElementById('outcome-choice');
    if (choiceOutcome && typeof choiceOutcome.scrollIntoView === 'function') {
      choiceOutcome.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    if (window.scrollY === 0 && typeof window.scrollTo === 'function') { window.scrollTo(0, 1); }
  }
  // The note is the one node the host changes WITHOUT a repaint (a refusal, a check note), so
  // it is the page's live region: a screen reader hears it when it changes (WCAG 4.1.3). Set
  // here, not in the markup the existing tests pin. A repainted region cannot announce this
  // way, since every repaint is a fresh document.
  var liveNote = document.getElementById('step-note');
  if (liveNote) { liveNote.setAttribute('role', 'status'); }
  // T-16 (F-10): a code block in an answer scrolls sideways rather than wrap, so it must take
  // keyboard focus to be scrolled without a mouse (WCAG 2.1.1). Only a block that really
  // overflows gets a tab stop, and only the newest twelve: a reply is model output, and a
  // conversation stuffed with wide blocks must not put hundreds of stops between the step's
  // controls and Ask (security review N-1). Set here, not in the markup the escaping tests pin.
  if (typeof document.querySelectorAll === 'function') {
    var blocks = document.querySelectorAll('pre.tutor-code');
    var stops = 0;
    for (var b = blocks.length - 1; b >= 0 && stops < 12; b--) {
      if (blocks[b].scrollWidth > blocks[b].clientWidth) { blocks[b].setAttribute('tabindex', '0'); stops++; }
    }
  }
  var scrollQueued = false;
  window.addEventListener('scroll', function () {
    if (scrollQueued) { return; }
    scrollQueued = true;
    setTimeout(function () {
      scrollQueued = false;
      var y = typeof window.scrollY === 'number' ? window.scrollY : 0;
      savedY = y > 0 ? Math.round(y) : 0;
      if (owns) { persist(); }
    }, 150);
  });

  function on(id, type, handler) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener(type, handler); }
  }

  on('btn-prev', 'click', function () { post('step:prev', {}); });
  on('btn-open', 'click', function () { post('step:open', {}); });
  on('btn-check', 'click', function () { reveal('check'); post('step:check', {}); });
  on('btn-next', 'click', function () { post('step:next', {}); });
  // T-21: one button per choosable option, ids choose-0 … choose-N; each posts its option's id
  // and the step this page was drawn for, both read from escaped attributes (never page-assembled
  // markup). The host compares the step and refuses in words when it has moved on, because every
  // step of a real plan has the same option ids.
  for (var ci = 0; ci < ${MAX_OPTIONS_RENDERED}; ci++) {
    (function (button) {
      if (!button) { return; }
      button.addEventListener('click', function () {
        reveal('choice');
        post('step:choose', {
          optionId: button.getAttribute('data-option-id'),
          stepId: mainEl ? mainEl.getAttribute('data-step-id') : null,
        });
      });
    })(document.getElementById('choose-' + ci));
  }
  // Only on the page while the offer stands (see reproduceHtml); \`on\` is null-safe, so the
  // rest of the time this line hooks nothing rather than needing a condition of its own.
  on('btn-reproduce', 'click', function () { post('reproduce:run', {}); });

  // ── T-6: the tutor ────────────────────────────────────────────────────────────────────

  /**
   * Send whatever is in the box, INCLUDING an empty box.
   *
   * Not guarding empty here is deliberate. The host answers a blank press with a sentence
   * (\`NOTHING_TO_ASK_MESSAGE\`, posted straight back into the note node without a repaint), and
   * a button that quietly does nothing is the one thing this project's conventions rule out.
   * Guarding it here would make that sentence unreachable and turn the control silent again.
   *
   * The question is KEPT — in the box and in the saved blob — until the host says it took it.
   * The host can refuse after this press (an unreachable provider, no request.json, a core
   * that will not load, one ask already in flight), and a page that had already thrown the
   * text away would be telling somebody their question was refused beside an empty box. The
   * saving is what matters: the acceptance arrives with a REPAINT, which tears this iframe
   * down, so the draft has to survive in \`setState\` and be dropped by the page that comes
   * back — see the \`data-accepted\` comparison at the top of this script.
   */
  function askTutor() {
    var box = document.getElementById('tutor-input');
    if (!box) { return; }
    var text = box.value;
    savedDraft = text;
    revealKey = 'tutor';
    revealAt = Date.now();
    persist();
    post('tutor:ask', { text: text });
  }

  on('btn-tutor-ask', 'click', askTutor);
  on('btn-tutor-cancel', 'click', function () { reveal('tutor'); post('tutor:cancel', {}); });
  // The same message from the line about an ask on ANOTHER step: the host's cancel goes
  // through the ledger and stops every live request, so one message is the whole control.
  on('btn-tutor-cancel-elsewhere', 'click', function () { reveal('tutor'); post('tutor:cancel', {}); });
  // T-43 (code review F1): this button is now on the keyboard route into the box, and it deletes
  // somebody's own words with no way back. So the first press asks, by changing what the button
  // says, and the second does it; leaving the button takes the question back.
  var forgetArmed = false;
  on('btn-tutor-clear', 'click', function () {
    var button = document.getElementById('btn-tutor-clear');
    if (!forgetArmed) {
      forgetArmed = true;
      if (button) { button.textContent = ${JSON.stringify(CLEAR_CONFIRM_LABEL)}; }
      return;
    }
    forgetArmed = false;
    reveal('tutor');
    post('tutor:clear', {});
  });
  on('btn-tutor-clear', 'blur', function () {
    forgetArmed = false;
    var button = document.getElementById('btn-tutor-clear');
    if (button) { button.textContent = ${JSON.stringify(CLEAR_BUTTON_LABEL)}; }
  });

  // ── T-7: the detour ───────────────────────────────────────────────────────────────────

  // Each of these is on the page only in the state it belongs to (see detourHtml); \`on\` is
  // null-safe, so the rest of the time these lines hook nothing rather than needing a
  // condition of their own — the same shape \`btn-reproduce\` above uses.
  on('btn-detour-start', 'click', function () { reveal('detour'); post('detour:start', {}); });
  on('btn-detour-regenerate', 'click', function () { reveal('detour'); post('detour:regenerate', {}); });
  on('btn-detour-back', 'click', function () { reveal('detour'); post('detour:back', {}); });
  // The same \`tutor:cancel\` the ask uses: the host's cancel goes through the ledger and stops
  // every live request, and a detour being written is one of them. One message is the whole
  // control, exactly as it is for the ask-on-another-step line.
  on('btn-tutor-cancel-detour', 'click', function () { reveal('detour'); post('tutor:cancel', {}); });

  // Enter sends, Shift+Enter makes a newline — sql-gauntlet's pattern, which the owner asked
  // for by name. Every other key falls straight through, so nothing here interferes with
  // typing, and the guard order matters: an event with no \`key\` at all (an older browser, a
  // synthetic one) must return before anything is called ON it rather than throw inside a
  // keystroke handler where the symptom would be a box that has silently stopped working.
  on('tutor-input', 'keydown', function (e) {
    if (!e || e.key !== 'Enter' || e.shiftKey) { return; }
    e.preventDefault();
    askTutor();
  });

  // Saved on every keystroke rather than on blur: a webview view is torn down when the sidebar
  // is collapsed or the panel repaints, neither of which is a blur, and the whole value of
  // this is surviving exactly those.
  on('tutor-input', 'input', function () {
    var box = document.getElementById('tutor-input');
    savedDraft = box ? box.value : '';
    persist();
  });

  ['manual', 'scaffolded', 'automated'].forEach(function (dial) {
    on('dial-' + dial, 'change', function () { post('dial:set', { dial: dial }); });
  });

  var skinpick = document.getElementById('skinpick');
  if (skinpick) {
    skinpick.addEventListener('change', function () {
      var v = skinpick.value;
      // Applied instantly, client-side, for zero flash — mirrors src/start/view.ts exactly;
      // the host's only job is to persist the choice for the NEXT time this page opens.
      if (!v || v === 'system') { document.documentElement.removeAttribute('data-theme'); }
      else { document.documentElement.setAttribute('data-theme', v); }
      post('skin:set', { skin: v });
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg) return;
    if (msg.type === 'step:note') {
      var note = msg.payload.note;
      var el = document.getElementById('step-note');
      if (el) { el.textContent = note; }
      // Keyed by the step it belongs to, so the restore above can tell "the same view came
      // back" from "a different step is on screen now" — and written through \`persist\` so it
      // carries the learner's draft along rather than erasing it. The whole reason this
      // channel exists is that it reaches the page WITHOUT a repaint; a save that dropped the
      // draft would undo that in a different way.
      savedNote = note;
      // T-16 (F-01): a NON-EMPTY note is the host answering a press without a repaint (an
      // empty ask, a refusal), so that press has had its answer: drop the pending reveal and
      // bring the note itself into view, because the learner pressed from further down the
      // page. An EMPTY note only clears an old one: an accepted ask posts it just before the
      // repaint to "thinking", and that repaint still needs its reveal.
      if (note) { revealKey = ''; }
      persist();
      if (el && note && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }
    }
  });
})();
`;

export function stepScript(): string {
  return CLIENT_SCRIPT;
}

/**
 * The page this view shows when there is no step to show — no tutorial in this folder yet,
 * or repo-tour's core not loaded so there is nothing to render a step WITH.
 *
 * It exists because the alternative was `html = ''`, and a silently blank panel is precisely
 * the failure this repo's house rule is about: if a surface can have nothing to say, it says
 * so, where the eye already is. It takes no `SkinsModule` on purpose — the "core is missing"
 * case is exactly the case where there isn't one — so it is deliberately unskinned, styled by
 * the bridge sheet's editor-token mapping alone, which needs nothing from repo-tour.
 */
export function renderNoticeHtml(notice: string): string {
  return renderPage({
    title: 'Build Tutorials: Step',
    coreCss: '',
    bridgeCss: bridgeCss(),
    pageCss: PAGE_CSS,
    skin: 'system',
    body: `<main class="notice-only"><h1>${escapeHtml(NOTICE_HEADING)}</h1><p class="notice">${escapeHtml(notice)}</p></main>`,
    script: '',
  });
}

/**
 * Everything `renderStepHtml` actually PUTS ON THE PAGE, as one comparable string — the key
 * `src/walk/step-panel.ts` decides whether to repaint on.
 *
 * **Why a repaint has to be conditional at all.** `webview.html = renderStepHtml(...)` is
 * neither free nor idempotent: `renderPage` mints a fresh nonce per call, so the string is
 * different every time and VS Code's identical-html short-circuit can never fire, and every
 * assignment tears the iframe down and builds it again. The session refreshes every surface
 * for reasons that change nothing here — `setDial` refreshes so the STATUS BAR can show
 * `· scaffolded` (AC6) — and the learner who had tabbed into the dial and pressed Down loses
 * the radio holding focus, while everyone loses their scroll position. Two pushes with the
 * same key produce the same page, so the second is skipped (T-4 code review, finding 1).
 *
 * **Why it lives here and not in the panel.** It enumerates what the markup above draws, so
 * it belongs beside that markup: T-4 kept it in `step-panel.ts`, one file away, which is
 * exactly the distance a drift needs — and the drift is silent. A field this file renders and
 * this function omits is stored on the host and never appears on screen until something else
 * forces a repaint: a panel that is stale, intermittently, which is far harder to find than
 * the repaint storm the key replaces. Here, the two are read together, and a unit test can
 * prove by mutation that changing a rendered field changes the key (there is no way to reach
 * `step-panel.ts` from `test/unit/`, which imports no `vscode`).
 *
 * **ADDING A FIELD TO THE MARKUP MEANS ADDING IT HERE, IN THE SAME COMMIT.** The list is in
 * the order `bodyHtml` reads them, so the two can be diffed side by side:
 *
 *   - `step.id`                        → `<main data-step-id>` (also the client script's key)
 *   - `step.decision.question`         → the `<h1>`
 *   - `step.decision.options[]`        → `id`, `label`, `consequence`, `taken` — the list, its
 *                                        `.option-taken` marking, its two badges, and (through
 *                                        the array's LENGTH) the "n not shown" note
 *   - `step.decision.authorChoice`     → the same marking, when no option carries `taken`
 *   - `step.decision.chosen`           → the learner's road (T-21): the mark, *Your choice* and
 *                                        the line about what has not changed yet
 *   - `state.choiceNote`               → the refusal above the options list (T-21), with its
 *                                        count, so a second refused press still repaints
 *   - `step.decision.why`              → the why paragraph
 *   - `step.decision.whySource`        → its "from the model / the author / not inferable" line
 *   - `step.witness.{sha,subject,date}`→ the witness sentence, or `NO_HISTORY_MESSAGE`
 *   - `state.shape`                    → the manual-mode shape block (AC2), and its ABSENCE is
 *                                        what removes that block when the dial leaves manual
 *   - `state.fileExists`               → *Open the file*'s `disabled`, and its hint text
 *   - `state.writeNote`                → the write note under the dial
 *   - `state.check`                    → the whole check report (AC5) — summary, verdict
 *                                        colour, every symbol and import row
 *   - `state.reproduce`                → the offer line and its button, present until done
 *   - `state.transcript[]`             → every turn drawn in the tutor log — `role` (which
 *                                        label and which class) and `content` (the escaped
 *                                        text and its ``` fences) — and, through the array's
 *                                        LENGTH, the "n earlier turns" note
 *   - `state.tutor.thinking`           → *Ask* versus "thinking…" and *Cancel*, and whether
 *                                        the box is `disabled`
 *   - `state.tutor.unreachable`        → the provider's reason, beside the input
 *   - `state.tutor.note`               → the sentence about the last outcome
 *   - `skins.SKINS`                    → the skin picker's `<option>`s
 *
 * **Four displayed fields are deliberately NOT here, and this is the only place that says
 * why.** Each is one the PAGE ITSELF keeps current between repaints, so a repaint would
 * install a value the learner is already looking at:
 *
 *   - **`state.dial`** (which radio is `checked`). The learner moved that radio; the browser
 *     checked it before the message was even posted. This is the exact push finding 1 is
 *     about, and repainting for it is what destroys the radio holding keyboard focus
 *     mid-arrow-key. Note that a dial change which really does change the PAGE still repaints,
 *     through `shape`, `writeNote` and `fileExists` — leaving manual mode removes the shape
 *     block, and scaffolding a file writes one — which is the correct trade: the paint is
 *     spent when there is something new to see and skipped when there is not.
 *   - **`state.skin`** (`<html data-theme>` and the picker's `selected`). The client script
 *     sets `data-theme` itself, instantly, for zero flash; the host's only job is to remember
 *     the choice for the next real render.
 *   - **`state.note`** (`#step-note`). It arrives as a `step:note` message the page writes
 *     into the node and saves, precisely so it survives a hidden view being torn down. (Its
 *     server-rendered counterpart, `writeNote`, IS in the key — a different node, a different
 *     owner, and nothing on the page keeps it current.)
 *   - **`state.progress`**, which nothing on this page reads any more: the dial it used to be
 *     consulted for is resolved by the session now (see `resolvedDial`).
 *
 * The tutor's DRAFT — what somebody is halfway through typing into the box — is a fifth of the
 * same kind and is not in `StepViewState` at all, so it cannot be listed above. It is worth
 * naming here anyway, because it is the field that made the exclusions matter: the panel
 * repaints when the transcript grows, which is precisely the moment the tutor answers, which is
 * precisely when a learner is typing their follow-up. The host never learns the draft; the
 * client script saves it into the same view-scoped blob the note uses and puts it back on the
 * next load. Do not "fix" that by pushing the draft to the host — a webview that told the host
 * what was in its own input would be the second source of truth this whole design exists to
 * refuse (spec §5.1).
 *
 * If any of those ever starts changing from a source OTHER than the page's own controls, the
 * fix is a targeted `postMessage` to update that one node — the way `note` already works —
 * not a full repaint, and not moving it into this key.
 *
 * **Capped value PLUS uncapped length**, for each string and each list — which keeps the
 * property the raw version was protecting while bounding what this builds (T-5 security
 * review, finding 5).
 *
 * The original went in raw, reasoning that hashing what the page EMITS would make two
 * genuinely different plans compare equal past the cap — stale, silently. That reasoning is
 * right, and it is why the fix is not "key on the rendered output". But raw meant
 * `JSON.stringify` over every option label, every consequence, the whole `why` and the entire
 * check report, on EVERY push rather than once per load — the same unbounded work T-4's own
 * security review flagged, reintroduced in the decision about whether to paint.
 *
 * Carrying the length beside the capped value restores the distinction exactly: two plans
 * that differ only past the cap render identically — that is what the cap means — but their
 * lengths differ, so the key still moves, and the "…N more" line that reports the difference
 * is itself driven by those counts. `String.prototype.length` is O(1), so the bound costs
 * nothing to compute. Erring is still one-directional: an occasional repaint that changed
 * nothing visible, which costs a nonce.
 *
 * Every array is guarded before it is walked, for the reason `planText` exists (T-4 security
 * review, finding 5): `options` is only TYPED as an array, and a `.map` on a plan that made it
 * an object throws — here, from inside the decision about whether to paint, which would take
 * down a push rather than merely a render.
 */
/** A value's capped form and its true size — enough to tell any two renderable states apart,
 *  and bounded however large the plan is. Non-strings pass through as themselves, since only
 *  a string can be unboundedly long here. */
function keyOf(value: unknown, max = MAX_CHECK_TEXT): unknown {
  return typeof value === 'string' ? [value.length <= max ? value : value.slice(0, max), value.length] : value;
}

/** The same, for a list: its capped head and its true count. The count is not decoration —
 *  it is what the "…and N more" lines are computed from, so two lists that share a head and
 *  differ in length really do render differently. */
function keyOfList<T>(value: unknown, max: number, project: (entry: T) => unknown): unknown {
  if (!Array.isArray(value)) return null;
  return [value.slice(0, max).map((entry) => project(entry as T)), value.length];
}

/**
 * The transcript's own version of `keyOfList`, and it exists for ONE reason: it takes the
 * TAIL.
 *
 * `transcriptHtml` draws the last `MAX_TURNS_RENDERED` turns, because in a conversation the
 * newest is what a learner is looking at. `keyOfList` takes the head, which is right for every
 * other list on this page and would be quietly wrong here — with two hundred stored turns the
 * key would describe the first thirty while the page drew the last thirty, so an answer
 * arriving into a full transcript would move nothing in the key except the count. The count
 * alone would in fact save it today (an appended turn always changes the length), which is
 * exactly the sort of accidental correctness that stops being correct the moment somebody adds
 * a way to edit a turn. Mirroring the render is the property worth having, not the coincidence.
 *
 * The per-turn cap is `MAX_REPLY_TEXT`, the SAME cap the render applies, which is what keeps
 * the capped-value-plus-length trick exact here as everywhere else: two transcripts that
 * differ only past the cap render identically — that is what the cap means — and their lengths
 * differ, so the key still moves.
 */
function keyOfTranscript(turns: unknown): unknown {
  if (!Array.isArray(turns)) return null;
  const shown = (turns as Array<AskMessage | undefined>).slice(-MAX_TURNS_RENDERED);
  // `kind` joins the projection because T-7 draws it: a note takes a different class, a
  // different label and a different escaping path from a tutor turn, so two transcripts
  // identical but for it render DIFFERENTLY and must not share a key. It is the same rule
  // `role` is here for, one field later.
  return [shown.map((turn) => [turn?.role, turn?.kind ?? null, keyOf(turn?.content, MAX_REPLY_TEXT)]), turns.length];
}

export function stepRenderKey(state: StepViewState, skins: SkinsModule): string {
  const { decision, id, witness } = state.step;
  const report = state.check?.report;
  return JSON.stringify([
    keyOf(id),
    stepCountText(state),
    keyOf(decision.question),
    keyOfList<OptionLike | undefined>(decision.options, MAX_OPTIONS_RENDERED, (option) => [
      keyOf(option?.id), keyOf(option?.label), keyOf(option?.consequence), option?.taken,
    ]),
    keyOf(decision.authorChoice),
    keyOf(decision.chosen), // T-21: a choice must repaint, or the press is silent
    keyOf(state.choiceNote ?? null), // T-21: so must a refusal, and a repeat of one (T-15)
    keyOf(decision.why, MAX_PLAN_TEXT),
    decision.whySource,
    [keyOf(witness?.sha), keyOf(witness?.subject), keyOf(witness?.date)],
    state.shape
      ? [
          keyOfList<string>(state.shape.signatures, MAX_LIST_ROWS, (line) => keyOf(line)),
          keyOfList<string>(state.shape.imports, MAX_LIST_ROWS, (line) => keyOf(line)),
        ]
      : null,
    state.fileExists,
    keyOf(state.writeNote ?? null),
    state.check
      ? [
          keyOf(state.check.summary, MAX_PLAN_TEXT),
          report?.ok,
          report?.parseErrors,
          keyOf(report?.reason ?? null, MAX_PLAN_TEXT),
          keyOfList<{ name?: unknown; kind?: unknown; status?: unknown }>(report?.symbols, MAX_LIST_ROWS, (row) => [
            keyOf(row?.name), keyOf(row?.kind), row?.status,
          ]),
          keyOfList<{ raw?: unknown; status?: unknown }>(report?.imports, MAX_LIST_ROWS, (row) => [keyOf(row?.raw), row?.status]),
        ]
      : null,
    state.reproduce ? [state.reproduce.count, state.reproduce.done] : null,
    // ── T-6: the tutor. Every one of these is drawn by `tutorHtml`, and every one of them is
    // a "stored on the host and never shown" bug if it is dropped from here. The thinking
    // state is the worst to lose: the *Ask* button would go on looking pressable while a
    // question was in flight, and the answer would appear only when something else forced a
    // repaint — which reads exactly like a tutor that ignores you.
    //
    // The four fields the review pass added — `stage`, `elsewhere`, `spend`, `accepted` —
    // are here for the same reason and NOT because the list looked short. Each of them
    // changes the page, so each of them must move the key, and `stepRenderKey — every field
    // the page draws moves the repaint key` proves it one field at a time. `accepted` is the
    // subtle one: it is drawn as an ATTRIBUTE rather than as text, and an attribute the
    // client script reads is exactly as load-bearing as a paragraph it does not.
    //
    // `spend` is bounded by construction — eight numbers and a boolean, none of them a
    // string — so it needs no `keyOf`.
    keyOfTranscript(state.transcript),
    state.tutor
      ? [
          state.tutor.thinking,
          keyOf(state.tutor.unreachable ?? null),
          keyOf(state.tutor.note ?? null, MAX_PLAN_TEXT),
          state.tutor.stage ?? null,
          state.tutor.elsewhere ? [keyOf(state.tutor.elsewhere.stepId), state.tutor.elsewhere.stage] : null,
          state.tutor.spend
            ? [
                state.tutor.spend.preparing,
                state.tutor.spend.sending,
                state.tutor.spend.unwatched,
                state.tutor.spend.replies,
                state.tutor.spend.inputTokens,
                state.tutor.spend.outputTokens,
                state.tutor.spend.usd,
                state.tutor.spend.metered,
              ]
            : null,
          keyOf(state.tutor.accepted ?? null, MAX_ASK_TEXT),
        ]
      : null,
    // ── T-7: the detour (plan R4). Three fields, all of them drawn by `detourHtml`, all of
    // them therefore here. `generating` is the one that would hurt most to lose — the button
    // would go on looking pressable while an example was being written, and the example would
    // appear only when something else forced a repaint, which reads exactly like a button
    // that ignores you. `open` decides WHICH control is on the page at all (the way out
    // instead of the way in), and `note` is the sentence AC5 requires a failed generation to
    // carry, so a second failure with a different reason under an unchanged key would show
    // the learner the first one's sentence.
    //
    // `state.tutor.unreachable` is deliberately NOT repeated here: it is already in the tutor
    // block above, and `detourHtml`'s hint is derived from that same value — one entry, one
    // field, no way for the two to disagree about whether a repaint is due.
    [
      state.detour?.generating === true,
      state.detour?.open ? [keyOf(state.detour.open.stepId), keyOf(state.detour.open.title)] : null,
      keyOf(state.detour?.note ?? null, MAX_PLAN_TEXT),
    ],
    keyOfList<SkinRow | undefined>(skins.SKINS, MAX_LIST_ROWS, (row) => [keyOf(row?.name), keyOf(row?.label), keyOf(row?.note)]),
  ]);
}

export function renderStepHtml(state: StepViewState, skins: SkinsModule): string {
  return renderPage({
    title: 'Build Tutorials: Step',
    coreCss: skins.baseCss() + skins.alternateCss(),
    bridgeCss: bridgeCss(),
    pageCss: PAGE_CSS,
    skin: state.skin,
    body: bodyHtml(state, skins),
    script: CLIENT_SCRIPT,
  });
}
