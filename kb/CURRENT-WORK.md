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

- **T-9** (direction) — Mode A — idea-first: a Socratic plan from first principles and simple shapes — dir-scope
- **T-10** (direction) — Divergence — follow the author or diverge, and replan the remainder — dir-scope

### Where that stands

**Every work ticket is complete. T-1…T-8 and T-11…T-13 have shipped; T-9, T-10 and T-14 are
direction/deferred.**

**T-8 (package and publish) MERGED at `d990a2a`** — the `.vsix` now carries the core, so the
extension installs for someone with no repo-tour checkout beside them. It was 11 files with no
`node_modules`; it is **152 files / 6.57 MB** with `repo-tour/dist`, `web-tree-sitter` and 36
`.wasm` grammars. AC1 PROVEN on **both** VSCodium and a real VS Code 1.136.1. Full account:
`.autodev/handoffs/T-8.md`.

**NOTHING IS PUBLISHED AND NO REGISTRY TOKEN EXISTS.** The publish steps are dry-run only, and the
script **refuses** when a credential is present unless two separately-sourced, version-bound
confirmations are given. Publishing remains the owner's act.

**`main` is 2 commits ahead of `origin/main`, and they are T-8's.** The push authorisation was
scoped to T-12 and T-13 (pushed at `8bb1f5b`) and does not stretch to T-8 — **ask before pushing**.

**T-9 (Mode A) and T-10 (divergence) are at `dir-scope`**, unblocked by the sponsor's decision form
of 2026-09-07 23:42 UTC (GA-8). Mode A's acceptance criterion is now mechanical and lives in T-9's
spec as **AC-A1**: same idea, answers differing at exactly one decision D → the steps downstream of
D differ **and** the steps independent of D do not. T-1 §9 gained **criterion 3a** for it, and
criterion 3 is now marked **(MODE B ONLY)**. What AC-A1 does *not* cover — whether the plan is any
good — is stated at length rather than implied.

**T-14 (undo a divergence)** filed at `intake` as the sponsor's deferral, carrying the observation
that undo and the deferred replan diff need the same substrate.

**Test baseline on `main`: 1248 unit + 75 vscode-test.** It was 479 + 50 when T-6 began.

- **T-14** (feature) — Undo a divergence — return to the pre-divergence plan — intake

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
- 2026-09-08 **T-8 COMPLETE** — Package and publish — .vsix, Marketplace and Open VSX
- 2026-09-07 **T-13 COMPLETE** — realGit spawns git with no timeout — the last unbounded member of the cost-and-…
- 2026-09-07 **T-12 COMPLETE** — reproduceFiles copies a reference repo's agent config and secrets into the lear…
- 2026-09-07 **T-7 COMPLETE** — The detour — an unrelated worked example, in real tabs, that leaves nothing beh…
- 2026-09-07 **T-6 COMPLETE** — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript pe…
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
