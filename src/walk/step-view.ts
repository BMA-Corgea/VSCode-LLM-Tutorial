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
 * **Recreate mode only, and this page is where that shows up.** The ticket's own spec is
 * explicit: the panel shows alternatives but does not let the learner pick one (T-10). That
 * is stronger than "the control is disabled" — for every option that is not what the author
 * actually did, there is NO `<button>` and NO `<input>` in the markup at all, only `<ul>`/
 * `<li>`/`<span>`/`<p>`. A disabled control can always be a bug away from becoming enabled by
 * accident; a control that was never rendered cannot. The author's own choice gets a "What
 * the author did" badge instead of a "coming with T-10" one, and nets no interactive markup
 * either, since nothing on this page is selectable yet.
 *
 * **Which option IS the author's** is read from `option.taken` FIRST and from `option.id ===
 * decision.authorChoice` as a fallback (T-4 code review, finding 6). repo-tour's own builder
 * keeps the two in agreement — the real 61-step sql-gauntlet plan carries exactly one `taken`
 * on every step — which is why reading only `taken` looked sufficient, and is exactly the trap:
 * a plan from an older builder, a hand-edited one, or one half-migrated by a future schema can
 * carry `authorChoice: 'author'` with no `taken` anywhere. Nothing would then be marked, EVERY
 * option would wear a "coming with T-10" badge, and AC2 ("the author's choice marked among the
 * options") would be silently unmet on a page that still looked perfectly fine. Do not
 * "simplify" the fallback away. It is resolved ONCE, to a single index, rather than tested per
 * option: two options can only both light up if the question is asked twice, and "the author
 * did two of these" is never a true sentence.
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
import { FALLBACK_DIAL, type OptionLike, type StepLike, type WhySource } from './model.js';
import { MAX_ASK_TEXT, type StepViewState } from './step-protocol.js';

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
export const T10_BADGE = 'coming with T-10';

// ── the render caps (T-4 security review, finding 3) ───────────────────────────────────────
// See the file header for the threat: `webview.html = ...` is synchronous on the extension
// host, every string here is third-party, repo-tour caps almost none of it, and this is the
// one path Workspace Trust does not gate. Both numbers are picked to sit far above anything a
// real plan has ever produced, so neither can plausibly cut a learner off mid-sentence, and
// far below anything that could make one render take meaningful time.

/**
 * How many options this panel will draw for one step.
 *
 * Measured, not guessed. A plan built with no interpretation gives every step exactly ONE
 * option ("What the author did") — that is all 61 steps of the real sql-gauntlet plan. A fully
 * interpreted step gives THREE: the author's own, plus the "exactly two OTHER reasonable ways"
 * repo-tour's interpreter prompt asks for by name. Nothing repo-tour can legitimately produce
 * goes past three, so 24 leaves eight times the headroom a real plan needs — while a hostile
 * `alternatives` array (repo-tour's `parseAlternatives` keeps every entry the model emitted,
 * unbounded) stops here instead of at ten thousand `<li>`s.
 */
export const MAX_OPTIONS_RENDERED = 24;

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
export const ASK_BUTTON_LABEL = 'Ask';
export const CANCEL_BUTTON_LABEL = 'Cancel';

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
.step-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:18px; }
.step-head h1 { font-size:16px; margin:0; max-width:70%; }
section { margin-bottom:20px; }
section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 8px; }
.options { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.option { border:1px solid var(--line); border-radius:var(--radius); padding:10px 14px; }
.option-taken { border-color:var(--accent); background:var(--hl); }
.option-label { display:block; font-weight:600; }
.option-consequence { margin:4px 0 0; color:var(--muted); }
.badge { display:inline-block; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; padding:2px 8px; border-radius:999px; margin-bottom:6px; }
.badge-taken { background:var(--accent-soft); color:var(--accent); }
.badge-t10 { background:var(--chip); color:var(--muted); }
.why-text { margin:0 0 4px; }
.why-source, .witness-text { color:var(--muted); font-size:12px; margin:0; }
/* The honest count under a capped options list — see MAX_OPTIONS_RENDERED. Styled like the
   other muted asides rather than like a warning: nothing has gone wrong, this panel has
   simply decided how much of a very large plan it is willing to draw at once. */
.options-omitted { color:var(--muted); font-size:12px; margin:8px 0 0; }
section h3 { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; margin:12px 0 6px; }
/* One monospace stack, declared once. repo-tour's base sheet has no code token to borrow and
   the bridge maps no VS Code font variable, so this is a plain stack rather than an invented
   \`--mono\` that would look like a token other files could rely on. */
.check-name, .shape-line { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
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
.turn-who { display:block; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); margin-bottom:3px; }
/* pre-wrap, so a model's own line breaks survive without this page turning them into markup —
   the whole of AC5 is that a fence and nothing else becomes an element, and a newline is
   presentation rather than structure. (No backticks anywhere in this sheet: it lives inside a
   TS template literal, so one would end the string and ship a page that does not parse.) */
.turn-text { white-space:pre-wrap; }
/* A fenced block is the ONE construct this page renders from a reply. It scrolls inside itself
   rather than widening the panel: code has no wrap opportunities, and overflow-wrap:anywhere
   on an example would break identifiers across lines, which is worse than a scrollbar. */
.turn-text pre.tutor-code { white-space:pre; overflow-x:auto; margin:8px 0; padding:8px 10px; background:var(--chip); border-radius:var(--radius); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
.tutor-empty { color:var(--muted); font-size:12px; margin:0 0 12px; }
/* The note takes the same colour as the write note — both are news about something that just
   happened, and both are the panel's answer to a control the learner pressed. The unreachable
   line is muted instead: it is a standing condition of their machine, not an event. */
.tutor-note { color:var(--kw); font-size:12px; margin:0 0 8px; }
.tutor-unreachable { color:var(--muted); font-size:12px; margin:0 0 8px; }
.tutor-ask { display:flex; flex-direction:column; gap:8px; }
.tutor-input { width:100%; box-sizing:border-box; font:inherit; font-size:13px; padding:8px 10px; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); color:inherit; resize:vertical; }
.tutor-input:disabled { opacity:0.6; }
.tutor-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.tutor-thinking { color:var(--muted); font-size:12px; }

/* This page lives in a SIDEBAR, and everything on it is someone else's text — a docstring,
   a commit subject, a generated sentence. The real plan already ships a \`why\` that is a
   docstring beginning with a rule of box-drawing characters
   (\`── tokenizer ─────────────────\`), which has no wrap opportunity in it at all and pushes
   the whole panel sideways. Long URLs and long identifiers do the same. \`anywhere\` is the
   right strength here: break mid-token only when there is no other option. */
main, section, .option { min-width:0; }
.step-head h1, .option-label, .option-consequence, .why-text, .why-source, .witness-text,
.note, .hint, .check-summary, .check-reason, .check-aside, .check-name, .shape-line,
.write-note, .reproduce, .turn-text, .tutor-note, .tutor-unreachable, .tutor-empty { overflow-wrap:anywhere; }

/* The sidebar is narrow — often ~300px, not the 640px an editor tab gets. Below that, the
   title and the skin picker stop competing for one line and 48px of horizontal padding
   stops eating a sixth of the width. */
@media (max-width: 480px) {
  main { padding:16px 12px 32px; }
  .step-head { flex-direction:column; gap:8px; }
  .step-head h1 { max-width:100%; }
  fieldset.dial label { margin-right:12px; }
}
`;

/**
 * Every option that is not what the author did: plain text/list markup, a "coming with T-10"
 * badge, and — deliberately — no `<button>`, no `<input>`, nothing in the DOM to select. The
 * author's own choice gets a distinct badge instead and no interactive markup either, since
 * nothing on this page is selectable yet (recreate mode; see the file header).
 *
 * Three review fixes live in this one function, and each is load-bearing:
 *
 *   - **`authorChoice` is a fallback for `taken`** (code review, finding 6). Resolved to ONE
 *     index before anything is drawn, so a plan cannot mark two options, and so a plan with
 *     `authorChoice` set but no `taken` anywhere still satisfies AC2 instead of badging every
 *     option "coming with T-10" and marking none.
 *   - **The list is capped** at `MAX_OPTIONS_RENDERED` (security, finding 3) — and the count
 *     of what is NOT drawn is printed under it. Never delete that line to tidy the markup:
 *     the cap is only defensible because the page admits to it.
 *   - **Nothing here trusts a field's declared type.** `opt.label.trim()` threw on a plan
 *     whose label was not a string, in a render nobody was listening to (security, finding 5).
 *     `planText`/`planId` make every read total.
 */
function optionsHtml(options: OptionLike[], authorChoice: unknown): string {
  const all = Array.isArray(options) ? options : [];

  // `taken` first — it is what every real plan carries, and what a learner's own future
  // choice (T-10) will set. `authorChoice` only answers when `taken` answers nothing at all.
  const takenIndex = all.findIndex((opt) => opt?.taken === true);
  const choice = planId(authorChoice);
  const authorIndex = takenIndex !== -1
    ? takenIndex
    : (choice === '' ? -1 : all.findIndex((opt) => planId(opt?.id) === choice));

  // AC2 outranks the cap. If a hostile plan buries the author's own option behind five
  // thousand alternatives, the option that AC2 requires to be marked takes the window's last
  // slot rather than being one of the ones dropped — a capped page that showed no marked
  // choice would be a page that met the security fix by breaking the acceptance criterion.
  const shown = all.slice(0, MAX_OPTIONS_RENDERED);
  let markedIndex = authorIndex;
  if (authorIndex >= MAX_OPTIONS_RENDERED) {
    shown[MAX_OPTIONS_RENDERED - 1] = all[authorIndex]!;
    markedIndex = MAX_OPTIONS_RENDERED - 1;
  }
  const omitted = all.length - shown.length;

  const items = shown
    .map((opt, i) => {
      const isAuthors = i === markedIndex;
      const cls = isAuthors ? 'option option-taken' : 'option option-alt';
      const label = planText(opt?.label);
      // The badge is suppressed when it would only repeat the option's own label. That is
      // not a rare tidy-up: a plan built with no interpretation gives every step exactly one
      // option, labelled "What the author did" by repo-tour itself, so the badge said it
      // twice in a row on all 61 steps of the first real plan we rendered. The author's
      // choice is still marked — `.option-taken` carries the accent border and highlight —
      // and the badge comes back the moment a plan has options whose labels differ.
      const badge = isAuthors
        ? (label.trim().toLowerCase() === AUTHOR_BADGE.toLowerCase() ? '' : `<span class="badge badge-taken">${AUTHOR_BADGE}</span>`)
        : `<span class="badge badge-t10">${T10_BADGE}</span>`;
      return `<li class="${cls}" data-option-id="${escapeAttr(planId(opt?.id))}">${badge}<span class="option-label">${escapeHtml(label)}</span><p class="option-consequence">${escapeHtml(planText(opt?.consequence))}</p></li>`;
    })
    .join('');

  const omittedNote = omitted > 0
    ? `<p class="options-omitted">${escapeHtml(optionsOmittedMessage(omitted))}</p>`
    : '';
  return `<ul class="options">${items}</ul>${omittedNote}`;
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
    return `<section class="check"><h2>${escapeHtml(CHECK_HEADING)}</h2>${summaryHtml}${reasonHtml}<p class="check-aside">${escapeHtml(CHECK_PARSE_MESSAGE)}</p></section>`;
  }

  const symbols = checkListHtml(report.symbols, 'export', true);
  const imports = checkListHtml(report.imports, 'import', false);
  return `<section class="check"><h2>${escapeHtml(CHECK_HEADING)}</h2>${summaryHtml}${symbols}${imports}</section>`;
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
      const mine = turn?.role === 'user';
      return `<li class="tutor-turn ${mine ? 'turn-user' : 'turn-tutor'}">`
        + `<span class="turn-who">${escapeHtml(mine ? USER_TURN_LABEL : TUTOR_TURN_LABEL)}</span>`
        + `<div class="turn-text">${answerHtml(turn?.content)}</div>`
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
  const input = `<textarea class="tutor-input" id="tutor-input" rows="3" maxlength="${MAX_ASK_TEXT}"`
    + ` placeholder="${escapeAttr(ASK_PLACEHOLDER)}"${thinking ? ' disabled' : ''}></textarea>`;

  const controls = thinking
    ? `<span class="tutor-thinking" id="tutor-thinking">${escapeHtml(THINKING_MESSAGE)}</span>`
      + `<button type="button" class="btn" id="btn-tutor-cancel">${escapeHtml(CANCEL_BUTTON_LABEL)}</button>`
    : `<button type="button" class="btn" id="btn-tutor-ask">${escapeHtml(ASK_BUTTON_LABEL)}</button>`;

  return `<section class="tutor"><h2>${escapeHtml(TUTOR_HEADING)}</h2>`
    + transcriptHtml(state.transcript)
    + note
    + unreachable
    + `<div class="tutor-ask">${input}<div class="tutor-controls">${controls}</div></div>`
    + '</section>';
}

function bodyHtml(state: StepViewState, skins: SkinsModule): string {
  const step = state.step;
  const currentDial: Dial = resolvedDial(state.dial);

  return `
<main id="step-main" data-step-id="${escapeAttr(planId(step.id))}">
  <div class="step-head">
    <h1>${escapeHtml(planText(step.decision.question))}</h1>
    ${pickerHtml(skins.SKINS, state.skin)}
  </div>

  <section>
    <h2>Options</h2>
    ${optionsHtml(step.decision.options, step.decision.authorChoice)}
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
  var initial = restore();
  if (initial && initial.stepId === stepId) {
    if (typeof initial.note === 'string') { savedNote = initial.note; }
    if (typeof initial.draft === 'string') { savedDraft = initial.draft; }
  }
  // ONE blob, written whole every time. Two writers each calling save() with only their own
  // field would each erase the other's — the note would eat the draft on the next reply, and
  // the draft would eat the note on the next keystroke.
  function persist() { save({ stepId: stepId, note: savedNote, draft: savedDraft }); }

  var initialNoteEl = document.getElementById('step-note');
  if (savedNote && initialNoteEl) { initialNoteEl.textContent = savedNote; }

  // T-6. The box is empty in the markup — the host does not know what somebody is halfway
  // through typing — so this is the only thing that can put a draft back. It matters far more
  // here than the note does: the panel REPAINTS when the transcript grows, which is exactly
  // the moment the tutor answers, which is exactly when a learner is most likely to be typing
  // their follow-up. Without this, every answer would delete the next question.
  var inputEl = document.getElementById('tutor-input');
  if (inputEl && savedDraft) { inputEl.value = savedDraft; }

  function on(id, type, handler) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener(type, handler); }
  }

  on('btn-prev', 'click', function () { post('step:prev', {}); });
  on('btn-open', 'click', function () { post('step:open', {}); });
  on('btn-check', 'click', function () { post('step:check', {}); });
  on('btn-next', 'click', function () { post('step:next', {}); });
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
   * The draft is cleared BEFORE the post, not after: the text is about to become a turn in the
   * transcript, the repaint that draws it will rebuild this box empty, and a saved draft left
   * behind would then be re-applied on top and the learner would find their question typed
   * twice — once in the conversation and once in the box.
   */
  function askTutor() {
    var box = document.getElementById('tutor-input');
    if (!box) { return; }
    var text = box.value;
    box.value = '';
    savedDraft = '';
    persist();
    post('tutor:ask', { text: text });
  }

  on('btn-tutor-ask', 'click', askTutor);
  on('btn-tutor-cancel', 'click', function () { post('tutor:cancel', {}); });

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
      persist();
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
    body: `<main class="notice-only"><p class="notice">${escapeHtml(notice)}</p></main>`,
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
  return [shown.map((turn) => [turn?.role, keyOf(turn?.content, MAX_REPLY_TEXT)]), turns.length];
}

export function stepRenderKey(state: StepViewState, skins: SkinsModule): string {
  const { decision, id, witness } = state.step;
  const report = state.check?.report;
  return JSON.stringify([
    keyOf(id),
    keyOf(decision.question),
    keyOfList<OptionLike | undefined>(decision.options, MAX_OPTIONS_RENDERED, (option) => [
      keyOf(option?.id), keyOf(option?.label), keyOf(option?.consequence), option?.taken,
    ]),
    keyOf(decision.authorChoice),
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
    // ── T-6: the tutor. Every one of these four is drawn by `tutorHtml`, and every one of
    // them is a "stored on the host and never shown" bug if it is dropped from here. The
    // thinking state is the worst of the four to lose: the *Ask* button would go on looking
    // pressable while a question was in flight, and the answer would appear only when
    // something else forced a repaint — which reads exactly like a tutor that ignores you.
    keyOfTranscript(state.transcript),
    state.tutor
      ? [state.tutor.thinking, keyOf(state.tutor.unreachable ?? null), keyOf(state.tutor.note ?? null, MAX_PLAN_TEXT)]
      : null,
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
