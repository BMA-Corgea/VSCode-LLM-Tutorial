// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one place this extension talks to a model (spec §5.5, AC3 and AC4).
 *
 * Everything else in the tutor is bookkeeping around this file: `context.ts` decides what the
 * model is told, `transcript.ts` decides what is remembered, `step-view.ts` decides how the
 * answer is drawn. This module does the thing none of them do — it asks, waits, and comes
 * back with an answer a panel can render without knowing what a provider is.
 *
 * ## This is the first module in the extension that spends the learner's money
 *
 * Nothing before T-6 cost a penny. The build (T-3) is repo-tour's spend, run once, in
 * repo-tour's own process; the dial's *Check my work* (T-4) is a tree-sitter parse and was
 * deliberately kept that way — `src/dial/check.ts`'s header argues at length against stapling
 * a model call to a green tick. Every button press that lands here, by contrast, bills
 * somebody. Three consequences run through this file:
 *
 * 1. **The runner is a seam, always.** `TutorDeps.run` exists so a test can supply the
 *    answer, and `test/unit/tutor-ask.test.ts` poisons `core.runLlm` so that a suite which
 *    forgot to inject one FAILS rather than quietly dialling out. If something here can only
 *    be tested against a live provider, the design is wrong — fix the design, do not spend.
 * 2. **The cost comes back with the answer.** `LlmReply` carries `inputTokens`,
 *    `outputTokens`, `usd` and `metered`, and `AskOutcome.reply` carries all four onward
 *    rather than dropping them at the door. `metered: false` means those zeros are UNKNOWN,
 *    not free (see `./core.ts` and repo-tour's `src/llm.ts`, which is emphatic about it):
 *    a provider that cannot report what it spent says so with a flag, and nothing downstream
 *    of here may render "$0.00" as though the answer were a gift.
 * 3. **No accidental second call.** One ask is one `run`. There is no retry, no fallback
 *    provider, no "try the cheaper model first" — a failure is reported, and the learner
 *    decides whether to pay for another attempt.
 *
 * ## Availability first, and immediately (AC4)
 *
 * `askTutor` probes `core.availability(provider)` BEFORE it builds a prompt and before it
 * reaches for a runner, and an unavailable provider returns `{ kind: 'unreachable' }` with
 * the provider's own sentence — "not found on PATH", "no such provider: nope" — carried
 * through verbatim rather than replaced by a house phrasing that says less.
 *
 * The AC is about a spinner, not about a probe: *the panel says so where the input is, and
 * never shows a spinner that does not end*. Ordering is what buys that. If the probe came
 * after the send, a machine with no `claude` on it would show "thinking…" for as long as it
 * took the provider to fail, then a failure that reads like the model's fault. Probing first
 * means the honest answer arrives in the time it takes to `access()` a file, and the panel
 * never enters the thinking state at all. It is also why `checkReachable` is exported
 * separately: the panel can ask on open, before the learner has typed anything.
 *
 * `checkReachable` never throws. A core that failed to load, a provider whose probe explodes
 * — both are "unreachable, and here is why", because a rejected promise on this path becomes
 * a spinner that does not end, which is the exact thing AC4 forbids.
 *
 * ## A timeout is a reply, not a hang
 *
 * `runLlm` is handed `deps.timeoutMs` and repo-tour's own `runProcess` will kill its child on
 * that deadline — but this module does not rely on it, and races the call against its own
 * timer. Two reasons. An injected runner has no timer at all, so without the race the unit
 * suite could not pin this behaviour without a real provider. And a provider whose child has
 * wedged in a state where its own `setTimeout` never fires would hang the panel forever;
 * "the model is slow" is a normal event in a tutorial and must always terminate in a sentence
 * the learner can read. `afterMs` is measured rather than assumed, in the same spirit as the
 * usage figures: it is how long the learner actually waited.
 *
 * The clock starts at the SEND, not at the top of `askTutor`. The availability probe can shell
 * out to `claude --version` with a fifteen-second budget of its own, and charging that to the
 * tutor's deadline would silently shorten every ask on a slow machine.
 *
 * ## Nothing here ever rejects
 *
 * `askTutor` resolves, always — `reply`, `unreachable`, `timedOut` or `failed`. It is driven
 * from a webview message handler, which is to say from an event with no `await` above it and
 * nobody to catch anything: an escaping rejection there is an unhandled rejection in the
 * extension host and a panel stuck on "thinking…". So every throw becomes a `failed` carrying
 * the reason, and the rejection handler is attached to the run promise at the moment it is
 * created rather than left to `Promise.race` — a call that rejects a second AFTER its deadline
 * has already lost the race still has a listener, and so is still not unhandled.
 *
 * ## Cancelling detaches; it does not kill
 *
 * This was the risk the plan told us to write ahead of, and reading `src/llm.ts` settled it:
 * repo-tour's `killLlmChildren()` kills **every** live child, not one. It exists for shutdown
 * — the server restarts itself on source changes and cannot leave model calls holding the
 * process open — and it has no notion of "this ask". A build's `interpretPlan` spawns children
 * through the same registry, so a learner pressing *Cancel* on a tutor question while a build
 * ran in the background would kill the build. That is a far worse outcome than waiting.
 *
 * So this module does not call it, and does not pretend to. `startAsk` returns an `AskRun`
 * whose `detach()` disconnects the UI from a request that is **still finishing**: the panel
 * leaves the thinking state at once, `delivered` resolves to `null`, and the answer — when it
 * eventually arrives, is charged for, and is discarded — can never reach the transcript. That
 * last part is the safety property worth stating plainly: a detached ask must not surface
 * later and answer a question the learner already walked away from. `delivered` is a one-shot
 * promise resolved by whichever comes first, so a late outcome has nowhere to land.
 *
 * It is honest rather than convenient, and the panel should say what it means: the model is
 * still finishing, and you will still be billed for it. A cancel that silently kept costing
 * money without saying so would be the dishonest version of the same mechanism.
 *
 * ## What is deliberately NOT here
 *
 * No `vscode` import — this compiles into the plain-mocha unit bundle, which marks
 * `repo-tour` and `mocha` external but NOT `vscode`, so a single import would break the whole
 * build (same rule as `src/dial/check.ts`, `src/dial/commit.ts`, `src/start/build.ts`).
 *
 * No clipping, no escaping, no persistence. A model reply is unbounded text and it does get
 * the announced-truncation treatment the rest of the panel gives long text — but in
 * `step-view.ts`, next to `MAX_PLAN_TEXT` and `TRUNCATION_MARKER`, where the caps already
 * live and where the escaping rule (AC5: code fences and nothing else as markup) is enforced.
 * Transport does not get to decide what a sentence is worth; it hands over exactly what the
 * provider said.
 *
 * **The model is resolved as a TUTOR's, not as the build's.** repo-tour ships
 * `resolveTutorChoice` alongside `resolveChoice` and keeps the two settings apart on purpose;
 * its T-18 Q5 added it on the argument that inheriting the build's model for the one thing the
 * reader talks to was the complaint. The asymmetry is if anything sharper here: the build model
 * is chosen for what interpreting a whole repository costs, once, in the background, while an
 * ask is one question from one learner at the moment they are already stuck. Unset therefore
 * means the provider's STRONGEST model, and `deps.model` is the tutor's own setting — see
 * `buildTutorials.tutorModel` in `src/extension.ts`, which is deliberately separate from
 * `buildTutorials.llmModel`.
 */

import type {
  AskContext,
  AskMessage,
  Availability,
  LlmChoice,
  LlmReply,
  TutorCore,
} from './core.js';

/**
 * Everything an ask needs, and nothing that knows about editors.
 *
 * Assembled once in `src/extension.ts` from the resolved settings and handed down, the same
 * way `WalkAdapters` reaches `session.ts` — so this module, like the session, imports no
 * `vscode` and can be driven entirely from a unit test.
 */
export interface TutorDeps {
  core: TutorCore;
  /** provider id as the learner's settings have it; `core.availability` is asked about THIS. */
  provider: string;
  model: string;
  /** the learner's target folder — what the provider is run in, never the reference repo */
  cwd: string;
  timeoutMs: number;
  /** Injected in tests. NOTHING in any suite may reach a real model. */
  run?: TutorCore['runLlm'];
}

/**
 * What one answer cost.
 *
 * Carried rather than summed: this module sees a single reply, and whoever wants a running
 * total for a step or a walk adds them up where the transcript is kept. `metered: false` means
 * the three numbers are unknowns the provider could not report — never a free answer, and
 * never to be rendered as one.
 */
export interface AskCost {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  metered: boolean;
}

/**
 * The four things that can come back, and there is no fifth.
 *
 * A discriminated union rather than `{ text, error? }` because the panel draws each of these
 * differently and must not be able to forget one: an answer is a transcript turn, while
 * `unreachable`, `timedOut` and `failed` are notes ABOUT the conversation rather than turns in
 * it (the plan's step 4 makes that call explicitly — `AskMessage` stays pure). Losing that
 * distinction is how a model's failure ends up stored as something the tutor said.
 */
export type AskOutcome =
  | { kind: 'reply'; text: string; cost: AskCost }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'timedOut'; afterMs: number }
  | { kind: 'failed'; detail: string };

/** A thrown anything, as one line a person can read. Mirrors `src/core.ts`'s `errorMessage`. */
function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.trim();
  return trimmed || 'the provider failed without saying why';
}

/** Only the four fields we promise, so nothing a provider invents rides along uninspected. */
function costOf(reply: LlmReply): AskCost {
  return {
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
    usd: reply.usd,
    metered: reply.metered,
  };
}

/**
 * Can this learner's chosen provider run here, right now — and if not, what should they read?
 *
 * Exported on its own so the panel can ask when the step opens rather than when the learner
 * presses *Ask*: the reachability line belongs next to the input from the start (AC4). Never
 * throws; a probe that explodes is `{ ok: false }` with the explosion as its detail, because
 * the alternative on this path is a spinner with nothing behind it.
 */
export async function checkReachable(deps: TutorDeps): Promise<Availability> {
  try {
    return await deps.core.availability(deps.provider);
  } catch (err) {
    return { ok: false, detail: detailOf(err) };
  }
}

/**
 * Ask the tutor one question and come back with something the panel can draw.
 *
 * Order matters and is the AC: availability, then prompt, then send, then the race. See this
 * file's header for why each step is where it is. Resolves in every case — the caller is a
 * message handler, and there is nobody above it to catch a rejection.
 */
export async function askTutor(
  deps: TutorDeps,
  ctx: AskContext,
  messages: AskMessage[],
): Promise<AskOutcome> {
  const availability = await checkReachable(deps);
  if (!availability.ok) return { kind: 'unreachable', detail: availability.detail };

  let prompt: string;
  let choice: LlmChoice;
  try {
    // `trimMessages` is a validator as much as a trimmer and returns fresh objects, so the
    // caller's transcript — the array that is about to be SAVED — is never touched. The
    // trimming applies to what is sent and to nothing else: the stored conversation keeps
    // every turn, and only the prompt is cut to the last thirty.
    prompt = deps.core.buildAskPrompt(deps.core.trimMessages(messages), ctx);
    // `resolveTutorChoice`, NOT `resolveChoice`. repo-tour keeps the two apart on purpose and
    // its own reasoning transfers exactly: the build model is chosen for what interpreting a
    // whole repository costs, once, in the background — and inheriting that for the one thing
    // a stuck person actually talks to is the complaint its Q5 answered. Unset means the
    // provider's STRONGEST model, which is the right way round here: an ask is one question,
    // for one learner, at the moment they are already confused, and a cheap wrong answer
    // there costs far more than the tokens it saved.
    choice = deps.core.resolveTutorChoice(
      { provider: deps.provider, model: deps.model },
      deps.core.resolveChoice({ provider: deps.provider }),
    );
  } catch (err) {
    return { kind: 'failed', detail: detailOf(err) };
  }

  // Called THROUGH the core rather than plucked off it. `deps.core` is a duck-typed object
  // assembled by `./core.ts` from a dynamically imported module, and a member torn loose from
  // its owner is a `this` bug waiting for the day somebody hands us a core built from a class.
  const send: TutorCore['runLlm'] =
    deps.run ?? ((text, sendTo, dir, ms) => deps.core.runLlm(text, sendTo, dir, ms));
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Both handlers are attached HERE, not after the race: a call that rejects after losing
    // to the deadline still has a listener and so is still not an unhandled rejection.
    const answered: Promise<AskOutcome> = send(prompt, choice, deps.cwd, deps.timeoutMs).then(
      (reply): AskOutcome => ({ kind: 'reply', text: reply.text, cost: costOf(reply) }),
      (err): AskOutcome => ({ kind: 'failed', detail: detailOf(err) }),
    );
    const expired = new Promise<AskOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'timedOut', afterMs: Date.now() - startedAt }),
        deps.timeoutMs,
      );
    });
    return await Promise.race([answered, expired]);
  } catch (err) {
    // A runner that throws synchronously — or returns something that is not a promise — never
    // gets as far as the race. Same answer as any other failure.
    return { kind: 'failed', detail: detailOf(err) };
  } finally {
    // Not `unref`ed: an unreferenced deadline can let the process exit before it fires, which
    // would turn "a timeout is a reply" back into "nothing happened".
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * An ask the learner can walk away from.
 *
 * `askTutor` is the whole contract for a caller who will wait; this is the same call for the
 * panel, which must be able to stop waiting. `detach()` is NOT a kill — see the header — it
 * severs delivery: `delivered` resolves to `null` immediately, `detached` flips so the panel
 * can say the model is still finishing, and the real outcome, whenever it arrives, has
 * nowhere to go. That is the guarantee worth having: an answer to a cancelled question can
 * never appear in the transcript minutes later.
 */
export interface AskRun {
  /**
   * The outcome, or `null` if the learner detached first. `null` means "there is nothing to
   * deliver" — never "the model said nothing", which is a `reply` with empty text.
   */
  readonly delivered: Promise<AskOutcome | null>;
  /** True once detached. The request may well still be running, and still costing money. */
  readonly detached: boolean;
  /** Idempotent, and harmless after the answer has already been delivered. */
  detach(): void;
}

/** Start an ask the panel can detach from. See `AskRun`. */
export function startAsk(deps: TutorDeps, ctx: AskContext, messages: AskMessage[]): AskRun {
  let detached = false;
  let deliver: (outcome: AskOutcome | null) => void = () => undefined;
  const delivered = new Promise<AskOutcome | null>((resolve) => {
    deliver = resolve;
  });

  // `askTutor` is contracted never to reject; the rejection arm is belt-and-braces so that a
  // future edit to it cannot turn this into an unhandled rejection nobody is listening for.
  void askTutor(deps, ctx, messages).then(
    (outcome) => {
      if (!detached) deliver(outcome);
    },
    (err: unknown) => {
      if (!detached) deliver({ kind: 'failed', detail: detailOf(err) });
    },
  );

  return {
    delivered,
    get detached() {
      return detached;
    },
    detach() {
      if (detached) return;
      detached = true;
      deliver(null);
    },
  };
}
