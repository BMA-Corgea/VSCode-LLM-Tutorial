# RESUME — Build Tutorials · overnight foreman run of Thu 2026-11-05, 00:30–02:35 MST

> **Read this file first and read it in order. It is written for someone who was not here.**
> Sections 1 and 2 save you from being wrong; the board is further down because the tracker
> regenerates it in one command. The run ended on the week's usage meter (wind-down at 96%), not
> because the work ran out.

**In one line:** T-15 and T-16 landed and are on GitHub's `main` (`89a6546`); T-9 and T-10 were
routed into seven tickets; T-17 (the derivation engine) and T-21 (choosing the road not taken)
are part-built on local branches with true handoffs. Nothing was published to any marketplace.

---

## 1 · WHAT YOU WILL GET WRONG IF YOU TRUST THIS REPO

1. **"T-15 shipped in September."** It merged then (`642eff4`) but its own goal was unmet: re-driven
   on `main` on 2026-11-05, a second press with nothing edited changed nothing visible, a
   double-click started two builds, and closing the start tab mid-build threw "Webview is
   disposed" (and, on success, never opened the walk). Finished to AC1–AC8 and pushed at `a1c6400`.
   Record: `.autodev/evidence/T-15/refine.md`, `uat.md`.
2. **"vscode-test runs under xvfb by itself."** Only when `DISPLAY` is unset:
   `scripts/run-tests.mjs` runs vscode-test DIRECTLY on any set `DISPLAY`, and the default tmux
   server exports the desktop's (`:1` here). Start seats with `env -u DISPLAY` (this run's
   `foreman.conf` does).
3. **"vscode-test runs VS Code 1.136.1."** `.vscode-test.mjs` pins no version; it resolves "stable"
   over the network on every run (1.145.0 here, a 361 MB download into each tree's `.vscode-test/`
   unless you symlink one in).
4. **"The screen tests are solid."** T-15's start-screen test *"a folder picker left open across
   the END of a build…"* times out under machine load (6–8+): it failed during T-16's run and twice
   in T-21's review, and passed on every quiet run. A failed step-screen test can also drag a T-15
   screen test down with it. Not yet ticketed — see section 2.
5. **"T-22 can start once T-17 and T-21 are on main."** The tracker's `--after` clears only when a
   blocker has passed accept, release AND monitor.
6. **T-14's `risk: low`** is stale and immutable: undo touches plan versions on the learner's disk.
   Override its review depth by hand, in its own evidence.
7. **"The learner's choice is `options[].chosen`."** It is `step.decision.chosen` (T-1 §4.2). On
   T-21's branch it is stored in `progress.json` and overlaid onto the plan the session hands out;
   `plan.json` is never rewritten by the walk (the plan write is T-22's, versioned per T-17's plan).

## 2 · HALF-DONE, UNVERIFIED, OR DELIBERATELY PARKED

| what | state | trigger / owner |
|---|---|---|
| **T-17** the derivation engine | `build`; branch `feature/T-17-derivation-engine` @ `8b53e18`, 27 commits, **local only**; 1397 unit + 77 vscode-test; steps 0a–6b(part) done; determinism (AC4) proven | Next session: `replanPlan` + changed answers (plan step 6b-2), AC3 close-out, two blind reviews, merge GO. Handoff `.autodev/handoffs/T-17.md` |
| **T-21** choosing the road not taken | `auto-review`; branch `feature/T-21-choosing-the-road-not-taken` @ `1206123`, **local only**; 1291 unit + 75 host + 11 screen; built, not merged. Security review done (1 Medium S1, 1 Low, 2 Info). Code review finished at 02:28: **not ready to merge — three Mediums**: (1) a press from a page showing a previous step is written to the CURRENT step, silently (repo-tour gives every step the same option ids — same as S1; the message must carry the step id); (2) AC7's prose retirement not done in its three places; (3) AC5's refusal is drawn ~900 px below the button and a second refusal changes nothing (T-15's shape). Six Lows ride with the fixes | **Not mergeable until the security review's Medium is fixed:** a page still showing a previous step can record a choice on the current step (repo-tour gives every step the same option ids). Handoff `.autodev/handoffs/T-21.md`; reviews `.autodev/reviews/T-21-*` |
| T-16 deliberate leftovers | F-07 bridges fonts, not text size (by decision); welcome-view flash + stale tab stop | **T-43** |
| T-16's last fix commit `87be0af` | merged after tests + mutations, **no second blind review** (no new stages after 94%) | Next review that touches `src/walk/step-view.ts` covers it |
| T-16 line 8: the real editor | everything measured headless; whether VS Code keeps the panel's scroll after a press is **unverified where it matters** | **T-42** |
| Screen-harness flakes under load | see §1.4 | The moment a screen test fails twice on one tree: ticket it |
| `feature/T-8-package` | September branch, 1 commit, local only (merged content is on main via `424fcec`) | none — informational |

No gate was killed. Nothing was stopped mid-run except T-17's build stage (stopped at a commit by
design, recorded in its handoff).

## 3 · WAITING ON THE OWNER

- **T-44 — a taste call:** the option the author chose is filled with the editor's search-match
  orange; in both high-contrast themes it is all but unmarked. (A) switch to the selection colour
  + a high-contrast edge (the visual reviewer's pick), (B) keep the orange and add only the
  high-contrast edge, (C) leave it. **If never answered:** nothing breaks; the high-contrast gap
  stays as T-44 describes. Lands after T-21 (same markup).
- **The design-polish skill's first run on a VS Code extension** produced **15 numbered proposed
  edits** (the biggest: compare consecutive states, so a press that changes nothing is caught):
  `.autodev/foreman/2026-11-05/design-polish-feedback.md` (local). Accept or reject them; the skill
  at `~/.claude/skills/design-polish/` was read, not edited.
- **Recommended, not required:** open *Build Tutorials: Start* and press *Build the plan* once with
  a problem on the form. T-15 was accepted on your behalf after a real-editor drive under xvfb,
  but it was your own press that found it.
- **Branches only on this disk:** T-17 and T-21's (above). Q4 B covers pushing `main` only, so
  they were not pushed to the public repo.
- **Authority used tonight** (local ledger, `.autodev/events.jsonl`): GA-11 (his words + form Q2–Q4;
  T-9, T-10, T-14, T-16), GA-12 (T-15 reconcile), GA-13 (T-17..T-23), GA-14 (finishing T-15). The
  tickets filed tonight beyond those — **T-30, T-40..T-44 — have no go-ahead naming them**; the next
  run needs its own.

## 4 · THE INSTRUMENTS, AND WHAT EACH ONE REFUSES

| tool | path | refuses |
|---|---|---|
| foreman instruments (`seat`, `send`, `fm`, `wait-any`, `lastmsg`) | `app-template/process/foreman/` (shared and live; not copied) | its README |
| `foreman.conf` | `.autodev/foreman/foreman.conf` (local) | a private tmux server; `SEAT_COMMAND` starts every seat with `DISPLAY`/`WAYLAND_DISPLAY` unset (nothing reaches the desktop) and pages held (`AUTODEV_NOTIFY_BIN=foreman-holds-all-pages`) |
| `push-scan.sh` | `.autodev/foreman/2026-11-05/instruments/push-scan.sh` (local) | a push whose messages or patches carry the owner's first name, an email (other than the noreply attribution), a `/home/` path, a token shape, or a `node_modules` / `.vscode-test/` / ledger path |

**Known gaps:** `seat watch` fired early twice (no new marker) and once timed out on a seat that
was mid-suite — read the transcript before acting on any fire. `wait-any`'s 600-character report
threshold missed a short `FOREMAN:` id report for ten minutes; watch for the markers instead.

## 5 · THE SHAPE OF THE RUN, so you can recreate it

- Three seats on the default tmux server, `opus` → **claude-opus-5-5**, `--effort max`, each in its
  own worktree beside this repo with `node_modules` symlinked from the main checkout:
  `bt-engine` (T-9/T-10 routing, then T-17), `bt-ui` (T-15, then T-21), `bt-polish` (T-16, opened
  on "design-polish ready"). Worktrees are left in place for the branches they hold.
- Reviews: two blind subagent reviews per build (code + security), plus a blind visual check for
  T-16; the foreman re-ran the suites on `main` before every push.
- Briefs, rulings, decisions: `.autodev/foreman/2026-11-05/` (local). The board:
  `node <autodev>/scripts/tracker.mjs --root . status`.

## 6 · STATE, PASTED FROM THE AUDIT

Pasted from `wind-down/reference/wd-audit` at 02:26 MST, paths elided (public repo). The **gates / long runs in flight** it lists are OTHER foremen's pytest runs on this machine (autoSQL, state-map/GUTS), none of this run's. `dirty:1 untracked:1` is this file and `kb/CURRENT-WORK.md`, committed right after this paste.

```

── GATES / LONG RUNS STILL IN FLIGHT ─────────────────────────────────────────
276946 timeout 1800 systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 demo/.venv/bin/python -m pytest demo/tests -ra -p no:cacheprovide
276947 <tmp> -m pytest demo/tests -ra -p no:cacheprovider
285206 <path> Projects/state-map-record/.venv/bin/python -m pytest -q -p no:cacheprovider tests/
  ^ LET THESE FINISH, or record the SHA + command + 'killed, not failed'.

── UNCOMMITTED / UNPUSHED, PER REPO ─────────────────────────────────────────
  UNTRACKED is where work DIES: a ledger-on-disk is untracked until staged, and a
  commit-count check reports clean over it. On this audit's first real use the repo
  showed unpushed:0 with NINE ticket files untracked. Commit your own, then push.
  tracked-dirty you did NOT write belongs to a peer session: NAME it, never commit it.
  VSCode-LLM-Tutorial            [main] dirty:1   untracked:1   unpushed:0

── BRANCHES THAT EXIST ONLY ON THIS DISK (every local branch, not just the checked-out one) ─────────────────────────────────────────
  feature/T-17-derivation-engine       27 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-21-choosing-the-road-not-taken    6 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-8-package                   1 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
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
  go-aheads recorded: 14
  grants recorded:    0  (0 is fine if that was decided)
  --> list tickets waiting on a human gate with the tracker, and put the FORM URL in RESUME

── done. Paste this whole block into RESUME, then act on every <-- marker. ──
```

## 7 · THE BOARD

- **Complete tonight:** T-9, T-10 (routed), T-15 (pushed `a1c6400`), T-16 (pushed `89a6546`; all 12
  stages passed, every gate cleared).
- **Filed tonight:** T-16 (polish), T-17..T-23 (T-9's and T-10's epics), T-30 (the build freezes the
  extension host on a large repo), T-40..T-44 (T-16's splits).
- **In flight:** T-17 `build`, T-21 `auto-review`. **Waiting:** T-14, T-18, T-19, T-20, T-22, T-23,
  T-30, T-40..T-44 at `intake`.
- **Pushed to `origin/main`:** `c9de1b4` (01:09), `a1c6400` (01:54), `89a6546` (02:24). Final
  full suite on `89a6546` by the foreman: typecheck, lint, build clean; **1303 unit; 75 host + 10
  screen vscode-test, exit 0**, headless.

## 8 · WHAT THIS RUN LEARNED THAT IS NOT IN A TICKET

A press that changes nothing on screen is invisible to every review that inspects one frame, and
this repo has now paid for it three times (T-15 twice, T-16's below-the-fold verdict). Compare
consecutive states, at the layer the person sees. And a reconcile is not paperwork: re-deriving
a "shipped" ticket on main is how T-15 turned out not to be done.
