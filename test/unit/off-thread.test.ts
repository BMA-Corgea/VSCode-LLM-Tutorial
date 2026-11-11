// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-30: the build's digest and buildPlan, off the extension host's thread.
 *
 * Plain mocha, a REAL worker thread (`dist/build-worker.js`, as esbuild built it) and the REAL
 * repo-tour, or a stub core root where a test needs a phase to fail in a particular way. Nothing
 * here spends a token: the one build that reaches `interpretPlan` runs with `cachedOnly: true`.
 * What only the real extension host can show, the stall and the real Cancel button, is
 * `test/build-off-thread.test.ts` and `test/start-screen.test.ts`.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO_TOUR_PATH, loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import {
  BuildPhaseCancelled, buildFromRequest, coreFor, markerPath, phaseCancelled, readMarker, TRY_AGAIN,
  type BuildContext, type BuildCore, type BuildOutcome, type BuildPhase, type DigestResultLike,
} from '../../src/start/build.js';
import { BUILD_WORKER_HEAP_MB, offThreadCore, type OffThreadDeps } from '../../src/start/off-thread.js';
import { emptyRequest, type BuildRequest } from '../../src/start/request.js';
import { BUILD_WORKER_RELATIVE } from '../../src/start/worker-protocol.js';
import { STALL_BOUND_MS } from '../support/stall-bound.js';

const CORE_ROOT = resolveCoreRoot(DEFAULT_REPO_TOUR_PATH, process.cwd()); // the root the shipped default resolves to
const WORKER = path.join(process.cwd(), BUILD_WORKER_RELATIVE);

let loaded: CoreLoadResult;
let realCore: BuildCore;
let defaultModel: string;
const made: string[] = [];

suiteSetup(async () => {
  loaded = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = coreFor(loaded.loaded);
  defaultModel = (loaded.loaded['interpret'] as { DEFAULT_MODEL: string }).DEFAULT_MODEL;
});

suiteTeardown(function () {
  this.timeout(120_000); // two fixtures of 20,000 files take longer to remove than mocha's 2 s
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function requestFor(repo: string, target: string): BuildRequest {
  return { ...emptyRequest(), recreate: true, repo, target };
}

/** T-15's shape: Go only, so the build ends at the language refusal after a read of `dirs × each` files. */
function goFixture(dirs: number, each: number): string {
  const root = tmp('t30-go-');
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `pkg${d}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < each; i++) fs.writeFileSync(path.join(dir, `f${i}.go`), `package pkg${d}\n\nfunc F${i}() int { return ${i} }\n`);
  }
  return root;
}

function tsFixture(dirs: number, each: number): string {
  const root = tmp('t30-ts-');
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `pkg${d}`);
    fs.mkdirSync(dir);
    for (let i = 0; i < each; i++) {
      const next = (i + 1) % each;
      fs.writeFileSync(path.join(dir, `f${i}.ts`), `import { f${next} } from './f${next}.js';\n\n/** doc ${i} */\nexport function f${i}(a: number): number {\n  return a + ${i};\n}\nexport const v${i} = f${next};\n`);
    }
  }
  return root;
}

/** A fixture the grammars have to work on, in every language they cover, with a real syntax error. */
function mixedFixture(): string {
  const root = tmp('t30-mixed-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'app.tsx'), "import { add } from './util';\n\nexport function App(): JSX.Element {\n  return <div>{add(1, 2)}</div>;\n}\n");
  fs.writeFileSync(path.join(root, 'src', 'plain.js'), 'export function twice(x) {\n  return x * 2;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'tool.py'), 'import os\n\n\ndef where():\n    """Where we are."""\n    return os.getcwd()\n');
  fs.writeFileSync(path.join(root, 'src', 'broken.ts'), 'export function nope( {\n  return\n');
  return root;
}

/** A stand-in repo-tour whose modules do what a test needs. `load` is by file: `dist/digest.js`, `dist/build.js`. */
function stubCore(files: Record<string, string>): string {
  const root = tmp('t30-stub-core-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'repo-tour', version: '0.0.0', type: 'module' }));
  fs.mkdirSync(path.join(root, 'dist'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'dist', name), body);
  return root;
}

const OK_DIGEST = `export async function digest() { return { manifest: {}, inventory: { files: [] } }; }\n`;

interface Harness {
  deps: OffThreadDeps;
  /** Resolves with a thread's exit code once one has exited, or rejects if none does within `ms`. */
  exited(ms: number): Promise<number>;
  /** How many worker threads this harness has seen start. */
  started(): number;
}

function harness(overrides: Partial<OffThreadDeps> = {}): Harness {
  let exitedWith: ((code: number) => void) | undefined;
  const exit = new Promise<number>((resolve) => { exitedWith = resolve; });
  let starts = 0;
  return {
    deps: {
      workerFile: WORKER,
      coreRoot: CORE_ROOT,
      inProcess: realCore,
      observe: { started: () => { starts += 1; }, exited: (code) => exitedWith?.(code) },
      ...overrides,
    },
    exited: (ms) => Promise.race([
      exit,
      new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error(`no worker thread exited within ${ms} ms`)), ms)),
    ]),
    started: () => starts,
  };
}

function contextFor(core: BuildCore, overrides: Partial<BuildContext> = {}): BuildContext {
  return { core, globalStorageRoot: tmp('t30-storage-'), provider: 'claude', model: defaultModel, cachedOnly: true, ...overrides };
}

/** Every path under `root`, with size and content hash for a file: what "byte-identical" compares. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else {
        const body = fs.readFileSync(abs);
        out.push(`${rel} ${body.length} ${createHash('sha256').update(body).digest('hex')}`);
      }
    }
  };
  walk(root);
  return out;
}

/** The target after a cancel: T-7's list of what "nothing" covers, as far as the target goes. */
function assertTargetClean(target: string): void {
  const build = path.join(target, '.repo-tour', 'build');
  assert.equal(fs.existsSync(markerPath(target)), false, 'the write-ahead marker was left behind');
  for (const name of ['plan.json', 'request.json']) {
    assert.equal(fs.existsSync(path.join(build, name)), false, `${name} was written by a build that was cancelled`);
  }
  const leftovers = fs.existsSync(build) ? fs.readdirSync(build).filter((f) => f.endsWith('.tmp')) : [];
  assert.deepEqual(leftovers, [], 'a temp file was left behind');
  // The strict form: validateTarget refuses a folder with anything in it, so even an empty
  // .repo-tour/build/ left here makes the next press on the same form a refusal.
  assert.deepEqual(fs.readdirSync(target), [], 'a cancelled build has to leave the folder it was given empty');
}

/** Wall-clock fields only: everything else about a digest is deterministic. */
function normaliseDigest(digest: DigestResultLike): unknown {
  const copy = structuredClone(digest) as unknown as {
    manifest: { generatedAt: string; cost: Record<string, unknown> };
    inventory: { stats: { wallMs: number } };
  };
  copy.manifest.generatedAt = '';
  for (const key of ['wallMs', 'inventoryMs', 'extractMs', 'rankMs', 'rollupMs']) copy.manifest.cost[key] = 0;
  copy.inventory.stats.wallMs = 0;
  return copy;
}

suite('the worker is built where the extension looks for it (T-30)', () => {
  test('dist/build-worker.js exists: esbuild and the constant name the same file', () => {
    assert.equal(fs.existsSync(WORKER), true, `nothing built at ${WORKER} — run npm run build, or esbuild.mjs and BUILD_WORKER_RELATIVE disagree`);
  });
});

suite('what a cancelled phase looks like (T-30)', () => {
  test('it is recognised by the property only the core sets, never by its words', () => {
    assert.equal(phaseCancelled(new BuildPhaseCancelled()), true);
    assert.equal(phaseCancelled(new Error('build cancelled while reading the repository')), false,
      'a sentence can carry text from a repository; it is not a classifier');
    assert.equal(phaseCancelled(undefined), false);
  });
});

suite('everything the digest returned still arrives (T-30 AC9)', function () {
  this.timeout(60_000);

  test('a real digest through a real worker deep-equals the same digest in-process, grammars and all', async () => {
    const repo = mixedFixture();
    const h = harness();
    const core = offThreadCore(h.deps);
    const inWorker = await core.digest(repo, { write: false });
    const inProcess = await realCore.digest(repo, { write: false });
    core.release?.();

    assert.equal(h.started(), 1, 'the digest did not run on a worker thread at all');
    assert.deepEqual(normaliseDigest(inWorker), normaliseDigest(inProcess));

    // Positive controls: an empty result would deep-equal an empty result.
    const manifest = inWorker['manifest'] as { counts: { symbols: number; parsed: number }; unparsed: unknown[]; graphCoverage: { filesWithParseErrors: number } };
    assert.ok(manifest.counts.symbols > 0, 'no symbols: the grammars did not load in the worker');
    assert.equal(manifest.counts.parsed, 5, 'all four grammars should have parsed their files');
    assert.ok(manifest.graphCoverage.filesWithParseErrors > 0, 'the syntax error should have been counted');
    assert.deepEqual(manifest.unparsed, [], 'nothing here is too big to parse');
  });

  test('a real plan through a real worker deep-equals the same plan in-process', async () => {
    const repo = mixedFixture();
    const h = harness();
    const core = offThreadCore(h.deps);
    const inWorker = await core.buildPlan(await core.digest(repo, { write: false }), { root: repo, witness: true });
    const digestHere = await realCore.digest(repo, { write: false });
    const inProcess = await realCore.buildPlan(digestHere, { root: repo, witness: true });
    core.release?.();

    assert.equal(h.started(), 1, 'one build, one worker');
    assert.ok(inWorker.steps.length > 0, 'an empty plan would deep-equal an empty plan');
    assert.deepEqual({ ...inWorker, generatedAt: '' }, { ...inProcess, generatedAt: '' });
  });

  test('buildPlan uses the digest it is given, not just the one the worker happens to hold', async () => {
    const first = mixedFixture();
    const second = tsFixture(1, 3);
    const core = offThreadCore(harness().deps);
    await core.digest(first, { write: false });
    const other = await realCore.digest(second, { write: false });
    const plan = await core.buildPlan(other, { root: second, witness: false });
    core.release?.();
    const expected = await realCore.buildPlan(other, { root: second, witness: false });
    assert.deepEqual({ ...plan, generatedAt: '' }, { ...expected, generatedAt: '' });
  });
});

suite('a failure in the worker comes back in the same words (T-30 AC7)', function () {
  this.timeout(30_000);

  test('digest throwing: the same reason, and the marker left for a resume, as in-process', async () => {
    const repo = mixedFixture();
    const inProcess = await buildFromRequest(requestFor(repo, tmp('t30-target-')), contextFor({ ...realCore, digest: () => Promise.reject(new Error('disk exploded')) }));
    assert.equal(inProcess.reason, `disk exploded — ${TRY_AGAIN}`, 'the comparison this test is built on');

    const target = tmp('t30-target-');
    const stub = stubCore({ 'digest.js': `export async function digest() { throw new Error('disk exploded'); }\n` });
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(harness({ coreRoot: stub }).deps)));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.cancelled, undefined);
    assert.equal(outcome.reason, inProcess.reason);
    assert.equal(readMarker(target)?.phase, 'digest', 'an unexpected failure leaves the marker for a resume');
  });

  test('buildPlan throwing: the same reason, marker at the plan phase', async () => {
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    const stub = stubCore({
      'digest.js': OK_DIGEST,
      'build.js': `export async function buildPlan() { throw new Error('no order to be had'); }\n`,
    });
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(harness({ coreRoot: stub }).deps)));
    assert.equal(outcome.reason, `no order to be had — ${TRY_AGAIN}`);
    assert.equal(readMarker(target)?.phase, 'plan');
  });
});

suite('a worker that cannot answer is a sentence, never a hang (T-30 AC8)', function () {
  this.timeout(30_000);

  async function endsWithASentence(stub: string, words: RegExp, overrides: Partial<OffThreadDeps> = {}): Promise<BuildOutcome> {
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(harness({ coreRoot: stub, ...overrides }).deps)));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.cancelled, undefined);
    assert.match(outcome.reason ?? '', words);
    assert.ok(readMarker(target), 'the marker is left: a resume can try again');
    return outcome;
  }

  test('a worker that exits while reading, with no answer', async () => {
    await endsWithASentence(stubCore({ 'digest.js': `export async function digest() { process.exit(3); }\n` }), /^reading the repository stopped unexpectedly.*\b3\b/);
  });

  test('a worker that exits while deriving the build order', async () => {
    await endsWithASentence(stubCore({
      'digest.js': OK_DIGEST,
      'build.js': `export async function buildPlan() { process.exit(4); }\n`,
    }), /^deriving the build order stopped unexpectedly.*\b4\b/);
  });

  test('an error thrown outside anything that could catch it', async () => {
    await endsWithASentence(stubCore({
      'digest.js': `export function digest() { setTimeout(() => { throw new Error('boom outside'); }, 0); return new Promise(() => {}); }\n`,
    }), /^reading the repository stopped unexpectedly: boom outside/);
  });

  test('a worker file that is not there', async () => {
    const missing = path.join(tmp('t30-empty-'), 'build-worker.js');
    await endsWithASentence(stubCore({ 'digest.js': OK_DIGEST }), /build worker/i, { workerFile: missing });
  });

  test('running out of memory ends the worker, not this process', async () => {
    await endsWithASentence(stubCore({
      'digest.js': `export async function digest() { const keep = []; for (;;) keep.push(new Array(10000).fill({ a: 1 })); }\n`,
    }), /^reading the repository stopped unexpectedly/, { workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 } } });
  });

  /** A digest that answers, and then its thread dies a moment later: the gap between two phases. */
  const ANSWERS_THEN = (death: string): string => `export async function digest() {\n  setTimeout(() => { ${death} }, 30);\n  return { manifest: {}, inventory: { files: [] } };\n}\n`;

  test('a worker that exits between two phases: the next phase says so, and does not wait for ever (review F2)', async () => {
    const repo = mixedFixture();
    const core = offThreadCore(harness({ coreRoot: stubCore({ 'digest.js': ANSWERS_THEN('process.exit(7);') }) }).deps);
    const digest = await core.digest(repo, { write: false });
    await new Promise((resolve) => setTimeout(resolve, 200)); // the thread has now died, with no phase running
    await assert.rejects(core.buildPlan(digest, { root: repo }), /^Error: deriving the build order stopped unexpectedly \(the build worker exited with code 7\)/);
  });

  test('a worker that throws between two phases: nothing is thrown on this thread, and the next phase says so (review F2)', async () => {
    // Mocha fails a test on an uncaught exception, which is exactly what an 'error' with no listener is.
    const repo = mixedFixture();
    const core = offThreadCore(harness({ coreRoot: stubCore({ 'digest.js': ANSWERS_THEN("throw new Error('boom after the reply');") }) }).deps);
    const digest = await core.digest(repo, { write: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(core.buildPlan(digest, { root: repo }), /^Error: deriving the build order stopped unexpectedly \(boom after the reply\)/);
  });

  test('the worker runs under the shipped heap limit, not the host\'s own (security review 2)', async () => {
    // The limit's effect is the out-of-memory test above, with a small limit; this is that the limit
    // that ships is the one the thread gets.
    const stub = stubCore({ 'digest.js': `import { resourceLimits } from 'node:worker_threads';\nexport async function digest() { return { manifest: {}, inventory: { files: [] }, resourceLimits }; }\n` });
    const core = offThreadCore(harness({ coreRoot: stub }).deps);
    const digest = await core.digest(mixedFixture(), { write: false }) as unknown as { resourceLimits: { maxOldGenerationSizeMb: number } };
    core.release?.();
    assert.equal(digest.resourceLimits.maxOldGenerationSizeMb, BUILD_WORKER_HEAP_MB);
    assert.ok(BUILD_WORKER_HEAP_MB < 4_000, 'at the host\'s own limit the real host crashed: the limit has to be below it');
  });

  test('a digest that cannot be sent to the worker is a failure, and the poll stops with it', async () => {
    const repo = mixedFixture();
    const core = offThreadCore(harness().deps);
    await core.digest(repo, { write: false });
    const unsendable = { inventory: { files: [] }, later: () => 1 } as unknown as DigestResultLike;
    let polls = 0;
    await assert.rejects(
      core.buildPlan(unsendable, { root: repo }, { isCancelled: () => { polls += 1; return false; } }),
      /could not be cloned/,
    );
    const seen = polls;
    await new Promise((resolve) => setTimeout(resolve, 350));
    core.release?.();
    assert.equal(polls, seen, 'the poll went on running after the phase had already failed');
  });

  test('a result that cannot cross the boundary', async () => {
    await endsWithASentence(stubCore({
      'digest.js': `export async function digest() { return { manifest: {}, inventory: { files: [] }, later: () => 1 }; }\n`,
    }), /could not be cloned/);
  });
});

suite('Cancel while a phase is running (T-30 AC4, AC5, AC6)', function () {
  this.timeout(120_000);

  test('during the read: promptly, by the shipped poll, leaving nothing, and the thread is gone', async () => {
    const repo = goFixture(200, 100);
    const target = tmp('t30-target-');
    const before = snapshot(repo);
    const h = harness();
    let cancelled = false;
    let pressedAt = 0;
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(h.deps), {
      isCancelled: () => cancelled,
      onPhase: (phase: BuildPhase) => {
        if (phase === 'digest') setTimeout(() => { cancelled = true; pressedAt = Date.now(); }, 250);
      },
    }));
    const took = Date.now() - pressedAt;

    assert.equal(outcome.reason, 'build cancelled while reading the repository');
    assert.equal(outcome.cancelled, true);
    assert.ok(pressedAt > 0, 'the press never happened: this test proved nothing');
    assert.ok(took <= STALL_BOUND_MS, `Cancel took ${took} ms to land, past the bound of ${STALL_BOUND_MS} ms`);

    assert.deepEqual(snapshot(repo), before, 'the reference folder was changed by a cancelled build');
    assert.equal(fs.existsSync(path.join(repo, '.repo-tour')), false, 'a cancelled read left a digest cache in the reference folder');
    assertTargetClean(target);
    assert.equal(h.started(), 1, 'the read did not run on a worker thread');
    assert.equal(await h.exited(10_000), 1, 'a terminated thread exits with 1');
  });

  test('during buildPlan: the same, and the outcome says which phase it stopped', async () => {
    const repo = tsFixture(50, 100);
    const target = tmp('t30-target-');
    const before = snapshot(repo);
    const h = harness();
    let cancelled = false;
    let pressedAt = 0;
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(h.deps), {
      isCancelled: () => cancelled,
      onPhase: (phase: BuildPhase) => {
        if (phase === 'plan') { cancelled = true; pressedAt = Date.now(); }
      },
    }));
    const took = Date.now() - pressedAt;

    assert.equal(outcome.reason, 'build cancelled while deriving the build order');
    assert.equal(outcome.cancelled, true);
    assert.ok(took <= STALL_BOUND_MS, `Cancel took ${took} ms to land, past the bound of ${STALL_BOUND_MS} ms`);
    assert.deepEqual(snapshot(repo), before);
    assertTargetClean(target);
    assert.equal(await h.exited(10_000), 1);
  });

  test('Cancel does not wait for a worker stuck behind a blocking child (T-13, again)', async () => {
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    const stub = stubCore({
      'digest.js': `import { execFileSync } from 'node:child_process';\nexport async function digest() { execFileSync('sleep', ['2']); return { manifest: {}, inventory: { files: [] } }; }\n`,
    });
    const h = harness({ coreRoot: stub });
    let cancelled = false;
    let pressedAt = 0;
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(h.deps), {
      isCancelled: () => cancelled,
      onPhase: (phase: BuildPhase) => {
        if (phase === 'digest') setTimeout(() => { cancelled = true; pressedAt = Date.now(); }, 400);
      },
    }));
    const took = Date.now() - pressedAt;
    assert.equal(outcome.reason, 'build cancelled while reading the repository');
    assert.ok(took <= STALL_BOUND_MS, `Cancel waited ${took} ms for a thread that cannot be stopped until its child exits`);
    // The thread does end, when the child does: nothing was left behind for good.
    assert.equal(await h.exited(10_000), 1);
  });

  test('the repeat: Cancel, then the same build runs to its normal ending in a new worker', async () => {
    const repo = goFixture(200, 100);
    const target = tmp('t30-target-');
    const first = harness();
    let cancelled = false;
    const stopped = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(first.deps), {
      isCancelled: () => cancelled,
      onPhase: (phase: BuildPhase) => { if (phase === 'digest') setTimeout(() => { cancelled = true; }, 250); },
    }));
    assert.equal(stopped.cancelled, true, stopped.reason);

    const second = harness();
    const again = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(second.deps)));
    assert.equal(again.cancelled, undefined);
    assert.match(again.reason ?? '', /is go; the grammars repo-tour ships cover/, 'the same request must reach its normal ending');
    assert.notEqual(again.reason, stopped.reason, 'the two endings have to be told apart');
    assert.equal(second.started(), 1, 'the second build needs a worker of its own');
    assert.equal(await second.exited(10_000), 1, 'and it is let go of after the refusal, with no buildPlan to wait for');
    assert.equal(fs.existsSync(path.join(repo, '.repo-tour')), false, 'not after a refusal either');
  });

  test('a completed build leaves nothing in the reference folder, and a whole plan in the target', async () => {
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    const before = snapshot(repo);
    const h = harness();
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(h.deps)));

    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(h.started(), 1);
    assert.deepEqual(snapshot(repo), before, 'a completed build wrote into the reference folder');
    assert.equal(fs.existsSync(path.join(repo, '.repo-tour')), false);
    const build = path.join(target, '.repo-tour', 'build');
    const plan = JSON.parse(fs.readFileSync(path.join(build, 'plan.json'), 'utf8')) as { steps: unknown[] };
    assert.ok(plan.steps.length > 0, 'the plan is whole');
    assert.equal(JSON.parse(fs.readFileSync(path.join(build, 'request.json'), 'utf8')).repo, repo);
    assert.equal(fs.existsSync(markerPath(target)), false);
  });

  test('the thread is gone before interpretPlan starts: that phase can run for minutes', async () => {
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    const h = harness();
    let codeSeenDuringInterpret: number | undefined;
    const inProcess: BuildCore = {
      ...realCore,
      interpretPlan: async (plan, digest, opts) => {
        codeSeenDuringInterpret = await h.exited(5_000);
        return realCore.interpretPlan(plan, digest, opts);
      },
    };
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore({ ...h.deps, inProcess })));
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(codeSeenDuringInterpret, 1, 'the worker was still holding a whole digest while the model calls ran');
  });

  test('the digest never reads a cache committed in the reference: not even a file it would follow out of the tree (security review 1, 4)', async () => {
    const repo = mixedFixture();
    const outside = tmp('t30-outside-');
    fs.writeFileSync(path.join(outside, 'inventory.json'), JSON.stringify([{ path: 'FROM-OUTSIDE-THE-REPOSITORY', sha256: 'x' }]));
    fs.mkdirSync(path.join(repo, '.repo-tour'));
    fs.symlinkSync(path.join(outside, 'inventory.json'), path.join(repo, '.repo-tour', 'inventory.json'));
    // The positive control: without being told otherwise, repo-tour does read it.
    const unprotected = await realCore.digest(repo, { write: false }) as unknown as { manifest: { incremental: unknown }; plan: { deleted: string[] } };
    assert.ok(unprotected.manifest.incremental, 'the planted file was not read at all: this test proves nothing');
    assert.deepEqual(unprotected.plan.deleted, ['FROM-OUTSIDE-THE-REPOSITORY']);

    let seen: DigestResultLike | undefined;
    const inWorker = offThreadCore(harness().deps);
    const spying: BuildCore = { ...inWorker, digest: async (...args) => { seen = await inWorker.digest(...args); return seen; } };
    const target = tmp('t30-target-');
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(spying));
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal((seen as unknown as { manifest: { incremental: unknown } }).manifest.incremental, null);
  });

  test('a .repo-tour that is a symlink: the clean-up does not remove a folder through it (security review 5)', async () => {
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    const outside = tmp('t30-outside-');
    fs.mkdirSync(path.join(outside, 'build'));
    fs.symlinkSync(outside, path.join(target, '.repo-tour'));
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(harness().deps), { isCancelled: () => true }));
    assert.equal(outcome.cancelled, true);
    assert.equal(fs.existsSync(path.join(outside, 'build')), true, 'an empty folder outside the target was removed through the link');
  });

  test('a Cancel polled after the phase finished cannot reach a phase that is over', async () => {
    // Nothing is running, so there is nothing to stop: the between-phase check answers instead.
    const repo = mixedFixture();
    const target = tmp('t30-target-');
    let cancelled = false;
    const outcome = await buildFromRequest(requestFor(repo, target), contextFor(offThreadCore(harness().deps), {
      isCancelled: () => cancelled,
      onPhase: (phase: BuildPhase) => { if (phase === 'interpret') cancelled = true; },
    }));
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.reason, 'build cancelled before writing the plan', 'interpret keeps today\'s between-phase Cancel (T-70)');
  });
});

suite('every build goes through it (T-30 AC10)', () => {
  test('buildContextFor is the one producer of the build\'s core, and it builds it off-thread', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.equal(source.match(/\boffThreadCore\(/g)?.length, 1, 'expected exactly one construction of the off-thread core');
    assert.doesNotMatch(source, /core:\s*coreFor\(/, 'a BuildContext built straight on the in-process core runs the build on the host\'s thread');
    const body = /function buildContextFor\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? '';
    assert.match(body, /\boffThreadCore\(/, 'buildContextFor must be the function that builds it');
    assert.equal(source.match(/\bbuildContextFor\(/g)?.length, 3, 'one definition, and one call each for runBuild and the resume');
  });
});

