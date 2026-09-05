# T-6 — The tutor — sql-gauntlet's pattern through repo-tour's brain, one transcript per step

**Type:** feature · **Shop:** vscode-llm-tutorial · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §5.5) · **Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-1).

## The ticket's spec (captured, not re-composed)

WHY: .autodev/specs/T-1-build-tutorials-v1.md §5.5. Evan: 'I can ask a tutor (like sql-gauntlet) if it doesn't make sense.' DEPENDS ON repo-tour T-13 (AskContext.build).

ACs:
1. A chat under the step panel; sending builds the prompt with the core's buildAskPrompt(messages, ctx) where ctx carries the step (question, options, why), the reference file's meaning, and the unified diff of the learner's current file against the reference. Check: unit test on the context block contents.
2. One transcript per step, persisted in progress.json; switching steps switches transcripts; returning restores. Check: state test.
3. Runs through the core's runLlm with the provider/model the core resolves (claude CLI by default); the choice is a setting mirroring repo-tour's. Check: a stubbed provider in tests.
4. Honest when unreachable: with no provider available the panel says so immediately and never shows a spinner that does not end. Check: test with resolveBin returning null.
5. Answers render code fences and nothing else as markup (repo-tour's askpanel rule: a model emitting stray angle brackets cannot rewrite the page). Check: escaping test.

Out of scope
- The detour — T-7
- Capturing a tutor exchange as a note — deferred: who=agent:pm why=notes are a repo-tour surface; not asked for here

## Refinement notes (2026-09-05 — drafted against T-4's PLAN; reconcile against T-4 + T-5's merged code before build)

- **Sequenced after T-5**, not in parallel with it: both edit the step panel, its protocol and the session. The
  tracker's `--after T-4` stands; the orchestrator spawns this only once T-5 has merged.
- **The tutor lives in the step panel** — a section under the step: the transcript, an input, *Ask*. One
  transcript per step in `progress.steps[id].transcript` (`AskMessage[]`, saved atomically), so switching steps
  switches transcripts and returning restores.
- **Context is built by the core, not re-invented.** `ask.buildAskPrompt(messages, ctx)` with `ctx = { repo:
  <reference name>, file: step.target.file, fileMeaning: step.decision.why, stopTitle: question, stopText: the
  options rendered as text, build: { question, options, why, learnerDiff } }` — `AskContext.build` is what
  repo-tour T-13 added for exactly this. `learnerDiff` = `git diff --no-index <ref file> <target file>` through
  the same git runner T-5 uses (empty when the learner has not created the file yet; say so in the block).
- **Runs through the core's LLM layer:** `llm.resolveChoice({ provider, model })` from the settings T-3 added,
  then `llm.runLlm(prompt, choice, cwd, timeoutMs)`; the extension never spawns `claude` itself. Tests inject a
  runner (`TutorDeps.run`) — never a real model.
- **Honest when unreachable, immediately:** before the first ask in a session, `llm.providerById(provider).available()`;
  if not ok, the panel shows the reason where the input is and disables nothing silently (the input stays, the
  reply is the reason). A running ask shows "thinking…" with a cancel; a timeout is a reply, not a hang.
- **Rendering:** escape everything; honour code fences only (repo-tour's `askpanel.ts` rule). Persona untouched.
- The transcript is trimmed the way repo-tour trims (`ask.trimMessages`) before it is sent.
