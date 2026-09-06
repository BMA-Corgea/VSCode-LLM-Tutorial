# Build Tutorials

**A paint-by-numbers tutorial, generated from a real repository, that walks you through
*building* it — not just reading it.** repo-tour digests a finished repo and explains how it
works; this is the inverse: it explains how the repo got built, one decision at a time, and
then has you build it yourself. Part of the [repo-tour](https://github.com/BMA-Corgea/repo-tour)
suite — the two share one core.

## What's here right now

This is **T-2 through T-6**: the extension skeleton and its doctor (T-2), the start screen,
the shared skin contract and building the plan with resume (T-3), the walk — decision tree,
step panel, editor driving, progress that survives a reload (T-4) — the dial, where your hands
meet the code (T-5), and now a tutor you can ask when a step does not land (T-6). The detour
is still to come (T-7).

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

## The dial — how much do you want to type?

Set on the start screen, and overridable on any single step from the panel. Three positions,
and what each does depends on what kind of step you are on.

| | a **file** step | a **symbol** step | a **shape** step |
| --- | --- | --- | --- |
| **manual** | nothing is written. The panel shows the file's *shape* — the signature line of each load-bearing range, and the imports — so you know what to write without being told how | you fill it in and press *Check my work* | informational |
| **scaffolded** | the file is written with the boilerplate exactly as the author had it and the load-bearing ranges replaced by stubs, each carrying a `TODO` naming the step it belongs to | as manual | informational |
| **automated** | the file is written exactly as the author had it, and the step is marked done | the panel narrates the range with it revealed and highlighted | informational |

**Your edits are never overwritten silently.** If a file already exists and differs from what
the dial would write, you are asked — once per step — and *Keep mine* leaves it exactly as it
is and says so in the panel. Identical content is not a conflict and does not interrupt you.

**Walking a whole tutorial in automated mode reproduces the reference repository
byte-for-byte.** That is a test, not a claim: the suite builds a plan, walks every step, and
diffs the result against the original. Files that are never *taught* — generated output,
vendored code, lockfiles, data, anything binary — are copied rather than stepped through, and
the panel offers that once, with the count, rather than doing it behind your back.

## Check my work

Pressing it runs repo-tour's own structural check against the reference and answers in the
panel: which exports are present, missing or extra, which imports matched, and whether the
file parses at all. The tree marks the step ✓ or ✗ — and a step you have *not* checked keeps
looking unchecked, because a tree where everything you have not reached yet wears the same
mark as the thing you got wrong is a tree that tells you nothing.

**The check is structural, deliberately.** It compares shape, never bodies: rename a local
variable and it passes, because how you wrote the inside is yours. A missing export is named,
not counted. If the file does not parse, it says so and shows no missing-symbol list at all —
nothing can be found in a tree that could not be built, and a list claiming every export is
missing when one bracket is would be worse than saying nothing.

## Ask the tutor

Under the step there is a chat. Ask it anything about the decision you are looking at and it
answers with the step already in hand — the question, the road the author took **and** the
alternatives they did not, the *why* with its source named, and a diff of your file against
theirs. You never have to explain where you are.

**One conversation per step.** It lives in your own `progress.json` beside everything else, so
moving to another step switches conversations and coming back restores yours.

**It tells you when it can't help.** If no model provider is reachable, the panel says so where
the input is, with the provider's own reason — immediately, not after a spinner that never
ends. A request that takes too long comes back as an answer saying so. Cancelling detaches you
from the request rather than pretending the model stopped, and a cancelled answer never
reappears later.

**Its answers are text, not markup.** Everything is escaped and only ``` code fences render as
anything — a model that emits stray angle brackets cannot rewrite the page.

**It has its own model setting**, `buildTutorials.tutorModel`, deliberately separate from the
build's. The build model is chosen for what analysing a whole repository costs, once, in the
background; the tutor is one question you ask when you are already stuck. Left empty it uses
your provider's strongest model, which is the right way round for the one place a wrong answer
is read by someone who is already confused.

## A commit per step

Each completed step is committed in the tutorial folder — `<ordinal>: <the question> — <the
option the author chose>` — so the history you end up with reads as the sequence of decisions
you actually made. The folder is `git init`ed if it needs to be.

**The commits are yours, not the extension's.** They use that folder's own git identity, and
if none is configured no commit is made and the panel says so — this will never invent an
author or borrow one. Turn the whole thing off with `buildTutorials.commitPerStep`.

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
| `buildTutorials.commitPerStep` | `true` | Commit each completed step in the tutorial folder. The commits use that folder's own git identity; with none configured, nothing is committed and the panel says so rather than inventing an author. |
| `buildTutorials.tutorModel` | *(empty)* | The model the **tutor** asks — separate from `llmModel` on purpose. Empty means your provider's strongest model, rather than the one chosen for what a whole build costs. |
| `buildTutorials.tutorTimeoutSeconds` | `120` | How long to wait for a tutor answer. A timeout is reported as a reply, never as a spinner that does not end. |

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
