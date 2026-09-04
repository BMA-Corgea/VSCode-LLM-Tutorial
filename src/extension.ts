// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The extension's entry point (spec §3, §5; T-1). All it does at T-2 is prove the host can
 * run repo-tour's core and report on it — the start screen, the walk, the dial, the tutor and
 * the detour all arrive in later tickets (T-3 … T-7). Registering their commands honestly
 * rather than silently is the point: a control that does nothing and says nothing is a
 * broken control (repo-tour's own lesson, spec §5.2).
 */

import * as vscode from 'vscode';
import { resolveCoreRoot } from './core.js';
import { runDoctor, formatReport } from './doctor.js';

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

async function runStartCommand(): Promise<void> {
  // Honest, not silent (repo-tour's lesson, spec §5.2): the start screen is T-3's job.
  await vscode.window.showInformationMessage(
    'The start screen arrives with T-3 — run "Build Tutorials: Doctor" to check this machine.',
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('buildTutorials.doctor', () => runDoctorCommand(context)),
    vscode.commands.registerCommand('buildTutorials.start', () => runStartCommand()),
  );
}

export function deactivate(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
