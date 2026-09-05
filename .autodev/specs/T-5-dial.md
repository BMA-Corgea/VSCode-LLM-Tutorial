# T-5 — The dial — manual, scaffolded, automated — with the structural check and a commit per step

**Type:** feature · **Shop:** vscode-llm-tutorial · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §5.4, §4.4, §4.5) · **Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-1).

## The ticket's spec (captured, not re-composed)

WHY: .autodev/specs/T-1-build-tutorials-v1.md §5.4, §4.4, §4.5. This is where the learner's hands meet the load-bearing line.

ACs:
1. The dial is global (from the start screen) and overridable per step from the panel; per-step positions are remembered; the global setting never drifts toward automated on its own. Check: state tests.
2. manual: the extension writes nothing and the panel shows the file's shape (exports, imports) from the plan. Check: target tree unchanged after opening the step.
3. scaffolded: the file is written with boilerplate ranges from the reference and the core's stubs for load-bearing ranges; the written file parses (zero ERROR nodes) in TS, JS and Python fixtures. Check: parse test on written files.
4. automated: the reference file is written verbatim and the panel walks each load-bearing range with reveal + decoration and the step's narration. Check: byte equality with the reference; the walk visits every range.
5. Check my work runs the core's structural check and shows present / missing / extra per symbol in the panel and a ✓ / ✗ on the tree node; a renamed local variable passes; a missing export is named. Check: unit + vscode-test.
6. Walking every step in automated mode reproduces the reference's source files byte-for-byte; generated / vendored / lockfile files are reproduced from plan.reproduce and never presented as steps. Check: diff -r in the acceptance run on the first target (sql-gauntlet).
7. Commit per completed step: the target is git-inited if needed; a passed (or automated) step commits its file with the message '<ordinal>: <question> — <chosen option label>'; a setting turns it off. Check: git log on the fixture target.

Out of scope
- Semantic comparison of bodies — deferred: who=agent:pm why=the check is structural by design (.autodev/specs/T-1-build-tutorials-v1.md §4.4); semantics go to the tutor on request
- Running the learner's app for them — deferred: who=agent:pm why=the real terminal is theirs; the panel only suggests the command

## Refinement notes (2026-09-05 — drafted against T-4's PLAN; reconcile against T-4's merged code before build)

- **What the dial changes, per step kind.** *file* step: manual → nothing written (the learner creates the
  file; the panel shows its shape — the signature line of each load-bearing range and the reference's import
  lines); scaffolded → the reference file with boilerplate ranges verbatim and load-bearing ranges stubbed by
  the core's `stubFile`; automated → the reference file verbatim. *symbol* step: manual/scaffolded → the learner
  fills it and presses *Check my work*; automated → the panel narrates the range (reveal + decoration + the
  step's why/summary) and *Next* marks it done. *shape* step: informational in every mode.
- **Never overwrite a learner's edits silently.** If `<target>/<file>` exists and differs from what the dial
  would write, ask *Overwrite / Keep mine* (a real `showWarningMessage` with two buttons); *Keep* leaves the
  file and says so in the panel.
- **`plan.reproduce`** (generated / vendored / lockfile / data / binaries — never taught): a command
  `buildTutorials.reproduceFiles` copies them from the reference; automated mode runs it before the first file
  step; other modes are offered it once at the first *shape* step, in the panel, with the count.
- **The check needs the reference's extract.** The extension has the plan, the reference root (`request.json`)
  and the core. Produce the reference `FileExtract` the way repo-tour's own `test/build.test.ts` does for
  `check()` (an inventory-shaped `FileRecord` + `extract()` on the one file), then call the core's
  `check(learnerSource, referenceExtract, language, relPath)`. Read `src/build/check.ts` and that test first;
  no repo-tour edits in this ticket.
- **Commits are the learner's, not ours.** `git init` the target if needed; commit with the target's own git
  identity; if none is configured, skip the commit and say so once in the panel (never invent an author).
  Message: `<ordinal>: <question> — <chosen option label>`. Setting `buildTutorials.commitPerStep` (default on).
- **Progress gains** `check?: { ok: boolean; at: string }` per step and `reproduced?: string` (ISO) — via the
  atomic `saveProgress` T-4 introduces.
- **Byte-for-byte is the acceptance criterion** (T-1 §9 #3): the vscode-test walks a small fixture plan in
  automated mode and `diff -r`s the target against the reference, ignoring `.repo-tour/` and `.git/`.
