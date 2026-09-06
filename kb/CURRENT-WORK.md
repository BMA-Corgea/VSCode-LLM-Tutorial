# vscode-llm-tutorial — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live.
     NOTE: the tracker regenerates the terse `- **T-N** (type) — title — stage`
     lines below on every stage change. Do NOT hand-write prose onto those lines;
     it gets clobbered mid-sentence. Narrative goes under "Where that stands". -->

- **T-5** (feature) — The dial — manual, scaffolded, automated — with the structural check and a comm… — build
- **T-6** (feature) — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript pe… — plan
- **T-7** (feature) — The detour — an unrelated worked example, in real tabs, that leaves nothing beh… — plan
- **T-8** (feature) — Package and publish — .vsix, Marketplace and Open VSX — plan
- **T-9** (direction) — Mode A — idea-first: a Socratic plan from first principles and simple shapes — dir-goals
- **T-10** (direction) — Divergence — follow the author or diverge, and replan the remainder — dir-goals

### Where that stands

**T-5 — the dial.** Branch `feature/T-5-dial`, worktree `../VSCode-LLM-Tutorial-T-5`, cut from
`main` at `ee9465a`. Where the learner's hands meet the load-bearing line: manual / scaffolded
/ automated, the structural check behind *Check my work*, and a commit per completed step.
Its locate and refinement notes were drafted against T-4's *plan*, so the plan now opens with a
**reconciliation table against T-4's merged code** — twelve names moved. The one worth reading
twice: the step panel keys repaints on what the page displays, so a check report added without
also adding it to that key is stored and never drawn, failing no test. Plan:
`.autodev/plans/T-5.md` §0.

T-5 also owns the half of AC1 that T-4 deliberately left undone: the GLOBAL dial sits in
`request.json` and nothing reads it, so `statusText` falls back to `manual` for any step
without a per-step override.

**T-6 is sequenced AFTER T-5**, not parallel — both edit the step panel, protocol and session,
and a three-way edit of those is not worth the merge.

**T-1** is complete and routed into T-2…T-10 here plus repo-tour T-11…T-13.

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
