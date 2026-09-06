# Reading repo-tour's BuildPlan: shapes that surprised us

What T-4 (the walk) learned by consuming a real `plan.json` rather than the schema
alone. Every claim here is evidence-backed — the evidence is named so the next ticket
can re-check it rather than trust it. The reference plan throughout is sql-gauntlet's
(`<sql-gauntlet>/.repo-tour/build/plan.json`, 61 steps), the only large real plan we
have.

## Line numbers are 1-based and INCLUSIVE

`startLine` / `endLine`, everywhere they appear (`step.target`, every
`scaffold.loadBearing` and `scaffold.boilerplate` range), are 1-based and inclusive —
the number a human sees in the editor gutter.

`vscode.Position` is **0-based**, so every value crossing into the VS Code API needs
`- 1`. An off-by-one here is silent: it highlights and scrolls to the wrong line
without failing any test that only counts ranges.

Four independent confirmations:

- repo-tour `src/build/types.ts` says it outright — *"A 1-indexed, inclusive line
  range — the unit `extract()` already reports symbols in."*
- `schema/build-plan.schema.json` sets `"minimum": 1` on every line field, in both
  `definitions.range` and `step.target`. A 0-based scheme's first line would be `0`.
- repo-tour's own consumers convert: `src/build/stub.ts` keeps a 1-indexed cursor and
  slices `lines.slice(range.startLine - 1, range.endLine)`; `src/interpret.ts`'s
  `numberedSlice` prints `i` as the gutter number while reading `lines[i - 1]`.
- In the real plan, across 35 `target.startLine` values and 122 scaffold ranges, the
  minimum is `1` and there is not a single `0`.

A plan is **regenerated, never repaired in place**, so it can outlive the file it
describes. Clamp converted lines into the document; a negative `vscode.Position` line
throws outright.

## `target.startLine` is present only on `symbol` steps

In the real plan: `symbol` 35/35 have it, `file` 0/21, `shape` 0/5.

So "reveal the step's start line" has no value to use on two of the three step kinds.
T-4's fallback, in order: `target.startLine` → the first `scaffold.loadBearing`
range's `startLine` (repo-tour guarantees those are non-overlapping and sorted, per
`types.ts`, so `[0]` really is the earliest) → line 1. Never an invented number.

## A `shape` step's `target.file` is NOT a file

It is a directory (`public`, `tools`) or the synthetic sentinel `@misc`, which is not
a path at all.

This bites in a specific way: **`fs.existsSync` returns `true` for a directory**, so a
plain existence check says "the file is there" and `vscode.workspace.openTextDocument`
then rejects. It is not a rare edge — 5 of 61 steps in the real plan. Anything gating
"can I open this?" wants `fs.statSync(p).isFile()`, not `existsSync`, and the reveal
path needs a catch regardless.

Left for a later ticket: a `shape` step arguably should not offer *Open the file* at
all, since it is about where things live rather than what is in them. T-4 disables the
button honestly but reuses the "you haven't created this file yet" wording, which is
slightly off for a directory that does exist.

## `loadBearing` is often empty

Only 7 of 21 `file` steps have a non-empty `scaffold.loadBearing`. "Decorates nothing"
is the common case, not a failure. Call `setDecorations(type, [])` anyway — on the same
editor that call *is* the clear.

## The real plan has no interpretation in it

sql-gauntlet's plan ran with `cost.provider: "none"`: every step has exactly one
option, `whySource` is `docstring` (10) or `none` (51) and **never** `interpret`, and
every `witness.sha` is `null`.

So a walk over this particular plan shows no alternatives and no witness sentences.
That is a property of the plan, not a bug in the consumer — do not "fix" it by
inventing data. The `interpret`-with-multiple-options and non-null-witness paths can
only be exercised by a hand-written fixture (`test/unit/walk-fixtures.ts`).

## Duck-type the plan; don't import repo-tour's types

`src/walk/model.ts` and `src/start/build.ts` both mirror a slice of `BuildPlan` as
local `*Like` interfaces rather than `import type`-ing repo-tour's own. repo-tour does
now ship a real `exports` map, so a type-only import would resolve — the reason is
different: the mirror keeps this extension typecheckable with no dependency on
repo-tour's `dist/*.d.ts` being present, and needs no edit when repo-tour's types grow
a field this extension never reads.

## The development host does not honour `capabilities.untrustedWorkspaces`

Learned while verifying T-4's workspace-trust fix, and worth knowing before anyone tests one
the easy way.

Launched with `--extensionDevelopmentPath` against an **untrusted** folder, the extension
activated and the walk ran — the status bar read `step 1 / 61 · manual` while VS Code showed
"Restricted Mode" in the same bar. Installing the packaged `.vsix` into a throwaway
`--extensions-dir` and opening the same untrusted folder showed the opposite, correctly: no
walk, no activity-bar container, extension disabled.

This is expected VS Code behaviour — a developer running their own extension has already
trusted it — but the consequence is sharp: **a workspace-trust protection can never be
verified from the dev host.** Test it by installing the real artifact, or you will conclude a
working guard is broken.

## Open, and it belongs to repo-tour rather than here (found by T-4's security review)

Our render caps defend against this; they do not fix it, and the fix belongs upstream.

- **`parseAlternatives` caps neither count nor length** (`repo-tour/src/interpret.ts`). Its
  sibling `parseAnswer` clamps `summary` to 400 characters and nothing else does. A
  prompt-injected docstring can therefore steer a model into emitting thousands of very long
  alternatives, which land in `plan.json` and are rendered synchronously by whatever consumes
  it. This is the ONE path that VS Code's Workspace Trust does not gate, because the victim
  never opens the attacker's repo — they point the start screen at its URL and we clone it.
- **`foldMeaning`** (`repo-tour/src/build/interpret.ts`) passes `why` through unclamped.
- **The interpret cache** (`<pkg>/.cache/interpret`, shared across every repo ever scanned) is
  read back with only `if (!cached.summary)` / `Array.isArray` guards, so a corrupt entry can
  put non-string values into `option.label` and `decision.why`. That is what makes the
  "plan fields might not be strings" defence in this extension load-bearing rather than
  paranoid.

Consuming code should keep treating plan text as untrusted and unbounded regardless of what
repo-tour does about this — but a cap at the producer is worth a ticket on repo-tour's board.
