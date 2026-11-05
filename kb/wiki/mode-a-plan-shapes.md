# A derived (Mode A) plan: what it holds, where its code lives, how to drive it in a test

What T-17 (the derivation engine, `src/derive/`) produces and the next tickets consume: T-18 asks
before showing, T-19 is the AC-A1 harness, T-20 is the start screen path, and T-22 is the replan
inside a live walk. Read it alongside [repo-tour-plan-shapes.md](repo-tour-plan-shapes.md), which
covers the Mode B plan it imitates. Every claim names the test that pins it.

## The plan is repo-tour's own shape, with Mode A's own truths

It validates against repo-tour's REAL `schema/build-plan.schema.json`
(`test/unit/derive-assemble.test.ts`, `derive-engine.test.ts`), and the existing walk renders it
unchanged in a real dev host (`test/derive.test.ts`).

- `source: { kind: 'idea', text }`, `mode: 'idea'`, `reproduce: []`.
- **`shape` and `file` steps only.** A chapter is a directory. Its shape step comes first and
  targets that directory; every file step lies inside it and depends on it.
  - There are no `symbol` steps, because a Mode A step must offer a real choice.
  - Scaffolded mode still works: `stubQuestionsFor` falls back to the file step's own question.
- **Options:** two to four.
  - The engine's recommendation is `taken` and is `authorChoice`.
  - `chosen` is the learner's answer, or `null`.
  - **There is no author**, so the step panel's "the author's choice" wording is wrong for Mode A.
    Changing it is T-18's job.
- `whySource: 'interpret'` always: a model's `why` is never passed off as the author's own words.
  `witness` is all `null`.
- **Step ids hash the decision** (kind, path, question and option labels), not the answer and not
  the code. Answering keeps a step's id; a replanned decision gets a new one
  (`derive-assemble.test.ts`).
- **Scaffold ranges** come from the derived file's own exported symbols: at most five,
  non-overlapping, widest through a clash. The rest of the file is boilerplate.
- **Languages:** JavaScript as `.mjs` (ES modules, which Node runs with no `package.json`) and
  Python as `.py`, standard library only. A JavaScript bare import must be a Node built-in. A
  derived app needs no install to start (`derive-smoke.test.ts`).

## The code lives outside the learner's folder

- **The reference tree:** `<globalStorage>/derived/<tutorial key>/<slug>-<content key>/`.
  - It is written whole (staged, then renamed into place) and **never modified**. A replan writes a
    NEW tree, and the old one keeps its bytes (`derive-tree.test.ts`, `derive-engine.test.ts`).
  - The tutorial key hashes the target folder; the content key hashes the files.
- **What the walk reads:** a Mode A tutorial's `request.json` is
  `{ idea, recreate: false, repo: '', target, dial, referenceRoot: <the tree> }`. The existing
  `loadRequest` accepts it as it stands: `repo` must be a string, and `referenceRoot` wins when it
  names a directory.
- **The cache:** `<globalStorage>/derive-cache/<sha256>.json` holds the model's RAW reply, keyed
  by `DERIVE_PROMPT_VERSION` plus the full prompt.
  - It is re-parsed by the same parser on every read, and only a reply that parsed is ever written.
  - It is what makes the engine deterministic: the second derivation of the same idea and answers
    makes **zero calls** (`derive-engine.test.ts`).

## The two entry points (`src/derive/engine.ts`)

- `derivePlan({ idea, answers }, deps)` is T-20's and T-19's.
- `replanPlan(state, stepId, answer, prefixStepIds, deps)` is T-18's and T-22's.
  - It keeps the prefix and every step the decision does not reach verbatim, code included.
  - It re-derives the rest of the decision's downstream, and never modifies the `state` it was
    handed.
- `derivePlan` folds the same internal step over the answers in plan order, so **one call equals a
  walk of calls**, byte for byte (AC5's test).
- `DerivationState` (idea, title, language, entry, chapters, nodes, files, answers) is plain data.
  It is what T-22's plan versions should keep on disk beside each `plan.json`.
- **A stored state is a second door, and is re-checked.** `replanPlan` runs `unsoundStateReason`
  on the state it is handed: the whole-plan rules, the file-path rule for every file step, and no
  code filed under a path the plan does not have. A tampered version on disk is refused in a
  sentence before anything is asked or written (`derive-engine.test.ts`, the two tampered-state
  tests). T-22 should still treat a version file it reads as untrusted, and never skip this check
  by building a state by hand.

## Driving it in a test without spending a token

- Every derive prompt ends in ONE line, `INPUT (JSON): {…}`, holding every value the call
  depends on, with `task` set to `outline`, `code` or `replan`.
- A scripted fake model parses that line and answers the task. See `fakeModel` and
  `followTheAnswer` in `test/unit/derive-engine.test.ts`: their answers depend on the prompt, so a
  changed answer really changes what comes back.
- Inject the fake through `AskSettings.run` on a real `AskLedger`, with the core's `runLlm`
  poisoned, as `tutor-ask.test.ts` does.
