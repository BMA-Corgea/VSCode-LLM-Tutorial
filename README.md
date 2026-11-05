# Build Tutorials

**A paint-by-numbers tutorial, generated from a real repository, that walks you through
*building* it — not just reading it.**

[repo-tour](https://github.com/BMA-Corgea/repo-tour) digests a finished repo and explains how
it works. This is the inverse: it explains how the repo got **built**, one decision at a time,
and then has you build it yourself — with a dial that decides how much of it you type. The two
share one core.

---

## Install

Grab the `.vsix` and install it from the command line, or from the Extensions view's
*⋯ → Install from VSIX…*:

```bash
codium --install-extension build-tutorials-0.0.1.vsix   # VSCodium
code   --install-extension build-tutorials-0.0.1.vsix   # VS Code
```

**The `.vsix` carries its own engine.** repo-tour's core, `web-tree-sitter` and the
tree-sitter grammars travel inside the package, so there is nothing else to clone and nothing
to configure. Leave `buildTutorials.repoTourPath` empty and it uses the copy it shipped with;
you only ever set it to run against a repo-tour checkout you are editing yourself.

You will also want the **`claude` CLI** on your PATH. It is what the build asks for each step's
*why*, and what the tutor and the detour talk to. Everything else works without it, and the
doctor tells you plainly whether it is there.

Run **Build Tutorials: Doctor** from the Command Palette any time you want to know what this
machine can actually do: whether the core was found and where, whether each of its eight
modules loaded, whether tree-sitter came up with its four grammars (Python, JavaScript,
TypeScript, TSX), and whether `claude` was found. A missing or misconfigured anything is a
report in plain sentences, never a stack trace.

---

## Start a tutorial

**Build Tutorials: Start** opens a form:

- **What do you want to build?** — an idea, in your own words.
- **Just recreate the repo as it stands** — the mode that is built today. Typing an idea
  without ticking this says so, right under the field: *"Idea-first builds arrive with T-9 —
  tick recreate to build from a repo."* Never a silent decline.
- **Reference repo** — a local absolute path, or a `https://github.com/<owner>/<repo>` URL. A
  URL is cloned in full (the witness needs history) and reused with `git fetch` next time. A
  repo whose source is outside the four languages the shipped grammars cover is refused,
  naming the languages it actually found.
- **Build it in** — an empty or new folder. The plan and the tutorial live here.
- **How much do you want to type?** — the dial, below. Set here as the default, overridable on
  any single step.

Every field's problem, if it has one, appears in a line right under that field. **And pressing
*Build the plan* always changes something you can read**, in a line below the button:

- **Refused** — the line names what to fix and the cursor moves to the first field with a problem.
  Press again without changing anything and the line changes too ("Still can't build … Tried 2
  times."), so a second press never looks like an ignored one.
- **Accepted** — the button reads *Building…* and stops taking presses, and the line says the build
  is running and that its progress and *Cancel* are in the notification in the corner. A
  double-click starts one build, not two; the second click is answered in the line.
- **Finished** — the button comes back and the line says how the build ended: built, failed (the
  reason is under *Reference repo*), or cancelled. Closing the tab mid-build loses none of this: a
  start screen opened while the build runs shows it building, and the ending still arrives.

That second sentence was learned the hard way. The first one used to end "never a disabled button
with no explanation", and the code satisfied it by shipping an *enabled* button with no response:
the problems were already on screen from typing, so pressing the button re-drew exactly what was
already there and a press was indistinguishable from being ignored. **The requirement had been
written against the wrong failure** — a disabled button at least tells you it will not work.

Building the plan takes minutes, so it runs behind a cancellable progress notification with a
write-ahead marker at `<target>/.repo-tour/build/building.json`. If the window reloads or the
extension host dies mid-build, the next activation notices and offers to resume — every
finished stage is cached by content hash, so resuming costs close to nothing. On success the
plan lands at `<target>/.repo-tour/build/plan.json`, and a notification reports the chapter and
step counts plus the cost: a real dollar amount and token count where the provider reports
usage, or an honest *"this provider does not report usage"* where it does not.

---

## The walk

Open a folder that contains a built plan and the walk starts itself. That is the whole rule —
no bookkeeping handed between windows. A **Build Tutorials** container appears in the activity
bar with two views.

**Decisions** is a native tree: chapters over steps, each showing the question it asks, marked
`✓` done, `✗` failed its check, `→` current, or `○` pending. A step you have not checked keeps
looking unchecked — a tree where everything you have not reached yet wears the same mark as
the thing you got wrong is a tree that tells you nothing.

**Current Step** is the panel beside it:

- the **question** this step is really answering;
- the **options** — the one the author chose, marked as such, and every alternative with its
  consequence spelled out. Alternatives are *shown, not offered*: choosing one is divergence,
  which arrives with T-10, so until then they carry that label and are not rendered as
  controls at all. There is nothing in the page to click, which is a straighter answer than a
  greyed-out button;
- the **why**, with its source named — *from the model, reading the code*, *from the author's
  own comment*, or *not inferable from the source*. You always know whether you are reading
  the author or an inference about them;
- the **witness** — the commit where this decision actually happened — or *no history to show*;
- the **dial** for this step, and **Previous / Open the file / Check my work / Next**.

Choosing a step reveals its range in a real editor tab and highlights the load-bearing lines,
leaving the boilerplate unmarked. Focus stays in the panel you are reading unless you press
*Open the file*, which is an explicit request to go there.

Your position and each step's status live in `<target>/.repo-tour/build/progress.json`, written
atomically, beside the plan rather than inside this extension — reload the window, close the
folder, come back tomorrow, and the walk is where you left it. The status bar carries
`step 7 / 61 · scaffolded` while it runs.

---

## The dial — how much do you want to type?

Set on the start screen, overridable on any single step from the panel. What each position does
depends on the kind of step you are on.

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

---

## Check my work

Pressing it runs repo-tour's own structural check against the reference and answers in the
panel: which exports are present, missing or extra, which imports matched, and whether the file
parses at all.

**The check is structural, deliberately.** It compares shape, never bodies: rename a local
variable and it passes, because how you wrote the inside is yours. A missing export is named,
not counted. If the file does not parse it says so and shows no missing-symbol list at all —
nothing can be found in a tree that could not be built, and a list claiming every export is
missing when one bracket is would be worse than saying nothing.

---

## Ask the tutor

Under the step there is a chat. Ask it anything about the decision in front of you and it
answers with the step already in hand — the question, the road the author took **and** the ones
they did not, the *why* with its source named, and a diff of your file against theirs. You never
have to explain where you are.

**One conversation per step.** It lives in your own `progress.json`, so moving to another step
switches conversations and coming back restores yours.

**It tells you when it can't help.** With no model provider reachable, the panel says so where
the input is, with the provider's own reason — immediately, not after a spinner that never ends.
A request that takes too long comes back as an answer saying so. Cancelling detaches you from
the request rather than pretending the model stopped, and a cancelled answer never reappears.

**Its answers are text, not markup.** Everything is escaped and only ``` code fences render as
anything, so a model that emits stray angle brackets cannot rewrite the page.

**It has its own model setting**, `buildTutorials.tutorModel`, separate from the build's on
purpose. The build model is chosen for what analysing a whole repository costs, once, in the
background; the tutor is one question you ask when you are already stuck. Left empty it uses
your provider's strongest model — the right way round for the one place a wrong answer is read
by someone who is already confused.

---

## The detour — when the concept itself is the problem

Sometimes the answer is not more detail about *this* file. Beside *Ask* there is **Show me an
unrelated example**.

Press it and the extension asks for a small, self-contained worked example of the same concept
in a **deliberately different domain** — if you are building a SQL trainer, you get something
that is not about SQL — then opens it as **real editor tabs** with a narrator beside them that
walks you through three to six stops, revealing and highlighting each one.

**It leaves nothing behind.** The detour's files are written into the extension's own global
storage, never into your workspace, so your explorer never shows them and your repository is
untouched by construction. *Back to my build* closes exactly the tabs it opened, disposes the
narrator, deletes the directory, and puts you back on the step you left, at the same dial. The
step's transcript records `detour taken: <title>` so you can see it happened.

**Retaking one is free** — detours are cached by step, so going back to an example costs
nothing. A generation that fails says why, in the panel.

---

## A commit per step

Each completed step is committed in the tutorial folder — `<ordinal>: <the question> — <the
option the author chose>` — so the history you end up with reads as the sequence of decisions
you actually made. The folder is `git init`ed if it needs to be.

**The commits are yours, not the extension's.** They use that folder's own git identity, and if
none is configured no commit is made and the panel says so — this will never invent an author
or borrow one. Turn it off with `buildTutorials.commitPerStep`.

---

## What a real one looks like

The first target this was built against is a local SQL interview trainer — an in-browser SQLite
engine that grades your queries, a timed gauntlet mode, and a tutor chat. Roughly 5,000 lines of
plain JavaScript, HTML and CSS with no framework and no build step. Pointed at it, the build
produced:

- **61 steps across 5 chapters**, ordered the way the repository was actually built rather than
  the way its directories are laid out: `public`, then `public/data`, then `data/sections`, then
  `tools`, then everything else.
- **35 symbol steps, 21 file steps, 5 shape steps.** A shape step is orientation — this is what
  this directory is for — and writes nothing. A file step is a whole file. A symbol step is one
  function or class, and it is where the dial earns its keep.
- **15 files reproduced rather than taught** — the vendored SQL engine, generated data, the
  lockfile. The panel offers to copy them once, with the count, and never does it silently.

Walking it in **automated** mode reproduces that repository byte-for-byte. Walking it in
**manual** mode is a week of evenings. The point of the dial is that you can start a chapter on
automated to see the shape, drop to scaffolded when it starts making sense, and go manual for
the one function you actually came to learn — per step, without restarting anything.

---

## Skins — one file, both front ends

Every webview here inlines repo-tour's own `baseCss()` + `alternateCss()` UNCHANGED — the exact
stylesheets its web pages use — plus a small bridge sheet mapping repo-tour's base tokens to VS
Code's theme variables. Pick **System** in the corner picker and the page follows your editor's
active colour theme in real time; pick a named skin (Dark, Gunmetal, Titanium, Classic, JRPG, …)
and it looks the same here as it does on repo-tour's own pages. The choice is remembered per
person and stamped into the page before the first paint, so there is no flash of the wrong theme.

**Adding a skin is one CSS file in `repo-tour/assets/skins/` plus one row in its `SKINS`
registry — nothing in this extension has to change for it to appear here too.**

---

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `buildTutorials.repoTourPath` | *(empty)* | Where to find repo-tour. **Leave it empty** to use the copy packaged inside the extension. A path — absolute, or relative to the extension's install directory — points at a checkout instead, which is what you want only when developing repo-tour itself. |
| `buildTutorials.llmProvider` | `claude` | Which provider the build asks for each step's *why* and its roads-not-taken. The default runs the local `claude` CLI — a subscription tool, not an API key. |
| `buildTutorials.llmModel` | *(empty)* | Model passed to the provider for the build. Empty uses repo-tour's own recommended default, read at run time, so this never hardcodes a copy that drifts. |
| `buildTutorials.commitPerStep` | `true` | Commit each completed step in the tutorial folder, using that folder's own git identity. |
| `buildTutorials.tutorModel` | *(empty)* | The model the **tutor** asks. Empty means your provider's strongest, rather than the one chosen for what a whole build costs. |
| `buildTutorials.tutorTimeoutSeconds` | `120` | How long to wait for a tutor answer, between 5 seconds and an hour. A timeout is reported as a reply, never as a spinner that does not end. |

The chosen **skin** is not a setting — it lives in VS Code's `globalState`, the same per-person,
per-machine scope repo-tour's web pages keep it in via `localStorage`.

---

## Building it from source

```bash
git clone https://github.com/BMA-Corgea/repo-tour.git
git clone https://github.com/BMA-Corgea/VSCode-LLM-Tutorial.git
cd repo-tour && npm install && npm run build && cd ../VSCode-LLM-Tutorial && npm install
```

The two repositories are **siblings**: `npm install` links `node_modules/repo-tour` to the
checkout next door, and the core is loaded from there rather than bundled, so it has to actually
be built before the doctor or the extension can use it. Then:

```bash
./start.sh                # build, then open the Extension Development Host — double-click friendly
./build-tutorials dev     # the same, without the "press enter to close" pause
./build-tutorials doctor  # check this machine, with no editor at all
./build-tutorials build   # bundle src/ to dist/
./build-tutorials test    # the unit suite, then vscode-test (headless via xvfb-run when there is no DISPLAY)
npm run package           # produce the .vsix, with repo-tour vendored into it
npm run verify:install    # install that .vsix into an isolated profile and prove it activates
npm run publish:dry-run   # say exactly what publishing would do — see below
```

`./build-tutorials dev` prefers `codium` and falls back to `code`, saying plainly which it found.

`npm test` runs two suites: `npm run test:unit` (plain `mocha`, with no `vscode` import anywhere
in it) and then the real `vscode-test` suite (a genuine `WebviewPanel`, a real tree and webview
view, real editor decorations, the extension's activation). **Neither ever spends a token** —
`cachedOnly: true` throughout, or an injected runner.

`npm run package` does not simply zip the working tree. It packs the sibling repo-tour checkout
into a tarball, installs it into a staging copy built from an explicit allowlist of files, and
packages from there — then reads the finished archive back and **fails** if the core, either
runtime dependency or any of the four grammars is missing, or if the archive carries anything
that must not be published. There is no route to a `.vsix` that skipped that check.

Half of that check looks for the maintainer's own name, and the strings it looks for are
supplied at run time — `BUILD_TUTORIALS_OWNER_NAMES`, else this checkout's git identity —
because writing them into a public repository would be the disclosure they exist to prevent.
If it can derive none, it **refuses** and exits 2 rather than reporting a pass: a check that
checked nothing is not a check. `--allow-vacuous-name-scan` says out loud that you accept an
archive whose name half is unchecked, and a run that uses it never prints "verified".

## Publishing

`npm run publish:dry-run` prints exactly what publishing to the Visual Studio Marketplace and to
Open VSX would do — the registry, the publisher id, the version, the artifact and its size, and
the literal command line — and sends nothing.

**It cannot become a real publish by accident.** A credential sitting in the environment does
not enable anything here; on its own it makes the script *refuse* and exit non-zero, because a
run that silently switches between "described it" and "did it" based on an environment variable
nobody typed is the one failure worth designing against. A real publish needs two separate,
deliberate confirmations, one of which names the exact version — and it is the owner's to
perform, in the owner's account.

What the confirmation binds, exactly: the **version** (`<publisher>.<name>@<version>`, so a
value set once cannot authorise the next release) and the artifact's **file name** (it must be
`<name>-<version>.vsix`, wherever it sits). The archive itself is never opened, so a stale build
sitting at the right name reads as a fresh one — the transcript says so on screen rather than
implying more. Both registry tools are pinned to exact versions, because a publish is the one
moment this project runs third-party code with a live credential in scope.

## Licence

[GNU AGPL v3](LICENSE) or later. If you run a modified version of this extension somewhere other
people can reach it over a network, they are entitled to its source — see [NOTICE](NOTICE) for
what that means in practice today.

**Source — https://github.com/BMA-Corgea/VSCode-LLM-Tutorial**
