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

- **T-6** (feature) — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript pe… — gate
- **T-7** (feature) — The detour — an unrelated worked example, in real tabs, that leaves nothing beh… — plan
- **T-8** (feature) — Package and publish — .vsix, Marketplace and Open VSX — plan
- **T-9** (direction) — Mode A — idea-first: a Socratic plan from first principles and simple shapes — dir-goals
- **T-10** (direction) — Divergence — follow the author or diverge, and replan the remainder — dir-goals

### Where that stands

**T-6 — the tutor. BUILT, not yet reviewed or merged.** Branch `feature/T-6-tutor`, worktree
`../VSCode-LLM-Tutorial-T-6`, 4 commits. All 7 plan steps, all 5 ACs. **653 unit + 58
vscode-test**, green under both display methods (T-6 began at 479 + 50).

**RESUME BY RUNNING THE TWO MACHINE REVIEWS** (code + security), the way T-4 and T-5 ran them
— `.autodev/reviews/T-5-*.md` shows the shape and the standard. Both of those tickets had
must-fix findings; this one has not been reviewed at all yet. Full account and the resume
command: `.autodev/handoffs/T-6.md`.

One thing already flagged for the reviewer: `checkReachable` is only called inside `beginAsk`,
so the reachability line appears after the first press rather than beside the input from the
start. AC4 as specified still holds; the refinement note's wording is only half wired.

**T-4 and T-5 are complete and merged.** T-7 (the detour) and T-8 (publish) are parked at
`plan`; T-9 and T-10 untouched at `dir-goals`.
- **T-12** (bug) — reproduceFiles copies a reference repo's agent config and secrets into the lear… — intake

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->
- Nothing is waiting on a human right now. T-4…T-8's `spec_ready` gates were all cleared
  2026-09-05 on the owner's go-ahead GA-1; the five "waiting at spec_ready" lines that stood
  here were stale against the tracker. T-4 is **building** (resumed 2026-09-05 on go-ahead
  GA-3); T-5…T-8 sit at `plan` — unstarted, not blocked. The next human stop is T-4's
  **accept** gate.


## Known landmines (not bugs today; they bite on a named trigger)

<!-- Things deliberately LEFT unfixed, each with the condition that makes it real.
     Never prune one silently: the point is that the next person meets it here
     rather than re-discovering it the hard way. -->

- **`feature-regulated@v1` has an unwired role.** Its `compliance-review` stage names the role
  `compliance-officer`, which resolves in no tier — not the client roster, not the plugin
  roster, not the catalog — so the stage would run on a **generic fallback agent** with no
  compliance instructions. `/autodev:doctor` reports it as the standing `pipelines.wiring` WARN.
  **Harmless right now** because nothing here targets that pipeline: every ticket runs on
  `feature@v1` or `direction@v2`.
  **TRIGGER — the moment any ticket targets `feature-regulated`, `compliance-officer` must be
  wired or the stage pruned.** Shipping a regulated ticket through a generic fallback would put
  a compliance stamp on work no compliance seat ever read.
  Left deliberately unfixed and deliberately un-pruned 2026-09-07 (foreman agent, on the owner's
  standing authority): pruning it would delete the fact that the preset exists, which is the
  knowledge this entry is protecting.


## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->
- 2026-09-06 **T-5 COMPLETE** — The dial — manual, scaffolded, automated — with the structural check and a comm…
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
