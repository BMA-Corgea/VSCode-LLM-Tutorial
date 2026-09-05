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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import {
  buildDir, buildFromRequest, coreFor, completionMessage, costLine, detectUnsupportedLanguages,
  languageRefusalMessage, markerPath, readMarker, resolveRepo, resumeIfMarked,
  type BuildContext, type BuildCore, type BuildMarker, type BuildPhase, type DigestResultLike,
  type GitRunner, type InterpretCostLike,
} from '../../src/start/build.js';
import { emptyRequest, type BuildRequest } from '../../src/start/request.js';

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

// ── a hand-rolled draft-07 subset schema checker, mirroring repo-tour's own T-12 test
// (test/build.test.ts, "the JSON schema (AC8)") — no ajv, same reasoning: a small checker
// over exactly the subset schema/build-plan.schema.json uses ($ref, const, enum, oneOf,
// type, required/properties, items/minItems) needs no runtime dependency. ──

type JsonSchema = Record<string, unknown>;

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const parts = ref.replace(/^#\//, '').split('/');
  let cur: unknown = root;
  for (const p of parts) cur = (cur as Record<string, unknown>)[p];
  return cur as JsonSchema;
}

function validateAgainst(root: JsonSchema, schema: JsonSchema, value: unknown, at: string, errors: string[]): void {
  if (typeof schema['$ref'] === 'string') {
    validateAgainst(root, resolveRef(root, schema['$ref']), value, at, errors);
    return;
  }
  if ('const' in schema) {
    if (value !== schema['const']) errors.push(`${at}: expected ${JSON.stringify(schema['const'])}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema['enum'])) {
    if (!schema['enum'].includes(value)) errors.push(`${at}: expected one of ${JSON.stringify(schema['enum'])}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema['oneOf'])) {
    const matches = (schema['oneOf'] as JsonSchema[]).filter((s) => {
      const sub: string[] = [];
      validateAgainst(root, s, value, at, sub);
      return sub.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at}: expected exactly one oneOf branch to match, ${matches.length} did`);
    return;
  }
  if (schema['type'] !== undefined) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    const ok = types.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
      return typeof value === t;
    });
    if (!ok) {
      errors.push(`${at}: expected type ${JSON.stringify(schema['type'])}, got ${JSON.stringify(value)}`);
      return;
    }
  }
  if (schema['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${at}: missing required key "${key}"`);
    }
    const props = (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateAgainst(root, sub, obj[key], `${at}.${key}`, errors);
    }
  }
  if (schema['type'] === 'array' && Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      errors.push(`${at}: expected at least ${schema['minItems']} items, got ${value.length}`);
    }
    if (schema['items']) value.forEach((v, i) => validateAgainst(root, schema['items'] as JsonSchema, v, `${at}[${i}]`, errors));
  }
}

function validateBuildPlan(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  validateAgainst(schema, schema, value, '$', errors);
  return errors;
}

const SCHEMA: JsonSchema = JSON.parse(
  fs.readFileSync(path.join(CORE_ROOT, 'schema', 'build-plan.schema.json'), 'utf8'),
) as JsonSchema;

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

    const writtenRequest: unknown = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    assert.deepEqual(writtenRequest, request);

    assert.equal(readMarker(target), null, 'the marker must be gone on success');
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
