# T-2 — Extension skeleton, core attach, and a doctor that proves the host can run it

**Type:** feature · **Shop:** vscode-llm-tutorial · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §3, §5, §10) · **Risk:** low
**Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (verbatim on the ledger).

## The ticket's spec (captured, not re-composed)

WHY: everything else stands on the extension host being able to load repo-tour's core (ESM, tree-sitter WASM) and find the claude CLI. Prove that first (.autodev/specs/T-1-build-tutorials-v1.md §3, §10).

ACs:
1. A VS Code extension manifest (package.json) with id build-tutorials, activation on command, commands buildTutorials.start and buildTutorials.doctor, and a setting buildTutorials.repoTourPath (default: the sibling ../repo-tour checkout). Check: the extension activates in vscode-test.
2. The extension's own code is bundled with esbuild to CJS; repo-tour is a file: dependency loaded UNBUNDLED via dynamic import() so its import.meta.url asset lookups keep working. Check: an activation test imports the core and calls baseCss().
3. doctor reports, in an output channel, in plain words: core found at <path> + version; each public module resolved; tree-sitter initialised in the host and the four grammars loaded; claude CLI found via the core's resolveBin (or not, with the reason). Check: run in vscode-test with the core present and with repoTourPath pointing nowhere.
4. CI (GitHub Actions) runs typecheck, lint, tests and vsce package on push. Check: a green run on main.
5. AGPL-3.0 headers/NOTICE in the extension and a Source link in its README, matching repo-tour's practice. Check: files present.

Out of scope
- Any user-facing screen — T-3
- Publishing — T-8

## Addendum — the boot-up scripts (Evan, 2026-09-04)

> *"…until these are created and there's a start.sh (like in repo-tour) that I can use to boot it up"*

repo-tour's shape: `start.sh` is the double-clickable wrapper over a control script
(`./repo-tour serve|tour|digest|open|tours|doctor|build|test`) and pauses at the end when
attached to a terminal. The analog for an extension is the **Extension Development Host**.

6. A control script `./build-tutorials` with verbs `dev` (build, then launch the editor with
   the extension loaded on a folder: `dev [folder]`, default a fresh scratch folder under
   `.scratch/`), `build`, `test`, `doctor` (runs the doctor headlessly and prints its report),
   `package` (a `.vsix`). It prefers `codium`, falls back to `code`, and says plainly which it
   found — this machine has `codium` (snap) and no `code`. Check: `./build-tutorials doctor`
   prints the report; `./build-tutorials dev` opens the host.
7. `start.sh` wraps `./build-tutorials dev "$@"` with repo-tour's pause-when-interactive
   behaviour (`BUILD_TUTORIALS_NO_PAUSE=1` disables). Check: `./start.sh` from a file manager
   leaves the window open.
8. Headless tests: `npm test` runs under `xvfb-run -a` when `DISPLAY` is unset (CI) and
   directly otherwise. Check: green locally and in CI.
