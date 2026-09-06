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
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { askTutor, checkReachable, startAsk, type AskOutcome, type TutorDeps } from '../../src/tutor/ask.js';
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
