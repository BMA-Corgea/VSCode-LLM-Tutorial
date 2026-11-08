// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AC2 and AC-A2(a): the UNCHANGED dial can use a derived plan in all three positions, and walking
 * every step in automated mode produces an app that starts.
 *
 * The derivation is the real engine through the real `AskLedger`, the real cache and repo-tour's
 * real `extract`, with a scripted fake model (`derive-engine.test.ts`'s). The writes are
 * `src/dial/writer.ts`'s own `planWrite`, `fileShape` and `writeTextAtomic`, imported and called
 * exactly as the walk calls them. That is the point: a Mode A plan works through the one walk, not
 * a second code path. The run at the end is `node` on the code this suite canned. The live half of
 * AC-A2 (a real model's code, read before it is run) belongs to the session that finishes T-17.
 */

import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { fileShape, isRefusal, planWrite, writeTextAtomic } from '../../src/dial/writer.js';
import { derivePlan } from '../../src/derive/engine.js';
import { AskLedger } from '../../src/tutor/ask.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import { FIXTURE_IDEA, fixtureOutlineText, outlineWith, stepsOf } from './derive-fixtures.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

let realCore: TutorCore;
let dialCore: DialCore;

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = tutorCoreFor(loaded.loaded);
  dialCore = dialCoreFor(loaded.loaded);
});

const TALLY = 'export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
const MAIN = "import { total } from '../core/tally.mjs';\n\nconsole.log(`total: ${total([1, 2, 3])}`);\n";
/** The shape the live run's model actually wrote for an entry point: a `main()` nothing exports. */
const MAIN_WITH_A_FUNCTION = "import { total } from '../core/tally.mjs';\n\nasync function main() {\n  console.log(`total: ${total([1, 2, 3])}`);\n}\n\nmain();\n";

const made: string[] = [];
const ledgers: AskLedger[] = [];

teardown(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function derived(entryCode = MAIN, outline = fixtureOutlineText()) {
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '))!;
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    const text = input['task'] === 'outline'
      ? outline
      : JSON.stringify({ content: (input['node'] as Record<string, unknown>)['path'] === 'core/tally.mjs' ? TALLY : entryCode });
    return Promise.resolve({ text, inputTokens: 0, outputTokens: 0, usd: 0, metered: true });
  };
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error('a test in derive-smoke.test.ts reached the real model')),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
  };
  const target = tempDir('derive-smoke-target-');
  const out = await derivePlan({ idea: FIXTURE_IDEA }, {
    ledger, globalStorageRoot: tempDir('derive-smoke-gs-'), target, dialCore,
    settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run },
  });
  if (!out.ok) assert.fail(out.reason);
  return { ...out, target };
}

function runIt(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
      resolve({ code, stdout, stderr, missing: (err as { code?: unknown } | null)?.code === 'ENOENT' });
    });
  });
}

function nodeRun(entry: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runIt(process.execPath, [entry], cwd);
}

const PY_TALLY = 'def total(xs):\n    return sum(xs)\n';
const PY_MAIN = 'from core.tally import total\n\nprint(f"total: {total([1, 2, 3])}")\n';

/** The fixture idea as a Python plan, derived through the real engine, with `files` as its code. */
async function derivedPython(files: Record<string, string> = { 'core/tally.py': PY_TALLY, 'cli/main.py': PY_MAIN }, plannedExtra: string[] = []) {
  const outline = outlineWith((o) => {
    o['language'] = 'python';
    o['entry'] = 'cli/main.py';
    const steps = stepsOf(o);
    steps[1]!['path'] = 'core/tally.py';
    steps[3]!['path'] = 'cli/main.py';
    steps[3]!['dependsOn'] = ['cli', 'core/tally.py'];
    for (const p of plannedExtra) {
      const chapter = p.split('/')[0]!;
      steps.splice(steps.findIndex((st) => st['path'] === chapter) + 1, 0, { ...steps[1]!, chapter, path: p, question: `${p}?`, dependsOn: [chapter] });
    }
  });
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '))!;
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    const text = input['task'] === 'outline' ? outline : JSON.stringify({ content: files[(input['node'] as { path: string }).path] });
    return Promise.resolve({ text, inputTokens: 0, outputTokens: 0, usd: 0, metered: true });
  };
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error('a test in derive-smoke.test.ts reached the real model')),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed provider probe' }),
  };
  const target = tempDir('derive-smoke-target-');
  const out = await derivePlan({ idea: FIXTURE_IDEA }, {
    ledger, globalStorageRoot: tempDir('derive-smoke-gs-'), target, dialCore,
    settings: { core, provider: 'claude', model: 'claude-sonnet-5', timeoutMs: 5_000, run },
  });
  return { out, target };
}

suite('the one walk takes a derived plan as it stands (AC2, AC-A2 a)', () => {
  test('manual: fileShape reads the derived file\'s signature and imports, as it would a real repository\'s', async () => {
    const { plan, referenceRoot } = await derived();
    const tally = plan.steps.find((s) => s.target.file === 'core/tally.mjs')!;
    assert.deepEqual(fileShape(referenceRoot, tally), { signatures: ['export function total(xs) {'], imports: [] });
    const main = plan.steps.find((s) => s.target.file === 'cli/main.mjs')!;
    assert.deepEqual(fileShape(referenceRoot, main).imports, ["import { total } from '../core/tally.mjs';"]);
  });

  test('scaffolded: the load-bearing function is stubbed and the stub still parses', async () => {
    const { plan, referenceRoot, target } = await derived();
    const tally = plan.steps.find((s) => s.target.file === 'core/tally.mjs')!;
    const write = planWrite(tally, 'scaffolded', referenceRoot, target, plan, dialCore);
    assert.ok(write !== null && !isRefusal(write), write !== null && isRefusal(write) ? write.refused : 'expected a write');
    assert.ok(write.content.includes('export function total(xs)'), 'the signature is kept');
    assert.ok(!write.content.includes('reduce'), 'the body — the answer — is hidden');
    assert.match(write.content, /TODO/);
  });

  test('scaffolded: an entry point that exports nothing hides its main() rather than handing over the answer', async () => {
    const { plan, referenceRoot, target } = await derived(MAIN_WITH_A_FUNCTION);
    const entry = plan.steps.find((s) => s.target.file === 'cli/main.mjs')!;
    const write = planWrite(entry, 'scaffolded', referenceRoot, target, plan, dialCore);
    assert.ok(write !== null && !isRefusal(write), write !== null && isRefusal(write) ? write.refused : 'expected a write');
    assert.notEqual(write.content, fs.readFileSync(path.join(referenceRoot, 'cli/main.mjs'), 'utf8'), 'scaffolded must not equal automated on this step');
    assert.ok(write.content.includes('async function main()'), 'the signature is kept');
    assert.ok(!write.content.includes('total([1, 2, 3])'), 'the body — the answer — is hidden');
    assert.match(write.content, /TODO/);
    const stub = path.join(tempDir('derive-smoke-stub-'), 'main.mjs');
    fs.writeFileSync(stub, write.content);
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['--check', stub], { timeout: 10_000 }, (err, _out, stderr) => (err ? reject(new Error(`the stub does not parse: ${stderr}`)) : resolve()));
    });
  });

  test('scaffolded: a line break in a model\'s question cannot become code, and the stub still parses', async () => {
    const outline = outlineWith((o) => { stepsOf(o)[1]!['question'] = 'How is it kept?\nglobalThis.INJECTED = true;'; });
    const { plan, referenceRoot, target } = await derived(MAIN, outline);
    const tally = plan.steps.find((s) => s.target.file === 'core/tally.mjs')!;
    const write = planWrite(tally, 'scaffolded', referenceRoot, target, plan, dialCore);
    assert.ok(write !== null && !isRefusal(write), write !== null && isRefusal(write) ? write.refused : 'expected a write');
    assert.ok(!/^\s*globalThis\.INJECTED/m.test(write.content), `the second line must stay inside the comment:\n${write.content}`);
    const stub = path.join(tempDir('derive-smoke-stub-'), 'tally.mjs');
    fs.writeFileSync(stub, write.content);
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['--check', stub], { timeout: 10_000 }, (err, _out, stderr) => (err ? reject(new Error(`the stub does not parse: ${stderr}`)) : resolve()));
    });
  });

  test('automated: walking every file step writes the reference bytes, and the app STARTS', async () => {
    const { plan, referenceRoot, target, state } = await derived();
    for (const step of plan.steps.filter((s) => s.kind === 'file')) {
      const write = planWrite(step, 'automated', referenceRoot, target, plan, dialCore);
      assert.ok(write !== null && !isRefusal(write), `${step.target.file}: ${write !== null && isRefusal(write) ? write.refused : 'nothing to write'}`);
      writeTextAtomic(write.path, write.content, target);
      assert.equal(fs.readFileSync(path.join(target, step.target.file), 'utf8'), fs.readFileSync(path.join(referenceRoot, step.target.file), 'utf8'));
    }
    const ran = await nodeRun(state.entry, target);
    assert.equal(ran.code, 0, `node ${state.entry} exited ${String(ran.code)}: ${ran.stderr}`);
    assert.equal(ran.stdout, 'total: 6\n');
  });

  test('a Python plan builds and STARTS the way the prompt says: from the top folder, as a module', async function () {
    const { out, target } = await derivedPython();
    if (!out.ok) assert.fail(out.reason);
    for (const step of out.plan.steps.filter((s) => s.kind === 'file')) {
      const write = planWrite(step, 'automated', out.referenceRoot, target, out.plan, dialCore);
      assert.ok(write !== null && !isRefusal(write), `${step.target.file}: ${write !== null && isRefusal(write) ? write.refused : 'nothing to write'}`);
      writeTextAtomic(write.path, write.content, target);
    }
    const ran = await runIt('python3', ['-m', 'cli.main'], target);
    if (ran.missing === true) { this.skip(); return; }
    assert.equal(ran.code, 0, `python3 -m cli.main exited ${String(ran.code)}: ${ran.stderr}`);
    assert.equal(ran.stdout, 'total: 6\n');
  });

  test('scaffolded: a Python file\'s functions are stubbed and the stub still parses', async function () {
    const { out, target } = await derivedPython();
    if (!out.ok) assert.fail(out.reason);
    const tally = out.plan.steps.find((s) => s.target.file === 'core/tally.py')!;
    const write = planWrite(tally, 'scaffolded', out.referenceRoot, target, out.plan, dialCore);
    assert.ok(write !== null && !isRefusal(write), write !== null && isRefusal(write) ? write.refused : 'expected a write');
    assert.ok(write.content.includes('def total(xs):'), 'the signature is kept');
    assert.ok(!write.content.includes('sum(xs)'), 'the body is hidden');
    const stub = path.join(tempDir('derive-smoke-stub-'), 'tally.py');
    fs.writeFileSync(stub, write.content);
    const ran = await runIt('python3', ['-c', `import ast; ast.parse(open(${JSON.stringify(stub)}).read())`], target);
    if (ran.missing === true) { this.skip(); return; }
    assert.equal(ran.code, 0, `the Python stub does not parse: ${ran.stderr}`);
  });

  for (const [name, planned, main, pattern] of [
    ['a sibling imported by its bare name, which only works when the file is run directly', ['cli/helper.py'], 'from helper import add\n\nprint(add(1, 2))\n', /only works when this file is run directly/],
    ['importlib', [], 'import importlib\n\nm = importlib.import_module("core.tally")\nprint(m)\n', /computed import/],
    ['__import__', [], 'm = __import__("core.tally")\nprint(m)\n', /computed import/],
    ['an undeclared file of the app, by its full name', ['core/helper.py'], 'from core.helper import add\n\nprint(add(1, 2))\n', /a file it does not depend on/],
  ] as Array<[string, string[], string, RegExp]>) {
    test(`a Python entry point with ${name} is refused`, async () => {
      const helper = 'def add(a, b):\n    return a + b\n';
      const { out } = await derivedPython({ 'core/tally.py': PY_TALLY, 'cli/main.py': main, 'cli/helper.py': helper, 'core/helper.py': helper }, planned);
      assert.ok(!out.ok, 'expected the derivation to fail');
      assert.match(out.reason, pattern);
    });
  }
});
