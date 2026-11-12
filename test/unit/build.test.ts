// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/start/build.ts — entirely `vscode`-free (see that file's header), so the write-ahead
 * marker, the language refusal, resume, and the full end-to-end build against a synthetic
 * fixture — schema-validated against repo-tour's REAL schema/build-plan.schema.json — all run
 * under plain mocha. `cachedOnly: true` everywhere: this suite never spends a token, per the
 * ticket's own operating rule. The one live run (a real model, no cachedOnly) is the
 * orchestrator's acceptance run on sql-gauntlet, not this suite.
 */

import * as assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { BUILD_PLAN_SCHEMA, validateBuildPlan, type JsonSchema } from './plan-schema.js';
import {
  buildDir, buildFromRequest, coreFor, completionMessage, costLine, detectUnsupportedLanguages,
  GIT_KILL_GRACE_MS, gitRunnerWith, gitTimedOut, gitTimeoutMs, GIT_TIMEOUT_MS, GitTimeoutError,
  languageRefusalMessage, markerPath, readFreshMarker, readMarker, realFsWriteOps, resolveRepo,
  realGit, resumeIfMarked, TRY_AGAIN, writeJsonAtomic,
  type BuildContext, type BuildCore, type BuildMarker, type BuildPhase, type DigestResultLike,
  type ExecFileLike, type FsWriteOps, type GitRunner, type InterpretCostLike,
} from '../../src/start/build.js';
import { emptyRequest, MARKER_FILE, pidSpace, unfinishedBuildIn, validateRequest, type BuildRequest } from '../../src/start/request.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

// ── loading the REAL repo-tour core once for the whole file (import() caches it anyway) ────

let realCore: BuildCore;
let defaultModel: string;

suiteSetup(async () => {
  const core: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(core.found, true, core.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = coreFor(core.loaded);
  const interpretMod = core.loaded['interpret'] as { DEFAULT_MODEL: string };
  defaultModel = interpretMod.DEFAULT_MODEL;
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** util.ts (source) + app.ts (source, imports util) — deliberately not named index/main/cli.ts,
 *  which repo-tour's inventory classifies as 'structural' by filename regardless of content. */
function makeTsFixture(): string {
  const root = tmpDir('build-tutorials-ts-fixture-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'util.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n\n' +
      'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'app.ts'),
    "import { add, multiply } from './util.js';\n\n" +
      'export function compute(a: number, b: number): number {\n  return add(a, b) + multiply(a, b);\n}\n',
  );
  return root;
}

function makeGoFixture(): string {
  const root = tmpDir('build-tutorials-go-fixture-');
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n');
  return root;
}

function baseContext(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    core: realCore,
    globalStorageRoot: tmpDir('build-tutorials-storage-'),
    provider: 'claude',
    model: defaultModel,
    cachedOnly: true,
    ...overrides,
  };
}

function requestFor(repo: string, target: string): BuildRequest {
  return { ...emptyRequest(), recreate: true, repo, target };
}

// ── repo-tour's real schema, through the ONE shared checker (test/unit/plan-schema.ts, hoisted
// by T-17 from the two byte-identical copies this file and its sibling used to carry). ──

const SCHEMA: JsonSchema = BUILD_PLAN_SCHEMA;

// ── AC3: the language refusal, as pure logic ────────────────────────────────────────────────

suite('detectUnsupportedLanguages / languageRefusalMessage (AC3)', () => {
  function digestOf(files: Array<{ path: string; language: string | null; classification: string }>): DigestResultLike {
    return { inventory: { files } };
  }

  test('a Go-only repo is refused, naming "go"', () => {
    const d = digestOf([{ path: 'main.go', language: 'go', classification: 'source' }]);
    assert.deepEqual(detectUnsupportedLanguages(d), ['go']);
    assert.equal(
      languageRefusalMessage('/repo', ['go']),
      '/repo is go; the grammars repo-tour ships cover TS, JS, TSX and Python',
    );
  });

  test('a TS-only repo is NOT refused (discriminates against the Go case above)', () => {
    const d = digestOf([{ path: 'a.ts', language: 'typescript', classification: 'source' }]);
    assert.equal(detectUnsupportedLanguages(d), null);
  });

  test('a mixed repo with AT LEAST ONE supported source language is not refused', () => {
    const d = digestOf([
      { path: 'main.go', language: 'go', classification: 'source' },
      { path: 'a.py', language: 'python', classification: 'source' },
    ]);
    assert.equal(detectUnsupportedLanguages(d), null);
  });

  test('a non-source file in an unsupported language does not trigger a refusal', () => {
    const d = digestOf([{ path: 'README.md', language: 'markdown', classification: 'structural' }]);
    assert.equal(detectUnsupportedLanguages(d), null);
  });

  test('no source files at all is not this check\'s problem (null, not a refusal)', () => {
    const d = digestOf([]);
    assert.equal(detectUnsupportedLanguages(d), null);
  });
});

// ── resolveRepo: local path vs. GitHub URL, with a FAKE git (no network) ───────────────────

suite('resolveRepo', () => {
  function fakeGit(): { git: GitRunner; calls: Array<{ args: string[]; cwd?: string }> } {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const git: GitRunner = (args, cwd) => {
      calls.push({ args, cwd });
      return Promise.resolve('');
    };
    return { git, calls };
  }

  test('a local path is returned as-is — no git call at all', async () => {
    const { git, calls } = fakeGit();
    const result = await resolveRepo('/some/local/repo', tmpDir('storage-'), git);
    assert.equal(result, '/some/local/repo');
    assert.equal(calls.length, 0);
  });

  test('a GitHub URL, not yet cloned, is cloned FULL (no --depth) into refs/<owner>-<name>', async () => {
    const { git, calls } = fakeGit();
    const storage = tmpDir('storage-');
    const result = await resolveRepo('https://github.com/BMA-Corgea/repo-tour', storage, git);
    assert.equal(result, path.join(storage, 'refs', 'BMA-Corgea-repo-tour'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['clone', 'https://github.com/BMA-Corgea/repo-tour', result]);
    assert.ok(!calls[0]!.args.includes('--depth'), 'the clone must be full, not shallow');
  });

  test('a GitHub URL already cloned there is fetched, not re-cloned (discriminates against the case above)', async () => {
    const { git, calls } = fakeGit();
    const storage = tmpDir('storage-');
    const dest = path.join(storage, 'refs', 'BMA-Corgea-repo-tour');
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });

    const result = await resolveRepo('https://github.com/BMA-Corgea/repo-tour', storage, git);
    assert.equal(result, dest);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['-C', dest, 'fetch', '--all', '--tags']);
    assert.ok(!calls[0]!.args.includes('clone'));
  });
});

// ── AC5: the full end-to-end build against a synthetic TS fixture, schema-validated ────────

suite('buildFromRequest — end to end on a synthetic TS fixture (AC5, cachedOnly)', () => {
  test('plan.json + request.json are written and plan.json validates against the real schema', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(repo, target);

    const outcome = await buildFromRequest(request, baseContext());

    assert.equal(outcome.ok, true, outcome.reason);
    assert.ok(outcome.plan);
    assert.ok(outcome.plan.chapters.length > 0);
    assert.ok(outcome.plan.steps.length > 0);

    const planPath = path.join(buildDir(target), 'plan.json');
    const requestPath = path.join(buildDir(target), 'request.json');
    assert.ok(fs.existsSync(planPath), 'plan.json should exist');
    assert.ok(fs.existsSync(requestPath), 'request.json should exist');

    const writtenPlan: unknown = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const errors = validateBuildPlan(SCHEMA, writtenPlan);
    assert.deepEqual(errors, [], `plan.json should validate against schema/build-plan.schema.json:\n${errors.join('\n')}`);

    // `referenceRoot` is written ALONGSIDE the request, not instead of it (T-5 security
    // review, finding 2). For a local path the two are the same string; for a GitHub URL they
    // are not, and recording only the URL is what made the dial silently refuse on every
    // URL-built tutorial — `repo` is what the learner typed, `referenceRoot` is where the
    // reference actually is.
    const writtenRequest: unknown = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    assert.deepEqual(writtenRequest, { ...request, referenceRoot: repo });

    assert.equal(readMarker(target), null, 'the marker must be gone on success');
  });

  test('a GitHub URL records the CLONE path as referenceRoot, not the URL (security review finding 2)', async () => {
    // The bug this pins: `resolveRepo` computed the clone path into a local and the raw
    // request was persisted, so `request.json.repo` stayed the URL and the clone path was
    // never written down anywhere. Everything downstream then did `path.resolve(url, rel)`,
    // got a nonsense path relative to the process cwd, and refused ONE READ AT A TIME —
    // scaffolded and automated wrote nothing, Check my work said "nothing to check", and the
    // acceptance criteria about reproducing the reference did not hold on the flow the README
    // documents first. Nothing noticed, because every other test passes a local path.
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const storage = tmpDir('storage-');
    const clone = path.join(storage, 'refs', 'BMA-Corgea-fixture');
    fs.cpSync(repo, clone, { recursive: true });
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });

    const request = { ...requestFor(repo, target), repo: 'https://github.com/BMA-Corgea/fixture' };
    const outcome = await buildFromRequest(request, { ...baseContext(), globalStorageRoot: storage, git: () => Promise.resolve('') });

    assert.equal(outcome.ok, true, outcome.reason);
    const written = JSON.parse(fs.readFileSync(path.join(buildDir(target), 'request.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(written['repo'], 'https://github.com/BMA-Corgea/fixture', 'what the learner typed is kept verbatim');
    assert.equal(written['referenceRoot'], clone, 'and where it actually landed is recorded beside it');
  });

  test('a plan missing a required key would NOT validate (proves the checker actually checks something)', () => {
    const bad = { schemaVersion: 1, mode: 'recreate' }; // missing source, chapters, steps, ...
    const errors = validateBuildPlan(SCHEMA, bad);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('missing required key')));
  });

  test('cost.metered is a real boolean field and, with cachedOnly + an empty cache, costs nothing', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const outcome = await buildFromRequest(requestFor(repo, target), baseContext());
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(typeof outcome.cost!.metered, 'boolean');
    assert.equal(outcome.cost!.usd, 0);
    assert.equal(outcome.cost!.inputTokens + outcome.cost!.outputTokens, 0);
  });
});

// ── AC3, via the real pipeline: a Go-only fixture is refused, with the reason ──────────────

suite('buildFromRequest — a Go-only fixture is refused (AC3)', () => {
  test('refused with a reason naming "go"; no plan.json; the marker is cleaned up', async () => {
    const repo = makeGoFixture();
    const target = tmpDir('build-tutorials-target-');

    const outcome = await buildFromRequest(requestFor(repo, target), baseContext());

    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /is go; the grammars repo-tour ships cover TS, JS, TSX and Python/);
    assert.ok(!fs.existsSync(path.join(buildDir(target), 'plan.json')), 'no plan should be written for a refused repo');
    assert.equal(readMarker(target), null, 'a deterministic refusal leaves no marker to resume');
  });

  test('a TS fixture, run the same way, is NOT refused (discriminates the check above)', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const outcome = await buildFromRequest(requestFor(repo, target), baseContext());
    assert.equal(outcome.ok, true, outcome.reason);
  });
});

// ── AC4: the write-ahead marker stays current, phase by phase ─────────────────────────────

suite('the write-ahead marker (AC4)', () => {
  test('is durably updated at each phase BEFORE that phase\'s work runs, and is gone on success', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const seenPhases: BuildPhase[] = [];

    const outcome = await buildFromRequest(
      requestFor(repo, target),
      baseContext({
        onPhase: (phase) => {
          seenPhases.push(phase);
          // Read the marker independently from disk — not from any in-memory value this
          // function already holds — to prove it was ACTUALLY written, not merely tracked.
          const onDisk = readMarker(target);
          assert.ok(onDisk, `marker should exist on disk when entering phase ${phase}`);
          assert.equal(onDisk.phase, phase);
        },
      }),
    );

    assert.equal(outcome.ok, true, outcome.reason);
    assert.deepEqual(seenPhases, ['digest', 'plan', 'interpret', 'write']);
    assert.equal(readMarker(target), null, 'the marker should be removed once the plan is written');
  });

  test('cancelling stops the build early, deletes the marker, and never calls buildPlan (discriminates)', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    let buildPlanCalls = 0;
    const spyCore: BuildCore = {
      ...realCore,
      buildPlan: (...args) => { buildPlanCalls++; return realCore.buildPlan(...args); },
    };

    const outcome = await buildFromRequest(
      requestFor(repo, target),
      baseContext({ core: spyCore, isCancelled: () => true }),
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.cancelled, true);
    assert.equal(buildPlanCalls, 0, 'cancellation before the plan phase must pre-empt buildPlan entirely');
    assert.equal(readMarker(target), null, 'an explicit cancel leaves nothing to resume');
  });

  test('a marker survives a THROWN digest error (left for a possible resume, not deleted)', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const brokenCore: BuildCore = { ...realCore, digest: () => Promise.reject(new Error('disk exploded')) };

    const outcome = await buildFromRequest(requestFor(repo, target), baseContext({ core: brokenCore }));

    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /disk exploded/);
    const marker = readMarker(target);
    assert.ok(marker, 'an unexpected failure should leave the marker for a later Resume');
    assert.equal(marker.phase, 'digest');
  });

  // T-71: what the learner is told after a build that fails partway, and what the next press does.
  // Made inside each test: `realCore` is only assigned in suiteSetup, after this loop has run.
  const failing: Array<[BuildPhase, (core: BuildCore) => BuildCore]> = [
    ['digest', (core) => ({ ...core, digest: () => Promise.reject(new Error('disk exploded.')) })],
    ['plan', (core) => ({ ...core, buildPlan: () => Promise.reject(new Error('no order to be had')) })],
  ];
  for (const [phase, failingAt] of failing) {
    test(`T-71: a build that fails at ${phase} says the next step, its marker names this host, and the SAME form builds again`, async () => {
      const repo = makeTsFixture();
      const target = tmpDir('build-tutorials-target-');
      const request = requestFor(repo, target);
      const outcome = await buildFromRequest(request, baseContext({ core: failingAt(realCore) }));
      assert.equal(outcome.ok, false);
      assert.ok(outcome.reason?.endsWith(` — ${TRY_AGAIN}`), `the reason does not say what to do next: ${outcome.reason}`);
      assert.doesNotMatch(outcome.reason ?? '', /\. —/, 'a reason that ends in a full stop gets one, not two');
      assert.equal(readMarker(target)?.phase, phase);
      assert.equal(typeof readMarker(target)?.heartbeatAt, 'string', 'a running build beats');
      assert.equal(typeof readMarker(target)?.endedAt, 'string', 'and a build that kept its marker says, as it leaves, that it ended');
      // The very next press, on the unedited form: accepted, where it used to be "not empty".
      assert.deepEqual(validateRequest(request).problems, {}, 'the same form was refused after a failure that keeps its marker');
    });
  }

  test('T-71 review F1: while a build runs, its folder is refused, however that build started; once it has failed, the same form builds again', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held: BuildCore = { ...realCore, digest: async () => { await gate; throw new Error('the network blinked'); } };
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    const running = buildFromRequest(request, baseContext({ core: held })); // a Resume runs exactly this
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(validateRequest(request).problems.target, `a build is running in ${target} now — wait for it to finish, or pick an empty or new folder`);
    release?.();
    const outcome = await running;
    assert.equal(outcome.ok, false);
    assert.deepEqual(validateRequest(request).problems, {}, 'the same form is built again once that build is over');
  });

  test('T-71 review F1: a Resume or a Discard answered after a build has started there since does nothing to it', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let digests = 0;
    const counted: BuildCore = { ...realCore, digest: async (...args) => { digests += 1; await gate; return realCore.digest(...args); } };
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    fs.mkdirSync(path.dirname(markerPath(target)), { recursive: true });
    fs.writeFileSync(markerPath(target), JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), phase: 'interpret', request }));
    for (const answer of ['Resume', 'Discard'] as const) {
      let answerNow: (() => void) | undefined;
      const asked = new Promise<void>((resolve) => { answerNow = resolve; });
      const prompt = resumeIfMarked(target, { ...baseContext({ core: counted }), confirm: async () => { await asked; return answer; } });
      const fromTheForm = buildFromRequest(request, baseContext({ core: counted })); // pressed while the prompt is open
      await new Promise((resolve) => setTimeout(resolve, 50));
      const theirs = readMarker(target)?.startedAt;
      answerNow?.();
      assert.equal(await prompt, undefined, `${answer} after a build started there must do nothing`);
      assert.equal(readMarker(target)?.startedAt, theirs, `${answer} touched the running build's marker`);
      assert.equal(digests, answer === 'Resume' ? 1 : 2, 'only the form\'s builds ran');
      release?.();
      await fromTheForm;
    }
  });

  test('T-71 review F2: a cancelled retry of a build that failed in its write leaves the folder empty, not "not empty"', async () => {
    const target = tmpDir('build-tutorials-target-');
    const repo = makeTsFixture();
    const failingPlanWrite: FsWriteOps = { ...realFsWriteOps, renameSync: (from, to) => { if (to.endsWith('plan.json')) throw new Error('disk full'); realFsWriteOps.renameSync(from, to); } };
    const failed = await buildFromRequest(requestFor(repo, target), baseContext({ writeOps: failingPlanWrite }));
    assert.equal(failed.ok, false);
    assert.ok(fs.existsSync(path.join(buildDir(target), 'request.json')), 'the failed write left request.json, as the scenario needs');
    const cancelled = await buildFromRequest(requestFor(repo, target), baseContext({ isCancelled: () => true }));
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(fs.readdirSync(target), [], 'the cancelled retry left the folder as it found nothing');
  });

  test('T-71 review F3: no "try again" where pressing again cannot help, plain words for a silent error, and a path keeps its dots', async () => {
    const target = tmpDir('build-tutorials-target-');
    const repo = makeTsFixture();
    const wontHelp = Object.assign(new Error('could not start the build: the build worker is missing from this install (x); reinstalling the extension should restore it'), { retryWontHelp: true });
    const missing = await buildFromRequest(requestFor(repo, target), baseContext({ core: { ...realCore, digest: () => Promise.reject(wontHelp) } }));
    assert.equal(missing.reason, wontHelp.message, 'a failure pressing again cannot cure says only what it says');
    const silent = await buildFromRequest(requestFor(repo, tmpDir('build-tutorials-target-')), baseContext({ core: { ...realCore, digest: () => Promise.reject(new Error('')) } }));
    assert.equal(silent.reason, `the build stopped without saying why — ${TRY_AGAIN}`);
    const dotted = await buildFromRequest(requestFor(repo, tmpDir('build-tutorials-target-')), baseContext({ core: { ...realCore, digest: () => Promise.reject(new Error('could not read /work/my.project...')) } }));
    assert.equal(dotted.reason, `could not read /work/my.project... — ${TRY_AGAIN}`, 'the dots are the text, not a sentence\'s end');
    const sentence = await buildFromRequest(requestFor(repo, tmpDir('build-tutorials-target-')), baseContext({ core: { ...realCore, digest: () => Promise.reject(new Error('the network blinked.')) } }));
    assert.equal(sentence.reason, `the network blinked — ${TRY_AGAIN}`, 'one full stop ending a sentence goes');
  });

  test("T-71: the language refusal keeps its own words (no \"try again\": the same repository fails the same way)", async () => {
    const target = tmpDir('build-tutorials-target-');
    const outcome = await buildFromRequest(requestFor(makeGoFixture(), target), baseContext());
    assert.equal(outcome.ok, false);
    assert.doesNotMatch(outcome.reason ?? '', /try again/);
  });
});

// ── T-71's re-review: another window, a crash, a trimmed target, a full disk ────────────────────

suite('T-71 re-review: the marker of a build another window may be running', () => {
  const DEAD_PID = 2 ** 22 + 54_321; // above Linux's default pid_max: no process has it
  const markerOf = (target: string, request: BuildRequest, fields: Partial<BuildMarker>): void => {
    fs.mkdirSync(path.dirname(markerPath(target)), { recursive: true });
    fs.writeFileSync(markerPath(target), JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), phase: 'interpret', request, ...fields }));
  };
  const liveElsewhere = (): Partial<BuildMarker> => ({ id: 'another-window', pid: process.ppid, host: os.hostname(), pidSpace: pidSpace(), heartbeatAt: new Date().toISOString() });

  test('R1: the reload prompt never offers to Resume or Discard a build another window is running now', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    markerOf(target, request, liveElsewhere());
    let asked = 0;
    // Its host is alive and stays alive: not a closing one (re-check N1), so after the wait, still not offered.
    const outcome = await resumeIfMarked(target, { ...baseContext(), confirm: () => { asked += 1; return Promise.resolve('Discard'); }, hostExitWaitMs: 300 });
    assert.equal(outcome, undefined);
    assert.equal(asked, 0, 'the prompt was shown for a build that is running in another window');
    assert.equal(readMarker(target)?.id, 'another-window', "the other window's marker was touched");
  });

  test('R1: a crashed build of THIS machine (its host gone, its heartbeat still fresh) is offered at once, and pressed for at once', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    markerOf(target, request, { id: 'crashed', pid: DEAD_PID, host: os.hostname(), pidSpace: pidSpace(), heartbeatAt: new Date().toISOString() });
    assert.equal(unfinishedBuildIn(target), 'build-again', 'a press must not wait 90 s for a host that is gone');
    let asked = 0;
    await resumeIfMarked(target, { ...baseContext(), confirm: () => { asked += 1; return Promise.resolve(undefined); } });
    assert.equal(asked, 1, 'the interrupted build was not offered after the reload that interrupted it');
  });

  test('N2: a build whose host has another set of process ids (WSL beside Windows, a host-network container) is never declared dead by its pid', async () => {
    for (const space of ['linux:another-boot:pid:[4026531836]', undefined]) {
      const label = space === undefined ? 'a marker that does not say its pid space' : 'a marker from another pid space';
      const target = tmpDir('build-tutorials-target-');
      const request = requestFor(makeTsFixture(), target);
      // The same hostname, a pid that is not alive HERE, and a heartbeat from now: alive where it runs.
      markerOf(target, request, { id: 'in-wsl', pid: DEAD_PID, host: os.hostname(), pidSpace: space, heartbeatAt: new Date().toISOString() });
      assert.equal(unfinishedBuildIn(target), 'maybe-running', `${label}: a live build was read as dead, by a pid that means nothing here`);
      let asked = 0;
      await resumeIfMarked(target, { ...baseContext(), confirm: () => { asked += 1; return Promise.resolve('Discard'); }, hostExitWaitMs: 300 });
      assert.equal(asked, 0, `${label}: the reload offered to Resume or Discard a build that is running`);
      assert.equal(readMarker(target)?.id, 'in-wsl', `${label}: its marker was touched`);
    }
  });

  test("N1: a reload that comes while the interrupted build's old host is still closing waits for it to go, then offers the Resume", async function () {
    this.timeout(20_000);
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    // The old host, a pid this test starts: alive 0.6 s more (VS Code gives a closing host up to 6 s), its build beating until it goes.
    const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore' });
    const gone = new Promise<void>((resolve) => { old.on('exit', () => { resolve(); }); });
    try {
      assert.equal(typeof old.pid, 'number');
      markerOf(target, request, { id: 'interrupted', pid: old.pid, host: os.hostname(), pidSpace: pidSpace(), heartbeatAt: new Date().toISOString() });
      let asked = 0;
      await resumeIfMarked(target, { ...baseContext(), confirm: () => { asked += 1; return Promise.resolve(undefined); }, hostExitWaitMs: 15_000 });
      assert.equal(asked, 1, 'the reload said nothing: the build it interrupted was not offered, because its old host was still closing');
      assert.equal(readMarker(target)?.id, 'interrupted', 'a dismissed prompt must leave the marker for next time');
    } finally {
      await gone; // it ends on its own, well before the bound
    }
  });

  test('R2: a build that finds another live build in its folder just before its first write refuses, and leaves that marker alone', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    markerOf(target, request, liveElsewhere());
    const outcome = await buildFromRequest(request, baseContext()); // as if it had passed the press before the other build began
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /another build started in .* while this one was fetching the repository/);
    assert.equal(readMarker(target)?.id, 'another-window', "the other build's marker was overwritten or deleted");
  });

  test('R1: a build another window starts while the prompt is open is left alone, whichever button is pressed', async () => {
    for (const answer of ['Discard', 'Resume'] as const) {
      const target = tmpDir('build-tutorials-target-');
      const request = requestFor(makeTsFixture(), target);
      markerOf(target, request, { id: 'crashed', pid: DEAD_PID, host: os.hostname(), pidSpace: pidSpace(), heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
      const phases: string[] = [];
      const outcome = await resumeIfMarked(target, {
        ...baseContext({ onPhase: (p) => { phases.push(p); } }),
        confirm: () => { markerOf(target, request, liveElsewhere()); return Promise.resolve(answer); },
      });
      assert.equal(outcome, undefined, `${answer}: acted on a folder another window's build had taken`);
      assert.deepEqual(phases, [], `${answer}: a second build ran there`);
      assert.equal(readMarker(target)?.id, 'another-window', `${answer}: the other window's marker was touched`);
    }
  });

  test('R1: the build the prompt asked about, found alive while it was open (another machine woke), is left alone', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    // One build throughout: the same id and start, only its heartbeat moves.
    const elsewhere = { id: 'on-a-laptop', pid: 4242, host: 'another-machine', startedAt: new Date(Date.now() - 900_000).toISOString() };
    markerOf(target, request, { ...elsewhere, heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
    let asked = 0;
    const outcome = await resumeIfMarked(target, {
      ...baseContext(),
      confirm: () => { asked += 1; markerOf(target, request, { ...elsewhere, heartbeatAt: new Date().toISOString() }); return Promise.resolve('Discard'); },
    });
    assert.equal(asked, 1, 'a build silent for 10 minutes on another machine should be offered');
    assert.equal(outcome, undefined);
    assert.equal(readMarker(target)?.id, 'on-a-laptop', 'Discard deleted the marker of a build that had just beaten again');
  });

  test('R2: a tutorial another build finished while this one was fetching is left as it is', async () => {
    const target = tmpDir('build-tutorials-target-');
    const storage = tmpDir('storage-');
    const clone = path.join(storage, 'refs', 'BMA-Corgea-fixture');
    fs.cpSync(makeTsFixture(), clone, { recursive: true });
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    const theirs = JSON.stringify({ chapters: [{ id: 'theirs' }] });
    const fetchWhileAnotherFinishes: GitRunner = (args) => {
      if (args.includes('fetch')) {
        fs.mkdirSync(buildDir(target), { recursive: true });
        fs.writeFileSync(path.join(buildDir(target), 'plan.json'), theirs);
      }
      return Promise.resolve('');
    };
    const request = { ...requestFor(makeTsFixture(), target), repo: 'https://github.com/BMA-Corgea/fixture' };
    const outcome = await buildFromRequest(request, { ...baseContext(), globalStorageRoot: storage, git: fetchWhileAnotherFinishes });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /another build finished a tutorial in .* while this one was fetching the repository/);
    assert.equal(fs.readFileSync(path.join(buildDir(target), 'plan.json'), 'utf8'), theirs, 'the finished tutorial was overwritten');
    assert.equal(readMarker(target), null, 'this build wrote its marker into a finished tutorial');
  });

  test('R2: a Resume of a build that crashed just after writing its plan still finishes (the plan was there before it began)', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    markerOf(target, request, { phase: 'write', id: 'crashed', pid: DEAD_PID, host: os.hostname(), pidSpace: pidSpace(), heartbeatAt: new Date().toISOString() });
    fs.writeFileSync(path.join(buildDir(target), 'request.json'), JSON.stringify(request));
    fs.writeFileSync(path.join(buildDir(target), 'plan.json'), JSON.stringify({ chapters: [] }));
    const outcome = await resumeIfMarked(target, { ...baseContext(), confirm: () => Promise.resolve('Resume') });
    assert.equal(outcome?.ok, true, outcome?.reason);
    assert.equal(readMarker(target), null);
  });

  test('R2: a build whose folder another build took over mid-build stops at its next phase, and writes nothing more', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    let interpreted = 0;
    const core: BuildCore = {
      ...realCore,
      // As when this build's heartbeat looked stale (its laptop slept) and another window built over it.
      buildPlan: (...args) => { markerOf(target, request, liveElsewhere()); return realCore.buildPlan(...args); },
      interpretPlan: (...args) => { interpreted += 1; return realCore.interpretPlan(...args); },
    };
    const outcome = await buildFromRequest(request, baseContext({ core }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /another build took over .* while this one was running — it stopped and wrote nothing more/);
    assert.equal(interpreted, 0, 'it went on to ask the model about a folder that was no longer its own');
    assert.equal(readMarker(target)?.id, 'another-window', "the other build's marker was overwritten");
    assert.equal(readMarker(target)?.endedAt, undefined, "the other build's marker was marked as ended");
    assert.equal(fs.existsSync(path.join(buildDir(target), 'plan.json')), false);
  });

  test('R2: a Cancel of a build whose folder another build has taken over leaves that build\'s marker alone', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    let cancelled = false;
    const core: BuildCore = {
      ...realCore,
      digest: (...args) => { markerOf(target, request, liveElsewhere()); cancelled = true; return realCore.digest(...args); },
    };
    const outcome = await buildFromRequest(request, baseContext({ core, isCancelled: () => cancelled }));
    assert.equal(outcome.cancelled, true, outcome.reason);
    assert.equal(readMarker(target)?.id, 'another-window', "the Cancel deleted the other build's marker");
  });

  test('R5: a first marker write that fails (a full disk) leaves nothing of ours behind, so the same form builds there once the disk is freed', async () => {
    const target = tmpDir('build-tutorials-target-');
    const request = requestFor(makeTsFixture(), target);
    // The reviewer's case: the temp file is begun, 7 bytes land, and the disk is full.
    const full: FsWriteOps = {
      ...realFsWriteOps,
      writeFileSync: (file, data) => {
        if (path.basename(file).startsWith(`${MARKER_FILE}.`)) {
          fs.writeFileSync(file, data.slice(0, 7));
          throw new Error('ENOSPC: no space left on device, write');
        }
        realFsWriteOps.writeFileSync(file, data);
      },
    };
    await assert.rejects(buildFromRequest(request, baseContext({ writeOps: full })), /ENOSPC/);
    assert.deepEqual(fs.readdirSync(target), [], 'a temp file or an empty build folder was left');
    assert.equal(validateRequest(request).problems.target, undefined, 'the form refuses the folder');
  });
});

// ── AC4: resuming after a (simulated) crash ────────────────────────────────────────────────

suite('resumeIfMarked (AC4)', () => {
  function writeCrashedMarker(target: string, marker: BuildMarker): void {
    fs.mkdirSync(path.dirname(markerPath(target)), { recursive: true });
    fs.writeFileSync(markerPath(target), JSON.stringify(marker, null, 2));
  }

  test('a fresh marker + "Resume" completes the build and removes the marker', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    writeCrashedMarker(target, { startedAt: new Date().toISOString(), phase: 'plan', request: requestFor(repo, target) });

    let confirmCalls = 0;
    const outcome = await resumeIfMarked(target, {
      ...baseContext(),
      confirm: (msg) => { confirmCalls++; assert.match(msg, /interrupted/); return Promise.resolve('Resume'); },
    });

    assert.ok(outcome);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(confirmCalls, 1);
    assert.ok(fs.existsSync(path.join(buildDir(target), 'plan.json')));
    assert.equal(readMarker(target), null);
  });

  test('"Discard" removes the marker and never builds anything (discriminates against Resume)', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    writeCrashedMarker(target, { startedAt: new Date().toISOString(), phase: 'digest', request: requestFor(repo, target) });

    const outcome = await resumeIfMarked(target, { ...baseContext(), confirm: () => Promise.resolve('Discard') });

    assert.equal(outcome, undefined);
    assert.equal(readMarker(target), null);
    assert.ok(!fs.existsSync(path.join(buildDir(target), 'plan.json')));
  });

  test('dismissing the prompt (undefined) leaves the marker untouched for next time', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const marker: BuildMarker = { startedAt: new Date().toISOString(), phase: 'digest', request: requestFor(repo, target) };
    writeCrashedMarker(target, marker);

    const outcome = await resumeIfMarked(target, { ...baseContext(), confirm: () => Promise.resolve(undefined) });

    assert.equal(outcome, undefined);
    assert.deepEqual(readMarker(target), marker);
  });

  test('a marker older than 6 hours is left alone WITHOUT even asking (discriminates against a fresh one)', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    writeCrashedMarker(target, { startedAt: sevenHoursAgo, phase: 'digest', request: requestFor(repo, target) });

    let confirmCalls = 0;
    const outcome = await resumeIfMarked(target, {
      ...baseContext(),
      confirm: () => { confirmCalls++; return Promise.resolve('Resume'); },
    });

    assert.equal(outcome, undefined);
    assert.equal(confirmCalls, 0, 'a stale marker must not even prompt');
    assert.ok(readMarker(target), 'a stale marker is left in place, not deleted, either');
  });

  test('no remembered target -> undefined, no filesystem access at all', async () => {
    const outcome = await resumeIfMarked(undefined, { ...baseContext(), confirm: () => Promise.resolve('Resume') });
    assert.equal(outcome, undefined);
  });

  test('a remembered target with no marker there -> undefined', async () => {
    const target = tmpDir('build-tutorials-target-'); // real dir, but never built
    const outcome = await resumeIfMarked(target, { ...baseContext(), confirm: () => Promise.resolve('Resume') });
    assert.equal(outcome, undefined);
  });
});

// ── the cost line (spec §5.2: "metered or 'this provider does not report usage'") ─────────

suite('costLine / completionMessage', () => {
  function cost(overrides: Partial<InterpretCostLike>): InterpretCostLike {
    return { provider: 'claude', metered: true, usd: 0, inputTokens: 0, outputTokens: 0, ...overrides };
  }

  test('metered -> a dollar amount and a token count', () => {
    assert.equal(costLine(cost({ metered: true, usd: 1.23, inputTokens: 1000, outputTokens: 500 })), '$1.23, 1500 tokens');
  });

  test('NOT metered -> the exact honest phrase, verbatim (discriminates against the metered case)', () => {
    assert.equal(costLine(cost({ metered: false, usd: 0, inputTokens: 0, outputTokens: 0 })), 'this provider does not report usage');
  });

  test('completionMessage names chapters and steps and includes the cost line', () => {
    const plan = { chapters: [1, 2, 3], steps: new Array(12).fill(0) };
    const msg = completionMessage(plan, cost({ metered: false }));
    assert.equal(msg, '3 chapters · 12 steps — this provider does not report usage');
  });
});

// ── T-3 rework, review finding 2: plan.json/request.json are written ATOMICALLY, in an
// order that leaves either a marker or a complete plan — never a half file and no marker. ──

suite('writeJsonAtomic (T-3 rework, review finding 2)', () => {
  test('a failing rename leaves NO file at the destination — the temp file holds it all', () => {
    const dir = tmpDir('atomic-write-');
    const dest = path.join(dir, 'plan.json');
    const ops: FsWriteOps = {
      ...realFsWriteOps,
      renameSync: () => { throw new Error('crashed during rename'); },
    };

    assert.throws(() => writeJsonAtomic(dest, { chapters: [1, 2, 3] }, ops), /crashed during rename/);

    // The whole point of temp+rename: the real filename never exists in a partial state. A
    // plain `fs.writeFileSync(dest, ...)` — what this replaced — would leave `dest` behind,
    // so this assertion is what fails if the fix is reverted.
    assert.equal(fs.existsSync(dest), false, 'the destination must not exist at all after a failed rename');
    // The temp file is found by SUFFIX, not by name: its name now carries random bytes
    // (T-4 security review, finding 4 — a repository can commit `plan.json.tmp` as a symlink,
    // git recreates it on clone, and `writeFileSync` follows it, so a predictable name meant
    // an attacker-chosen file was truncated and overwritten on the first save).
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.equal(leftovers.length, 1, 'exactly one temp file should hold the interrupted write');
    assert.notEqual(leftovers[0], 'plan.json.tmp', 'the temp name must NOT be predictable');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, leftovers[0]!), 'utf8')),
      { chapters: [1, 2, 3] },
      'the content was written COMPLETELY to a temp file first, and only then renamed',
    );
  });

  test('the same write, uninterrupted, lands complete at the destination (discriminates)', () => {
    const dir = tmpDir('atomic-write-');
    const dest = path.join(dir, 'nested', 'plan.json');
    writeJsonAtomic(dest, { chapters: [1] });
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), { chapters: [1] });
    assert.deepEqual(
      fs.readdirSync(path.dirname(dest)).filter((name) => name.endsWith('.tmp')),
      [],
      'the temp file is renamed away, not left behind — checked by suffix, since the name is random',
    );
  });
});

suite('buildFromRequest — a crash while writing the plan (AC4/AC5, review finding 2)', () => {
  /** Real fs ops, except that renaming onto any path matching `failOn` throws — the crash a
   *  plain `writeFileSync` could not survive without leaving a truncated file behind. */
  function opsFailingRenameTo(failOn: RegExp, renamed: string[]): FsWriteOps {
    return {
      ...realFsWriteOps,
      renameSync: (from, to) => {
        if (failOn.test(to)) throw new Error(`crashed while renaming onto ${path.basename(to)}`);
        renamed.push(to);
        realFsWriteOps.renameSync(from, to);
      },
    };
  }

  test('a crash renaming plan.json leaves no plan.json at all, and the marker still there', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const renamed: string[] = [];

    const outcome = await buildFromRequest(
      requestFor(repo, target),
      baseContext({ writeOps: opsFailingRenameTo(/plan\.json$/, renamed) }),
    );

    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /crashed while renaming onto plan\.json/);

    const planPath = path.join(buildDir(target), 'plan.json');
    assert.equal(fs.existsSync(planPath), false, 'no partial plan.json may be left for T-4 to trip over');

    const marker = readMarker(target);
    assert.ok(marker, 'the marker must still be there, so this is resumable rather than silently broken');
    assert.equal(marker.phase, 'write');
    assert.ok(readFreshMarker(target), 'and fresh enough that activation would offer to resume it');
  });

  test('request.json is written BEFORE plan.json, and the marker is removed only after both', async () => {
    const repo = makeTsFixture();
    const target = tmpDir('build-tutorials-target-');
    const renamed: string[] = [];

    const outcome = await buildFromRequest(
      requestFor(repo, target),
      baseContext({ writeOps: opsFailingRenameTo(/never-matches-anything/, renamed) }),
    );

    assert.equal(outcome.ok, true, outcome.reason);
    // Every durable write in this file goes through the same temp+rename helper, so this is
    // the full ordered list: the marker (once per phase), then request.json, then plan.json.
    const deliverables = renamed.filter((p) => !p.endsWith('building.json')).map((p) => path.basename(p));
    assert.deepEqual(deliverables, ['request.json', 'plan.json']);
    assert.ok(
      renamed.filter((p) => p.endsWith('building.json')).length >= 4,
      'the marker is itself renamed into place once per phase — it uses the same helper',
    );
    assert.equal(readMarker(target), null, 'and is removed only once both deliverables are complete');
  });
});

// ── T-13: every git subprocess is bounded ───────────────────────────────────────────────────

/**
 * The invariant this ticket establishes, and `autodev/instructions/invariants-in-handoffs.md`
 * is why it is pinned rather than written down: *an invariant that is not pinned by a test the
 * next ticket would break is not an invariant, it is a coincidence that held once.* This
 * defect exists precisely because a bound was left to whoever remembered.
 *
 * The sentence being pinned is **no git subprocess this extension spawns is unbounded**, and
 * it is deliberately not pinned as a list of call sites — an enumerated list proves the list,
 * not the property, which was T-7's `stepRenderKey` lesson. It is pinned as two halves that
 * together leave no way through:
 *
 *   1. **`gitRunnerWith` cannot reach `execFile` without a bound** — asserted over the INPUTS
 *      rather than over the callers, including values TypeScript says cannot arrive. A new
 *      call site therefore inherits a bound by existing; it does not have to remember one.
 *   2. **`gitRunnerWith` is the only thing that spawns anything** — a source scan, so a module
 *      added tomorrow that reaches for `child_process` itself fails here rather than shipping
 *      a second unbounded family.
 *
 * ### What these pins CANNOT see, stated rather than implied
 *
 * Reviewed as adversarially as the code, because the first version of this paragraph named
 * only the exotic miss and not the two nearest ones (T-13 review, lesson 3).
 *
 *   - Half 2 is a scan of `src/**` source TEXT, RAW, over every extension esbuild will bundle.
 *     A spawn reached through a computed module name (`await import('node:child' + '_process')`)
 *     slips past it. That is a deliberate obfuscation rather than the accident this guards,
 *     which is somebody writing the obvious import in a new file; catching the former would
 *     take an evaluator. It errs towards false positives — a prose mention is reported — and
 *     the fixture test below is what proves it sees the shapes that used to escape.
 *   - It scans `src/`. `scripts/` and `esbuild.mjs` are build-time and are not in the shipped
 *     bundle; repo-tour, which this extension loads as a library, spawns `claude` under its own
 *     rules. The claim is about THIS repository's git, in what ships.
 *   - Nothing here waits out a real 30-second bound, and nothing waits out the real 5-second
 *     escalation grace either. That the LITERAL 30,000 reaches the child is proven with a spy;
 *     that a real `execFile` honours the number it is given, and that the promise settles when
 *     the child ignores the signal, are proven with real children and a shortened bound and
 *     grace. The join between them — that Node applies the options it was handed at the scale
 *     it was handed them — is inspection, not test.
 *   - **The escalation does not reach a GRANDCHILD.** Node signals the child, not its process
 *     group, so a `git` that is a wrapper leaves a subprocess running after this promise has
 *     correctly rejected. `src/start/build.ts` states the trade that was declined to fix it.
 *     What is pinned here is the promise settling, which is the property the walk depends on;
 *     the orphan is a stated limit and not an oversight.
 *   - `commitStep`, `resolveRepo` and `tutorContext` deciding what a timeout MEANS is pinned in
 *     `test/unit/dial-commit.test.ts`, `test/unit/walk-session.test.ts` and
 *     `test/unit/tutor-context.test.ts`. This suite only proves the bound exists.
 */
suite('T-13 — no git subprocess is unbounded', () => {
  /** `gitRunnerWith` wired to a spy instead of a process: what the child WOULD have been given. */
  function spyExec(): { exec: ExecFileLike; calls: Array<{ args: readonly string[]; options: { cwd?: string; maxBuffer: number; timeout: number } }> } {
    const calls: Array<{ args: readonly string[]; options: { cwd?: string; maxBuffer: number; timeout: number } }> = [];
    const exec: ExecFileLike = (_file, args, options, callback) => {
      calls.push({ args, options });
      callback(null, '', '');
      return undefined;
    };
    return { exec, calls };
  }

  test('the bound is a property of the RUNNER, so no input at all reaches execFile without one', () => {
    const { exec, calls } = spyExec();
    const git = gitRunnerWith(exec);

    // Not a list of call sites: a list of the shapes a TIER can take, which is the only thing
    // that varies the bound. The last four are values TypeScript rejects and JavaScript does
    // not — `GitRunner` crosses a `vscode` adapter boundary and is handed to modules bundled
    // separately, so "the type forbids it" is not the same as "it cannot arrive".
    const tiers = [...Object.keys(GIT_TIMEOUT_MS), undefined, '', 'medium', null, 0, {}];
    for (const tier of tiers) {
      void git(['rev-parse', '--git-dir'], '/somewhere', tier as never);
    }

    assert.equal(calls.length, tiers.length, 'every one of them reached the spy');
    for (const [i, call] of calls.entries()) {
      const ms = call.options.timeout;
      assert.equal(typeof ms, 'number', `input ${i} produced a non-numeric timeout`);
      assert.ok(Number.isFinite(ms) && ms > 0,
        `input ${i} (${JSON.stringify(tiers[i])}) reached execFile with timeout=${String(ms)} — `
        + 'an absent or zero timeout is how execFile is told to wait forever, which is the defect');
    }
  });

  test('and a hostile TUNING override cannot produce "no bound" either', () => {
    // `GitRunnerTuning` is a second door into the number `execFile` reads as "run forever" when
    // it is missing, so it is guarded the same way the tier is, and asserted over inputs for
    // the same reason: a bound that can be switched off by handing it a `0` is not a bound.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '600', {}]) {
      const { exec, calls } = spyExec();
      void gitRunnerWith(exec, { boundMs: bad as never, killGraceMs: bad as never })(['status']);
      const ms = calls[0]?.options.timeout;
      assert.ok(typeof ms === 'number' && Number.isFinite(ms) && ms > 0,
        `boundMs=${JSON.stringify(bad)} reached execFile with timeout=${String(ms)}`);
      assert.equal(ms, GIT_TIMEOUT_MS.short, 'an override that is not a usable number falls back to the tier');
    }
  });

  test('an unrecognised tier falls back to the SHORT bound rather than to no bound', () => {
    assert.equal(gitTimeoutMs(undefined), GIT_TIMEOUT_MS.short, 'omitted means short');
    assert.equal(gitTimeoutMs('medium' as never), GIT_TIMEOUT_MS.short);
    assert.equal(gitTimeoutMs(null as never), GIT_TIMEOUT_MS.short);
    assert.equal(gitTimeoutMs('short'), GIT_TIMEOUT_MS.short);
    assert.equal(gitTimeoutMs('long'), GIT_TIMEOUT_MS.long);
  });

  /**
   * Review finding 3, at the classifier. `gitTimedOut` used to fall through to a regex over
   * `err.message`, and the runner composes an ordinary failure's message as
   * `git ${args.join(' ')} failed: …` — argv included. Two call sites put `plan.json` text into
   * that argv: `commitStep`'s `-m <ordinal: question — label>` and `learnerDiffFor`'s target
   * path. Driven with real git and a real exit-1: a plan whose question read `timed out after
   * 1 second and was stopped` routed an ordinary commit failure into the timeout branch.
   *
   * The pin is the property, not the regex's absence: **the sentence never decides.** Only
   * something the runner itself set can say a subprocess was stopped.
   */
  test('a rejection that merely SAYS it timed out is not classified as one — the plan does not get a vote', () => {
    const forged = new Error(
      'git commit -q -m 3: timed out after 1 second and was stopped — Option A -- src/x.ts '
      + 'failed: nothing to commit, working tree clean',
    );
    assert.equal(gitTimedOut(forged), false,
      'this is an ordinary exit-1 whose message carries the plan’s own question. Classifying it as a '
      + 'timeout is a `plan.json` choosing which sentence a learner is shown');

    assert.equal(gitTimedOut(new GitTimeoutError(['commit'], GIT_TIMEOUT_MS.short)), true,
      'and the real one, which carries the property, still is — otherwise this passes by classifying nothing');
    assert.equal(gitTimedOut({ gitTimedOutAfterMs: 30_000 }), true, 'the duck-type survives the bundle split');
    assert.equal(gitTimedOut({ gitTimedOutAfterMs: '30000' }), false, 'a string is not the property');
    assert.equal(gitTimedOut('timed out after 30 seconds and was stopped'), false, 'nor is a bare string rejection');
  });

  test('the escalation grace is a real, finite, positive second wait — not zero and not forever', () => {
    // Zero would make the SIGTERM pointless (git would never get to remove its own lock files);
    // absent or infinite would put the settle back where finding 1 found it.
    assert.ok(Number.isFinite(GIT_KILL_GRACE_MS) && GIT_KILL_GRACE_MS > 0,
      `the grace between SIGTERM and SIGKILL is ${String(GIT_KILL_GRACE_MS)}`);
    assert.ok(GIT_KILL_GRACE_MS < GIT_TIMEOUT_MS.short,
      'and it is a tail on the bound rather than a second bound the learner would notice');
  });

  test('the default is the SHORT tier, and it is the owner’s 30 seconds', () => {
    const { exec, calls } = spyExec();
    void gitRunnerWith(exec)(['commit', '-q', '-m', 'x'], '/target');
    assert.equal(calls[0]?.options.timeout, 30_000,
      'a control a learner just pressed waits 30 seconds, not ten minutes (decision form Q3, option A)');
    assert.ok(GIT_TIMEOUT_MS.long > GIT_TIMEOUT_MS.short, 'and the long tier is the longer of the two');
  });

  /**
   * The funnel. Half 1 above is only worth anything while `gitRunnerWith` is the only thing
   * that starts a process — the next unbounded git would not be a missing tier, it would be a
   * new file with its own `execFile` and nobody the wiser.
   */
  suite('and one file spawns; the rest ask it to', () => {
    /** Where a subprocess is legitimately started in `src/`, and why. Anything else is new. */
    const ALLOWED: Array<[string, string]> = [
      ['src/start/build.ts', 'gitRunnerWith — the one spawner, and the one place the bound is applied'],
    ];

    const SPAWNERS = /\b(?:execFile|execFileSync|execSync|spawnSync|spawn|fork)\s*\(|\bchild_process\b/;

    /**
     * Every extension esbuild will resolve and bundle, not just `.ts` (T-13 review finding 4).
     * Driven, `src/telemetry.js` holding `require('node:child_process')` and imported by the
     * real `src/doctor.ts` was bundled into `dist/doctor.js` and the scan stayed GREEN — a
     * real, shipping, unbounded spawner the pin could not see. `.mts` and `.tsx` slipped past
     * identically. `tsc` happened to catch the `.js` case on an implicit `any`, which is a rule
     * that exists for an unrelated reason and that one `@ts-expect-error` removes; a pin that
     * is quietly relying on another layer is still broken.
     */
    const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

    function sources(dir: string, out: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sources(full, out);
        else if (SOURCE_FILE.test(entry.name)) out.push(full);
      }
      return out;
    }

    /**
     * The scan itself, over RAW text — no comment-stripping, which is the other half of finding
     * 4. The stripper this used to run, `replace(/\/\*[\s\S]*?\*\//g, '')`, knows nothing about
     * strings: one unbalanced `/*` inside a template literal, closed by a later real doc
     * comment, blanks every line between them. The fixture test below exhibits that on real
     * bytes rather than asserting it.
     *
     * **Measured on this tree, rather than taken from the review**, because the review's own
     * figure for how common that is did not reproduce and the honest number is the one you can
     * check. Today the stripper deletes no real statement in any of the 35 `src/**.ts` files,
     * and hides no spawner — so this is a latent hazard, not a live one. What is thin is the
     * margin: the stripper keeps 11% of `src/walk/paths.ts`, under 30% of 15 of the 35 files,
     * and a median of 32%. A pin whose input is mostly deleted before it is read is one webview
     * literal away from seeing nothing, and the failure direction is the silent one.
     *
     * Raw text errs the other way, and that is the whole reason to prefer it: a file that only
     * MENTIONS `execFile` in prose is reported, which is a loud false positive somebody fixes
     * in a minute, rather than a silent false negative that ships. Measured on this tree, no
     * file in `src/` does — the one file that names these words is the one on the allow-list.
     */
    function spawnersUnder(root: string): string[] {
      const offenders: string[] = [];
      for (const file of sources(root)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (SPAWNERS.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
      }
      return offenders.sort();
    }

    test('nothing outside the allow-list starts a subprocess of its own', () => {
      const root = process.cwd();
      assert.ok(fs.existsSync(path.join(root, 'src')),
        `src/ should be readable from the repository root, not ${root}`);

      const offenders = spawnersUnder(root)
        .filter((rel) => rel.startsWith('src/'))
        .filter((rel) => !ALLOWED.some(([allowed]) => allowed === rel));

      assert.deepEqual(
        offenders, [],
        'a module outside `src/start/build.ts` starts its own subprocess, or names one in a comment. '
        + 'A second spawner is a second place a time bound has to be remembered, which is exactly how '
        + 'T-13 happened — take a `GitRunner` instead, or add the file here with the reason it needs '
        + 'its own process. (This is a RAW text scan: a prose mention is reported too, on purpose.)',
      );
    });

    /**
     * The scan's own reach, proved on a fixture tree instead of on `src/`. The review broke the
     * real tree inside a `mktemp -d` copy to find the gaps; this is that reproduction inverted,
     * and it runs on every commit rather than once.
     */
    test('and the scan can actually SEE the shapes that used to slip past it', () => {
      const root = tmpDir('build-tutorials-scan-fixture-');
      const write = (rel: string, body: string): void => {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
      };

      write('telemetry.js', "const cp = require('node:child_process');\nmodule.exports = cp;\n");
      write('nested/deep/probe.mts', "import { spawn } from 'node:child_process';\nspawn('git');\n");
      write('widget.tsx', "import { execFile } from 'node:child_process';\nexecFile('git', []);\n");
      // The comment-stripper's blind spot, and it is written to actually EXHIBIT it rather than
      // to gesture at it: an unbalanced `/*` inside a template literal, and the next real doc
      // comment's `*/` closing it — so the non-greedy `replace(/\/\*[\s\S]*?\*\//g, '')` deletes
      // everything between, the spawner included. Measured on exactly these bytes: raw text
      // contains a spawner, the stripped text does not.
      write('webview.ts', [
        'export const CSS = `',
        '  .box { color: red } /* an unbalanced comment marker, inside a template literal',
        '`;',
        "import { execSync } from 'node:child_process';",
        "execSync('git status');",
        '/** A real doc comment, whose closing marker ends the one opened in the literal above. */',
        'export const after = 1;',
        '',
      ].join('\n'));
      // The discriminator: an ordinary module is not reported.
      write('quiet.ts', 'export const two = 1 + 1;\n');

      assert.deepEqual(
        spawnersUnder(root),
        ['nested/deep/probe.mts', 'telemetry.js', 'webview.ts', 'widget.tsx'],
        'the extension filter and the raw-text scan together have to see all four — a `.js` bundled '
        + 'by esbuild, a `.mts` in a subdirectory, a `.tsx`, and a spawner a comment-stripper would '
        + 'have blanked. Missing any one of them is a shipping unbounded subprocess nobody is told about',
      );

      // And the last of those four is not a hypothetical: the stripper this scan used to run
      // really does remove it. Asserting the mechanism rather than describing it is the point —
      // a comment claiming a stripper would have missed this file, without checking, would be
      // the same class of thing every other finding on this ticket was.
      const webview = fs.readFileSync(path.join(root, 'webview.ts'), 'utf8');
      assert.match(webview, SPAWNERS, 'the raw file spawns');
      assert.doesNotMatch(
        webview.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), SPAWNERS,
        'and after the old comment-stripper it does not — which is why this scan reads raw text. '
        + 'No file in `src/` is hidden this way today; what makes it worth guarding is that the stripper '
        + 'already deletes 89% of `src/walk/paths.ts` before anything reads it',
      );
    });

    /**
     * The allow-list's staleness check. It used to be `assert.match(code, /timeout/)` against
     * the whole file, which is satisfied by the forty lines of comment ABOUT timeouts that file
     * now carries — delete the option, keep the docs, stay green (review finding 7). It now
     * asserts the option is in the options object literal handed to the spawn, which no amount
     * of prose produces.
     *
     * It is still a smoke check and is labelled one: the property "every call reaches
     * `execFile` with a finite positive `timeout`" is pinned behaviourally by the input-shape
     * test at the top of this suite, over the space of inputs rather than over this file's
     * text. This one only says the allow-list is not describing a file that has moved on.
     */
    test('and the allow-list is not stale — the file on it still spawns, and still passes the option (smoke)', () => {
      for (const [rel, why] of ALLOWED) {
        const abs = path.join(process.cwd(), rel);
        assert.ok(fs.existsSync(abs), `${rel} is on the allow-list and is not there any more (${why})`);
        const code = fs.readFileSync(abs, 'utf8');
        assert.match(code, SPAWNERS, `${rel} no longer spawns anything — drop it from the list`);

        const call = /\bexec\(\s*'git'[\s\S]{0,200}?\{([^{}]*)\}/.exec(code);
        assert.ok(call, `${rel} no longer calls exec('git', …) with an options object — this check has drifted`);
        assert.match(call[1] ?? '', /\btimeout\b/,
          `${rel} spawns git without putting a timeout in the options it hands the child. The word `
          + 'appearing somewhere in the file is not the same thing, which is what this used to accept');
        assert.match(call[1] ?? '', /\bkillSignal\b/,
          `${rel} no longer states its killSignal — the escalation in gitRunnerWith is built on it`);
      }
    });
  });

  /**
   * The end of the wire. Everything above is about the number handed over; this is about a real
   * `git` that never returns, a real `execFile`, and `gitRunnerWith`'s own translation of what
   * comes back — the reproduction from T-6 security finding 5 with the signs flipped.
   *
   * The exec seam shortens the WAIT and not the sentence: the bound the runner reports is still
   * `GIT_TIMEOUT_MS.short`, which is what the spy tests above pin. A suite that sat out the real
   * thirty seconds would prove the same thing and cost thirty seconds on every run.
   */
  suite('a real git that never returns is really stopped', () => {
    const impatient: ExecFileLike = (file, args, options, callback) =>
      // `Math.min`, not a flat 600: if the runner ever stopped supplying a timeout this would
      // be NaN, and the test would fail rather than quietly proving that `execFile` honours a
      // number the seam put there itself.
      execFile(file, args, { ...options, timeout: Math.min(options.timeout, 600) }, callback);

    test('`git hash-object --stdin` — which reads stdin forever — rejects as a timeout', async function () {
      this.timeout(10_000);
      // execFile never closes the child's stdin, so this process runs until something stops it.
      // Before this ticket, nothing did: the test hung, and mocha's own process could not exit
      // afterwards because the orphan kept the event loop alive.
      const err = await gitRunnerWith(impatient)(['hash-object', '--stdin'], os.tmpdir())
        .then(() => null, (e: unknown) => e);

      assert.ok(err instanceof GitTimeoutError, `expected a GitTimeoutError, got ${String(err)}`);
      assert.equal(err.gitTimedOutAfterMs, GIT_TIMEOUT_MS.short, 'and it reports the tier’s bound');
      assert.ok(gitTimedOut(err), 'the predicate every caller branches on agrees');
      assert.match(err.message, /timed out after 30 seconds and was stopped/);
    });

    /**
     * The property the whole ticket rests on, and the one the first version did not have:
     * **the promise ALWAYS settles.** `execFile`'s `timeout` is a single `SIGTERM` and nothing
     * more — a child that ignores it, or one blocked in an uninterruptible syscall on the hung
     * network mount this ticket names as its own trigger, never reaches `close`, so
     * `execFile`'s callback never fires and the promise never resolves or rejects. On the
     * walk's serialised chain that is `step:check`, `dial:set`, `tutor:clear` and every other
     * queued control silent for good: T-6 finding 5 and T-7 finding 3, reopened by the fix
     * meant to close them.
     *
     * Driven before the fix, at a 600 ms bound: `*** NEVER SETTLED after 6s ***`, the child
     * still alive, and node itself unable to exit (124 under an external `timeout 20`).
     *
     * The assertion is deliberately about the PROMISE and not about the signal: escalating is
     * how it is done today, but what a person would say is *a bound that cannot be ignored*,
     * and that stays true if the mechanism is ever replaced.
     */
    test('a child that IGNORES SIGTERM still settles the promise — one signal is not a bound', async function () {
      if (process.platform === 'win32') { this.skip(); return; }
      this.timeout(20_000);

      const stubborn = path.join(tmpDir('build-tutorials-stubborn-'), 'stubborn.sh');
      // `trap '' TERM` is the portable spelling of the case that matters: a process the first
      // signal does not move. A D-state process on a hung NFS mount cannot be simulated in a
      // test — this is the same shape from the runner's side, which is all the runner can see.
      fs.writeFileSync(stubborn, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 0.2; done\n");
      fs.chmodSync(stubborn, 0o755);

      // The seam only substitutes the BINARY — `gitRunnerWith` always asks for `git`, and a
      // `git` that survives its own SIGTERM is exactly what is being stood in for. The options
      // are passed through untouched, `timeout` and `killSignal` included, so what is under
      // test is the runner's own numbers rather than the seam's.
      let childPid: number | undefined;
      const stubbornExec: ExecFileLike = (_file, _args, options, callback) => {
        const spawned = execFile(stubborn, [], options, callback);
        childPid = spawned.pid;
        return spawned;
      };

      // Both numbers overridden together, which is the point of `GitRunnerTuning`: the seam
      // used by the tests above rewrites the CHILD's timeout only, and against a runner that
      // now keeps a timer of its own that would be measuring a runner that does not exist.
      const started = Date.now();
      const err = await gitRunnerWith(stubbornExec, { boundMs: 400, killGraceMs: 400 })(
        ['commit', '-q', '-m', 'x'], os.tmpdir(),
      ).then(() => null, (e: unknown) => e);
      const elapsed = Date.now() - started;

      assert.ok(err instanceof GitTimeoutError,
        `the promise must settle even though the child ignored the signal — got ${String(err)}`);
      assert.equal(err.gitTimedOutAfterMs, 400, 'and it reports the bound it was actually given');
      assert.ok(elapsed >= 400,
        `it settled after ${elapsed}ms — before the bound, which would mean nothing was really waited for`);
      assert.ok(elapsed < 10_000,
        `it settled after ${elapsed}ms. The bound plus one grace is the whole wait; anything near mocha’s `
        + 'patience means the promise is again waiting on a child that will not close');

      // The settle is the property; this is the escalation doing its other job. A promise that
      // settled while leaving the process running would still be an improvement, and would
      // still be leaking one `git` per bound on a machine where git has stopped answering.
      assert.ok(childPid, 'the seam should have spawned something');
      await new Promise((r) => setTimeout(r, 250)); // the kernel's turn, not ours
      let alive = true;
      try { process.kill(childPid, 0); } catch { alive = false; }
      assert.equal(alive, false,
        `the child ignored SIGTERM and is still running after the runner gave up on it (pid ${String(childPid)}). `
        + 'SIGTERM first is deliberate — it is how git gets to remove its own lock files — but it cannot be '
        + 'the only signal');
    });

    test('git’s ordinary non-zero exit is NOT read as a timeout — the discriminator', async () => {
      const outside = tmpDir('build-tutorials-not-a-repo-');
      const err = await realGit(['rev-parse', '--git-dir'], outside).then(() => null, (e: unknown) => e);

      assert.ok(err instanceof Error, 'a non-repository is still a rejection');
      assert.equal(err instanceof GitTimeoutError, false);
      assert.equal(gitTimedOut(err), false,
        'exit 128 is git ANSWERING. Reading it as a timeout would make every caller’s new branch '
        + 'the one that fires on the ordinary case');
      assert.match(err.message, /not a git repository/i, 'and git’s own words survive, as before');
    });

    test('a resolved run is untouched by any of it', async () => {
      const version = await realGit(['--version'], os.tmpdir());
      assert.match(version, /^git version /);
    });
  });

  // ── the second pin the ticket asks for by name: the long tier reaches clone and fetch ──────

  /**
   * The regression this exists to catch is a legitimate clone dying at thirty seconds. It is
   * asserted as the NUMBER that reaches the child process rather than as the tier's name, so
   * renaming or restructuring the tiers cannot satisfy it while breaking the property: what
   * a person would say is *a clone gets minutes, not seconds*, and that is true or false
   * regardless of how the bound is spelled.
   */
  suite('the clone and the fetch get minutes; everything else gets seconds', () => {
    const TEN_MINUTES = 10 * 60_000;

    test('a fresh clone is given at least ten minutes', async () => {
      const { exec, calls } = spyExec();
      const storage = tmpDir('storage-');
      await resolveRepo('https://github.com/BMA-Corgea/repo-tour', storage, gitRunnerWith(exec));

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.args[0], 'clone');
      assert.ok((calls[0]?.options.timeout ?? 0) >= TEN_MINUTES,
        `the clone reached execFile with timeout=${String(calls[0]?.options.timeout)}. A FULL clone of a `
        + 'large repository over a slow link legitimately takes minutes; the short default would turn a '
        + 'working clone into a failed build');
    });

    test('and so is the fetch that refreshes one', async () => {
      const { exec, calls } = spyExec();
      const storage = tmpDir('storage-');
      fs.mkdirSync(path.join(storage, 'refs', 'BMA-Corgea-repo-tour', '.git'), { recursive: true });
      await resolveRepo('https://github.com/BMA-Corgea/repo-tour', storage, gitRunnerWith(exec));

      assert.equal(calls.length, 1);
      assert.ok(calls[0]?.args.includes('fetch'));
      assert.ok((calls[0]?.options.timeout ?? 0) >= TEN_MINUTES,
        'a fetch --all --tags talks to a network too');
    });

    test('a local path clones nothing, so it is bounded by not happening', async () => {
      const { exec, calls } = spyExec();
      const result = await resolveRepo('/some/local/repo', tmpDir('storage-'), gitRunnerWith(exec));
      assert.equal(result, '/some/local/repo');
      assert.deepEqual(calls, []);
    });
  });

  // ── what a stopped clone means to the caller: the first of the four sentences ─────────────

  suite('a clone that was stopped is reported as a wait, not as a broken repository', () => {
    function timingOutGit(): GitRunner {
      return (args) => Promise.reject(new GitTimeoutError(args, GIT_TIMEOUT_MS.long));
    }

    test('buildFromRequest returns the bound, says nothing was written, and leaves no marker', async () => {
      const target = tmpDir('build-tutorials-target-');
      const outcome = await buildFromRequest(
        requestFor('https://github.com/BMA-Corgea/repo-tour', target),
        baseContext({ git: timingOutGit() }),
      );

      assert.equal(outcome.ok, false);
      assert.match(outcome.reason ?? '', /timed out after 10 minutes and was stopped/,
        'the bound is named, so ten minutes reads as ours rather than as the network’s answer');
      assert.match(outcome.reason ?? '', /Nothing was written/);
      assert.match(outcome.reason ?? '', /point Build Tutorials at the folder/,
        'and it offers the thing they can actually do next');
      assert.equal(readMarker(target), null, 'no marker exists yet at that point, so there is none to resume');
    });

    /**
     * Review finding 5. The comment behind that sentence used to justify it with *"a
     * half-finished clone is reused with `fetch`, so a retry is not a fresh download"*, and
     * driven — on a real `file://` clone of a large local source killed mid-transfer — git
     * REMOVES the destination it created, so `resolveRepo`'s `fs.existsSync(dest/.git)` is
     * false and the retry is a full fresh clone.
     *
     * This is the same unwind on the fast path: a source that does not exist. What it pins is
     * the half the learner-facing sentence actually promises — *"Nothing was written, so
     * nothing needs cleaning up"* — which is true precisely BECAUSE git takes its own partial
     * clone with it. The killed-mid-transfer case is the same code in git and is not waited
     * out here; it was driven in the review and is recorded there.
     */
    test('a failed clone leaves no destination behind — which is what "nothing to clean up" rests on', async () => {
      const storage = tmpDir('storage-');
      const dest = path.join(storage, 'refs', 'BMA-Corgea-repo-tour');
      const missing = path.join(tmpDir('build-tutorials-no-such-source-'), 'not-a-repository');

      // `resolveRepo` only takes the clone branch for a GitHub URL, so the real `git clone` is
      // driven directly with the same shape: a destination git has to create for itself.
      const err = await realGit(['clone', missing, dest]).then(() => null, (e: unknown) => e);

      assert.ok(err instanceof Error, 'cloning something that is not there fails');
      assert.equal(fs.existsSync(dest), false,
        'git unwinds the directory it created. A comment claiming the partial clone is kept and '
        + 'refreshed with `fetch` was wrong about this, and the retry advice has to be true for the '
        + 'reason it is actually true: nothing is left, so nothing needs cleaning up');
      assert.equal(fs.existsSync(path.join(dest, '.git')), false,
        'and `resolveRepo` tests exactly this path, so the next press clones fresh rather than fetching');
    });

    test('an ordinary clone failure keeps the wording it always had', async () => {
      const target = tmpDir('build-tutorials-target-');
      const outcome = await buildFromRequest(
        requestFor('https://github.com/BMA-Corgea/repo-tour', target),
        baseContext({ git: () => Promise.reject(new Error('git clone failed: Repository not found.')) }),
      );

      assert.equal(outcome.ok, false);
      assert.match(outcome.reason ?? '', /Repository not found/);
      assert.doesNotMatch(outcome.reason ?? '', /Nothing was written/,
        'the timeout advice would be noise on a repository that does not exist');
    });
  });
});
