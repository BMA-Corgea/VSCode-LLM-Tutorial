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
  buildFromRequest, completionMessage, coreFor, realGit, resumeIfMarked,
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

/** Remembers, per window, which target the last build/resume was for (spec §5.2, plan step 6e). */
const CURRENT_BUILD_KEY = 'buildTutorials.currentBuild';

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

async function reportOutcome(outcome: BuildOutcome | undefined): Promise<void> {
  if (!outcome) return;
  if (outcome.ok) {
    await vscode.window.showInformationMessage(`Build Tutorials: ${completionMessage(outcome.plan!, outcome.cost!)}`);
  } else if (!outcome.cancelled) {
    await vscode.window.showErrorMessage(`Build Tutorials: ${outcome.reason ?? 'the build failed'}`);
  } else {
    await vscode.window.showInformationMessage(`Build Tutorials: ${outcome.reason ?? 'build cancelled'}`);
  }
}

async function runBuild(context: vscode.ExtensionContext, core: CoreLoadResult, request: BuildRequest): Promise<void> {
  await context.workspaceState.update(CURRENT_BUILD_KEY, request.target);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Build Tutorials', cancellable: true },
    async (progress, token) => {
      const outcome = await buildFromRequest(request, buildContextFor(context, core, progress, token));
      await reportOutcome(outcome);
    },
  );
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
  StartPanel.show(context, {
    skins,
    onSubmit: (request) => { void runBuild(context, core, request); },
  });
}

/**
 * On activation: if the last build this window remembers has a write-ahead marker on disk
 * (a reload or a crash interrupted it), offer to resume — never silently, and never without
 * asking (spec §5.2). No marker, no remembered target, or a missing core: quietly does
 * nothing, since `buildTutorials.doctor` is where a missing-core problem gets explained.
 */
async function resumeOnActivate(context: vscode.ExtensionContext): Promise<void> {
  const target = context.workspaceState.get<string>(CURRENT_BUILD_KEY);
  if (!target) return;

  const core = await loadCore(configuredRepoTourRoot(context));
  if (!core.found) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Build Tutorials', cancellable: true },
    async (progress, token) => {
      const resumeCtx: ResumeContext = {
        ...buildContextFor(context, core, progress, token),
        confirm: (message) => Promise.resolve(vscode.window.showInformationMessage(message, 'Resume', 'Discard')),
      };
      const outcome = await resumeIfMarked(target, resumeCtx);
      await reportOutcome(outcome);
    },
  );
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
