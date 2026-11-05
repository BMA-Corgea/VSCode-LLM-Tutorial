// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/derive/ask.ts` — the engine's one door to a model (AC4's mechanism, AC6, AC8, AC10).
 *
 * Driven through the REAL `AskLedger` with repo-tour's REAL core, `runLlm` poisoned and the
 * provider probe stubbed — `test/unit/tutor-ask.test.ts`'s own harness, so a test that forgot to
 * inject a runner fails instead of dialling out. The runner every test injects records what it
 * was asked. No test spends a token.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { askOnce, newTally, type DeriveAskDeps } from '../../src/derive/ask.js';
import { deriveCacheKey, readCachedReply } from '../../src/derive/cache.js';
import { parseCodeReply } from '../../src/derive/prompt.js';
import { DERIVE_CACHE_DIR } from '../../src/derive/storage.js';
import { AskLedger } from '../../src/tutor/ask.js';
import { tutorCoreFor, type LlmReply, type TutorCore } from '../../src/tutor/core.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());
const SPEND_GUARD = 'a test in derive-ask.test.ts reached the real model';

let realCore: TutorCore;

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = tutorCoreFor(loaded.loaded);
});

const made: string[] = [];
const ledgers: AskLedger[] = [];

teardown(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A runner that answers with `replies` in turn and records every prompt it was sent. */
function scripted(replies: Array<Partial<LlmReply>>): { prompts: string[]; run: TutorCore['runLlm'] } {
  const prompts: string[] = [];
  const run: TutorCore['runLlm'] = (prompt) => {
    prompts.push(prompt);
    const next = replies.shift();
    if (next === undefined) return Promise.reject(new Error('the scripted runner was asked more often than the test expected'));
    return Promise.resolve({ text: '', inputTokens: 0, outputTokens: 0, usd: 0, metered: true, ...next });
  };
  return { prompts, run };
}

function depsWith(run: TutorCore['runLlm'], extra: Partial<DeriveAskDeps> = {}): DeriveAskDeps {
  const gs = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-ask-gs-'));
  made.push(gs);
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error(SPEND_GUARD)),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
  };
  return { ledger, settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run }, globalStorageRoot: gs, ...extra };
}

const GOOD = JSON.stringify({ content: 'export const x = 1;\n' });
const parse = (text: string) => parseCodeReply(text, 'core/x.mjs');

suite('askOnce — the cache, then the ledger, then the same parser for both', () => {
  test('a miss is asked through the ledger, parsed, and cached; the same prompt again makes no call', async () => {
    const runner = scripted([{ text: GOOD, inputTokens: 100, outputTokens: 20, usd: 0.01 }]);
    const deps = depsWith(runner.run);
    const tally = newTally();
    assert.deepEqual(await askOnce(deps, 'derive:code:x', 'the prompt', parse, tally), { content: 'export const x = 1;\n' });
    assert.equal(runner.prompts.length, 1);
    assert.equal(deps.ledger.spend().replies, 1, 'the ledger counted the paid request');
    assert.deepEqual(await askOnce(deps, 'derive:code:x', 'the prompt', parse, tally), { content: 'export const x = 1;\n' });
    assert.equal(runner.prompts.length, 1, 'the second ask was served from the cache');
    assert.deepEqual(
      { calls: tally.calls, cachedStops: tally.cachedStops, interpretedStops: tally.interpretedStops, inputTokens: tally.inputTokens, outputTokens: tally.outputTokens, usd: tally.usd, unmetered: tally.unmetered },
      { calls: 1, cachedStops: 1, interpretedStops: 1, inputTokens: 100, outputTokens: 20, usd: 0.01, unmetered: 0 },
    );
  });

  test('the prompt reaches the runner exactly as built, through the ledger\'s scratch directory', async () => {
    const seen: Array<{ prompt: string; cwd: string }> = [];
    const run: TutorCore['runLlm'] = (prompt, _choice, cwd) => {
      seen.push({ prompt, cwd });
      return Promise.resolve({ text: GOOD, inputTokens: 0, outputTokens: 0, usd: 0, metered: true });
    };
    const deps = depsWith(run);
    await askOnce(deps, 'derive:code:x', 'exactly this', parse, newTally());
    assert.equal(seen[0]?.prompt, 'exactly this');
    assert.equal(seen[0]?.cwd, deps.ledger.scratchDir(), 'the provider runs in the ledger\'s neutral folder, never a target');
  });

  test('a reply that does not parse is refused and NOT cached: the next press asks again', async () => {
    const runner = scripted([{ text: 'not json' }, { text: GOOD }]);
    const deps = depsWith(runner.run);
    const tally = newTally();
    const first = await askOnce(deps, 'derive:code:x', 'p', parse, tally);
    assert.ok('refused' in first && /not one JSON object/.test(first.refused));
    assert.deepEqual(tally.failures.length, 1);
    // Pinned on DISK, not only by behaviour: a cached bad reply would be re-parsed and refused on
    // the next ask anyway, so a test that only watched the second call could not tell a cache
    // that kept garbage from one that did not (red-checks row 12, when this assertion was absent).
    assert.equal(readCachedReply(deps.globalStorageRoot, deriveCacheKey('p')), null, 'nothing was written for a reply that did not parse');
    assert.deepEqual(await askOnce(deps, 'derive:code:x', 'p', parse, tally), { content: 'export const x = 1;\n' });
    assert.equal(runner.prompts.length, 2);
  });

  test('a cached reply the parser refuses is a miss, asked again, never served (AC8)', async () => {
    const runner = scripted([{ text: GOOD }]);
    const deps = depsWith(runner.run);
    fs.mkdirSync(path.join(deps.globalStorageRoot, DERIVE_CACHE_DIR), { recursive: true });
    const key = deriveCacheKey('p');
    fs.writeFileSync(path.join(deps.globalStorageRoot, DERIVE_CACHE_DIR, `${key}.json`), JSON.stringify({ key, reply: '{"content": 42}' }));
    assert.deepEqual(await askOnce(deps, 'derive:code:x', 'p', parse, newTally()), { content: 'export const x = 1;\n' });
    assert.equal(runner.prompts.length, 1, 'the tampered entry was not used');
  });

  test('unreachable, timed out and failed each come back as a sentence, and cost is still counted', async () => {
    const unreachable = depsWith(scripted([]).run);
    unreachable.settings = { ...unreachable.settings, core: { ...unreachable.settings.core, availability: () => Promise.resolve({ ok: false, detail: 'not found on PATH' }) } };
    const a = await askOnce(unreachable, 'derive:outline', 'p', parse, newTally());
    assert.ok('refused' in a && a.refused.includes('not found on PATH'));

    const never: TutorCore['runLlm'] = () => new Promise<LlmReply>(() => undefined);
    const slow = depsWith(never);
    slow.settings = { ...slow.settings, timeoutMs: 30 };
    const b = await askOnce(slow, 'derive:outline', 'p', parse, newTally());
    assert.ok('refused' in b && /did not answer within/.test(b.refused));

    const fetchy = scripted([{ text: 'FETCH: file core/x.mjs', usd: 0.5, metered: true }]);
    const tally = newTally();
    const c = await askOnce(depsWith(fetchy.run), 'derive:outline', 'p', parse, tally);
    assert.ok('refused' in c && /request failed/.test(c.refused));
    assert.equal(tally.usd, 0.5, 'a billed reply that was discarded still cost money');
  });

  test('an unmetered reply makes the totals a floor, never a figure (AC10)', async () => {
    const runner = scripted([{ text: GOOD, metered: false }]);
    const tally = newTally();
    await askOnce(depsWith(runner.run), 'derive:code:x', 'p', parse, tally);
    assert.equal(tally.unmetered, 1);
  });

  test('cancelled before the question: nothing is sent', async () => {
    const runner = scripted([{ text: GOOD }]);
    const out = await askOnce(depsWith(runner.run, { isCancelled: () => true }), 'derive:code:x', 'p', parse, newTally());
    assert.ok('refused' in out && /cancelled/.test(out.refused));
    assert.equal(runner.prompts.length, 0);
  });
});

suite('one door out — src/derive/ never starts a paid request any other way (AC6)', () => {
  /** Code with comments removed, so a header that NAMES a forbidden function is not mistaken for a call. */
  function codeOf(file: string): string {
    return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  test('no file in src/derive/ names runLlm, startAsk, startPromptAsk, askTutor or askWithPrompt', () => {
    const dir = path.join(process.cwd(), 'src', 'derive');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 6, `the scan found ${files.length} files — it must be scanning the real folder`);
    for (const f of files) {
      const code = codeOf(path.join(dir, f));
      for (const name of ['runLlm', 'startAsk', 'startPromptAsk', 'askTutor', 'askWithPrompt']) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(code), `${f} names ${name}`);
      }
    }
  });

  test('the one door it does use is the ledger\'s', () => {
    const code = codeOf(path.join(process.cwd(), 'src', 'derive', 'ask.ts'));
    assert.match(code, /\.ledger\.open\(/);
    assert.match(code, /\.sendPrompt\(/);
  });
});
