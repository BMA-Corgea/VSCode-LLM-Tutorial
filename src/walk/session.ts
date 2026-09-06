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
 *     read code in.
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
 *     file is the one way `writeTextAtomic`'s atomicity could still lose.
 *   - **Never prompt twice for the same (step, file) in one session.** This is the plan's own
 *     named write-ahead risk, and the reason is mechanical rather than theoretical: the tree
 *     re-fires `goTo` for the step already current (that is how a learner asks for their file
 *     back), so an overwrite prompt raised from inside the entry pass would come back every
 *     single time until they answered it the way it wanted. `prompted` remembers the pair,
 *     and a pair already asked about is answered by the learner's FIRST answer — *Keep mine*
 *     keeps meaning keep mine, for the rest of the session, without asking again.
 *   - **Identical content is not a conflict.** A file that already holds exactly the bytes
 *     the dial would write is left alone with nothing said: no prompt, no rewrite, no note. It
 *     is the ordinary state of a step re-entered after it was written, and prompting there
 *     would teach the learner to dismiss the one dialog that is supposed to protect their work.
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
 */

import type { GitRunner } from '../start/build.js';
import type { BuildRequest, Dial } from '../start/request.js';
import { commitStep } from '../dial/commit.js';
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
  reproduceEntries,
  reproduceFiles,
  writeTextAtomic,
  type FileShape,
} from '../dial/writer.js';
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
   * T-5 (AC6): `plan.reproduce`'s never-taught files — generated, vendored, lockfiles, data,
   * binaries. Absent when the plan lists none, so the panel has nothing to offer rather than
   * an offer of nothing. `done` is `progress.reproduced`, which survives a reload.
   */
  reproduce?: { count: number; done: boolean };
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
  loadRequest(target: string): BuildRequest | null;
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
   * cannot be read). This is the one input to the overwrite decision, so it is a question
   * about the learner's disk — which is what an adapter is for — rather than an `fs` import
   * this file has never needed (`./paths.ts` states that constraint out loud). Wire it as a
   * `readFileSync(absPath, 'utf8')` inside a `try`.
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
  /** `git`, for the commit per completed step (AC7). `src/start/build.ts`'s `realGit` wires in
   *  as-is; `src/dial/commit.ts` is what actually holds the git knowledge, including the rule
   *  that a missing identity is a refusal and never an invented author. */
  git: GitRunner;
  /** `buildTutorials.commitPerStep`. A getter, read at the moment of the commit rather than
   *  captured at `open`, so a learner who turns it off mid-walk is obeyed on their next step
   *  instead of on their next window. */
  commitPerStep(): boolean;
}

/**
 * What one attempt to put a step's file on disk actually did. Returned rather than acted on
 * inside `writeFile` so that `applyDial` keeps ONE place that decides what to persist, what to
 * push and what to commit — the alternative (a helper that refreshes and persists on its own)
 * is exactly the "second path that writes without pushing" this file's header rules out.
 *
 * `landed` and `wrote` are deliberately different questions. `landed` is "the file now holds
 * this step's bytes", which is true of a file that was ALREADY identical and is what decides
 * whether an automated step is complete; `wrote` is "bytes were actually put there", which is
 * true of nothing when a learner keeps their own version.
 */
interface WriteAttempt {
  landed: boolean;
  wrote: boolean;
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
  /** ONE serialised chain for every asynchronous job this session owns — applying a dial,
   *  running a check, reproducing the never-taught files. See the file header: serialising
   *  them is what stops two `goTo`s from racing two writes at the same file, and owning them
   *  is what keeps a failure out of an unwatched `void`ed promise. */
  private work: Promise<void> = Promise.resolve();
  /** `${stepId} ${absPath}` for every pair this session has already raised the
   *  Overwrite/Keep prompt for — the plan's named write-ahead risk (see the file header). */
  private readonly prompted = new Set<string>();
  /** The full report of the last check per step, this session only; the durable half lives in
   *  `progress.steps[id].check`. Keyed by step so a learner can check two steps and see both. */
  private readonly checks = new Map<string, CheckOutcome>();
  /** Manual mode's file shape, and the transient sentence about the last write — each tagged
   *  with the step it belongs to, which is how both stop being shown when the walk moves. */
  private shape: { stepId: string; shape: FileShape } | undefined;
  private note: { stepId: string; text: string } | undefined;

  private constructor(
    public readonly target: string,
    private readonly adapters: WalkAdapters,
    private readonly plan: PlanLike,
    private progress: Progress,
    /** `request.json`, read ONCE at `open` — the reference root and the global dial (AC1).
     *  `null` is ordinary; see `WalkAdapters.loadRequest`. */
    private readonly request: BuildRequest | null,
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

  /** The next step by ordinal, or nothing at all at the end of the plan — no wraparound. */
  next(): void {
    const id = nextStepId(this.plan, this.progress);
    if (id) this.goTo(id);
  }

  /** The previous step by ordinal, or nothing at all at the start of the plan. */
  prev(): void {
    const id = prevStepId(this.plan, this.progress);
    if (id) this.goTo(id);
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
   */
  setDial(stepId: string, dial: Dial): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    this.progress = setDialIn(this.progress, stepId, dial);
    const current = stepId === this.progress.current;
    if (current) this.clearStepNotes();
    this.commit(false);
    if (current) this.enterCurrentStep();
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
   */
  reproduce(): void {
    if (this.disposed) return;
    this.enqueue(() => {
      const step = currentStep(this.plan, this.progress);
      if (this.reproduceInto()) {
        this.commit(false);
        return;
      }
      // Pressed against a page whose offer is already spent — the panel hides it once
      // `reproduce.done` is true, so this only arrives from a stale render. Said rather than
      // swallowed: a button that does nothing and explains nothing is the one thing the walk's
      // conventions rule out.
      if (step) this.noteFor(step.id, 'This project’s generated files have already been copied — nothing was copied again.');
    });
  }

  /**
   * The promise of everything this session currently has in flight — a dial being applied, a
   * check running, files being reproduced.
   *
   * Not a test seam bolted on afterwards, and not a way for a surface to wait: the panel and
   * the tree are pushed to, they never ask. It exists because the acceptance criterion does.
   * AC6 is "walk every step in automated mode, then `diff -r` the target against the
   * reference", and a run that starts diffing while the last file is still being written is
   * not measuring what it claims to. `test/dial.test.ts` awaits this between the walk and the
   * diff; `test/unit/walk-session.test.ts` awaits it between an action and its assertion, for
   * the same reason.
   */
  settled(): Promise<void> {
    return this.work;
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
   */
  private enterCurrentStep(): void {
    const step = currentStep(this.plan, this.progress);
    if (!step) return;
    this.enqueue(() => this.applyDial(step.id));
  }

  /**
   * The dial, applied to one step (ACs 2, 3, 4, 7).
   *
   * Reads the step back by id rather than closing over the object, and stops if the walk has
   * moved on: a job that waited behind a modal for half a minute must not write the file of a
   * step nobody is looking at any more.
   */
  private async applyDial(stepId: string): Promise<void> {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step || this.progress.current !== stepId) return;

    // No `request.json` means no reference root: there is nothing to copy FROM, so no position
    // can write and none pretends to. Deliberately quiet — the plan is on disk without the
    // request that produced it, which is a folder somebody assembled by hand, not something
    // the learner did or can fix from the panel, and the surfaces already say the honest thing
    // (the file is not there, the dial reads what it reads).
    const request = this.request;
    if (request === null) return;
    const refRoot = request.repo;

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
    if (dial === 'automated') this.reproduceInto();

    const planned = planWrite(step, dial, refRoot, this.target, this.plan, core);
    if (planned === null) {
      // Nothing to write, and that is correct. A `shape` or `symbol` step owns no file of its
      // own; only the position's own meaning could have got us this far with a `file` step, and
      // `manual` already returned above.
      this.concludePass(before);
      return;
    }
    if (isRefusal(planned)) {
      // A refusal is a VALUE from `planWrite` precisely so it can be SHOWN. It means the plan
      // pointed outside the folder, or at a file that is not text, or at a language repo-tour
      // cannot stub — none of which the learner caused, and all of which they are entitled to
      // know about rather than watch a dial do nothing at all.
      this.note = { stepId, text: planned.refused };
      this.concludePass(before);
      return;
    }

    const attempt = await this.writeFile(step, planned.path, planned.content);
    if (attempt.note !== undefined) this.note = { stepId, text: attempt.note };

    // AC7's other half: an automated step has no check to pass — the file IS the reference —
    // so arriving at it with the file in place is what completing it means. A scaffolded step is
    // NOT done here: the learner still has to fill the stubbed ranges in, and *Check my work* is
    // what says they did. `wasDone` is the guard that keeps this to ONE commit per step: the
    // tree re-fires `goTo` for the step already current, and `git commit` on an unchanged file
    // fails with "nothing to commit", which would surface as a refusal that never happened.
    const complete = dial === 'automated' && attempt.landed && !wasDone;
    if (complete) this.progress = markDoneIn(this.progress, stepId);

    this.concludePass(before);
    if (complete) await this.commitFor(step);
  }

  /**
   * One push at the end of an entry pass, and a `saveProgress` only if there is something new
   * to save. Splitting the two matters because the pass runs on EVERY arrival at a step,
   * including the arrivals a learner makes by clicking the step they are already on.
   */
  private concludePass(before: Progress): void {
    if (this.progress !== before) this.commit(false);
    else if (this.note !== undefined) this.refresh(false);
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
    if (existing === content) return { landed: true, wrote: false };

    let overwriting = false;
    if (existing !== undefined) {
      const key = `${step.id} ${absPath}`;
      if (this.prompted.has(key)) {
        return {
          landed: false,
          wrote: false,
          note: `Your own ${step.target.file} was kept — you chose that earlier in this session, and you are not asked again.`,
        };
      }
      this.prompted.add(key);
      if (!(await this.adapters.confirmOverwrite(step.target.file))) {
        return { landed: false, wrote: false, note: `Your own ${step.target.file} was kept. Nothing was written over it.` };
      }
      overwriting = true;
    }

    try {
      writeTextAtomic(absPath, content);
    } catch (err) {
      // A folder that will not take a write is a standing condition — it fails on this step and
      // on every step after it — so it is stated in the panel each time (free, and where the eye
      // already is) and put in front of the learner exactly once.
      const reason = messageOf(err);
      this.reportWriteFailure(reason);
      return { landed: false, wrote: false, note: `${step.target.file} could not be written — ${reason}` };
    }

    return {
      landed: true,
      wrote: true,
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

    const refRoot = this.request?.repo;
    if (refRoot === undefined) {
      this.noteFor(stepId, 'This tutorial has no reference repository recorded, so there is nothing to check against.');
      return;
    }

    const core = await this.adapters.core();
    if (!core) {
      this.reportCoreMissing();
      return;
    }

    // NOT `void`ed and NOT swallowed: a throw here is an unloadable core or a missing grammar,
    // and `enqueue` routes it to `reportError`. See `src/dial/check.ts`'s header.
    const outcome = await runStructuralCheck(core, refRoot, this.target, step);
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
   */
  private async commitFor(step: StepLike): Promise<void> {
    if (!this.adapters.commitPerStep()) return;
    const result = await commitStep(this.target, step, [step.target.file], this.adapters.git);
    if (result.committed) return;

    const reason = result.reason ?? 'git did not say why';
    this.noteFor(step.id, `${step.target.file} was not committed — ${reason}.`);
    if (this.commitReported) return;
    this.commitReported = true;
    this.adapters.reportError(
      `Your step was not committed in ${this.target} — ${reason}. The tutorial carries on either `
      + 'way; set `git config user.name` and `git config user.email` in that folder and the next '
      + 'completed step will commit normally. (Build Tutorials never commits under a name you '
      + 'did not choose, and the `buildTutorials.commitPerStep` setting turns this off.)',
    );
  }


  /**
   * Copies `plan.reproduce` into the target and records that it happened. Returns whether
   * anything was actually attempted, so a caller can skip a pointless persist.
   *
   * `reproduced` is recorded even when some entries failed, and that is the honest answer
   * rather than a lax one: the pass RAN, every entry that could be copied was, and the ones
   * that could not are named in `reportError` where a person can act on them. Recording
   * nothing would leave the panel offering a copy that has already been made, and re-running
   * it would not fix a reference file that is missing.
   */
  private reproduceInto(): boolean {
    if (this.progress.reproduced !== undefined) return false;
    const refRoot = this.request?.repo;
    if (refRoot === undefined || reproduceEntries(this.plan).length === 0) return false;

    const problems = reproduceFiles(this.plan, refRoot, this.target);
    this.progress = { ...this.progress, reproduced: new Date().toISOString() };
    if (problems.length > 0) {
      this.adapters.reportError(
        `Some of this project's generated files could not be copied into ${this.target}: ${problems.join('; ')}`,
      );
    }
    return true;
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
  }

  /** A transient sentence about what just happened, tagged with the step it is about, then
   *  pushed — see `WalkView.writeNote` for why the tag matters. */
  private noteFor(stepId: string, text: string): void {
    this.note = { stepId, text };
    this.refresh(false);
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
      return err instanceof Error && err.message.length > 0 ? err.message : String(err);
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
      + 'remember which step you are on the next time you open this folder — the folder may be '
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
    const step = currentStep(this.plan, this.progress);
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
    const reproducible = reproduceEntries(this.plan).length;
    const check = this.checks.get(step.id);
    return {
      plan: this.plan,
      progress: this.progress,
      step,
      fileExists: absPath !== null && this.adapters.fileExists(absPath),
      dial: stepDial(this.progress, step.id, this.request?.dial),
      ...(this.shape?.stepId === step.id ? { shape: this.shape.shape } : {}),
      ...(check ? { check } : {}),
      ...(this.note?.stepId === step.id ? { writeNote: this.note.text } : {}),
      ...(reproducible > 0
        ? { reproduce: { count: reproducible, done: this.progress.reproduced !== undefined } }
        : {}),
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
 *  the identical rule `persist` already applies to a failed `saveProgress`. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : String(err);
}
