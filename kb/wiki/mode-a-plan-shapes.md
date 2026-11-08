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
  the code. Answering keeps a step's id; a replanned decision that changes those words gets a new
  one (`derive-assemble.test.ts`). A replan that keeps the words keeps the id even when the code
  changes, so the step's tutor transcript and progress follow it. T-22 should rule on that.
- **Scaffold ranges** come from the derived file's own exported symbols: at most five,
  non-overlapping, widest through a clash. A file that exports nothing (usually the entry point)
  takes its own functions and multi-line variables instead, or scaffolded mode would hand over the
  whole file. The rest of the file is boilerplate.
- **Languages:** JavaScript as `.mjs` (ES modules, which Node runs with no `package.json`) and
  Python as `.py`, standard library only. A JavaScript bare import must be a Node built-in. A
  derived app needs no install to start (`derive-smoke.test.ts`).
  - **Starting one:** JavaScript is `node cli/main.mjs`. Python is started from the top folder as a
    module, `python3 -m cli.main`, and imports a file of the app by its dotted path from there. The
    plan does not carry the command, so T-20 has to know this.
  - **The import check is a correctness check, never a sandbox.** It keeps the plan's graph true
    and the app able to start. A Node built-in can still run a process, and the file runs as the
    learner. What the learner is told about that is T-61. It reads text, so a form it cannot see
    is a limit, not a guarantee, and whether a built-in exists is asked of the editor's Node, which
    may not be the Node the learner runs.

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
  - It is re-judged by the same checks on every read, and only a reply that passed all of them is
    ever written: a code reply that fails repo-tour's parser, or a replan that cannot be merged, is
    asked again on the next press (`derive-engine.test.ts`). A new file is judged only where it
    comes in, against every file the finished tree will hold, so nothing later can refuse a reply
    that was accepted.
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
  on the state it is handed. Every chapter and step goes back through the parser and has to come
  out exactly as it went in, then the whole-plan rules, then the code's bounds, then repo-tour's
  reading of the stored files. A tampered version on disk is refused in a sentence before anything
  is asked or written (`derive-engine.test.ts`'s table of tampered states). A kept file is judged
  against what it declares, so a state the engine made is never refused for a file a later replan
  added. T-22 should still treat a version file it reads as untrusted, and never skip this check by
  building a state by hand.
- **For T-22 to rule on:** a walked step kept against a rewritten decision can leave an app that
  does not start while the plan says `ok`, and a replan's new steps can interleave chapters, so
  Next can step back into an earlier chapter's group (`graph.ts`).
- **What one press can cost is bounded twice:** one question is at most `MAX_DERIVE_PROMPT_CHARS`,
  and a press sends at most `DERIVE_LIMITS.maxCallsPerPress` questions. Past the second it stops and
  says so, and what was answered stays cached, so pressing again carries on (`derive-ask.test.ts`).
- **Pass the model already resolved.** An empty model is refused, but an unrecognised one becomes
  the provider's strongest in `resolveTutorChoice`, so T-20 should resolve it as
  `src/extension.ts`'s `resolveLlmSettings` does.

## Driving it in a test without spending a token

- Every derive prompt ends in ONE line, `INPUT (JSON): {…}`, holding every value the call
  depends on, with `task` set to `outline`, `code` or `replan`.
- A scripted fake model parses that line and answers the task. See `fakeModel` and
  `followTheAnswer` in `test/unit/derive-engine.test.ts`: their answers depend on the prompt, so a
  changed answer really changes what comes back.
- Inject the fake through `AskSettings.run` on a real `AskLedger`, with the core's `runLlm`
  poisoned, as `tutor-ask.test.ts` does.
