# RESUME — Build Tutorials · foreman AFK run of Tue 2026-11-10, 17:40–21:30 MST

> **Read this file first and read it in order. It is written for someone who was not here.**
> The run ended on **the owner's stop** (announcement A-20261110-2113-9d99: "wind down all the claude agents on
> the bridge"), at 69% of the week, not on its meter line. No merge, push, stage or gate happened after it.

**In one line:** six tickets landed on `main` tonight. Five are on GitHub (`c5046d5`): T-81, T-80, T-40, T-52, T-82.
**T-51 is merged locally at `3c858cb` and NOT pushed** (the stop came first). T-22, T-71, T-70, T-72 and T-83 stopped
on local branches, each with an exact handoff. Nothing was published to any marketplace.

---

## 0 · NEEDS THE OWNER (each with a recommendation, and what happens if never answered)

1. **Accept tonight's landings.** T-81, T-80, T-40, T-52 and T-82 sit at `uat`; T-51 at `verify`. The coordinator's
   standing order kept every `accept` gate the owner's. *Recommend:* accept each. *If never:* they stay at `uat`;
   the code is on `main` either way.
2. **One repository secret, so CI can finish.** CI's Package step checks the `.vsix` for the owner's names, read
   from the secret `BUILD_TUTORIALS_OWNER_NAMES` (comma-separated), so they never sit in this public repo.
   `gh secret list` shows none. *Recommend:* add it (Settings → Secrets and variables → Actions). *If never:* CI
   stops at Package by design, and install-and-activate and the publish dry run only ever run on this machine.
3. **T-72's real fix lives in repo-tour**, written and not applied: `.autodev/evidence/T-72/repo-tour-gitattributes.patch`
   (an `lstat`, regular files only, `O_NOFOLLOW`, a bounded read). *Recommend:* apply it in a repo-tour run.
   *If never:* this extension's own pre-flight (T-72's branch, once landed) still refuses a hostile `.gitattributes`.
4. **T-40's arrows (taste, no action needed):** at a 288 px side bar the step panel's buttons take one more row.
   Kept; one line to undo. Shots: `.autodev/evidence/T-40/widths/step-actions-before@288.png` and `…-final@288.png`.
5. **Still standing from earlier runs:** T-22's M1 ruling (warn, and name the walked steps); the 15 design-polish
   skill edits (`.autodev/foreman/2026-11-05/design-polish-feedback.md`), now with T-40's notes beside them
   (`.autodev/evidence/T-40/skill-notes.md`); and the foreman's draft T-61 rulings, never handed to a seat
   (`.autodev/foreman/2026-11-10-afk/decisions/t61-rulings-draft.md`). *If never:* the skill stays as it is, and
   T-61's refine starts from the draft.

## 1 · WHAT YOU WILL GET WRONG IF YOU TRUST THIS REPO

1. **"`main` = `origin/main`."** False: local `main` is **6 commits ahead**: T-51's branch and its merge `3c858cb`, then this RESUME's own commit.
   It was reviewed (blind, SHIP AFTER FIXES, fixed), and the foreman re-derived its head `619adf5` (1795 unit); the
   merge tree is byte-identical to `619adf5`. Not pushed only because the stop came first. **First act of the next
   run:** `push-scan.sh`, then push `main` (GA-16 Q13 covers it), then T-51's `verify` (host and screen not run).
2. **"CI is green" / "the full suite passed".** CI on GitHub was **red on every push from 2026-09-08 to tonight**:
   one unit test leaned on git's own `index.lock` advice, which git 2.54+ stopped printing (this machine has 2.43).
   Every later CI step had not run for two months. T-82 fixed it. The first run after (42955173462): unit 1789, host
   85, screen 27 of 28 on GitHub. The one red is **T-83** (T-42's "verdict fully in view", on the runner's 322 px
   panel, VS Code **1.145.3**). After T-83, Package will exit 2 until the secret above exists. **Read `gh run list`
   after every push**; a local green is not a GitHub green.
3. **"`npm install` in a seat's tree is fine."** Each tree's `node_modules` is a link to the main checkout's; an
   install there re-extracts all 423 shared packages under the other seats. T-40 added `@vscode/codicons` with a
   lock-only install, `npm pack`, an integrity check and one moved directory (`.autodev/evidence/T-40/npm/README.md`).
4. **"The unit suite runs anywhere."** It needs `../repo-tour` beside the tree, and a `TMPDIR` outside any folder
   whose parents hold a `node_modules`: inside one, 14 core-root and off-thread tests fail falsely.
5. **"Test runs fill `/tmp`"** (the Nov 8 RESUME). No longer: T-81 gives each run a private temp folder, and CI
   checks it. But T-81's own unwritable-fixture tests, when mutated, leave chmod-0 folders under a seat's scratch:
   `chmod -R u+rwx <exact path>` before the `rm`.
6. **"T-22's replan is proved against a real model."** Not yet. Live run 1 (4 calls, $0.17 estimated, on the
   owner's subscription) found that the code question carried the author's `why`, so the model wrote the author's
   binary search for the learner's "scan one by one". Mode A shared it. Fixed (`c2697a6`). **Live run 2**, on the
   post-review head, against the pass criterion already written in `.autodev/evidence/T-22/live-run.md`, **was not
   made**: the stop came first. It is authorised (`.autodev/foreman/2026-11-10-afk/decisions/ac12-live-divergence.md`).
7. **"The extension never sends a secret."** **T-92 (risk high, filed tonight, not started):** a cloned repository's
   own `.repo-tour/` can aim the dial and the tutor at any file under a root it chooses (a private key, say);
   automated mode copies it, and the tutor sends a diff of it to the model provider. Pre-existing since T-5/T-6.
   Workspace trust stands in front. It was queued first after T-22.
8. **"vscode-test runs 1.145.2."** Here, yes. The real install is in the `VSCode-LLM-Tutorial-bt-t30` worktree's
   `.vscode-test/` (keep that worktree; the others link to it). GitHub resolves `stable` to 1.145.3 now.

## 2 · HALF-DONE, UNVERIFIED, OR DELIBERATELY PARKED

| what | state at the stop | next / trigger |
|---|---|---|
| **T-51** Previous/Next at the plan's ends | merged `3c858cb`, **unpushed**; `verify` partial (typecheck, lint, unit 1795), host and screen not run | push first; then `verify` |
| **T-22** the replan | `feature/T-22-the-replan` @ `a39228a`, clean, stage `auto-review`. Two blind reviews done and fixed; the blind re-review of the fixes was **stopped mid-run** (any partial report is incomplete); N3 (one tutor sentence, AC7) not made; live run 2 not made | handoff `.autodev/handoffs/T-22.md`: re-run the re-review, N3, live run 2, labels, merge `main`, GO |
| **T-71** a failed build's retry | `feature/T-71-retry-after-a-failed-build` @ `9c672f9`, clean, at its merge gate; its verify is green (unit 1816, screen 30, host 85). The focused re-review found R1 (Medium: the reload prompt could Resume or Discard a build another window is running); R1, R2, R4, R5 fixed; **the re-check of those fixes was stopped** | re-check the fixes, then the GO. Handoff `.autodev/handoffs/T-71.md` |
| **T-70** Cancel stops the model calls | `feature/T-70-cancel-stops-the-model-calls` @ `1f52872`, clean, `auto-review`; verify cut off at host (unit 1795, screen 29) | finish verify; handoff `.autodev/handoffs/T-70.md` |
| **T-72** hostile `.gitattributes` | `feature/T-72-hostile-gitattributes` @ `c8b147e`, `auto-review`; one uncommitted change (F5's URL words, not red-checked) saved as a patch in `.autodev/evidence/T-72/` | handoff `.autodev/handoffs/T-72.md` |
| **T-83** the verdict on a short panel (CI's last red) | `feature/T-83-check-verdict` @ `3c858cb`, no commits, `refine`; its diagnostic test saved at `.autodev/evidence/T-83/t83-diag.test.ts`, not yet run in its final form | handoff `.autodev/handoffs/T-83.md` |
| **T-92** (risk high), then T-23, T-14 | not started | T-92 first, after T-22 |
| T-50, T-73, T-110, T-111, T-100, T-90, T-91, T-93, T-94 | filed, named by a go-ahead, not started | by what a learner meets first |
| T-18, T-20, T-61, T-60 | not started | T-61 before T-20 ships Mode A |

**Killed rather than finished** (each a stop, not a failure): T-22's blind re-review of `a39228a`'s fixes; T-71's
focused re-check of its R1 fixes; T-70's verify at the host label; bt-t40's T-83 diagnostic. No gate was running.

## 3 · AUTHORITY

- **GA-17** (the owner's words, 2026-11-10: "do what you can to improve them"; A-20261110-1738-7905) named T-22,
  T-14, T-18, T-20, T-23, T-40, T-61, T-50..T-52, T-60, T-70..T-73, T-80, T-81. **GA-18..GA-21** recorded the same
  words for tickets filed tonight (T-82, T-100; T-110, T-111; T-83; T-90..T-94), because the tracker reads a ticket
  list literally. Accept gates were excluded; no secret, account or other repository was touched.
- **The run ended on the owner's stop. A new run starts only on the owner's word** (A-20261110-2113-9d99).
- Push: `main` only, after each reviewed landing, `push-scan.sh` first (GA-16 Q13). Branches stay local.

## 4 · THE INSTRUMENTS, AND WHAT EACH ONE REFUSES

All in `.autodev/foreman/2026-11-10-afk/` (local, untracked: `.autodev/` never enters this public repo).

| tool | refuses / does |
|---|---|
| `foreman.conf` | a copy of `.autodev/foreman/foreman.conf` that also gives each seat `TMPDIR=<one folder per seat>`, so a seat's test leftovers can be deleted by exact path |
| `instruments/rederive.sh <ref> <label>` | the foreman's own check of a merge head: `git archive` copy (tracked files only), `../repo-tour` linked beside it, `TMPDIR` beside it (not inside), build, typecheck, lint, unit with mocha's exit code, temp leftovers counted |
| `instruments/push-scan.sh` | a push whose patches or messages carry a name, an email, a `/home/` path, a token shape, or a ledger path (a fixture's `@example.com` hits; read it, then judge) |
| `instruments/safe-send.sh` | pasting into a seat with a prompt open (a paste's Enter answers it) |
| `instruments/watch-seats.mjs` | one Monitor stream: seat reports, idle, open prompts, meter changes, disk under 10 GB |

**Known gaps:** a merge's tree equal to a re-derived head was accepted as proof without a second run (sound, but
say so); `watch-seats` does not see a seat's subagent stuck waiting ("Waiting for quiet machine window", 44 minutes
on T-40's reviewer): read the pane's agent rows every 20 minutes.

## 5 · THE SHAPE OF THE RUN

- Three seats, `opus` → claude-opus-5-5, `--effort max`, each in a worktree beside this repo with `node_modules`
  linked: `bt-t22` (`…-bt-engine`: T-22), `bt-t81` (`…-bt-ui`: T-81, T-80, T-82, T-71, T-70, T-72),
  `bt-t40` (`…-bt-polish`: T-40, T-52, T-51, T-83). All closed at the stop. From 21:12, nice 19 with idle I/O
  (the owner was playing a game).
- One blind Opus review per ticket inside its seat (two for T-22), plus a focused re-review where a fix was a new
  mechanism. The foreman re-derived every merge head before its GO and pushed after each landing.
- Briefs, rulings, the log and the report input: `.autodev/foreman/2026-11-10-afk/`. The board:
  `node <autodev>/scripts/tracker.mjs --root . status`.

## 6 · STATE, PASTED FROM THE AUDIT

Pasted from `wind-down/reference/wd-audit` at 21:22, worktree paths elided (public repo). `dirty:2` is this file and `kb/CURRENT-WORK.md`, committed right after this paste; `unpushed:5` is T-51 (§1.1), held by the stop; the local-only branches are the owner's Q13 rule.

```

── GATES / LONG RUNS STILL IN FLIGHT ─────────────────────────────────────────
  none running (a bash shell merely WAITING on one does not count)

── UNCOMMITTED / UNPUSHED, PER REPO ─────────────────────────────────────────
  UNTRACKED is where work DIES: a ledger-on-disk is untracked until staged, and a
  commit-count check reports clean over it. On this audit's first real use the repo
  showed unpushed:0 with NINE ticket files untracked. Commit your own, then push.
  tracked-dirty you did NOT write belongs to a peer session: NAME it, never commit it.
  VSCode-LLM-Tutorial            [main] dirty:2   untracked:0   unpushed:5  <-- UNPUSHED

── BRANCHES THAT EXIST ONLY ON THIS DISK (every local branch, not just the checked-out one) ─────────────────────────────────────────
  feature/T-22-the-replan              19 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-51-plan-ends                4 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-70-cancel-stops-the-model-calls    5 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-71-retry-after-a-failed-build    7 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-72-hostile-gitattributes    4 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-8-package                   1 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-83-check-verdict            5 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  main                                  5 commit(s)  ahead of its remote
  NOT SEEN: refs/remotes is this disk's CACHED belief about the remote, as of the last fetch.
  This contacted nothing. A branch deleted on the server still reads as backed up here.
  Stash entries are on no remote and are reachable from no branch, so no count above includes
  them: 0 entry(s), and the stack is shared across worktrees.

── PIN vs MAIN (an organ ahead of its pin is a gap someone will 'fix') ─────────────────────────────────────────

── ATTESTATIONS (bare audit: runs nothing) ─────────────────────────────────────────
  (no repin_guard.py here)

── SEAT HOLDS — every one of these must be GONE before the panes close ─────────────────────────────────────────
  none (good)

── WORKER PANES ─────────────────────────────────────────
  no w-* sessions

── INSTRUMENTS STILL ONLY IN A SCRATCHPAD — these die with the session ─────────────────────────────────────────
  none found (either already persisted, or look harder)

── OPERATOR GATES STILL OPEN ─────────────────────────────────────────
  go-aheads recorded: 21
  grants recorded:    0  (0 is fine if that was decided)
  --> list tickets waiting on a human gate with the tracker, and put the FORM URL in RESUME

── done. Paste this whole block into RESUME, then act on every <-- marker. ──
```

## 7 · THE BOARD

- **Landed tonight:** T-81 (`aa7bc4a`), T-80 (`e113bf6`), T-40 (`9cf14af`), T-52 (`0c4445a`), T-82 (`c5046d5`),
  all pushed; T-51 (`3c858cb`), not pushed.
- **Filed tonight:** T-82, T-83 (foreman); T-90..T-94 (from T-22's reviews); T-100; T-110, T-111.
- **In flight:** T-22, T-70, T-72 at `auto-review`; T-71 at its merge gate; T-83 at `refine`.

## 8 · WHAT THIS RUN LEARNED THAT IS NOT IN A TICKET

A suite that is green here can be red on GitHub for two months while every RESUME reports "full suite green":
read the CI run after every push, at the layer the world sees. And one live model call is worth more than a
hundred scripted ones for a prompt-shaped feature: T-22's first live run found, in four calls, the defect every
scripted test had passed.
