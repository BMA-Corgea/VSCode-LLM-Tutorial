# T-7 — The detour — an unrelated worked example, in real tabs, that leaves nothing behind

**Type:** feature · **Shop:** vscode-llm-tutorial · **After:** T-6 · **Intent:** T-1 (`.autodev/specs/T-1-build-tutorials-v1.md` §5.6) · **Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-1).

## The ticket's spec (captured, not re-composed)

WHY: .autodev/specs/T-1-build-tutorials-v1.md §5.6. Evan asked for the concept to be shown 'on a completely unrelated example that we create', and asked the name not be over-indexed on. Working name: detour.

ACs:
1. 'Explain with an unrelated example' on the step panel asks the model (via the core's runLlm) for a self-contained example of the step's concept in a DIFFERENT domain: ≤ 5 files, ≤ 60 lines each, plus 3–6 narration stops, as JSON; the prompt states the concept and the learner's domain so the example avoids it. Check: prompt test; a schema test on the reply.
2. Files are written under globalStorageUri/detours/<stepId>/ — never inside the workspace — and opened as real editor tabs; a narrator webview tab walks the stops with reveal + decoration. Check: the workspace tree hash is unchanged after a detour.
3. 'Back to my build' closes the detour's tabs and narrator, deletes its directory, and restores the step panel at the same step. Check: directory absent; active step unchanged.
4. The step's transcript records 'detour taken: <title>'. Check: progress.json.
5. Cached by step id + prompt version so retaking is free; a failed generation says why in the panel. Check: second run makes no LLM call.

Out of scope
- Runnable detours (a terminal for the example) — deferred: who=agent:pm why=reading a worked example is the ask; running it is a later nicety
- Detours in Mode A — T-9

## Refinement notes (2026-09-05 — drafted against the T-4/T-6 plans; reconcile against merged code before build)

- **An editor tab IS a detour** (spec §5.6): the toy files open as real editor tabs from the extension's global
  storage — `globalStorageUri/detours/<stepId>/` — so the explorer never shows them and the learner's workspace
  tree is untouched by construction. A narrator webview tab (`renderPage`, the same skin contract) walks the
  stops with reveal + decoration, reusing T-4's `editor.ts` helpers.
- **The ask is one core call**, through the same `TutorDeps` seam T-6 builds: a prompt that names the concept
  (the step's question + why), the learner's domain (the reference repo's name and the file's role), and asks
  for a self-contained example in a DIFFERENT domain: ≤ 5 files, ≤ 60 lines each, 3–6 stops, as JSON
  `{ title, domain, files: [{ path, content }], stops: [{ file, startLine, endLine, text }] }`. The reply is
  validated against that shape (a hand-rolled checker, the T-12 style) — a malformed reply is a panel note,
  never a crash, never a half-written detour.
- **Cached by `stepId` + prompt version** under `globalStorageUri/detours/cache/<hash>.json` so retaking is free;
  a "regenerate" button forces a fresh one.
- **Return restores exactly:** closes the detour's tabs (only those — matched by URI under the detour dir),
  disposes the narrator, deletes the directory, and reveals the step the learner left, at the same dial. The
  transcript for that step records `detour taken: <title>` as an assistant-side note (T-6's transcript type
  gains an optional `kind: 'note'` — reconcile with what T-6 shipped).
- **Escalation ladder in the panel:** the tutor section gets a second button beside *Ask* — *Show me an
  unrelated example* — visible always, honest when unreachable (the same reachability line T-6 shows).
- Tests never call a model: an injected runner returns a canned detour JSON.
