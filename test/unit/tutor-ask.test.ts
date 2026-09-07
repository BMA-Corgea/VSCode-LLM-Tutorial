// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/tutor/ask.ts` — the one place this extension talks to a model (AC3, AC4).
 *
 * ## Not one token is spent in here, and that is enforced rather than promised
 *
 * The core under test is the REAL repo-tour core, loaded exactly as `dial-check.test.ts`
 * loads it, so `buildAskPrompt`, `buildContextBlock`, `trimMessages` and `resolveChoice` are
 * the genuine articles — all four are pure string work, and a stubbed core would only prove
 * this module can agree with its own mock about what a prompt looks like. The trimming
 * assertion in particular is worthless against a fake: what is being pinned is repo-tour's
 * real thirty-turn rule reaching the prompt.
 *
 * The single function that can spend money — `runLlm` — is POISONED on every core this file
 * builds, so a test that forgets to inject `TutorDeps.run` fails loudly instead of quietly
 * dialling a provider. `the seam is the only route to a provider` proves the poison is real,
 * which also proves that every other test here, all of which get their canned text back, went
 * through the injected runner and nowhere near a CLI.
 *
 * `availability` is stubbed for the same reason in reverse: repo-tour's real claude probe
 * shells out to `claude --version`, which spends nothing but is slow and depends on the
 * machine. The one suite that WANTS the real probe — AC4's — takes it, and makes it answer
 * "no" by pointing `REPO_TOUR_CLAUDE_BIN` at a path that does not exist. That env var name is
 * the one the plan's reconciliation table corrects (`BUILD_TUTORIALS_CLAUDE` is this
 * extension's setting and reaches no provider); it is read through `resolveBin`, which only
 * `access()`es a file, so that suite spawns nothing either.
 *
 * ## Both directions, everywhere
 *
 * A module that answered `failed` to everything would pass a suite made only of failure
 * cases, so each refusal is paired with the near-identical case that must still work: the
 * unreachable provider against the available one, the never-resolving runner against the
 * prompt one, the detached run against the run nobody detached. The timing tests use
 * deadlines in the tens of milliseconds — the behaviour is the race, not the duration.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import {
  AskLedger,
  askTutor,
  boundedTimeoutMs,
  checkReachable,
  DEFAULT_TIMEOUT_MS,
  isFetchRequestReply,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  startAsk,
  withoutFetchProtocol,
  type AskOutcome,
  type AskSettings,
  type TutorDeps,
} from '../../src/tutor/ask.js';
import { tutorCoreFor, type AskContext, type AskMessage, type LlmChoice, type LlmReply, type TutorCore } from '../../src/tutor/core.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

/** What a poisoned `core.runLlm` says when a test forgets to inject a runner. */
const SPEND_GUARD = 'a test in tutor-ask.test.ts reached the real model';

/** repo-tour's `available()` sentence for a claude binary it cannot find. Its words, not ours. */
const PROVIDER_SAYS_MISSING = 'not found on PATH';

let realCore: TutorCore;

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = tutorCoreFor(loaded.loaded);
});

/**
 * The real core with the two environment-touching members replaced: `runLlm` poisoned so it
 * can only ever be a test failure, `availability` stubbed to a fast yes. Overrides are applied
 * last, so a suite that wants the genuine probe back can ask for it by name.
 */
function coreWith(overrides: Partial<TutorCore> = {}): TutorCore {
  return {
    ...realCore,
    runLlm: () => Promise.reject(new Error(SPEND_GUARD)),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
    ...overrides,
  };
}

function depsWith(overrides: Partial<TutorDeps> = {}): TutorDeps {
  return {
    core: coreWith(),
    provider: 'claude',
    model: 'claude-opus-5',
    cwd: '/learner/target',
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** One call to the injected runner, exactly as `askTutor` made it. */
interface Sent {
  prompt: string;
  choice: LlmChoice;
  cwd: string;
  timeoutMs: number | undefined;
}

/** An injected runner that records what it was asked and answers with a canned reply. */
function recorder(reply: Partial<LlmReply> = {}): { calls: Sent[]; run: TutorCore['runLlm'] } {
  const calls: Sent[] = [];
  const run: TutorCore['runLlm'] = (prompt, choice, cwd, timeoutMs) => {
    calls.push({ prompt, choice, cwd, timeoutMs });
    return Promise.resolve({
      text: 'Because the parser would otherwise have two jobs.',
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      metered: false,
      ...reply,
    });
  };
  return { calls, run };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The step the learner is stuck on — enough of an `AskContext` to exercise the build block. */
const CTX: AskContext = {
  repo: 'reference',
  file: 'src/parse.ts',
  fileMeaning: 'the tokenizer, so the parser has one job',
  stopTitle: 'Why does the tokenizer get its own module?',
  stopText: '[author] Split it out — the parser stays one job',
  build: {
    question: 'Why does the tokenizer get its own module?',
    options: [
      { label: 'Split it out', consequence: 'the parser stays one job', taken: true },
      { label: 'Keep it inline', consequence: 'one file, two reasons to change', taken: false },
    ],
    why: 'the parser stays one job',
    learnerDiff: '(the learner has not created this file yet)',
  },
};

const ONE_QUESTION: AskMessage[] = [{ role: 'user', content: 'Why not keep it inline?' }];

// ---------------------------------------------------------------- the reply path

suite('askTutor — an answer, and what it cost', () => {
  test("an injected runner's canned text comes back as a reply", async () => {
    const { calls, run } = recorder({ text: 'One module, one reason to change.' });
    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply');
    assert.equal(outcome.kind === 'reply' && outcome.text, 'One module, one reason to change.');
    assert.equal(calls.length, 1);
  });

  test('the cost is carried through, field for field', async () => {
    const { run } = recorder({ inputTokens: 4_120, outputTokens: 318, usd: 0.0271, metered: true });
    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply');
    if (outcome.kind !== 'reply') return;
    assert.deepEqual(outcome.cost, {
      inputTokens: 4_120,
      outputTokens: 318,
      usd: 0.0271,
      metered: true,
    });
  });

  test('an unmetered provider reports metered:false — the zeros are unknowns, not a free answer', async () => {
    const { run } = recorder({ inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply');
    if (outcome.kind !== 'reply') return;
    // The flag is the whole point: without it a renderer cannot tell "$0.00" from "we do not
    // know", and the two are not the same sentence to show someone paying for this.
    assert.equal(outcome.cost.metered, false);
    assert.equal(outcome.cost.usd, 0);
  });

  test('the provider, model, cwd and deadline all reach the runner', async () => {
    const { calls, run } = recorder();
    await askTutor(depsWith({ run, model: 'claude-haiku-4-5-20251001', cwd: '/tmp/learner', timeoutMs: 4_000 }), CTX, ONE_QUESTION);

    const sent = calls[0];
    assert.ok(sent, 'the runner should have been called');
    // Through the core's own resolveChoice, so an unknown model would have been corrected here.
    assert.deepEqual(sent.choice, { provider: 'claude', model: 'claude-haiku-4-5-20251001' });
    assert.equal(sent.cwd, '/tmp/learner');
    assert.equal(sent.timeoutMs, 4_000);
  });

  test("an unknown model is resolved to the provider's own, not sent as typed", async () => {
    const { calls, run } = recorder();
    await askTutor(depsWith({ run, model: 'gpt-9-ultra' }), CTX, ONE_QUESTION);

    const sent = calls[0];
    assert.ok(sent);
    assert.equal(sent.choice.provider, 'claude');
    assert.notEqual(sent.choice.model, 'gpt-9-ultra');
  });

  test('the prompt is the real buildAskPrompt over the real context block', async () => {
    const { calls, run } = recorder();
    await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    const sent = calls[0];
    assert.ok(sent);
    assert.match(sent.prompt, /--- THE BUILD STEP ---/);
    assert.match(sent.prompt, /Question: Why does the tokenizer get its own module\?/);
    assert.match(sent.prompt, /\[author\] Split it out — the parser stays one job/);
    assert.match(sent.prompt, /\[alternative\] Keep it inline/);
    assert.match(sent.prompt, /the learner has not created this file yet/);
    assert.match(sent.prompt, /READER: Why not keep it inline\?/);
  });
});

// ---------------------------------------------------------------- trimming

suite('askTutor — the conversation is trimmed for the WIRE, never for the record', () => {
  /** Forty alternating turns: `trimMessages` keeps the last thirty, so #10 must not be sent. */
  function longConversation(): AskMessage[] {
    return Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `[turn-${i + 1}] something the ${i % 2 === 0 ? 'learner' : 'tutor'} said`,
    }));
  }

  test('what is SENT is the trimmed conversation', async () => {
    const { calls, run } = recorder();
    await askTutor(depsWith({ run }), CTX, longConversation());

    const sent = calls[0];
    assert.ok(sent);
    assert.ok(!sent.prompt.includes('[turn-10]'), 'the eleventh-from-last turn should have been trimmed away');
    assert.ok(sent.prompt.includes('[turn-11]'), 'the thirtieth-from-last turn should survive');
    assert.ok(sent.prompt.includes('[turn-40]'), 'the question just asked must always survive');
  });

  test("the CALLER's array is untouched — it is the transcript about to be saved", async () => {
    const messages = longConversation();
    const before = JSON.parse(JSON.stringify(messages)) as AskMessage[];
    const { run } = recorder();

    await askTutor(depsWith({ run }), CTX, messages);

    assert.equal(messages.length, 40);
    assert.deepEqual(messages, before);
  });

  test('a malformed stored transcript is validated rather than crashed on', async () => {
    // `trimMessages` takes `unknown` in repo-tour precisely so a hand-edited progress.json
    // cannot take the panel down. A junk turn is dropped; the real one still reaches the wire.
    const messages = [null, { role: 'user', content: 'a real question' }, { role: 'user' }] as unknown as AskMessage[];
    const { calls, run } = recorder();

    const outcome = await askTutor(depsWith({ run }), CTX, messages);

    assert.equal(outcome.kind, 'reply');
    const sent = calls[0];
    assert.ok(sent);
    assert.match(sent.prompt, /READER: a real question/);
  });
});

// ---------------------------------------------------------------- AC4

suite('AC4 — availability comes first, and the answer is the provider\'s own', () => {
  const BIN_ENV = 'REPO_TOUR_CLAUDE_BIN';
  let saved: string | undefined;

  setup(() => {
    saved = process.env[BIN_ENV];
    // An explicit-but-broken override does NOT fall through to PATH in repo-tour's
    // `resolveBin`, so this makes the real probe answer "no" on any machine, claude or not.
    process.env[BIN_ENV] = path.join(os.tmpdir(), 'build-tutorials-no-such-claude');
  });

  teardown(() => {
    if (saved === undefined) delete process.env[BIN_ENV];
    else process.env[BIN_ENV] = saved;
  });

  test('an unavailable provider is unreachable, carrying the reason it gave', async () => {
    const outcome = await askTutor(
      depsWith({ core: coreWith({ availability: (id) => realCore.availability(id) }), run: recorder().run }),
      CTX,
      ONE_QUESTION,
    );

    assert.equal(outcome.kind, 'unreachable');
    // Verbatim: a house rephrasing would say less than the provider already said.
    assert.equal(outcome.kind === 'unreachable' && outcome.detail, PROVIDER_SAYS_MISSING);
  });

  test('and the runner is NEVER called — nothing is spent, no spinner is ever started', async () => {
    const { calls, run } = recorder();
    const outcome = await askTutor(
      depsWith({ core: coreWith({ availability: (id) => realCore.availability(id) }), run }),
      CTX,
      ONE_QUESTION,
    );

    assert.equal(outcome.kind, 'unreachable');
    assert.equal(calls.length, 0, 'an unreachable provider must be answered before anything is sent');
  });

  test('an available provider does reach the runner (the other direction)', async () => {
    const { calls, run } = recorder();
    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply');
    assert.equal(calls.length, 1);
  });

  test('a provider id nobody claims is unreachable, not a crash', async () => {
    const { calls, run } = recorder();
    const outcome = await askTutor(
      depsWith({ core: coreWith({ availability: (id) => realCore.availability(id) }), provider: 'nope', run }),
      CTX,
      ONE_QUESTION,
    );

    assert.equal(outcome.kind, 'unreachable');
    assert.equal(outcome.kind === 'unreachable' && outcome.detail, 'no such provider: nope');
    assert.equal(calls.length, 0);
  });

  test('checkReachable reports a probe that explodes; it does not rethrow it', async () => {
    const core = coreWith({
      availability: () => {
        throw new Error('the core never loaded');
      },
    });

    const availability = await checkReachable(depsWith({ core }));

    assert.deepEqual(availability, { ok: false, detail: 'the core never loaded' });
  });

  test('checkReachable answers yes when the provider says yes', async () => {
    const availability = await checkReachable(depsWith());

    assert.equal(availability.ok, true);
    assert.equal(availability.detail, 'stubbed provider probe');
  });
});

// ---------------------------------------------------------------- the deadline

suite('askTutor — a timeout is a reply, not a hang', () => {
  /** A runner with no timer of its own, the way a wedged provider looks from here. */
  const neverAnswers: TutorCore['runLlm'] = () => new Promise<LlmReply>(() => undefined);

  test('a runner that never resolves still answers, as timedOut', async () => {
    const started = Date.now();
    const outcome = await askTutor(depsWith({ run: neverAnswers, timeoutMs: 30 }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'timedOut');
    if (outcome.kind !== 'timedOut') return;
    // Measured, not assumed — `afterMs` is how long the learner actually waited. The lower
    // bound is loose because a timer is allowed to fire a hair early.
    assert.ok(outcome.afterMs >= 25, `afterMs should be around the deadline, was ${outcome.afterMs}`);
    assert.ok(Date.now() - started < 5_000, 'and it must not have waited for the 5s default');
  });

  test('a runner that answers inside the deadline is not timed out (the other direction)', async () => {
    const run: TutorCore['runLlm'] = async () => {
      await delay(10);
      return { text: 'in time', inputTokens: 0, outputTokens: 0, usd: 0, metered: false };
    };

    const outcome = await askTutor(depsWith({ run, timeoutMs: 500 }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply');
    assert.equal(outcome.kind === 'reply' && outcome.text, 'in time');
  });

  test('a late answer cannot overwrite the timedOut one, and a late rejection is not unhandled', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run: TutorCore['runLlm'] = async () => {
        await delay(60);
        throw new Error('claude exited 1, long after nobody was listening');
      };

      const outcome = await askTutor(depsWith({ run, timeoutMs: 20 }), CTX, ONE_QUESTION);
      assert.equal(outcome.kind, 'timedOut');

      // The whole point: this is a webview message handler, and there is nothing above it.
      await delay(120);
      assert.deepEqual(seen, [], 'a rejection after the deadline must already have a listener');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------- failure

suite('askTutor — a failure is an answer too', () => {
  test('a rejecting runner is failed, carrying the provider\'s reason', async () => {
    const run: TutorCore['runLlm'] = () => Promise.reject(new Error('claude exited 2: not logged in'));

    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.detail, 'claude exited 2: not logged in');
  });

  test('a runner that throws synchronously never escapes either', async () => {
    const run = (() => {
      throw new Error('spawn ENOENT');
    }) as TutorCore['runLlm'];

    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.detail, 'spawn ENOENT');
  });

  test('a non-Error thrown by a provider still reads as a sentence', async () => {
    // Not every rejection is an `Error`: a stream handler that rejects with a string is a real
    // shape, and `detailOf` has to survive it rather than print "[object Object]".
    const notAnError: unknown = 'the socket closed';
    const run: TutorCore['runLlm'] = async () => {
      await delay(0);
      throw notAnError;
    };

    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.detail, 'the socket closed');
  });

  test('a failure with nothing to say still says something', async () => {
    const run: TutorCore['runLlm'] = () => Promise.reject(new Error('   '));

    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.detail, 'the provider failed without saying why');
  });

  test('a broken prompt builder is failed, not an exception out of askTutor', async () => {
    const core = coreWith({
      buildAskPrompt: () => {
        throw new Error('the ask module never loaded');
      },
    });
    const { calls, run } = recorder();

    const outcome = await askTutor(depsWith({ core, run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed');
    assert.equal(calls.length, 0, 'and nothing was sent');
  });

  test('the seam is the only route to a provider: with no injected runner, core.runLlm is what is called', async () => {
    // The poison in `coreWith` is what makes every other test in this file provably
    // model-free — this is the test that proves the poison is armed and reachable.
    const outcome = await askTutor(depsWith(), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.detail, SPEND_GUARD);
  });
});

// ---------------------------------------------------------------- cancellation

suite('startAsk — cancelling detaches the panel; it does not kill the request', () => {
  test('a detached run delivers null, and the late answer never arrives', async () => {
    let finished = false;
    const run: TutorCore['runLlm'] = async () => {
      await delay(60);
      finished = true;
      return { text: 'the answer nobody waited for', inputTokens: 0, outputTokens: 0, usd: 0.01, metered: true };
    };

    const ask = startAsk(depsWith({ run }), CTX, ONE_QUESTION);
    ask.detach();

    assert.equal(ask.detached, true);
    assert.equal(await ask.delivered, null, 'a detached run has nothing to deliver');

    // The request really was left to finish — we did not kill it, because killLlmChildren
    // would have taken every other model call on this process with it.
    await delay(120);
    assert.equal(finished, true, 'the request should still have run to completion');
    assert.equal(await ask.delivered, null, 'and its answer must still have nowhere to land');
  });

  test('an undetached run delivers its outcome (the other direction)', async () => {
    const { run } = recorder({ text: 'delivered normally' });

    const ask = startAsk(depsWith({ run }), CTX, ONE_QUESTION);
    const outcome = (await ask.delivered) as AskOutcome;

    assert.equal(ask.detached, false);
    assert.equal(outcome.kind, 'reply');
    assert.equal(outcome.kind === 'reply' && outcome.text, 'delivered normally');
  });

  test('detaching after the answer has landed cannot un-deliver it', async () => {
    const { run } = recorder({ text: 'already on screen' });

    const ask = startAsk(depsWith({ run }), CTX, ONE_QUESTION);
    const outcome = (await ask.delivered) as AskOutcome;
    assert.equal(outcome.kind, 'reply');

    ask.detach();
    ask.detach();

    const again = (await ask.delivered) as AskOutcome;
    assert.equal(again.kind, 'reply');
    assert.equal(ask.detached, true, 'the flag still flips — the panel may want to say so');
  });

  test('a detached run swallows a failure too, not only an answer', async () => {
    const run: TutorCore['runLlm'] = async () => {
      await delay(40);
      throw new Error('claude exited 1');
    };

    const ask = startAsk(depsWith({ run }), CTX, ONE_QUESTION);
    ask.detach();

    assert.equal(await ask.delivered, null);
    await delay(90);
    assert.equal(await ask.delivered, null);
  });

  test('detaching an unreachable ask is still just null, not a stuck promise', async () => {
    const core = coreWith({ availability: () => Promise.resolve({ ok: false, detail: 'not found on PATH' }) });
    const { calls, run } = recorder();

    const ask = startAsk(depsWith({ core, run }), CTX, ONE_QUESTION);
    ask.detach();

    assert.equal(await ask.delivered, null);
    assert.equal(calls.length, 0);
  });
});

// ── T-6 review: the seam ───────────────────────────────────────────────────────────────────

/**
 * The first review of this module found five defects that are one absence: nothing owned the
 * set of live paid requests, the bound on their deadline, the directory they launch in, or
 * what they had cost. `AskLedger` is that owner, and these suites are its proof — every one of
 * them drives the ledger rather than reading it, and none of them can reach a provider.
 */

/** An ask that will not answer until the test says so, and remembers whether it was asked. */
function held(): { run: TutorCore['runLlm']; calls: () => number; reply: (r?: Partial<LlmReply>) => void; fail: (why: string) => void } {
  let resolveWith: ((reply: LlmReply) => void) | undefined;
  let rejectWith: ((err: Error) => void) | undefined;
  let calls = 0;
  return {
    run: () => {
      calls += 1;
      return new Promise<LlmReply>((resolve, reject) => { resolveWith = resolve; rejectWith = reject; });
    },
    calls: () => calls,
    reply: (r = {}) => resolveWith?.({ text: 'an answer', inputTokens: 10, outputTokens: 5, usd: 0.002, metered: true, ...r }),
    fail: (why) => rejectWith?.(new Error(why)),
  };
}

function settingsWith(overrides: Partial<AskSettings> = {}): AskSettings {
  const deps = depsWith();
  // Everything the ledger does NOT choose. `cwd` is deliberately absent from `AskSettings`:
  // the ledger picks the directory the provider is started in, so no caller can hand it one.
  return { core: deps.core, provider: deps.provider, model: deps.model, timeoutMs: deps.timeoutMs, ...overrides };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Let the pre-flight inside `askTutor` — the availability probe and the prompt build — run,
 *  so `held()`'s runner has actually been reached and can be released. Three hops, because
 *  that is how many awaits sit between `send()` and the call. */
async function reachedTheRunner(): Promise<void> {
  await tick();
  await tick();
  await tick();
}

suite('boundedTimeoutMs — the deadline is neither NaN nor an overflow (review finding 9)', () => {
  test('a value that is not a number becomes the default, rather than NaN', () => {
    // The shipped defect, in one line. `src/extension.ts` did `Math.max(5, seconds) * 1000`
    // with no type check, `Math.max(5, "two minutes")` is NaN, and `setTimeout(…, NaN)` fires
    // IMMEDIATELY — so every ask instantly "timed out" while the request ran on and billed.
    for (const raw of ['two minutes', NaN, Infinity, -Infinity, undefined, null, {}, []] as unknown[]) {
      assert.equal(boundedTimeoutMs(raw), DEFAULT_TIMEOUT_MS, `${JSON.stringify(raw) ?? 'undefined'} is not a deadline`);
    }
  });

  test('a deadline that has already passed is garbage too, not an instant timeout', () => {
    assert.equal(boundedTimeoutMs(0), DEFAULT_TIMEOUT_MS);
    assert.equal(boundedTimeoutMs(-1), DEFAULT_TIMEOUT_MS);
  });

  test('anything past an hour is capped, three orders of magnitude short of the int32 wrap', () => {
    // Measured on the shipped code: `tutorTimeoutSeconds=999999999` → `timedOut` after 1 ms,
    // because Node clamps a timer past 2^31-1 ms to 1 ms while the model runs on and bills.
    assert.equal(boundedTimeoutMs(999_999_999_000), MAX_TIMEOUT_MS);
    assert.ok(MAX_TIMEOUT_MS < 2_147_483_647, 'the cap must be a number a 32-bit timer can hold');
  });

  test('an ordinary deadline passes through untouched, including a very small one', () => {
    assert.equal(boundedTimeoutMs(120_000), 120_000);
    // Not clamped up to the SETTING's floor: `package.json`'s `minimum: 5` is a statement
    // about what is sensible to wait for, and this function's job is garbage, not policy.
    // A suite that could not race a 20 ms deadline could not pin the race at all.
    assert.equal(boundedTimeoutMs(20), 20);
    assert.equal(boundedTimeoutMs(0.4), MIN_TIMEOUT_MS, 'and never rounds down to a zero-millisecond timer');
  });

  test('driven: a string deadline no longer times an ask out instantly', async () => {
    const { run } = recorder();
    const started = Date.now();

    const outcome = await askTutor(depsWith({ run, timeoutMs: 'two minutes' as unknown as number }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply', 'the shipped code answered `timedOut` here, in about a millisecond');
    assert.ok(Date.now() - started < 1_000);
  });

  test('driven: an overflowing deadline no longer times an ask out instantly', async () => {
    const { calls, run } = recorder();

    const outcome = await askTutor(depsWith({ run, timeoutMs: 999_999_999_000 }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'reply');
    assert.equal(calls[0]!.timeoutMs, MAX_TIMEOUT_MS, 'and the provider is handed the SAME bounded number, so its own kill deadline agrees with ours');
  });
});

suite('the FETCH protocol the persona promises and this consumer does not have (security 10)', () => {
  test('the real persona\'s fetch section is replaced with the truth, in the real prompt', () => {
    // Read off the REAL repo-tour prompt rather than a fixture: the whole risk is that
    // repo-tour's `ASK_PERSONA` says something this extension cannot do.
    const prompt = realCore.buildAskPrompt(ONE_QUESTION, CTX);
    assert.match(prompt, /FETCH: file/, 'the core really does promise the protocol — if this stops being true, so does the fix');

    const sent = withoutFetchProtocol(prompt);

    assert.doesNotMatch(sent, /FETCH: file/, 'the model is no longer told it may ask for a file');
    assert.match(sent, /Looking things up:/, 'and the heading stays, because an earlier bullet cross-references it by name');
    assert.match(sent, /implements no fetch protocol/);
    assert.ok(sent.includes(realCore.buildContextBlock(CTX)), 'nothing but the section was touched');
  });

  test('a prompt with no such section is returned exactly as it came', () => {
    // Best-effort by design: repo-tour rewording the persona must not corrupt a prompt.
    const plain = 'SYSTEM\n\nsome context\n\n--- CONVERSATION SO FAR ---\nREADER: hi\n';
    assert.equal(withoutFetchProtocol(plain), plain);
  });

  test('a reply that IS a fetch request is refused rather than drawn as an answer', async () => {
    const { run } = recorder({ text: 'FETCH: file src/rank.ts', usd: 0.004, metered: true });

    const outcome = await askTutor(depsWith({ run }), CTX, ONE_QUESTION);

    assert.equal(outcome.kind, 'failed', 'plumbing is not an answer, and must never become a stored assistant turn');
    assert.match(outcome.kind === 'failed' ? outcome.detail : '', /no way to fetch one/);
    // The money half: the request was made and paid for, whatever came back.
    assert.equal(outcome.kind === 'failed' ? outcome.cost?.usd : undefined, 0.004);
  });

  test('an answer that merely mentions FETCH is an answer', () => {
    assert.equal(isFetchRequestReply('FETCH: file src/rank.ts'), true);
    assert.equal(isFetchRequestReply('```\nFETCH: search tokenize\n```'), true, 'fenced, exactly as repo-tour\'s own parser reads it');
    assert.equal(isFetchRequestReply('The model may reply FETCH: file x — but it cannot here.\nSo ask me instead.'), false);
    assert.equal(isFetchRequestReply('FETCH: nonsense'), false);
    assert.equal(isFetchRequestReply('Because the parser has one job.'), false);
  });
});

suite('AskLedger — the one thing that owns a live paid request', () => {
  test('the neutral cwd is the ledger\'s, and it is neither the learner\'s folder nor /tmp itself', async () => {
    // Security review finding 3: the provider is an agent CLI, an agent CLI reads its
    // configuration out of the directory it starts in, and T-5's `reproduceFiles` copies a
    // reference repo's `.claude/settings.json` into the learner's folder with no allowlist.
    const ledger = new AskLedger();
    const { calls, run } = recorder();
    try {
      const ticket = ledger.open('st-2-file-parse');
      ticket.send(settingsWith({ run }), CTX, ONE_QUESTION);
      await ticket.delivered;

      const dir = calls[0]!.cwd;
      assert.notEqual(dir, '/learner/target');
      assert.notEqual(dir, os.tmpdir(), 'a world-writable directory is not a neutral one');
      assert.ok(dir.startsWith(os.tmpdir()) && fs.existsSync(dir));
      assert.deepEqual(fs.readdirSync(dir), [], 'empty — there is nothing in it for a CLI to read as configuration');
    } finally {
      ledger.close();
    }
  });

  test('close() takes the scratch directory away and refuses to open another ticket', async () => {
    const ledger = new AskLedger();
    const { calls, run } = recorder();
    const first = ledger.open('st-2-file-parse');
    first.send(settingsWith({ run }), CTX, ONE_QUESTION);
    await first.delivered;
    const dir = calls[0]!.cwd;

    ledger.close();

    assert.equal(fs.existsSync(dir), false, 'no litter in the temp directory, one per window reload');
    const after = ledger.open('st-3-symbol-handle');
    after.send(settingsWith({ run }), CTX, ONE_QUESTION);
    assert.equal(calls.length, 1, 'a closed ledger never sends again — a disposed session must not be able to start a request');
    assert.equal(await after.delivered, null);
  });

  test('the deadline is bounded at the ledger, so no entry point can arm a NaN timer', async () => {
    const ledger = new AskLedger();
    const { calls, run } = recorder();
    try {
      const ticket = ledger.open('st-2-file-parse');
      ticket.send(settingsWith({ run, timeoutMs: 'soon' as unknown as number }), CTX, ONE_QUESTION);
      await ticket.delivered;

      assert.equal(calls[0]!.timeoutMs, DEFAULT_TIMEOUT_MS);
    } finally {
      ledger.close();
    }
  });

  test('spend() counts what came back, and says UNKNOWN rather than zero when nothing metered it', async () => {
    const ledger = new AskLedger();
    try {
      assert.deepEqual(ledger.spend(), {
        preparing: 0, sending: 0, unwatched: 0, replies: 0, inputTokens: 0, outputTokens: 0, usd: 0, metered: false,
      }, 'a walk that has asked nothing has spent nothing, and knows it');

      const metered = ledger.open('st-2-file-parse');
      metered.send(settingsWith({ run: recorder({ inputTokens: 800, outputTokens: 120, usd: 0.0031, metered: true }).run }), CTX, ONE_QUESTION);
      await metered.delivered;
      assert.deepEqual(ledger.spend(), {
        preparing: 0, sending: 0, unwatched: 0, replies: 1, inputTokens: 800, outputTokens: 120, usd: 0.0031, metered: true,
      });

      const unmetered = ledger.open('st-2-file-parse');
      unmetered.send(settingsWith({ run: recorder({ inputTokens: 0, outputTokens: 0, usd: 0, metered: false }).run }), CTX, ONE_QUESTION);
      await unmetered.delivered;

      const spend = ledger.spend();
      assert.equal(spend.replies, 2);
      assert.equal(spend.metered, false,
        'ONE unmetered answer makes the total a floor rather than a figure — zeros mean unknown, never free');
    } finally {
      ledger.close();
    }
  });

  test('a provider that reports nonsense cannot turn the total into NaN', async () => {
    const ledger = new AskLedger();
    try {
      const ticket = ledger.open('st-2-file-parse');
      ticket.send(settingsWith({ run: recorder({ usd: NaN, inputTokens: Infinity, metered: true }).run }), CTX, ONE_QUESTION);
      await ticket.delivered;

      const spend = ledger.spend();
      assert.equal(spend.usd, 0);
      assert.equal(spend.inputTokens, 0);
      assert.equal(spend.replies, 1, 'it still happened and was still paid for');
    } finally {
      ledger.close();
    }
  });

  test('abandoning BEFORE the send means nothing is ever sent, and nothing is charged', async () => {
    // The pre-flight half of the seam (security review finding 5). `startAsk` alone could only
    // ever detach from a request that had already been made.
    const ledger = new AskLedger();
    const gate = held();
    try {
      const ticket = ledger.open('st-2-file-parse');
      assert.equal(ticket.phase, 'preparing');
      assert.equal(ledger.spend().preparing, 1, 'and the panel can draw it, which is why it exists');

      ticket.abandon();
      ticket.send(settingsWith({ run: gate.run }), CTX, ONE_QUESTION);

      assert.equal(gate.calls(), 0, 'a cancel during the pre-flight is a real cancellation, not a detachment');
      assert.equal(await ticket.delivered, null);
      assert.deepEqual(ledger.live(), []);
      assert.equal(ledger.spend().replies, 0);
    } finally {
      ledger.close();
    }
  });

  test('a question the learner walked away from stays counted until the provider is done with it', async () => {
    // Code review finding 10's money half, and the reason the ledger listens to
    // `AskRun.finished` rather than to `delivered`.
    const ledger = new AskLedger();
    const gate = held();
    try {
      const ticket = ledger.open('st-2-file-parse');
      ticket.send(settingsWith({ run: gate.run }), CTX, ONE_QUESTION);
      assert.deepEqual(
        { sending: ledger.spend().sending, unwatched: ledger.spend().unwatched },
        { sending: 1, unwatched: 0 },
      );

      await reachedTheRunner();
      ticket.abandon();
      assert.equal(await ticket.delivered, null, 'the panel stops waiting AT ONCE');
      assert.deepEqual(
        { sending: ledger.spend().sending, unwatched: ledger.spend().unwatched },
        { sending: 1, unwatched: 1 },
        'and the request is still running and still billing, which is what the page has to say',
      );

      gate.reply({ usd: 0.005, metered: true });
      await tick();

      assert.equal(ledger.spend().sending, 0);
      assert.equal(ledger.spend().usd, 0.005, 'they were billed for it, so it is in the total');
      assert.equal(ledger.spend().replies, 1);
    } finally {
      ledger.close();
    }
  });

  test('two live requests are two, and abandonAll() reaches both — from anywhere', async () => {
    // Code review finding 3: `thinking` is per-step, so navigating away used to leave a
    // billing request with no control anywhere in the UI to stop it. One control, one call.
    const ledger = new AskLedger();
    const first = held();
    const second = held();
    try {
      const a = ledger.open('st-2-file-parse');
      a.send(settingsWith({ run: first.run }), CTX, ONE_QUESTION);
      const b = ledger.open('st-3-symbol-handle');
      b.send(settingsWith({ run: second.run }), CTX, ONE_QUESTION);

      assert.deepEqual(ledger.live().map((entry) => entry.stepId), ['st-2-file-parse', 'st-3-symbol-handle']);
      assert.equal(ledger.spend().sending, 2);

      ledger.abandonAll();

      assert.equal(await a.delivered, null);
      assert.equal(await b.delivered, null);
      assert.equal(ledger.spend().unwatched, 2, 'stopped waiting for, still running, still billing — and the page says so');
    } finally {
      ledger.close();
    }
  });

  test('live() names the step each ask belongs to, which is what the OTHER step\'s page draws', async () => {
    const ledger = new AskLedger();
    const gate = held();
    try {
      const ticket = ledger.open('st-2-file-parse');
      assert.deepEqual(ledger.live(), [{ stepId: 'st-2-file-parse', phase: 'preparing', abandoned: false }]);
      ticket.send(settingsWith({ run: gate.run }), CTX, ONE_QUESTION);
      assert.deepEqual(ledger.live(), [{ stepId: 'st-2-file-parse', phase: 'sending', abandoned: false }]);

      await reachedTheRunner();
      gate.reply();
      await ticket.delivered;
      await tick();
      assert.deepEqual(ledger.live(), [], 'an answered ask is not live, and nothing has to remember to say so');
    } finally {
      ledger.close();
    }
  });

  test('a ticket is one request: a second send does nothing, and there is no retry', async () => {
    const ledger = new AskLedger();
    const gate = held();
    try {
      const ticket = ledger.open('st-2-file-parse');
      ticket.send(settingsWith({ run: gate.run }), CTX, ONE_QUESTION);
      ticket.send(settingsWith({ run: gate.run }), CTX, ONE_QUESTION);
      await reachedTheRunner();

      assert.equal(gate.calls(), 1);
    } finally {
      ledger.close();
    }
  });

  test('a failing provider closes the ticket and is not counted as a paid reply', async () => {
    const ledger = new AskLedger();
    const gate = held();
    try {
      const ticket = ledger.open('st-2-file-parse');
      ticket.send(settingsWith({ run: gate.run }), CTX, ONE_QUESTION);
      await reachedTheRunner();
      gate.fail('claude exited 127');
      const outcome = await ticket.delivered;

      assert.equal(outcome?.kind, 'failed');
      await tick();
      assert.deepEqual(ledger.live(), []);
      assert.equal(ledger.spend().replies, 0, 'a call that never produced an answer reported no cost, and inventing one would be worse than saying nothing');
    } finally {
      ledger.close();
    }
  });
});

suite('AskRun.finished — what was paid for, as opposed to what was delivered', () => {
  test('it resolves with the real outcome even after a detach', async () => {
    const gate = held();
    const run = startAsk(depsWith({ run: gate.run }), CTX, ONE_QUESTION);
    await reachedTheRunner();

    run.detach();
    assert.equal(await run.delivered, null, 'the panel is disconnected');

    gate.reply({ usd: 0.01, metered: true });
    const finished = await run.finished;
    assert.equal(finished.kind, 'reply', 'and the request finished anyway, because detaching is not killing');
    assert.equal(finished.kind === 'reply' && finished.cost.usd, 0.01);
  });

  test('it never rejects, whatever the runner does', async () => {
    const run = startAsk(depsWith({ run: () => Promise.reject(new Error('boom')) }), CTX, ONE_QUESTION);

    const finished = await run.finished;
    assert.equal(finished.kind, 'failed');
  });
});
