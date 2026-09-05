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

import * as vscode from 'vscode';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from './core.js';
import { runDoctor, formatReport } from './doctor.js';
import { StartPanel, type StartPanelDeps } from './start/panel.js';
import {
  buildFromRequest, completionMessage, coreFor, readFreshMarker, readMarker, realGit, resumeIfMarked,
  type BuildContext, type BuildOutcome, type ResumeContext,
} from './start/build.js';
import type { BuildRequest } from './start/request.js';

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
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Build Tutorials', cancellable: true },
    async (progress, token) => {
      const outcome = await buildFromRequest(request, buildContextFor(context, core, progress, token));
      await reportOutcome(outcome, panel);
    },
  );
  await forgetUnlessResumable(context, request.target);
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
  // Resumed to completion, or Discarded (`resumeIfMarked` removes the marker either way):
  // nothing is left to resume, so the bookmark goes too. A dismissed prompt or a failed
  // resume leaves the marker — and so keeps the bookmark — for next time.
  await forgetUnlessResumable(context, target);
}

/** Returned from `activate()` as this extension's public API — see @types/vscode's
 *  `Extension<T>.exports`. `_context` exists for vscode-test only: there is no other
 *  supported way for a test to reach the real `ExtensionContext` a command handler runs
 *  with, short of duplicating activation itself. */
export interface ExtensionApi {
  _context: vscode.ExtensionContext;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  context.subscriptions.push(
    vscode.commands.registerCommand('buildTutorials.doctor', () => runDoctorCommand(context)),
    vscode.commands.registerCommand('buildTutorials.start', () => runStartCommand(context)),
  );
  void resumeOnActivate(context);
  return { _context: context };
}

export function deactivate(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
