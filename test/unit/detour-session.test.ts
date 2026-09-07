// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/detour/session.ts — the detour's state machine, driven through fake adapters and a REAL
 * disk, with no extension host and no provider anywhere near it (T-7, plan step 4's own named
 * verification: "state machine with fake adapters").
 *
 * Nothing here may import `vscode`, value or type: `esbuild.mjs`'s `test/unit/*.test.ts` bundle
 * marks `repo-tour` and `mocha` external and deliberately not `vscode`, so one such import
 * fails the BUILD and takes the whole unit suite with it.
 *
 * ## Two things about this harness that are load-bearing rather than convenient
 *
 * **The disk is real.** `globalStorageRoot` is an `mkdtemp`, not a fixture path, and every
 * assertion about where a file landed is a `readdirSync`. That is not thoroughness for its own
 * sake — the whole containment argument in `src/detour/prompt.ts` and `src/detour/store.ts` is
 * that a path can stay under a root as a STRING and land somewhere else on a DISK, and only
 * `realpath` can tell the two apart. A fake filesystem would agree with the string every time
 * and prove exactly nothing. `the store root is a link to somewhere else` plants that link for
 * real and asserts the folder on the other end stays empty.
 *
 * **The ledger is real.** `AskLedger` is the genuine article from `src/tutor/ask.ts`, because
 * plan R2 — "nothing starts a paid request except a ticket this ledger opened" — is only a
 * property if the thing under test really goes through it. `spend()` and `abandonAll()` are
 * asserted against directly: a detour generation that had found its own way to a model would
 * be invisible to both, which is precisely the class T-6 closed and this ticket must not
 * reopen. What is faked is one layer lower: `TutorCore.runLlm`, which is where money is spent.
 *
 * **No test in this file may reach a provider.** The default runner is POISONED — it rejects
 * with a sentence that can only ever be a test failure — and a test that wants an answer says
 * what the answer is. `the poison is real` drives it on purpose, which is what makes every
 * other test's canned reply evidence that it went through the seam rather than past it.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AskLedger, type AskSettings } from '../../src/tutor/ask.js';
import type { AskMessage, LlmReply, TutorCore } from '../../src/tutor/core.js';
import { DETOUR_PROMPT_VERSION, prepareDetourWrite } from '../../src/detour/prompt.js';
import { detourDir, detoursRoot, readCachedDetour, writeCachedDetour } from '../../src/detour/store.js';
import { DetourSession, refusalSentence, type DetourAdapters } from '../../src/detour/session.js';
import type { NarratorViewState } from '../../src/detour/narrator.js';
import type { Detour } from '../../src/detour/types.js';
import { fixturePlan } from './walk-fixtures.js';

/** What a runner nobody replaced says. If this reaches an assertion, a test forgot to answer
 *  for itself and would otherwise have dialled a real provider. */
const SPEND_GUARD = 'a test in detour-session.test.ts reached the real model';

const STEP_ID = 'st-2-file-parse';

/** A well-formed reply: three files, three stops, every stop inside its own file. Three rather
 *  than one because AC2 counts tabs ("≥ 3 detour tabs open") and one file cannot carry that. */
const GOOD_DETOUR: Detour = {
  title: 'A vending machine',
  domain: 'vending machines',
  files: [
    { path: 'coins.ts', content: 'export type Coin = 5 | 10 | 25;\nexport const VALUES: Coin[] = [5, 10, 25];\n' },
    { path: 'stock/tray.ts', content: 'export interface Slot { code: string; count: number; }\nexport const EMPTY: Slot[] = [];\n' },
    { path: 'machine.ts', content: 'import { VALUES } from "./coins";\nexport function total(c: number[]) { return c.length + VALUES.length; }\n' },
  ],
  stops: [
    { file: 'coins.ts', startLine: 1, endLine: 1, text: 'The coins are their own module — one idea, one file.' },
    { file: 'stock/tray.ts', startLine: 1, endLine: 2, text: 'The tray knows nothing about coins.' },
    { file: 'machine.ts', startLine: 2, endLine: 2, text: 'Only the machine joins them.' },
  ],
};

function replyOf(detour: unknown): string {
  return JSON.stringify(detour);
}

// ── the recording fake ──────────────────────────────────────────────────────────────────────

/** One adapter call with what it was handed. The log IS the behaviour of a state machine whose
 *  job is which surface gets what and in which order (`walk-session.test.ts` says the same). */
type Call =
  | { fn: 'openDetourTab'; absPath: string }
  | { fn: 'revealDetourStop'; absPath: string; startLine: number; endLine: number }
  | { fn: 'closeTabsUnder'; prefixes: string[] }
  | { fn: 'showNarrator'; state: NarratorViewState }
  | { fn: 'closeNarrator' }
  | { fn: 'runLlm'; prompt: string }
  | { fn: 'availability' };

interface Fake {
  session: DetourSession;
  log: Call[];
  storage: string;
  ledger: AskLedger;
  refreshes: () => number;
  unreachable: () => string | undefined;
  /** Tabs the fake pretends it cannot close, by absolute path. */
  stuck: Set<string>;
}

interface FakeOptions {
  /** What the model answers. `undefined` leaves the poison in place. */
  canned?: string;
  /** A runner that decides per call — for the supersede and cancel tests, which need one that
   *  does not resolve until they say so. */
  runner?: (prompt: string) => Promise<LlmReply>;
  availability?: { ok: boolean; detail: string };
  /** No settings at all: repo-tour will not load, or no tutor is wired. */
  noSettings?: boolean;
  openThrows?: (absPath: string) => boolean;
  closeThrows?: boolean;
}

const tempDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

function fakeCore(log: Call[], options: FakeOptions): TutorCore {
  const runner = options.runner
    ?? (options.canned === undefined
      ? (): Promise<LlmReply> => Promise.reject(new Error(SPEND_GUARD))
      : (): Promise<LlmReply> => Promise.resolve({
        text: options.canned as string, inputTokens: 3, outputTokens: 7, usd: 0.5, metered: true,
      }));
  return {
    // Deliberately recognisable AND deliberately wrong for a detour: if this string ever
    // reaches `runLlm`, the detour went through `askTutor`'s conversation path instead of
    // `sendPrompt`, and the prompt AC1 is about was never sent.
    buildAskPrompt: (messages: AskMessage[]) => `CONVERSATION PROMPT turns=${messages.length}`,
    buildContextBlock: () => 'CONTEXT',
    trimMessages: (raw) => (Array.isArray(raw) ? (raw as AskMessage[]) : []),
    resolveChoice: (choice) => ({ provider: choice?.provider ?? 'claude', model: 'default' }),
    resolveTutorChoice: (stored, build) => ({
      provider: stored?.provider ?? build.provider,
      model: stored?.model === undefined || stored.model === '' ? 'strongest' : stored.model,
    }),
    runLlm: (prompt) => {
      log.push({ fn: 'runLlm', prompt });
      return runner(prompt);
    },
    availability: () => {
      log.push({ fn: 'availability' });
      return Promise.resolve(options.availability ?? { ok: true, detail: 'a stubbed provider probe' });
    },
  };
}

function makeFake(options: FakeOptions = {}): Fake {
  const log: Call[] = [];
  const storage = tmpDir('detour-storage-');
  const ledger = new AskLedger();
  const stuck = new Set<string>();
  let refreshes = 0;
  let unreachable: string | undefined;

  const settings: AskSettings = {
    core: fakeCore(log, options),
    provider: 'claude',
    model: '',
    timeoutMs: 5_000,
  };

  const adapters: DetourAdapters = {
    globalStorageRoot: storage,
    openDetourTab: (absPath) => {
      log.push({ fn: 'openDetourTab', absPath });
      if (options.openThrows?.(absPath) === true) return Promise.reject(new Error('that tab would not open'));
      return Promise.resolve();
    },
    revealDetourStop: (absPath, startLine, endLine) => {
      log.push({ fn: 'revealDetourStop', absPath, startLine, endLine });
      return Promise.resolve();
    },
    closeTabsUnder: (prefixes) => {
      log.push({ fn: 'closeTabsUnder', prefixes });
      if (options.closeThrows === true) return Promise.reject(new Error('the tabs could not be reached'));
      return Promise.resolve([...stuck]);
    },
    showNarrator: (state) => { log.push({ fn: 'showNarrator', state }); },
    closeNarrator: () => { log.push({ fn: 'closeNarrator' }); },
    skin: () => 'system',
  };

  const session = new DetourSession({
    adapters,
    ledger,
    settings: () => Promise.resolve(options.noSettings === true ? undefined : settings),
    refresh: () => { refreshes += 1; },
    reportUnreachable: (detail) => { unreachable = detail; },
  });

  return { session, log, storage, ledger, refreshes: () => refreshes, unreachable: () => unreachable, stuck };
}

function step() {
  const plan = fixturePlan();
  const found = plan.steps.find((s) => s.id === STEP_ID);
  assert.ok(found, `the fixture plan should contain ${STEP_ID}`);
  return { plan, step: found };
}

/** Every file under `dir`, relative and sorted — what "the tree is unchanged" is measured on. */
function treeOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function calls(log: Call[], fn: Call['fn']): Call[] {
  return log.filter((entry) => entry.fn === fn);
}

// ── AC1 and AC2: what one press actually does ───────────────────────────────────────────────

suite('DetourSession.start — the example is written, opened and narrated (ACs 1, 2)', () => {
  teardown(cleanTempDirs);

  test('a good reply becomes files under globalStorage/detours, tabs, a narrator and stop 1', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    const result = await fake.session.start(s, plan, '/somewhere/the-authors-repo');

    assert.equal(result.started, true, 'a well-formed reply opens a detour');
    assert.equal(result.started && result.title, GOOD_DETOUR.title, 'and hands back the title AC4 records');

    // The files, on a real disk, under the extension's own storage and nowhere else.
    const dir = detourDir(fake.storage, STEP_ID);
    assert.deepEqual(
      treeOf(dir),
      ['coins.ts', 'machine.ts', path.join('stock', 'tray.ts')].sort(),
      'every file in the reply is on disk, at its own relative path, nested folders included',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'coins.ts'), 'utf8'),
      GOOD_DETOUR.files[0]?.content,
      'and holds exactly what the model sent — no re-encoding on the way through',
    );

    // AC2's own check, at this level: everything written is inside the detours folder.
    for (const rel of treeOf(fake.storage)) {
      assert.ok(
        rel.startsWith('detours' + path.sep),
        `nothing outside <storage>/detours was written, but ${rel} was`,
      );
    }

    // One tab per file, in the reply's own order, at the paths that were really written.
    const tabs = calls(fake.log, 'openDetourTab');
    assert.equal(tabs.length, 3, 'one real editor tab per file (AC2)');
    assert.deepEqual(
      tabs.map((c) => (c.fn === 'openDetourTab' ? path.relative(dir, c.absPath) : '')),
      ['coins.ts', path.join('stock', 'tray.ts'), 'machine.ts'],
      'in the order the model listed them, so the narration and the tabs agree',
    );

    const shown = calls(fake.log, 'showNarrator');
    assert.ok(shown.length >= 1, 'the narrator is raised');
    const last = shown[shown.length - 1];
    assert.ok(last?.fn === 'showNarrator');
    assert.equal(last.state.current, 0, 'and parks on the FIRST stop — goto(0)');
    assert.equal(last.state.detour.title, GOOD_DETOUR.title, 'with the detour it is narrating');

    // …and that stop's range is revealed and decorated in ITS OWN tab.
    const reveals = calls(fake.log, 'revealDetourStop');
    assert.equal(reveals.length, 1, 'exactly one reveal, for the stop it landed on');
    const reveal = reveals[0];
    assert.ok(reveal?.fn === 'revealDetourStop');
    assert.equal(path.relative(dir, reveal.absPath), 'coins.ts', "the first stop's own file");
    assert.equal(reveal.startLine, 1);
    assert.equal(reveal.endLine, 1);
  });

  test('the narrator is raised BEFORE the reveal, so the prose is never behind the highlight', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    const order = fake.log.map((c) => c.fn);
    const narrator = order.indexOf('showNarrator');
    const reveal = order.indexOf('revealDetourStop');
    assert.ok(narrator >= 0 && reveal >= 0, 'both happened');
    assert.ok(narrator < reveal, 'the narrator is on screen before the editor is scrolled under it');
    // Every tab is open before either: a stop cannot be revealed into a tab that is not there.
    assert.ok(order.lastIndexOf('openDetourTab') < narrator, 'and every tab is open before the narrator');
  });

  test('the prompt that is SENT is the detour prompt, not the tutor conversation', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, '/tmp/checkouts/the-authors-repo');

    const sent = calls(fake.log, 'runLlm');
    assert.equal(sent.length, 1, 'exactly one model call for one press');
    const prompt = sent[0]?.fn === 'runLlm' ? sent[0].prompt : '';
    assert.ok(
      !prompt.startsWith('CONVERSATION PROMPT'),
      'it did NOT go through buildAskPrompt — repo-tour\'s persona asks for prose under 200 words, '
      + 'which is the opposite of the one JSON object this asks for',
    );
    assert.ok(prompt.includes('--- WHAT TO RETURN ---'), 'it is detourPrompt\'s own document');
    assert.ok(prompt.includes('the-authors-repo'), "and it names the learner's own domain, to avoid it (AC1)");
    // The FOLDER NAME, exactly as `tutorContext` names it for the tutor — never the whole
    // path, which can be a URL with a token in it and is going to a paid third party.
    assert.ok(!prompt.includes('/tmp/checkouts'), 'and only the folder name leaves this machine');
  });
});

// ── AC5: retaking is free, and a failure says why ───────────────────────────────────────────

suite('DetourSession.start — the cache (AC5)', () => {
  teardown(cleanTempDirs);

  test('a second start on the same step makes NO model call and no provider probe', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    await fake.session.start(s, plan, 'ref');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'the first press pays for one answer');
    await fake.session.returnToBuild();

    const before = fake.log.length;
    const again = await fake.session.start(s, plan, 'ref');

    assert.equal(again.started, true, 'the retake opens the same example');
    const after = fake.log.slice(before);
    assert.equal(after.filter((c) => c.fn === 'runLlm').length, 0, 'AC5: the second run makes NO LLM call');
    assert.equal(
      after.filter((c) => c.fn === 'availability').length,
      0,
      'and no provider probe either — a cached detour must reopen on a machine where the provider '
      + 'has since been uninstalled, which is what "retaking is free" has to mean to be worth having',
    );
    assert.equal(after.filter((c) => c.fn === 'openDetourTab').length, 3, 'the tabs come back all the same');
  });

  test('the cache is keyed by prompt VERSION, so a bumped version is a miss by construction', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    assert.ok(readCachedDetour(fake.storage, STEP_ID, DETOUR_PROMPT_VERSION) !== null, 'it really was cached');
    assert.equal(
      readCachedDetour(fake.storage, STEP_ID, DETOUR_PROMPT_VERSION + 1),
      null,
      'and the entry does not answer for a prompt that no longer asks the same question',
    );
  });

  test('the cache is per STEP — a different step is a miss and pays for its own answer', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const plan = fixturePlan();
    const first = plan.steps.find((s) => s.id === STEP_ID);
    const other = plan.steps.find((s) => s.id === 'st-4-symbol-render');
    assert.ok(first && other);

    await fake.session.start(first, plan, 'ref');
    await fake.session.returnToBuild();
    await fake.session.start(other, plan, 'ref');

    assert.equal(calls(fake.log, 'runLlm').length, 2, 'two steps, two answers — the key is the step id');
  });

  test('a poisoned cache entry is a MISS, not a detour — it is sanitised, never trusted', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    // Hand-written by "another tool" — legal JSON, wrong shape. `sanitizeDetour` drops the
    // whole entry rather than half-trusting it, because a stop refers to one of the detour's
    // own files and a half-trusted detour opens editor tabs.
    writeCachedDetour(fake.storage, STEP_ID, DETOUR_PROMPT_VERSION, GOOD_DETOUR);
    const cachePath = path.join(detoursRoot(fake.storage), 'cache');
    const entry = fs.readdirSync(cachePath)[0];
    assert.ok(entry);
    fs.writeFileSync(path.join(cachePath, entry), JSON.stringify({ title: 'x', domain: 'y', files: 'not an array', stops: [] }));

    const result = await fake.session.start(s, plan, 'ref');
    assert.equal(result.started, true, 'the press still works');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'by paying for a fresh answer rather than opening the poison');
  });
});

suite('DetourSession.start — a failed generation says WHY (AC5)', () => {
  teardown(cleanTempDirs);

  /** Every refusal path ends the same way: nothing on disk, nothing open, and a sentence. */
  async function refusedBy(canned: string): Promise<{ note: string; storage: string; log: Call[] }> {
    const fake = makeFake({ canned });
    const { plan, step: s } = step();
    const result = await fake.session.start(s, plan, 'ref');
    assert.equal(result.started, false, 'a reply this shape must not open a detour');
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and must open no tabs');
    assert.equal(calls(fake.log, 'showNarrator').length, 0, 'and raise no narrator');
    assert.equal(treeOf(detourDir(fake.storage, STEP_ID)).length, 0, 'and leave nothing on disk');
    return { note: result.started ? '' : result.note, storage: fake.storage, log: fake.log };
  }

  test('a reply that is not JSON at all', async () => {
    const { note } = await refusedBy('I would rather not, thanks.');
    assert.ok(note.length > 0, 'it says something');
    assert.ok(/JSON/i.test(note), 'and names what was wrong, rather than "something went wrong"');
  });

  test('too many files — the number is in the sentence', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, content: 'x\n' }));
    const { note } = await refusedBy(replyOf({ ...GOOD_DETOUR, files }));
    assert.ok(note.includes('7'), 'the count the model actually sent');
    assert.ok(note.includes('5'), 'and the limit it broke');
  });

  test('too few stops — the number is in the sentence', async () => {
    const { note } = await refusedBy(replyOf({ ...GOOD_DETOUR, stops: GOOD_DETOUR.stops.slice(0, 1) }));
    assert.ok(note.includes('1') && note.includes('3'), 'what was sent, and the range that was asked for');
  });

  test('a stop pointing at a file the model never sent', async () => {
    const { note } = await refusedBy(replyOf({
      ...GOOD_DETOUR,
      stops: [...GOOD_DETOUR.stops.slice(1), { file: 'ghost.ts', startLine: 1, endLine: 1, text: 'look here' }],
    }));
    assert.ok(note.includes('ghost.ts'), 'the file it named');
  });

  test('every DetourRefusal arm has a sentence, and none of them is empty', () => {
    // The union is the contract `./types.ts` wrote down for exactly this; a new arm with no
    // sentence would be a refusal the panel could not explain, which is the failure mode both
    // T-6 reviews named. Exhaustive by construction — a missing arm does not compile.
    const all = [
      refusalSentence({ reason: 'not-json', detail: 'x' }),
      refusalSentence({ reason: 'bad-shape', detail: 'x' }),
      refusalSentence({ reason: 'too-many-files', found: 9 }),
      refusalSentence({ reason: 'file-too-long', path: 'a.ts', lines: 99 }),
      refusalSentence({ reason: 'bad-stop-count', found: 0 }),
      refusalSentence({ reason: 'stop-file-unknown', file: 'a.ts' }),
      refusalSentence({ reason: 'bad-range', file: 'a.ts', detail: 'x' }),
      refusalSentence({ reason: 'unsafe-path', path: '../x', detail: 'climbs out' }),
    ];
    for (const sentence of all) assert.ok(sentence.trim().length > 20, `a real sentence, not "${sentence}"`);
    assert.equal(new Set(all).size, all.length, 'and each arm says something different from the others');
  });

  test('an unreachable provider is honest, costs nothing, and is carried up to the standing line', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR), availability: { ok: false, detail: 'not found on PATH' } });
    const { plan, step: s } = step();

    const result = await fake.session.start(s, plan, 'ref');

    assert.equal(result.started, false);
    assert.ok(result.started === false && result.note.includes('not found on PATH'), "the provider's OWN words, not a house phrasing");
    assert.equal(calls(fake.log, 'runLlm').length, 0, 'nothing was sent');
    assert.deepEqual(fake.ledger.spend().replies, 0, 'and nothing was billed');
    assert.equal(fake.unreachable(), 'not found on PATH', 'and the walk keeps the standing line beside the input');
  });

  test('no tutor wired at all is an honest answer rather than a broken button', async () => {
    const fake = makeFake({ noSettings: true });
    const { plan, step: s } = step();
    const result = await fake.session.start(s, plan, 'ref');
    assert.equal(result.started, false);
    assert.ok(result.started === false && result.note.includes('repo-tour'), 'it names what is missing');
    assert.equal(calls(fake.log, 'availability').length, 0, 'and does not probe a provider it has no way to reach');
  });

  test('the poison is real — a test that answers for nothing reaches no model, it FAILS', async () => {
    const fake = makeFake();
    const { plan, step: s } = step();
    const result = await fake.session.start(s, plan, 'ref');
    assert.equal(result.started, false, 'the failure is a refusal, not a crash');
    assert.ok(result.started === false && result.note.includes(SPEND_GUARD), 'and it is the guard that answered');
  });
});

// ── containment: the half a pure function cannot do ─────────────────────────────────────────

suite('DetourSession.start — every write goes through prepareDetourWrite', () => {
  teardown(cleanTempDirs);

  /** A hostile path is refused with its own reason, nothing lands, and the other files still
   *  do — one bad file must not cost the learner the example. */
  async function hostilePath(bad: string): Promise<{ note: string | undefined; storage: string; started: boolean }> {
    const fake = makeFake({
      canned: replyOf({
        ...GOOD_DETOUR,
        files: [{ path: bad, content: 'OWNED\n' }, ...GOOD_DETOUR.files],
      }),
    });
    const { plan, step: s } = step();
    const result = await fake.session.start(s, plan, 'ref');
    return { note: result.note, storage: fake.storage, started: result.started };
  }

  for (const bad of [
    '../escaped.ts',
    '../../escaped.ts',
    'a/../../escaped.ts',
    '/etc/escaped.ts',
    'C:\\escaped.ts',
    'a\\b.ts',
    '.ssh/authorized_keys',
    'nested/../../../escaped.ts',
  ]) {
    test(`"${bad}" is refused, by name, and writes nothing`, async () => {
      const { note, storage, started } = await hostilePath(bad);

      // The refusal is REPORTED. `parseDetourReply` rejects the whole reply for a path this
      // shape, so the honest outcome is a refusal with a reason rather than four files out of
      // five — the point being that the learner is told, either way.
      assert.ok(note !== undefined && note.length > 0, 'it says why');

      // And on the disk: nothing anywhere in the storage root but (at most) the detours
      // folder and its cache. `escaped.ts` exists nowhere under it, at any depth.
      for (const rel of treeOf(storage)) {
        assert.ok(!rel.includes('escaped.ts'), `${rel} should not exist`);
        assert.ok(!rel.includes('authorized_keys'), `${rel} should not exist`);
      }
      assert.equal(started, false, 'and no detour opened on a reply that tried it');
    });
  }

  test('a store root that is a LINK to somewhere else writes nothing, anywhere (T-5\'s HIGH)', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const outside = tmpDir('detour-outside-');

    // The exact shape T-5's merge-blocking finding was: a path that is contained as a STRING
    // and elsewhere on the DISK. `<storage>/detours` is where every detour goes, so a link
    // standing there would make every "contained" write land in the attacker's folder — and
    // `prepareDetourWrite` alone cannot see it, because it resolves the DETOUR directory and
    // would agree that everything is inside whatever that resolves to. `provenStoreRoot`, one
    // level further up, is what refuses; it is reached because `writeDetour` clears through
    // `removeDetour` before it writes.
    fs.symlinkSync(outside, detoursRoot(fake.storage), 'dir');

    const { plan, step: s } = step();
    const result = await fake.session.start(s, plan, 'ref');

    assert.equal(result.started, false, 'the detour is refused rather than written through the link');
    assert.deepEqual(treeOf(outside), [], 'and the folder on the other end stays EMPTY');
  });

  test('a file already standing as a SYMLINK at its destination is refused, not written through', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    // First press writes the detour for real.
    await fake.session.start(s, plan, 'ref');
    const dir = detourDir(fake.storage, STEP_ID);

    // Now replace one of its files with a link out. A second press clears the directory first,
    // so this is not the state a real second press would find — which is exactly why the check
    // is driven directly rather than only through `start`: the guard has to hold whether or
    // not the clearing ran, because "a defence that relies on a caller in another file is not
    // a defence this file has" (`store.ts`'s own words).
    const victim = path.join(tmpDir('detour-victim-'), 'secret.txt');
    fs.writeFileSync(victim, 'the learner\'s secret\n');
    fs.rmSync(path.join(dir, 'coins.ts'));
    fs.symlinkSync(victim, path.join(dir, 'coins.ts'));

    const answer = prepareDetourWrite(dir, 'coins.ts');
    assert.ok(typeof answer !== 'string', 'a symlink at the destination is refused');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'the learner\'s secret\n', 'and the file it pointed at is untouched');
  });

  test('the written paths are the ones prepareDetourWrite returned, under the RESOLVED root', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    const realDir = fs.realpathSync(detourDir(fake.storage, STEP_ID));
    for (const call of calls(fake.log, 'openDetourTab')) {
      assert.ok(call.fn === 'openDetourTab');
      assert.ok(
        call.absPath.startsWith(realDir + path.sep),
        `${call.absPath} should sit under the resolved detour directory ${realDir} — the composed `
        + 'path is not what is opened, because on a platform whose temp root is a symlink the two differ',
      );
      assert.ok(fs.lstatSync(call.absPath).isFile(), 'and every one of them is a real file, not a link');
    }
  });
});

// ── R2: the ledger is the only way a paid request starts ────────────────────────────────────

suite('DetourSession — the generation is the LEDGER\'s request (plan R2)', () => {
  teardown(cleanTempDirs);

  test('what the detour spent is in the walk\'s own total, not beside it', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();

    assert.equal(fake.ledger.spend().replies, 0, 'nothing spent before the press');
    await fake.session.start(s, plan, 'ref');

    const spend = fake.ledger.spend();
    assert.equal(spend.replies, 1, 'the detour\'s answer is counted');
    assert.equal(spend.inputTokens, 3);
    assert.equal(spend.outputTokens, 7);
    assert.equal(spend.usd, 0.5, 'at what it cost — a request outside the ledger would show zero here');
    assert.equal(spend.metered, true);
  });

  test('the request is LIVE in the ledger while it runs, on the step it was asked from', async () => {
    let release: ((reply: LlmReply) => void) | undefined;
    const fake = makeFake({
      runner: () => new Promise<LlmReply>((resolve) => { release = resolve; }),
    });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    const live = fake.ledger.live();
    assert.equal(live.length, 1, 'the ledger knows about it');
    assert.equal(live[0]?.stepId, STEP_ID, 'and which step it belongs to — so a panel elsewhere can offer to stop it');
    assert.equal(live[0]?.phase, 'sending', 'and that it is billing right now');
    assert.equal(fake.session.view(STEP_ID).generating, true, 'the button says so');

    release?.({ text: replyOf(GOOD_DETOUR), inputTokens: 1, outputTokens: 1, usd: 0, metered: false });
    await running;
    assert.equal(fake.ledger.live().length, 0, 'and it is gone when it ends');
    assert.equal(fake.session.view(STEP_ID).generating, false, 'as is the sentence about waiting');
  });

  test('abandonAll reaches it — one Cancel really does stop every live request', async () => {
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => { /* never answers */ }) });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    fake.ledger.abandonAll();
    const result = await running;

    assert.equal(result.started, false, 'the detour does not open behind a cancel');
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and nothing was opened');
    assert.equal(treeOf(detourDir(fake.storage, STEP_ID)).length, 0, 'and nothing was written');
  });

  test('cancel() answers whether it acted — a Cancel with nothing running must stay a no-op', async () => {
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => undefined) });
    const { plan, step: s } = step();

    assert.equal(fake.session.cancel(), false, 'nothing to stop');
    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.equal(fake.session.cancel(), true, 'something to stop');
    assert.equal(fake.session.cancel(), false, 'and it is idempotent');
    await running;
  });

  test('one generation at a time — a second press while the first runs is answered, not queued', async () => {
    const fake = makeFake({ runner: () => new Promise<LlmReply>(() => undefined) });
    const { plan, step: s } = step();

    const first = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const second = await fake.session.start(s, plan, 'ref');

    assert.equal(second.started, false);
    assert.ok(second.started === false && second.note.includes('already'), 'and it says so rather than doing nothing');
    assert.equal(calls(fake.log, 'runLlm').length, 1, 'the second press did not start a second billed request');
    fake.session.cancel();
    await first;
  });
});

// ── AC3: the way back leaves nothing behind ─────────────────────────────────────────────────

suite('DetourSession.returnToBuild — closes what it opened, deletes what it wrote (AC3)', () => {
  teardown(cleanTempDirs);

  test('the tabs, the narrator and the directory all go, and the title comes back for AC4', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    const dir = detourDir(fake.storage, STEP_ID);
    assert.equal(treeOf(dir).length, 3, 'the example really was on disk first');

    const before = fake.log.length;
    const result = await fake.session.returnToBuild();
    const after = fake.log.slice(before);

    assert.equal(result.returned, true);
    assert.equal(result.returned && result.stepId, STEP_ID, 'the step it belonged to — not whatever is current now');
    assert.equal(result.returned && result.title, GOOD_DETOUR.title, 'the title the transcript note records');
    assert.equal(result.returned && result.note, undefined, 'and nothing to apologise for');

    assert.equal(after.filter((c) => c.fn === 'closeTabsUnder').length, 1, 'the tabs are closed');
    assert.equal(after.filter((c) => c.fn === 'closeNarrator').length, 1, 'the narrator is disposed');
    assert.equal(fs.existsSync(dir), false, 'AC3: the directory is ABSENT');
    assert.equal(fake.session.activeStepId(), undefined, 'and nothing is open any more');
  });

  test('the tabs are closed BEFORE the files are deleted', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    const dir = detourDir(fake.storage, STEP_ID);

    let existedWhenClosing: boolean | undefined;
    // The adapter is asked while the return is mid-flight, which is the only moment the order
    // is observable — a learner staring at a "file not found" they did nothing to deserve is
    // what closing after deleting looks like from the outside.
    const wrapped = fake.session as unknown as { deps: { adapters: DetourAdapters } };
    const original = wrapped.deps.adapters.closeTabsUnder.bind(wrapped.deps.adapters);
    wrapped.deps.adapters.closeTabsUnder = (prefixes) => {
      existedWhenClosing = fs.existsSync(dir);
      return original(prefixes);
    };

    await fake.session.returnToBuild();
    assert.equal(existedWhenClosing, true, 'the files were still there when the tabs were asked to close');
    assert.equal(fs.existsSync(dir), false, 'and gone by the end');
  });

  test('BOTH spellings of the folder are handed to the tab matcher', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    await fake.session.returnToBuild();
    const close = calls(fake.log, 'closeTabsUnder')[0];
    assert.ok(close?.fn === 'closeTabsUnder');

    const composed = detourDir(fake.storage, STEP_ID);
    const resolved = fs.realpathSync(path.dirname(composed)) + path.sep + path.basename(composed);
    assert.ok(close.prefixes.includes(composed) || close.prefixes.includes(resolved), 'the folder is named');
    // On a platform whose temp root is a symlink the two differ and BOTH must be matched, or
    // every tab stays open on that platform. Where they are the same string, one is correct
    // and a duplicate would be needless work on the common path.
    if (composed !== resolved) {
      assert.deepEqual([...close.prefixes].sort(), [composed, resolved].sort(), 'both spellings');
    } else {
      assert.deepEqual(close.prefixes, [composed], 'one spelling, because there is only one');
    }
  });

  test('a return with nothing open says so rather than doing nothing', async () => {
    const fake = makeFake();
    const result = await fake.session.returnToBuild();
    assert.equal(result.returned, false);
    assert.ok(result.returned === false && result.note.length > 0, 'and it is a sentence, not silence');
  });
});

// ── honest controls: a tab that will not close ──────────────────────────────────────────────

suite('DetourSession.returnToBuild — honest when a tab will not close', () => {
  teardown(cleanTempDirs);

  test('the directory is STILL deleted and the learner is told WHICH tab to close', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    const dir = detourDir(fake.storage, STEP_ID);
    const stubborn = path.join(fs.realpathSync(dir), 'machine.ts');
    fake.stuck.add(stubborn);

    const result = await fake.session.returnToBuild();

    assert.equal(result.returned, true, 'the return still happens — a learner is not stranded in a detour by an unsaved buffer');
    assert.equal(fs.existsSync(dir), false, 'and the directory is still deleted, exactly as promised');
    const note = result.returned ? result.note : undefined;
    assert.ok(note !== undefined, 'and it is NOT silent: a partial success that said nothing would be the dishonest version');
    assert.ok(note.includes('machine.ts'), 'it names the tab, by a name the learner can find');
    assert.ok(/close/i.test(note), 'and says what to do about it');
  });

  test('the plural agrees with itself, because a sentence that does not reads like a bug', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    const real = fs.realpathSync(detourDir(fake.storage, STEP_ID));
    fake.stuck.add(path.join(real, 'machine.ts'));
    fake.stuck.add(path.join(real, 'coins.ts'));

    const result = await fake.session.returnToBuild();
    const note = result.returned ? result.note ?? '' : '';
    assert.ok(note.includes('These tabs are'), `two tabs get a plural sentence, not "${note}"`);
  });

  test('an adapter that throws is reported as everything still open — the conservative direction', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR), closeThrows: true });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    const result = await fake.session.returnToBuild();
    assert.equal(result.returned, true, 'the return still completes');
    assert.equal(fs.existsSync(detourDir(fake.storage, STEP_ID)), false, 'the files still go');
    const note = result.returned ? result.note ?? '' : '';
    assert.ok(note.includes('coins.ts') && note.includes('machine.ts'), 'and every tab is named, because none of them is known to have closed');
  });

  test('a file that would not open is reported, and the rest of the example still opens', async () => {
    const fake = makeFake({
      canned: replyOf(GOOD_DETOUR),
      openThrows: (absPath) => absPath.endsWith('machine.ts'),
    });
    const { plan, step: s } = step();

    const result = await fake.session.start(s, plan, 'ref');
    assert.equal(result.started, true, 'one tab that will not open does not cost the learner the example');
    assert.ok(result.started && result.note?.includes('machine.ts'), 'and it is said out loud');
    assert.equal(calls(fake.log, 'showNarrator').length >= 1, true, 'the narrator still walks the stops');
  });
});

// ── the lifecycle: a superseded or cancelled detour lands NOWHERE ────────────────────────────

suite('DetourSession — nothing lands after the moment it belonged to', () => {
  teardown(cleanTempDirs);

  test('a session disposed mid-generation opens nothing, writes nothing and narrates nothing', async () => {
    let release: ((reply: LlmReply) => void) | undefined;
    const fake = makeFake({ runner: () => new Promise<LlmReply>((resolve) => { release = resolve; }) });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await fake.session.dispose();

    // The answer arrives AFTER the walk went away — the case T-6's reviews proved closed and
    // this must not reopen.
    release?.({ text: replyOf(GOOD_DETOUR), inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
    const result = await running;

    assert.equal(result.started, false);
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'no tab');
    assert.equal(calls(fake.log, 'showNarrator').length, 0, 'no narrator');
    assert.equal(treeOf(detourDir(fake.storage, STEP_ID)).length, 0, 'and no files');
  });

  test('dispose is idempotent and turns every method into a no-op', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    await fake.session.dispose();
    await fake.session.dispose();
    assert.equal(fs.existsSync(detourDir(fake.storage, STEP_ID)), false, 'the detour went with the session');

    const before = fake.log.length;
    const started = await fake.session.start(s, plan, 'ref');
    await fake.session.goto(1);
    await fake.session.next();
    const returned = await fake.session.returnToBuild();
    assert.equal(started.started, false, 'no detour starts on a dead session');
    assert.equal(returned.returned, false);
    assert.equal(fake.log.length, before, 'and not one adapter was touched');
  });

  test('a SUPERSEDED generation removes what it wrote rather than leaving it for the next press', async () => {
    // Two presses: the first is still waiting when the second is cancelled out from under it.
    // The supersede is arranged by cancelling, which bumps the same counter a second start
    // would — the two take one road out by design (see `stopped`).
    let release: ((reply: LlmReply) => void) | undefined;
    const fake = makeFake({ runner: () => new Promise<LlmReply>((resolve) => { release = resolve; }) });
    const { plan, step: s } = step();

    const running = fake.session.start(s, plan, 'ref');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    fake.session.cancel();
    release?.({ text: replyOf(GOOD_DETOUR), inputTokens: 0, outputTokens: 0, usd: 0, metered: false });
    const result = await running;

    assert.equal(result.started, false, 'the overtaken generation does not open');
    assert.equal(treeOf(detourDir(fake.storage, STEP_ID)).length, 0, 'and leaves no directory behind');
    assert.equal(calls(fake.log, 'openDetourTab').length, 0, 'and no tab anywhere');
  });

  test('starting a SECOND detour closes the first — one narrator, one example', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const plan = fixturePlan();
    const first = plan.steps.find((st) => st.id === STEP_ID);
    const other = plan.steps.find((st) => st.id === 'st-4-symbol-render');
    assert.ok(first && other);

    await fake.session.start(first, plan, 'ref');
    const firstDir = detourDir(fake.storage, STEP_ID);
    await fake.session.start(other, plan, 'ref');

    assert.equal(fs.existsSync(firstDir), false, "the first example's files are gone");
    assert.equal(fake.session.activeStepId(), 'st-4-symbol-render', 'and the open one is the second');
    assert.equal(treeOf(detourDir(fake.storage, 'st-4-symbol-render')).length, 3, 'which really is on disk');
  });
});

// ── walking the stops ───────────────────────────────────────────────────────────────────────

suite('DetourSession — next, prev and goto walk the narrator (AC2)', () => {
  teardown(cleanTempDirs);

  async function opened() {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    return fake;
  }

  function currentStop(fake: Fake): number | undefined {
    const shown = calls(fake.log, 'showNarrator');
    const last = shown[shown.length - 1];
    return last?.fn === 'showNarrator' ? last.state.current : undefined;
  }

  test('next walks forward and STOPS at the last — no wraparound', async () => {
    const fake = await opened();
    assert.equal(currentStop(fake), 0);
    await fake.session.next();
    assert.equal(currentStop(fake), 1);
    await fake.session.next();
    assert.equal(currentStop(fake), 2);
    await fake.session.next();
    assert.equal(currentStop(fake), 2, 'Next at the end stays put rather than starting the example again');
  });

  test('prev walks back and stops at the first', async () => {
    const fake = await opened();
    await fake.session.goto(2);
    await fake.session.prev();
    assert.equal(currentStop(fake), 1);
    await fake.session.prev();
    assert.equal(currentStop(fake), 0);
    await fake.session.prev();
    assert.equal(currentStop(fake), 0, 'and does not run off the front');
  });

  test('each stop reveals ITS OWN file, at its own lines', async () => {
    const fake = await opened();
    const dir = fs.realpathSync(detourDir(fake.storage, STEP_ID));
    await fake.session.goto(1);
    await fake.session.goto(2);

    const reveals = calls(fake.log, 'revealDetourStop').map((c) =>
      (c.fn === 'revealDetourStop' ? [path.relative(dir, c.absPath), c.startLine, c.endLine] : []));
    assert.deepEqual(reveals, [
      ['coins.ts', 1, 1],
      [path.join('stock', 'tray.ts'), 1, 2],
      ['machine.ts', 2, 2],
    ], 'the three stops, each pointing into the file it names');
  });

  test('an index off either end is CLAMPED, never a blank page or a throw', async () => {
    const fake = await opened();
    await fake.session.goto(99);
    assert.equal(currentStop(fake), 2, 'past the end is the last stop');
    await fake.session.goto(-5);
    assert.equal(currentStop(fake), 0, 'before the start is the first');
    await fake.session.goto(Number.NaN);
    assert.equal(currentStop(fake), 0, 'and a number that is not one is the first, not a crash');
  });

  test('walking with nothing open touches nothing', async () => {
    const fake = makeFake();
    await fake.session.goto(0);
    await fake.session.next();
    await fake.session.prev();
    assert.deepEqual(fake.log, [], 'no narrator, no reveal, no anything');
  });
});

// ── the view the panel draws (plan R4's other half) ─────────────────────────────────────────

suite('DetourSession.view — what the button is told', () => {
  teardown(cleanTempDirs);

  test('the empty state is what puts the button on the page', () => {
    const fake = makeFake();
    assert.deepEqual(fake.session.view(STEP_ID), { generating: false }, 'absent keys, not undefined ones');
  });

  test('an open detour is reported on EVERY step, with the step it belongs to', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');

    const here = fake.session.view(STEP_ID);
    const elsewhere = fake.session.view('st-4-symbol-render');
    assert.deepEqual(here.open, { stepId: STEP_ID, title: GOOD_DETOUR.title });
    assert.deepEqual(
      elsewhere.open,
      { stepId: STEP_ID, title: GOOD_DETOUR.title },
      'the way out has to be reachable from wherever the learner is standing — a control that '
      + 'names something it cannot act on is what this repo rules out',
    );
    assert.equal(elsewhere.generating, false, 'while `generating` stays per-step');
  });

  test('a refusal is on the view as well as in the result, so the panel can draw it', async () => {
    const fake = makeFake({ canned: 'not json at all' });
    const { plan, step: s } = step();
    await fake.session.start(s, plan, 'ref');
    const note = fake.session.view(STEP_ID).note;
    assert.ok(note !== undefined && note.length > 0, 'AC5: the panel has the sentence');
    fake.session.clearNote();
    assert.equal(fake.session.view(STEP_ID).note, undefined, 'and it is cleared when the walk moves');
  });

  test('every refusal pushes, so the button cannot be left saying it is still writing', async () => {
    const fake = makeFake({ canned: 'not json at all' });
    const { plan, step: s } = step();
    const before = fake.refreshes();
    await fake.session.start(s, plan, 'ref');
    assert.ok(fake.refreshes() > before, 'the panel was told');
    assert.equal(fake.session.view(STEP_ID).generating, false, 'and nothing is left generating');
  });
});

suite('DetourSession — a second example does not un-tell the first one\'s bad news', () => {
  teardown(cleanTempDirs);

  test('a tab of the OLD detour that would not close is still named after the new one opens', async () => {
    const fake = makeFake({ canned: replyOf(GOOD_DETOUR) });
    const plan = fixturePlan();
    const first = plan.steps.find((st) => st.id === STEP_ID);
    const other = plan.steps.find((st) => st.id === 'st-4-symbol-render');
    assert.ok(first && other);

    await fake.session.start(first, plan, 'ref');
    const stubborn = path.join(fs.realpathSync(detourDir(fake.storage, STEP_ID)), 'machine.ts');
    fake.stuck.add(stubborn);

    const result = await fake.session.start(other, plan, 'ref');

    assert.equal(result.started, true, 'the new example opens');
    const note = result.started ? result.note ?? '' : '';
    // The stuck tab is still on the learner's screen. Saying so and then replacing the
    // sentence with one about the new example would be the silence this rule forbids, with an
    // extra step in front of it.
    assert.ok(note.includes('machine.ts'), `the old detour's stuck tab is still named, got "${note}"`);
    assert.ok(fake.session.view(STEP_ID).note?.includes('machine.ts'), 'and the panel is told the same thing');
  });
});
