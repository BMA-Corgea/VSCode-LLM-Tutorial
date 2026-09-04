# T-2 — UAT: is this what the owner MEANT?

**Intent chain:** T-1 (Evan, 2026-09-04) → spec §3 (one core, two front ends; the extension imports
repo-tour's core), §10 (the risk: does web-tree-sitter initialise in the extension host?), and his
closing ask verbatim: *"…until these are created and there's a start.sh (like in repo-tour) that I can
use to boot it up."*

**Conformance read (agent, uat level auto; accept spent on-behalf under GA-1 — the same words):**

| what was meant | what was built | verdict |
| --- | --- | --- |
| prove the host can run repo-tour's core before anything else is built | `loadCore` + doctor, 4 tests inside a real `@vscode/test-electron` host: 7/7 modules, 4/4 grammars, claude found | **conforms — the §10 bet is settled** |
| a `start.sh` like repo-tour's | `start.sh` wraps `./build-tutorials dev` with repo-tour's pause semantics; `./build-tutorials` has `dev / build / test / doctor / package`; prefers `codium` (this machine) | conforms |
| honest, not silent, where a feature is not there yet | `buildTutorials.start` says "the start screen arrives with T-3" | conforms |
| loads the core unbundled so `import.meta.url` keeps working | esbuild `external: ['vscode','repo-tour']`; dynamic `import()`; subpath-first with `dist/` fallback | conforms |

**Fitness in the hands:** the builder ran `./build-tutorials dev` and codium opened with the extension;
`./start.sh` verified interactive and non-interactive. Evan's own boot-up is the acceptance of the SET, at
the end — not of this skeleton alone.

**Gaps / carried forward:** `vsce package` needs `--no-dependencies` because the `file:` core cannot be
represented inside a `.vsix` — vendoring the core is T-8's AC2, already filed. CI's green run on GitHub is
unverified until main is pushed (the constituent commands were run locally). AC5's "matching repo-tour's
practice" was over-specified: repo-tour has no SPDX headers; the extension has them anyway — harmless.
