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

- **T-6** (feature) — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript pe… — plan
- **T-7** (feature) — The detour — an unrelated worked example, in real tabs, that leaves nothing beh… — plan
- **T-8** (feature) — Package and publish — .vsix, Marketplace and Open VSX — plan
- **T-9** (direction) — Mode A — idea-first: a Socratic plan from first principles and simple shapes — dir-goals
- **T-10** (direction) — Divergence — follow the author or diverge, and replan the remainder — dir-goals

### Where that stands

**T-5 — the dial. COMPLETE.** Merged as `1167f91`; the full pipeline ran. Tests across T-4 and
T-5 went from 89 unit + 20 vscode-test to **479 + 50**. Verified on the INSTALLED `.vsix`
against the real 61-step plan, not the dev host: automated mode wrote the step's file
byte-for-byte, copied all 15 never-taught files, and committed under the folder's own git
identity. Evidence and screenshot in `.autodev/evidence/T-5/`.

**One delta from T-1 §5.4 is on the record for the owner**, not decided: he wrote that
automated mode's panel "walks each load-bearing range and narrates"; what ships reveals and
decorates the STEP's range. Identical for a symbol step, visible only on a multi-range file
step. Whether a per-range walk earns its complexity is a feel question.

**Both machine reviews found things worth more than the feature**, all fixed in-diff: a write
that could escape the target through a symlinked directory, a commit that took the whole index
rather than the step's file, a file the dial wrote but never revealed, and — before that — an
entry pass that was dropped rather than deferred when the learner navigated quickly. The
durable form of each is in `kb/wiki/lessons.md`, which is now nine lessons rather than a stub.

**T-6 is next and must RECONCILE FIRST.** It was refined against T-4's plan, and both T-4 and
T-5 have since moved the surfaces it edits. The two it will trip on: `stepRenderKey` (a
rendered field missing from the repaint key is stored and never drawn, failing no test), and
the panel's client-side `note` channel, which has had no producer since T-5 deleted the
"arrives with T-5" placeholder — T-6's tutor is what fills it, and its clearing-on-navigation
is currently untested as a result.

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
