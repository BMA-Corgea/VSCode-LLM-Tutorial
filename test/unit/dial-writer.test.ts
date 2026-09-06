// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/dial/writer.ts` — what the three-position dial writes (ACs 2, 3, 4, 6).
 *
 * Everything the dial writes is decided by a pure function of (step, dial, a reference tree
 * on disk), so all of it runs under plain mocha with real `fs` and no extension host. Nothing
 * here imports `vscode`, value or type: `esbuild.mjs` marks `repo-tour` and `mocha` external
 * for the unit bundle and deliberately does NOT mark `vscode`, so one such import would fail
 * the build for every unit suite at once.
 *
 * **The core is the REAL one.** `stubFile` and `extract` are loaded out of the sibling
 * repo-tour checkout exactly as `build.test.ts` loads its own core, because AC3's check is not
 * "the writer called `stubFile`" — it is "the file that lands on the learner's disk PARSES,
 * with zero tree-sitter ERROR nodes, in TS, JS and Python". A fake core cannot answer that
 * question, and answering it is the whole reason this module is worth a suite of its own: a
 * scaffold that does not parse greets the learner with red squiggles they did not cause.
 *
 * **The fixture is a REFERENCE tree, not a target tree**, which is why it is here rather than
 * in `walk-fixtures.ts`. That file describes a folder the learner is building IN — a plan plus
 * the files the plan talks about. This one describes the repository being copied FROM: three
 * source languages, a file with no grammar at all, a CRLF file with no trailing newline, and
 * the generated/lockfile/binary files that are never taught and only ever reproduced. They are
 * different objects with different jobs, and this one also has to hold bytes (a real binary,
 * real CRLF) that a target fixture has no reason to carry.
 *
 * Line numbers are load-bearing throughout: every `loadBearing` range below is written against
 * the fixture sources as numbered in their comments, so a line added to one of those templates
 * without moving the ranges will show up as a stub in the wrong place — which is exactly the
 * failure the parse assertions exist to catch.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor, type DialCore, type FileRecord } from '../../src/dial/core.js';
import {
  fileShape, isRefusal, planWrite, reproduceEntries, reproduceFiles, writeTextAtomic,
  type PlannedWrite, type WritePlan,
} from '../../src/dial/writer.js';
import type { PlanLike, StepLike } from '../../src/walk/model.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

let core: DialCore;

suiteSetup(async function () {
  // Loading the grammars costs a second or two the first time; the default 2s timeout is not
  // a statement about how long that should take.
  this.timeout(60_000);
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  core = dialCoreFor(loaded.loaded);
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── the reference repository the dial copies from ───────────────────────────────────────────

/**
 *  1 import { readFileSync } from 'node:fs';
 *  2 import {
 *  3   join,
 *  4 } from 'node:path';
 *  5 export { VERSION as version } from './version.js';
 *  6
 *  7 export interface Token {
 *  8   kind: 'word' | 'punct';
 *  9   value: string;
 * 10 }
 * 11
 * 12 export function tokenize(line: string): Token[] {   <- load-bearing 12-18
 * ...
 * 20 export function render(tokens: Token[]): string {   <- load-bearing 20-22
 * ...
 * 24 const CONFIG = join(__dirname, 'config.json');
 * 25 export const VERSION = readFileSync(CONFIG, 'utf8').length;
 */
const UTIL_TS = `import { readFileSync } from 'node:fs';
import {
  join,
} from 'node:path';
export { VERSION as version } from './version.js';

export interface Token {
  kind: 'word' | 'punct';
  value: string;
}

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  for (const raw of line.split(/\\s+/)) {
    if (raw.length > 0) out.push({ kind: 'word', value: raw });
  }
  return out;
}

export function render(tokens: Token[]): string {
  return tokens.map((t) => t.value).join(' ');
}

const CONFIG = join(__dirname, 'config.json');
export const VERSION = readFileSync(CONFIG, 'utf8').length;
`;

/**
 * 1 const { tokenize } = require('./util.js');
 * 2
 * 3 function shout(line) {   <- load-bearing 3-5
 * 4   return tokenize(line).map((t) => t.value.toUpperCase()).join(' ');
 * 5 }
 * 6
 * 7 module.exports = { shout };
 */
const APP_JS = `const { tokenize } = require('./util.js');

function shout(line) {
  return tokenize(line).map((t) => t.value.toUpperCase()).join(' ');
}

module.exports = { shout };
`;

/**
 *  1 import json
 *  2 from typing import List
 *  3
 *  4
 *  5 def total(values: List[int]) -> int:   <- load-bearing 5-10
 * ...
 * 13 def as_json(values: List[int]) -> str: <- load-bearing 13-14
 * 14     return json.dumps({"total": total(values)})
 */
const CALC_PY = `import json
from typing import List


def total(values: List[int]) -> int:
    """Add the values up."""
    running = 0
    for v in values:
        running += v
    return running


def as_json(values: List[int]) -> str:
    return json.dumps({"total": total(values)})
`;

/** CRLF, a BOM, and no trailing newline — three things a careless writer "fixes" (AC4/AC6). */
const CRLF_TS = `\uFEFFexport const GREETING = 'hi';\r\nexport function greet(): string {\r\n  return GREETING;\r\n}`;

/** Not text at all: a NUL, and bytes that are not valid UTF-8 in any order. */
const BLOB_BIN = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x00, 0x80, 0x0d, 0x0a]);

/** The reference repository, written once per test that needs one. */
function referenceTree(): string {
  const root = tmpDir('dial-writer-reference-');
  const write = (rel: string, data: string | Buffer): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  write('src/util.ts', UTIL_TS);
  write('src/app.js', APP_JS);
  write('calc.py', CALC_PY);
  write('crlf.ts', Buffer.from(CRLF_TS, 'utf8'));
  write('README.md', '# The reference\n\nNothing here has a grammar.\n');
  write('package-lock.json', '{\n  "lockfileVersion": 3\n}\n');
  write('vendor/bundle.min.js', '!function(){var a=1}();\n');
  write('data/blob.bin', BLOB_BIN);
  return root;
}

function step(
  overrides: Partial<StepLike> & Pick<StepLike, 'id' | 'ordinal' | 'kind' | 'target'>,
  question = `why is ${overrides.target.file} shaped this way?`,
): StepLike {
  return {
    chapter: 'src',
    decision: {
      question,
      options: [{ id: 'author', label: 'What the author did', consequence: 'as written', taken: true }],
      authorChoice: 'author',
      chosen: 'author',
      why: 'because that is what the author did',
      whySource: 'interpret',
    },
    scaffold: { loadBearing: [], boilerplate: [] },
    dependsOn: [],
    witness: { sha: null, date: null, subject: null },
    ...overrides,
  };
}

/**
 * The plan for that reference tree. A fresh graph per call, so a test may mutate what it gets.
 *
 * `st-3-symbol-tokenize` exists to pin `stubQuestionsFor`'s two branches at once: it starts on
 * line 12, the same line as the file step's FIRST load-bearing range, so that range's stub is
 * named after step 3, while the second range — which no symbol step starts on — falls back to
 * the file step's own ordinal and question.
 */
function referencePlan(): PlanLike {
  return {
    schemaVersion: 1,
    source: { kind: 'repo', root: '/fixture/reference', head: 'a'.repeat(40) },
    mode: 'recreate',
    generatedAt: '2026-09-05T00:00:00.000Z',
    cost: { provider: 'claude', metered: false, calls: 0, cachedStops: 0, interpretedStops: 0, inputTokens: 0, outputTokens: 0, usd: 0, model: 'none', failures: [] },
    reproduce: ['package-lock.json', 'vendor/bundle.min.js', 'data/blob.bin'],
    chapters: [{ key: 'src', title: 'src', subtitle: '2 files', tierPath: 'src' }],
    steps: [
      step({ id: 'st-1-shape-src', ordinal: 1, kind: 'shape', target: { file: 'src' } }),
      step({
        id: 'st-2-file-util',
        ordinal: 2,
        kind: 'file',
        target: { file: 'src/util.ts' },
        scaffold: {
          loadBearing: [{ startLine: 12, endLine: 18 }, { startLine: 20, endLine: 22 }],
          boilerplate: [{ startLine: 1, endLine: 11 }, { startLine: 19, endLine: 19 }, { startLine: 23, endLine: 25 }],
        },
      }),
      step({
        id: 'st-3-symbol-tokenize',
        ordinal: 3,
        kind: 'symbol',
        target: { file: 'src/util.ts', startLine: 12, endLine: 18 },
        scaffold: { loadBearing: [{ startLine: 12, endLine: 18 }], boilerplate: [] },
      }, 'how should tokenize turn a line into tokens?'),
      step({
        id: 'st-4-file-app',
        ordinal: 4,
        kind: 'file',
        target: { file: 'src/app.js' },
        scaffold: { loadBearing: [{ startLine: 3, endLine: 5 }], boilerplate: [{ startLine: 1, endLine: 2 }, { startLine: 6, endLine: 7 }] },
      }),
      step({
        id: 'st-5-file-calc',
        ordinal: 5,
        kind: 'file',
        target: { file: 'calc.py' },
        scaffold: {
          loadBearing: [{ startLine: 5, endLine: 10 }, { startLine: 13, endLine: 14 }],
          boilerplate: [{ startLine: 1, endLine: 4 }, { startLine: 11, endLine: 12 }],
        },
      }),
      step({ id: 'st-6-file-crlf', ordinal: 6, kind: 'file', target: { file: 'crlf.ts' } }),
      step({
        id: 'st-7-file-readme',
        ordinal: 7,
        kind: 'file',
        target: { file: 'README.md' },
        scaffold: { loadBearing: [{ startLine: 1, endLine: 1 }], boilerplate: [] },
      }),
    ],
  };
}

function stepOf(plan: PlanLike, id: string): StepLike {
  const found = plan.steps.find((s) => s.id === id);
  if (!found) assert.fail(`the fixture plan has no step ${id}`);
  return found;
}

// ── reading the result of a plan, without letting a refusal pass as a write ─────────────────

function plannedWrite(result: WritePlan): PlannedWrite {
  if (result === null) assert.fail('expected a planned write, got null (nothing to write)');
  if (isRefusal(result)) assert.fail(`expected a planned write, got a refusal: ${result.refused}`);
  return result;
}

function refusalOf(result: WritePlan): string {
  if (result === null) assert.fail('expected a refusal, got null — a refused path must be distinguishable from "nothing to write"');
  if (!isRefusal(result)) assert.fail(`expected a refusal, got a write to ${result.path}`);
  return result.refused;
}

/** Writes the plan for real and hands back the bytes that landed. */
function apply(result: WritePlan): Buffer {
  const write = plannedWrite(result);
  writeTextAtomic(write.path, write.content);
  return fs.readFileSync(write.path);
}

/** The real core's ERROR-node count for a source — AC3's own check, not a proxy for it. */
async function parseErrorsOf(source: string, language: string, ext: string): Promise<number> {
  const dir = tmpDir('dial-writer-parse-');
  const rel = `probe.${ext}`;
  fs.writeFileSync(path.join(dir, rel), source);
  const record: FileRecord = {
    path: rel, repo: '', bytes: Buffer.byteLength(source, 'utf8'), loc: source.split(/\r?\n/).length,
    language, sha256: '', classification: 'source', signals: [], binary: false,
  };
  const { extracts } = await core.extract(dir, [record]);
  assert.equal(extracts.length, 1, `extract() produced nothing for a ${language} fixture`);
  return (extracts[0] as { parseErrors: number }).parseErrors;
}

// ── manual: the extension writes nothing (AC2) ──────────────────────────────────────────────

suite('the dial at manual — the extension writes nothing (AC2)', () => {
  test('every kind of step plans nothing, and the target folder stays empty', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();

    for (const s of plan.steps) {
      assert.equal(planWrite(s, 'manual', refRoot, target, plan, core), null, `${s.id} planned a write in manual mode`);
    }
    assert.deepEqual(fs.readdirSync(target), [], 'manual mode touched the target folder');
  });

  test('a shape or symbol step is never written, at any dial position', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();

    for (const id of ['st-1-shape-src', 'st-3-symbol-tokenize']) {
      for (const dial of ['manual', 'scaffolded', 'automated'] as const) {
        assert.equal(planWrite(stepOf(plan, id), dial, refRoot, target, plan, core), null, `${id} planned a write at ${dial}`);
      }
    }
  });
});

// ── scaffolded: boilerplate verbatim, load-bearing stubbed, and it PARSES (AC3) ─────────────

suite('the dial at scaffolded — the shape, never the answer (AC3)', () => {
  test('boilerplate survives verbatim and the load-bearing bodies are gone', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const written = apply(planWrite(stepOf(plan, 'st-2-file-util'), 'scaffolded', refRoot, target, plan, core)).toString('utf8');

    // boilerplate, byte for byte
    assert.match(written, /^import \{ readFileSync \} from 'node:fs';\n/);
    assert.ok(written.includes("export { VERSION as version } from './version.js';"), 'a re-export line was lost');
    assert.ok(written.includes("export interface Token {\n  kind: 'word' | 'punct';\n  value: string;\n}"), 'the interface is boilerplate and must survive whole');
    assert.ok(written.includes("export const VERSION = readFileSync(CONFIG, 'utf8').length;"), 'the tail of the file was dropped');

    // the two load-bearing bodies, gone — signatures kept
    assert.ok(written.includes('export function tokenize(line: string): Token[] {'), 'the signature is boilerplate the learner should not have to invent');
    assert.ok(!written.includes('if (raw.length > 0)'), 'the answer to the first load-bearing range was handed over');
    assert.ok(written.includes('export function render(tokens: Token[]): string {'), 'the second signature was lost');
    assert.ok(!written.includes('.map((t) => t.value).join'), 'the answer to the second load-bearing range was handed over');
  });

  test('each stub is named after the step the learner will land on', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const written = apply(planWrite(stepOf(plan, 'st-2-file-util'), 'scaffolded', refRoot, target, plan, core)).toString('utf8');

    // Range one starts on the symbol step's own line, so it is named after THAT step…
    assert.ok(
      written.includes('// TODO(step 3): how should tokenize turn a line into tokens?'),
      `the first stub is not named after the symbol step that owns it:\n${written}`,
    );
    // …and range two, which no symbol step starts on, falls back to the file step itself.
    assert.ok(
      written.includes('// TODO(step 2): why is src/util.ts shaped this way?'),
      `the second stub did not fall back to the file step:\n${written}`,
    );
  });

  test('the written file parses with zero ERROR nodes — TypeScript, JavaScript and Python', async function () {
    this.timeout(60_000);
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();

    const cases: Array<[string, string, string]> = [
      ['st-2-file-util', 'typescript', 'ts'],
      ['st-4-file-app', 'javascript', 'js'],
      ['st-5-file-calc', 'python', 'py'],
    ];
    for (const [id, language, ext] of cases) {
      const written = apply(planWrite(stepOf(plan, id), 'scaffolded', refRoot, target, plan, core)).toString('utf8');
      assert.equal(await parseErrorsOf(written, language, ext), 0, `the scaffolded ${language} file does not parse:\n${written}`);
      // And the reference it came from parses too, so a zero above is a real result rather
      // than a language the grammar quietly declines to complain about.
      assert.equal(await parseErrorsOf(fs.readFileSync(path.join(refRoot, stepOf(plan, id).target.file), 'utf8'), language, ext), 0);
    }
  });

  test('that check can fail — a file that does not parse really does report ERROR nodes', async function () {
    this.timeout(60_000);
    // Without this the assertion above would also pass against a `parseErrorsOf` that always
    // answered zero, and AC3's whole check would be decorative.
    assert.ok(await parseErrorsOf('export function broken(: {\n', 'typescript', 'ts') > 0);
    assert.ok(await parseErrorsOf('def f(:\n    return 1\n', 'python', 'py') > 0);
  });

  test('a python block body is replaced in place, header and indentation intact', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const written = apply(planWrite(stepOf(plan, 'st-5-file-calc'), 'scaffolded', refRoot, target, plan, core)).toString('utf8');

    assert.ok(written.startsWith('import json\nfrom typing import List\n'), 'the imports are boilerplate');
    assert.ok(written.includes('def total(values: List[int]) -> int:\n    raise NotImplementedError'), `the block body was not stubbed:\n${written}`);
    assert.ok(!written.includes('running += v'), 'the answer was handed over');
    assert.ok(!written.includes('json.dumps'), 'the second range was not stubbed');
  });

  test('a file with nothing load-bearing is all boilerplate — the reference, verbatim', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    // `st-6-file-crlf` declares no load-bearing ranges at all.
    const written = apply(planWrite(stepOf(plan, 'st-6-file-crlf'), 'scaffolded', refRoot, target, plan, core));
    assert.ok(written.equals(fs.readFileSync(path.join(refRoot, 'crlf.ts'))), 'a file with no decisions in it should arrive whole');
  });

  test('a file repo-tour has no grammar for is refused, not "scaffolded" into the answer', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    // stubFile leaves an unrecognised language's ranges untouched — which for a scaffold means
    // handing over exactly the lines it was asked to hide. Refusing is the honest answer.
    const reason = refusalOf(planWrite(stepOf(plan, 'st-7-file-readme'), 'scaffolded', refRoot, target, plan, core));
    assert.match(reason, /no grammar for README\.md/);
    assert.deepEqual(fs.readdirSync(target), [], 'a refusal must not write anything');
  });

  test('the same file at automated needs no grammar — a refusal is about stubbing, not copying', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const written = apply(planWrite(stepOf(plan, 'st-7-file-readme'), 'automated', refRoot, target, plan, core));
    assert.ok(written.equals(fs.readFileSync(path.join(refRoot, 'README.md'))));
  });

  test('load-bearing ranges that are not ranges are refused, never stubbed around', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const broken = stepOf(plan, 'st-2-file-util');
    // Dropping one bad range would shift every stub's question onto the wrong range, and
    // stubFile's own handling of a NaN line number silently truncates the rest of the file.
    broken.scaffold.loadBearing = [{ startLine: 12, endLine: 18 }, { startLine: Number.NaN, endLine: 22 }];
    assert.match(refusalOf(planWrite(broken, 'scaffolded', refRoot, target, plan, core)), /are not line ranges/);
    assert.deepEqual(fs.readdirSync(target), []);
  });
});

// ── automated: the reference file, byte for byte (AC4, AC6) ─────────────────────────────────

suite('the dial at automated — byte for byte (AC4, AC6)', () => {
  test('every source file arrives identical to the reference', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();

    for (const id of ['st-2-file-util', 'st-4-file-app', 'st-5-file-calc']) {
      const s = stepOf(plan, id);
      const written = apply(planWrite(s, 'automated', refRoot, target, plan, core));
      const reference = fs.readFileSync(path.join(refRoot, s.target.file));
      // Buffers, not strings: `diff -r` is the acceptance criterion and it compares bytes.
      assert.ok(written.equals(reference), `${s.target.file} differs from the reference`);
    }
  });

  test('a BOM, CRLF line endings and a missing trailing newline all survive', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const written = apply(planWrite(stepOf(plan, 'st-6-file-crlf'), 'automated', refRoot, target, plan, core));
    const reference = fs.readFileSync(path.join(refRoot, 'crlf.ts'));

    assert.ok(written.equals(reference), 'the three things a careless writer "fixes" were fixed');
    assert.equal(written.subarray(0, 3).toString('hex'), 'efbbbf', 'the BOM was stripped');
    assert.ok(written.includes('\r\n'), 'CRLF was normalised away');
    assert.ok(!written.toString('utf8').endsWith('\n'), 'a trailing newline was invented');
  });

  test('the destination is inside the target, and the plan says so before anything is written', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const write = plannedWrite(planWrite(stepOf(plan, 'st-2-file-util'), 'automated', refRoot, target, plan, core));

    assert.equal(write.path, path.join(target, 'src', 'util.ts'));
    assert.equal(fs.existsSync(write.path), false, 'planWrite must PLAN a write, never perform one');
  });

  test('a reference file that is not UTF-8 text is refused rather than rewritten as replacement characters', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const binaryStep = step({ id: 'st-x-blob', ordinal: 9, kind: 'file', target: { file: 'data/blob.bin' } });

    assert.match(refusalOf(planWrite(binaryStep, 'automated', refRoot, target, plan, core)), /is not UTF-8 text/);
    assert.deepEqual(fs.readdirSync(target), []);
  });

  test('a reference file that is not there is refused, not written blank', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const missing = step({ id: 'st-x-missing', ordinal: 9, kind: 'file', target: { file: 'src/nowhere.ts' } });

    assert.match(refusalOf(planWrite(missing, 'automated', refRoot, target, plan, core)), /could not be read/);
    assert.deepEqual(fs.readdirSync(target), []);
  });
});

// ── containment: nothing is written outside the learner's folder ────────────────────────────

suite('containment — a destination that leaves the target is refused, never clamped', () => {
  test('a `target.file` of ../escape is a refusal the caller can act on', () => {
    const refRoot = referenceTree();
    const sandbox = tmpDir('dial-writer-sandbox-');
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    const plan = referencePlan();
    const escape = step({ id: 'st-x-escape', ordinal: 9, kind: 'file', target: { file: '../escape/pwned.ts' } });

    for (const dial of ['scaffolded', 'automated'] as const) {
      const result = planWrite(escape, dial, refRoot, target, plan, core);
      // Not null: "refused" and "nothing to write" are different answers, and a caller that
      // cannot tell them apart reports a security refusal as a quiet no-op.
      assert.ok(isRefusal(result), `${dial} did not refuse an escaping path`);
      assert.match(refusalOf(result), /points outside the folder you are building in/);
    }
    // path.join would have produced <sandbox>/escape/pwned.ts. Nothing was clamped into the
    // target either — a refusal writes nowhere at all.
    assert.deepEqual(fs.readdirSync(sandbox), ['project']);
    assert.deepEqual(fs.readdirSync(target), []);
  });

  test('an absolute `target.file`, which path.join would have quietly made relative', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const absolute = step({ id: 'st-x-abs', ordinal: 9, kind: 'file', target: { file: '/etc/passwd' } });

    assert.match(refusalOf(planWrite(absolute, 'automated', refRoot, target, plan, core)), /points outside the folder/);
  });

  test('an ordinary nested path still resolves — the refusal is not vacuous', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    // Same shape as the escaping case, one directory deeper and legitimate. Without this a
    // planWrite that refused everything would pass the suite above and break every real plan.
    const nested = plannedWrite(planWrite(stepOf(plan, 'st-2-file-util'), 'automated', refRoot, target, plan, core));
    assert.equal(nested.path, path.join(target, 'src', 'util.ts'));
    assert.ok(apply(planWrite(stepOf(plan, 'st-2-file-util'), 'automated', refRoot, target, plan, core)).length > 0);
  });

  test('a reference path that leaves the reference root is refused on the read side too', () => {
    const refRoot = referenceTree();
    // Reached through `fileShape`, which only ever reads: `planWrite` checks the destination
    // first, and with one relative path and two roots the two checks always agree.
    const escape = step({ id: 'st-x-escape', ordinal: 9, kind: 'file', target: { file: '../../etc/passwd' } });
    assert.deepEqual(fileShape(refRoot, escape), { signatures: [], imports: [] });
  });
});

// ── containment, the half that needs a real filesystem ──────────────────────────────────────

/**
 * A symlinked DIRECTORY inside the target (T-5 security review, finding 1 — HIGH).
 *
 * The suite above is arithmetic: `..`, an absolute path, a sibling that shares a name prefix.
 * All of it is real and all of it was already working, and none of it is containment on its
 * own, because a path can stay under the target as a STRING and land somewhere else on a DISK.
 * What ships that gap is a repository committing one line:
 *
 *     src -> ../outside
 *
 * git recreates a symlink on clone, so it costs an attacker nothing; `resolveInsideTarget`
 * says `src/util.ts` is contained, which it is, lexically; and `mkdirSync(…, { recursive:
 * true })` follows the link without a murmur. The learner clicks a step and a file outside the
 * folder they named is overwritten. Nor does this need an attacker at all — pnpm makes every
 * `node_modules/<pkg>` a directory symlink into a global store, and repo-tour classifies
 * `node_modules` as vendored, which puts it straight into `plan.reproduce`.
 *
 * So every test here builds a REAL symlink on a REAL disk and then asserts about the file
 * outside, not about what the writer believed it was doing. A test that only checked the
 * refusal message would pass just as happily if the refusal came after the write.
 *
 * Both directions again: the ordinary nested path and the legitimately symlinked TARGET are
 * asserted just as carefully, because a check that refused everything would pass every hostile
 * case here and break every real build — including, specifically, every build on macOS, where
 * `os.tmpdir()` sits under a symlink.
 */
suite('containment — a symlinked DIRECTORY, where the lexical check ends and the disk begins', () => {
  /**
   * The planted repository, built for real: a canary file outside the target, and a `src`
   * inside the target that is a link to the folder holding it. The reference tree really does
   * have `src/util.ts`, so nothing but the symlink distinguishes this from an ordinary build.
   */
  function planted(): { refRoot: string; target: string; outside: string; canary: string } {
    const refRoot = referenceTree();
    const sandbox = tmpDir('dial-writer-sandbox-');
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside);
    const canary = path.join(outside, 'util.ts');
    fs.writeFileSync(canary, 'someone else’s file\n');
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    fs.symlinkSync(path.join('..', 'outside'), path.join(target, 'src'));
    return { refRoot, target, outside, canary };
  }

  test('planWrite refuses it in words, in every position that writes — and the file outside is untouched', () => {
    const plan = referencePlan();
    for (const dial of ['scaffolded', 'automated'] as const) {
      const { refRoot, target, canary } = planted();
      const result = planWrite(stepOf(plan, 'st-2-file-util'), dial, refRoot, target, plan, core);

      // A refusal, not a null: "refused" and "nothing to write" are different answers, and the
      // session shows the first and stays silent about the second.
      assert.ok(isRefusal(result), `${dial} planned a write through a symlinked directory`);
      assert.match(refusalOf(result), /through a symlink/);
      assert.equal(fs.readFileSync(canary, 'utf8'), 'someone else’s file\n',
        `${dial} wrote through the planted link and overwrote a file outside the learner's folder`);
    }
  });

  test('a directory DEEPER than the link is refused too, and nothing is created outside', () => {
    // `<target>/src/deep` is not itself a symlink — it does not exist yet, and mkdir -p would
    // create it inside `outside/`. A check that only lstat'd the last component would pass
    // this, and a check that created before it looked would leave an empty folder out there.
    const { refRoot, target, outside } = planted();
    const plan = referencePlan();
    // The reference really does have this file, so the refusal below can only be about the
    // DESTINATION — `readReference` refuses a missing source first, and would have masked it.
    fs.mkdirSync(path.join(refRoot, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(refRoot, 'src', 'deep', 'util.ts'), 'export const F = 6;\n');
    const deeper = step({
      id: 'st-x-deep',
      ordinal: 9,
      kind: 'file',
      target: { file: 'src/deep/util.ts' },
    });

    assert.match(refusalOf(planWrite(deeper, 'automated', refRoot, target, plan, core)), /through a symlink/);
    assert.deepEqual(fs.readdirSync(outside), ['util.ts'], 'a refused plan created a directory outside the target');
  });

  test('the write primitive refuses the same destination when it is told the root', () => {
    // `planWrite` is where a refusal becomes a sentence the learner reads; this is the last
    // line, for the window between a plan and the write it authorised.
    const { target, canary } = planted();
    const dest = path.join(target, 'src', 'util.ts');

    assert.throws(() => writeTextAtomic(dest, 'pwned\n', target), /through a symlink/);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'someone else’s file\n');
  });

  test('reproduce refuses the planted entry, reports it, and still copies the entries beside it', () => {
    const { refRoot, target, outside } = planted();
    fs.writeFileSync(path.join(outside, 'bundle.min.js'), 'do not touch\n');
    fs.symlinkSync(path.join('..', 'outside'), path.join(target, 'vendor'));
    const plan = referencePlan();
    plan['reproduce'] = ['vendor/bundle.min.js', 'package-lock.json'];

    const problems = reproduceFiles(plan, refRoot, target);

    assert.equal(problems.length, 1, `expected one refusal, got ${JSON.stringify(problems)}`);
    assert.match(problems[0] ?? '', /refused — it reaches outside the folder you are building in through a symlink/);
    assert.equal(fs.readFileSync(path.join(outside, 'bundle.min.js'), 'utf8'), 'do not touch\n');
    // Not vacuous, and not all-or-nothing: one planted entry must not cost the learner the
    // lockfile they are owed, or AC6's `diff -r` can never come back clean.
    assert.ok(fs.existsSync(path.join(target, 'package-lock.json')));
  });

  test('the READ side too: a reference file behind a symlink is refused before it is read', () => {
    // The mirror image, and the reason the check runs on both roots. `vendor -> ~` in a
    // reference repository copies a file the learner can read into a project they are about to
    // commit and push — and `fileShape` would have shown it to them on the way.
    const sandbox = tmpDir('dial-writer-sandbox-');
    const secrets = path.join(sandbox, 'secrets');
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'util.ts'), 'BEGIN OPENSSH PRIVATE KEY\n');
    const refRoot = path.join(sandbox, 'reference');
    fs.mkdirSync(refRoot);
    fs.symlinkSync(path.join('..', 'secrets'), path.join(refRoot, 'src'));
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    const util = stepOf(plan, 'st-2-file-util');

    assert.match(refusalOf(planWrite(util, 'automated', refRoot, target, plan, core)), /reference repository/);
    assert.deepEqual(fileShape(refRoot, util), { signatures: [], imports: [] },
      'the panel is a place to read the answer out of, so a refused read must not reach it either');
    assert.deepEqual(fs.readdirSync(target), [], 'nothing was written for a file we would not read');
  });

  test('reproduce refuses an entry that leaves the REFERENCE through a symlink', () => {
    const sandbox = tmpDir('dial-writer-sandbox-');
    const secrets = path.join(sandbox, 'secrets');
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'id_rsa'), 'BEGIN OPENSSH PRIVATE KEY\n');
    const refRoot = path.join(sandbox, 'reference');
    fs.mkdirSync(refRoot);
    fs.writeFileSync(path.join(refRoot, 'package-lock.json'), '{}\n');
    fs.symlinkSync(path.join('..', 'secrets'), path.join(refRoot, 'vendor'));
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    plan['reproduce'] = ['vendor/id_rsa', 'package-lock.json'];

    const problems = reproduceFiles(plan, refRoot, target);

    assert.equal(problems.length, 1, `expected one refusal, got ${JSON.stringify(problems)}`);
    assert.match(problems[0] ?? '', /refused — it leaves the reference repository through a symlink/);
    assert.equal(fs.existsSync(path.join(target, 'vendor', 'id_rsa')), false, 'a key was copied into the learner’s project');
    assert.ok(fs.existsSync(path.join(target, 'package-lock.json')));
  });

  // ── and now the other direction, which is what stops the fix being "refuse everything" ────

  test('an ordinary nested path under an ordinary target still writes — with the root named and without', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();

    const write = plannedWrite(planWrite(stepOf(plan, 'st-2-file-util'), 'automated', refRoot, target, plan, core));
    assert.equal(write.path, path.join(target, 'src', 'util.ts'), 'the path handed back is the plan’s, not a resolved rewrite of it');
    writeTextAtomic(write.path, write.content, target);
    assert.equal(fs.readFileSync(write.path, 'utf8'), write.content);

    const second = path.join(target, 'a', 'b', 'c', 'deep.ts');
    writeTextAtomic(second, 'export const D = 4;\n');
    assert.equal(fs.readFileSync(second, 'utf8'), 'export const D = 4;\n');
  });

  test('a symlinked TARGET is not the attack — a build in a folder that is itself a link still works', () => {
    // `/tmp` is a symlink on macOS and `os.tmpdir()` sits under one, so this is the ORDINARY
    // case on a whole platform, not an exotic one. Refusing it would be the fix breaking every
    // real build — which is the shape most containment regressions actually take.
    const refRoot = referenceTree();
    const sandbox = tmpDir('dial-writer-sandbox-');
    const real = path.join(sandbox, 'real-project');
    fs.mkdirSync(real);
    const target = path.join(sandbox, 'project');
    fs.symlinkSync(real, target);
    const plan = referencePlan();

    const write = plannedWrite(planWrite(stepOf(plan, 'st-2-file-util'), 'automated', refRoot, target, plan, core));
    writeTextAtomic(write.path, write.content, target);

    assert.equal(fs.readFileSync(path.join(real, 'src', 'util.ts'), 'utf8'), write.content,
      'the target being a symlink is not an escape from the target');
  });

  test('a symlink AT the destination is still replaced rather than refused, root or no root', () => {
    // The directory check must not swallow the final-component rule, which is rename(2)'s and
    // covers a different case: a planted `src/parse.ts -> ~/.bashrc` is REPLACED, its pointee
    // untouched. Refusing here instead would be a regression dressed as extra safety.
    const sandbox = tmpDir('dial-writer-sandbox-');
    const outside = path.join(sandbox, 'bashrc');
    fs.writeFileSync(outside, 'export PATH=$PATH\n');
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    const dest = path.join(target, 'parse.ts');
    fs.symlinkSync(outside, dest);

    writeTextAtomic(dest, 'export const E = 5;\n', target);

    assert.equal(fs.readFileSync(outside, 'utf8'), 'export PATH=$PATH\n');
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const E = 5;\n');
  });
});

// ── manual mode's panel content (AC2) ───────────────────────────────────────────────────────

suite('fileShape — enough to know what to write, never the answer (AC2)', () => {
  test('the signature line of each load-bearing range, in file order', () => {
    const refRoot = referenceTree();
    const shape = fileShape(refRoot, stepOf(referencePlan(), 'st-2-file-util'));
    assert.deepEqual(shape.signatures, [
      'export function tokenize(line: string): Token[] {',
      'export function render(tokens: Token[]): string {',
    ]);
  });

  test('the reference imports, with a multi-line one folded back into a single entry', () => {
    const refRoot = referenceTree();
    const shape = fileShape(refRoot, stepOf(referencePlan(), 'st-2-file-util'));
    assert.deepEqual(shape.imports, [
      "import { readFileSync } from 'node:fs';",
      "import { join, } from 'node:path';",
      "export { VERSION as version } from './version.js';",
    ]);
  });

  test('a `require` binding counts as an import, the way repo-tour\'s own extract counts it', () => {
    const refRoot = referenceTree();
    const shape = fileShape(refRoot, stepOf(referencePlan(), 'st-4-file-app'));
    assert.deepEqual(shape.imports, ["const { tokenize } = require('./util.js');"]);
    assert.deepEqual(shape.signatures, ['function shout(line) {']);
  });

  test('python: both import spellings, and neither body', () => {
    const refRoot = referenceTree();
    const shape = fileShape(refRoot, stepOf(referencePlan(), 'st-5-file-calc'));
    assert.deepEqual(shape.imports, ['import json', 'from typing import List']);
    assert.deepEqual(shape.signatures, [
      'def total(values: List[int]) -> int:',
      'def as_json(values: List[int]) -> str:',
    ]);
  });

  test('nothing in the shape is the answer', () => {
    const refRoot = referenceTree();
    const plan = referencePlan();
    for (const id of ['st-2-file-util', 'st-4-file-app', 'st-5-file-calc']) {
      const shape = fileShape(refRoot, stepOf(plan, id));
      const shown = [...shape.signatures, ...shape.imports].join('\n');
      for (const answer of ['raw.length > 0', 'toUpperCase', 'running += v', 'json.dumps']) {
        assert.ok(!shown.includes(answer), `${id}'s shape leaked "${answer}"`);
      }
    }
  });

  test('an unreadable reference is an empty shape, not a throw — the panel is on screen', () => {
    const refRoot = referenceTree();
    const missing = step({ id: 'st-x-missing', ordinal: 9, kind: 'file', target: { file: 'src/nowhere.ts' } });
    assert.deepEqual(fileShape(refRoot, missing), { signatures: [], imports: [] });
  });
});

/**
 * The shape is BOUNDED at the source, and says where it cut (T-5 security review, finding 6).
 *
 * Both lists are lifted verbatim off a file in a repository nobody here has read, and neither
 * has a natural bound: a minified bundle is one line and megabytes long, and `plan.json`
 * decides how many load-bearing ranges there are. `src/walk/step-view.ts` renders both lists at
 * the PROSE cap of 20,000 characters across up to 200 rows, so an unbounded shape is up to
 * eight megabytes of HTML to build, escape and push through a webview, for one manual step.
 *
 * Announced rather than silent, which is the same rule the option list and the check report
 * already follow. Silence would read as "that is the whole import list", and a learner
 * comparing the panel against the reference would go looking for their mistake in the wrong
 * place — the cap would have turned a security fix into a teaching bug.
 */
suite('fileShape — bounded at the source, and honest about where it cut (security finding 6)', () => {
  /** A reference holding one file, written to order. */
  function referenceWith(rel: string, source: string): string {
    const root = tmpDir('dial-writer-reference-');
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    return root;
  }

  test('a minified file’s single line is shortened, and says so', () => {
    // What repo-tour classifies as vendored and a plan can still name as a `file` step. The
    // signature line here is the whole bundle.
    const source = `export function f(){${'a'.repeat(200_000)}}\n`;
    const length = source.trimEnd().length;
    const refRoot = referenceWith('src/min.js', source);
    const minified = step({
      id: 'st-x-min',
      ordinal: 9,
      kind: 'file',
      target: { file: 'src/min.js' },
      scaffold: { loadBearing: [{ startLine: 1, endLine: 1 }], boilerplate: [] },
    });

    const shape = fileShape(refRoot, minified);

    assert.equal(shape.signatures.length, 1);
    const line = shape.signatures[0] ?? '';
    assert.ok(line.length < 500, `the panel was handed a ${line.length}-character "signature"`);
    assert.match(line, /shortened here/, 'a silent cut reads as the whole line');
    assert.ok(line.includes(`${length} characters`), 'the learner is told how much of it they are not seeing');
  });

  test('more ranges and more imports than the cap: capped, counted, and the count is right', () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(`import a${i} from './a${i}.js';`);
    const refRoot = referenceWith('src/many.ts', `${lines.join('\n')}\n`);
    const many = step({
      id: 'st-x-many',
      ordinal: 9,
      kind: 'file',
      target: { file: 'src/many.ts' },
      scaffold: {
        loadBearing: lines.map((_, i) => ({ startLine: i + 1, endLine: i + 1 })),
        boilerplate: [],
      },
    });

    const shape = fileShape(refRoot, many);

    for (const [name, list] of [['signatures', shape.signatures], ['imports', shape.imports]] as const) {
      assert.equal(list.length, 101, `${name} was not capped`);
      assert.match(list[100] ?? '', /… and 150 more, not shown/, `${name} cut silently`);
    }
    // Under `step-view.ts`'s own 200-row cap, so the announcement is not the row the panel
    // drops — a cap whose own notice gets truncated away is a silent cap with extra steps.
    assert.ok(shape.signatures.length < 200);
  });

  test('an ordinary file is not touched by either cap — the bound must not become a lie about small files', () => {
    const refRoot = referenceTree();
    const shape = fileShape(refRoot, stepOf(referencePlan(), 'st-2-file-util'));
    for (const line of [...shape.signatures, ...shape.imports]) {
      assert.ok(!line.includes('not shown') && !line.includes('shortened here'), `an ordinary line was announced as cut: ${line}`);
    }
    assert.deepEqual(shape.signatures, [
      'export function tokenize(line: string): Token[] {',
      'export function render(tokens: Token[]): string {',
    ]);
  });
});

// ── the files that are never taught (AC6) ───────────────────────────────────────────────────

suite('reproduceFiles — the generated, vendored and binary files (AC6)', () => {
  test('copies byte for byte, creating the directories on the way', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();

    assert.deepEqual(reproduceFiles(plan, refRoot, target), [], 'nothing should have gone wrong');
    for (const rel of ['package-lock.json', 'vendor/bundle.min.js', 'data/blob.bin']) {
      assert.ok(
        fs.readFileSync(path.join(target, rel)).equals(fs.readFileSync(path.join(refRoot, rel))),
        `${rel} did not arrive byte for byte`,
      );
    }
  });

  test('a real binary survives — bytes go in and out, never a string', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    reproduceFiles(referencePlan(), refRoot, target);
    // Decoding this as UTF-8 and re-encoding would turn 0xff 0xfe 0x80 into U+FFFD.
    assert.ok(fs.readFileSync(path.join(target, 'data', 'blob.bin')).equals(BLOB_BIN));
  });

  test('running it twice is idempotent, and leaves no scratch files behind', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    reproduceFiles(plan, refRoot, target);
    assert.deepEqual(reproduceFiles(plan, refRoot, target), []);
    assert.deepEqual(fs.readdirSync(path.join(target, 'vendor')), ['bundle.min.js']);
  });

  test('an entry that climbs out is refused and reported, and the ordinary entries beside it still land', () => {
    const refRoot = referenceTree();
    const sandbox = tmpDir('dial-writer-sandbox-');
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    const plan = referencePlan();
    plan['reproduce'] = ['../escape/pwned.txt', 'vendor/bundle.min.js', '/etc/passwd'];

    const problems = reproduceFiles(plan, refRoot, target);
    assert.equal(problems.length, 2, `expected two refusals, got ${JSON.stringify(problems)}`);
    for (const problem of problems) assert.match(problem, /refused — it points outside/);
    // Not vacuous: the contained entry in the middle really was copied.
    assert.ok(fs.readFileSync(path.join(target, 'vendor', 'bundle.min.js')).equals(fs.readFileSync(path.join(refRoot, 'vendor', 'bundle.min.js'))));
    assert.deepEqual(fs.readdirSync(sandbox), ['project'], 'something was written outside the target');
  });

  test('a missing source is reported, never thrown — one bad entry does not abandon the rest', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    plan['reproduce'] = ['vendor/gone.js', 'package-lock.json'];

    const problems = reproduceFiles(plan, refRoot, target);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /vendor\/gone\.js: could not be read from the reference/);
    assert.ok(fs.existsSync(path.join(target, 'package-lock.json')));
  });

  test('a reproduce list that is not a list of paths is not an error', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    plan['reproduce'] = ['package-lock.json', 42, '', '   ', null, { path: 'x' }];

    assert.deepEqual(reproduceEntries(plan), ['package-lock.json']);
    assert.deepEqual(reproduceFiles(plan, refRoot, target), []);
    assert.deepEqual(fs.readdirSync(target), ['package-lock.json']);
  });

  test('a plan with no reproduce key at all reproduces nothing, quietly', () => {
    const refRoot = referenceTree();
    const target = tmpDir('dial-writer-target-');
    const plan = referencePlan();
    delete plan['reproduce'];

    assert.deepEqual(reproduceEntries(plan), []);
    assert.deepEqual(reproduceFiles(plan, refRoot, target), []);
    assert.deepEqual(fs.readdirSync(target), []);
  });
});

// ── the write primitive ─────────────────────────────────────────────────────────────────────

suite('writeTextAtomic — durable, and unreachable by a pre-planted name', () => {
  test('the content lands, missing directories are created, and no temp file is left behind', () => {
    const target = tmpDir('dial-writer-target-');
    const dest = path.join(target, 'deep', 'nested', 'file.ts');
    writeTextAtomic(dest, 'export const A = 1;\n');

    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const A = 1;\n');
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['file.ts'], 'a scratch file was left in the learner\'s project');
  });

  test('writing twice replaces the file and still leaves one entry', () => {
    const target = tmpDir('dial-writer-target-');
    const dest = path.join(target, 'file.ts');
    writeTextAtomic(dest, 'first\n');
    writeTextAtomic(dest, 'second\n');

    assert.equal(fs.readFileSync(dest, 'utf8'), 'second\n');
    assert.deepEqual(fs.readdirSync(target), ['file.ts']);
  });

  test('a pre-planted `<file>.tmp` symlink is never written through — the temp name is not predictable', () => {
    const sandbox = tmpDir('dial-writer-sandbox-');
    const outside = path.join(sandbox, 'canary.txt');
    fs.writeFileSync(outside, 'do not touch\n');
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    const dest = path.join(target, 'parse.ts');
    // Exactly what a repository can commit: git recreates a symlink on clone, so this costs
    // an attacker nothing. A fixed `.tmp` suffix would truncate the canary on the learner's
    // first click (T-4 security review, finding 4).
    fs.symlinkSync(outside, `${dest}.tmp`);

    writeTextAtomic(dest, 'export const B = 2;\n');

    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not touch\n', 'the planted temp name was written through');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const B = 2;\n');
    assert.ok(fs.lstatSync(`${dest}.tmp`).isSymbolicLink(), 'the planted link should simply have been ignored');
  });

  test('a symlink AT the destination is replaced, not followed', () => {
    const sandbox = tmpDir('dial-writer-sandbox-');
    const outside = path.join(sandbox, 'bashrc');
    fs.writeFileSync(outside, 'export PATH=$PATH\n');
    const target = path.join(sandbox, 'project');
    fs.mkdirSync(target);
    const dest = path.join(target, 'parse.ts');
    fs.symlinkSync(outside, dest);

    writeTextAtomic(dest, 'export const C = 3;\n');

    // rename(2) replaces the link itself; writeFileSync would have followed it.
    assert.equal(fs.readFileSync(outside, 'utf8'), 'export PATH=$PATH\n', 'the write followed a symlink out of the folder');
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const C = 3;\n');
  });
});
