# Build Tutorials

**A paint-by-numbers tutorial, generated from a real repository, that walks you through
*building* it — not just reading it.** repo-tour digests a finished repo and explains how it
works; this is the inverse: it explains how the repo got built, one decision at a time, and
then has you build it yourself. Part of the [repo-tour](https://github.com/BMA-Corgea/repo-tour)
suite — the two share one core.

## What's here right now

This is **T-2 + T-3 + T-4**: the extension skeleton and its doctor (T-2), the start screen,
the shared skin contract and building the plan with resume (T-3), and now the walk itself —
the decision tree, the step panel, editor driving, and progress that survives a reload (T-4).
There is still no file writing, no tutor and no detour; those arrive in T-5 through T-8.

T-2 proved this extension can load repo-tour's core — an ESM package that finds its own
assets (skins, tree-sitter grammars) via `import.meta.url` — from inside the VS Code
extension host, via dynamic `import()`, unbundled. T-3 builds the extension's front door on
top of that: `Build Tutorials: Start` opens a real form, and submitting it turns a repository
into a `BuildPlan` — repo-tour's own build-order engine, asked to write out the same
decisions this extension will later walk you through.

## The start screen

`Build Tutorials: Start` opens a webview editor tab with:

- **What do you want to build?** — an idea, in your own words.
- **Just recreate the repo as it stands** — the only mode v1 actually builds. Typing an idea
  without ticking this shows, right under the idea field, *"Idea-first builds arrive with
  T-9 — tick recreate to build from a repo"* — never a silent decline.
- **Reference repo** — a local absolute path, or a `https://github.com/<owner>/<repo>` URL.
  A URL is cloned in full (the witness needs history) into this extension's global storage,
  under `refs/<owner>-<repo>`; reused with `git fetch` next time. A repo whose source is
  outside the languages repo-tour's shipped grammars cover (TypeScript, JavaScript, TSX,
  Python) is refused, naming the languages actually found.
- **Build it in** — an empty or new folder. This is where the plan (and, later, the tutorial
  itself) lives.
- **How much do you want to type?** — the three-position dial: manual, scaffolded, or
  automated. Set here as the default, and overridable per step in the walk. The dial is
  recorded, and shown; what it actually *does* to a step arrives with T-5.

Every field's problem, if it has one, appears in a line right under that field — never a
disabled button with no explanation.

Building the plan can take minutes, so it runs behind a cancellable progress notification and
a write-ahead marker at `<target>/.repo-tour/build/building.json`, kept current as the build
moves through each stage. If the window reloads (or the extension host is killed) mid-build,
the NEXT activation notices the marker and offers to resume — every finished step of
`interpretPlan`'s work is cached by content hash, so resuming costs close to nothing. On
success, the plan lands at `<target>/.repo-tour/build/plan.json` (plus `request.json`,
recording exactly what was asked for), and a notification reports the chapter/step counts and
the cost — a dollar amount and a token count where the provider reports usage, or an honest
*"this provider does not report usage"* where it does not.

## The walk

Open a folder that contains a built plan (`.repo-tour/build/plan.json`) and the walk starts
itself — that is the whole rule, no bookkeeping handed between windows. There is a **Build
Tutorials** container in the activity bar holding two views.

**Decisions** is a native tree: chapters over steps, each step showing the question it asks,
marked `✓` done, `→` current, or `○` pending. Click one and it becomes current.

**Current Step** is the panel beside it, and it shows, for the step you are on:

- the **question** this step is really answering;
- the **options** — the one the author actually chose, marked as such, and every alternative
  with its consequence spelled out. Alternatives are shown, not offered: choosing one is
  divergence, which arrives with T-10, and until then they carry that label and are not
  rendered as controls at all. There is nothing in the page to click, which is a straighter
  answer than a greyed-out button;
- the **why**, with its source named — *from the model, reading the code*, *from the author's
  own comment*, or *not inferable from the source*. You always know whether you are reading
  the author or an inference about them;
- the **witness** — the commit where this decision actually happened — or *no history to
  show*;
- the **dial** for this step, and **Previous / Open the file / Check my work / Next**.

Choosing a step reveals its range in a real editor tab and highlights the load-bearing lines
— the ones this step is asking you to write — leaving the boilerplate unmarked. Focus stays
in the panel you are reading unless you press *Open the file*, which is an explicit request
to go there.

**Honest controls, as everywhere else here.** *Check my work* answers, in the panel, *"Check
my work arrives with T-5"* — it does not quietly do nothing. *Open the file* is disabled, with
the reason next to it, when the file does not exist yet. Changing the dial is remembered per
step for T-5 to read.

Your position and each step's status live in `<target>/.repo-tour/build/progress.json`,
written atomically, beside the plan rather than inside this extension — reload the window,
close the folder, come back tomorrow, and the walk is where you left it. The status bar
carries `step 7 / 40 · scaffolded` while it runs.

## Skins — one file, both front ends

Every webview in this extension inlines repo-tour's own `baseCss()` + `alternateCss()`
UNCHANGED — the exact stylesheets its web pages use — plus a small bridge sheet that maps
repo-tour's base tokens to VS Code's own theme variables. Pick **System** in the corner
picker and the page follows your editor's active colour theme in real time; pick a named skin
(Dark, Gunmetal, Titanium, Classic, JRPG, …) and it looks the same here as it does on
repo-tour's own pages. The choice is remembered per person (VS Code's `globalState`, not a
workspace setting) and is stamped into the page before the very first paint, so there is no
flash of the wrong theme on open.

**Adding a skin is still just one CSS file in `repo-tour/assets/skins/` plus one row in its
`SKINS` registry — nothing in this extension has to change for it to show up here too.**

## The doctor

`Build Tutorials: Doctor` (from the Command Palette, or `./build-tutorials doctor` with no
editor at all) reports, in plain sentences:

- whether repo-tour's core was found, where, and its version
- whether each of its public modules loaded (8, including `build` — repo-tour's
  digest-to-`BuildPlan` engine T-3 consumes), and how (its published subpath exports, or
  `dist/<mod>.js` as a fallback for a repo-tour checkout with no `exports` map)
- whether tree-sitter initialised and its four grammars (Python, JavaScript, TypeScript,
  TSX) loaded
- whether the `claude` CLI was found, or the reason it was not

A missing or misconfigured core is a report, never a crash.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `buildTutorials.repoTourPath` | `../repo-tour` | Where to find a repo-tour checkout — relative to this extension, or absolute. |
| `buildTutorials.llmProvider` | `claude` | Which LLM provider repo-tour's interpret stage asks for each step's why and its roads-not-taken. The default runs the local `claude` CLI — a subscription tool, not an API key. |
| `buildTutorials.llmModel` | *(empty)* | Model name passed to the provider. Empty uses repo-tour's own recommended default at run time, so this setting never hardcodes a copy that can drift out of sync with repo-tour. |

The chosen **skin** is not a setting — it lives in VS Code's `globalState`, the same
per-person, per-machine scope repo-tour's own web pages keep it in via `localStorage`.

## Running it

```bash
./start.sh              # build, then open the Extension Development Host — double-click friendly
./build-tutorials dev    # the same, without the "press enter to close" pause
./build-tutorials doctor # check this machine with no editor at all
./build-tutorials build  # bundle src/ to dist/
./build-tutorials test   # run the plain-mocha unit suite, then vscode-test (headless via xvfb-run when there is no DISPLAY)
./build-tutorials package # produce a .vsix
```

`./build-tutorials dev` prefers `codium` (VSCodium) and falls back to `code` (VS Code),
saying plainly which it found.

`npm test` runs two suites: `npm run test:unit` (plain `mocha`, no `vscode` import anywhere
in it — pure logic, the write-ahead marker, the language refusal, the walk's own state
machine driven through fake adapters, and a full end-to-end `cachedOnly` build against a
synthetic fixture, schema-validated against repo-tour's own
`schema/build-plan.schema.json`), then the real `vscode-test` suite (a genuine
`WebviewPanel`, a real tree and webview view, real editor decorations, the extension's
activation). Never spends a token either way —
`cachedOnly: true` throughout; the one run that actually asks a model anything is the
orchestrator's own acceptance pass on a real target repo, never this suite.

repo-tour is consumed as a `file:` dependency on a sibling checkout (`npm install` links
`node_modules/repo-tour` to it) — see `buildTutorials.repoTourPath` above. It is loaded, not
bundled or copied, so it needs to actually be built (`npm run build` inside repo-tour, or
`./repo-tour build`) before the doctor or the extension can use it.

## Licence

[GNU AGPL v3](LICENSE) or later. If you run a modified version of this extension somewhere
other people can reach it over a network, they are entitled to its source — see
[NOTICE](NOTICE) for what that means in practice today. The extension now has a real
user-facing surface (the start screen, T-3) but does not yet carry a Source link on it,
matching repo-tour's practice of putting that offer where the eye already is rather than in
a file nobody opens; until it does, the offer lives here: **Source —
https://github.com/BMA-Corgea/VSCode-LLM-Tutorial**.
