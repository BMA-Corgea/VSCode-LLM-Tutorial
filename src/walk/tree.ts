// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DecisionsTreeProvider — the walk's chapters-and-steps tree, as a NATIVE VS Code TreeView
 * (AC1, plan step 4). One of the four surfaces `WalkSession` drives; like every other one it
 * holds no truth of its own — `setView` is handed a whole `WalkView` and re-renders from it,
 * and between two `setView` calls this provider's answer to "what is in the tree" cannot
 * change (spec §5.3; `src/start/panel.ts` established the same discipline for the start
 * screen's single surface).
 *
 * **Native, not a webview, and that is the interesting choice here.** The step panel beside
 * it is a webview because it renders repo-tour's own skinned markup; a tree is not — VS Code
 * already ships the affordances a tree needs (twisties that remember themselves, keyboard
 * navigation, the reveal API, theme-correct codicons) and a webview would have to
 * re-implement every one of them, worse. So this file's whole job is translation: from the
 * `TreeChapterNode[]` `treeModel` computes into the `vscode.TreeItem`s VS Code renders.
 *
 * **The tree's SHAPE is not decided here.** `treeModel(plan, progress)` (`./model.js`) already
 * groups steps under chapters, orders them by ordinal, drops a chapter that ended up with no
 * steps, and resolves each step to `done` / `current` / `pending` — and it is unit-tested
 * under plain mocha with no extension host, which is the entire reason it lives over there
 * (see `session.ts`'s header on the `vscode` line). Re-deriving any of that here would create
 * a second definition of the tree that no unit test can reach. This file therefore contains
 * no grouping, no sorting and no status arithmetic; if a status looks wrong, `model.ts` is
 * where it is wrong.
 *
 * Two details worth knowing before changing anything:
 *
 *   - **Every item carries a stable `id`** (`chapter:<key>` / `step:<id>`). Without one, VS
 *     Code identifies items by object identity, and `setView` builds fresh objects on every
 *     refresh — so clicking a step (which persists, refreshes, and re-fires this event) would
 *     collapse every chapter the learner had opened, on every click. With an id, expansion
 *     and selection survive the refresh. The two prefixes keep the ids unique across the
 *     whole tree, which VS Code requires: a chapter key and a step id are drawn from
 *     different namespaces and could otherwise collide.
 *   - **No view means an EMPTY tree, never a thrown error.** `getChildren` is called by VS
 *     Code on its own schedule — at view-registration time, long before any walk has opened,
 *     and again after `WalkSession.dispose()` hands us `undefined` — and a provider that
 *     throws there puts a red error blob in the sidebar for a state that is entirely normal
 *     ("no tutorial open in this window yet").
 */

import * as vscode from 'vscode';
import { treeModel, type TreeChapterNode, type TreeStepNode } from './model.js';
// `import type`, and it is load-bearing: it is erased at compile time, so this file's very
// real `vscode` import never becomes something `session.ts` (and therefore `test/unit/`)
// drags in behind it. See `session.ts`'s header on which side of that line each file sits.
import type { WalkView } from './session.js';

/**
 * A node in the rendered tree, discriminated because the two levels are genuinely different
 * things rather than one recursive shape: a chapter is a heading that holds steps, a step is
 * a leaf that is clickable. Exported because `src/extension.ts` types the `vscode.TreeView`
 * it creates against it (and `test/walk.test.ts` walks the provider directly).
 */
export type DecisionNode =
  | { kind: 'chapter'; chapter: TreeChapterNode }
  | { kind: 'step'; step: TreeStepNode };

/** AC1's three icons, as codicon ids — `$(check)` / `$(arrow-right)` / `$(circle-outline)`
 *  in the spec's own shorthand. A map rather than a switch so a fourth status (T-5's failed
 *  check is the obvious candidate) is one row here and a compile error at `TreeStepNode`. */
const STEP_ICON: Record<TreeStepNode['status'], string> = {
  done: 'check',
  current: 'arrow-right',
  pending: 'circle-outline',
};

/**
 * Chapters open COLLAPSED, except the one holding the current step. Opening a tutorial at
 * step 7 of 40 and being shown five shut chapters means hunting for where you are before you
 * can do anything; opening all of them means a forty-row wall. This is only ever the FIRST
 * state a chapter is rendered in — once an item with this `id` exists, VS Code preserves
 * whatever the learner did to it and ignores this value, so it never fights them afterwards.
 */
function chapterItem(chapter: TreeChapterNode): vscode.TreeItem {
  const open = chapter.steps.some((step) => step.status === 'current');
  const item = new vscode.TreeItem(
    chapter.title,
    open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `chapter:${chapter.key}`;
  item.description = chapter.subtitle;
  item.tooltip = `${chapter.title} — ${chapter.subtitle}`;
  // For a future `menus.view/item/context` (T-5's "mark this chapter done", T-10's alternatives):
  // a `when` clause can only tell the two levels apart if the items say which they are.
  item.contextValue = 'chapter';
  return item;
}

/**
 * A step leaf. `label` is the step's own question, because that IS what the learner is here
 * to see (`TreeStepNode.title`'s own doc comment) — the ordinal goes in `description`, where
 * it pairs with the status bar's "step N / M" without competing with the question for the
 * row's width.
 *
 * The `command` is AC1's second half: clicking a step makes it current. It is not a
 * navigation-only affordance — `buildTutorials.goToStep` runs through `WalkSession.goTo`, so
 * one click persists the position, re-renders the panel and the status bar, and reveals the
 * file. Nothing about that is this file's business, which is why it hands over an id and
 * nothing else.
 */
function stepItem(step: TreeStepNode): vscode.TreeItem {
  const item = new vscode.TreeItem(step.title, vscode.TreeItemCollapsibleState.None);
  item.id = `step:${step.id}`;
  item.description = String(step.ordinal);
  item.tooltip = `step ${step.ordinal} · ${step.kind} · ${step.status}\n${step.title}`;
  item.iconPath = new vscode.ThemeIcon(STEP_ICON[step.status]);
  item.contextValue = 'step';
  item.command = {
    command: 'buildTutorials.goToStep',
    title: 'Go to step',
    arguments: [step.id],
  };
  return item;
}

export class DecisionsTreeProvider implements vscode.TreeDataProvider<DecisionNode> {
  /** Declared before `onDidChangeTreeData` on purpose: field initialisers run in declaration
   *  order, and the event below reads this one. */
  private readonly changed = new vscode.EventEmitter<DecisionNode | undefined>();

  readonly onDidChangeTreeData: vscode.Event<DecisionNode | undefined> = this.changed.event;

  /** The whole rendered tree, recomputed once per `setView` rather than once per
   *  `getChildren` call — and, more to the point, computed from ONE snapshot, so the roots VS
   *  Code asks for and the children it asks for next can never come from two different
   *  `progress` values. Empty until a walk opens. */
  private chapters: TreeChapterNode[] = [];

  /**
   * Takes a whole `WalkView` (not a plan and a progress separately) for the reason
   * `WalkView` exists at all: a surface is handed one consistent snapshot, never a
   * half-updated pair. `undefined` means "there is no walk to show" — an empty tree, which is
   * a legitimate state and not an error.
   */
  setView(view: WalkView | undefined): void {
    this.chapters = view ? treeModel(view.plan, view.progress) : [];
    // `undefined` = "the whole tree changed". Firing per-node would be a lie here: a step
    // becoming current also changes the step that WAS current, and after a rebuild the node
    // set itself is different.
    this.changed.fire(undefined);
  }

  getTreeItem(element: DecisionNode): vscode.TreeItem {
    return element.kind === 'chapter' ? chapterItem(element.chapter) : stepItem(element.step);
  }

  getChildren(element?: DecisionNode): DecisionNode[] {
    if (!element) return this.chapters.map((chapter): DecisionNode => ({ kind: 'chapter', chapter }));
    if (element.kind === 'step') return [];
    return element.chapter.steps.map((step): DecisionNode => ({ kind: 'step', step }));
  }

  /** The emitter is the only thing this provider owns. The `vscode.TreeView` itself is
   *  created and disposed by `src/extension.ts` (`context.subscriptions`), which is also why
   *  this provider outlives any one `WalkSession` — see `WalkSession.dispose`. */
  dispose(): void {
    this.changed.dispose();
  }
}
