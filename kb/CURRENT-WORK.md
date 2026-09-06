# vscode-llm-tutorial — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->

- **T-5 (feature) — The dial. IN PLAN, branch `feature/T-5-dial`, worktree
  `../VSCode-LLM-Tutorial-T-5`.** Where the learner's hands meet the load-bearing line:
  manual / scaffolded / automated, the structural check behind *Check my work*, and a commit
  per completed step. Its locate and refinement notes were drafted against T-4's PLAN, so the
  plan now opens with a **reconciliation table against T-4's merged code** — twelve names
  moved, and one of them (the step panel's new repaint key) would store a check result and
  never draw it rather than failing loudly. Plan: `.autodev/plans/T-5.md`.
  T-5 also owns the half of AC1 that T-4 deliberately left: the GLOBAL dial in `request.json`
  is still read by nothing, so `statusText` falls back to `manual` per step.

- **T-6 → T-8** — parked at `plan`, `spec_ready` cleared on GA-1. T-6 is sequenced AFTER T-5
  (both edit the step panel, protocol and session; a three-way edit is not worth the merge).

- **T-9, T-10** (direction) — Mode A (idea-first) and Divergence. Untouched, at `dir-goals`.

- **T-1 (direction) — Build tutorials v1.** Complete; routed into T-2…T-10 here plus
  repo-tour T-11…T-13.

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
- 2026-09-06 **T-4 COMPLETE** — The walk — decision tree, step panel, editor driving, and progress that survive…
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
