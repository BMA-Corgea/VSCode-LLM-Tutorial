# vscode-llm-tutorial — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->

- **T-4 (feature) — The walk. BUILT, REVIEWED, MERGED; waiting at the `accept` gate.**
  Merged to `main` as `a46f7c9`. All 6 ACs and all 8 plan steps done: native decision tree,
  webview step panel, real editor reveal + load-bearing decorations, and position that
  survives a reload in `<target>/.repo-tour/build/progress.json`. Tests went from 89 unit + 20
  vscode-test at the start of the ticket to **261 + 39**, green under both a real DISPLAY and
  `xvfb-run`. Two machine reviews (code + security) ran and **every finding was fixed in-diff**
  rather than deferred — including a path traversal that T-5 would have turned from a read
  into a write, and a workspace-settable `repoTourPath` that this ticket had newly made
  reachable by merely opening a folder. Verified e2e against the **installed .vsix** on a real
  61-step plan: untrusted workspace correctly disabled, trusted opens the walk, a malformed
  plan says so. Full account: `.autodev/handoffs/T-4.md`; reviews and evidence in
  `.autodev/reviews/` and `.autodev/evidence/T-4/`.
  **The one thing needing the owner: nobody has SEEN the tree or the step panel inside VS
  Code's own chrome** — this machine has no way to synthesise a click, so the activity-bar
  container could not be opened. 30 seconds at the accept gate closes it.

- **T-5 → T-8** — parked at `plan`, `spec_ready` already cleared on GA-1. T-6 follows T-5, not
  parallel. T-5 should read `kb/wiki/repo-tour-plan-shapes.md` first: it writes the learner's
  files at exactly the paths T-4 just had to make containment-safe.

- **T-9, T-10** (direction) — Mode A (idea-first) and Divergence. Untouched, at `dir-goals`.

- **T-1 (direction) — Build tutorials v1.** Complete; routed into T-2…T-10 here plus
  repo-tour T-11…T-13. Spec: `.autodev/specs/T-1-build-tutorials-v1.md`.

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->
- Nothing is waiting on a human right now. T-4…T-8's `spec_ready` gates were all cleared
  2026-09-05 on the owner's go-ahead GA-1; the five "waiting at spec_ready" lines that stood
  here were stale against the tracker. T-4 is **building** (resumed 2026-09-05 on go-ahead
  GA-3); T-5…T-8 sit at `plan` — unstarted, not blocked. The next human stop is T-4's
  **accept** gate.


## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->
- 2026-09-05 **T-4 merged to main** — the walk; every review finding fixed in-diff, awaiting the owner's accept
- 2026-09-05 **T-11 COMPLETE** — The owner's name leaves the public repo
- 2026-09-05 **T-3 COMPLETE** — The start screen, shared skins, and building the plan with resume
- 2026-09-04 **T-2 COMPLETE** — Extension skeleton, core attach, and a doctor that proves the host can run it
- 2026-09-04 **T-1 COMPLETE** — Build tutorials v1 — recreate a repo by its decisions, in VS Code, on repo-tour…


## Reference table (where the past lives)

| Looking for... | Where |
| --- | --- |
| Any ticket's full journey | its ticket file (by id/slug) and its handoff in `.autodev/handoffs/` |
| The event-by-event record | `events.jsonl` (append-only, forever) |
| Durable lessons and decisions | `kb/wiki/` |
| What the code looks like now | `kb/CODE-MAP.md` |
