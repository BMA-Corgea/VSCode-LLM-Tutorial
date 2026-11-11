// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WalkSession — the walk's state machine (spec §5.3; AC1, AC3, AC4, AC6). One instance per
 * open build: it owns the plan, the progress, and the answer to "which step is the learner
 * on", and it is the ONLY thing that pushes that answer outward. The decision tree, the step
 * panel, the status bar and the editor never talk to each other and never hold truth of their
 * own — each is handed a `WalkView` and renders it — which is the same "the host is the only
 * truth" discipline `src/start/panel.ts` established for the start screen (spec §5.1), moved
 * up one level because the walk has FOUR surfaces to keep in agreement instead of one.
 *
 * **No `vscode` import, value or type — and here that is load-bearing, not stylistic.**
 * `esbuild.mjs`'s `test/unit/*.test.ts` bundle is built with `external: ['repo-tour',
 * 'mocha']` and deliberately NOT `vscode`, because a unit test must never need an extension
 * host to run. So anything reachable from a `test/unit/` file that touches the real `vscode`
 * module fails to BUNDLE — `Could not resolve "vscode"`, at build time, taking the whole unit
 * suite with it. The plan's own step 5 asks for "a unit test of the state machine with fake
 * adapters", which is only possible if this file is reachable from `test/unit/`. Hence
 * `WalkAdapters`: plain duck-typed functions, no `vscode.ExtensionContext`, no
 * `vscode.TextEditor`, no `vscode.Uri`, nothing this file cannot honestly type on its own.
 * (The plan's shorthand `WalkSession.open(context, target, deps)` is superseded by exactly
 * that: `src/extension.ts` closes the context INTO the adapters it builds.) Every adapter
 * that really does import `vscode` — `tree.ts`, `step-panel.ts`, `editor.ts`, `status.ts` —
 * lives behind this interface and is exercised from `test/walk.test.ts` instead, the same
 * split `src/start/{protocol,view}.ts` versus `src/start/panel.ts` already draws.
 *
 * Four things about the shape below are worth reading before changing it:
 *
 *   - **`refresh` is the only way state leaves this object.** Every public method mutates
 *     `progress` and then hands off to `commit`, which persists and pushes — there is no
 *     second path that writes without pushing, and none that pushes to one surface and not
 *     the others, so the tree, the panel and the status bar cannot drift apart. That is also
 *     why `WalkView` bundles `plan`, `progress`, `step` and `fileExists` into one value rather
 *     than four `set*` calls: a surface is handed one consistent snapshot, never a
 *     half-updated pair of them. **A failed WRITE may not suspend that rule** — see `commit`,
 *     and code review finding 4, which was exactly the session advancing while every surface
 *     went on showing the step before it.
 *   - **`refresh` takes `revealEditor` as a parameter.** Real navigation (`open`, `goTo`,
 *     and so `next`/`prev`) reveals and decorates the target range; `setDial` and `markDone`
 *     refresh the tree, the panel and the status bar but skip the reveal. Re-centring the
 *     editor every time the learner clicks a dial radio on the step they are already looking
 *     at is not incorrect, just needless jank — and jank in the one window they are trying to
 *     read code in. T-5 adds the one other reveal, and it exists because of the ORDER those
 *     two run in: the entry pass writes the step's file after `goTo` has already refreshed and
 *     found nothing there, so the pass reveals the file it made appear — and only that file
 *     (code review finding 2; `applyDial`'s `appeared` is the whole condition).
 *   - **`fileExists` gates the reveal itself, not merely the panel's button.** In manual mode
 *     with nothing written yet (T-5's job, not this ticket's) `<target>/<step.target.file>`
 *     genuinely does not exist, and `vscode.workspace.openTextDocument` on a missing path
 *     REJECTS — a rejection nobody is listening for, from inside a `void`-ed promise. So a
 *     step whose file is not there yet gets `clearEditor()` (drop the previous step's
 *     decorations, leave the editor alone) and the panel says why, honestly, where the eye
 *     already is (conventions.md: never a silent no-op).
 *   - **A `target.file` that escapes the target folder is not openable either.**
 *     `resolveInsideTarget` (`./paths.ts`), never `path.join`, is what turns a step's relative
 *     path into an absolute one; a `null` from it means the plan pointed OUTSIDE the folder
 *     the learner is working in, and this code runs automatically on activation, so there is
 *     no gesture at all between a crafted `plan.json` and an opened file (security review
 *     finding 2). That answer collapses into `fileExists: false` on purpose rather than
 *     growing a state of its own: "there is nothing to open here" is already a case every
 *     surface downstream renders honestly, and the learner — who did not write the plan and
 *     has nothing to fix in it — is shown no error for it.
 *
 * **The reload drill (AC4) is the point of the whole design.** Nothing here is cached beyond
 * one instance's lifetime and nothing is memoised across instances: `open` reads the plan and
 * the progress back through the adapters every single time, so `dispose()` followed by a
 * fresh `open` on the same target lands on the same step for exactly one reason — the current
 * step is on disk in `<target>/.repo-tour/build/progress.json`, written by
 * `adapters.saveProgress` the moment it changed, and read back by `adapters.loadProgress`.
 * The session is a view onto that file, never its owner.
 *
 * ## T-5 — the dial, the check and the commit (spec §5.4; ACs 1, 2, 4, 5, 7)
 *
 * T-4 shipped a walk that could show a dial and remember which position the learner dragged
 * it to, and deliberately stopped there. This is where those positions start costing bytes on
 * the learner's disk, so five things about the wiring are worth reading before touching it.
 *
 *   - **The dial is RESOLVED here, once, and handed out on the view.** `stepDial` (`./
 *     model.ts`) is AC1's rule — this step's override, else the global from `request.json`,
 *     else `manual` — and no surface may re-derive it, because a status bar and a panel that
 *     each ran their own fallback are two answers to a question with one. The global is read
 *     ONCE, at `open`, through `adapters.loadRequest`: the same round-trip discipline the
 *     plan and the progress get, so the reload drill covers the dial too.
 *   - **Writing is asynchronous; navigating is not.** `adapters.confirmOverwrite` is a real
 *     modal, and repo-tour's core arrives from an `await`, so applying a dial cannot be part
 *     of `goTo`'s synchronous "persist → refresh" pass. It is a job put on `work`, a single
 *     serialised promise chain that also OWNS every failure: nothing in it is `void`ed into
 *     the dark, and anything that throws lands in `reportError` — the same honest channel a
 *     failed `saveProgress` uses, and the reason `src/dial/check.ts` insists its callers await
 *     rather than fire-and-forget. One chain rather than one promise per click is deliberate:
 *     the tree can fire `goTo` faster than a write completes, and two writes racing the same
 *     file is the one way `writeTextAtomic`'s atomicity could still lose. Serialised means
 *     DEFERRED, never dropped — a pass belongs to the step the walk ENTERED, and `applyDial`
 *     argues at length why one whose step is no longer current still has to run.
 *   - **Never prompt twice for the same (step, file) in one session.** This is the plan's own
 *     named write-ahead risk, and the reason is mechanical rather than theoretical: the tree
 *     re-fires `goTo` for the step already current (that is how a learner asks for their file
 *     back), so an overwrite prompt raised from inside the entry pass would come back every
 *     single time until they answered it the way it wanted. `prompted` remembers the pair,
 *     and a pair already asked about is answered by the learner's FIRST answer — *Keep mine*
 *     keeps meaning keep mine, for the rest of the session, without asking again. The one
 *     exception is an explicit `dial:set` on the step in front of the learner: that is a new
 *     deliberate gesture rather than the tree re-firing, and `setDial` forgets that step's
 *     answers so the new position may ask again (code review finding 5). Without it, one
 *     *Keep mine* killed the dial for that step — the control's own documented promise, "drag
 *     it to automated and the file should be there", answered by a remembered refusal.
 *   - **Identical content is not a conflict.** A file that already holds exactly the bytes
 *     the dial would write is left alone with nothing said: no prompt, no rewrite, no note. It
 *     is the ordinary state of a step re-entered after it was written, and prompting there
 *     would teach the learner to dismiss the one dialog that is supposed to protect their work.
 *   - **The never-taught files are the learner's too.** `plan.reproduce`'s generated, vendored
 *     and lockfile paths are copied by an ARRIVAL in automated mode as well as by a press, so
 *     the same rule governs them: an arrival copies what is absent or already identical and
 *     holds back anything it would overwrite until the count has been said (security review
 *     finding 3). A learner who ran `npm install` in the target — which the spec leaves to
 *     them on purpose — has a `package-lock.json` that is theirs, not the reference's.
 *   - **`writeNote` describes an ACTION, not a step.** It is keyed to the step it was produced
 *     for and disappears the moment the walk moves, because "your version was kept" is true
 *     of something that just happened and false of a step you have merely arrived at. The same
 *     goes for `shape` and for the in-memory `check` outcomes: the durable half of a check is
 *     `progress.steps[id].check` (the tree's ✓/✗, which survives a reload); the full report is
 *     this session's, and a reload honestly shows no report rather than a remembered one.
 *
 * **Nothing on the automated path normalises anything** (AC6). `planWrite` hands over the
 * reference file's exact bytes and `writeTextAtomic` writes exactly those; there is no
 * trailing newline added here, no line-ending translation, no re-encoding. Walking every step
 * in automated mode has to reproduce the reference byte-for-byte, and `diff -r` is not a
 * metaphor.
 *
 * ## T-6 — the tutor (spec §5.5; ACs 2, 3, 4)
 *
 * The walk gains the one thing that costs the learner money, and three of its rules are
 * unlike anything above them:
 *
 *   - **An ask is NOT on the serialised chain; only its delivery is.** Everything T-5 added
 *     goes through `enqueue` because two writes racing one file is the failure that matters
 *     there. An ask writes nothing until it answers, and it can sit with a model for two
 *     minutes — so serialising it would mean a learner who asked a question could not have the
 *     next step's file written until the answer came back. It runs beside the chain and hands
 *     its outcome back to `enqueue`, which keeps every mutation of `progress` in one order
 *     while keeping the wait out of everyone else's way. `settled()` closes the gap that
 *     opens; see there.
 *   - **No spinner is ever left running** — AC4, entire. `asking` is the single answer to "is
 *     something in flight", `TutorView.thinking` is derived from it rather than tracked beside
 *     it, and `deliverAsk` clears it before it looks at the outcome, so no branch that exists
 *     and no branch anybody adds later can end with a spinner and nothing behind it.
 *   - **`AskLedger` is what stops a runaway billed request** — a name, not a list. One ledger
 *     per session owns every ask this walk starts: `beginAsk` opens a TICKET at the press
 *     (which is what puts the pre-flight on camera and makes *Cancel* able to stop it before
 *     anything is sent), the ledger bounds the deadline, chooses the neutral directory the
 *     provider runs in, and sums what came back. `cancelAsk` goes through
 *     `AskLedger.abandonAll()` rather than through the one ticket this object happens to hold,
 *     so the control reaches a live ask on any step; `TutorView.spend` and
 *     `TutorView.elsewhere` are read off the same ledger, which is why neither can be stale.
 *     Nothing here reaches a provider by any other route.
 *   - **Cancel detaches; it does not kill.** repo-tour's `killLlmChildren` kills every live
 *     child, so cancelling one question would kill a background build. `AskTicket.abandon()`
 *     severs delivery instead: the answer to a question the learner walked away from can never
 *     reach their transcript, the request is still finishing, and the panel says so — including
 *     that it is still being billed, which the ledger counts rather than merely asserting.
 *     Before the send there is nothing to detach from, so a cancel there is a real
 *     cancellation and the sentence says that instead. `dispose()` closes the ledger.
 *   - **A refusal never eats the question.** Four of the answers below are decided AFTER the
 *     press, so the page cannot know from the press alone whether the learner's text is safe
 *     to throw away. `TutorView.accepted` is the host naming the question it really sent, and
 *     its absence is what leaves a minute of somebody's typing where they left it.
 *
 * The durable half is the transcript: one per step in `progress.steps[id].transcript`, written
 * through the same atomic `saveProgress` as everything else, and read back ONLY through
 * `getTranscript`. The transient half — thinking, the unreachable line, the note about a
 * timeout — is this object's and dies with it, exactly like `writeNote` and the check reports.
 */

import type { GitRunner } from '../start/build.js';
import type { Dial } from '../start/request.js';
import type { ResolvedRequest } from './store.js';
import { commitStep, ensureTranscriptIgnored, type CommitResult } from '../dial/commit.js';
import type { DialCore } from '../dial/core.js';
import {
  // Aliased for the same reason `markDoneIn`/`setDialIn` are below: this class's own
  // `runCheck()` is the method a panel button calls, and `runStructuralCheck` is the module
  // that actually compares two files. A reader scanning one should never have to work out
  // which of the two they are looking at.
  runCheck as runStructuralCheck,
  type CheckOutcome,
} from '../dial/check.js';
import {
  fileShape,
  isRefusal,
  planWrite,
  deliverableEntries,
  reproduceFiles,
  writeTextAtomic,
  type FileShape,
} from '../dial/writer.js';
import {
  AskLedger,
  checkReachable,
  type AskOutcome,
  type AskSettings,
  type AskSpend,
  type AskTicket,
} from '../tutor/ask.js';
import { DetourSession, type DetourAdapters, type DetourView } from '../detour/session.js';
import { tutorialId } from '../detour/store.js';
import { tutorContext } from '../tutor/context.js';
import type { AskMessage, TutorCore } from '../tutor/core.js';
import { appendTurn, clearTranscript, getTranscript, sentTurns } from '../tutor/transcript.js';
import {
  currentStep,
  nextStepId,
  prevStepId,
  setCheck,
  setCurrent,
  statusText,
  stepDial,
  // Aliased: the two pure `Progress` transformers below share their names with this class's
  // own `setDial`/`markDone` methods. TypeScript resolves the two apart without help (a
  // method needs `this.`), but a reader scanning `setDial` inside `setDial` should not have
  // to work that out from scratch.
  markDone as markDoneIn,
  setDial as setDialIn,
  setChosen as setChosenIn,
  optionsTable,
  withChosen,
  type PlanLike,
  type Progress,
  type StepLike,
} from './model.js';
import { resolveInsideTarget } from './paths.js';

/**
 * One consistent snapshot of "where the walk is", as every surface sees it. Structurally this
 * is `StepViewState` (`src/walk/step-protocol.ts`) minus the two fields that are the step
 * panel's OWN local state and deliberately not the session's — `skin` and `note` (see that
 * file, and handoff T-4 item 2) — so `StepViewProvider` builds what it renders by spreading a
 * `WalkView` and adding those two, rather than this file growing panel concerns it has no
 * business persisting.
 *
 * `plan` and `progress` are handed out by reference and must be treated as immutable:
 * `model.ts`'s transformers all return new objects, and this session replaces its `progress`
 * rather than editing it in place, so a surface holding an older `WalkView` still holds a
 * coherent (merely stale) picture — which is exactly what makes the panel's "did the step
 * actually change?" comparison against its previous view meaningful.
 */
/** What the panel says when a choice names no road the page offers at this step (T-21) — a stale or forged page. */
export const CHOICE_NOT_AN_OPTION = 'That is not one of this step\u2019s options, so nothing was recorded.';
/** What the panel says when the road pressed is the one already taken (T-21, T-15). */
export const CHOICE_ALREADY_TAKEN = 'That is already the road this step is on.';
/** What the panel says when the press came from a page for a step the learner has left (T-21, AC2). */
export const CHOICE_STALE_PAGE = 'That press was for a step you have since left, so nothing was recorded.';

/**
 * A refusal, in words, and how many times in a row it has been given (T-21, AC5). A refused press
 * must change the screen and a second identical one must change it again: the same sentence twice
 * is the same frame twice, which is T-15's defect one press later. So the count goes in the words,
 * the same way the start screen's `inARow` does.
 */
export function choiceRefusalText(reason: string, inARow: number): string {
  return inARow > 1 ? `${reason} Tried ${inARow} times.` : reason;
}

export interface WalkView {
  plan: PlanLike;
  progress: Progress;
  /** The CURRENT step, already resolved — no surface has to re-derive it from `progress`. */
  step: StepLike;
  /** Whether `<target>/<step.target.file>` exists on disk, as of this refresh. */
  fileExists: boolean;
  /**
   * T-5 (AC1): the RESOLVED dial for this step — its own override, else the global from
   * `request.json`, else `manual`. Resolved ONCE, here, by `stepDial`: a surface that ran its
   * own fallback would be a second answer to a question that has one, and T-4's status bar
   * already proved how that goes wrong (it read the override alone and quietly said `manual`
   * at a learner who had set the global to `automated` on the start screen).
   */
  dial: Dial;
  /**
   * T-5 (AC2), manual mode only: what to write, never the answer — the signature line of each
   * load-bearing range and the reference file's imports. Absent in every other position,
   * because in every other position the file itself is on disk to look at.
   */
  shape?: FileShape;
  /**
   * T-5 (AC5): the last structural check for THIS step, with its full report. `undefined`
   * means nobody has pressed *Check my work* here — which is NOT the same as a check that ran
   * and failed, and the tree renders the two differently. Held in memory only: the durable
   * half is `progress.steps[id].check`, so a reload honestly shows no report rather than
   * pretending to remember one it never stored.
   */
  check?: CheckOutcome;
  /**
   * T-5: a transient sentence about the last write — refused, kept, overwritten, written, or
   * (after a passed check) not committed. Cleared when the step changes, because it describes
   * an ACTION and not a step: "your version was kept" is true of something that just happened
   * and false of a step the learner has merely arrived at.
   */
  writeNote?: string;
  /**
   * T-21 (AC5): why the last press of *Choose this instead* was refused, with the count once it
   * has been refused more than once in a row. Drawn beside the options list, where the press was
   * — not with `writeNote` under the dial, a screen away. Cleared by a recorded choice and by
   * moving; held in memory only, because it describes a press and not the walk.
   */
  choiceNote?: string;
  /**
   * T-5 (AC6): `plan.reproduce`'s never-taught files — generated, vendored, lockfiles, data,
   * binaries. Absent when the plan lists none, so the panel has nothing to offer rather than
   * an offer of nothing. `done` is `progress.reproduced`, which survives a reload.
   */
  reproduce?: { count: number; done: boolean };
  /**
   * T-6 (AC2): THIS step's conversation with the tutor, oldest turn first.
   *
   * Read only through `src/tutor/transcript.ts`'s `getTranscript`, never off
   * `progress.steps[id].transcript` directly, and that is not a style preference — `store.ts`
   * validates `check` and passes `transcript` through untouched, so `getTranscript` is the one
   * place anything decides what is safe to render back to a learner as their own words. A
   * caller that reached past it would be handing the panel whatever a hand-edited
   * `progress.json` happened to contain.
   *
   * Required rather than optional: a step nobody has asked about has an empty conversation,
   * which is a real state the page draws, and `undefined` would be a second spelling of it.
   */
  transcript: AskMessage[];
  /** T-6 (AC4): what the tutor is doing, as opposed to what it has said — see `TutorView`. */
  tutor?: TutorView;
  /**
   * T-7: the detour's transient state — is one being written, is one open, and what the last
   * attempt had to say (`DetourView`, `src/detour/session.ts`).
   *
   * Always present, like `tutor` and unlike T-5's four: "nothing open, nothing generating" is
   * a real and drawable state — it is what puts *Show me an unrelated example* on the page —
   * so there is nothing for an absent key to mean. **Every field of it is in
   * `stepRenderKey`** (plan R4): a field the panel draws and the key omits is stored on the
   * host and never shown, which fails no test and is this repository's most-repeated lesson.
   */
  detour: DetourView;
}

/**
 * The tutor's transient state: never in `progress.json`, and every field of it is about the
 * MOMENT rather than about the step (contrast `transcript`, which is the durable half).
 *
 * `thinking` is the one AC4 turns on. The session clears its in-flight ask BEFORE it decides
 * what to say about the outcome, so a spinner cannot outlive the request that raised it — not
 * on a reply, not on a timeout, not on a failure, and not on an outcome nobody anticipated.
 * "No spinner is ever left running" is the whole of that criterion, and it is a property of
 * the ORDER those two lines are written in, which is why they are commented where they sit.
 *
 * `unreachable` carries the PROVIDER's own sentence ("not found on PATH") rather than a house
 * phrasing, and outlives one ask: a `claude` that is not installed is not installed for the
 * rest of the session, and the line belongs beside the input the whole time.
 *
 * `note` is a sentence about the conversation that is deliberately not a turn in it. The
 * distinction is the plan's, made explicitly: `AskMessage` stays pure, so a timeout is never
 * stored as something the tutor said and never sent back to a model as though it were.
 */
export interface TutorView {
  thinking: boolean;
  unreachable?: string;
  note?: string;
  /**
   * WHICH half of the wait `thinking` is about — the sentence only.
   *
   * `thinking` stays the single answer to "is a spinner on screen"; both are derived from
   * `this.asking` in the same expression, so the two cannot drift. The distinction is worth
   * drawing because the two halves are different promises to the learner: `preparing` is the
   * availability probe and the diff, during which nothing has been sent and nothing is
   * charged, and `sending` is a request with a provider that is billing right now. Saying
   * "thinking…" through a fifteen-second `claude --version` would be a small lie told at the
   * exact moment a learner is deciding whether the button worked.
   */
  stage?: 'preparing' | 'sending';
  /**
   * An ask that is live on a DIFFERENT step (code review finding 3).
   *
   * `thinking` is per-step by design — a learner who navigates away must not find a spinner on
   * the step they arrived at — and the consequence was that navigating away left a billing
   * request with no control anywhere in the UI to stop it, under a note telling them to press
   * a *Cancel* that was on the page they had left. The tutor section now says where the ask
   * is and offers to stop it from wherever the learner is standing.
   */
  elsewhere?: { stepId: string; stage: 'preparing' | 'sending' };
  /**
   * What this walk has spent, and what is spending right now (code review finding 5).
   *
   * `AskCost` was computed on every reply, carried through `AskOutcome` and read nowhere —
   * in a module whose header argues that "a tutor that quietly bills is not honest". This is
   * the observable half: it comes off `AskLedger.spend()`, which is complete by construction
   * because the ledger is the only thing that starts a paid request. Rendered on every step,
   * because it is the WALK's spend rather than the step's.
   */
  spend?: AskSpend;
  /**
   * The question the session has just accepted and sent — the page's signal that its draft
   * became a turn (code review findings 1, 2 and 3's shared root).
   *
   * The client script used to empty the box on the press, so the four refusals that are
   * decided AFTER the press — provider unreachable, no `request.json`, no core, one ask
   * already in flight — each destroyed the learner's question: gone from the box, gone from
   * the saved blob, and deliberately not in the transcript. It was nowhere. Now the page keeps
   * its draft until the host says it took it, and this is the host saying so: the script drops
   * the draft only when it matches this, so a refusal leaves the question exactly where the
   * learner typed it, with the reason beside it.
   *
   * Tagged to a step by construction (it is only ever set for the step the ask was made on)
   * and cleared when the walk moves, like `note`.
   */
  accepted?: string;
}

/**
 * Everything this state machine cannot do by itself, as plain functions. Duck-typed on
 * purpose (see the file header): a unit test passes fakes that merely record what they were
 * handed, and `src/extension.ts` passes the real thing — `store.ts`'s `loadPlan`,
 * `loadProgress` and `saveProgress` can be wired in as-is, since their signatures are exactly
 * the three named here, and `fileExists` is `fs.existsSync`.
 *
 * `setTree`/`setPanel` take `WalkView | undefined` rather than a separate `clear()` because
 * "there is nothing to show" is a state the walk can legitimately be in (a plan with no steps
 * at all; a disposed session), and giving it its own message would let a surface miss it.
 */
export interface WalkAdapters {
  /** Re-render the decision tree from this view — `undefined` means "show nothing". */
  setTree(view: WalkView | undefined): void;
  /** Re-render the step panel from this view — `undefined` means "show nothing". */
  setPanel(view: WalkView | undefined): void;
  /** Status bar text (`statusText`, AC6); the empty string when there is no current step. */
  setStatus(text: string): void;
  /** Open the target file, reveal the step's range, decorate its load-bearing lines (AC3).
   *  Only ever called when `view.fileExists` — see the file header. */
  revealEditor(view: WalkView): void;
  /** Drop the previous step's decorations. Safe to call when there are none. */
  clearEditor(): void;
  /** Bring the target file to the front on the learner's own explicit request (`step:open`). */
  openFile(view: WalkView): void;
  fileExists(absPath: string): boolean;
  loadPlan(target: string): PlanLike;
  loadProgress(target: string, plan: PlanLike): Progress;
  saveProgress(target: string, progress: Progress): void;
  /** A failure the learner needs to know about, in their words — `src/extension.ts` routes it
   *  to the output channel and a notification. Never called for anything they can fix by
   *  waiting; a walk that has stopped saving is not that. */
  reportError(message: string): void;

  // ── T-5 ─────────────────────────────────────────────────────────────────────────────────

  /**
   * `<target>/.repo-tour/build/request.json` — what was ASKED for when this tutorial was
   * built. `src/walk/store.ts`'s `loadRequest` wires in as-is; this session reads exactly two
   * fields off it, `repo` (the REFERENCE ROOT every position that writes copies from) and
   * `dial` (AC1's global setting).
   *
   * `null` is an ordinary answer, not an error: a plan on disk without the request that
   * produced it is a folder someone assembled or half-copied by hand. It can be walked — the
   * plan carries the decisions — it simply cannot be written INTO, since there is nothing to
   * copy from, so every position behaves like `manual` and nothing is claimed on the learner's
   * behalf.
   */
  loadRequest(target: string): ResolvedRequest | null;
  /**
   * repo-tour's core, lazily. A PROMISE rather than the getter `StepPanelDeps.skins` uses,
   * and the difference is load-bearing: `activate()` is synchronous and opens the walk before
   * `loadCore` has resolved, so a getter would hand back `undefined` for exactly the moment a
   * resumed walk applies its first dial — a learner reopening a folder mid-tutorial in
   * automated mode would find the current step's file unwritten, and only writing once they
   * navigated. Awaiting it costs nothing (the entry pass is already async for
   * `confirmOverwrite`) and closes the race outright. `src/extension.ts` memoises the load, so
   * this is one `await` on an already-settled promise from the second call onward.
   *
   * `undefined` means repo-tour is not loadable at all — a standing condition the doctor
   * explains — and nothing is written or checked while it holds. Scaffolding without the core
   * is the case that matters: `stubFile` is the only thing that HIDES the load-bearing lines,
   * so "write it anyway" would hand the learner the answer under the label of a scaffold.
   */
  core(): Promise<DialCore | undefined>;
  /**
   * The text `absPath` currently holds, or `undefined` when there is nothing there (or it
   * cannot be read). This is what both overwrite decisions read — the step's own file in
   * `writeFile`, and a `plan.reproduce` entry in `wouldReplace` — so it is a question about the
   * learner's disk, which is what an adapter is for, rather than an `fs` import this file has
   * never needed (`./paths.ts` states that constraint out loud). Wire it as a
   * `readFileSync(absPath, 'utf8')` inside a `try`.
   *
   * It is asked about the REFERENCE tree as well as the target (`wouldReplace` compares the
   * two), so nothing here may assume the path sits under `target`.
   */
  readText(absPath: string): string | undefined;
  /**
   * *Overwrite* / *Keep mine* — `true` to overwrite, for a file that exists and DIFFERS from
   * what the dial would write (spec §5.4: never overwrite a learner's edits silently). Takes
   * the RELATIVE path because it is shown to a person who thinks in the paths their editor
   * shows them, not in absolute ones. Injected rather than called directly so the whole rule —
   * asked on a real difference, asked once per (step, file), obeyed afterwards — is testable
   * with no editor anywhere near it.
   */
  confirmOverwrite(relPath: string): Promise<boolean>;
  /** `git`, for the commit per completed step (AC7) and for the tutor's pre-flight diff.
   *  `src/start/build.ts`'s `realGit` wires in as-is; `src/dial/commit.ts` is what actually
   *  holds the git knowledge, including the rule that a missing identity is a refusal and never
   *  an invented author. Every call this session makes takes the runner's SHORT bound — thirty
   *  seconds, the default (T-13) — because every one of them is a sub-second local operation
   *  sitting under a control somebody just pressed. The long tier exists for the clone, which
   *  happens in `src/start/build.ts` and never here. */
  git: GitRunner;
  /** `buildTutorials.commitPerStep`. A getter, read at the moment of the commit rather than
   *  captured at `open`, so a learner who turns it off mid-walk is obeyed on their next step
   *  instead of on their next window. */
  commitPerStep(): boolean;

  // ── T-6: the tutor ──────────────────────────────────────────────────────────────────────

  /**
   * The tutor's slice of repo-tour, lazily — a promise for the same reason `core()` is one,
   * and `undefined` when repo-tour is not loadable at all.
   *
   * **OPTIONAL, unlike every adapter above it, and that is a decision rather than an
   * oversight.** The tutor is the one capability of this walk that can be entirely absent: a
   * session driven with no tutor wired is a walk with no *Ask* — every other surface works, no
   * position of the dial changes, and nothing is silently degraded. Requiring it would force
   * every adapter set that has nothing to do with a model to stub one, including
   * `test/dial.test.ts`'s, which exists to prove a learner's bytes survive a real write path
   * and has no business naming a provider to do it. An absent adapter and a `tutorCore()` that
   * resolves `undefined` are answered identically here — a sentence in the panel, never a
   * broken walk — so the optionality costs nothing in behaviour.
   *
   * Kept apart from `core()` because the two answer different questions: the dial's core is
   * reached on every navigation and its absence stops writes; this one is reached only when
   * somebody asks.
   */
  tutorCore?(): Promise<TutorCore | undefined>;
  /**
   * `buildTutorials.llmProvider`, `buildTutorials.tutorModel` and
   * `buildTutorials.tutorTimeoutSeconds`, as of RIGHT NOW.
   *
   * A getter for the reason `commitPerStep` is one: a learner who switches provider or raises
   * the deadline mid-walk is obeyed on their next question rather than on their next window.
   * `model` may be the empty string, and empty means UNSET, which `resolveTutorChoice` reads
   * as the provider's strongest model — the right way round for the only place in this
   * extension where a wrong answer is read by a person who is already confused. Optional for
   * the same reason `tutorCore` is, and the two are asked for together: half a tutor is not a
   * tutor.
   */
  tutorSettings?(): { provider: string; model: string; timeoutMs: number };

  // ── T-7: the detour ─────────────────────────────────────────────────────────────────────

  /**
   * The editor tabs and the narrator webview one detour needs (`src/detour/session.ts`).
   *
   * **OPTIONAL, for exactly the reasons `tutorCore` is.** A session driven with no detour
   * adapters is a walk whose *Show me an unrelated example* button says so honestly and
   * changes nothing else: every other surface works, no position of the dial moves, and
   * nothing is silently degraded. Requiring it would force `test/dial.test.ts`'s adapter set —
   * which exists to prove a learner's bytes survive a real write path — to invent a narrator
   * webview to do it.
   *
   * It carries `globalStorageRoot` rather than the session composing one, because AC2 is
   * precisely that the files land in the extension's own global storage and never in the
   * workspace: the folder is the EXTENSION's to know (`context.globalStorageUri`), not
   * something a state machine should be able to derive from the target it is walking.
   */
  detour?: DetourAdapters;
}

/**
 * What one attempt to put a step's file on disk actually did. Returned rather than acted on
 * inside `writeFile` so that `applyDial` keeps ONE place that decides what to persist, what to
 * push and what to commit — the alternative (a helper that refreshes and persists on its own)
 * is exactly the "second path that writes without pushing" this file's header rules out.
 *
 * `landed` is "the file now holds this step's bytes", which is true of a file that was ALREADY
 * identical and is what decides whether an automated step is complete. It used to carry a
 * companion `wrote` — "bytes were actually put there" — with a paragraph here arguing the
 * distinction; it was set on all five returns below and read by nobody (code review finding
 * 10). The question the caller actually has is a third one, and one this method cannot answer
 * anyway: **did the file APPEAR**, which is `landed` against a `fileExists` taken before the
 * write, and which is what decides the reveal (finding 2 — see `applyDial`).
 */
interface WriteAttempt {
  landed: boolean;
  /** The transient sentence for the panel, absent when nothing worth saying happened. */
  note?: string;
}

export class WalkSession {
  /** The last snapshot pushed to the surfaces; `undefined` when there is no current step. */
  private view: WalkView | undefined;
  /** See `dispose`: a torn-down session must not answer a stale click by driving surfaces
   *  that now belong to a different target's session. */
  private disposed = false;
  /** See `reportPersistFailure`: a folder that cannot be written to does not fail once, it
   *  fails on every click, so the learner is told once and is not asked to dismiss a
   *  notification per navigation for the rest of the walk. */
  private persistReported = false;
  /** The same once-per-session rule, for the three standing conditions T-5 can meet: a
   *  repo-tour that will not load, a target folder whose files will not write, and a
   *  repository with no git identity to commit under. Each fails on every step for as long as
   *  it holds, and none of them is fixed by being told about it a second time. */
  private coreReported = false;
  private writeReported = false;
  private commitReported = false;
  /** The same rule once more, for the sentence naming what a copy of `plan.reproduce` would
   *  have written over. That condition holds on every arrival at every automated step until
   *  the learner does something about it, and the offer stays on the page the whole time, so
   *  re-saying it per step would be noise around a decision already in their hands. See
   *  `reproduceInto`. */
  private reproduceAnnounced = false;
  /** ONE serialised chain for every asynchronous job this session owns — applying a dial,
   *  running a check, reproducing the never-taught files. See the file header: serialising
   *  them is what stops two `goTo`s from racing two writes at the same file, and owning them
   *  is what keeps a failure out of an unwatched `void`ed promise. */
  private work: Promise<void> = Promise.resolve();
  /** Every absolute path this session has already raised the Overwrite/Keep prompt about,
   *  keyed by the step it was raised FOR — the plan's named write-ahead risk (see the file
   *  header). A map of sets rather than one flat `${stepId} ${absPath}` set because an explicit
   *  `dial:set` on the current step has to be able to forget that step's answers in one move
   *  and no other step's (code review finding 5); see `setDial`. */
  private readonly prompted = new Map<string, Set<string>>();
  /** The full report of the last check per step, this session only; the durable half lives in
   *  `progress.steps[id].check`. Keyed by step so a learner can check two steps and see both. */
  private readonly checks = new Map<string, CheckOutcome>();
  /** Manual mode's file shape, and the transient sentence about the last write — each tagged
   *  with the step it belongs to, which is how both stop being shown when the walk moves. */
  private shape: { stepId: string; shape: FileShape } | undefined;
  private note: { stepId: string; text: string } | undefined;
  /** T-21: the last refused press of *Choose this instead* and how many times in a row it has happened (`WalkView.choiceNote`). */
  private choiceRefusal: { stepId: string; reason: string; inARow: number } | undefined;
  /**
   * T-6: the ask in flight, and the step it belongs to. `undefined` means nothing is waiting
   * on a model, which is exactly what `TutorView.thinking` reports — so there is ONE answer to
   * "is a spinner on screen" and it is this field, rather than a boolean somebody has to
   * remember to clear beside it (AC4).
   *
   * Tagged with a step for the same reason `note` and `shape` are: an ask belongs to the
   * conversation it was asked in, and a learner who navigates away while the model is thinking
   * must not find a spinner on the step they arrived at. The ask itself keeps running and its
   * answer still lands in the transcript it belongs to — the same rule `applyDial` states for
   * an entry pass, and for the same reason: the learner asked for it.
   */
  private asking: { stepId: string; ticket: AskTicket } | undefined;
  /**
   * T-6: the one thing that owns a live paid request — every ask this session starts, the
   * bound on its deadline, the neutral directory it runs in, and what it all cost.
   *
   * There is exactly one, it is created with the session and closed with it, and nothing here
   * reaches a provider except through it. That is what makes `spend()` complete and what makes
   * *Cancel* reach an ask on any step: see `AskLedger`, which argues the whole case.
   */
  private readonly ledger = new AskLedger();
  /** T-6: a sentence ABOUT the conversation — unreachable, timed out, failed, cancelled —
   *  tagged with its step so it stops being shown when the walk moves, exactly like `note`.
   *  Never a turn in the transcript; see `TutorView`. */
  private tutorNote: { stepId: string; text: string } | undefined;
  /** T-6: the last question this session actually SENT, and the step it was sent on — the
   *  page's signal that its draft became a turn. See `TutorView.accepted`, which is the whole
   *  argument; cleared when the walk moves, like `tutorNote`. */
  private lastAsked: { stepId: string; text: string } | undefined;
  /** T-6 (security review finding 12): whether this session has already made `.repo-tour/`
   *  uncommittable in the learner's repository. Once per session — the rule is idempotent, but
   *  a `git rev-parse` and a file read per ask is work on the one path that must stay fast. */
  private ignoreEnsured = false;
  /** T-6 (AC4): the provider's own reason it cannot be run here, once something has asked.
   *  A standing condition rather than an event, so unlike `tutorNote` it is NOT cleared when
   *  the walk moves — a `claude` that is not installed is not installed on the next step
   *  either, and the line belongs beside the input for as long as that holds. */
  private unreachable: string | undefined;

  /**
   * T-7: the detour, built on first use and only when the adapters for one were wired.
   *
   * Lazy rather than built in the constructor because a walk nobody presses the button on
   * should create nothing — the same argument `AskLedger.scratchDir` makes for its temp
   * directory. `undefined` therefore means one of two things that are answered identically:
   * no detour adapters were wired at all, or nobody has asked for a detour yet.
   */
  private detourSession: DetourSession | undefined;

  private constructor(
    public readonly target: string,
    private readonly adapters: WalkAdapters,
    private readonly plan: PlanLike,
    private progress: Progress,
    /** `request.json`, read ONCE at `open` — the reference root and the global dial (AC1).
     *  `null` is ordinary; see `WalkAdapters.loadRequest`. */
    private readonly request: ResolvedRequest | null,
  ) {}

  /**
   * Reads the plan and the progress back from disk THROUGH the adapters (never `fs` here —
   * that is what keeps the state machine testable with fakes and what makes the reload drill
   * a real round trip rather than a re-read of something already in memory), then pushes a
   * full refresh WITH an editor reveal: opening the walk should land the learner in the file
   * they left off in, not merely tell them which step it was.
   *
   * Nothing is written back — no `progress.json`, at least. A first-ever walk's progress is
   * `emptyProgress(plan)` — parked on the first step — and staying in memory until the learner
   * actually does something means merely LOOKING at a tutorial never writes progress into
   * their folder. The reload drill survives it either way: `loadProgress` reconstructs the
   * identical starting point on the next open.
   *
   * The learner's SOURCE files are the T-5 exception, and it is the dial's whole point rather
   * than a slip: resuming a walk on a `file` step in a position that writes applies that
   * position, exactly as arriving at the step by clicking would. It is `enterCurrentStep`
   * that does it, after the refresh and asynchronously, so `open` stays synchronous for the
   * three call sites in `src/extension.ts` that depend on it being so. In `manual` — the
   * fallback whenever there is no global dial to read — nothing is written at all (AC2).
   *
   * `loadRequest` is read here and only here. Re-reading it per step would let the reference
   * root shift under a walk in progress, and the global dial is a setting the START SCREEN
   * owns: AC1 says it "never drifts toward automated on its own", and a value read once
   * cannot drift at all.
   */
  static open(target: string, adapters: WalkAdapters): WalkSession {
    const plan = adapters.loadPlan(target);
    const session = new WalkSession(
      target,
      adapters,
      plan,
      adapters.loadProgress(target, plan),
      adapters.loadRequest(target),
    );
    session.resolveCurrent();
    session.refresh(true);
    session.enterCurrentStep();
    return session;
  }

  /**
   * What the surfaces were last handed — the same object, not a copy (see `WalkView` on why
   * these are safe to share). `undefined` means there is nothing to show: a plan with no steps
   * at all, or a disposed session.
   *
   * A plain, non-test-suffixed getter on purpose: `StepViewProvider` needs exactly this in
   * production when a hidden webview view comes back and has to re-render from the host
   * (AC5), so exposing it is the design, not a test seam (handoff T-4 item 7).
   */
  getView(): WalkView | undefined {
    return this.view;
  }

  /**
   * Makes `stepId` current, persists, and refreshes WITH a reveal — the one thing a tree
   * click, a Next/Previous press and a `buildTutorials.goToStep` command argument all do.
   *
   * An id the plan does not contain is SILENTLY ignored (handoff T-4 item 4). The two ways
   * one arrives — a tree item left over from a plan that has since been rebuilt, and a
   * hand-typed command argument — are both ordinary, and neither is worth taking the walk
   * down over. Re-`goTo`ing the step already current is not a no-op, deliberately: clicking
   * the current step in the tree is how a learner asks to be taken back to the file after
   * wandering off in the editor.
   */
  goTo(stepId: string): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    this.progress = setCurrent(this.progress, stepId);
    this.clearStepNotes();
    this.commit(true);
    this.enterCurrentStep();
  }

  /** The next step by ordinal, or nothing at all at the end of the plan — no wraparound. Returns
   *  whether it moved, so a caller can say why it did not (T-51). */
  next(): boolean {
    const id = nextStepId(this.plan, this.progress);
    if (id) this.goTo(id);
    return id !== null;
  }

  /** The previous step by ordinal, or nothing at all at the start of the plan. Returns whether it moved. */
  prev(): boolean {
    const id = prevStepId(this.plan, this.progress);
    if (id) this.goTo(id);
    return id !== null;
  }

  /**
   * Records the learner's per-step dial override (spec §5.4, AC1). Refreshes without a
   * reveal: the status bar's "· <dial>" and the panel's radios both have to update, but the
   * editor is already showing the right file and re-centring it here would only jump the code
   * out from under the learner's eyes.
   *
   * T-5: moving the dial on the step the learner is LOOKING at applies the new position at
   * once, because that is what the control appears to promise — drag it to *automated* and
   * the file should be there. Moving it on some other step in the tree only records the
   * choice; that step will apply it when the learner arrives, which is the same rule `open`
   * and `goTo` follow and not a second one.
   *
   * Which is also why this is the one place that forgets an Overwrite/Keep answer (code review
   * finding 5). `prompted` exists to stop the entry pass the TREE re-fires from asking the same
   * question on every click; a learner who moves the dial here is making a new gesture, and
   * answering it with the refusal they gave the previous position leaves them no way back to a
   * file the control just promised them, short of reloading the window.
   */
  setDial(stepId: string, dial: Dial): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    this.progress = setDialIn(this.progress, stepId, dial);
    const current = stepId === this.progress.current;
    if (current) {
      this.clearStepNotes();
      // For this step only, and only from here: `goTo`, `next` and `prev` all still find the
      // remembered answer, which is the whole of the once-per-session rule.
      this.prompted.delete(stepId);
    }
    this.commit(false);
    if (current) this.enterCurrentStep();
  }

  /**
   * The learner takes a road at a step — the Current Step panel's *Choose this instead* (T-21,
   * T-10 E1). Recorded in progress, shown on the plan (`withChosen`), and NOTHING ELSE changes:
   * re-deriving the rest of the walk from it is T-22's. Latest wins until then; choosing the
   * author's option returns to the author's road.
   *
   * `optionId` came from a webview and is only a KEY: it is matched against the rows the page can
   * show (`optionsTable`, the same answer the page drew from), and one that names none of them
   * writes nothing and says so — as does choosing the road already taken — so a press always
   * changes something on screen (T-15). Whether the page was drawn for this step at all has
   * already been asked by the protocol (`handleStepMessage`, then `refuseStaleChoice` below).
   */
  choose(stepId: string, optionId: string): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    const step = withChosen(this.plan, this.progress).steps.find((s) => s.id === stepId);
    if (!step) return;
    const table = optionsTable(step);
    const row = table.keys.indexOf(optionId);
    if (row !== -1 && row === table.on) {
      this.refuseChoice(stepId, CHOICE_ALREADY_TAKEN);
      return;
    }
    if (table.choosable[row] !== true) {
      this.refuseChoice(stepId, CHOICE_NOT_AN_OPTION);
      return;
    }
    this.choiceRefusal = undefined;
    this.progress = setChosenIn(this.progress, stepId, optionId);
    this.commit(false);
  }

  /**
   * A press from a page that was not drawn for the step the walk is on (T-21, AC2): nothing is
   * recorded, anywhere, and the panel says so on the step the learner is standing on. `stepId` is
   * the walk's own current step, never the page's. Repo-tour gives every step the same option ids,
   * so without this a stale page's `alt-1` is a real option of the new step and lands there.
   */
  refuseStaleChoice(stepId: string): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    this.refuseChoice(stepId, CHOICE_STALE_PAGE);
  }

  /** Records and pushes a refusal, counting it when it repeats the last one (see `choiceRefusalText`). Writes nothing to disk. */
  private refuseChoice(stepId: string, reason: string): void {
    const last = this.choiceRefusal;
    const inARow = last?.stepId === stepId && last.reason === reason ? last.inARow + 1 : 1;
    this.choiceRefusal = { stepId, reason, inARow };
    this.refresh(false);
  }

  /**
   * Marks a step done — the tree's `$(check)` icon, and T-5's own last act after a check
   * passes. Declared and working now so T-5 wires to a state machine that already persists it
   * the same way everything else does. No reveal, same reasoning as `setDial`.
   */
  markDone(stepId: string): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    this.progress = markDoneIn(this.progress, stepId);
    this.commit(false);
  }

  /**
   * The panel's "Open the file" button (`step:open`). Only acts when there is a step and its
   * file actually exists — `fileExists` here is the snapshot from the last refresh, which is
   * the SAME snapshot the panel rendered its button's enabled state from, so the two can never
   * disagree about whether this click should have been possible.
   */
  openFile(): void {
    const view = this.view;
    if (!view?.fileExists) return;
    this.adapters.openFile(view);
  }

  // ── T-5: the three things the dial actually does ──────────────────────────────────────────

  /**
   * *Check my work* (AC5) — the panel's `step:check` message, and the tree's ✓/✗ behind it.
   *
   * Fire-and-forget from the panel's point of view, exactly as `goTo` is: the caller gets
   * `void` and the session owns the promise, so a failure lands in `reportError` instead of
   * an unhandled rejection nobody is listening for. That is the contract `src/dial/check.ts`
   * asks for out loud — its callers must await and catch, never `void` it — because the
   * difference between its two failure answers is the whole design. `null` means "there is
   * nothing to check here", the ORDINARY state of manual mode before the learner has written
   * anything: it records no verdict, marks nothing failed, and says so in `writeNote` rather
   * than leaving a pressed button to do nothing at all. A THROW is real breakage — an
   * unloadable core, a missing grammar — and goes to the learner.
   *
   * A pass marks the step done and, when `buildTutorials.commitPerStep` is on, commits it
   * (AC7). Both happen in ONE persist: a check that passed and a step that is done are the
   * same fact, and writing them separately would leave a window in which `progress.json`
   * claims a passed check on a step still pending.
   */
  runCheck(): void {
    const step = currentStep(this.plan, this.progress);
    if (this.disposed || !step) return;
    this.enqueue(() => this.applyCheck(step.id));
  }

  /**
   * Copies `plan.reproduce` — the generated, vendored, lockfile, data and binary files
   * repo-tour deliberately never turns into steps — from the reference into the target (AC6).
   *
   * There is no decision in a lockfile and nothing to learn from retyping a minified bundle,
   * but they are exactly why `diff -r` between a fully walked target and the reference can
   * come back clean at all: the `file` steps and this list TOGETHER cover every file the
   * inventory saw. Recorded in `progress.reproduced` so the panel's offer can stop being made
   * once it has been taken, and so a reload does not offer it again.
   *
   * The press IS the gesture the copy needs — but only once it has been told what the copy is
   * about to replace (security review finding 3). `reproduceAnnounced` is what makes the count
   * a warning rather than a receipt: pressed onto files the learner has since changed, the
   * first press says how many and copies nothing, and the second one goes ahead. When there is
   * nothing of theirs to lose — a target that simply does not have these files yet, which is
   * every fresh build — there is nothing to warn about and it stays one press.
   */
  reproduce(): void {
    if (this.disposed) return;
    this.enqueue(() => {
      const step = currentStep(this.plan, this.progress);
      const outcome = this.reproduceInto(this.reproduceAnnounced);
      if (step) this.setNote(step.id, outcome.note);
      if (outcome.copied) {
        this.commit(false);
        return;
      }
      if (outcome.note !== undefined) {
        this.refresh(false);
        return;
      }
      // Pressed against a page whose offer is already spent — the panel hides it once
      // `reproduce.done` is true, so this only arrives from a stale render. Said rather than
      // swallowed: a button that does nothing and explains nothing is the one thing the walk's
      // conventions rule out.
      if (step) this.noteFor(step.id, 'This project’s generated files have already been copied — nothing was copied again.');
    });
  }

  // ── T-6: the tutor ────────────────────────────────────────────────────────────────────────

  /**
   * One question for the tutor (spec §5.5; ACs 2, 3, 4).
   *
   * Fire-and-forget from the panel's point of view, exactly as `runCheck` and `goTo` are — and
   * here the reason is at its sharpest. This is called from a webview message listener, with
   * no `await` above it and nobody to catch anything, and what it starts waits on a MODEL for
   * as long as the learner's `tutorTimeoutSeconds` allows. An escaping rejection there is an
   * unhandled rejection in the extension host and a panel stuck on "thinking…" — which is the
   * one thing AC4 forbids by name. So the session owns the whole asynchronous life of the ask,
   * and `enqueue` routes anything that throws to `reportError`.
   *
   * **Nothing here runs synchronously, including the refusal**, and that is load-bearing
   * rather than tidy. `handleStepMessage` returns a state the panel adopts only if nothing
   * overtook it while the effects ran (`step-panel.ts`'s identity guard), so an effect that
   * refreshed on its way out would make the panel drop the very sentence this message came
   * back with. Every answer this method has goes through the chain and arrives as a push.
   *
   * `text` has already been trimmed and length-checked by `handleStepMessage`; what is checked
   * again here is only what this object knows and the protocol cannot — whether there is a
   * step, a reference, a core, and nothing already in flight.
   */
  ask(text: string): void {
    const step = currentStep(this.plan, this.progress);
    if (this.disposed || !step) return;
    this.enqueue(() => this.beginAsk(step.id, text));
  }

  /**
   * Stop waiting (AC4) — and be honest about what stopping does and does not do.
   *
   * SYNCHRONOUS, deliberately, and the only public tutor method that is: the whole promise of
   * *Cancel* is that the spinner goes NOW, and putting it on a chain whose head is a job that
   * may sit behind a two-minute model call would make the button take two minutes to work.
   * There is nothing to serialise anyway — this touches no file and no `progress`.
   *
   * `detach()` is not a kill and this method does not pretend otherwise. repo-tour's
   * `killLlmChildren()` kills EVERY live child rather than one, so pressing *Cancel* on a
   * tutor question while a build ran in the background would kill the build (`src/tutor/
   * ask.ts` argues it in full, and the plan named it as the risk to write ahead of). What
   * detaching buys is the safety property that actually matters: the answer to a question the
   * learner walked away from can never appear in their transcript minutes later. The request
   * itself is still running and still costing money, and the note says so — a cancel that
   * quietly kept billing would be the dishonest version of the same mechanism.
   */
  cancelAsk(): void {
    if (this.disposed) return;
    const asking = this.asking;
    // T-7: *Cancel* is ONE control and it stops every live request this walk started, which
    // now includes a detour being written. Done before the early return below, because a
    // detour generation with no tutor ask beside it is exactly the case that would otherwise
    // fall through it — a *Cancel* that did nothing while a paid request ran is the shape
    // T-6's own finding 3 was about, and the ledger's `abandonAll` alone would stop the
    // request while leaving the button on the page saying an example was still coming.
    const stoppedDetour = this.detourSession?.cancel() === true;
    // Nothing in flight is an ordinary outcome, not an error: the answer landed while the
    // press was in the air, and the page it was pressed on is already a repaint out of date.
    // There is nothing to say about a wait that has already ended, and the reply the learner
    // is now looking at says more than any sentence about it could. T-6 pinned that as a
    // no-op — no note, no push — and the detour must not quietly turn it into a push: only a
    // detour that really was stopped repaints, because only then is there a button still
    // drawn un-pressable with nothing behind it.
    if (!asking) {
      if (stoppedDetour) this.refresh(false);
      return;
    }
    // Read BEFORE anything is abandoned: what a cancel MEANS depends on which half of the
    // wait it lands in, and the ticket has moved on by the time the sentence is written.
    // `preparing` is a real cancellation — nothing was sent, so nothing is charged — and
    // saying "you will still be billed" there would be a lie in the learner's favour's
    // opposite direction. Only `sending` is still costing money.
    const wasSending = asking.ticket.phase === 'sending';
    // Cleared BEFORE the abandon and before anything is said, so `thinking` is already false
    // by the time any surface is pushed to — and so `deliverAsk`'s identity check refuses the
    // outcome when it eventually arrives (see there).
    this.asking = undefined;
    // Through the LEDGER rather than through the one ticket this session happens to be holding:
    // *Cancel* is the control that stops every live request, from whatever step it is pressed
    // on, which is what code review finding 3 asked for. Today there is at most one and the
    // two are the same call; the difference is that this one cannot go stale.
    this.ledger.abandonAll();
    this.setTutorNote(
      asking.stepId,
      wasSending
        ? 'You stopped waiting. The model is still finishing that question and you will still be billed for it — '
          + 'its answer will not appear here.'
        : 'You stopped before the question was sent, so nothing was asked and nothing was charged.',
    );
    this.refresh(false);
  }

  /**
   * Forget this step's conversation (code review finding 6; security review finding 12).
   *
   * `clearTranscript` shipped exported, with six unit tests and no caller in `src/` — a
   * capability with a test suite attached and no way for a learner to reach it. It is wired
   * here rather than deleted because the thing it does is the one control a stored
   * conversation owes somebody: `progress.json` holds their questions and a model's answers,
   * in a folder this extension `git init`s for them, and "you can delete this" is not
   * something a panel may only imply.
   *
   * It is NOT the whole answer to that exposure, and must not be mistaken for one — a
   * retention control somebody has to remember to press is not a retention policy. The default
   * is `ensureTranscriptIgnored`, which makes `.repo-tour/` uncommittable without anybody
   * pressing anything. This is the other half: the learner's own copy, on their own disk,
   * removed when they say so.
   *
   * On the chain, because it persists and repaints. An ask in flight for this step is
   * abandoned first: the answer to a question whose conversation the learner has just deleted
   * must not arrive a second later and re-create it.
   */
  clearConversation(): void {
    const step = currentStep(this.plan, this.progress);
    if (this.disposed || !step) return;
    const stepId = step.id;
    this.enqueue(() => {
      if (this.asking?.stepId === stepId) {
        this.asking = undefined;
        this.ledger.abandonAll();
      }
      const had = getTranscript(this.progress, stepId).length;
      this.progress = clearTranscript(this.progress, stepId);
      this.lastAsked = undefined;
      this.setTutorNote(
        stepId,
        had === 0
          ? 'There was nothing in this conversation to forget.'
          : `This conversation is gone — ${had} ${had === 1 ? 'turn' : 'turns'} deleted from this tutorial's progress file. What it already cost is still counted below.`,
      );
      this.commit(false);
    });
  }

  // ── T-7: the detour ──────────────────────────────────────────────────────────────────────

  /**
   * *Show me an unrelated example* (ACs 1, 2, 5) — the second button beside *Ask*.
   *
   * On the chain, like everything else that persists and repaints, and for the sharper reason
   * `applyDial` gives: a detour WRITES files and OPENS tabs, and two presses racing each other
   * into one directory is the shape `enqueue` exists to prevent. `DetourSession` guards itself
   * as well (its `seq`), because serialising is not the same as superseding — a second press
   * that waits its turn still has to know it is the second.
   *
   * **What is on the chain is the PRESS, not the model call** (code review finding 3). The job
   * below returns as soon as the request is sent; the wait runs beside the chain and comes back
   * on it through `DetourDeps.resume`. T-7 shipped with the whole generation awaited here, so a
   * detour being written made every other control on the panel — `ask`, `step:check`,
   * `dial:set`, `tutor:clear`, `reproduce:run`, `detour:back` — go silent for up to an hour.
   * T-6 moved `ledger.open()` to the top of `beginAsk` precisely so a press is visible in one
   * chain hop, and then this held the hop.
   *
   * **The sentence is not recorded here.** `DetourSession` stores every note it returns
   * (`DetourView.note` → `#detour-note`), and this method used to put the same string through
   * `setTutorNote` as well — so every refusal was drawn twice, verbatim, in adjacent paragraphs
   * of the same section (code review finding 5). When a lower layer already stores what it
   * returns, the upper layer's job is to route it. The one sentence still composed here is the
   * one only this object can know: that no detour adapters were wired at all.
   */
  startDetour(): void {
    const step = currentStep(this.plan, this.progress);
    if (this.disposed || !step) return;
    const stepId = step.id;
    this.enqueue(async () => {
      const detour = this.detour();
      if (!detour) {
        // Honest controls: the capability is genuinely absent, and saying so beats a button
        // that looks pressable and does nothing.
        this.setTutorNote(stepId, 'Unrelated examples are not available in this window.');
        this.refresh(false);
        return;
      }
      // The reference ROOT, not `request.repo`: `DetourSession` derives the folder name from
      // it the way `tutorContext` does for `AskContext.repo`, so the tutor and the detour name
      // the learner's project identically — and the raw `repo` field, which can be a URL with
      // a token in it, never leaves this machine.
      await detour.start(step, this.plan, this.request?.referenceRoot);
      if (this.disposed) return;
      this.refresh(false);
    });
  }

  /**
   * *Write a new example* — the spec's "regenerate" control (refinement notes; code review
   * finding 9).
   *
   * The spec promised it and T-7 shipped without it, which left the cache with **no escape
   * hatch at all**: `DETOUR_PROMPT_VERSION` was the only invalidator and it is a source
   * constant, so a learner served an example that did not help had no way to ask for another
   * one, ever. The key now carries the prompt, so a plan rebuilt with a different question is
   * already a miss; this is the other half — the same question, a different answer, on request.
   *
   * It is on the panel only while a detour is OPEN on this step, which is the state a learner
   * is in when they decide the example is not helping. That is a pure function of state
   * `stepRenderKey` already carries (`step.id`, and `detour.open.stepId`), so it adds no field
   * to the key and no mutation to its sweep.
   */
  regenerateDetour(): void {
    const step = currentStep(this.plan, this.progress);
    if (this.disposed || !step) return;
    const stepId = step.id;
    this.enqueue(async () => {
      const detour = this.detour();
      if (!detour) {
        this.setTutorNote(stepId, 'Unrelated examples are not available in this window.');
        this.refresh(false);
        return;
      }
      await detour.start(step, this.plan, this.request?.referenceRoot, { fresh: true });
      if (this.disposed) return;
      this.refresh(false);
    });
  }

  /**
   * *Back to my build* (ACs 3, 4) — the way out, from the panel's button or the narrator's.
   *
   * The order below is AC3 read literally: the detour's tabs and narrator go and its directory
   * is deleted (the detour session's job), then the step the learner left is re-revealed AT
   * THE SAME DIAL — which is what `refresh(true)` does, because `stepDial` resolves the dial
   * on every build of the view and nothing about a detour touched it — and only then is the
   * note appended and saved.
   *
   * **The note is a `kind: 'note'` turn** (AC4, plan R1). `AskMessage` gained that field for
   * this one sentence, `sanitizeTranscript` allow-lists exactly that value, and `sentTurns` is
   * what keeps it off the send path — so the learner reads "detour taken: …" in their
   * conversation and no model is ever told the assistant said it. Appended through
   * `appendTurn` like every other turn, so it is stored, sanitised and capped by the same
   * rules and there is no second transcript writer to keep in step.
   *
   * Recorded against the step the detour was TAKEN on, not the step that happens to be
   * current: a learner who left a detour open and navigated away is still owed the record on
   * the step it belonged to.
   */
  returnFromDetour(): void {
    if (this.disposed) return;
    this.enqueue(async () => {
      const detour = this.detourSession;
      if (!detour) return;
      const result = await detour.returnToBuild();
      if (this.disposed) return;
      if (!result.returned) {
        // Nothing composed here and nothing re-stored: `DetourSession.refuseReturn` has already
        // put the sentence where the panel draws it (code review finding 5). This also retires
        // the `currentStep(…)?.id ?? ''` that used to file the note under an id `tutorView`
        // could never match on a plan with no current step (finding 12).
        this.refresh(false);
        return;
      }
      this.progress = appendTurn(this.progress, result.stepId, {
        role: 'assistant',
        content: `detour taken: ${result.title}`,
        kind: 'note',
      });
      // `commit(true)`: persist, push to every surface, and REVEAL — the learner is coming
      // back to their own file and should land in it, at the step they left. The one place in
      // this file where a non-navigating action reveals, and it is a navigation in every sense
      // that matters to a person.
      this.commit(true);
    });
  }

  /** The narrator's *Next* / *Previous*. Not on the chain: they touch no file and no
   *  `progress`, and putting them behind a job that may be waiting on a model would make the
   *  buttons take a model call to work — the same argument `cancelAsk` makes for being
   *  synchronous. `DetourSession.goto` owns the clamping. */
  detourNext(): void {
    if (this.disposed) return;
    void this.detourSession?.next();
  }

  detourPrev(): void {
    if (this.disposed) return;
    void this.detourSession?.prev();
  }

  /**
   * The detour session, built on first use — `undefined` when no detour adapters were wired,
   * which is an honest "not available in this window" rather than a broken walk.
   *
   * The ledger handed in is THIS session's, which is plan R2 made structural: the detour's
   * paid request and the tutor's are in one set, so `spend()` counts both, *Cancel* stops
   * both, and `dispose` closes both.
   */
  private detour(): DetourSession | undefined {
    if (this.detourSession) return this.detourSession;
    const adapters = this.adapters.detour;
    if (!adapters) return undefined;
    this.detourSession = new DetourSession({
      adapters,
      ledger: this.ledger,
      settings: () => this.tutorSettingsNow(),
      refresh: () => { this.refresh(false); },
      reportUnreachable: (detail) => { this.unreachable = detail; },
      // Which TUTORIAL, not which step — the component `globalStorageUri` does not carry and a
      // repo-tour step id does not either. Computed once: `target` and `plan` are both assigned
      // in the constructor and neither is ever reassigned, so a detour opened now and removed
      // twenty minutes later is aimed at the same directory. See `store.ts`'s header, section 0.
      tutorial: tutorialId(this.target, this.plan),
      // The detour's answer comes back onto THIS chain, and the wait does not sit on it —
      // `beginAsk`/`deliverAsk`'s split, for the second control that spends money.
      resume: (job) => { this.enqueue(job); },
    });
    return this.detourSession;
  }

  /**
   * The ask itself: probe, record the question, start the model, and hand delivery back to the
   * chain. Everything that can refuse does so BEFORE the thinking state is entered.
   *
   * **The order is AC4.** The availability probe comes first, before a prompt is built and
   * before a runner is reached for, so a machine with no provider on it gets the honest answer
   * in the time it takes to `access()` a file, and the panel never enters the SENDING state at
   * all: it says "getting ready to ask", and then it says why it stopped. Probing after the
   * send would show "thinking…" for as long as the provider took to fail and then a failure
   * that reads like the model's fault. (`askTutor` probes again on its own way in — it is
   * contracted to, and this file does not edit it. One extra `--version` per ask is a fraction
   * of a second against a model call, and the duplication buys the thing that matters: the
   * panel decides whether to say anything is being SPENT before it says so.)
   *
   * **What changed, and why it is not a weakening of AC4.** The ticket is opened at the top,
   * before any of it, because the pre-flight is not free: the probe budgets fifteen seconds
   * for a `claude --version` and `tutorContext` shells out to `git diff`, and all of it used
   * to run with `this.asking` unset — no spinner, and a *Cancel* that early-returned and said
   * nothing (security review finding 5). AC4's letter survived that (no spinner was left
   * running, because none was ever raised) and the honest-controls rule did not: pressing
   * *Ask* looked exactly like a button that did nothing. `TutorView.stage` is what keeps the
   * two states apart, so nothing here claims a model is thinking while a probe is running,
   * and nothing claims money is being spent before any is.
   *
   * **And the pre-flight is now BOUNDED as well as visible (T-13).** The other half of that
   * same finding was that `tutorContext`'s `git diff` had no time limit at all, so on a slow
   * or enormous tree the ticket could sit in `preparing` forever: the spinner this ticket
   * raises would be honest about the wait and the wait would never end. Every call the runner
   * makes now carries the short bound, so the `stopped()` check after `tutorContext` below is
   * reached within thirty seconds — thirty-five where the subprocess needed the runner's
   * second signal (`GIT_KILL_GRACE_MS`) — which is what makes *Cancel* a control that really
   * acts rather than one that acts only if git is feeling cooperative.
   *
   * "Whatever git does" is the load-bearing half and it is a property of the RUNNER, not of
   * git's manners: the first version of this bound was a single `SIGTERM`, and a child that
   * ignored it left the promise permanently unsettled and this check permanently unreached
   * (review finding 1, driven). It now settles on the runner's own timer whether the child
   * dies or not. The one thing that genuinely escapes is a grandchild of a wrapped `git` —
   * stated in `src/start/build.ts`, and it does not delay this check.
   *
   * The learner's own turn is appended and SAVED before the model is asked, in the same commit
   * that raises the spinner. A window closed mid-ask therefore comes back with the question in
   * the conversation and no answer under it, which is what really happened; recording it only
   * on success would lose questions exactly when a learner most wants to know what they asked.
   */
  private async beginAsk(stepId: string, text: string): Promise<void> {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) return;
    if (this.asking) {
      // NOT unreachable, and the comment that used to say it was is the finding. The view does
      // remove *Ask* while an ask is in flight — but it keys on `this.asking`, which is now set
      // at the top of this method rather than after three awaits, so the window in which *Ask*
      // is still on the page has gone from "a dynamic import, a `claude --version` spawn with a
      // fifteen-second budget, and a `git diff`" down to one chain hop. Small is not zero, so
      // this branch stays, and it no longer points at a control that is not on the page: the
      // page has *Cancel* on it for the whole of that window now.
      //
      // The learner's text is NOT lost either — `accepted` was never set for this press, so the
      // page keeps its draft (see `TutorView.accepted`).
      this.setTutorNote(stepId, 'One question is already with the tutor. Wait for that answer, or press Cancel — your question is still in the box.');
      this.refresh(false);
      return;
    }

    // ── The ticket is opened HERE, at the press, and that is security review finding 5 ──────
    //
    // Everything below this line used to run with nothing on screen: `TutorView.thinking` is
    // derived from `this.asking`, which was set AFTER the availability probe (`claude
    // --version`, a fifteen-second budget of its own) and after `tutorContext`'s `git diff` —
    // so pressing *Ask* looked exactly like a button that did nothing, and `cancelAsk`
    // early-returned on `!asking` and said nothing either. AC4's letter survived (no spinner
    // was left running, because none was ever raised) but the honest-controls rule did not.
    //
    // A ticket is `preparing` until `send`: the panel draws the wait, *Cancel* really stops it,
    // and nothing has been sent, so a cancel here is a genuine cancellation rather than a
    // detachment from something that goes on billing.
    const ticket = this.ledger.open(stepId);
    this.asking = { stepId, ticket };
    this.tutorNote = undefined;
    // `accepted` describes THIS ask and nothing earlier, and clearing it at the press is what
    // makes that true. Without this, a learner who asks the same question twice — a retry
    // after a failure is the obvious way to get there — would have their second draft dropped
    // by the FIRST ask's signal, even on a press the host went on to refuse. It is cleared
    // after the already-in-flight guard above deliberately: that branch refuses a SECOND
    // question while the first is still live, and the first one's signal is still true.
    this.lastAsked = undefined;
    // The push that raises the spinner, and it is CAUGHT rather than allowed to escape.
    // `enqueue` reports a throw and moves on, which would leave `this.asking` set, `thinking`
    // true and no request behind it to ever take it down — a spinner that runs until the
    // window closes, which is the one thing AC4 forbids by name. It is also the wrong answer
    // on its own terms: a surface that threw while a spinner was going up is not a reason to
    // refuse a question the learner asked. So it is reported and the ask carries on, and the
    // answer's own repaint is what clears the state (the same argument the delivery hook below
    // makes, one push earlier).
    try {
      this.refresh(false);
    } catch (err) {
      this.adapters.reportError(messageOf(err));
    }

    /** The ticket is over and nothing is left spinning about it. Idempotent, and the only way
     *  this method ends a ticket it did not send. */
    const close = (): void => {
      ticket.abandon();
      if (this.asking?.ticket === ticket) this.asking = undefined;
    };

    /** Every refusal below ends the same way: the ticket is over, the spinner comes off, and
     *  the page is told — while `accepted` stays unset, so the learner's question is still in
     *  the box where they typed it (code review findings 1 and 2). */
    const refuse = (note: string): void => {
      close();
      this.setTutorNote(stepId, note);
      this.refresh(false);
    };

    /**
     * Should this pre-flight stop, and has it left anything behind if so?
     *
     * The disposed half is LIVENESS, and the same rule every other await on this chain follows
     * — `enqueue` re-guards a job that has not STARTED, and only the job can guard itself once
     * it has; a disposed session's target may already belong to the session that replaced it.
     * The abandoned half is new and is what makes the pre-flight interruptible: a *Cancel*
     * pressed during the probe stops the ask rather than merely stopping the spinner, because
     * `abandon()` before `send` means nothing is ever sent.
     *
     * It CLOSES on the way out rather than only answering, so that no exit from this method
     * can leave a `preparing` ticket live with `thinking` true and nothing behind it. Today
     * both callers of `abandon` already clear `this.asking` first, so this is a second lock on
     * a door that is shut — which is exactly the standard the rest of this lifecycle is held
     * to.
     */
    const stopped = (): boolean => {
      if (!this.disposed && !ticket.abandoned) return false;
      close();
      return true;
    };

    // No `request.json` means no reference root, and the tutor's context is built AGAINST the
    // reference — the author's file, and the diff of the learner's against it. Asking without
    // it would spend the learner's money on a question with half its context missing. The same
    // answer `applyCheck` gives for the same folder, in the same words.
    const refRoot = this.request?.referenceRoot;
    if (refRoot === undefined) {
      refuse('This tutorial has no reference repository recorded, so there is nothing for the tutor to read. Nothing was asked, and your question is still in the box.');
      return;
    }

    const settings = await this.tutorSettingsNow();
    // The first of four, one after every await. See `stopped`.
    if (stopped()) return;
    if (!settings) {
      this.reportCoreMissing();
      refuse('repo-tour could not be loaded, so there is nobody to ask. Nothing was sent, nothing was charged, and your question is still in the box.');
      return;
    }

    const availability = await checkReachable(settings);
    if (stopped()) return;
    if (!availability.ok) {
      // The provider's OWN words, carried through rather than replaced by a house phrasing
      // that says less: "not found on PATH" tells a learner what to do and "the tutor is
      // unavailable" does not. Recorded in `unreachable` as well as in the note, because it is
      // a standing condition — the line belongs beside the input from now on, not only under
      // the question that discovered it.
      this.unreachable = availability.detail;
      refuse(`The tutor could not be reached, so nothing was asked and nothing was charged — ${availability.detail}. Your question is still in the box.`);
      return;
    }
    // A provider that answers again after a spell of not answering clears the line rather than
    // leaving a stale complaint beside a working input.
    this.unreachable = undefined;

    const ctx = await tutorContext(step, refRoot, this.target, this.adapters.git);
    if (stopped()) return;

    // Security review finding 12, and it goes here because THIS is the moment the exposure is
    // created: the next two lines write a learner's own words into a folder this extension
    // `git init`s for them. The rule is idempotent and this session only ever writes it once;
    // it is awaited rather than fired off because a transcript must not reach the disk before
    // the thing that keeps it out of a commit.
    await this.ensureTranscriptIgnoredOnce();
    if (stopped()) return;

    this.progress = appendTurn(this.progress, stepId, { role: 'user', content: text });
    // The page's signal that its draft became a turn — set on the ONE path that really sends,
    // and on none of the four that refuse. See `TutorView.accepted`.
    this.lastAsked = { stepId, text };
    // Sent BEFORE the commit, so the push that raises the spinner is made with the request
    // already live — there is no window in which the page says "thinking…" and nothing is.
    // `sentTurns` re-reads what was just appended, which is the sanitising round trip the
    // stored transcript owes — and then drops the walk's own notes (T-7). What the model is
    // shown is what the panel draws MINUS anything neither party said: a "detour taken: …"
    // note is part of the learner's record of the conversation and would reach the model as a
    // sentence the assistant appears to have written, because repo-tour's `trimMessages`
    // rebuilds turns as `{ role, content }` and so keeps the sentence while dropping the field
    // that marked it. The filter belongs here, upstream of that trimmer.
    ticket.send(settings, ctx, sentTurns(this.progress, stepId));

    // Registered BEFORE the commit, and the order is the last of AC4's locks. `commit`
    // persists and then pushes to four surfaces, any of which is an adapter that can throw —
    // and a throw here escapes to `enqueue`, which reports it and moves on, leaving
    // `this.asking` set and `thinking` true with nothing left to take it down. Hooking
    // delivery first means the answer (or the timeout, which always comes) still arrives, still
    // clears the ask and still repaints, whatever the push did. No spinner is ever left
    // running, including on the paths nobody planned for.
    //
    // `delivered` is a one-shot promise that only ever RESOLVES (`src/tutor/ask.ts` builds it
    // by hand), so the rejection arm exists only so a future edit to that file cannot turn
    // this into an unhandled rejection nobody is listening for. Delivery goes back through
    // `enqueue` rather than being acted on here: it persists and repaints, and those belong on
    // the one serialised chain with everything else that does.
    void ticket.delivered.then(
      (outcome) => { this.enqueue(() => { this.deliverAsk(stepId, ticket, outcome); }); },
      (err: unknown) => { this.adapters.reportError(messageOf(err)); },
    );

    this.commit(false);
  }

  /**
   * Make `.repo-tour/` uncommittable in the learner's repository, once per session (security
   * review finding 12).
   *
   * `progress.json` now holds free text — the learner's questions and a model's answers — at
   * `<target>/.repo-tour/build/progress.json`, in a folder this extension `git init`s. The
   * dial's own commit is pathspec-scoped and does not sweep it up, which was checked; what
   * does sweep it up is the learner's own `git add -A`, in a repository this extension made
   * for them, on the ordinary path where nobody did anything wrong.
   *
   * Never throws and never reports: see `ensureTranscriptIgnored`. A failure here must not be
   * the reason a question goes unasked, and the ask itself is the thing the learner pressed.
   */
  private async ensureTranscriptIgnoredOnce(): Promise<void> {
    if (this.ignoreEnsured) return;
    this.ignoreEnsured = true;
    await ensureTranscriptIgnored(this.target, this.adapters.git);
  }

  /**
   * What came back, drawn — and in every branch, the spinner goes off first.
   *
   * `this.asking = undefined` is written BEFORE the outcome is even looked at, and that
   * ordering is AC4 in one line: no branch below, and no branch a later edit adds, can leave a
   * spinner running, because by the time any of them runs there is nothing in flight to spin
   * about. Whoever moves that assignment into the cases has reintroduced the exact failure the
   * criterion names.
   *
   * The identity check is what makes a cancel safe. `cancelAsk` clears `this.asking`
   * synchronously, so a late outcome — a model that answered a second after the learner walked
   * away — finds a run that is no longer this session's ask and lands nowhere. `AskRun.detach`
   * already guarantees the outcome is `null` in that case; this is the second lock on the same
   * door, and it also covers the case a detach cannot: an ask SUPERSEDED by a newer one.
   *
   * The three failure outcomes are notes, not turns (the plan says so explicitly, and
   * `AskOutcome` is a union rather than `{ text, error? }` for the same reason): a timeout
   * stored in the transcript would be sent back to the model on the next question as though the
   * tutor had said it.
   */
  private deliverAsk(stepId: string, ticket: AskTicket, outcome: AskOutcome | null): void {
    if (this.disposed) return;
    if (this.asking?.ticket !== ticket) return;
    this.asking = undefined;

    if (outcome === null) {
      // Unreachable in practice — `cancelAsk` clears `this.asking`, so the check above has
      // already returned by the time a detached run delivers its `null`. Kept, and kept
      // refreshing, because the alternative if some future path ever detaches without clearing
      // is a spinner nothing takes down, which is the one outcome this method may not have.
      this.refresh(false);
      return;
    }

    switch (outcome.kind) {
      case 'reply':
        // The only outcome that is a TURN. `outcome.cost` is deliberately NOT summed here —
        // the ledger already counted it, off `AskRun.finished`, which is what makes the total
        // complete rather than dependent on this branch remembering. It reaches the page as
        // `TutorView.spend`. What is still forbidden is rendering `$0.00` at somebody who was
        // in fact billed: `metered: false` means unknown, never free, and `AskSpend.metered`
        // is the flag that carries that all the way to the sentence.
        this.progress = appendTurn(this.progress, stepId, { role: 'assistant', content: outcome.text });
        this.commit(false);
        return;
      case 'unreachable':
        this.unreachable = outcome.detail;
        this.setTutorNote(stepId, `The tutor could not be reached, so nothing was asked and nothing was charged — ${outcome.detail}.`);
        this.refresh(false);
        return;
      case 'timedOut':
        // A timeout is a REPLY, not a hang — that is the whole of `askTutor`'s deadline race,
        // and this sentence is where the learner finds out. Their question stays in the
        // conversation because they really did ask it, and the next ask carries it as context.
        this.setTutorNote(
          stepId,
          `The tutor did not answer within ${secondsPhrase(outcome.afterMs)}. Your question is still in this conversation — `
          + 'ask again, or raise `buildTutorials.tutorTimeoutSeconds`.',
        );
        this.refresh(false);
        return;
      case 'failed':
        this.setTutorNote(stepId, `The tutor could not answer — ${outcome.detail}. Nothing was added to this conversation.`);
        this.refresh(false);
        return;
    }
  }

  /**
   * Everything one ask needs, assembled from the two optional adapters — or `undefined`, which
   * is the honest answer for a walk with no tutor wired and for a repo-tour that will not load
   * alike. Both collapse into one answer on purpose: the panel has one sentence to say about
   * "there is nobody to ask", and the learner cannot act on the difference.
   *
   * `cwd` is the LEARNER's folder, never the reference — it is what the provider is run in, and
   * `TutorDeps.cwd` says so out loud. The settings are read HERE, per ask, rather than captured
   * at `open`, so switching provider or raising the deadline takes effect on the next question.
   */
  private async tutorSettingsNow(): Promise<AskSettings | undefined> {
    if (!this.adapters.tutorCore || !this.adapters.tutorSettings) return undefined;
    const core = await this.adapters.tutorCore();
    if (!core) return undefined;
    const settings = this.adapters.tutorSettings();
    return {
      core,
      provider: settings.provider,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
    };
  }

  /** A tutor sentence about what just happened, tagged with its step — the same shape and the
   *  same reasoning as `setNote`, kept separate because the two are drawn in different places
   *  (this one inside the tutor section, beside the input it is about) and because a write's
   *  news and a model's must not overwrite each other. Never pushes; the caller owns that. */
  private setTutorNote(stepId: string, text: string): void {
    this.tutorNote = { stepId, text };
  }

  /**
   * The promise of everything this session currently has in flight — a dial being applied, a
   * check running, files being reproduced, a question with the tutor.
   *
   * Not a test seam bolted on afterwards, and not a way for a surface to wait: the panel and
   * the tree are pushed to, they never ask. It exists because the acceptance criterion does.
   * AC6 is "walk every step in automated mode, then `diff -r` the target against the
   * reference", and a run that starts diffing while the last file is still being written is
   * not measuring what it claims to. `test/dial.test.ts` awaits this between the walk and the
   * diff; `test/unit/walk-session.test.ts` awaits it between an action and its assertion, for
   * the same reason.
   *
   * **T-6: an ask is in flight WITHOUT being on the chain, so waiting for the chain alone is
   * no longer waiting for everything.** That split is deliberate — a question can sit with a
   * model for two minutes, and serialising it ahead of the entry pass would mean a learner who
   * asked something could not have the next step's file written until the answer came back
   * (AC6's own byte-for-byte reproduction, blocked by a chat message). So the ask runs beside
   * the chain and only its DELIVERY is enqueued, which is what keeps `progress.json` mutated
   * in one order. This method closes the resulting gap: drain the chain, then wait for whatever
   * ask those jobs started, then drain the chain again for the delivery that ask enqueued. It
   * cannot wait forever — `askTutor` races its own deadline, so every ask terminates in an
   * outcome — which is exactly why a timeout being a reply rather than a hang is a property of
   * this suite as much as of the panel.
   */
  settled(): Promise<void> {
    return this.work.then(async () => {
      // TWO things can be in flight beside the chain now, not one. T-7's detour has exactly
      // the shape T-6's ask has — the model call runs off the chain and only its DELIVERY is
      // enqueued (code review finding 3) — so this method has to know about both, or a test
      // that drains the chain after pressing the detour button reads a walk that has not
      // finished reacting. Both are awaited before the chain is drained a second time, because
      // either one's delivery job lands on the end of it.
      const waits: Array<Promise<unknown>> = [];
      const asking = this.asking;
      if (asking) waits.push(asking.ticket.delivered);
      const detouring = this.detourSession?.pending();
      if (detouring) waits.push(detouring);
      if (waits.length === 0) return;
      await Promise.all(waits);
      // Re-read rather than captured: the delivery job was appended by the `.then` that
      // `beginAsk` (or `DetourSession.start`) registered on that promise, which runs before
      // this continuation does, so `this.work` is by now the chain WITH that job on the end.
      await this.work;
    });
  }

  /**
   * Stops driving the surfaces: decorations off (AC3 — "decorations clear when the step
   * changes", and a session going away is the most complete kind of change), and `undefined`
   * to the tree and the panel so neither is left showing a walk that is no longer running.
   *
   * The adapters themselves are NOT disposed — they own their own lifetimes, registered in
   * `context.subscriptions` by `src/extension.ts`, and they outlive this session precisely so
   * that "a second `open` on a different target replaces the first" (plan step 5) can hand
   * the same tree and the same panel a new session's view.
   *
   * Every surface this session drives is cleared, the status bar included. A replacement
   * session overwrites the text on its own first `refresh`, so clearing matters for the case
   * where there is NO replacement — the plan was deleted, the folder was closed — and the
   * alternative is a status pill still reading `step 3 / 12 · manual` for a walk that is not
   * running. Consistency is the argument: the tree and the panel are owned exactly the same
   * way and are cleared here, so singling the status bar out would be an inconsistency a
   * reader would have to re-derive rather than a rule they could state.
   *
   * Idempotent, and every mutator above turns into a no-op afterwards, so a click queued
   * against a replaced session cannot write the old target's progress or repaint surfaces the
   * new session has already claimed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view = undefined;
    // T-5's own surfaces are in-memory rather than on screen, and they go the same way: a
    // report, a shape or a note surviving into a replacement session would be describing a
    // walk that is no longer running. `prompted` goes too, and deliberately — the promise is
    // "never twice in one SESSION", and a new session is a new session.
    this.shape = undefined;
    this.note = undefined;
    this.checks.clear();
    this.prompted.clear();
    // T-6: the ask in flight is DETACHED rather than merely forgotten, and the difference is
    // the point. Forgetting it would leave a live request whose answer resolves into a
    // `deliverAsk` on a dead session — guarded, but only by a check somebody could delete —
    // while detaching severs delivery at the source: `delivered` resolves to `null`, and the
    // model's answer, whenever it arrives and whatever it cost, has nowhere to land. The
    // request itself is still finishing; nothing here can stop that without killing every
    // other live child (see `cancelAsk`), and a session going away is not a reason to take a
    // background build down with it.
    this.asking = undefined;
    this.tutorNote = undefined;
    this.lastAsked = undefined;
    // Through the LEDGER, which abandons every live ask, refuses to open another and removes
    // the scratch directory the provider was launched in. The totals are not reset — `close`
    // is the end of the ledger, not a way to forget what a walk spent.
    this.ledger.close();
    // T-7: the detour goes with the session — its tabs closed, its narrator disposed and its
    // directory deleted. Voided with a catch rather than awaited because `dispose` is
    // synchronous for the three call sites in `src/extension.ts` that depend on it being so,
    // and because the cleanup is genuinely best-effort: a window closing must not be blocked
    // on a tab that will not go, and `DetourSession.dispose` swallows each failure on its own
    // (there is nobody left to tell). The `catch` is belt-and-braces so a future edit to that
    // method cannot turn this into an unhandled rejection nobody is listening for.
    const detour = this.detourSession;
    this.detourSession = undefined;
    if (detour) void detour.dispose().catch(() => { /* nothing left that could be told */ });
    this.adapters.clearEditor();
    this.adapters.setTree(undefined);
    this.adapters.setPanel(undefined);
    this.adapters.setStatus('');
  }

  // ── T-5: the asynchronous half, owned rather than voided ─────────────────────────────────

  /**
   * Puts one job on this session's single chain and never lets it escape.
   *
   * Serialised because the tree can fire `goTo` faster than a write completes, and two entry
   * passes racing the same destination is the one way `writeTextAtomic`'s atomicity could
   * still lose — the loser's rename would land last and win. Chained rather than queued in a
   * list so `settled()` is simply the tail of it.
   *
   * Every job is re-guarded when it RUNS rather than only when it is enqueued: a session
   * disposed while a job was waiting must not go on driving surfaces the replacement session
   * has already claimed, which is the same rule every public mutator above follows.
   */
  private enqueue(job: () => Promise<void> | void): void {
    this.work = this.work
      .then(async () => {
        if (this.disposed) return;
        try {
          await job();
        } catch (err) {
          this.adapters.reportError(messageOf(err));
        }
      })
      // The last resort: a `reportError` adapter that itself throws must not turn this chain
      // into an unhandled rejection and take every job after it down with it.
      .catch(() => { /* nothing left that could be told */ });
  }

  /**
   * Applies the current step's dial — the thing every arrival at a step does, and the only
   * place in this extension that writes a learner's own source file.
   *
   * Called after the refresh rather than before it, so the surfaces are already showing the
   * step the learner asked for while the write is still being decided; the write's own result
   * arrives as a second push a moment later, carrying `writeNote`.
   *
   * The step is PINNED here, at the moment of arrival, and `applyDial` is handed that id
   * rather than asking what is current when it eventually runs. See there: the pass belongs to
   * the step the walk entered, and the walk can enter two steps before either pass has run.
   */
  private enterCurrentStep(): void {
    const step = currentStep(this.plan, this.progress);
    if (!step) return;
    this.enqueue(() => this.applyDial(step.id));
  }

  /**
   * The dial, applied to one step (ACs 2, 3, 4, 7).
   *
   * Reads the step back by id rather than closing over the object, because an id is what
   * survives a wait on this session's chain. What it deliberately does NOT do is check that
   * the step is still the CURRENT one — that is the rule, not an omission, and it was learned
   * the expensive way, so read it before putting such a check back:
   *
   * **An entry pass belongs to the step the walk ENTERED, not to the step the walk happens to
   * be on by the time the pass gets its turn.** Two `next()` calls in one tick — an ordinary
   * double-click on the Next button, or a held keybinding repeating faster than a write — put
   * two passes on the chain before either can run, and the first of them finds the walk
   * already a step further on. A staleness check at the top of this method did not DEFER that
   * pass, it dropped it: the acceptance suite measured two files never written, one commit
   * where three were due, and no `reportError`, no `writeNote` and no tree mark to say a step
   * had been skipped, because nothing on this path reports a pass it declined to run. AC6 is
   * "walking every step in automated mode reproduces the reference byte-for-byte", and
   * clicking Next twice is walking; AC7's commit per completed step goes the same way, since a
   * file that was never written completes nothing.
   *
   * The check that used to be here argued that "a job that waited behind a modal for half a
   * minute must not write the file of a step nobody is looking at any more". The modal is
   * precisely why that cannot happen: `confirmOverwrite` is a `showWarningMessage(..., {
   * modal: true })` (`src/extension.ts`), which blocks the window, so the learner cannot
   * navigate while it is up. And when they do answer — *Overwrite*, about a file named to them
   * in the dialog — that answer is honoured wherever the walk has since gone, because
   * `writeFile` has already recorded the pair in `prompted`, and a later visit would otherwise
   * tell them their version was kept on the one occasion they asked for the opposite.
   *
   * What DOES cancel a pass in flight is the session going away, and that is what the two
   * `disposed` re-checks below — plus the third inside `writeFile`, which is the one that
   * guards the bytes — are for. `enqueue` re-guards a job that has not started yet; only the
   * job can guard itself once it has. A disposed session's target may already belong to the
   * session that replaced it — writing the same files, from a `prompted` set that starts empty
   * — and a `commit` from a dead session drives surfaces the new one has claimed.
   */
  private async applyDial(stepId: string): Promise<void> {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) return;

    // No `request.json` means no reference root: there is nothing to copy FROM, so no position
    // can write and none pretends to. Deliberately quiet — the plan is on disk without the
    // request that produced it, which is a folder somebody assembled by hand, not something
    // the learner did or can fix from the panel, and the surfaces already say the honest thing
    // (the file is not there, the dial reads what it reads).
    const request = this.request;
    if (request === null) return;
    // `referenceRoot`, never `repo`: for a GitHub-URL build those differ, and `repo` is only
    // what the learner typed. `loadRequest` has already resolved and stat'd this one.
    const refRoot = request.referenceRoot;

    const dial = stepDial(this.progress, stepId, request.dial);

    // AC2, in full: manual writes NOTHING — not an empty file, not a directory — and the panel
    // is handed the file's shape instead, which is enough to know what to write and never the
    // answer. Only a `file` step has a shape to show; a `symbol` step lives inside a file some
    // earlier step wrote, and a `shape` step's target is a directory.
    if (dial === 'manual') {
      if (step.kind !== 'file') return;
      this.shape = { stepId, shape: fileShape(refRoot, step) };
      this.refresh(false);
      return;
    }

    if (step.kind !== 'file') return;

    const core = await this.adapters.core();
    // The first of this method's two `disposed` re-checks (see its header). Everything past
    // here writes into the learner's folder or pushes to a surface — `reportCoreMissing`
    // included — and a session torn down while the core was loading owns neither any more.
    if (this.disposed) return;
    if (!core) {
      this.reportCoreMissing();
      return;
    }

    // Whether this pass changed anything durable. `commit` persists AND pushes, and a pass that
    // merely re-confirmed a file already written must do neither: `goTo` has just persisted the
    // position, so a second identical `saveProgress` per navigation would be a write into the
    // learner's folder for nothing.
    const before = this.progress;
    const wasDone = this.progress.steps[stepId]?.status === 'done';

    // AC6: the never-taught files land BEFORE the first file the learner is shown, so an
    // automated walk's target is complete rather than complete-except-the-lockfile. Once only
    // — `progress.reproduced` is what remembers it, across reloads as well as across steps.
    // Nothing is REPLACED from here, though: arriving at a step is not a gesture, and this pass
    // runs on activation (security review finding 3). What it would have written over comes
    // back as a sentence instead, and rides out with this pass's own.
    const reproduceNote = dial === 'automated' ? this.reproduceInto(false).note : undefined;

    const planned = planWrite(step, dial, refRoot, this.target, this.plan, core);
    if (planned === null) {
      // Nothing to write, and that is correct. A `shape` or `symbol` step owns no file of its
      // own; only the position's own meaning could have got us this far with a `file` step, and
      // `manual` already returned above.
      this.setNote(stepId, reproduceNote);
      this.concludePass(before, false);
      return;
    }
    if (isRefusal(planned)) {
      // A refusal is a VALUE from `planWrite` precisely so it can be SHOWN. It means the plan
      // pointed outside the folder, or at a file that is not text, or at a language repo-tour
      // cannot stub — none of which the learner caused, and all of which they are entitled to
      // know about rather than watch a dial do nothing at all.
      this.setNote(stepId, reproduceNote, planned.refused);
      this.concludePass(before, false);
      return;
    }

    // Asked BEFORE the write, because the whole question code review finding 2 turns on is
    // whether the write is what made the file appear. By now `goTo`'s `refresh(true)` has
    // already run and found nothing there — that is the trace in the finding — so a file that
    // exists only after `writeFile` has been shown to nobody at all.
    const existedBefore = this.adapters.fileExists(planned.path);

    const attempt = await this.writeFile(step, planned.path, planned.content);
    // The second re-check, and the one that matters most: `writeFile` can wait on a human, and
    // everything below it persists progress, pushes it to four surfaces and commits.
    if (this.disposed) return;
    this.setNote(stepId, reproduceNote, attempt.note);

    // AC7's other half: an automated step has no check to pass — the file IS the reference —
    // so arriving at it with the file in place is what completing it means. A scaffolded step is
    // NOT done here: the learner still has to fill the stubbed ranges in, and *Check my work* is
    // what says they did. `wasDone` is the guard that keeps this to ONE commit per step: the
    // tree re-fires `goTo` for the step already current, and `git commit` on an unchanged file
    // fails with "nothing to commit", which would surface as a refusal that never happened.
    const complete = dial === 'automated' && attempt.landed && !wasDone;
    if (complete) this.progress = markDoneIn(this.progress, stepId);

    // The reveal this pass owes the learner (AC4; code review finding 2), and every part of
    // the condition is load-bearing. The file APPEARED — `landed` measured against the existence taken
    // above — so an overwrite, a *Keep mine* and a re-entered step all stay silent: `goTo`
    // revealed those already, and re-centring the editor under someone reading it is exactly
    // the jank `setDial`'s no-reveal rule exists to avoid. And the step is still the CURRENT
    // one: a pass the walk has moved past still writes its file (see this method's header),
    // but `refresh` reveals whatever is current, so revealing from a deferred pass would drag
    // the editor onto another step's file — or, if that one is not written yet, strip the
    // decorations off the file the learner is actually looking at.
    const appeared = attempt.landed && !existedBefore && stepId === this.progress.current;

    this.concludePass(before, appeared);
    if (complete) await this.commitFor(step);
  }

  /**
   * One push at the end of an entry pass, and a `saveProgress` only if there is something new
   * to save. Splitting the two matters because the pass runs on EVERY arrival at a step,
   * including the arrivals a learner makes by clicking the step they are already on.
   *
   * `revealEditor` is the pass's OWN reveal, and the only one that is not a navigation (code
   * review finding 2): the file this pass just wrote could not be revealed when the learner
   * arrived, because it did not exist yet. `applyDial` decides it; every other caller passes
   * `false`, and a pass that reveals also refreshes even when it has nothing else to say.
   */
  private concludePass(before: Progress, revealEditor: boolean): void {
    if (this.progress !== before) this.commit(revealEditor);
    else if (revealEditor || this.note !== undefined) this.refresh(revealEditor);
  }

  /**
   * The write itself, and the one rule that matters around it: **never overwrite a learner's
   * edits silently** (spec §5.4). Decides and reports; it never persists and never pushes,
   * so `applyDial` keeps one place that does both.
   *
   * Three states, and only one of them is a conflict:
   *
   *   - **nothing there** — write it. The ordinary case, and the whole point of the position.
   *   - **already exactly these bytes** — leave it, say nothing. A step re-entered after it
   *     was written is not a conflict, and prompting there would train the learner to dismiss
   *     the one dialog that exists to protect their work.
   *   - **there and different** — ask, ONCE per (step, file) for the life of the session, and
   *     then honour the answer without asking again. The tree re-fires `goTo` for the step
   *     already current, so an unremembered prompt would reappear on every click until it got
   *     the answer it wanted; and a *Keep mine* that stopped meaning keep mine the moment the
   *     learner clicked their own step in the tree would be the most expensive kind of bug
   *     this file can have.
   */
  private async writeFile(step: StepLike, absPath: string, content: string): Promise<WriteAttempt> {
    const existing = this.adapters.readText(absPath);
    // Identical, so there is nothing to do and nothing to SAY. The absent note is what stops a
    // re-entered step from re-announcing a write that happened ten clicks ago, and `landed` is
    // still true: the file holds exactly this step's bytes, however it came to.
    if (existing === content) return { landed: true };

    let overwriting = false;
    if (existing !== undefined) {
      const asked = this.prompted.get(step.id) ?? new Set<string>();
      if (asked.has(absPath)) {
        return {
          landed: false,
          note: `Your own ${step.target.file} was kept — you chose that earlier in this session, and you are not asked again.`,
        };
      }
      asked.add(absPath);
      this.prompted.set(step.id, asked);
      const overwrite = await this.adapters.confirmOverwrite(step.target.file);
      // The learner's answer is honoured wherever the WALK has moved to while the dialog was
      // up (`applyDial`'s header argues why, and why the modal makes that a narrow case). A
      // SESSION torn down under it is the exception: its target may already belong to the
      // session that replaced it, and no note is left either, since there is nobody to read one.
      if (this.disposed) return { landed: false };
      if (!overwrite) {
        return { landed: false, note: `Your own ${step.target.file} was kept. Nothing was written over it.` };
      }
      overwriting = true;
    }

    try {
      // The third argument is the target ROOT, and it is what makes the containment check a
      // real one rather than a lexical one (security review finding 1, closed in `writer.ts`):
      // `planWrite` proved this path stays inside the folder by `path` alone, and `renameSync`
      // protects the final component, but a directory component that becomes a symlink between
      // those two answers — a concurrent local process, while the overwrite prompt is up — is
      // re-checked at the last instant only when the root is handed over. Every write path in
      // this extension passes it; none of them is the one that skips the gate.
      writeTextAtomic(absPath, content, this.target);
    } catch (err) {
      // A folder that will not take a write is a standing condition — it fails on this step and
      // on every step after it — so it is stated in the panel each time (free, and where the eye
      // already is) and put in front of the learner exactly once.
      const reason = messageOf(err);
      this.reportWriteFailure(reason);
      return { landed: false, note: `${step.target.file} could not be written — ${reason}` };
    }

    return {
      landed: true,
      note: overwriting
        ? `${step.target.file} was replaced with this step's version, as you asked.`
        : `${step.target.file} was written for you.`,
    };
  }

  /**
   * *Check my work*, for one step — the structural comparison, the verdict, and what a pass
   * earns (AC5, AC7).
   *
   * `null` from `runCheck` is answered here and never surfaced as a failure. It is the state
   * manual mode is in until the learner creates the file, and it also covers a language
   * repo-tour has no grammar for and a `shape` step whose target is a directory: none of those
   * is a step the learner got WRONG, and marking one ✗ would tell them they had.
   */
  private async applyCheck(stepId: string): Promise<void> {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) return;

    const refRoot = this.request?.referenceRoot;
    if (refRoot === undefined) {
      this.noteFor(stepId, 'This tutorial has no reference repository recorded, so there is nothing to check against.');
      return;
    }

    const core = await this.adapters.core();
    // The same LIVENESS re-checks `applyDial` makes, for the same reason and now for the same
    // reach (code review finding 3): `enqueue` guards a job that has not STARTED, and only the
    // job itself can guard it once it has. Everything past here writes `progress.json` and
    // repaints all three surfaces — undoing the clear `dispose()` has just pushed, or painting
    // over the session that replaced this one on the same folder — and then runs git.
    // The one-liner the handoff proposed for this, a `disposed` check at the top of `refresh`,
    // would not have covered it: `commit` PERSISTS before it refreshes, and `commitFor` runs
    // afterwards, so `saveProgress` and the commit would both still have happened.
    if (this.disposed) return;
    if (!core) {
      this.reportCoreMissing();
      return;
    }

    // NOT `void`ed and NOT swallowed: a throw here is an unloadable core or a missing grammar,
    // and `enqueue` routes it to `reportError`. See `src/dial/check.ts`'s header.
    const outcome = await runStructuralCheck(core, refRoot, this.target, step);
    // The second one, and the wide one: this await is two tree-sitter parses, which is a
    // comfortably long time for a folder to be closed or a walk to be re-opened in.
    if (this.disposed) return;
    if (outcome === null) {
      this.noteFor(stepId, `There is nothing to check here yet — ${step.target.file} has not been created, so there is no shape to compare.`);
      return;
    }

    this.checks.set(stepId, outcome);
    const wasDone = this.progress.steps[stepId]?.status === 'done';
    this.progress = setCheck(this.progress, stepId, outcome.report.ok, new Date().toISOString());
    // One persist, not two: "this check passed" and "this step is done" are the same fact, and
    // writing them separately leaves a window where `progress.json` claims one without the
    // other. A failed check records the verdict and leaves the step pending, which is exactly
    // what the tree needs to draw ✗ on a step the learner is still working on.
    if (outcome.report.ok) this.progress = markDoneIn(this.progress, stepId);
    this.commit(false);
    // ONE commit per step, not one per click. `wasDone` is what makes that true: a learner who
    // presses *Check my work* twice on a step they have already passed would otherwise get a
    // second `git commit` on an unchanged file, which fails with "nothing to commit" and reads
    // in the panel as a refusal — a complaint manufactured by asking the same question twice.
    if (outcome.report.ok && !wasDone) await this.commitFor(step);
  }

  /**
   * One commit per completed step, in the LEARNER'S own repository (AC7) — off by
   * `buildTutorials.commitPerStep`, read now rather than at `open` so turning it off takes
   * effect on the next step and not in the next window.
   *
   * `commitStep` never throws and never invents an author: a folder with no git identity comes
   * back as `{ committed: false, reason }`, which is a refusal on principle rather than a
   * failure (its header argues it at length — a tutorial putting a name the learner never
   * chose on a repository they will keep and push is graffiti with a signature). So the reason
   * is shown in the panel, where it is free to read and costs no dismissal, and put in front
   * of them exactly ONCE for the session: an unconfigured identity does not fail once, it
   * fails on every step of a 61-step plan, and the learner fixes it with one `git config`
   * whenever they like — after which the very next step commits normally.
   *
   * The ADVICE in that notice is gated on the refusal actually having been a missing identity
   * (code review finding 8). It used to be given for every reason there is — "nothing to
   * commit", a stale `index.lock`, a `pre-commit` hook that said no — where telling a learner
   * to run `git config user.name` is an instruction that fixes nothing and points them away
   * from the sentence that says what really happened. Both wordings carry the reason itself,
   * because that is the part they can act on.
   */
  private async commitFor(step: StepLike): Promise<void> {
    if (!this.adapters.commitPerStep()) return;
    const result = await commitStep(this.target, step, [step.target.file], this.adapters.git);
    // The third liveness re-check (code review finding 3). A git run is the widest await on
    // either path that reaches here, and everything below it pushes a view.
    if (this.disposed) return;
    if (result.committed) return;

    const reason = result.reason ?? 'git did not say why';
    this.noteFor(step.id, `${step.target.file} was not committed — ${reason}.`);
    if (this.commitReported) return;
    this.commitReported = true;
    this.adapters.reportError(this.commitNotice(result, reason));
  }

  /**
   * The once-per-session sentence about a step that did not commit — THREE of them, because a
   * refusal, an ordinary failure and a stopped subprocess are three different things to be
   * told, and the difference is what the learner does next.
   *
   * **Branched on `CommitResult.refusal`, never on the reason text** (T-13 review finding 3).
   * The reason carries git's own argv, and `commitStep`'s argv carries `commitSubject(step)` —
   * the plan's question and option label, out of a `plan.json` this extension did not write.
   * Driven: matching on the sentence let a plan whose question read `timed out after 1 second
   * and was stopped` choose the stopped-git wording for an ordinary exit-1 commit, and one
   * reading `no git identity configured in this folder` choose the identity advice. The
   * sentence is still SHOWN — it is the half the learner can act on — it just does not get to
   * pick which sentence surrounds it.
   *
   * The reason itself is carried in all three. What varies is what comes after it.
   *
   *   - **A missing identity** is a refusal on principle, and the only one this extension can
   *     tell them how to fix in a line (code review finding 8 — the advice used to be given
   *     for every reason there is, including the ones it fixes nothing about).
   *   - **A git that was STOPPED at its bound** (T-13) is neither a refusal nor a failure of
   *     theirs, and the ordinary sentence would be subtly false for it: "only the bookkeeping
   *     commit did not happen" is a claim about a subprocess nobody waited for the end of. So
   *     it says what IS known — the bound was ours, their file is untouched, the next completed
   *     step retries — and names the bound as ours, so a slow network drive reads as a wait we
   *     imposed rather than as git misbehaving.
   *
   *     **What it deliberately no longer says is anything about `.git/index.lock`** (review
   *     finding 2). That advice was here, and it was false for the only signal this extension
   *     sends: driven, `git` registers its lock files with `sigchain` and removes them on
   *     `SIGTERM` — lock verified held mid-hook, gone after the runner's own signal, next
   *     commit fine, and 0 survivors in 12 randomised kills. It survives `SIGKILL`, which the
   *     runner now does send after its grace period, so a stale lock went from impossible to
   *     merely rare — and telling every stopped-git learner to delete a file inside `.git/` on
   *     the strength of the rare case is still the wrong trade. Nothing is lost by dropping it:
   *     when a lock really does survive, the next commit's reason says so, naming the file and
   *     what to do, down the branch below. That advice is this extension's, given only when the
   *     files are really there (`staleLockAdvice`, `src/dial/commit.ts`, T-82). It no longer comes
   *     from git: 2.43 printed "remove the file manually to continue", 2.54 and later do not, and
   *     git's words are translated.
   *   - **Anything else** — a stale lock, a `pre-commit` hook, a detached HEAD — keeps the
   *     wording it has always had, and carries git's own words with it.
   */
  private commitNotice(result: CommitResult, reason: string): string {
    const preamble = `Your step was not committed in ${this.target} — ${reason}.`;
    if (result.refusal === 'no-identity') {
      return `${preamble} The tutorial carries on either way; set \`git config user.name\` and `
        + '`git config user.email` in that folder and the next completed step will commit normally. '
        + '(Build Tutorials never commits under a name you did not choose, and the '
        + '`buildTutorials.commitPerStep` setting turns this off.)';
    }
    if (result.refusal === 'git-stopped') {
      return `${preamble} That bound is this extension’s, not git’s — it is there so a git that never `
        + 'returns cannot leave you pressing a button that does nothing. The tutorial carries on and '
        + 'your file is on disk exactly as this step left it; nothing of yours was edited. The next '
        + 'completed step tries again on its own.';
    }
    return `${preamble} The tutorial carries on either way and nothing of yours was changed — your `
      + 'file is on disk exactly as this step left it, and only the bookkeeping commit did not happen. '
      + '(The `buildTutorials.commitPerStep` setting turns the per-step commit off if you would rather '
      + 'it did not try.)';
  }


  /**
   * Copies `plan.reproduce` into the target and records that it happened — or copies nothing
   * and says what it would have written over (AC6; security review finding 3, code review
   * finding 6). Returns what the caller has to act on: whether anything was copied, so a
   * pointless persist can be skipped, and the sentence to show, when there is one.
   *
   * **`mayReplace` is about the gesture, not about the position of the dial.** This runs from
   * two places with completely different standing. `applyDial` calls it on arrival in
   * automated mode — on activation, before the learner has pressed anything — and `reproduce()`
   * calls it because somebody pressed the offer. The rule this ticket names by name is that a
   * learner's edits are never overwritten silently, and these files are theirs to have edited
   * like any other: running `npm install` in the target (which the spec leaves to them on
   * purpose) rewrites `package-lock.json`, and this used to replace it without a word. So an
   * arrival copies only what is absent or already identical, names the count of what it did
   * not touch, and leaves the offer standing; the press that follows is the gesture, made with
   * the number already in front of them.
   *
   * `reproduced` is recorded even when some entries failed, and that is the honest answer
   * rather than a lax one: the pass RAN, every entry that could be copied was, and the ones
   * that could not are named in `reportError` where a person can act on them. Recording
   * nothing would leave the panel offering a copy that has already been made, and re-running
   * it would not fix a reference file that is missing.
   */
  private reproduceInto(mayReplace: boolean): { copied: boolean; note?: string } {
    if (this.progress.reproduced !== undefined) return { copied: false };
    const refRoot = this.request?.referenceRoot;
    // `deliverableEntries`, not `reproduceEntries` (T-12 review finding 1). The question here is
    // "what will land", and a withheld entry never lands — so counting it made the overwrite
    // prompt fire for a file that would never be written (blocking the whole copy on the first
    // press) and then claim it "was replaced" on the second, over bytes nothing had touched.
    const entries = deliverableEntries(this.plan);
    if (refRoot === undefined || entries.length === 0) return { copied: false };

    const replacing = entries.filter((entry) => this.wouldReplace(refRoot, entry));
    if (replacing.length > 0 && !mayReplace) {
      // Once per session. Nothing was recorded, so `reproduce.done` is still false and the
      // panel's offer — with its own count of the whole list — is still on the page; saying
      // this again on the next automated step would be noise around a decision the learner is
      // already holding. The same standing-condition rule `reportCoreMissing` follows.
      if (this.reproduceAnnounced) return { copied: false };
      this.reproduceAnnounced = true;
      return {
        copied: false,
        // The list is copied as ONE act and recorded as one instant, so it is held as one too:
        // "nothing was copied" is the first thing the sentence says, because a press that
        // half-happened would leave `progress.reproduced` describing a copy that did not.
        note: replacing.length === 1
          ? `Nothing was copied: ${namesOf(replacing)} is already here and differs from this project's own, and nothing of yours is written over without asking. Copy them in again to replace it.`
          : `Nothing was copied: ${replacing.length} of these files are already here and differ from this project's own (${namesOf(replacing)}), and nothing of yours is written over without asking. Copy them in again to replace them.`,
      };
    }

    const { problems, withheld } = reproduceFiles(this.plan, refRoot, this.target);
    this.progress = { ...this.progress, reproduced: new Date().toISOString() };
    if (problems.length > 0) {
      this.adapters.reportError(
        `Some of this project's generated files could not be copied into ${this.target}: ${problems.join('; ')}`,
      );
    }
    // NOT `reportError` (T-12 review finding 8). A withheld entry is the rule working, and on the
    // default demo path — repo-tour, which commits `.claude/settings.json` — it happens to every
    // learner on their first automated step. Routing it through the error channel meant the
    // feature announced its own correct operation as a failure. It is said in the panel's note,
    // beside the copy it belongs to, in the learner's own reading order.
    const withheldNote = withheld.length === 0
      ? undefined
      : withheld.length === 1
        ? `One file was left for you rather than copied: ${withheld[0]}.`
        : `${withheld.length} files were left for you rather than copied: ${withheld.join('; ')}.`;
    return {
      copied: true,
      // Said afterwards as well as before, because "3 files were replaced" is what makes the
      // warning a warning rather than a form to click through.
      ...(() => {
        const replaced = replacing.length === 0
          ? undefined
          : replacing.length === 1
            ? `${namesOf(replacing)} was replaced with this project's own version, as you asked.`
            : `${replacing.length} files that were already here were replaced with this project's own versions, as you asked.`;
        const note = [replaced, withheldNote].filter((part) => part !== undefined).join(' ');
        return note === '' ? {} : { note };
      })(),
    };
  }

  /**
   * Would copying `entry` write over something of the learner's? Asked of every entry before
   * any of them is copied, and it is what lets the ordinary case stay quiet: a target that
   * does not have the file yet, or already holds exactly the reference's bytes, loses nothing
   * — the identical-bytes short-circuit `writeFile` has had all along, now on this path too
   * (code review finding 6).
   *
   * "Exactly" is the hard half, because `readText` DECODES and `reproduce` is the one path
   * that carries files which are not text at all: two different binaries can decode to the
   * same lossy string, and answering "identical" for those would silently overwrite the very
   * file this check exists to notice. A decode that lost anything leaves U+FFFD behind, so a
   * string carrying one is not evidence of anything and counts as a replacement. The direction
   * is deliberate — over-counting costs one sentence, under-counting costs a learner's file.
   */
  private wouldReplace(refRoot: string, entry: string): boolean {
    const to = resolveInsideTarget(this.target, entry);
    // A refused path is not a replacement: nothing will be written for it at all, and
    // `reproduceFiles` names it among the problems it hands back.
    if (to === null || !this.adapters.fileExists(to)) return false;
    const from = resolveInsideTarget(refRoot, entry);
    if (from === null) return false;
    const mine = this.adapters.readText(to);
    return !(mine !== undefined && mine === this.adapters.readText(from) && !mine.includes('\uFFFD'));
  }

  /**
   * Drops the last action's sentence and the last step's shape, SYNCHRONOUSLY, before the
   * refresh that a navigation is about to make.
   *
   * The timing is the whole of it, and getting it wrong is invisible for the common case. Both
   * fields are tagged with the step they belong to, so moving to a DIFFERENT step already stops
   * rendering them — but re-entering the step already current is an ordinary gesture (it is how
   * a learner asks for their file back), and there the tag matches. Clearing inside the
   * asynchronous entry pass is too late: `commit` has already pushed a view carrying the note
   * from the previous visit, and a pass that changes nothing never refreshes again, so
   * "src/parse.ts was written for you" would reappear under a click that wrote nothing at all.
   */
  private clearStepNotes(): void {
    this.shape = undefined;
    this.note = undefined;
    // T-21: a refused press describes that press, not the step.
    this.choiceRefusal = undefined;
    // T-6: the tutor's own sentence goes with them, for the identical reason — "the tutor did
    // not answer within 120 seconds" describes something that just happened, not a step. What
    // does NOT go is `unreachable`: that one is a standing condition of the provider rather
    // than an event, so it survives navigation and keeps the honest line beside the input.
    // Nor does the transcript, which is not a note at all — it is on disk, per step, and
    // switching steps switches it by construction (AC2).
    this.tutorNote = undefined;
    // `accepted` is a signal to ONE page about ONE draft, so it has the shortest life of any
    // of these: a learner who navigates away is looking at a different box, and telling that
    // box its draft was accepted would empty a question about another step.
    this.lastAsked = undefined;
    // T-7: the detour's own sentence, for the identical reason — "the model did not send an
    // example in time" describes an event, not a step. What does NOT go is the OPEN detour:
    // navigating with an example still on screen is an ordinary thing to do, and forgetting
    // it here would leave five tabs and a narrator with nothing left that could close them.
    this.detourSession?.clearNote();
  }

  /** A transient sentence about what just happened, tagged with the step it is about, then
   *  pushed — see `WalkView.writeNote` for why the tag matters. */
  private noteFor(stepId: string, text: string): void {
    this.setNote(stepId, text);
    this.refresh(false);
  }

  /**
   * The same sentence, recorded WITHOUT a push, and joined when there is more than one — the
   * form an entry pass needs, since `concludePass` owns that pass's single push.
   *
   * More than one is ordinary rather than exceptional: the first arrival that finds a
   * `plan.reproduce` file the learner has changed has something to say about that as well as
   * about the step's own file, and the panel has one line to say both in. Absent sentences are
   * dropped rather than joined into stray spaces, and a call with nothing to say leaves the
   * previous note alone — a pass that says nothing must not silently blank a sentence.
   */
  private setNote(stepId: string, ...sentences: (string | undefined)[]): void {
    const text = sentences.filter((sentence): sentence is string => sentence !== undefined).join(' ');
    if (text.length > 0) this.note = { stepId, text };
  }

  /** ONCE per session, for the same reason `reportPersistFailure` is: a repo-tour that will
   *  not load is a standing condition the doctor explains and the learner fixes in settings,
   *  not something to re-state on every step they walk past. */
  private reportCoreMissing(): void {
    if (this.coreReported) return;
    this.coreReported = true;
    this.adapters.reportError(
      'repo-tour could not be loaded, so nothing can be written or checked for you. The walk '
      + 'still works and your files are untouched — run Build Tutorials: Doctor to see which '
      + 'path it tried.',
    );
  }

  /** ONCE per session, same reasoning again: a target folder that refuses a write refuses
   *  every write, and the panel goes on saying so per step at no cost to anybody. */
  private reportWriteFailure(reason: string): void {
    if (this.writeReported) return;
    this.writeReported = true;
    this.adapters.reportError(
      `Could not write this step's file into ${this.target} — the folder may be read-only, or `
      + `the disk full. Nothing of yours was changed. (${reason})`,
    );
  }

  // ── write, then push, then complain ────────────────────────────────────────────────────

  /**
   * Every mutator above ends here, and the ORDER of these three lines is code review finding
   * 4's fix. Read it before reordering them.
   *
   * The bug it closes: `goTo` used to mutate `this.progress`, call `saveProgress`, and only
   * then `refresh`. A write can genuinely fail — a read-only target folder, a full disk, sync
   * or anti-virus software holding the rename open — and the throw travelled out through
   * `handleStepMessage`, `onMessage` and the webview's `onDidReceiveMessage` listener, where
   * VS Code logs it and shows the learner NOTHING. The session had already advanced; not one
   * surface had been told. So the page still read step 1 while the session sat on step 2, the
   * learner pressed Next again, and the session went to step 3 behind a page that had never
   * moved. One failed `fs.rename` suspended every rule this file states about the tree, the
   * panel, the status bar and the editor never disagreeing.
   *
   * The navigation is KEPT rather than rolled back. It is what the learner just asked for,
   * they watched themselves ask for it, and the walk works perfectly well from memory — what
   * they have actually lost is the walk REMEMBERING where they are the next time they open
   * the folder, which is what the message says and all it says. Rolling back would refuse
   * them a step they are entitled to in order to protect a file that is not writable anyway.
   *
   * `refresh` runs BEFORE `reportError`, so the surfaces are already in agreement by the time
   * anything is put in front of anyone — which also means an adapter that misbehaves inside
   * the report cannot re-open the very desync this method exists to close.
   */
  private commit(revealEditor: boolean): void {
    const failure = this.persist();
    this.refresh(revealEditor);
    if (failure !== undefined) this.reportPersistFailure(failure);
  }

  /**
   * Writes the progress and NEVER throws: it returns the reason the write failed, or
   * `undefined`. Returning the reason rather than reporting it from in here is exactly what
   * lets `commit` put the refresh first; see there.
   */
  private persist(): string | undefined {
    try {
      this.adapters.saveProgress(this.target, this.progress);
      return undefined;
    } catch (err) {
      return messageOf(err);
    }
  }

  /**
   * ONCE per session, never once per click. A folder that cannot be written to does not fail
   * once: it fails on every navigation, every dial change and every step marked done, and a
   * learner walking the 61-step plan we have would spend the tutorial dismissing notifications
   * instead of reading code. The condition is a standing one, so it is stated once, plainly,
   * and then endured quietly — the walk itself keeps working the whole time, which is the
   * point of keeping the navigation in `commit`.
   *
   * Worded for the learner rather than for us: it names the folder, says what they have
   * actually lost (their place, next time — not their work, and not this session), and carries
   * the underlying reason at the tail for the output channel, where whoever diagnoses a
   * read-only checkout or a full disk will go looking.
   */
  private reportPersistFailure(reason: string): void {
    if (this.persistReported) return;
    this.persistReported = true;
    this.adapters.reportError(
      `Could not save your progress in ${this.target}. The walk still works, but it will not `
      + 'remember which step you are on, or any road you have chosen, the next time you open this folder — the folder may be '
      + `read-only, or the disk full. (${reason})`,
    );
  }

  // ── the single push point ──────────────────────────────────────────────────────────────

  /**
   * Builds one `WalkView` and hands it to every surface. The only place state leaves this
   * object; see the file header for why `revealEditor` is a parameter rather than always-on.
   *
   * The no-current-step case is handled honestly rather than by throwing — a hand-built
   * fixture, or a plan whose chapters produced no steps at all, can genuinely reach here —
   * and it means exactly what it says everywhere: nothing in the tree, nothing in the panel,
   * an EMPTY status bar (never "step 1 / 0", which would be a number invented to fill a slot),
   * and no editor left decorated from whatever was showing before.
   */
  private refresh(revealEditor: boolean): void {
    const view = this.buildView();
    this.view = view;
    this.adapters.setTree(view);
    this.adapters.setPanel(view);
    // The GLOBAL dial is passed here (T-5, AC1) and that is the whole of what T-4's status bar
    // was missing: it read the per-step override alone and fell back to `manual`, so a learner
    // who set `automated` on the start screen was told, on every step they had not touched,
    // that nothing was being written for them while it was.
    this.adapters.setStatus(view ? statusText(this.plan, this.progress, this.request?.dial) : '');
    if (!revealEditor) return;
    if (view?.fileExists) this.adapters.revealEditor(view);
    else this.adapters.clearEditor();
  }

  private buildView(): WalkView | undefined {
    // The plan every surface is shown carries the learner's choices (T-21) — overlaid here, in
    // ONE place, onto a new plan object; `this.plan` stays exactly what repo-tour wrote.
    const shown = withChosen(this.plan, this.progress);
    const step = currentStep(shown, this.progress);
    if (!step) return undefined;
    // `resolveInsideTarget`, NOT `path.join` — security review finding 2, argued in full in
    // `./paths.ts`. `path.join('/home/you/repo', '../../../.ssh/id_rsa')` is a perfectly real
    // path to somebody's private key, and `refresh(true)` reveals the current step's file on
    // activation, so the old code needed no click at all between a crafted `plan.json` and an
    // open editor tab. A `null` here is "there is nothing to open", which every surface
    // already knows how to render honestly (`fileExists: false` is the ordinary state of a
    // file T-5 has not written yet), so the escape is a dead end rather than an error thrown
    // at a learner who did not write the plan. Note `fileExists` is not even ASKED about an
    // escaping path: the adapter is `fs.statSync` on the real filesystem, and a containment
    // check that consults the disk first is a containment check that already lost.
    const absPath = resolveInsideTarget(this.target, step.target.file);
    // T-5's four optional fields are SPREAD IN rather than set to `undefined`, so a view for a
    // step with no note and no check has no `writeNote` and no `check` key at all. The step
    // panel keys its repaints on a rendered-field digest (`keyFor`), and `undefined` versus
    // absent is exactly the kind of difference that decides whether a repaint happens.
    // What the panel OFFERS must be what will land (T-12 review finding 8): the offer said
    // "3 files" and delivered 2.
    const reproducible = deliverableEntries(this.plan).length;
    const check = this.checks.get(step.id);
    return {
      plan: shown,
      progress: this.progress,
      step,
      fileExists: absPath !== null && this.adapters.fileExists(absPath),
      dial: stepDial(this.progress, step.id, this.request?.dial),
      ...(this.shape?.stepId === step.id ? { shape: this.shape.shape } : {}),
      ...(check ? { check } : {}),
      ...(this.note?.stepId === step.id ? { writeNote: this.note.text } : {}),
      ...(this.choiceRefusal?.stepId === step.id
        ? { choiceNote: choiceRefusalText(this.choiceRefusal.reason, this.choiceRefusal.inARow) }
        : {}),
      ...(reproducible > 0
        ? { reproduce: { count: reproducible, done: this.progress.reproduced !== undefined } }
        : {}),
      // T-6 (AC2). Read through `getTranscript` and never off `progress.steps[id].transcript`,
      // because that is the one function that decides what is safe to render back to a learner
      // as their own conversation — `store.ts` validates `check` and passes `transcript`
      // through untouched, so reaching past it here would hand the panel whatever a
      // hand-edited `progress.json` happened to contain. Keyed by the CURRENT step, which is
      // the whole of "switching steps switches transcripts, and returning restores": there is
      // no cache to invalidate and no rule for this method to remember.
      transcript: getTranscript(this.progress, step.id),
      // Always present, unlike T-5's four — a `thinking: false` is a real and drawable state
      // (it is what puts *Ask* on the page rather than *Cancel*), so there is nothing for an
      // absent key to mean. Both optional halves are spread in the same "absent, not
      // `undefined`" way the rest of this object uses, because `step-panel.ts` keys its
      // repaints on a digest of what is drawn and absent-versus-undefined is exactly the kind
      // of difference that decides whether a repaint happens.
      tutor: this.tutorView(step.id),
      // T-7. Always present, for the reason `tutor` is: "nothing open, nothing generating" is
      // the state that puts the button on the page. Asked of the session rather than stored
      // here, so there is one answer to "is a detour open" and no flag to keep in step. A
      // walk with no detour adapters answers the empty state, which is what draws the button
      // as unavailable rather than as broken.
      detour: this.detourSession?.view(step.id) ?? { generating: false },
    };
  }

  /**
   * The tutor's transient half for ONE step — see `TutorView`, which argues every field.
   *
   * `thinking` and `stage` are read off the same expression rather than tracked beside each
   * other, so there is still exactly one answer to "is a spinner on screen" (AC4) and no
   * second flag anybody has to remember to clear. `elsewhere` and `spend` come off the LEDGER,
   * which is the only thing that starts a paid request, so neither can be stale and neither
   * depends on a branch above remembering to report.
   */
  private tutorView(stepId: string): TutorView {
    const here = this.asking?.stepId === stepId ? this.asking : undefined;
    const stage = here?.ticket.phase;
    // Anything live that does NOT belong to the step on screen. `thinking` is per-step by
    // design (a learner who navigates away must not find a spinner on the step they arrived
    // at), and the cost of that used to be a billing request with no control anywhere in the
    // UI to stop it — code review finding 3. The ledger knows where every live ask is, so the
    // page can now name it and offer to stop it from wherever the learner is standing.
    // Abandoned asks are deliberately excluded: they are still running and still billing, and
    // `spend.unwatched` is where that is said — but this line comes with a CONTROL, and a
    // control that cannot act on what it names is the exact thing this repo's conventions rule
    // out. There is nothing left to cancel about an ask the learner already cancelled.
    const away = this.ledger.live().find((entry) => entry.stepId !== stepId && !entry.abandoned);
    const spend = this.ledger.spend();
    return {
      thinking: here !== undefined,
      ...(stage === 'preparing' || stage === 'sending' ? { stage } : {}),
      ...(this.unreachable !== undefined ? { unreachable: this.unreachable } : {}),
      ...(this.tutorNote?.stepId === stepId ? { note: this.tutorNote.text } : {}),
      ...(away ? { elsewhere: { stepId: away.stepId, stage: away.phase } } : {}),
      // Absent, not zeroed, when this walk has neither spent anything nor got anything in the
      // air: an empty object would draw an empty box and move the repaint key for nothing.
      ...(spend.replies > 0 || spend.sending > 0 || spend.preparing > 0 ? { spend } : {}),
      ...(this.lastAsked?.stepId === stepId ? { accepted: this.lastAsked.text } : {}),
    };
  }

  private hasStep(stepId: string): boolean {
    return this.plan.steps.some((s) => s.id === stepId);
  }

  /**
   * A `current` that names no step in this plan is repaired, in memory, to the plan's first
   * step. It happens for one unremarkable reason: the tutorial was rebuilt (new plan, new step
   * ids) over a `progress.json` that is still perfectly valid JSON, so `loadProgress` has
   * nothing to object to and hands back a position that no longer exists. Left alone, that is
   * a walk with an empty tree and an empty panel on top of a plan that is entirely fine.
   *
   * `nextStepId` already defines "nothing is current" as "the first step by ordinal", so this
   * borrows that answer rather than inventing a second definition of where a walk begins — and
   * a plan with no steps yields `null` there, which correctly leaves the empty case empty.
   * Not persisted: the repair is deterministic, so the next `open` reaches the same place, and
   * merely opening a tutorial still writes nothing into the learner's folder.
   */
  private resolveCurrent(): void {
    if (currentStep(this.plan, this.progress)) return;
    const first = nextStepId(this.plan, this.progress);
    if (first) this.progress = setCurrent(this.progress, first);
  }
}

/** Whatever was thrown, as something a person can read. An `Error` with an empty message says
 *  nothing at all, so it falls through to `String(err)` the same way a thrown string does —
 *  the identical rule a failed `saveProgress` gets, which is why `persist` calls this rather
 *  than spelling it out a third time (code review finding 10). */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : String(err);
}

/**
 * A measured wait, as a phrase that agrees with itself.
 *
 * `Math.max(1, Math.round(ms / 1000))` used to be spelled inline and produced "within 1
 * **seconds**" for every ask that failed faster than half a second — which, before the
 * deadline was bounded, was every ask on a machine whose `tutorTimeoutSeconds` was a string
 * (code review finding 9). The floor of one is kept deliberately: a `timedOut` measured at
 * 400 ms is still a real wait the learner sat through, and "within 0 seconds" reads as a bug
 * report rather than as a sentence.
 */
function secondsPhrase(ms: number): string {
  const seconds = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/**
 * Up to three `plan.reproduce` entries by name, the rest as a count. A real reproduce list runs
 * to hundreds of entries — lockfiles, a `dist/` tree, vendored bundles — and a sentence naming
 * every one of them is not more informative, it is unreadable. Each name is capped for the same
 * reason `src/walk/step-view.ts` caps plan text: these strings come out of `plan.json` like
 * everything else, and nothing has promised they are short.
 */
function namesOf(entries: string[]): string {
  const shown = entries.slice(0, 3).map((entry) => (entry.length <= 80 ? entry : `${entry.slice(0, 79)}…`));
  const rest = entries.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}
