# RESUME — Build Tutorials · MVP run of Tue 2026-11-17, 13:37–22:20 MST

## NEEDS THE OWNER

Road: proof · Rung: applications · A stranger can now download Build Tutorials v0.1.0 from this repository's GitHub
Releases page, install it, and build and walk a tutorial of a real repository, which gives an application a
working, installable VS Code extension to point to.

1. **Sign off 15 tickets at `uat`**: T-72, T-92, T-91, T-141, T-140, T-120, T-22, T-152, T-171, T-122, T-154, T-121,
   T-61, T-110 (its Start-form half) and T-73. All landed today on `main` and are green on GitHub on every step (the last
   is CI 44242668108 on `45fdfd5`). *Recommend:* accept on the evidence, as the owner did on Nov 11's Q4 and today's
   evening-form Q4. *If never:* they stay at `uat`; the code is on `main` either way.
2. **T-90's product ruling, now with a live data point.** In AC12 run 2 the re-derived `isInRange` destructured
   `[start, end]` pairs while the author's data file holds flat arrays, so the re-planned app would throw on its first
   lookup: D's code question is never shown the file it rewrites. *Recommend:* (a) show the file as it stands, framed so
   the author's code does not argue for the author's road. *If never:* the replan (on `main`, not in v0.1.0) can write
   code that doesn't fit the data it reads; it is labelled as the model's, and T-61 refuses process and eval calls in it.
3. **T-161, optional:** after a symbol press, the taken-over file's own question can't be chosen anywhere (the
   reviewer's cheaper alternative is in the ticket). The foreman's ruling stands for v0.1 until the owner rules.
4. **Optional: the Marketplace and Open VSX.** v0.1.0 is on GitHub Releases only. Publishing to either registry needs
   the owner's own tokens and is the owner's act (T-8's script refuses otherwise).
5. *(Carried from Nov 11, never put to the owner)* The CI secret holds the owner's first name only; this machine's own
   package check searches the git email instead. *Recommend:* leave it.

## 0 · In one paragraph

**Build Tutorials v0.1.0 is public:** https://github.com/BMA-Corgea/VSCode-LLM-Tutorial/releases/tag/v0.1.0, tag
`v0.1.0` at `1656cf9`. Before it was published, all four of the owner's conditions (form "Build Tutorials release",
GA-29) were checked:
- the hostile-repository safety tickets T-72, T-92 and T-91 (plus T-120), and the first-run words of T-141, are on `main`;
- CI is green on every step at the release commit;
- the release's `.vsix` is byte for byte the one CI built (sha256 `6fce9047…7467`);
- a live stranger check from that downloaded file passed: fresh profile; Doctor; a build from
  `github.com/sindresorhus/get-east-asian-width` with 10 of 10 questions answered ($0.36); an automated step; Check my
  work; a tutor answer; a reload; no ticket number on any screen.

After the release, the replan (T-22) and its safety rules (T-61) landed on `main`, with T-171, T-122, T-121, T-110's
Start half, T-73 and two test fixes. **`main` is green on GitHub at `45fdfd5`, and nothing is unpushed.**

## 1 · WHAT YOU WILL GET WRONG IF YOU TRUST THIS REPO

1. **"v0.1.0 has the replan."** It does not. v0.1.0 is `1656cf9`, which has none of T-22, T-61, T-171, T-122, T-121,
   T-110 or T-73. The README on `main` describes the replan and says the release does not have it. **A next release
   carries T-22 only because T-61 is on `main` too, and that rule stands:** see
   `.autodev/foreman/2026-11-17/decisions/t22-lands-after-the-release-commit.md`.
2. **"T-110 is done."** Only its Start-form half landed (`e6964c4`). The step panel's controls are still open (T-110's
   handoff), although the ticket sits at `uat`. File the panel half as its own ticket, or rewind T-110, before
   accepting it.
3. **"T-61's AC9 (a model following an instruction a repository planted) is proven."** It is not. The one live press
   was refused at parse: `lookup.js`'s reply was not one JSON object, probably cut off. Nothing was written or run, and
   the only code question shown the plant was the refused one. AC9 is carried to T-162.
4. **"Unit and host green means safe to land."** Not here. T-122 landed after unit and host only, and turned `main` red
   on GitHub: T-15 AC6 read the bookmark one await too early, and T-154 fixed it. **Run every label the change lives in
   (unit, `host` AND `screen`) on the exact head,** in a `git archive` copy. A seat's own tree carries compiled tests of
   other branches in `dist/`.
5. **"A red Test step on GitHub is a regression."** Twice today it was not: a test helper's race (T-152) and a timing
   assumption (T-154), both test-only fixes now on `main`. Read the failing test before reverting anything.
6. **"The shared machine lock is first come, first served."** Only if every waiter backs off. Fast polls starved another
   foreman for 45 minutes, so `bigstep.sh` now waits 150 s after any release. An EMPTY lock folder (no owner or pid)
   blocks every big step on the machine until someone renames it aside.
7. **"repo-tour's main is e79619b"** (Nov 11's RESUME). It is `b0006b7` (T-59, T-67), pushed 2026-11-12 02:03Z; every
   CI run since has used it.

## 2 · HALF-DONE, UNVERIFIED, OR DELIBERATELY PARKED

| what | state | trigger / owner |
|---|---|---|
| T-23 (the replan never touches the walked prefix or the disk) | `queue`, R9 ruled (A) | first for the engine seat next run; its handoff gives the steps |
| T-110's step-panel half | not built | file it, or rewind T-110, before the owner accepts T-110 |
| T-162 (T-61's open notes, and AC9) | filed, `intake` | AC9 needs another live press, kept raw: the foreman's call on subscription usage |
| T-50, T-123 (MVP items 10 and 13) | `intake`, not started | both touch the step panel, so not alongside T-61 and T-73 |
| T-150 (a planted marker's Resume builds a repository the folder names; medium), T-151, T-153, T-160, T-161, T-170 | filed today, below the MVP line | — |
| T-14, T-18, T-20 (Mode A), T-90 (needs the ruling above), T-93, T-94, T-60, T-100, T-111 | `intake` | below the MVP line |

**Killed rather than finished:** none of the run's tickets. One foreman re-derive was killed by Claude Code for low
memory at 17:33, and not restarted, per the harness. T-120 landed on its seat's checks plus GitHub CI instead, and that
is said in its record.

## 3 · AUTHORITY

- GA-27 (today's words, 13 tickets, scope_confirmed false), GA-28 (T-140, T-141), **GA-29 (the owner's form: publish
  v0.1.0 once four checks hold, now spent)**, **GA-30 (the owner's evening form: the accepts of T-51, T-71, T-83, T-70,
  T-130 and T-131, cleared today)**, GA-31 (T-171), GA-32 (T-152), GA-33 (T-154).
- Push: `main` only, after a reviewed landing, `push-scan.sh` first (GA-16 Q13). Branches stay local.
- Forms: "Build Tutorials release" https://claude.ai/artifact/RwcrmtvjZkEYBr9GRWpJDe (answered A, spent). The evening
  form https://claude.ai/artifact/FGZRhDkBsUDmiU9yvSV2Qx (its Q4 is answered and spent).

## 4 · THE INSTRUMENTS

In `.autodev/foreman/2026-11-17/instruments/` on the main checkout (untracked, local): `bigstep.sh` (one big step
machine-wide, a memory floor, nice 19 and idle I/O, a 150 s back-off after any release), `clear.py` (removes scratch
by exact path, only what was born today), `rederive.sh`, `push-scan.sh`, `safe-send.sh`, `watch-seats.mjs` (also
flags a question asked without a marker; persists its offsets), `meter-read.sh` and `meter-loop.sh`. **Before
reusing them, edit `clear.py`'s `ROOTS` and `TODAY_BOOT`, and the `/tmp/fmv-…` and run-folder paths.** What each one
refuses, and why, is in the appendix of the run folder's `RESUME.md`. Seat bt-ui's own instruments are in
`.autodev/foreman/2026-11-17/seat-bt-ui-instruments/`.

## 5 · THE SHAPE OF THE RUN

- Three seats on `opus` (claude-opus-5-5 by their transcripts), effort max, nice 19 from 17:36. All closed. Each
  resumes with `claude --resume <id>` in its tree:
  - **bt-ui** `2167d1aa-2f31-4b37-a524-b2d3389c85a0`, in `VSCode-LLM-Tutorial-bt-ui`: T-72, T-91, T-141, T-120, T-152,
    T-122, T-154, T-73.
  - **bt-engine** `8f08d029-56e8-4c5b-8a88-b3a2f2eceb86`, in `VSCode-LLM-Tutorial-bt-engine`: T-22, T-61, then T-23 next.
  - **bt-guard** `2bf92f33-f030-4ce8-85dc-12c3a950e07a`, in `VSCode-LLM-Tutorial-bt-polish`: T-92, T-140 and the
    release, T-171, T-121, T-110's Start half.
- The release worktree `VSCode-LLM-Tutorial-bt-release` was removed at the wind-down; its branch `feature/T-140-release`
  is merged and kept. Re-cutting a release: `node scripts/release-draft.mjs <main sha>` prints the draft command;
  `--verify-draft` checks the draft's asset byte for byte.
- Run folder: `.autodev/foreman/2026-11-17/`, with `MVP.md`, `log.md` (every decision with its time), `decisions/`,
  `briefs/` (every message sent), `foreman-checks/` (every re-derive and CI log) and `report-input.md`.
- **Real VS Code 1.145.2 lives in `VSCode-LLM-Tutorial-bt-t30/.vscode-test/`**; the other trees link to it. Keep that tree.

## 6 · STATE, PASTED FROM THE AUDIT

Run at 22:18 MST, after every seat was closed and the disk step was done. `dirty:1` is `kb/CURRENT-WORK.md` (the
tracker's rewrite), committed with this file. `T-61-before-rebase-2026-11-17` is a local ref kept on purpose, so the
old SHAs in T-61's evidence still resolve. The scratchpad instruments listed belong to another foreman's session (GUTS),
not this run's.

```
── GATES / LONG RUNS STILL IN FLIGHT ──
  none running (a bash shell merely WAITING on one does not count)
── UNCOMMITTED / UNPUSHED, PER REPO ──
  VSCode-LLM-Tutorial            [main] dirty:1   untracked:0   unpushed:0
── BRANCHES THAT EXIST ONLY ON THIS DISK ──
  T-61-before-rebase-2026-11-17         8 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-8-package                   1 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  Stash entries ... 0 entry(s)
── SEAT HOLDS ──
  none (good)
── WORKER PANES ──
  no w-* sessions
── INSTRUMENTS STILL ONLY IN A SCRATCHPAD ──
  (another foreman's session: GUTS)
── OPERATOR GATES STILL OPEN ──
  go-aheads recorded: 33
  grants recorded:    0  (0 is fine if that was decided)
```

## 7 · THE BOARD

- **Published:** v0.1.0 at `1656cf9`.
- **Landed and pushed today, in order:** T-72 `954d7a0`, T-92 `bfda586`, T-91 `ff48dff`, T-141 `b00d38d`, T-140
  `728c584`, T-120 `1656cf9`, T-152 `eb830c3`, T-22 `e35ba56`, T-171 `59aeae9`, T-122 `2dfdfaa`, T-154 `34ba7f5`, T-121
  `f8c185c`, T-110 (Start half) `e6964c4`, T-61 `a491fb0`, T-73 `45fdfd5`. All 15 are at `uat`.
- **Closed today** (accepted on the owner's evening-form Q4, GA-30): T-51, T-71, T-83, T-70, T-130, T-131.
- **Filed today:** T-140, T-141, T-150, T-151, T-152, T-153, T-154, T-160, T-161, T-162, T-170, T-171.
- **Open:** T-23 (`queue`); 18 at `intake`, listed in §2.

## 8 · WHAT THIS RUN LEARNED

The release was cut twice. A review of a later ticket found a one-click link a planted marker could still draw, at the
very commit the first draft pointed at: "every gate green" and "the MVP's promise kept" are different claims, and only
re-reading the promise catches the gap. And a test label skipped because "nothing it draws changed" turned main red
within the hour, so run every label a change lives in.

## Cleanup for the owner (nothing below was deleted)

*Carried from 2026-11-11, untouched:*
- Local branches merged into `main` and kept: `feature/T-51-plan-ends`, `-T-70-…`, `-T-71-…`, `-T-83-…`, `-T-130-…`,
  `-T-131-install-logs`.
- In `.autodev/reviews/`: `T-71-recheck-stopped-2026-11-10.md` and `T-22-rereview-partial-2026-11-10.md` (with its
  `-drives/`).
- In the worktrees, gitignored: `VSCode-LLM-Tutorial-bt-engine/build-tutorials-0.0.1.vsix`, its `vendor/` and
  `.scratch/` folders from Nov 10-11; `VSCode-LLM-Tutorial-bt-polish/.scratch/vscode-test.pinned.mjs`, its `vendor/`
  and an empty `test/screen-diag/`.

*Added today:*
- `VSCode-LLM-Tutorial-bt-ui/.vscode-test/vscode-linux-x64-1.145.0`: a real 178 MB VS Code install from Nov 5. It
  slows T-13's scan in that tree (T-151), and bt-polish links to it.
- Local branches merged into `main` today and kept: `feature/T-72-…`, `-T-92-…`, `-T-91-…`, `-T-141-…`, `-T-140-release`,
  `-T-120-…`, `-T-152-…`, `-T-22-the-replan`, `-T-171-…`, `-T-122-…`, `-T-154-…`, `-T-121-…`, `-T-110-…`, `-T-61-…`,
  `-T-73-…`; and the local ref `T-61-before-rebase-2026-11-17`.
- In the coordinator's run folder: this run's `bigstep.lock.released-*-fm-vscode-llm-tutorial-*` lock history.
