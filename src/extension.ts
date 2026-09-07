// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The extension's entry point (spec §3, §5; T-1). T-3 replaces the honest placeholder
 * `buildTutorials.start` had with the real start screen, and adds the one thing that has to
 * run without anyone asking for it: on activation, if a build was interrupted (a window
 * reload, a crash), offer to resume it (spec §5.2).
 *
 * Every VS Code-specific effect `src/start/build.ts` needs (the progress notification, the
 * cancellation token, the Resume/Discard prompt, `globalStorageUri`, `workspaceState`) is
 * wired here — that file itself has no `vscode` import, by design (see its header).
 */

import fs from 'node:fs';
import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from './core.js';
import { runDoctor, formatReport } from './doctor.js';
import { StartPanel, type StartPanelDeps } from './start/panel.js';
import {
  buildFromRequest, completionMessage, coreFor, readFreshMarker, readMarker, realGit, resumeIfMarked,
  type BuildContext, type BuildOutcome, type ResumeContext,
} from './start/build.js';
import type { BuildRequest } from './start/request.js';
import { NarratorPanel, detourAdaptersFor } from './detour/panel.js';
import { readSkin } from './skins.js';
import { StepDecorator } from './walk/editor.js';
import { resolveInsideTarget } from './walk/paths.js';
import { WalkSession, type WalkAdapters } from './walk/session.js';
import { StepViewProvider } from './walk/step-panel.js';
import { WalkStatusBar } from './walk/status.js';
import { hasPlan, loadPlan, loadProgress, loadRequest, saveProgress } from './walk/store.js';
import { dialCoreFor, type DialCore } from './dial/core.js';
import { tutorCoreFor, type TutorCore } from './tutor/core.js';
import { DecisionsTreeProvider } from './walk/tree.js';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel('Build Tutorials');
  return outputChannel;
}

/** Where the setting currently points, resolved against this extension's own install directory. */
function configuredRepoTourRoot(context: vscode.ExtensionContext): string {
  const setting = vscode.workspace.getConfiguration('buildTutorials').get<string>('repoTourPath', '../repo-tour');
  return resolveCoreRoot(setting, context.extensionUri.fsPath);
}

async function runDoctorCommand(context: vscode.ExtensionContext): Promise<void> {
  const channel = getOutputChannel();
  channel.clear();
  channel.show(true);
  channel.appendLine('running the doctor…');
  channel.appendLine('');

  const root = configuredRepoTourRoot(context);
  const report = await runDoctor(root);
  for (const line of formatReport(report)) channel.appendLine(line);
}

/**
 * Remembers, per window, which target the last build/resume was for (spec §5.2, plan step 6e).
 *
 * A POINTER AT A POSSIBLE MARKER, nothing more — deliberately not a record that a build ever
 * happened here. The durable state is on disk: `<target>/.repo-tour/build/plan.json` is what
 * T-4's walk looks for, never this key. So the moment there is no marker left at the target
 * (the build finished, was refused, was cancelled, was discarded, or simply went stale), the
 * key has no job and is cleared — otherwise every future activation of this window would pay
 * to re-answer a question that can only ever come back "nothing to do" (T-3 rework, review
 * finding 1).
 */
const CURRENT_BUILD_KEY = 'buildTutorials.currentBuild';

/** Clears the bookmark unless a marker is still sitting at `target` waiting to be resumed. */
async function forgetUnlessResumable(context: vscode.ExtensionContext, target: string): Promise<void> {
  if (readMarker(target) === null) await context.workspaceState.update(CURRENT_BUILD_KEY, undefined);
}

/** `buildTutorials.llmModel`'s default is `""`: resolved here from repo-tour's own DEFAULT_MODEL
 *  export rather than a copy hardcoded in package.json that could drift out of sync. */
function resolveLlmSettings(core: CoreLoadResult): { provider: string; model: string } {
  const config = vscode.workspace.getConfiguration('buildTutorials');
  const provider = config.get<string>('llmProvider', 'claude');
  const configuredModel = config.get<string>('llmModel', '');
  const interpretMod = core.loaded['interpret'] as { DEFAULT_MODEL: string };
  return { provider, model: configuredModel || interpretMod.DEFAULT_MODEL };
}

function buildContextFor(
  context: vscode.ExtensionContext,
  core: CoreLoadResult,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): BuildContext {
  const { provider, model } = resolveLlmSettings(core);
  return {
    core: coreFor(core.loaded),
    globalStorageRoot: context.globalStorageUri.fsPath,
    provider,
    model,
    cachedOnly: false,
    git: realGit,
    onProgress: (msg) => progress.report({ message: msg }),
    isCancelled: () => token.isCancellationRequested,
  };
}

/**
 * A notification either way (so anyone not currently looking at the start screen — or, for
 * a resume, anyone who does not even have it open — still finds out); a REFUSAL or error
 * additionally goes `panel.reportProblem` when a panel is given, since AC3 asks for the
 * reason "shown in the form", not only a transient toast. Every non-ok, non-cancelled reason
 * is attributed to the `repo` field: v1's actual failure modes here (a language refusal, a
 * clone failure) are always about the repo; a rarer internal error (e.g. a full disk during
 * the final write) reusing that same field is an acceptable simplification for v1 over
 * threading field-attribution through every stage of `build.ts`.
 */
async function reportOutcome(outcome: BuildOutcome | undefined, panel?: StartPanel): Promise<void> {
  if (!outcome) return;
  if (outcome.ok) {
    await vscode.window.showInformationMessage(`Build Tutorials: ${completionMessage(outcome.plan!, outcome.cost!)}`);
  } else if (!outcome.cancelled) {
    panel?.reportProblem({ repo: outcome.reason ?? 'the build failed' });
    await vscode.window.showErrorMessage(`Build Tutorials: ${outcome.reason ?? 'the build failed'}`);
  } else {
    await vscode.window.showInformationMessage(`Build Tutorials: ${outcome.reason ?? 'build cancelled'}`);
  }
}

async function runBuild(context: vscode.ExtensionContext, core: CoreLoadResult, request: BuildRequest, panel: StartPanel): Promise<void> {
  await context.workspaceState.update(CURRENT_BUILD_KEY, request.target);
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Build Tutorials', cancellable: true },
    async (progress, token) => {
      const built = await buildFromRequest(request, buildContextFor(context, core, progress, token));
      await reportOutcome(built, panel);
      return built;
    },
  );
  await forgetUnlessResumable(context, request.target);
  if (outcome?.ok) await openOrOfferWalk(context, request.target);
}

async function runStartCommand(context: vscode.ExtensionContext): Promise<void> {
  const root = configuredRepoTourRoot(context);
  const core = await loadCore(root);
  if (!core.found) {
    await vscode.window.showErrorMessage(
      `Build Tutorials: repo-tour was not found (${core.reason}). Run "Build Tutorials: Doctor" for details.`,
    );
    return;
  }
  const skins = core.loaded['skins'] as StartPanelDeps['skins'];
  // `panel` is read inside `onSubmit`, never at the time this object literal is built — by
  // the time a real form:submit can fire, `show()` below has long since returned it.
  const panel: StartPanel = StartPanel.show(context, {
    skins,
    onSubmit: (request) => { void runBuild(context, core, request, panel); },
    // A message from the webview that does not match any known shape is ignored, not acted
    // on and never thrown (T-3 rework, review finding 3) — this is where it gets said out
    // loud, so a page that has quietly stopped working is explainable rather than a mystery.
    log: (line) => { getOutputChannel().appendLine(`start screen: ${line}`); },
  });
}

/**
 * The three things `resumeOnActivate` reaches outside itself for. Injected the way
 * `src/start/build.ts` injects `git`, and for the same reason: this runs on EVERY window
 * activation, so "it does nothing, cheaply, when there is nothing to resume" is a property
 * a test has to be able to prove, and neither `loadCore` nor a notification is observable
 * from outside otherwise (T-3 rework, review finding 1).
 */
export interface ResumeDeps {
  // Declared as function-valued PROPERTIES, not method shorthand: `confirm` below is handed
  // straight to `resumeIfMarked` unbound, which the `@typescript-eslint/unbound-method` rule
  // rightly refuses for a method.
  loadCore: (root: string) => Promise<CoreLoadResult>;
  withProgress: <T>(
    task: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<T>,
  ) => Promise<T>;
  /** The Resume/Discard prompt. `undefined` = dismissed, which leaves the marker for next time. */
  confirm: (message: string) => Promise<'Resume' | 'Discard' | undefined>;
}

const REAL_RESUME_DEPS: ResumeDeps = {
  loadCore: (root) => loadCore(root),
  withProgress: (task) => Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Build Tutorials', cancellable: true },
    (progress, token) => task(progress, token),
  )),
  confirm: (message) => Promise.resolve(vscode.window.showInformationMessage(message, 'Resume', 'Discard')),
};

/**
 * On activation: if the last build this window remembers has a FRESH write-ahead marker on
 * disk (a reload or a crash interrupted it within the last 6 hours), offer to resume — never
 * silently, and never without asking (spec §5.2).
 *
 * The order here is the whole point. `readFreshMarker` is a single `fs.readFileSync` and a
 * clock comparison; loading repo-tour's core and opening a progress notification are not. So
 * the cheap question is asked FIRST, and nothing is paid for until its answer is yes — no
 * marker (or one older than 6 hours) means this bookmark can never do anything again, so it
 * is cleared and we return, before any core load and before any UI. Before the rework this
 * function committed to both up front and only discovered there was nothing to do inside
 * `resumeIfMarked`, which meant every activation of any workspace that had ever run a build
 * reloaded the whole core and flashed an empty notification, forever (review finding 1).
 *
 * A missing core with a fresh marker is the one case the bookmark survives: the marker is
 * still resumable, it is the core that is missing, and `buildTutorials.doctor` is where that
 * gets explained.
 *
 * Exported for `test/extension.test.ts`, which drives it with fake `deps` — VS Code's
 * `Extension.activate()` is idempotent within one process, so a second real activation is
 * not something a test can stage.
 */
export async function resumeOnActivate(
  context: vscode.ExtensionContext,
  deps: ResumeDeps = REAL_RESUME_DEPS,
): Promise<void> {
  const target = context.workspaceState.get<string>(CURRENT_BUILD_KEY);
  if (!target) return;

  if (!readFreshMarker(target)) {
    await context.workspaceState.update(CURRENT_BUILD_KEY, undefined);
    return;
  }

  const core = await deps.loadCore(configuredRepoTourRoot(context));
  if (!core.found) return; // the marker is still good; the core is what is missing

  const outcome = await deps.withProgress(async (progress, token) => {
    const resumeCtx: ResumeContext = {
      ...buildContextFor(context, core, progress, token),
      confirm: deps.confirm,
    };
    return resumeIfMarked(target, resumeCtx);
  });
  await reportOutcome(outcome);
  if (outcome?.ok) await openOrOfferWalk(context, target);
  // Resumed to completion, or Discarded (`resumeIfMarked` removes the marker either way):
  // nothing is left to resume, so the bookmark goes too. A dismissed prompt or a failed
  // resume leaves the marker — and so keeps the bookmark — for next time.
  await forgetUnlessResumable(context, target);
}

// ── the walk (T-4) ────────────────────────────────────────────────────────────────────────

/**
 * The walk's surfaces are created ONCE per window and outlive any individual `WalkSession`,
 * because that is what "a second open on a different target replaces the first" needs: the
 * same tree, the same panel and the same status bar get handed a new session's view rather
 * than being torn down and rebuilt. The session itself is the replaceable part.
 *
 * `walkSkins` is module state for an awkward but unavoidable reason: `activate()` is
 * synchronous, a `WebviewViewProvider` has to be REGISTERED inside it, and repo-tour's skins
 * arrive from an `await`. So the panel is handed a getter (`() => walkSkins`) instead of a
 * value, and renders an honest notice until — or unless — the core actually loads.
 */
let walkTree: DecisionsTreeProvider | undefined;
let walkPanel: StepViewProvider | undefined;
let walkDecorator: StepDecorator | undefined;
/** T-7: the detour's narrator webview. A window-wide singleton like the four surfaces above
 *  it, made once in `activate()` and handed to whichever session is running — the same
 *  reasoning `walkPanel` carries: a session is REPLACED whenever the learner opens a different
 *  target, and a panel pinned to the first one would outlive it. */
let walkNarrator: NarratorPanel | undefined;
let walkStatus: WalkStatusBar | undefined;
let walkSession: WalkSession | undefined;
let walkSkins: StartPanelDeps['skins'] | undefined;

/**
 * Two questions, both of which have to answer yes before the walk will open a path.
 *
 * **Is it a FILE?** `fs.statSync(...).isFile()`, NOT `fs.existsSync` — the distinction is
 * load-bearing, not pedantry. A `shape` step's `target.file` is a DIRECTORY (`public`,
 * `tools`) or the synthetic `@misc` sentinel, and `existsSync` answers `true` for a directory,
 * which would enable the panel's *Open the file* button on something `openTextDocument` then
 * rejects. In the one large real plan we have that is 5 steps out of 61 — not an edge case.
 * See `kb/wiki/repo-tour-plan-shapes.md`.
 *
 * **Is it really INSIDE the target?** `src/walk/paths.ts`'s `resolveInsideTarget` already
 * refuses a `target.file` that spells its way out (`../../..`), and `src/walk/session.ts`
 * calls it before this adapter is ever consulted — but that check is pure `path` arithmetic,
 * by design: `session.ts` cannot import `fs` without breaking the plain-mocha unit bundle, and
 * a symlink is invisible to string arithmetic anyway. `<target>/notes.md` symlinked to
 * `~/.ssh/id_rsa` passes containment on its name and is somebody's private key on the disk.
 * The `fs` half therefore lives here, where `fs` already does: `realpathSync` both sides —
 * the TARGET as well as the file, because a target reached through a symlinked parent
 * (`/tmp` on some systems, a bind mount, a home directory that is a link) would otherwise put
 * every legitimate file "outside" itself and disable the whole walk — and require the real
 * path to still be inside the real target (security review, finding 2).
 *
 * A `false` here is not an error and is never reported: it means exactly what it means
 * everywhere else in the walk, "there is nothing to open for this step", which every surface
 * already renders honestly. The learner did not write the plan and has nothing to fix in it.
 * It matters now rather than later because **T-5 writes the learner's files at these same
 * paths**, which turns this read gate into a write gate one ticket from here.
 */
function isOpenableFile(target: string, absPath: string): boolean {
  try {
    if (!fs.statSync(absPath).isFile()) return false;
    return resolveInsideTarget(fs.realpathSync(target), fs.realpathSync(absPath)) !== null;
  } catch {
    return false;
  }
}

/** Built per session so `target` is closed over: `WalkView` deliberately carries the plan and
 *  the step but not the folder they came from, which is the session's own business. */
function walkAdaptersFor(context: vscode.ExtensionContext, target: string): WalkAdapters {
  return {
    setTree: (view) => walkTree?.setView(view),
    setPanel: (view) => walkPanel?.setView(view),
    setStatus: (text) => walkStatus?.setText(text),
    revealEditor: (view) => { void walkDecorator?.revealStep(target, view.step); },
    clearEditor: () => walkDecorator?.clear(),
    // The one place focus is taken: the learner pressed *Open the file* and asked to go there.
    openFile: (view) => { void walkDecorator?.revealStep(target, view.step, { preserveFocus: false }); },
    // Closed over `target`, which is the only reason this adapter can answer the containment
    // half at all — `WalkAdapters.fileExists` is handed an absolute path and nothing else.
    fileExists: (absPath) => isOpenableFile(target, absPath),
    loadPlan,
    loadProgress,
    loadRequest,
    saveProgress,

    // ── T-5: what the dial needs from the outside world ──────────────────────────────────
    core: () => ensureDialCore(context),
    // A plain read. Note what is NOT here: there is no `writeText` adapter, on purpose. The
    // session calls `src/dial/writer.ts`'s own atomic write directly, so the random temp
    // suffix and the refusal to follow a symlink at the destination have exactly ONE
    // implementation and cannot be quietly lost to a simpler-looking wiring here.
    readText: (absPath) => {
      try {
        return fs.readFileSync(absPath, 'utf8');
      } catch {
        return undefined;
      }
    },
    /**
     * Overwrite / Keep mine. A modal question, because the alternative is destroying work the
     * learner did by hand — and it is asked only when the file on disk genuinely DIFFERS from
     * what the dial would write (identical content is not a conflict), and only once per
     * step per session. A dismissed dialog is `false`: silence means keep what they have.
     */
    confirmOverwrite: async (relPath) => {
      const choice = await vscode.window.showWarningMessage(
        `${relPath} already has your own changes. Overwrite it with this step's version?`,
        { modal: true },
        'Overwrite',
        'Keep mine',
      );
      return choice === 'Overwrite';
    },
    git: realGit,

    // ── T-6: the tutor ───────────────────────────────────────────────────────────────────
    tutorCore: () => tutorCoreNow(context),
    tutorSettings: tutorSettingsNow,

    // ── T-7: the detour ──────────────────────────────────────────────────────────────────
    //
    // `globalStorageUri.fsPath` is AC2 in one line: the example's files land in the
    // extension's own storage and never in `target`, so the learner's explorer, their `git
    // status` and eventually their commit are untouched by construction rather than by a rule
    // somebody has to remember. The session cannot derive this folder — it is the EXTENSION's
    // to know — which is why it arrives as an adapter rather than being composed downstream.
    //
    // Absent when the narrator was never made (nothing but a defensive branch: `registerWalk`
    // makes it before any session exists), and an absent adapter set is answered honestly by
    // the panel rather than by a button that does nothing.
    ...(walkNarrator
      ? {
          detour: detourAdaptersFor({
            globalStorageRoot: context.globalStorageUri.fsPath,
            narrator: walkNarrator,
            // Read at the moment of the render rather than captured, so a learner who changes
            // skin mid-detour is obeyed on the next stop — `commitPerStep`'s rule.
            skin: () => readSkin(context.globalState, walkSkins?.DEFAULT_SKIN ?? 'system'),
            // The WALK's decorator, so a detour stop and a step share one decoration type and
            // one `clear()` that really clears — see `StepDecorator.revealRangeAt`.
            revealRange: async (absPath, startLine, endLine) => {
              await walkDecorator?.revealRangeAt(absPath, startLine, endLine);
            },
          }),
        }
      : {}),

    commitPerStep: () => vscode.workspace.getConfiguration('buildTutorials').get<boolean>('commitPerStep', true),
    // The walk's channel for a failure the LEARNER has to know about — today, a
    // `progress.json` that cannot be written (a read-only checkout, a full disk), which costs
    // them their place in the tutorial next time they open the folder without costing them
    // anything now (T-4 code review, finding 4; the wording is composed in `session.ts`,
    // which is the only thing that knows what actually failed). Surfaced the same two ways
    // `reportOutcome` surfaces a failed build: the output channel for whoever diagnoses it,
    // and a notification for whoever is looking at the editor rather than at a log. The
    // session reports each standing condition once per session, so this cannot become a
    // notification per click.
    reportError: (message) => { reportWalkFailure(message); },
  };
}

/**
 * The walk's one failure channel, and the answer to "the walk silently never opens" (T-4 code
 * review finding 2 / security review finding 5).
 *
 * All three ways a walk opens — activation, `buildTutorials.openWalk`, and the moment a build
 * finishes — run the same synchronous `WalkSession.open`, and `loadPlan` THROWS on a
 * `plan.json` that is not a build plan. Every one of those call sites is an `async` function
 * whose promise is `void`ed, so the throw became an unhandled rejection: no notification, no
 * output-channel line, nothing in the UI at all, and a panel confidently reading "No tutorial
 * in this folder yet" over a folder that visibly has one. Three surfaces, because each covers
 * a person the others miss: the output channel for whoever is diagnosing it later, a
 * notification for whoever is looking at their code right now, and `StepViewProvider.setNotice`
 * for whoever opens the Build Tutorials container afterwards and finds it — the only one of
 * the three that is still there in five minutes' time.
 *
 * `panelNotice` is OPTIONAL because the other caller must not pass one. `WalkAdapters.
 * reportError` (a `progress.json` that will not save, code review finding 4) is a failure
 * ALONGSIDE a walk that is working perfectly well — the panel is showing a live step, and
 * replacing that step with a notice would take the tutorial away to complain about a file. A
 * notice belongs here only when there is genuinely nothing else for the panel to show.
 */
function reportWalkFailure(message: string, panelNotice?: string): void {
  getOutputChannel().appendLine(`walk: ${message}`);
  if (panelNotice !== undefined) walkPanel?.setNotice(panelNotice);
  void vscode.window.showErrorMessage(`Build Tutorials: ${message}`);
}

/** The spec's rule, verbatim: the walk opens for any workspace folder that contains
 *  `.repo-tour/build/plan.json`. `hasPlan` is a single `existsSync`, so asking on every
 *  activation costs nothing. */
function folderWithPlan(): string | undefined {
  return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).find(hasPlan);
}

/**
 * Always replaces: after a REBUILD the plan on disk is a different plan, so re-reading it is
 * the point, not waste.
 *
 * The `try` is here rather than at each of the three call sites deliberately — it is the one
 * funnel every way of opening a walk already goes through, so a FOURTH entry point added later
 * inherits the handling instead of quietly reintroducing the silent failure. `loadPlan` is the
 * throw it is written for (a malformed `plan.json`), but everything `WalkSession.open` does
 * synchronously is inside it, because "the walk did not open and nobody was told" is the
 * failure being closed, not "this one function threw".
 *
 * `walkSession` is cleared BEFORE the attempt, not merely reassigned after it. The old code
 * left the disposed session in the variable when `open` threw, so `deps.session()` went on
 * handing the step panel a session whose every method is a no-op — a walk that answers clicks
 * with silence, which is precisely the symptom this whole fix exists to remove.
 */
function openWalkAt(context: vscode.ExtensionContext, target: string): void {
  walkSession?.dispose();
  walkSession = undefined;
  try {
    walkSession = WalkSession.open(target, walkAdaptersFor(context, target));
    walkPanel?.setNotice(undefined);
  } catch (error) {
    const reason = error instanceof Error && error.message.length > 0 ? error.message : String(error);
    reportWalkFailure(
      `the tutorial in ${target} could not be opened: ${reason}`,
      `This folder's tutorial could not be opened. ${reason}`,
    );
  }
}

/** Loaded once, lazily, and never retried in a loop: a missing core is a standing condition
 *  the doctor explains, not something to re-ask on every keystroke. */
async function ensureWalkSkins(context: vscode.ExtensionContext): Promise<void> {
  if (walkSkins) return;
  const core = await loadCore(configuredRepoTourRoot(context));
  if (core.found) walkSkins = core.loaded['skins'] as StartPanelDeps['skins'];
}

/**
 * The dial's slice of repo-tour, loaded once and memoised — a PROMISE, deliberately, and not
 * the synchronous getter `skins` uses.
 *
 * `activate()` is synchronous and opens the walk before `loadCore` has resolved. A getter
 * would therefore answer `undefined` for exactly the moment a RESUMED walk applies its first
 * dial: reopen a folder mid-tutorial in automated mode and the current step's file would
 * silently not be written, which is the worst shape a bug can take here — nothing fails, the
 * learner simply finds a file missing and no reason for it. Awaiting a settled promise costs
 * nothing after the first call.
 */
let walkDialCore: Promise<DialCore | undefined> | undefined;

function ensureDialCore(context: vscode.ExtensionContext): Promise<DialCore | undefined> {
  walkDialCore ??= loadCore(configuredRepoTourRoot(context)).then((core) =>
    core.found ? dialCoreFor(core.loaded) : undefined,
  );
  return walkDialCore;
}

/**
 * The tutor's slice of repo-tour, loaded once and memoised — a promise for the same reason
 * `ensureDialCore` is one: `activate()` is synchronous and the walk opens before `loadCore`
 * resolves.
 *
 * Separate from the dial's core rather than merged into it because the two answer to different
 * questions. The dial's is reached on every navigation and must not be optional in practice;
 * the tutor's is reached only when someone asks, and a missing one is a sentence in the panel
 * rather than a broken walk.
 */
let walkTutorCore: Promise<TutorCore | undefined> | undefined;

function ensureTutorCore(context: vscode.ExtensionContext): Promise<TutorCore | undefined> {
  walkTutorCore ??= loadCore(configuredRepoTourRoot(context)).then((core) =>
    core.found ? tutorCoreFor(core.loaded) : undefined,
  );
  return walkTutorCore;
}

/**
 * vscode-test only, and the narrowest seam that makes the tutor testable at all — installed
 * by `ExtensionApi._walk.useTutorCore`, `undefined` the rest of the time.
 *
 * `WalkAdapters.tutorCore` is the session's only route to a model, and in a real window it is
 * repo-tour's own `runLlm`, which shells out to a provider the learner is paying for. A
 * vscode-test therefore cannot drive an ask at all without a way to put a stand-in in front of
 * it: there is no supported way to reach the REGISTERED session's adapters from outside
 * `activate()` (the same argument `_walk` itself is built on), and a test that constructed its
 * own session with its own adapters would prove something about a copy — which for this one
 * capability is not a stylistic preference. The registered session is the only object whose
 * ask really is wired to the real provider, so it is the only one whose ask being wired to a
 * FAKE proves the wiring exists.
 *
 * A whole `TutorCore` rather than only its `runLlm` on purpose. `TutorDeps.run` is the seam
 * `src/tutor/ask.ts` offers a unit test, but `WalkSession.tutorDepsNow` deliberately does not
 * fill it — the session takes its runner from the core it was handed, which is the shape that
 * ships — so overriding the core is the only injection point that does not require adding a
 * production field nothing in production would ever set. It also lets a test do what
 * `test/unit/tutor-ask.test.ts` already does: keep every pure member of the REAL core (so an
 * ask goes through repo-tour's genuine `buildAskPrompt`), delegate `availability` to the real
 * provider probe where a test wants the provider's own words, and poison `runLlm` so a test
 * that forgot to answer for itself fails loudly instead of quietly spending money.
 *
 * Not consulted by anything but `walkAdaptersFor`, and not cleared by `deactivate`: whoever
 * installs one restores it in their own `teardown`, exactly as they restore an env var.
 */
let tutorCoreStandIn: TutorCore | undefined;

/** The core the SESSION asks with: the stand-in if a test installed one, else the real one. */
function tutorCoreNow(context: vscode.ExtensionContext): Promise<TutorCore | undefined> {
  return tutorCoreStandIn ? Promise.resolve(tutorCoreStandIn) : ensureTutorCore(context);
}

/**
 * The tutor's provider, model and deadline.
 *
 * `tutorModel` is deliberately NOT `llmModel`. repo-tour keeps the two apart and its reasoning
 * transfers exactly: the build model is picked for what interpreting a whole repository costs,
 * once, in the background, while an ask is one question from one learner at the moment they
 * are already stuck. Empty means unset, which `resolveTutorChoice` reads as the provider's
 * STRONGEST model — the right way round for the only place in this extension where a wrong
 * answer is read by a person who is already confused.
 */
function tutorSettingsNow(): { provider: string; model: string; timeoutMs: number } {
  const config = vscode.workspace.getConfiguration('buildTutorials');
  return {
    provider: config.get<string>('llmProvider', 'claude'),
    model: config.get<string>('tutorModel', ''),
    timeoutMs: Math.max(5, config.get<number>('tutorTimeoutSeconds', 120)) * 1000,
  };
}

function registerWalk(context: vscode.ExtensionContext): void {
  walkTree = new DecisionsTreeProvider();
  walkDecorator = new StepDecorator();
  // Routed through `walkSession` by getter for the reason `StepPanelDeps.session` is a
  // function: the narrator outlives any one session, and a captured one would keep driving a
  // walk that has been replaced. An optional call, so a press that lands between two sessions
  // is a no-op rather than a crash.
  walkNarrator = new NarratorPanel(
    {
      prev: () => { walkSession?.detourPrev(); },
      next: () => { walkSession?.detourNext(); },
      back: () => { walkSession?.returnFromDetour(); },
    },
    () => walkSkins,
  );
  walkStatus = new WalkStatusBar();
  walkPanel = new StepViewProvider(context, {
    skins: () => walkSkins,
    session: () => walkSession,
    log: (line) => { getOutputChannel().appendLine(`step panel: ${line}`); },
  });

  context.subscriptions.push(
    walkTree,
    walkDecorator,
    walkNarrator,
    walkStatus,
    // The provider itself, ONE entry for the window's whole life. It owns the listeners it
    // hooks in `resolveWebviewView` and replaces them on each re-resolve, rather than
    // appending three more of them here every time the view is dragged to another container
    // (T-4 code review, finding 9).
    walkPanel,
    vscode.window.registerTreeDataProvider('buildTutorials.decisions', walkTree),
    // No `webviewOptions.retainContextWhenHidden`: VS Code's default is `false`, and false is
    // exactly what AC5 asks for — a hidden view is torn down and re-rendered FROM THE HOST
    // when it comes back, so the panel can never become a second source of truth.
    vscode.window.registerWebviewViewProvider(StepViewProvider.viewType, walkPanel),
  );
}

/** On activation: the cheap question first (is there a plan in any open folder at all?), and
 *  nothing is paid for until its answer is yes — the same discipline `resumeOnActivate`
 *  follows, and for the same reason. */
async function openWalkOnActivate(context: vscode.ExtensionContext): Promise<void> {
  const target = folderWithPlan();
  if (!target) return;
  await ensureWalkSkins(context);
  openWalkAt(context, target);
}

/**
 * After a build lands: walk it here if "here" is where it was built, otherwise offer to go
 * there. Deliberately NOT `workspaceState` juggling across windows (spec's refinement notes) —
 * the new window detects the plan on its own activation, by the same rule as every other
 * window.
 */
async function openOrOfferWalk(context: vscode.ExtensionContext, target: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  if (folders.includes(target)) {
    await ensureWalkSkins(context);
    openWalkAt(context, target);
    await vscode.commands.executeCommand('buildTutorials.step.focus');
    return;
  }
  const choice = await vscode.window.showInformationMessage('Plan built — open the folder to start?', 'Open the folder');
  if (choice === 'Open the folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
}

async function runOpenWalkCommand(context: vscode.ExtensionContext): Promise<void> {
  const target = folderWithPlan();
  if (!target) {
    await vscode.window.showInformationMessage(
      'Build Tutorials: no tutorial in this folder yet — run "Build Tutorials: Start" to build one.',
    );
    return;
  }
  await ensureWalkSkins(context);
  if (walkSession?.target !== target) openWalkAt(context, target);
  await vscode.commands.executeCommand('buildTutorials.step.focus');
}

/** Returned from `activate()` as this extension's public API — see @types/vscode's
 *  `Extension<T>.exports`. `_context` exists for vscode-test only: there is no other
 *  supported way for a test to reach the real `ExtensionContext` a command handler runs
 *  with, short of duplicating activation itself. */
export interface ExtensionApi {
  _context: vscode.ExtensionContext;
  /**
   * vscode-test only, and for the same reason `_context` is here: the walk's surfaces are
   * created inside `activate()` and held in module state, and there is no supported way for a
   * test to reach the REGISTERED tree and webview-view providers — the only ones VS Code will
   * actually resolve and re-render — short of duplicating activation itself, which would prove
   * something about a copy rather than about what ships.
   *
   * Getters, not values: every one of these is replaced over the window's life (the session on
   * every `openAt`, the rest never, but a value snapshot would quietly stop being true).
   * `openAt` exists because a test's fixture folder is not a workspace folder, so
   * `folderWithPlan()` cannot find it — it is the same path `runOpenWalkCommand` takes, minus
   * the folder lookup.
   */
  _walk: {
    session: () => WalkSession | undefined;
    tree: () => DecisionsTreeProvider | undefined;
    panel: () => StepViewProvider | undefined;
    decorator: () => StepDecorator | undefined;
    openAt: (target: string) => Promise<void>;
    /**
     * The REAL tutor core, exactly as this extension resolves it — never the stand-in below,
     * so a test can build a fake ON TOP of the genuine article rather than inventing a second
     * repo-tour to agree with itself about what a prompt looks like.
     */
    tutorCore: () => Promise<TutorCore | undefined>;
    /**
     * Put a stand-in in front of it for the registered session's next ask; `undefined`
     * restores the real one. See `tutorCoreStandIn` for why the seam is a whole core and why
     * it exists at all — in short, `runLlm` spends the learner's money, and a suite with no
     * way to intercept it either cannot test the tutor or has to pay to.
     */
    useTutorCore: (core: TutorCore | undefined) => void;
  };
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  registerWalk(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('buildTutorials.doctor', () => runDoctorCommand(context)),
    vscode.commands.registerCommand('buildTutorials.start', () => runStartCommand(context)),
    vscode.commands.registerCommand('buildTutorials.openWalk', () => runOpenWalkCommand(context)),
    vscode.commands.registerCommand('buildTutorials.nextStep', () => { walkSession?.next(); }),
    vscode.commands.registerCommand('buildTutorials.prevStep', () => { walkSession?.prev(); }),
    // The tree hands this the step's own id. `unknown`, and checked: the command is also
    // reachable by hand (it is hidden from the palette, not from `executeCommand`), and
    // `WalkSession.goTo` already ignores an id the plan does not contain.
    vscode.commands.registerCommand('buildTutorials.goToStep', (stepId: unknown) => {
      if (typeof stepId === 'string') walkSession?.goTo(stepId);
    }),
    // Deliberately NOT gated behind a `when` clause. The context key it would need does not
    // exist, and a `when` on an undefined key hides a command forever — so it is always
    // offered and says honestly that there is no walk, which is what `openWalk` already does.
    vscode.commands.registerCommand('buildTutorials.reproduceFiles', () => {
      if (!walkSession) {
        void vscode.window.showInformationMessage(
          'Build Tutorials: no tutorial is open in this folder — run "Build Tutorials: Start" to build one.',
        );
        return;
      }
      walkSession.reproduce();
    }),
  );
  void resumeOnActivate(context);
  void openWalkOnActivate(context);
  return {
    _context: context,
    _walk: {
      session: () => walkSession,
      tree: () => walkTree,
      panel: () => walkPanel,
      decorator: () => walkDecorator,
      openAt: async (target: string) => {
        await ensureWalkSkins(context);
        openWalkAt(context, target);
      },
      tutorCore: () => ensureTutorCore(context),
      useTutorCore: (core: TutorCore | undefined) => { tutorCoreStandIn = core; },
    },
  };
}

export function deactivate(): void {
  walkSession?.dispose();
  walkSession = undefined;
  walkSkins = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
