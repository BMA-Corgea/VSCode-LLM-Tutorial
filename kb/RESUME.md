# RESUME — Build Tutorials · foreman continuation run of Sun 2026-11-08, 11:50–16:30 MST

> **Read this file first and read it in order. It is written for someone who was not here.**
> Sections 1 and 2 save you from being wrong; the board is further down because the tracker
> regenerates it in one command. The run ended on the week's usage meter, by design.

**In one line:** eight tickets landed and are on GitHub's `main` (`35f805c`): T-21, T-30, T-17, T-44,
T-42, T-43, T-19, T-41. T-22 (the replan) is built most of the way on a local branch. Nothing was
published to any marketplace. The owner's form answers are in the local ledger as GA-16.

---

## 1 · WHAT YOU WILL GET WRONG IF YOU TRUST THIS REPO

1. **"The walk re-plans after a choice."** Only on the branch `feature/T-22-the-replan` (local,
   not merged; see section 2). On `main`, a press records the choice and the panel says plainly the
   rest of the walk hasn't changed.
2. **"The idea box exists."** `src/derive/` (T-17) landed on `main` and has **no caller in the shipped
   extension** until T-20. T-17's proof is one live derivation (`.autodev/evidence/T-17/live-run.md`,
   4 calls, $0.11): the prompts changed after that run, so what the model would write now is not
   re-proved. T-19's harness proves the engine listens, on a fake model; it says nothing about a real
   model or about plan quality.
3. **"The screen suite is solid."** T-15's start-screen test *"a folder picker left open across the
   END of a build…"* (T-80) fails intermittently, often under load, and passed on the final full run.
   T-21's seat found it polls for a state lasting milliseconds (in a failing probe the second build
   DID start). Don't read one failure as a regression; re-run once. T-80 holds the leads.
4. **"vscode-test runs VS Code 1.145.0."** `.vscode-test.mjs` pins no version; `stable` resolves over
   the network on every run. It is **1.145.2** now, and a tree without it downloads about 1 GB into its
   `.vscode-test/`. Symlink an existing install instead.
5. **"vscode-test runs under xvfb by itself."** Only when `DISPLAY` is unset: start seats with
   `env -u DISPLAY -u WAYLAND_DISPLAY` (the local `foreman.conf` does).
6. **"The test suites clean up after themselves."** They don't: each unit run leaves about 390 temp
   folders in `/tmp` (T-81). Three seats filled the root disk this way in one afternoon; the foreman
   cleared about 2.6 GB by exact path.
7. **T-22's product call (M1) is already ruled:** the page warns and names each walked step that
   stood on the old road, and the decision's own code follows the answer (foreman's ruling, reversible;
   recorded in T-22's spec and handoff). Don't re-litigate it unless the owner overturns it.
8. **T-14's `risk: low`** is stale and immutable (undo touches plan versions on the learner's disk).
   Override its review depth by hand, in its own evidence.

## 2 · HALF-DONE, UNVERIFIED, OR DELIBERATELY PARKED

| what | state | trigger / owner |
|---|---|---|
| **T-22** the replan | branch `feature/T-22-the-replan` @ `53b2311`, **local only** (the owner's Q13: branches stay here), `build` not passed; 1795 unit, 4 real-page re-plan tests and 14 real-page mutants caught; no model call made. Handoff `.autodev/handoffs/T-22.md` is exact | Next: the other 29 unit-level mutants, one live divergence AC12 (needs a live-run authorisation), the `build` pass, the `host` and `screen` labels, two blind reviews, merge GO |
| **T-18, T-20, T-23** | not started | wait on T-22; T-20 also needs T-61 settled before it ships Mode A |
| **T-40** codicons, waiting states | not started | next free seat |
| **T-14** undo | ready (GA-11), not started | shares T-22's plan versions: land it after T-22 |
| **T-61** model-written code runs as the learner | filed, open | settle before T-20 ships Mode A |
| **T-50, T-51, T-52, T-60, T-70, T-71, T-72, T-73, T-80, T-81** | filed this run, `intake`, no go-ahead names them | see each ticket; none blocks T-22 |

No gate was killed. Every landing had blind review: two reviewers for T-17, T-21, T-30, T-19 and T-43; one for T-44, T-41 and T-42; T-17 and T-21 also had a blind re-review of their fixes. The landed branches are merged and pushed; worktrees are left in place beside this repo.

## 3 · WAITING ON THE OWNER

Nothing blocks the next run. Banked, each with what happens if never answered: the 15 proposed edits to
the design-polish skill (`.autodev/foreman/2026-11-05/design-polish-feedback.md`, local): the skill stays as
it is; and the T-22 M1 ruling, which they can overturn cheaply. Publishing to any marketplace remains the
owner's act. **Authority used today** (local ledger `.autodev/events.jsonl`): GA-15 (T-17..T-23, T-30,
T-40..T-43, on the owner's words on Nov 8), GA-16 (the form: T-44's answer A, push `main` after each
reviewed landing, the owner skips the hands-on press, so the screen suite carries that check). T-50..T-81
have no go-ahead naming them.

## 4 · THE INSTRUMENTS, AND WHAT EACH ONE REFUSES

| tool | path | refuses |
|---|---|---|
| foreman instruments (`seat`, `send`, `fm`, `wait-any`, `lastmsg`) | app-template's `process/foreman/` (shared and live; not copied) | its README |
| `foreman.conf` | `.autodev/foreman/foreman.conf` (local) | a private tmux server; `SEAT_COMMAND` starts every seat with `DISPLAY`/`WAYLAND_DISPLAY` unset and pages held |
| `push-scan.sh` | `.autodev/foreman/2026-11-08/instruments/push-scan.sh` (local) | a push whose messages or patches carry the owner's first name, an email (other than the noreply attribution), a `/home/` path, a token shape, or a `node_modules` / `.vscode-test/` / ledger path |
| `watch-seats.mjs` | `.autodev/foreman/2026-11-08/instruments/` (local) | one stream for a Monitor: seat reports, idle, an open prompt (once per prompt), meter changes |
| `safe-send.sh` | `.autodev/foreman/2026-11-08/instruments/` (local) | pasting into a seat with a permission prompt open: a paste's Enter answers the prompt "Yes" (it happened once today) |

**Known gaps:** `seat send` retries after 60 s and can mis-report on a busy seat; a seat's `rm` inside a compound command trips a permission prompt, and the seat stalls until it auto-blocks (tell seats: one plain `rm` with a literal path).

## 5 · THE SHAPE OF THE RUN, so you can recreate it

- Three seats on the default tmux server, `opus` → **claude-opus-5-5**, `--effort max`, each in its own worktree beside this repo with `node_modules` symlinked from the main checkout: `bt-t21` (T-21, T-44, T-43, T-41), `bt-t17` (T-17, T-22), `bt-t30` (T-30, T-42, T-19). All closed at wind-down.
- Reviews: blind Opus subagents inside each seat; the foreman re-ran unit and typecheck on every merge head before its GO, and re-drove each ticket's real-host or real-panel tests on the merge commit before clearing `accept`.
- Briefs, rulings, decisions, foreman checks: `.autodev/foreman/2026-11-08/` (local). The board: `node <autodev>/scripts/tracker.mjs --root . status`.

## 6 · STATE, PASTED FROM THE AUDIT

Pasted from `wind-down/reference/wd-audit` at the end of the run, paths elided (public repo). `dirty:2` is this file and `kb/CURRENT-WORK.md`, committed right after this paste.

```

── GATES / LONG RUNS STILL IN FLIGHT ──
  none running (a bash shell merely WAITING on one does not count)

── UNCOMMITTED / UNPUSHED, PER REPO ──
  UNTRACKED is where work DIES: a ledger-on-disk is untracked until staged, and a
  commit-count check reports clean over it. On this audit's first real use the repo
  showed unpushed:0 with NINE ticket files untracked. Commit your own, then push.
  tracked-dirty you did NOT write belongs to a peer session: NAME it, never commit it.
  VSCode-LLM-Tutorial            [main] dirty:2   untracked:0   unpushed:0

── BRANCHES THAT EXIST ONLY ON THIS DISK (every local branch, not just the checked-out one) ──
  feature/T-22-the-replan               9 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-8-package                   1 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  NOT SEEN: refs/remotes is this disk's CACHED belief about the remote, as of the last fetch.
  This contacted nothing. A branch deleted on the server still reads as backed up here.
  Stash entries are on no remote and are reachable from no branch, so no count above includes
  them: 0 entry(s), and the stack is shared across worktrees.

── PIN vs MAIN (an organ ahead of its pin is a gap someone will 'fix') ──
── ATTESTATIONS (bare audit: runs nothing) ──
  (no repin_guard.py here)

── SEAT HOLDS — every one of these must be GONE before the panes close ──
  none (good)

── WORKER PANES ──
  no w-* sessions

── INSTRUMENTS STILL ONLY IN A SCRATCHPAD — these die with the session ──
  none found (either already persisted, or look harder)

── OPERATOR GATES STILL OPEN ──
  go-aheads recorded: 16
  grants recorded:    0  (0 is fine if that was decided)
  --> list tickets waiting on a human gate with the tracker, and put the FORM URL in RESUME

── done. Paste this whole block into RESUME, then act on every <-- marker. ──
```

## 7 · THE BOARD

- **Landed today, on GitHub's `main`:** T-21 (`08884ee`), T-30 (`76bb37b`), T-17 (`dea3fc7`), T-44 (`382fa2e`), T-42 (`21896a2`), T-43 (`3dbbbc9`), T-19 (`964ce97`), T-41 (`35f805c`).
- **The foreman's full suite on `35f805c`:** typecheck, lint, build clean; **1741 unit; 82 host + 22 screen vscode-test, exit 0**, headless under `xvfb-run -a`.
- **Filed today:** T-50, T-51, T-52, T-60, T-61, T-70, T-71, T-72, T-73, T-80, T-81.
- **In flight:** T-22 at `build`, on its branch. **Waiting:** T-14, T-18, T-20, T-23, T-40 at `intake`.

## 8 · WHAT THIS RUN LEARNED THAT IS NOT IN A TICKET

A fix can introduce the defect the next reviewer finds: T-17's blind re-review of its own fixes found a real regression that every green test had passed. And a foreman's message to a seat is a keystroke: a paste into a seat with an open permission prompt answers the prompt, so check the seat's state before typing anything into it.
