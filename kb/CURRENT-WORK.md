# vscode-llm-tutorial — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->
  `feature/T-2-skeleton` (commits through `1f5c259` plus a README/NOTICE/packaging follow-up)
  and self-verified — typecheck, lint, `npm test` (4/4, both under a real DISPLAY and under
  `xvfb-run -a`), `npm run build`, `./build-tutorials doctor`, `./build-tutorials package`
  (.vsix), and `./build-tutorials dev` / `./start.sh` (codium opened with the extension,
  confirmed via process + logs, then closed) all green. **The risky bet paid off**: repo-tour's
  ESM core, including web-tree-sitter's WASM, loads and runs correctly inside the real VS Code
  extension host via dynamic `import()` — no architecture change needed, T-3 onward can build
  on this as specced. Full account: `.autodev/handoffs/T-2.md`. Reported back for
  review/accept.
- **T-3** (feature) — The start screen, shared skins, and building the plan with resume — intake
- **T-4** (feature) — The walk — decision tree, step panel, editor driving, and progress that survive… — intake
- **T-5** (feature) — The dial — manual, scaffolded, automated — with the structural check and a comm… — intake
- **T-6** (feature) — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript pe… — intake
- **T-7** (feature) — The detour — an unrelated worked example, in real tabs, that leaves nothing beh… — intake
- **T-8** (feature) — Package and publish — .vsix, Marketplace and Open VSX — intake
- **T-9** (direction) — Mode A — idea-first: a Socratic plan from first principles and simple shapes — dir-goals
- **T-10** (direction) — Divergence — follow the author or diverge, and replan the remainder — dir-goals


- **T-1 (direction) — Build tutorials v1.** 2026-09-04: shaped with Evan in one session and
  routed into T-2…T-10 here + repo-tour T-11…T-13. Waiting on his approval of the set and his
  answer to the exception question. Spec: `.autodev/specs/T-1-build-tutorials-v1.md`. First
  thing to prove: T-2's doctor (can the extension host load repo-tour's core at all).

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->


## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->
- 2026-09-04 **T-2 COMPLETE** — Extension skeleton, core attach, and a doctor that proves the host can run it
- 2026-09-04 **T-1 COMPLETE** — Build tutorials v1 — recreate a repo by its decisions, in VS Code, on repo-tour…


## Reference table (where the past lives)

| Looking for... | Where |
| --- | --- |
| Any ticket's full journey | its ticket file (by id/slug) and its handoff in `.autodev/handoffs/` |
| The event-by-event record | `events.jsonl` (append-only, forever) |
| Durable lessons and decisions | `kb/wiki/` |
| What the code looks like now | `kb/CODE-MAP.md` |
