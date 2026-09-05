// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WalkStatusBar — "step 7 / 40 · scaffolded" in the status bar (AC6, plan step 4). The
 * smallest of the walk's four surfaces and, deliberately, the dumbest: it is handed a string
 * and shows it. That is the whole class.
 *
 * **It does not format anything.** The text comes from `statusText(plan, progress)`
 * (`./model.js`), which has no `vscode` import and is unit-tested under plain mocha —
 * including the two things that are easy to get subtly wrong and impossible to see from here:
 * that `N` is 1-indexed against the plan's own ordinal order, and that the dial falls back to
 * `manual` when a step has no per-step override recorded yet (never a number or a word
 * invented to fill the slot). Formatting the string in this file instead would put AC6's
 * actual assertion behind an extension host, for no gain.
 *
 * **The empty string HIDES the item; it does not show an empty one.** `WalkSession.refresh`
 * passes `''` when there is no current step at all — a plan whose chapters produced no steps,
 * a session that has been replaced. A blank pill in the status bar is a UI element claiming
 * to be reporting something while reporting nothing, and the learner cannot tell it apart
 * from a bug; no pill is the honest rendering of "no walk is open" (conventions.md: never a
 * silent no-op — and this is the case where showing nothing IS the honest signal, because the
 * walk's absence is the fact being reported).
 */

import * as vscode from 'vscode';

/**
 * Left, because this belongs with the other "where am I" indicators (branch, problems), not
 * with the right-hand per-file ones (line/column, language, encoding) — the walk's position
 * is a property of the workspace, not of whatever file happens to be focused. Higher priority
 * sorts further left within that group; 100 puts it near the front without displacing the
 * source-control block that everyone expects at the very left edge.
 */
const PRIORITY = 100;

export class WalkStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PRIORITY);
    // Names the entry in the status bar's own right-click "hide this" menu. Without it VS
    // Code labels the row with the current TEXT, so the learner's only way to turn the walk's
    // position off would be a menu row reading "step 7 / 40 · scaffolded".
    this.item.name = 'Build Tutorials';
    this.item.tooltip = 'Build Tutorials — where you are in this walk';
    // A status bar entry that reports a position but cannot take you to it is a missed
    // affordance. `buildTutorials.openWalk` is one of the four commands step 6 contributes
    // (handoff T-4 item 8); until that lands this click has nothing to run, which is the one
    // ordering dependency this file has on the wiring step.
    this.item.command = 'buildTutorials.openWalk';
  }

  /** Sets the text and shows the item; `''` clears and hides it. */
  setText(text: string): void {
    this.item.text = text;
    if (text) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
