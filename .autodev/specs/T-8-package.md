# T-8 — Package and publish — .vsix, Marketplace and Open VSX

**Type:** feature · **Shop:** vscode-llm-tutorial · **After:** T-5, T-6, T-7 · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §6 decision 7, §11) · **Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-1).

## The ticket's spec (captured, not re-composed)

WHY: .autodev/specs/T-1-build-tutorials-v1.md §6 decision 7 — publish to both. Evan named VSCodium, which cannot use the MS Marketplace; Open VSX is its store.

ACs:
1. vsce package produces a .vsix that installs into VS Code and VSCodium and activates. Check: CI artifact; manual install on both.
2. The .vsix carries repo-tour's core and its two runtime deps unbundled under node_modules with the WASM grammars present; the doctor passes from the installed extension. Check: install from .vsix, run doctor.
3. Publish steps for the MS Marketplace (vsce publish) and Open VSX (ovsx publish) are scripted and dry-run in CI with tokens absent (the script says what it would do). Check: CI log.
4. README: what it is, the dial, the first target walkthrough, the AGPL notice and Source link. Check: file review.

Out of scope
- Publishing repo-tour to npm — deferred: who=human:evan why=not v1; the core is vendored into the .vsix from the file: link
- Marketplace listing assets beyond an icon — deferred: who=agent:pm why=a listing is polish after the first real user

## Refinement notes (2026-09-05)

- **The `.vsix` must carry the core.** `vsce package --no-dependencies` (T-2) ships nothing under
  `node_modules`; the `file:../repo-tour` link cannot be represented in a `.vsix` at all. The packaging step
  therefore **vendors** repo-tour: `npm pack` the sibling checkout (its `prepare` builds `dist/`; `files`
  covers `dist`, `assets`, `schema`) into `vendor/repo-tour-<version>.tgz`, installs it into a staging copy of
  the extension (`npm install --omit=dev ./vendor/…`), and packages from there so `node_modules/repo-tour` +
  `web-tree-sitter` + `tree-sitter-wasms` (with the `.wasm` files) are inside the archive. `src/core.ts`
  already resolves `node_modules/repo-tour` as its third fallback — verify the installed extension's doctor
  reports `via: exports` with NO `repoTourPath` setting.
- **`.vscodeignore`** stops shipping the test bundle (T-2 review advisory) and `.scratch/`, `.vscode-test/`,
  `vendor/*.tgz` sources — but must NOT exclude `node_modules/` in the staged package.
- **Two stores, one script:** `scripts/publish.mjs` with `--dry-run` (default when tokens are absent): prints
  exactly what `vsce publish` / `ovsx publish` would do; runs only with `VSCE_PAT` / `OVSX_PAT` present. CI
  runs the dry-run on every push and uploads the `.vsix` artifact.
- **Install on both editors, for real:** `codium --install-extension <vsix>` here (and `code` where present);
  then the extension's doctor from the installed copy. The clean-room verify for this ticket is that install.
- The README gets the first-target walkthrough (sql-gauntlet), the dial, the tutor/detour, the AGPL notice and a
  *Source* link — repo-tour's practice.
