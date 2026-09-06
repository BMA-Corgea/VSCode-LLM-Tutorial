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

- **T-5** (feature) — The dial — manual, scaffolded, automated — with the structural check and a comm… — auto-review
- **T-6** (feature) — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript pe… — plan
- **T-7** (feature) — The detour — an unrelated worked example, in real tabs, that leaves nothing beh… — plan
- **T-8** (feature) — Package and publish — .vsix, Marketplace and Open VSX — plan
- **T-9** (direction) — Mode A — idea-first: a Socratic plan from first principles and simple shapes — dir-goals
- **T-10** (direction) — Divergence — follow the author or diverge, and replan the remainder — dir-goals

### Where that stands

**T-5 — the dial. BUILT; in review.** Branch `feature/T-5-dial`, worktree
`../VSCode-LLM-Tutorial-T-5`, 10 commits. All 8 plan steps, all 7 ACs. Tests went from
261 + 39 at the start of the ticket to **429 unit + 50 vscode-test**, green under both a real
DISPLAY and `xvfb-run`. Full account: `.autodev/handoffs/T-5.md`.

AC6 is proven the way it is worded — a real plan built through the core with `cachedOnly`,
walked in automated mode, then compared to the reference file-for-file and byte-for-byte, with
a mutation proof that flips a byte a string comparison could not see.

**Its own acceptance suite found a real bug rather than passing.** `applyDial`'s staleness
check sat before its await, so a queued entry pass for a step already navigated past was
dropped rather than deferred: two `next()` calls in one tick left two files unwritten and one
commit instead of three, silently. Fixed in `fbf6805`. Nothing caught it earlier because the
fixture had a single `file` step, and a walk with one file step cannot be walked past one. The
generalisable form is now in `kb/wiki/lessons.md`.

**T-6 must reconcile before it builds, exactly as T-5 had to.** T-6 was refined against T-4's
PLAN, and T-5 has since moved more of the same surfaces. Two things it will trip on: the
panel's repaint key (`stepRenderKey` — a rendered field missing from it is stored and never
drawn, failing no test), and the fact that the panel's client-side `note` channel now has no
producer, because T-5 deleted the placeholder that fed it and T-6's tutor is what fills it.

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
