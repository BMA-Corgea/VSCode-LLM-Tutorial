# T-4 — The walk: decision tree, step panel, editor driving, and progress that survives reload

**Type:** feature · **Shop:** vscode-llm-tutorial · **After:** T-3 · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §5.1, §5.3) · **Risk:** medium
**Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-1).

## The ticket's spec (captured, not re-composed)

WHY: .autodev/specs/T-1-build-tutorials-v1.md §5.1, §5.3. Recreate mode only; the panel shows alternatives but does not let the learner pick one (marked 'coming with T-10', where the eye is).

ACs:
1. A native TreeView of chapters → steps with done / current / pending icons; clicking a step makes it current. Check: TreeDataProvider unit tests.
2. The step panel (webview view) renders question, the author's choice marked among the options, why with its source named (interpret / docstring / not inferable), the witness (or 'no history to show'), Open the file, Check my work (wired in T-5), Next / Previous. Check: rendered HTML assertions per whySource and for a null witness.
3. Opening a step reveals the target range in the real editor and decorates the load-bearing lines with a TextEditorDecorationType; decorations clear when the step changes. Check: vscode-test asserts the active editor, visible range and decoration count.
4. Position and per-step status persist in <target>/.repo-tour/build/progress.json; the current build's target folder is remembered in workspaceState so reopening the workspace restores the tree and panel at the same step. Check: state test across a simulated reload.
5. The step panel implements getState/setState and re-renders from the host's plan after being hidden; it never holds truth of its own. Check: hide/show in vscode-test keeps the step.
6. Status bar shows 'step 7 / 40 · scaffolded'. Check: status bar item text.

Out of scope
- Writing files, the dial's effect, checking — T-5
- Picking an alternative — T-10

## Refinement notes (2026-09-05, against T-3's real code)

- **Mirror T-3's split exactly:** pure `model` / `view` / `protocol` modules with no `vscode` import (unit-tested
  under plain mocha), and thin adapters that meet the real API (`src/start/panel.ts` is the pattern; the host
  is the only truth, `retainContextWhenHidden: false`, re-render on visibility). `renderPage` from
  `src/webview/page.ts` prepends `post/restore/save`; `escapeHtml`/`escapeAttr` from `src/webview/html.ts`.
- **Which workspace is "the build"?** The learner works in the target folder. Rule: **the walk opens for any
  workspace folder that contains `.repo-tour/build/plan.json`** — detected on activation (`onStartupFinished`
  is already in `activationEvents`) and after a build completes. If the build's target is not the open
  workspace, offer *Open the folder* (`vscode.openFolder`) — the new window then detects the plan itself. No
  `workspaceState` juggling across windows.
- **Progress lives beside the plan:** `<target>/.repo-tour/build/progress.json` — `{ schemaVersion: 1,
  current: stepId | null, steps: { [stepId]: { status: 'pending' | 'done', dial?: Dial } } }`, written atomically
  (temp + rename, like T-3's marker). Per-step `dial` and `transcript` slots exist now for T-5/T-6.
- **Two surfaces in one container:** a `viewsContainers.activitybar` entry `buildTutorials` holding the native
  tree `buildTutorials.decisions` and the webview view `buildTutorials.step`. The step panel also carries the
  skin picker (same `readSkin`/`writeSkin`).
- **Honest controls (repo-tour's lesson):** *Check my work* and the dial are rendered now and act in T-5 — pressing
  *Check* replies, in the panel, "Check my work arrives with T-5"; changing the dial persists per step (T-5 reads it).
  Alternatives are shown and marked *coming with T-10*, not selectable. *Open the file* is enabled only when
  `<target>/<file>` exists (manual mode, nothing written yet → the panel says "you haven't created this file yet").
- **Decorations:** one `TextEditorDecorationType` (`backgroundColor: new ThemeColor('editor.findMatchHighlightBackground')`,
  `isWholeLine: true`) over the step's load-bearing ranges, cleared on step change or panel dispose; reveal with
  `TextEditorRevealType.InCenter`.
- **The reload drill is real here:** a new `WalkSession` constructed from disk (plan + progress) restores the
  current step — unit-tested from disk, and the vscode-test reopens the session after disposing it.
