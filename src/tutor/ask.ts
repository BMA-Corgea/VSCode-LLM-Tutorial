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
 * ## `AskLedger` is the answer to "what stops a runaway billed request"
 *
 * A name, not a list. The first review of this file found five separate defects — a live
 * request with no control to stop it, a `NaN` deadline firing instantly while the request
 * billed on, a cancel-then-ask leaving two requests running with nothing said about the second
 * bill, an uninterruptible off-camera pre-flight, and an `AskCost` computed on every reply and
 * rendered nowhere. They were one absence seen from five doors: `AskRun` is per-ask, and
 * nothing owned the set of live runs, the validated bound, the directory they launch in, or
 * what they had cost.
 *
 * `AskLedger` owns all four, `AskTicket` is one ask from the button press to the last byte,
 * and nothing in `src/` starts a paid request any other way — `startAsk` is the primitive the
 * ledger composes, not an entry point. So `spend()` is complete by construction rather than by
 * everybody remembering to report, and `abandonAll()` is one control that reaches every live
 * request from anywhere in the walk.
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  /**
   * The directory the provider process is STARTED IN — a neutral scratch directory, and never
   * the learner's folder (security review finding 3).
   *
   * It used to be `this.target`, with a comment saying so proudly, and the reasoning was
   * backwards: the provider is an AGENT CLI, and an agent CLI reads its configuration out of
   * the directory it starts in. T-5's `reproduceFiles` copies every `plan.reproduce` entry
   * from an untrusted reference repo into that folder with no name allowlist, and repo-tour's
   * own inventory classifies a reference repo's `.claude/settings.json` and `.mcp.json` as
   * `data` — so `plan.reproduce` really does deliver agent configuration into the exact
   * directory the ask was being launched from.
   *
   * `cwd` buys the ask NOTHING: the whole prompt goes in on stdin, `--allowedTools ''` is set
   * on every path, and no answer depends on where the process started. So it is now
   * `AskLedger`'s to choose — see `AskLedger.scratchDir` — and `AskSettings` deliberately
   * does not carry it, so no caller can hand this a folder somebody else can write into.
   */
  cwd: string;
  timeoutMs: number;
  /** Injected in tests. NOTHING in any suite may reach a real model. */
  run?: TutorCore['runLlm'];
}

/**
 * Everything an ask needs EXCEPT where the process runs.
 *
 * The one field held back is `cwd`, and holding it back is the point: it belongs to the
 * `AskLedger`, which is the only thing that starts a paid request, so a caller assembling
 * settings from the learner's own configuration cannot pick the directory an agent CLI will
 * read its configuration out of. See `TutorDeps.cwd`.
 */
export type AskSettings = Omit<TutorDeps, 'cwd'>;

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
  /**
   * `cost` is present exactly when the provider answered, was paid, and the answer turned out
   * to be something this panel cannot show anybody — today that is one case, a `FETCH:` line
   * (see `FETCH_UNIMPLEMENTED_DETAIL`). A billed request whose answer is discarded still cost
   * the learner money, and the ledger counts it: dropping the figure because the reply was
   * unusable would be the same dishonesty as rendering `$0.00`.
   */
  | { kind: 'failed'; detail: string; cost?: AskCost };

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

// ── The deadline, bounded where it is USED (code review 9 / security review 9) ─────────────

/**
 * The bounds on a number that is about to become a `setTimeout`, in milliseconds — enforced
 * HERE, at the one place a deadline is handed to a provider, rather than where the setting is
 * read.
 *
 * That placement is the whole fix. `src/extension.ts`'s `tutorSettingsNow` did
 * `Math.max(5, config.get<number>('tutorTimeoutSeconds', 120)) * 1000` with no type check, and
 * `Math.max(5, "two minutes")` is `NaN`: `setTimeout(…, NaN)` fires IMMEDIATELY, so every ask
 * instantly "timed out" while the request went on running and billing. `package.json` had the
 * same hole at the other end — it declared `minimum: 5` and no maximum, and past ~2,147,483
 * seconds the product overflows a 32-bit signed integer, Node clamps the timer to 1 ms, and
 * every ask reports "timed out" in a millisecond while the model runs on (measured:
 * `999999999` → `timedOut` after 1 ms). `package.json` now declares both bounds, which is what
 * stops a learner typing one; this is what stops any of it reaching a timer — from a settings
 * file VS Code did not validate, from a test, or from an entry point nobody has written yet.
 *
 * **These are bounds on GARBAGE, not the learner's policy, and the difference matters.** The
 * learner's floor is `package.json`'s `minimum: 5` and `tutorSettingsNow`'s `Math.max(5, …)`,
 * which is a statement about what is a sensible thing to wait; a caller with a good reason to
 * race a 20-millisecond deadline (the unit suite, which must pin the race without waiting five
 * seconds for it) is not making a mistake, and clamping them up to a policy minimum would be
 * this module deciding a question that is not its own. What is never legitimate is a deadline
 * that is not a number, one that has already passed, or one big enough to wrap an `int32` —
 * and all three produce the same symptom, an ask that "times out" instantly while the request
 * runs on and bills.
 *
 * The ceiling is one hour: far past any question worth waiting for, and three orders of
 * magnitude short of the overflow.
 */
export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 3_600_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A deadline a `setTimeout` can be trusted with: a finite, positive number of milliseconds no
 * larger than `MAX_TIMEOUT_MS`.
 *
 * Anything that is not one — a string, `NaN`, `Infinity`, zero, a negative, `undefined` from a
 * configuration file somebody hand-edited — becomes `DEFAULT_TIMEOUT_MS` rather than being
 * coerced, because there is no honest reading of `"two minutes"` and a silently coerced `NaN`
 * is exactly how this got shipped.
 */
export function boundedTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(raw)));
}

// ── The FETCH protocol the persona promises and this consumer does not have ────────────────

/**
 * repo-tour's `ASK_PERSONA` tells the model it may reply with a single `FETCH: file <path>`
 * line and that *"It is fetched for you and you are asked the question again."* This extension
 * makes exactly one `runLlm` call and implements no fetch loop, so a model that chooses to look
 * something up has its plumbing rendered at the learner as the tutor's answer (security review
 * finding 10). Carrying an unimplemented protocol is the "confidently stale sentence" failure
 * this codebase names everywhere else.
 *
 * `buildAskPrompt` hardcodes the persona, so the section is replaced in the built prompt rather
 * than at its source: the heading is kept (an earlier bullet cross-references it by name) and
 * its contents are replaced with the truth. Best-effort by design — if repo-tour rewords the
 * persona the heading is simply not found and the prompt goes out untouched, which is why the
 * REPLY is checked as well. Two independent halves: say it in the prompt, and refuse to draw
 * the plumbing if a model says it anyway.
 */
const FETCH_HEADING = 'Looking things up:';

const NO_FETCH_SECTION = [
  FETCH_HEADING,
  '- You cannot, here. This tutor makes exactly ONE call and implements no fetch protocol:',
  '  nothing you ask for is fetched, and you are not asked again. A FETCH line would be shown',
  '  to the reader as your answer.',
  '- So answer from what you were given, and when that is not enough say plainly what you',
  '  could not see. "I cannot tell from what I can see here" is a useful answer.',
].join('\n');

/** Replace the persona's fetch section with the truth. Never throws; returns the prompt
 *  unchanged when the section is not where it was. */
export function withoutFetchProtocol(prompt: string): string {
  const heading = prompt.indexOf(`\n${FETCH_HEADING}\n`);
  if (heading < 0) return prompt;
  const from = heading + 1;
  const end = prompt.indexOf('\n\n', from);
  if (end < 0) return prompt;
  return prompt.slice(0, from) + NO_FETCH_SECTION + prompt.slice(end);
}

/** What the learner reads when the model asked for a file instead of answering. Honest about
 *  whose limitation it is, and about the money, because the request was still paid for. */
export const FETCH_UNIMPLEMENTED_DETAIL =
  'the tutor asked to look a file up, and this panel has no way to fetch one. '
  + 'That request was still charged for. Ask again, and name the file or the code you want it to look at.';

/**
 * Is this reply the fetch protocol's machinery rather than an answer?
 *
 * Mirrors repo-tour's own `parseFetchRequest` — one line, optionally fenced, `FETCH:` then
 * `file` or `search` then something — rather than importing it, because `TutorCore` is the
 * pinned slice of repo-tour this extension depends on and growing it for a protocol this
 * extension does not implement would be the wrong direction. Deliberately narrow: anything
 * with a second line, or a sentence around the marker, is a real answer that happens to
 * mention `FETCH` and is drawn as one.
 */
export function isFetchRequestReply(text: string): boolean {
  let body = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(body);
  if (fenced) body = (fenced[1] ?? '').trim();
  if (body.includes('\n')) return false;
  return /^FETCH:\s*(?:file|search)\s+\S/i.test(body);
}

/**
 * Can this learner's chosen provider run here, right now — and if not, what should they read?
 *
 * Exported on its own so the panel can ask when the step opens rather than when the learner
 * presses *Ask*: the reachability line belongs next to the input from the start (AC4). Never
 * throws; a probe that explodes is `{ ok: false }` with the explosion as its detail, because
 * the alternative on this path is a spinner with nothing behind it.
 */
export async function checkReachable(deps: Pick<TutorDeps, 'core' | 'provider'>): Promise<Availability> {
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
    // `withoutFetchProtocol` is applied to the BUILT prompt because `buildAskPrompt` hardcodes
    // `ASK_PERSONA` and takes no persona of its own. See there: the persona promises a fetch
    // loop this extension does not have, and a promise nobody can keep is a sentence that gets
    // rendered at the learner as an answer.
    prompt = withoutFetchProtocol(deps.core.buildAskPrompt(deps.core.trimMessages(messages), ctx));
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
  // Bounded HERE as well as in `AskTicket.send`, so `askTutor` called directly — by a test, or
  // by whatever calls it next — cannot arm a `setTimeout` with `NaN` either. The provider is
  // handed the same bounded number, so its own deadline and this module's race agree.
  const deadline = boundedTimeoutMs(deps.timeoutMs);
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Both handlers are attached HERE, not after the race: a call that rejects after losing
    // to the deadline still has a listener and so is still not an unhandled rejection.
    const answered: Promise<AskOutcome> = send(prompt, choice, deps.cwd, deadline).then(
      (reply): AskOutcome => {
        const cost = costOf(reply);
        // The reply is the fetch protocol's plumbing rather than an answer (security review
        // finding 10). It is NOT stored and NOT drawn as something the tutor said — but the
        // cost rides out with the refusal, because the learner was billed for it either way.
        if (isFetchRequestReply(reply.text)) {
          return { kind: 'failed', detail: FETCH_UNIMPLEMENTED_DETAIL, cost };
        }
        return { kind: 'reply', text: reply.text, cost };
      },
      (err): AskOutcome => ({ kind: 'failed', detail: detailOf(err) }),
    );
    const expired = new Promise<AskOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'timedOut', afterMs: Date.now() - startedAt }),
        deadline,
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
  /**
   * What the request ACTUALLY did, whether or not anybody was still waiting for it.
   *
   * `delivered` answers "what does the panel get"; this answers "what was paid for", and after
   * a detach the two diverge: `delivered` is already `null` while this one is still running,
   * still billing, and resolves when the call really ends. It is what `AskLedger` counts, so
   * that a question the learner walked away from still shows up in what the walk has spent.
   *
   * Never rejects, for the same reason `delivered` never does.
   */
  readonly finished: Promise<AskOutcome>;
  /** True once detached. The request may well still be running, and still costing money. */
  readonly detached: boolean;
  /** Idempotent, and harmless after the answer has already been delivered. */
  detach(): void;
}

/**
 * Start one ask the panel can detach from. See `AskRun`.
 *
 * The PRIMITIVE, not the entry point: nothing in `src/` calls this directly any more.
 * `AskLedger.open(...).send(...)` is the way a paid request starts, because a run on its own
 * knows nothing about the other runs, about the bound on its deadline or about what it cost —
 * see `AskLedger`, which owns all three.
 */
export function startAsk(deps: TutorDeps, ctx: AskContext, messages: AskMessage[]): AskRun {
  let detached = false;
  let deliver: (outcome: AskOutcome | null) => void = () => undefined;
  const delivered = new Promise<AskOutcome | null>((resolve) => {
    deliver = resolve;
  });

  // `askTutor` is contracted never to reject; the rejection arm is belt-and-braces so that a
  // future edit to it cannot turn this into an unhandled rejection nobody is listening for.
  // Attached HERE, at the moment the promise is created, so nothing downstream can leave a
  // late rejection unhandled.
  const finished: Promise<AskOutcome> = askTutor(deps, ctx, messages).then(
    (outcome) => outcome,
    (err: unknown): AskOutcome => ({ kind: 'failed', detail: detailOf(err) }),
  );
  void finished.then((outcome) => {
    if (!detached) deliver(outcome);
  });

  return {
    delivered,
    finished,
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

// ── The ledger: the one thing that owns a live paid request ────────────────────────────────

/**
 * What the walk has spent, and what is spending right now.
 *
 * `AskCost` is one answer's bill; this is the running total plus the state of everything still
 * in the air, which is the half `AskCost` deliberately did not carry ("whoever wants a running
 * total for a step or a walk adds them up where the transcript is kept" — this is that place).
 *
 * `metered` is the honesty flag and it is ANDed across every counted reply: one unmetered
 * answer makes the totals a FLOOR rather than a figure, and a panel that rendered them as a
 * figure would be doing exactly what `AskCost`'s own comment forbids. Zeros with
 * `metered: false` mean UNKNOWN, never free.
 */
export interface AskSpend {
  /** asks in their pre-flight: nothing has been sent, so nothing is billed YET */
  preparing: number;
  /** requests with a provider RIGHT NOW — billing, this second */
  sending: number;
  /** of `sending`, the ones nobody is waiting for any more: cancelled, superseded, disposed.
   *  Still running and still costing money; this is the number that says so. */
  unwatched: number;
  /** replies that came back and were counted — delivered and discarded alike */
  replies: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  metered: boolean;
}

export type AskPhase = 'preparing' | 'sending' | 'closed';

/**
 * One ask, from the button press to the last byte — the unit the ledger keeps.
 *
 * It exists to make "when does an ask begin" answerable in one word: at the PRESS, not three
 * awaits later. `startAsk` covers only the model call, so everything in front of it — the
 * `claude --version` probe (a fifteen-second budget of its own) and the `git diff` — used to
 * run with nothing on screen and a *Cancel* that returned early and said nothing (security
 * review finding 5). A ticket is `preparing` from the moment it is opened, which is what the
 * panel draws and what *Cancel* acts on; `send` moves it to `sending`, which is the first
 * moment anybody is billed.
 */
export interface AskTicket {
  readonly stepId: string;
  readonly phase: AskPhase;
  /** true once `abandon()` has been called — see there */
  readonly abandoned: boolean;
  /**
   * The outcome, or `null`. `null` means "nothing will be delivered here": the learner stopped
   * waiting, or the pre-flight refused before anything was sent.
   */
  readonly delivered: Promise<AskOutcome | null>;
  /**
   * Send it. The pre-flight is over and from here the learner is billed.
   *
   * The ledger completes the settings: the deadline is put through `boundedTimeoutMs` and the
   * `cwd` is the ledger's neutral scratch directory. A second call, or a call on an abandoned
   * ticket, sends nothing — a ticket is one request, and there is no retry.
   */
  send(settings: AskSettings, ctx: AskContext, messages: AskMessage[]): void;
  /**
   * Stop. Idempotent, and safe in every phase.
   *
   * Before `send` this is genuinely a cancellation: nothing was ever sent, so nothing is
   * charged. After `send` it is a DETACH and not a kill — repo-tour's `killLlmChildren()`
   * kills every live child rather than one, so cancelling a tutor question would kill a
   * background build (this file's header argues it in full). The request goes on running and
   * goes on costing money, which is why it stays counted in `AskSpend.unwatched` until it
   * really ends.
   *
   * A refusal calls this too: the pre-flight decided not to ask, and the ticket is over.
   */
  abandon(): void;
}

/** A provider is allowed to report anything; a total is not allowed to become `NaN` because
 *  it did. Anything that is not a finite number counts as zero, which is what `metered:
 *  false` already means: unknown. */
function countable(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

class LedgerTicket implements AskTicket {
  phase: AskPhase = 'preparing';
  abandoned = false;
  readonly delivered: Promise<AskOutcome | null>;
  private deliver: (outcome: AskOutcome | null) => void = () => undefined;
  private run: AskRun | undefined;

  constructor(readonly stepId: string, private readonly ledger: AskLedger) {
    this.delivered = new Promise<AskOutcome | null>((resolve) => {
      this.deliver = resolve;
    });
  }

  send(settings: AskSettings, ctx: AskContext, messages: AskMessage[]): void {
    if (this.phase !== 'preparing' || this.abandoned) return;
    this.phase = 'sending';
    const run = startAsk(
      { ...settings, cwd: this.ledger.scratchDir(), timeoutMs: boundedTimeoutMs(settings.timeoutMs) },
      ctx,
      messages,
    );
    this.run = run;
    void run.delivered.then((outcome) => { this.deliver(outcome); });
    // `finished`, not `delivered`: a cancelled question is still a bill, and it stays open in
    // the ledger until the call really ends rather than until somebody stopped listening. On a
    // TIMEOUT the two end together, which is honest here for a reason worth stating: `runLlm`
    // is handed the same bounded deadline, and repo-tour's `runProcess` kills its own child
    // on it, so the deadline really is the end of the request and not merely the end of the
    // wait. The cost of a timed-out call is unknown, which is exactly what it is: nobody
    // reported one.
    void run.finished.then((outcome) => {
      this.ledger.record(outcome);
      this.phase = 'closed';
      this.ledger.release(this);
    });
  }

  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    if (this.run) {
      // Still `sending`: the request is running and billing, and `finished` will close it.
      this.run.detach();
    } else {
      this.phase = 'closed';
      this.ledger.release(this);
    }
    this.deliver(null);
  }
}

/**
 * **The one place that owns the lifecycle of an in-flight paid request.**
 *
 * `AskRun` is per-ask: it can be detached and it carries what one answer cost. What nothing
 * owned before was the SET of live runs, the bound on their deadline, the directory they are
 * launched in, and the running total of what they have spent — so five different entry points
 * each had their own partial answer to "what stops a runaway billed request", and each one was
 * separately defensible and separately wrong:
 *
 *   - a live request with no control anywhere in the UI to stop it (code review finding 3);
 *   - a `NaN` deadline that fired instantly while the request went on billing (finding 9);
 *   - a cancel-then-ask that left two billed requests running and said nothing about the
 *     second bill (finding 10);
 *   - a pre-flight that ran off-camera with an uninterruptible *Cancel* (security 5);
 *   - an `AskCost` computed on every reply and rendered nowhere (finding 5) — in a file whose
 *     own header argues that "a tutor that quietly bills is not honest".
 *
 * They are one absence seen from five doors. The ledger is the answer to all five and the
 * answer is a NAME: nothing starts a paid request except `ledger.open(step).send(...)`, so
 * `ledger.spend()` is complete by construction, `ledger.abandonAll()` stops everything from
 * anywhere, and there is no sixth door to enumerate.
 *
 * One ledger per `WalkSession`, disposed with it. It holds no `vscode`, no editor and no
 * progress — a unit test drives it directly.
 */
export class AskLedger {
  private readonly tickets = new Set<LedgerTicket>();
  private replies = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private usd = 0;
  private unmetered = 0;
  private scratch: string | undefined;
  private closed = false;

  /** Open a ticket for a question about `stepId`. `preparing` until `send`: nothing is sent
   *  and nothing is billed, but the panel can already draw it and *Cancel* can already stop
   *  it, which is the whole of security review finding 5. */
  open(stepId: string): AskTicket {
    const ticket = new LedgerTicket(stepId, this);
    if (this.closed) {
      // A ledger that has been closed never sends anything again — a disposed session's ask
      // must not be able to start one. The ticket is handed back already over rather than
      // `undefined`, so no caller needs a second shape for "there is no ticket".
      ticket.abandon();
      return ticket;
    }
    this.tickets.add(ticket);
    return ticket;
  }

  /** Everything still in the air, oldest first — what step it belongs to and what it is
   *  doing. This is how a panel on a DIFFERENT step can say an ask is live and offer to stop
   *  it (code review finding 3), rather than pointing at a control that is not on the page. */
  live(): Array<{ stepId: string; phase: 'preparing' | 'sending'; abandoned: boolean }> {
    const out: Array<{ stepId: string; phase: 'preparing' | 'sending'; abandoned: boolean }> = [];
    for (const ticket of this.tickets) {
      if (ticket.phase === 'closed') continue;
      out.push({ stepId: ticket.stepId, phase: ticket.phase, abandoned: ticket.abandoned });
    }
    return out;
  }

  /** What this walk has spent, and what is spending right now. See `AskSpend`. */
  spend(): AskSpend {
    let preparing = 0;
    let sending = 0;
    let unwatched = 0;
    for (const ticket of this.tickets) {
      if (ticket.phase === 'preparing') preparing += 1;
      else if (ticket.phase === 'sending') {
        sending += 1;
        if (ticket.abandoned) unwatched += 1;
      }
    }
    return {
      preparing,
      sending,
      unwatched,
      replies: this.replies,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      usd: this.usd,
      metered: this.replies > 0 && this.unmetered === 0,
    };
  }

  /** Stop waiting for every live ask, wherever it was asked from. The single control behind
   *  *Cancel*, so a question left running on a step the learner has walked away from is still
   *  reachable from the page they are on now. */
  abandonAll(): void {
    for (const ticket of [...this.tickets]) ticket.abandon();
  }

  /**
   * The session is going away. Every ask is abandoned (detached, never killed — see
   * `AskTicket.abandon`), nothing new can be opened, and the scratch directory goes.
   *
   * The totals are deliberately NOT reset: `close` is the end of the ledger, not a way to
   * forget what was spent.
   */
  close(): void {
    this.closed = true;
    this.abandonAll();
    const dir = this.scratch;
    this.scratch = undefined;
    if (dir === undefined || dir === os.tmpdir()) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A scratch directory that will not go is litter in `os.tmpdir()`, not a failure worth
      // a sentence at somebody closing a window.
    }
  }

  /**
   * The neutral directory every provider process is started in (security review finding 3).
   *
   * A fresh `mkdtemp` rather than `os.tmpdir()` itself, and rather than the learner's folder:
   * an agent CLI reads its configuration out of the directory it starts in, T-5's
   * `reproduceFiles` copies a reference repo's `.claude/settings.json` and `.mcp.json` into
   * the learner's folder with no name allowlist, and `/tmp` is world-writable. An empty
   * directory this process just created is the only one of the three nobody else can have
   * written into. Created once per session, on the first ask, so a walk nobody asks a question
   * on creates nothing.
   */
  scratchDir(): string {
    if (this.scratch !== undefined) return this.scratch;
    try {
      this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-tutor-'));
    } catch {
      // Better a shared temp directory than the learner's folder, which is the thing this
      // exists to stop. Recorded here rather than thrown: a failed `mkdtemp` must not be the
      // reason a question goes unanswered.
      this.scratch = os.tmpdir();
    }
    return this.scratch;
  }

  /** @internal — `LedgerTicket` calls this when a request really ends. */
  record(outcome: AskOutcome): void {
    const cost = outcome.kind === 'reply' || outcome.kind === 'failed' ? outcome.cost : undefined;
    if (cost === undefined) return;
    this.replies += 1;
    this.inputTokens += countable(cost.inputTokens);
    this.outputTokens += countable(cost.outputTokens);
    this.usd += countable(cost.usd);
    if (cost.metered !== true) this.unmetered += 1;
  }

  /** @internal — `LedgerTicket` calls this when it is over, in every direction. */
  release(ticket: LedgerTicket): void {
    this.tickets.delete(ticket);
  }
}
