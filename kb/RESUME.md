# RESUME — Build Tutorials · foreman burn run of Wed 2026-11-11, 17:15–19:30 MST

> **Read this file first and read it in order. It is written for someone who was not here.**
> The run ended at 91% of the week, before its 94% wind-down line (A-20261111-1803-4bd7), because what was left
> (T-72's fix, T-22's R3, T-92) could not reach a clean stage boundary before the 93% line stops new stages: starting
> any of it would have left half-built work for the power-off that follows. **Nothing was deleted after 17:31**
> (A-20261111-1731-24c9, the owner away): see "Cleanup for the owner" at the end.

**In one line:** GitHub CI is **green on every step** at `f841827` (run 43140599113), for the first time since
2026-09-05, and it is the first run ever to reach the install check and the publish dry run (nothing was published).
Landed and pushed tonight: T-51 (last night's merge), T-71, T-83, T-70 and T-131. Five tickets closed on the owner's
form answer. T-72 and T-22 are held on their branches, each for a real reason.

---

## 0 · NEEDS THE OWNER (each with a recommendation, and what happens if never answered)

1. **Sign off T-51, T-71, T-83, T-70, T-130 and T-131.** Each is at `uat`, on `main`, with its own tests green on
   GitHub. The owner's Q4 answer covered only the five it named (T-81, T-80, T-40, T-52, T-82: closed tonight).
   *Recommend:* accept on the evidence, as Q4. *If never:* they stay at `uat`; the code is on `main` either way.
2. **The CI secret holds the owner's first name only**, as the Q5 answer said ("your name as the foremen's push checks
   already know it"; no other names in its notes). This machine's own package check searches the git email instead:
   the git name here is the public org name, which the check skips. *Recommend:* leave it. *If never:* CI checks the
   name and this machine checks the email.

Decided for the owner tonight, standing unless overturned: T-22's R3 is one writer per file after a symbol press
(`.autodev/foreman/2026-11-11-burn/decisions/t22-r3-one-writer.md`); T-22's second live model run waits for the next run,
because it must judge the final head and R3 is not built.

## 1 · WHAT YOU WILL GET WRONG IF YOU TRUST THIS REPO

1. **"Green here means green on GitHub."** It didn't, twice tonight. GitHub's runner has **no git identity**, so a
   passing check's commit is refused there, and that refusal's note pushed the verdict out of view (T-83; a learner on
   a fresh machine meets the same path). And the install check's own `xvfb-run` closed its display about a second after
   the `code` launcher returned, so the editor never opened (T-131); every local run had an outer `xvfb-run`, which hid
   it. **Read `gh run list` after every push.** VSCodium's half of the install check is UNPROVEN on GitHub (not on the
   runner), by design.
2. **"vscode-test runs the same VS Code here and on GitHub."** No. Here: 1.145.2, always pinned with `--code-version
   1.145.2` (the config's `stable` now resolves to 1.146.0 and would download). GitHub: 1.146.0 since tonight.
3. **"The repo-tour beside the tree is the one CI tests against."** No: CI checks out repo-tour's GitHub `main`, now
   `e79619b` (pushed 18:35 tonight, carrying repo-tour's T-63). T-63 is this repo's T-72 fix applied there (the owner's
   Q6): repo-tour no longer follows a link out of the tree. It broke T-30's committed-cache test's positive control here;
   fixed in `4a1837e` (inside T-83), checked on both repo-tour heads (T-130), green on GitHub against the new core.
   After any repo-tour landing, re-run this unit suite against its new head the same hour.
4. **"A unit failure under load is a defect."** Load ran 17-43 on 20 threads tonight: T-13's subprocess scan,
   dial-commit's stranded-file test and T-30 AC2's stall bound each failed once under load and passed alone
   (0.3-1.3 s). One quiet re-run before believing a timing failure. T-13's scan sits near mocha's 2 s timeout.
5. **"T-72 only needs its merge."** No: merging it with T-71 needs new code, and a focused blind check found that code
   can delete a live build's marker. See §2.
6. **"T-22 is close to landing."** No: R3 (must-fix) is ruled but not built, R11, R9 and NF3 are open, the re-check of
   tonight's fixes has not run, and AC12's second live run has not been made.
7. **"The run's evidence is in /tmp."** /tmp is wiped at boot. Everything needed is in the main checkout's `.autodev/`
   (untracked by design, on this disk only) or on a branch.

## 2 · HALF-DONE, UNVERIFIED, OR DELIBERATELY PARKED

| what | state at the end | next / trigger |
|---|---|---|
| **T-72** hostile `.gitattributes` | `feature/T-72-hostile-gitattributes` @ `2c09378` (main `75a6c7c` merged in), clean, at its merge gate, **not merged**. Its own work is green (unit 1862, screen 35, host 89; F5 red-checked; 31 mutants killed). The 5-minute check of the T-71 merge resolution (`.autodev/reviews/T-72-merge-check.md`) found `deleteMarker` can remove a live build's marker when the marker on disk predates T-71's ids, and a marker or `plan.json` that appears during the walk is overwritten; and T-30's real-Cancel screen test races T-72's walk (34/35 on the merge tree) | the fix order in `.autodev/handoffs/T-72.md` (walk first, then T-71's live-build check, then delete only a marker that is not running, matched on `id ?? startedAt`; the screen test waits for the read's progress line), one focused check, GO |
| **T-22** the replan | `feature/T-22-the-replan` @ `e77666e`, clean, `auto-review`. Tonight: a fresh blind re-review (2 must-fix, 6 should-fix, 3 notes) and both reviews' fixes over 7 commits, each red first; host 89, screen 34; unit 1971 with 1 failing that was T-30's control before its fix reached main (merge main to clear it) | merge main; build R3 (ruled); a focused blind re-check of tonight's fixes; then AC12 run 2 (authorised; harness proved dry): `.autodev/handoffs/T-22.md` |
| T-51, T-71, T-83, T-70, T-130, T-131 | at `uat`, on `main`, green on GitHub | the owner's accept (§0.1) |
| **T-92** (risk high) | not started | first after T-22: a cloned repository's own `.repo-tour/` can aim the dial and the tutor at a file under a root it chooses |
| T-120..T-123, T-90, T-91, T-93, T-94, T-110, T-111, T-100, T-50, T-73, T-60, T-23, T-14, T-18, T-20, T-61 | filed, named by a go-ahead, not started | by what a learner meets first; T-61 before T-20 ships Mode A (Q9: T-61's draft rulings are its starting defaults) |
| next-run candidates, not filed | T-13's subprocess scan near mocha's 2 s timeout; a learner with no git identity first hears of it at their first passing check (an earlier word on the Start screen would help); T-131's notes (a killed `xvfb-run` may leave a temp folder; the `DISPLAY` test is written twice) | file when next touched |

**Killed rather than finished:** none. Every seat ended at a stage boundary on the foreman's word.

## 3 · AUTHORITY

- **GA-22** (the owner's words, 2026-11-11 about 17:00: "pick up where the foremen left off last night … I need it to
  burn out", A-20261111-1712-5c46, plus form Q5 and Q9) names the work the 2026-11-10 RESUME queued. **GA-23** (form Q4)
  cleared the accept gates of T-81, T-80, T-40, T-52 and T-82 only. **GA-24..GA-26** record the same words for tickets
  filed tonight (T-120..T-122; T-123, T-130; T-131). Every other accept gate stays the owner's.
- The form "Nov 10 Run Questions" (https://claude.ai/artifact/HSV9CM2A5dZsGi5s6KKv9x) was read first-hand from its
  state-data (submitted 2026-11-11 23:43 UTC).
- Push: `main` only, after each reviewed landing, `push-scan.sh` first (GA-16 Q13). Branches stay local.
- One action outside the ledger: `gh secret set BUILD_TUTORIALS_OWNER_NAMES` (Q5), from a 0600 file, never printed;
  the file was removed before the away rule began. Package has passed with it on every GitHub run since.

## 4 · THE INSTRUMENTS

All in `.autodev/foreman/2026-11-11-burn/` (local, untracked): `instruments/rederive.sh` (the foreman's check of a head
in a `git archive` copy; tonight it printed "to delete" paths that were NOT deleted), `push-scan.sh`, `safe-send.sh`
(refuses to paste into a seat with a prompt open), `watch-seats.mjs`; `foreman.conf` (seats under `nice -n 10`,
`TMPDIR=/tmp/fmv-cJ5M7G/<seat>`); `briefs/` (both charters and every message sent); `decisions/`; `log.md`;
`report-input.md`; `foreman-checks/` (every GitHub run's log and every re-derive).

**Known gap:** `seat send` cannot prove delivery of a one-line message (no marker): read the transcript instead.

## 5 · THE SHAPE OF THE RUN

- Two seats, fresh (not resumed: last night's T-22 seat held 864k tokens of context), `opus` → claude-opus-5-5,
  `--effort max`: `bt-ui` (session `f8c837fc-931c-4367-a214-dd7d79ba2cb4`, `VSCode-LLM-Tutorial-bt-ui` plus
  `-bt-polish` for T-83: T-71, T-83, T-70, T-72) and `bt-engine` (`9979c76c-1cc5-4d99-873c-4b375b394bdf`,
  `-bt-engine`: T-22, T-130, T-131). Both closed at the end; either resumes with `claude --resume <id>` in its tree.
- Blind Opus reviews inside each seat, plus a focused check wherever a fix or a merge resolution was a new mechanism.
  The foreman re-derived every head before its GO, pushed after each landing and read each GitHub run.
- The real VS Code 1.145.2 install is in the `VSCode-LLM-Tutorial-bt-t30` worktree's `.vscode-test/`; keep that tree.

## 6 · STATE, PASTED FROM THE AUDIT

Pasted from `wind-down/reference/wd-audit` at 19:31, project paths elided (public repo). `dirty:1` is
`kb/CURRENT-WORK.md` (the tracker's rewrite), committed with this file right after. The pytest in flight is fm-autosql's
(its cwd is the `GIMS-asql-dash` tree), not this run's. The scratchpad listing is fm-guts's session (37 files), trimmed
here; this run's scratchpad holds nothing. The three local-only branches are the owner's Q13 rule (`T-8-package`
predates this run).

```
── GATES / LONG RUNS STILL IN FLIGHT ─────────────────────────────────────────
2486195 .venv/bin/python -m pytest tests/test_g11_paths_stay_in_their_project.py tests/test_g70_camera_run_id_stays_in_its_project.py tests/test_archi
  ^ LET THESE FINISH, or record the SHA + command + 'killed, not failed'.

── UNCOMMITTED / UNPUSHED, PER REPO ─────────────────────────────────────────
  VSCode-LLM-Tutorial            [main] dirty:1   untracked:0   unpushed:0

── BRANCHES THAT EXIST ONLY ON THIS DISK (every local branch, not just the checked-out one) ─────────────────────────────────────────
  feature/T-22-the-replan              28 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-72-hostile-gitattributes    6 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  feature/T-8-package                   1 commit(s)  <-- NO REMOTE COUNTERPART, exists only on this disk
  Stash entries ... 0 entry(s), and the stack is shared across worktrees.

── SEAT HOLDS — every one of these must be GONE before the panes close ─────────────────────────────────────────
  none (good)

── WORKER PANES ─────────────────────────────────────────
  no w-* sessions

── INSTRUMENTS STILL ONLY IN A SCRATCHPAD — these die with the session ─────────────────────────────────────────
  /tmp/claude-1000/<the GUTS project>/<fm-guts's session>/scratchpad   (37 files: fm-guts's, not this run's)

── OPERATOR GATES STILL OPEN ─────────────────────────────────────────
  go-aheads recorded: 26
  grants recorded:    0  (0 is fine if that was decided)
```

## 7 · THE BOARD

- **Landed and pushed tonight:** T-51 (`3c858cb`, last night's merge), T-71 (`c4dded9`), T-83 (`2c61b7b`), T-70
  (`aa41e36`), T-131 (`75a6c7c`, `1125115`, `f841827`). `main` = `origin/main` = `f841827` plus this kb commit.
- **Closed on the owner's Q4:** T-81, T-80, T-40, T-52, T-82.
- **At `uat`:** T-51, T-71, T-83, T-70, T-130, T-131.
- **Filed tonight:** T-120..T-123 (bt-ui), T-130, T-131 (bt-engine).
- **Final main `f841827`:** the full suite once at the end, here: unit 1842, host 89, screen 33 (1.145.2), first runs,
  temp folder unchanged (`.autodev/evidence/main-2026-11-11/verify-f841827.log`); GitHub run 43140599113 green on every
  step.

## 8 · WHAT THIS RUN LEARNED THAT IS NOT IN A TICKET

A push read on GitHub found, in one night, two failures this machine could not show (a runner with no git identity, a
virtual display that outlived nothing), and fixing both turned two months of red into a fully green run. A fix applied
to a sibling repository broke this repository's test within the hour, and two seats then fixed it at once, because the
foreman answered one seat's heads-up and not the other's: answer every heads-up, or route it. And a 5-minute blind look
at a merge resolution, held for on a mechanism with a review history, found a live-marker deletion that every green
suite had passed.

## Cleanup for the owner (nothing below was deleted, by the away rule)

Everything under `/tmp` is wiped at the next boot anyway.

- `/tmp/fmv-cJ5M7G/` (2.0 GB): the seats' temp folders (`bt-ui/` 1.1 GB, `bt-engine/` 480 MB: test temp folders,
  reviewers' scratch, `git archive` copies, editor profiles, T-83's diagnostic in `bt-ui/moved/T-83/`, T-131's wrappers)
  and the foreman's re-derive copies (`fm/`, 430 MB, with its `fm/repo-tour` link).
- In the worktrees, gitignored: `VSCode-LLM-Tutorial-bt-engine/build-tutorials-0.0.1.vsix`, its `vendor/` and
  `.scratch/ac12/dry-ff9d67e.vscode-test.mjs`; `VSCode-LLM-Tutorial-bt-polish/.scratch/vscode-test.pinned.mjs` and an
  empty `test/screen-diag/`.
- Local branches merged into `main` and kept: `feature/T-51-plan-ends`, `-T-70-…`, `-T-71-…`, `-T-83-…`, `-T-130-…`,
  `-T-131-install-logs`.
- In `.autodev/reviews/`: `T-71-recheck-stopped-2026-11-10.md` and `T-22-rereview-partial-2026-11-10.md` (with its
  `-drives/`), last night's stopped partial reviews, moved aside.
