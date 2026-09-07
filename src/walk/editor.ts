// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * StepDecorator — the walk driving the REAL editor (AC3, plan step 4, handoff T-4 item 5).
 * When a step becomes current, the file it is about opens beside the walk, scrolls to the
 * step's range, and has its load-bearing lines highlighted; when the step changes, that
 * highlight goes. This is the one surface that is not a panel: the learner's own editor,
 * which is where they are actually going to write the code.
 *
 * `preserveFocus: true` and `ViewColumn.One` together are the whole ergonomic argument. The
 * learner's hands are in the walk (the tree, the panel's Next button); moving the file under
 * their eyes should never move their cursor out of the surface they are driving, and every
 * step should reuse the SAME editor column rather than fanning forty files across the window.
 *
 * ## Two constraints this file is shaped around — read both before changing it
 *
 * **1. Decorations are write-only.** `vscode.TextEditor.setDecorations(type, ranges)` is the
 * entire API: there is no `getDecorations()` anywhere in the VS Code surface, and a
 * `TextEditorDecorationType` is an opaque handle that reports nothing about where it has been
 * painted. So plan step 7's own verification line — "decorations applied, count via the
 * session's test seam" — is not merely inconvenient to write without help, it is impossible.
 * `getLastRangeCountForTest()` is that help: a REQUIRED part of this class's contract, not an
 * optional nicety, and the only way `test/walk.test.ts` can assert AC3's second half at all.
 * It reports the number of ranges handed to the most recent `setDecorations` call, which is
 * `0` after `clear()` and `0` for a step that decorates nothing.
 *
 * **2. repo-tour's line numbers are 1-BASED and INCLUSIVE; `vscode.Position` is 0-BASED.**
 * Every number that crosses into this file is converted, exactly once, in `toZeroBased`. The
 * evidence, recorded here because the next ticket (T-5, which stubs files at these same
 * ranges) needs it and should not have to re-derive it:
 *
 *   - repo-tour `src/build/types.ts`, on `Range`: "A 1-indexed, inclusive line range — the
 *     unit `extract()` already reports symbols in."
 *   - repo-tour `schema/build-plan.schema.json`: `startLine` and `endLine` are
 *     `{ "type": "integer", "minimum": 1 }`, in both `definitions.range` and `step.target`.
 *     A 0-based scheme's first line would be `0`, which the schema forbids outright.
 *   - repo-tour's own consumers do the `- 1` themselves: `src/build/stub.ts` keeps a cursor
 *     commented "next not-yet-emitted 1-indexed line" and slices
 *     `lines.slice(range.startLine - 1, range.endLine)` — the textbook 1-based-inclusive to
 *     0-based-half-open conversion; `src/interpret.ts`'s `numberedSlice` prints `i` as the
 *     gutter number while reading `lines[i - 1]`, so `startLine` is literally the number a
 *     human sees beside the line.
 *   - The real plan at `sql-gauntlet/.repo-tour/build/plan.json`: across 35 `target.startLine`
 *     values and 122 scaffold ranges, the minimum is `1` and there is not a single `0`.
 *
 * An off-by-one here would silently scroll to and highlight the wrong line — nothing would
 * throw, and a test that only counts ranges would pass — which is why the conversion is one
 * named function with the reasoning attached rather than a `- 1` sprinkled at four call sites.
 *
 * ## What actually reaches `revealStep`
 *
 * `WalkSession.refresh` only calls in when `fileExists`, but `fileExists` is `fs.existsSync`,
 * which is true of a DIRECTORY — and in a real plan a `shape` step's `target.file` is exactly
 * that: `public`, `tools`, or the synthetic sentinel `@misc`, which is not a path at all.
 * `openTextDocument` rejects on all three. That rejection arrives inside a promise the
 * adapter boundary has already `void`-ed (`WalkAdapters.revealEditor` returns `void`), where
 * nobody is listening and it becomes an unhandled rejection that takes down nothing visible
 * and explains nothing. So the open is caught, and a step whose file cannot be opened simply
 * drops the previous step's highlight and leaves the editor alone — the panel is already
 * saying, honestly and where the eye is, what is going on with that file.
 *
 * The same catch covers the ordinary races (the file deleted between the check and the open)
 * and the plan being stale relative to the file it describes, which is also why every line
 * number is clamped to the document rather than trusted: repo-tour plans are regenerated, not
 * repaired, so a plan can legitimately outlive the file it was computed from.
 *
 * And `target.file` is not trusted to stay inside the target folder either: it is resolved
 * through `resolveInsideTarget` (`./paths.ts`), never `path.join`, because
 * `path.join('/home/you/repo', '../../../.ssh/id_rsa')` is a real path to somebody's private
 * key and this reveal happens automatically on activation. `WalkSession` performs the same
 * check before it ever calls in — a step that escapes reports `fileExists: false` and is never
 * revealed at all — and the check is repeated HERE anyway, deliberately: `openFile` reaches
 * this method by a second route, this class is public and takes a raw `target` and `StepLike`
 * from whoever calls it, and a containment check that exists in exactly one caller is one
 * refactor away from not existing. Security review finding 2.
 *
 * ## Concurrent reveals, and why there is a sequence number
 *
 * `revealStep` awaits twice and nothing serialises it, while `WalkSession.refresh` fires one
 * per navigation — so pressing Next twice quickly starts two. They do NOT finish in order:
 * step 4's file may already be open, so its `openTextDocument` resolves from VS Code's cache
 * in the same tick, while step 3's is cold disk I/O. Step 3 therefore lands LAST and wins
 * every assignment below it — `showTextDocument` pulls the older step's file to the front,
 * the `lastEditor !== editor` branch calls `clear()` over step 4's fresh highlight, step 3's
 * ranges get painted, and `getLastRangeCountForTest` ends up describing the stale call. The
 * tree, the panel and the status bar all say step 4; the editor shows step 3, scrolled to
 * step 3's line, highlighted. The failed-open path is worse still: a stale reveal's
 * `catch { this.clear() }` erases a NEWER step's decorations for a file that has nothing to
 * do with it.
 *
 * `revealSeq` is the fix (code review finding 3). Each call claims a number before it can
 * await, and re-checks after every await: if a newer call has started, this one is a reveal
 * the learner has already navigated past, and the correct thing for it to do is nothing at
 * all. A counter rather than a queue or a lock because a superseded reveal has no value —
 * making the learner wait for step 3 to finish opening before step 4 may start would be
 * slower AND still show them a file they have moved on from.
 */

import * as vscode from 'vscode';
import type { RangeLike, StepLike } from './model.js';
import { resolveInsideTarget } from './paths.js';

/**
 * Which step kinds get their load-bearing lines highlighted (plan step 4: "decorate every
 * `scaffold.loadBearing` range for `symbol`/`file` steps"). A `shape` step is a chapter's
 * opening argument about a whole subsystem — its target is a directory and its `loadBearing`
 * is empty in every real plan — so it reveals, if it can, and decorates nothing. Kept as a
 * set rather than an inline `||` so the rule reads as a rule.
 */
const DECORATED_KINDS: ReadonlySet<StepLike['kind']> = new Set<StepLike['kind']>(['symbol', 'file']);

/**
 * 1-based inclusive (repo-tour) to 0-based (`vscode.Position`), clamped into the document.
 *
 * The clamp is not paranoia about repo-tour: it is about the file, which the learner is
 * actively editing and which may well be shorter than it was when the plan was computed. A
 * `vscode.Position` with a negative line THROWS ("Illegal value for line"), and one past the
 * end quietly addresses nothing. `lineCount` is at least 1 even for an empty document, so the
 * result is always a line that exists.
 *
 * The `line: unknown` and the integer gate are code review finding 8, and the parameter type
 * is deliberately wider than `RangeLike` claims because `RangeLike` is a CAST, not a
 * validation: `plan.json` is `JSON.parse`d and asserted into shape, so `startLine` can hold
 * anything JSON can hold, and the old signature's `number` was a promise nobody had checked.
 * `Math.max('12abc', 1)` is `NaN`; `NaN < 0` is false, so `vscode.Position`'s own guard waves
 * it straight through; and `doc.lineAt(NaN)` then throws from inside a promise this class's
 * caller has already `void`-ed — a step that silently never reveals, with nothing logged and
 * nothing on screen to explain it. A fraction and `Infinity` are no better as line numbers
 * (one addresses a position between two lines, the other clamps to the last line as though it
 * had been asked for), so `Number.isInteger` rejects all three with one check.
 *
 * The fallback is line 1, which is `0` after the conversion — the same answer `revealLine`
 * already gives for a step that names no line at all. The top of the file is the honest
 * "somewhere in here"; guessing a number would be worse than admitting we have none.
 */
function toZeroBased(line: unknown, lineCount: number): number {
  if (typeof line !== 'number' || !Number.isInteger(line)) return 0;
  return Math.min(Math.max(line, 1), lineCount) - 1;
}

/**
 * One `scaffold` range as a real editor range. The decoration type sets `isWholeLine`, so the
 * character offsets are not what paints the highlight — but a range that actually spans its
 * own text is the honest one, and it keeps working if `isWholeLine` is ever dropped.
 * `endLine` is floored at `start` so an inverted range (a hand-built fixture; a badly stale
 * plan) degrades to a single line instead of throwing.
 */
function toRange(range: RangeLike, doc: vscode.TextDocument): vscode.Range {
  const start = toZeroBased(range.startLine, doc.lineCount);
  const end = Math.max(start, toZeroBased(range.endLine, doc.lineCount));
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}

/**
 * The line to scroll to. `target.startLine` is only present on `symbol` steps — in the real
 * plan all 21 `file` steps and all 5 `shape` steps leave it undefined — so a `file` step falls
 * back to its first load-bearing range, which is the first thing it is going to ask the
 * learner to write. repo-tour guarantees those ranges are "always non-overlapping and sorted"
 * (`src/build/types.ts` on `Step.scaffold`), so `[0]` really is the earliest. Failing both,
 * the top of the file: the honest answer to "somewhere in here", never an invented number.
 */
function revealLine(step: StepLike): number {
  return step.target.startLine ?? step.scaffold.loadBearing[0]?.startLine ?? 1;
}

export class StepDecorator {
  /**
   * ONE decoration type, created once and reused for the life of this object. Creating one
   * per reveal would leak a renderer-side handle per step and, worse, make "clear the last
   * step's highlight" require remembering every type ever made — the whole reason a single
   * long-lived handle is the idiom.
   */
  private readonly decoration: vscode.TextEditorDecorationType;

  /**
   * The editor the current ranges were actually painted on — NOT `window.activeTextEditor`,
   * which is a different question with a different answer by the time `clear()` runs (the
   * learner opened a scratch file; a Peek view took focus; the walk was disposed while the
   * editor group was elsewhere). Un-decorating the wrong editor is a no-op that leaves the
   * real highlight sitting there permanently.
   */
  private lastEditor: vscode.TextEditor | undefined;

  private lastRangeCount = 0;

  /**
   * Monotonic, bumped at the top of every `revealStep` — the guard against two navigations
   * overlapping (code review finding 3; the header's "Concurrent reveals" section has the
   * failure in full). It is never reset, not even by `clear()` or `dispose()`: its only job is
   * to be DIFFERENT from the number an in-flight call is holding, and a reset is precisely how
   * a stale call would find its number valid again and resume painting.
   */
  private revealSeq = 0;

  constructor() {
    this.decoration = vscode.window.createTextEditorDecorationType({
      // A theme colour, not a literal: the highlight has to be legible in a light theme, a
      // dark one and a high-contrast one, and `editor.findMatchHighlightBackground` is
      // already the token every theme defines for "this region, but you are not editing it"
      // (spec §5.3 refinement notes name it).
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      isWholeLine: true,
    });
  }

  /**
   * Open `<target>/<step.target.file>`, scroll the step's line into the centre, and highlight
   * its load-bearing ranges. Resolves — never rejects — whatever happens: see the file header
   * on why a rejection here has nobody to catch it.
   */
  /**
   * `preserveFocus` defaults to true because the common caller is a STEP CHANGE — the learner
   * clicked in the tree or pressed Next, and yanking the caret out of the panel they are
   * reading would be the editor taking a turn nobody offered it. The exception is the panel's
   * own *Open the file* button, which is an explicit "take me there": that one passes
   * `preserveFocus: false`, because being sent to a file you asked for and left unable to type
   * in it is its own small insult.
   */
  async revealStep(target: string, step: StepLike, opts: { preserveFocus?: boolean } = {}): Promise<void> {
    // Claimed before anything can await, so every check below is asking one question: has the
    // learner navigated past this reveal while it was waiting on the disk? If they have, this
    // call must touch nothing — not the front-most editor, not the decorations, not the
    // bookkeeping the test seam reads.
    const seq = ++this.revealSeq;

    // Containment, not `path.join`. `null` means the plan named something outside the target
    // folder, which is not a file we will open at any point, on any code path. Nothing has
    // awaited yet, so this call is still the newest one and the clear is unconditionally
    // right: the step DID change, and the previous step's highlight would now be pointing at
    // the wrong code.
    const absPath = resolveInsideTarget(target, step.target.file);
    if (absPath === null) {
      this.clear();
      return;
    }

    let editor: vscode.TextEditor;
    try {
      const doc = await vscode.workspace.openTextDocument(absPath);
      // The bail-out that matters most: `showTextDocument` is what pulls a file to the FRONT,
      // so a superseded reveal must never reach it. This is the exact line that stops step 3
      // (cold, slow) from yanking the editor back off step 4 (already cached, so it finished
      // first).
      if (seq !== this.revealSeq) return;
      editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: opts.preserveFocus ?? true,
        viewColumn: vscode.ViewColumn.One,
      });
      if (seq !== this.revealSeq) return;
    } catch {
      // A directory, a sentinel like `@misc`, a file deleted since the check, a binary VS
      // Code will not open as text. The step still CHANGED, so the previous step's highlight
      // has to go — leaving it up would be pointing at the wrong code.
      //
      // Unless a newer reveal has started, in which case the highlight now on screen is ITS
      // highlight, for a file this failure has nothing to do with, and wiping it would be this
      // call's parting shot at a step the learner is currently reading.
      if (seq !== this.revealSeq) return;
      this.clear();
      return;
    }

    // Everything from here down is synchronous, which is why there is no third check: this
    // call cannot be overtaken mid-paint. Anything added below that AWAITS needs one.
    const doc = editor.document;
    const line = toZeroBased(revealLine(step), doc.lineCount);
    editor.revealRange(
      new vscode.Range(line, 0, line, 0),
      // InCenter, not InCenterIfOutsideViewport: the step's line should land in a predictable
      // place every time, so "where am I now" is never a question the learner has to re-answer
      // by scanning the viewport.
      vscode.TextEditorRevealType.InCenter,
    );

    const ranges = DECORATED_KINDS.has(step.kind)
      ? step.scaffold.loadBearing.map((range) => toRange(range, doc))
      : [];

    // Clearing first only matters when the previous highlight is on a DIFFERENT editor:
    // `setDecorations(type, [])` on this one is itself the clear, so a step that decorates
    // nothing (a `shape` step, a `file` step with an empty scaffold — 14 of 21 in the real
    // plan) still wipes what the previous step left behind.
    if (this.lastEditor !== editor) this.clear();
    editor.setDecorations(this.decoration, ranges);
    this.lastEditor = editor;
    this.lastRangeCount = ranges.length;
  }

  /**
   * The same reveal-and-decorate for one range of one absolute path (T-7, AC2's "reveal +
   * decoration" on a detour stop).
   *
   * It is a method here rather than a second decorator inside `src/detour/` for the reason the
   * `decoration` field already argues: ONE long-lived decoration type per window, so that
   * "clear the last highlight" is one call that really clears rather than a set of handles
   * somebody has to remember. A detour's highlight and a step's are the same colour because
   * they mean the same thing — *this region, but you are not editing it* — and the learner
   * moves between them constantly.
   *
   * `revealSeq` is claimed exactly as `revealStep` claims it, so a stop and a step navigation
   * racing each other resolve the same way: the newest wins and the loser touches nothing.
   * `preview: false` for the reason `detourAdaptersFor` gives — the detour's tabs must stack —
   * and `preserveFocus` because the narrator is what the learner is driving.
   *
   * Resolves, never rejects: the caller is a button press, and there is nobody above it.
   */
  async revealRangeAt(absPath: string, startLine: number, endLine: number): Promise<void> {
    const seq = ++this.revealSeq;
    let editor: vscode.TextEditor;
    try {
      const doc = await vscode.workspace.openTextDocument(absPath);
      if (seq !== this.revealSeq) return;
      editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.One,
      });
      if (seq !== this.revealSeq) return;
    } catch {
      // The tab was closed by hand, or the file is gone. The narrator has already moved and
      // says where to look; there is nothing here worth taking a button press down for, and
      // the previous highlight is deliberately LEFT alone — unlike `revealStep`'s failure
      // path, nothing about a detour stop that would not open says the walk has moved on.
      return;
    }

    const doc = editor.document;
    const start = toZeroBased(startLine, doc.lineCount);
    const end = Math.max(start, toZeroBased(endLine, doc.lineCount));
    editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenter);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    if (this.lastEditor !== editor) this.clear();
    editor.setDecorations(this.decoration, [range]);
    this.lastEditor = editor;
    this.lastRangeCount = 1;
  }

  /** Un-decorate the editor the ranges were actually painted on. Safe when there are none. */
  clear(): void {
    const editor = this.lastEditor;
    this.lastEditor = undefined;
    this.lastRangeCount = 0;
    if (!editor) return;
    try {
      editor.setDecorations(this.decoration, []);
    } catch {
      // The document was closed while it held the highlight: VS Code invalidates the
      // `TextEditor` object and `setDecorations` on it throws. Nothing to un-decorate — the
      // editor the ranges were painted on is already gone, and so are they.
    }
  }

  /**
   * The number of ranges in the most recent `setDecorations` call — `0` after `clear()`, `0`
   * for a step that decorates nothing. The ONLY way to observe this class's effect from a
   * test; see the file header for why VS Code leaves no other one.
   */
  getLastRangeCountForTest(): number {
    return this.lastRangeCount;
  }

  /**
   * Disposing the decoration type removes its decorations from every editor by itself, so the
   * `clear()` first is not what takes the highlight down — it is what leaves this object's own
   * bookkeeping telling the truth afterwards, which matters because `dispose` runs from
   * `context.subscriptions` at a moment no test controls.
   */
  dispose(): void {
    this.clear();
    this.decoration.dispose();
  }
}
