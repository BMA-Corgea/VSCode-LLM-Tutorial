# T-1 — Build tutorials, v1: recreate a repo by its decisions

**Type:** direction · **Shop:** vscode-llm-tutorial · **Preset:** solo-builder-review
**Author:** PM (agent) for `human:evan` · **Written:** 2026-09-04
**Gate:** the ticket SET below is approved by Evan before any child ticket starts; each child
then has its own `spec_ready` gate unless he grants the branch (§12, the exception question).

---

## 1. Why this exists

Evan, 2026-09-04, verbatim:

> *"What I want to do is create a VScode addon that lets me get a tutorial of an idea instead
> of simply vibecoding it. You see how repo-tour interprets a repo and tells you how it works?
> I want an app that walks me through how to code it and what kinds of decisions go into
> making a file or repo the way it is. Basically, a paint by numbers to create an app."*

The complaint is not that code appears; it is that **the reasoning never does.** A vibecoded
app is one you own and do not understand. This product puts the decisions back: every step
is a decision, the code is what the decision implies, and the learner's hands are on the
line the decision was about.

It is the inverse of repo-tour. repo-tour digests a finished repo and explains *how it
works*. This digests a repo (or, later, an idea) and explains *how it got built* — and then
has you build it. Evan's GitHub description already says it: *"Part of the repo-tour suite."*

## 2. The one abstraction

Both front doors produce the same artifact — an **ordered decision list**:

```
   an idea  ──►  ┌────────────────────────────┐
                 │  ORDERED DECISION LIST     │ ──► step ──► step ──► step
   a repo   ──►  │  each: question, options,  │       at each one the learner
                 │  consequence, the code     │       takes the default or diverges
                 └────────────────────────────┘
                 default comes from:  idea → derived from first principles (Mode A, T-9)
                                      repo → extracted from the real repo   (Mode B, THIS)
```

- **A step is one decision plus the code that decision implies.** Not a file, not a commit.
  Files fall out of decisions — which is the thesis.
- The Socratic layer is not a third mode; it is how the learner moves through the list.
- Divergence is not a Mode-B feature; in Mode A every step is a divergence with no author to
  disagree with. **Divergence = a Mode-A replan seeded by the Mode-B prefix** (T-10).

## 3. One core, two front ends — the architecture decision this ticket locks

Evan: *"I do ultimately want this to share a core with repo-tour. I want it to be part of the
same app."* repo-tour had already ruled *own pages, not a GitHub overlay* (a web surface),
and this product ruled *VS Code extension* (§6). Those cannot be the same window. They can be
the same app:

```
        repo-tour  (github.com/BMA-Corgea/repo-tour)              VSCode-LLM-Tutorial
        ────────────────────────────────────────────              ─────────────────────
  CORE  digest · rank · extract · interpret · rollup  ◄── imports ── extension host
        llm (claude CLI, codex, ollama) · ask · skins                 │
        NEW  build/plan.ts   digest → BuildPlan                       ├─ start screen   (webview tab)
        NEW  build/check.ts  learner file vs reference                 ├─ decision tree  (native)
        NEW  interpret: alternatives per step                          ├─ step panel     (webview view)
                                                                      ├─ editor driving (native)
  WEB   server.ts · repoview.ts · prview.ts  (how it WORKS)            ├─ tutor · detour
                                                                      └─ dial · check · commit
```

**Recommended: the extension imports repo-tour's core as a package.** One digest cache on
disk (`<repo>/.repo-tour/`, shared — a repo already toured is nearly free to plan), one LLM
layer and its subscription-not-API-key constraint, one Ask persona, **one skin set**. The web
page and the extension are two front ends of one core.

**Alternative considered — the extension as a client of the running repo-tour server.**
Literally one process; the server would grow `/api/plan`, `/api/scaffold`, `/api/check`, and
the extension would spawn `repo-tour serve` like a language server. Rejected for v1: it puts
an HTTP API in front of every operation for a payoff (shared in-memory job state) the on-disk
cache already mostly gives, and it means the extension cannot run without a second process.
The core is kept behind a clean module boundary so this can be revisited without a rewrite.

**What this costs, said plainly.** repo-tour is `private: true`, unpublished, and locates its
assets with `import.meta.url` (`src/skins.ts` `skinsDir()`, `src/extract.ts` `grammarPath()`).
The extension must load it as ESM from `node_modules` via dynamic `import()` — not bundle it —
and the core must accept injected asset roots. That is repo-tour **T-11**. For Evan's machine
a `file:` dependency on the sibling checkout serves; publishing repo-tour is deferred (§11).

## 4. The build-order engine (lands in repo-tour — T-12, T-13)

Everything below is a **projection of the digest** (`src/tour.ts` doctrine: computed at
render time, never a hand-written artifact, disposable and regenerable). Four free stages
already exist; the plan adds no new parsing.

### 4.1 Deriving the steps — deterministic, free

| From | The engine derives |
| --- | --- |
| `rollup` subsystem tiers (`TierDigest`) | **chapters**, ordered so a chapter comes after the chapters it imports from |
| `ImportGraph` | **file order within a chapter**: topological, leaves first — you build what you import before what imports it. Ties: first-commit date, then rank score |
| `FileExtract.symbols` (exported, by span) | **symbol steps** — the load-bearing parts of a file, capped at 5 per file so a 1,200-line file is not 40 steps. A file that exports nothing (script-style JS, IIFEs, CommonJS, a private-only Python module) falls back to all its recorded symbols, minus trivial ones (one-line variables, aliases) — repo-tour T-15, from the sql-gauntlet dry run, 2026-09-04 |
| `git log --diff-filter=A` per file | the **witness**: when the author actually wrote it, and the commit subject — shown, never used to order |
| `Classification` | only `source` and `structural` files become steps; `test` files become steps *after* the file they test; `generated` / `vendored` / `lockfile` / `data` (and any binary) go to `plan.reproduce` — reproduced by the automated writer, never taught. **Invariant:** every inventoried file is a step or is in `reproduce`; nothing vanishes (T-12 review, 2026-09-04) |

Three step kinds: **shape** (one per chapter: why this subsystem exists), **file** (create
this module: what it owns, what it depends on), **symbol** (fill this load-bearing part).

### 4.2 The data model — complete from day one (Evan's constraint, §7)

```ts
interface BuildPlan {
  schemaVersion: 1;
  source: { kind: 'repo'; root: string; head: string | null } | { kind: 'idea'; text: string } | { kind: 'both'; root: string; head: string | null; text: string };
  mode: 'recreate' | 'guided' | 'idea';        // v1 produces only 'recreate'; the enum exists now
  chapters: Chapter[];
  steps: Step[];                               // flat, ordered; each names its chapter
  generatedAt: string;
  cost: InterpretCost;                         // repo-tour's shape; metered:false is honest, never zero-as-fact
}
interface Chapter { key: string; title: string; subtitle: string; tierPath: string }
interface Step {
  id: string;                                  // stable: sha256(file + kind + symbol name) — survives regeneration
  ordinal: number;
  chapter: string;
  kind: 'shape' | 'file' | 'symbol';
  decision: {
    question: string;                          // "How should files be ranked by importance?"
    options: Option[];                         // ALWAYS ≥ 2 once interpreted; exactly one is the author's
    authorChoice: string;                      // option id — the ground truth
    chosen: string | null;                     // recreate mode: === authorChoice. Field exists for T-9/T-10
    why: string;                               // interpret's why, else the docstring, else "not inferable from the source" — never invented
    whySource: 'interpret' | 'docstring' | 'none';
  };
  target: { file: string; startLine?: number; endLine?: number };
  scaffold: { loadBearing: Range[]; boilerplate: Range[] };   // from extract's symbol ranges
  dependsOn: string[];                         // step ids, from the import graph
  witness: { sha: string | null; date: string | null; subject: string | null };
}
interface Option { id: string; label: string; consequence: string; taken: boolean }
```

### 4.3 The options — the only paid part (T-13)

repo-tour's interpret stage reads the real lines and writes `what` / `why` / `summary`,
cached by content hash (`src/interpret.ts`). The build engine asks the **same call** for one
more thing: *two other ways this could reasonably have been done, and what each would have
cost.* `PROMPT_VERSION` bumps; the cache key changes with it, exactly as designed. Even in
recreate mode the learner sees *the author chose X; Y and Z were on the table* — that is the
teaching, and it is what makes T-9/T-10 a change of defaults rather than new machinery.

### 4.4 The check — structural, deterministic, never a model (T-12)

`check(learnerFile, referenceExtract)` runs extract on the learner's file and compares
**structure**: exported symbols (name + kind), resolved imports, parse errors. It reports
present / missing / extra per symbol. It never compares bodies and never fails a learner for
naming a local variable differently. Semantic questions go to the tutor, on request.

### 4.5 Scaffolding — from the reference, by range

- **load-bearing** = the ranges of the file's symbol steps.
- **boilerplate** = everything else in the file (imports, types, small helpers).
- A stub keeps the symbol's first line (signature), replaces the body with a language-correct
  placeholder (`// TODO(step 7): <decision question>` / `raise NotImplementedError`), so the
  file parses and the check can run on it.

## 5. The extension (this repo — T-2 … T-8)

### 5.1 Surfaces

```
┌──────────┬─────────────────────────────────────┬──────────────────┐
│ DECISIONS│   the learner's real files          │  CURRENT STEP    │
│ native   │   ┌─────────────────────────────┐   │  webview view    │
│ tree     │   │ 13  ◀ native decoration on  │   │  question        │
│ ✓ ✓ ▸ ·  │   │ 14    the load-bearing range│   │  author's choice │
│          │   └─────────────────────────────┘   │  + alternatives  │
│          │   ▸ terminal — runs THEIR app       │  why · witness   │
│          │                                     │  dial · check    │
│          │                                     │  tutor  "why?"   │
└──────────┴─────────────────────────────────────┴──────────────────┘
```

| surface | kind | why |
| --- | --- | --- |
| start screen | webview, editor tab | a form with interdependent fields; transient |
| decision list | **native TreeView** | it is a list — keyboard nav, icons, theming for free |
| step panel + tutor | webview view (sidebar) | rich, persistent, beside the code all session |
| "this is the line" | **native decoration + reveal** | it is in the real editor |
| detour | webview tab as narrator; **real editor tabs** for its files | see 5.6 |

Webviews are isolated iframes; all state lives in the extension host, each view is a dumb
renderer. Hidden webviews are torn down: every view implements `getState`/`setState` and the
host re-renders from the plan, never from the view.

### 5.2 The start screen (T-3)

```
  What do you want to build?          [ idea textbox ]
  ☐ Just recreate the repo as it stands
  Reference repo                      [ local path or GitHub URL ]   required if ☑
  Build it in                         [ folder picker — empty or new ]
  How much do you want to type?       manual ●────○────○ watch me build it
```

- Recreate ⇒ repo required. Idea-only or idea+repo are **present and honest**: typing an idea
  without ticking recreate shows, where the eye already is, *"Idea-first builds arrive with
  T-9 — tick 'recreate' to build from a repo."* (repo-tour lesson: a control that silently
  declines is a broken control.)
- A GitHub URL is cloned into the extension's global storage; a local path is used in place.
  A repo outside TS/JS/TSX/Python is refused *with the reason* (the grammars repo-tour ships).
- Building the plan may take minutes — *"speed is not a priority"* — so it runs with a
  progress notification and a **write-ahead marker** (`<target>/.repo-tour/build/building.json`,
  repo-tour's T-4 lesson); a window reload resumes, and finished interpretation is cached.
- The plan is written to `<target>/.repo-tour/build/plan.json`, progress to `progress.json`
  beside it: the build belongs to that project, survives a reinstall, and repo-tour can read it.

### 5.3 The walk (T-4)

Tree of chapters → steps with done / current / pending. The step panel shows the question,
the author's choice marked among the alternatives, the why (with its source named), the
witness, this step's dial, and *Open the file · Check my work · Next*. Opening a step reveals
the target range and decorates the load-bearing lines. Position persists.

### 5.4 The dial (T-5)

Global at the start screen, **overridable per step** — attention goes where the decisions are
load-bearing. The extension remembers per-step positions and never drifts the global setting
toward *automated* on its own.

| position | what the extension writes | what the learner does |
| --- | --- | --- |
| manual | nothing — shows the file's shape (exports, imports) | writes the file; *Check* compares structure |
| scaffolded | boilerplate ranges from the reference; stubs for load-bearing ranges | fills the stubs; *Check* |
| automated | the reference file, verbatim | watches: the panel walks each load-bearing range and narrates |

**Commit per completed step** (PM suggestion, A0g — cheap, and it is the resume mechanism):
the target is `git init`ed if needed, and a passed step commits its file with the decision as
the message. The learner's own build gains a history that mirrors the decision list — which
repo-tour can then tour. Off by one setting.

### 5.5 The tutor (T-6)

sql-gauntlet's shape, through repo-tour's existing brain: `buildAskPrompt(messages, ctx)` +
`runLlm` (`src/ask.ts`, `src/llm.ts`) — the claude CLI by default, no API key. Context is the
step (question, options, why), the reference's meaning, and **the unified diff of the
learner's file against the reference** — the tutor can see exactly where you left the author.
**One transcript per step**, persisted in `progress.json`. Honest when the provider is
unreachable: the persona already says so; the panel never hangs.

### 5.6 The detour (T-7)

Evan: *"If I need help with a specific concept, I want to be able to go to … a cutaway gag
where we demonstrate the concept on a completely unrelated example that we create."*
(He asked that the name not be over-indexed on; **detour** is the working name.)

The escalation ladder: *"why?"* → tutor answers in place → *"I still don't get it"* → detour.
The model is asked for a tiny, self-contained example of the concept **in a different domain**
(≤ 5 files, ≤ 60 lines each) with 3–6 narration stops. The files are written to the
extension's global storage — **outside the workspace**, so the explorer never shows them —
and opened as real editor tabs; a narrator webview walks them with reveal + decoration. *Back
to my build* closes the tabs, deletes the directory, and restores the step. Unrelated on
purpose: a sandwich shop teaches dependency injection better than a fourth variation of your
own auth module, because the concept cannot be confused with the local instance. Cached by
step + prompt version, so retaking is free.

### 5.7 Skins — one file, both front ends (T-3)

Evan: *"just like the repo-tour I want to be able to one shot new css styles so have it
modular like that."* The extension's webviews inline `baseCss()` + `alternateCss()` from
repo-tour's `src/skins.ts` — **the same files**. A bridge sheet maps the base tokens to
`--vscode-*` variables under `:root:not([data-theme])`, so *System* means *follow the editor
theme*. The picker lists `SKINS`; the choice is stamped into the HTML by the host before first
paint (no flash), persisted in `globalState`. **A new skin is one CSS file in
`repo-tour/assets/skins/` plus one row — and it appears in the web app and in VS Code.**

## 6. Recorded decisions (Evan, 2026-09-04 — do not re-litigate)

1. Two front doors, one engine.
2. Start screen: idea + recreate checkbox + repo (required iff checked) + dial.
3. Three-position dial, global then per-step.
4. Tutor at every step, sql-gauntlet's pattern.
5. Detour — unrelated toy example, disposable, returns you.
6. **Divergence = replan the remainder.** *"The cost doesn't really bother me honestly … let's
   replan the remainder so we get something that functions."* Replan-diff UI is later.
7. **Extension** — not a VSCodium fork (a monthly upstream rebase, solo, eats the project), not
   an own IDE (the learner would leave competent only in the tutorial app). VS Code and
   VSCodium share the API; publish to the MS Marketplace **and** Open VSX.
8. **v1 = recreate-as-it-stands**, architected so the other modes are visible from day one.
9. Shared core with repo-tour; *"part of the same app"* — resolved as §3.
10. Skins modular like repo-tour — §5.7.
11. AGPL-3.0 (on the repo, GitHub-detected). Note: on a local extension AGPL behaves like GPL;
    §13 bites only on a hosted modified version — which is the intent.

## 7. v1 scope, and how the other modes stay visible

v1 ships **recreate mode end to end** — the smallest thing that proves the whole engine and
the only mode with ground truth (the output can be diffed against the actual repo).

The other modes are not stripped; they are **honored in the data and named in the UI**:
`mode` is an enum, `source` a union, `chosen` a field, `options` always ≥ 2 with alternatives
*generated and shown*. Mode A and divergence are filed now as their own direction tickets
(T-9, T-10) so they sit on the board, not in prose. What v1 does *not* do is let the learner
pick an alternative — the option is shown and marked *coming with T-10*, where the eye is.

## 8. The ticket set — epics with boundaries and order

Cross-repo: the tracker cannot `--after` across shops, so the repo-tour dependency is stated
here and in T-3's spec. Order of play: **RT T-11 ∥ RT T-12 ∥ T-2** → RT T-13 → T-3 → T-4 →
(T-5 ∥ T-6) → T-7 → T-8.

| id | shop | title | consumes | produces | risk |
| --- | --- | --- | --- | --- | --- |
| T-11 | repo-tour | Expose the core as a consumable package | — | `exports` map; injectable asset roots (skins dir, grammar dir); `prepare` builds `dist/`; a consumer smoke test that imports from outside the repo | low |
| T-12 | repo-tour | The build-order engine: digest → BuildPlan, and the structural check | digest, rollup, extract, git | `src/build/plan.ts`, `src/build/check.ts`, schema, tests on synthetic git fixtures | medium |
| T-13 | repo-tour | Interpret the decisions: alternatives per step; Ask context for a build step | T-12 | `PROMPT_VERSION` bump, `alternatives` in the cached meaning, `AskContext.build` | low |
| T-2 | here | Extension skeleton, core attach, doctor | — | manifest, activation, `repoTour.path`, dynamic ESM import of the core, `doctor` command (core, grammars, claude), vscode-test, CI | low |
| T-3 | here | Start screen, shared skins, plan build with resume | T-2, RT T-11/12/13 | the form; clone-or-path; language refusal; progress + marker; `plan.json`; skin loader + bridge + picker | medium |
| T-4 | here | The walk: tree, step panel, editor driving, progress | T-3 | TreeView, step webview, reveal + decorations, next/prev, `progress.json`, state restore | medium |
| T-5 | here | The dial, the check, commit per step | T-4 | scaffold writer, automated writer + narrated reveal, check UI, per-step override, git commits | medium |
| T-6 | here | The tutor | T-4, RT T-13 | chat under the step panel, per-step transcripts, diff-in-context, honest offline | low |
| T-7 | here | The detour | T-6 | unrelated example in global storage, real tabs, narrator, clean return | low |
| T-8 | here | Package and publish | T-5, T-6, T-7 | `.vsix`, Marketplace + Open VSX steps, README, AGPL notice + Source link | low |
| T-9 | here | *direction* — Mode A: idea-first, Socratic from first principles | T-1 | its own scoped set, later | — |
| T-10 | here | *direction* — Divergence: follow or diverge, replan the remainder | T-1 | its own scoped set, later | — |

**Right-sizing check:** a reviewer can reject T-5 (the scaffold writer) and approve T-4 (the
walk) — they are separable deliverables with separate tests. T-6 and T-7 are split because
the detour's cleanup contract (nothing left in the workspace) deserves its own gate.

## 9. Success shape for the direction — each criterion names its check

| # | criterion | check |
| --- | --- | --- |
| 1 | From an empty folder and a local TS/JS/Python repo, the start screen yields a `BuildPlan` whose steps cover every `source` + `structural` file in dependency order | engine test on a synthetic fixture; live run on the first target (§13) |
| 2 | Every step carries question, ≥ 2 options with the author's marked, why + whySource, witness, scaffold ranges, dependsOn | JSON-schema test over a generated plan |
| 3 | Walking every step in **automated** mode reproduces the reference's source files byte-for-byte (generated/vendored/lockfiles reproduced, never taught) | `diff -r` in the acceptance run |
| 4 | In **scaffolded** mode every stub parses, and filling stubs with the reference bodies passes *Check*; *Check* is structural and deterministic | engine tests; a check on a renamed local variable passes |
| 5 | The tutor is handed the step and the learner-vs-reference diff, keeps one transcript per step, and says so when the provider is unreachable | unit test on the context block; a run with `claude` absent |
| 6 | A detour leaves the workspace tree unchanged and its directory removed on return | test asserts the tree hash before/after |
| 7 | A new skin is one CSS file + one row in repo-tour and shows in both front ends | add a fixture skin; assert it is in the webview HTML and the web page |
| 8 | Killing VS Code mid-plan resumes from the marker; step progress survives reload | manual kill + a persisted-state test |
| 9 | A `.vsix` builds; Marketplace and Open VSX publish steps are documented and dry-run | CI artifact |
| 10 | The plan reports what interpreting cost, or `metered: false` when the provider cannot say | manifest field test |

## 10. Known limits and risks, stated up front

- **Languages:** TS, JS, TSX, Python — repo-tour's shipped grammars (`src/extract.ts`
  `GRAMMAR_FOR`). Anything else is refused with the reason; a new language is a grammar, not
  a new pipeline.
- **ESM in the extension host:** the core is loaded with dynamic `import()` from
  `node_modules`, unbundled, so `import.meta.url` keeps working; the extension's own code is
  bundled. T-2's doctor proves tree-sitter's WASM loads in the host before anything else is built.
- **Token cost:** one interpret call per step (alternatives ride in the same call), cached by
  content hash in the reference repo's `.repo-tour/`. A repo already toured pays only for the
  new prompt version. Cost is on the plan, metered or not.
- **The witness is only as good as the history:** a repo with no git history (sql-gauntlet has
  none) gets `witness: null` fields and the panel says *"no history to show"* — never invents.
- **Ordering is logical, not historical.** Topological build order is the honest teaching
  order; the git witness shows where the author actually went. Both are shown; neither lies.
- **Distribution:** a `file:` dependency on the sibling repo-tour checkout works for Evan; a
  public `.vsix` needs repo-tour published or vendored — deferred (§11).

## 11. Out of scope

- Mode A, idea-first planning — T-9
- Divergence, follow-or-diverge, replan the remainder — T-10
- A visible replan diff when later steps change — deferred: who=human:evan why="sophistication that we don't need yet … if we start selling this or something then maybe"
- Letting the learner pick an alternative in recreate mode — T-10
- Languages beyond TS/JS/TSX/Python — deferred: who=human:evan why=repo-tour's grammar coverage is its own decision (repo-tour T-1 §3)
- Publishing repo-tour to npm / vendoring it into the `.vsix` — deferred: who=human:evan why=a public artifact is not v1; the `file:` link serves his machine
- Tutorials from a PR rather than a repo — deferred: who=human:evan why=repo-first was the 2026-08-25 decision on repo-tour and holds here
- GONS / GUTS integration — repo-tour T-7
- The extension as a client of the repo-tour server (§3 alternative) — deferred: who=agent:pm why=revisit only if in-process job sharing is ever needed; the module boundary keeps it open
- A "Build" page inside repo-tour's web UI — deferred: who=agent:pm why=the tutorial runs in VS Code; a web launcher adds nothing yet

## 12. The exception question (asked once, per dir-scope)

Default: Evan approves each child ticket's spec as it comes (T-2 … T-8 — seven stops) and
accepts each at `accept`. The alternative is a branch grant: run the approved set with only
`accept` stopping for him. His answer is recorded verbatim with `tracker.mjs grant` when it
lands, never paraphrased.

## 13. The first live target

**sql-gauntlet** (36 files, ~2,400 lines of JS, no git history) — small enough to walk end to
end in one sitting, in a language the grammars cover, and its missing history exercises the
`witness: null` path honestly. **repo-tour itself** is the second target: ~10k lines of TS with
sixty commits — proves scale and the witness. GUTS is not a v1 target.
