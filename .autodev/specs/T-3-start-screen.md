# T-3 — The start screen, shared skins, and building the plan with resume

**Type:** feature · **Shop:** vscode-llm-tutorial · **After:** T-2 (complete) + repo-tour T-11/T-12/T-13 (cross-shop) · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §5.2, §5.7, §4) · **Risk:** medium
**Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-1).

## The ticket's spec (captured, not re-composed)

WHY: the front door (.autodev/specs/T-1-build-tutorials-v1.md §5.2) and the skin contract (.autodev/specs/T-1-build-tutorials-v1.md §5.7). DEPENDS ON repo-tour T-11 (package exports + injectable asset roots), T-12 (BuildPlan) and T-13 (alternatives) — cross-shop, so not expressible with --after; do not start build until those three are merged.

ACs:
1. A webview editor tab with: idea textbox; 'Just recreate the repo as it stands' checkbox; reference repo field (local path or GitHub URL) required iff the checkbox is ticked; 'Build it in' folder picker requiring an empty or new folder; the three-position dial. Check: form validation tests via the webview's message protocol.
2. Typing an idea without ticking recreate shows, in the form itself, 'Idea-first builds arrive with T-9 — tick recreate to build from a repo' — no silent decline (repo-tour lesson T-3). Check: DOM assertion.
3. A GitHub URL is cloned into globalStorageUri/refs/<owner>-<name>; a local path is used in place; a repo whose files are outside TS/JS/TSX/Python is refused with the reason shown in the form. Check: tests with a fixture repo and a Go-only fixture.
4. Building the plan calls the core's digest + buildPlan + interpret with a progress notification, writes a write-ahead marker <target>/.repo-tour/build/building.json kept current, and resumes from it after a window reload. Check: kill vscode-test mid-build; on restart the marker is picked up and the plan completes.
5. plan.json is written to <target>/.repo-tour/build/ and validates against the core's schema; cost is shown on completion (metered or 'this provider does not report usage'). Check: schema validation test.
6. Skins: every webview inlines the core's baseCss() + alternateCss() plus a bridge sheet mapping base tokens to --vscode-* variables under :root:not([data-theme]) so System follows the editor theme; the picker lists SKINS; the choice is stamped into the HTML by the host before first paint and persisted in globalState. Check: a fixture skin dropped into repo-tour's assets/skins/ + one row appears in the webview HTML with no extension change.
7. Every inlined client script is parsed by new Function in a test (repo-tour lesson: client script in template literals). Check: the parse test.

Out of scope
- Walking the plan — T-4
- Mode A / idea-first — T-9
- A network-served skin — deferred: who=agent:pm why=webviews inline CSS exactly as repo-tour's pages do

## Refinement notes (2026-09-04, against T-2's merged code and repo-tour's T-12/T-13 API)

- **The core's API this consumes** (repo-tour `main` after T-13): `repo-tour/build` → `buildPlan(digest, { root, witness })`, `interpretPlan(plan, digest, { root, provider, model, cacheDir, cachedOnly, onProgress })`; `repo-tour/digest` → `digest(root, { write: true })`; `repo-tour/skins` → `SKINS`, `DEFAULT_SKIN`, `baseCss()`, `alternateCss()`; the schema at `repo-tour/schema/build-plan.schema.json`.
- **Skin choice lives in `globalState`, not settings** — the same "per person, not per project" choice repo-tour made with localStorage. System = follow the editor theme, via a bridge sheet under `:root:not([data-theme])`.
- **Validation messages appear under the field**, never as a disabled button (repo-tour lesson: a control that silently declines is broken). The idea-only case says exactly where Mode A is (T-9).
- **The build runs in the extension host with a write-ahead marker** (`<target>/.repo-tour/build/building.json`, repo-tour's T-4 lesson); tests use `cachedOnly` so the suite never spends tokens; the one live run is the orchestrator's acceptance on sql-gauntlet.
- A GitHub URL is cloned in full (the witness needs history) into the extension's global storage.
