# Conventions — vscode-llm-tutorial

Read before creating anything new (build.md: survey before writing).

- **Ports.** This extension binds nothing: its UI is VS Code webviews, in-process; it consumes
  repo-tour as a library, not its server. If a ticket ever needs a local server, dev server or
  preview, it claims a port in `/home/corgea/Desktop/Coding Projects/PROJECT_PORTS.md` FIRST
  (Evan, 2026-09-05), checks the distinct-and-safe list there, and never uses `7777` (a trap —
  a wrong health-check default in another repo goes false-green if anything answers there).
- **The core is external.** repo-tour is loaded with dynamic `import()` from `node_modules`,
  never bundled; esbuild keeps `repo-tour` (and `vscode`) `external`. Extend `CORE_MODULE_NAMES`
  in `src/core.ts` rather than importing a core module elsewhere. `repo-tour/schema/*` is not in
  its exports map — read schema files by filesystem path from `core.root`.
- **Paths have spaces** (`Coding Projects`): `vscode.Uri` / `pathToFileURL`, never string `file://`.
- **Webviews:** nonce CSP; every inline `<script>` parse-tested with `new Function`; state via
  `getState`/`setState` with the host as the only truth; skin `data-theme` stamped by the host
  before first paint; `System` = the bridge sheet mapping repo-tour's tokens to `--vscode-*`.
- **Tests never spend tokens:** `cachedOnly: true` or an injected `runner`; `npm test` runs
  vscode-test (xvfb when `DISPLAY` is unset). `codium` exists on this machine, `code` does not.
- **Honest controls:** a feature that is not built yet says so where the eye is (repo-tour's
  lesson) — never a silent no-op, never a disabled button with no explanation.
- **Worktrees** are siblings of the repo (`../VSCode-LLM-Tutorial-<ticket>`) so `file:../repo-tour`
  resolves; merge from `main`'s own checkout; remove a worktree only from outside it.
- **Commits:** author `Corgea <blackmapartistry@gmail.com>`; trailers `Co-Authored-By: Claude Fable
  5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Mxgb5pYk1Jb3C1qwp9RLAV`.
  Workers never touch the ledger (`.autodev/events.jsonl`, `tickets/`, `releases/`).
