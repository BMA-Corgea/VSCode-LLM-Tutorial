// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine's one door to a model (T-17, AC4, AC6, AC8, AC10) — every outline, code
 * and replan question goes through `askOnce`, and `askOnce` goes through nothing but the cache
 * and the walk's own `AskLedger`.
 *
 * ── The order is the design ──────────────────────────────────────────────────────────────────
 *
 *   1. **The cache first**, under the hash of the exact prompt (`./cache.ts`). A hit is RE-PARSED
 *      by the same parser that judges a live reply, so the cache can never be a looser door than
 *      the model (T-7). A hit that no longer parses is a miss.
 *   2. **Then the ledger**: `ledger.open(<ticket id>).sendPrompt(settings, prompt)`. That is the
 *      only way anything in `src/` starts a paid request (`src/tutor/ask.ts`'s `AskLedger`): it
 *      owns the bounded deadline, the neutral scratch directory the provider runs in, the live set
 *      that `abandonAll()` reaches, and the running total that `spend()` reports. Nothing here
 *      names `runLlm`, `startAsk`, `startPromptAsk`, `askTutor` or `askWithPrompt`, and the unit
 *      suite scans `src/derive/` to keep it that way.
 *   3. **Then the parser**, and only a reply that PASSED is written to the cache. `parse` is every
 *      check a reply has to survive, so the engine hands it the deeper ones too (does the file
 *      really parse, does the replan merge into a plan). A reply that fails ANY of them is asked
 *      again on the next press rather than served forever.
 *
 * Each distinct prompt is therefore asked at most once while its answer stays cached — which is
 * the whole of the engine's determinism, and why the second derivation of the same idea and
 * answers makes zero calls.
 *
 * ── Every outcome is a value ─────────────────────────────────────────────────────────────────
 *
 * `askOnce` does not throw on its own account: an unreachable provider, a timeout, a failure, an
 * abandoned request and an unusable reply each come back as a `DeriveRefusal` sentence, and the
 * cost of anything that was billed is counted in the tally either way — a request that was paid
 * for and then discarded still cost money (`src/tutor/ask.ts`'s own rule). The one thing it does
 * not catch is a `parse` that rejects; the engine's outer `try` turns that into a sentence.
 *
 * No `vscode` import — see `./types.ts`.
 */

import type { AskLedger, AskOutcome, AskSettings } from '../tutor/ask.js';
import { deriveCacheKey, readCachedReply, writeCachedReply } from './cache.js';
import { MAX_DERIVE_PROMPT_CHARS } from './prompt.js';
import { DERIVE_LIMITS, isDeriveRefusal, type DeriveRefusal } from './types.js';

export interface DeriveAskDeps {
  /** the one owner of a paid request's lifetime — see the header */
  ledger: AskLedger;
  /** provider, model, deadline and core, resolved by the caller; `run` is a test's seam */
  settings: AskSettings;
  /** where `derive-cache/` lives — the extension's global storage */
  globalStorageRoot: string;
  /** polled before each question; true stops the derivation before anything more is sent */
  isCancelled?: () => boolean;
}

/** The most of a provider's failure text a refusal sentence carries. */
const MAX_DETAIL_CHARS = 300;

/**
 * What a derivation's questions cost so far, summed across them — the figures the plan's `cost`
 * reports. `unmetered` counts live replies whose provider could not say what they cost: one of
 * them makes the totals a floor rather than a figure.
 */
export interface AskTally {
  calls: number;
  cachedStops: number;
  interpretedStops: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  unmetered: number;
  failures: string[];
}

export function newTally(): AskTally {
  return { calls: 0, cachedStops: 0, interpretedStops: 0, inputTokens: 0, outputTokens: 0, usd: 0, unmetered: 0, failures: [] };
}

/** A provider's own words, at a length one sentence can carry. */
function capped(detail: string): string {
  return detail.length <= MAX_DETAIL_CHARS ? detail : `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/** A provider may report anything; a total must not become `NaN` because it did. */
function countable(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Add what a finished question cost to the tally. `began` is whether the request really started.
 *
 * Only something that was sent counts as a call. A call that was sent and reported no cost (timed
 * out, failed, abandoned while it ran) is an UNKNOWN: it stays in `unmetered`, so the totals read
 * as a floor. Counted as nothing, it would say `metered: true, usd: 0` about a request that billed.
 */
function countCost(tally: AskTally, outcome: AskOutcome | null, began: boolean): void {
  if (outcome === null ? !began : outcome.kind === 'unreachable') return;
  tally.calls += 1;
  const cost = outcome !== null && (outcome.kind === 'reply' || outcome.kind === 'failed') ? outcome.cost : undefined;
  if (cost === undefined) {
    tally.unmetered += 1;
    return;
  }
  tally.inputTokens += Math.round(countable(cost.inputTokens));
  tally.outputTokens += Math.round(countable(cost.outputTokens));
  tally.usd += countable(cost.usd);
  if (cost.metered !== true) tally.unmetered += 1;
}

/**
 * Ask `prompt` at most once: the cache, then the ledger, then the parser — see the header.
 * `parse` is the SAME function for a cached reply and a live one; that sameness is the point.
 * It may be async because one of the checks it carries is repo-tour's parser over a real file.
 */
export async function askOnce<T>(
  deps: DeriveAskDeps,
  ticketId: string,
  prompt: string,
  parse: (text: string) => T | DeriveRefusal | Promise<T | DeriveRefusal>,
  tally: AskTally,
): Promise<T | DeriveRefusal> {
  if (deps.isCancelled?.() === true) return { refused: 'the derivation was cancelled before this question was asked' };
  // The bound's own door: whatever a prompt was built from, this is the most that can leave.
  if (prompt.length > MAX_DERIVE_PROMPT_CHARS) {
    return { refused: `this question came to ${prompt.length} characters, more than the ${MAX_DERIVE_PROMPT_CHARS} one question may send, so nothing was sent` };
  }

  const key = deriveCacheKey(prompt);
  const cached = readCachedReply(deps.globalStorageRoot, key);
  if (cached !== null) {
    const fromCache = await parse(cached);
    if (!isDeriveRefusal(fromCache)) {
      tally.cachedStops += 1;
      return fromCache;
    }
    // A cached reply the parser now refuses is a miss: asked again, never served.
  }

  // A press may not buy more than this, and the cache above is free, so it counts what is sent.
  if (tally.calls >= DERIVE_LIMITS.maxCallsPerPress) {
    return { refused: `this stopped after ${tally.calls} questions, the most one press may ask; what was answered is kept, so pressing again carries on from here` };
  }

  const ticket = deps.ledger.open(ticketId);
  ticket.sendPrompt(deps.settings, prompt);
  const began = ticket.phase === 'sending';
  const outcome = await ticket.delivered;
  countCost(tally, outcome, began);
  if (outcome === null) {
    return { refused: 'the request was stopped before it answered; if it had already been sent it is still finishing, and still billed' };
  }
  switch (outcome.kind) {
    case 'unreachable':
      return { refused: `the model could not be reached: ${capped(outcome.detail)}` };
    case 'timedOut':
      return { refused: `the model did not answer within ${Math.max(1, Math.round(outcome.afterMs / 1000))} seconds, and nothing was kept` };
    case 'failed':
      return { refused: `the request failed: ${capped(outcome.detail)}` };
    case 'reply': {
      const parsed = await parse(outcome.text);
      if (isDeriveRefusal(parsed)) {
        tally.failures.push(parsed.refused);
        return parsed;
      }
      tally.interpretedStops += 1;
      writeCachedReply(deps.globalStorageRoot, key, outcome.text);
      return parsed;
    }
  }
}
