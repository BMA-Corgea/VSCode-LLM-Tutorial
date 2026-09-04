# Build Tutorials

**A paint-by-numbers tutorial, generated from a real repository, that walks you through
*building* it — not just reading it.** repo-tour digests a finished repo and explains how it
works; this is the inverse: it explains how the repo got built, one decision at a time, and
then has you build it yourself. Part of the [repo-tour](https://github.com/BMA-Corgea/repo-tour)
suite — the two share one core.

## What's here right now

This is **T-2**: the extension skeleton, the attachment to repo-tour's core, and a doctor
that proves the host machine can actually run it. There is no start screen, no decision tree,
no tutor yet — those arrive in T-3 through T-8. Running `Build Tutorials: Start` says so
honestly rather than doing nothing silently.

What T-2 *does* prove: this extension can load repo-tour's core — an ESM package that finds
its own assets (skins, tree-sitter grammars) via `import.meta.url` — from inside the VS Code
extension host, via dynamic `import()`, unbundled. That is the one architectural bet
everything else in this project stands on.

## The doctor

`Build Tutorials: Doctor` (from the Command Palette, or `./build-tutorials doctor` with no
editor at all) reports, in plain sentences:

- whether repo-tour's core was found, where, and its version
- whether each of its public modules loaded, and how (today: `dist/<mod>.js` — repo-tour has
  no `exports` map yet; once it does, via its published subpath exports instead, with no
  change needed here)
- whether tree-sitter initialised and its four grammars (Python, JavaScript, TypeScript,
  TSX) loaded
- whether the `claude` CLI was found, or the reason it was not

A missing or misconfigured core is a report, never a crash.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `buildTutorials.repoTourPath` | `../repo-tour` | Where to find a repo-tour checkout — relative to this extension, or absolute. |

## Running it

```bash
./start.sh              # build, then open the Extension Development Host — double-click friendly
./build-tutorials dev    # the same, without the "press enter to close" pause
./build-tutorials doctor # check this machine with no editor at all
./build-tutorials build  # bundle src/ to dist/
./build-tutorials test   # run the vscode-test suite (headless via xvfb-run when there is no DISPLAY)
./build-tutorials package # produce a .vsix
```

`./build-tutorials dev` prefers `codium` (VSCodium) and falls back to `code` (VS Code),
saying plainly which it found.

repo-tour is consumed as a `file:` dependency on a sibling checkout (`npm install` links
`node_modules/repo-tour` to it) — see `buildTutorials.repoTourPath` above. It is loaded, not
bundled or copied, so it needs to actually be built (`npm run build` inside repo-tour, or
`./repo-tour build`) before the doctor or the extension can use it.

## Licence

[GNU AGPL v3](LICENSE) or later. If you run a modified version of this extension somewhere
other people can reach it over a network, they are entitled to its source — see
[NOTICE](NOTICE) for what that means in practice today, and the **Source** link this
extension's own user-facing surface will carry once it has one (T-3 onward), matching
repo-tour's practice of putting that offer where the eye already is rather than in a file
nobody opens. Until then, the offer lives here: **Source —
https://github.com/BMA-Corgea/VSCode-LLM-Tutorial**.
