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
 * Three things about the shape below are worth reading before changing it:
 *
 *   - **`refresh` is the only way state leaves this object.** Every public method mutates
 *     `progress`, persists if it changed, and then calls `refresh` — there is no second path
 *     that pushes to one surface and not the others, so the tree, the panel and the status bar
 *     cannot drift apart. That is also why `WalkView` bundles `plan`, `progress`, `step` and
 *     `fileExists` into one value rather than four `set*` calls: a surface is handed one
 *     consistent snapshot, never a half-updated pair of them.
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
 *
 * **The reload drill (AC4) is the point of the whole design.** Nothing here is cached beyond
 * one instance's lifetime and nothing is memoised across instances: `open` reads the plan and
 * the progress back through the adapters every single time, so `dispose()` followed by a
 * fresh `open` on the same target lands on the same step for exactly one reason — the current
 * step is on disk in `<target>/.repo-tour/build/progress.json`, written by
 * `adapters.saveProgress` the moment it changed, and read back by `adapters.loadProgress`.
 * The session is a view onto that file, never its owner.
 */

import path from 'node:path';
import type { Dial } from '../start/request.js';
import {
  currentStep,
  nextStepId,
  prevStepId,
  setCurrent,
  statusText,
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
}

export class WalkSession {
  /** The last snapshot pushed to the surfaces; `undefined` when there is no current step. */
  private view: WalkView | undefined;
  /** See `dispose`: a torn-down session must not answer a stale click by driving surfaces
   *  that now belong to a different target's session. */
  private disposed = false;

  private constructor(
    public readonly target: string,
    private readonly adapters: WalkAdapters,
    private readonly plan: PlanLike,
    private progress: Progress,
  ) {}

  /**
   * Reads the plan and the progress back from disk THROUGH the adapters (never `fs` here —
   * that is what keeps the state machine testable with fakes and what makes the reload drill
   * a real round trip rather than a re-read of something already in memory), then pushes a
   * full refresh WITH an editor reveal: opening the walk should land the learner in the file
   * they left off in, not merely tell them which step it was.
   *
   * Nothing is written back. A first-ever walk's progress is `emptyProgress(plan)` — parked
   * on the first step — and staying in memory until the learner actually does something means
   * merely LOOKING at a tutorial never writes into their folder. The reload drill survives it
   * either way: `loadProgress` reconstructs the identical starting point on the next open.
   */
  static open(target: string, adapters: WalkAdapters): WalkSession {
    const plan = adapters.loadPlan(target);
    const session = new WalkSession(target, adapters, plan, adapters.loadProgress(target, plan));
    session.resolveCurrent();
    session.refresh(true);
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
    this.persist();
    this.refresh(true);
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
   * Records the learner's per-step dial override (spec §5.4; T-5 is what READS it and acts on
   * it — this ticket shows the control and remembers the answer, honestly). Refreshes without
   * a reveal: the status bar's "· <dial>" and the panel's radios both have to update, but the
   * editor is already showing the right file and re-centring it here would only jump the code
   * out from under the learner's eyes.
   */
  setDial(stepId: string, dial: Dial): void {
    if (this.disposed || !this.hasStep(stepId)) return;
    this.progress = setDialIn(this.progress, stepId, dial);
    this.persist();
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
    this.persist();
    this.refresh(false);
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
    this.adapters.clearEditor();
    this.adapters.setTree(undefined);
    this.adapters.setPanel(undefined);
    this.adapters.setStatus('');
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
    this.adapters.setStatus(view ? statusText(this.plan, this.progress) : '');
    if (!revealEditor) return;
    if (view?.fileExists) this.adapters.revealEditor(view);
    else this.adapters.clearEditor();
  }

  private buildView(): WalkView | undefined {
    const step = currentStep(this.plan, this.progress);
    if (!step) return undefined;
    return {
      plan: this.plan,
      progress: this.progress,
      step,
      fileExists: this.adapters.fileExists(path.join(this.target, step.target.file)),
    };
  }

  private hasStep(stepId: string): boolean {
    return this.plan.steps.some((s) => s.id === stepId);
  }

  private persist(): void {
    this.adapters.saveProgress(this.target, this.progress);
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
