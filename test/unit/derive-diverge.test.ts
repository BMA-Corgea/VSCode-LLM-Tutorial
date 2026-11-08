// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `divergePlan` (T-22): a different road in a real repository's walk re-derives what follows from
 * it, through the real `AskLedger`, the real cache and repo-tour's REAL `extract`, with a scripted
 * model and `core.runLlm` poisoned. The plan is Mode B-shaped: `symbol` steps, path chapter keys,
 * TypeScript, and a file's edges that are its imports only. No test spends a token.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { divergePlan, type DivergeDeps, type DivergeInput } from '../../src/derive/diverge.js';
import { AskLedger } from '../../src/tutor/ask.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import type { PlanLike, StepLike } from '../../src/walk/model.js';

let realCore: TutorCore;
let dialCore: DialCore;
const made: string[] = [];
const ledgers: AskLedger[] = [];

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = tutorCoreFor(loaded.loaded);
  dialCore = dialCoreFor(loaded.loaded);
});

teardown(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const options = (extra = 'alt-1') => [
  { id: 'author', label: 'What the author did', consequence: 'as written', taken: true },
  { id: extra, label: 'Another road', consequence: 'something else', taken: false },
];

function step(id: string, ordinal: number, chapter: string, kind: StepLike['kind'], file: string, dependsOn: string[] = [], oneOption = false, extra: Partial<StepLike> = {}): StepLike {
  return {
    id, ordinal, chapter, kind,
    decision: { question: `${id}?`, options: oneOption ? options().slice(0, 1) : options(), authorChoice: 'author', chosen: null, why: 'because', whySource: 'interpret' },
    target: { file, ...(kind === 'symbol' ? { startLine: 2, endLine: 3 } : {}) },
    scaffold: { loadBearing: [], boilerplate: [] },
    dependsOn,
    witness: { sha: null, date: null, subject: null },
    ...extra,
  };
}

function repoPlan(): PlanLike {
  return {
    schemaVersion: 1,
    source: { kind: 'repo', root: '/somewhere/small-app', head: null },
    mode: 'recreate',
    generatedAt: '2026-11-01T00:00:00.000Z',
    cost: { provider: 'claude', metered: true, calls: 1, cachedStops: 0, interpretedStops: 1, inputTokens: 0, outputTokens: 0, usd: 0, model: 'm', failures: [] },
    reproduce: [],
    chapters: [
      { key: 'src', title: 'src', subtitle: 's', tierPath: 'src' },
      { key: 'src/api', title: 'api', subtitle: 's', tierPath: 'src/api' },
      { key: 'src/view', title: 'view', subtitle: 's', tierPath: 'src/view' },
      { key: 'docs', title: 'docs', subtitle: 's', tierPath: 'docs' },
    ],
    steps: [
      step('s-src', 1, 'src', 'shape', 'src'),
      step('s-parse', 2, 'src', 'file', 'src/parse.ts'),
      step('s-store', 3, 'src', 'file', 'src/store.ts'),
      step('s-api', 4, 'src/api', 'shape', 'src/api'),
      step('s-routes', 5, 'src/api', 'file', 'src/api/routes.ts', ['s-parse']),
      step('s-handle', 6, 'src/api', 'symbol', 'src/api/routes.ts', ['s-routes']),
      step('s-status', 7, 'src/api', 'symbol', 'src/api/routes.ts', ['s-routes'], true),
      step('s-view', 8, 'src/view', 'shape', 'src/view'),
      step('s-render', 9, 'src/view', 'file', 'src/view/render.ts'),
      step('s-docs', 10, 'docs', 'shape', 'docs'),
    ],
  };
}

function repoOnDisk(): string {
  const root = tempDir('diverge-repo-');
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('src/parse.ts', "import lodash from 'lodash';\n\nexport function tokenize(line: string): string[] {\n  return lodash.split(line, ' ');\n}\n");
  write('src/store.ts', 'export const STORE = 1;\n');
  write('src/api/routes.ts', "import { tokenize } from '../parse';\n\nexport function handle(body: string): number {\n  return tokenize(body).length;\n}\n\nexport function status(): number {\n  return 200;\n}\n");
  write('src/view/render.ts', "export function render(): string {\n  return 'x';\n}\n");
  return root;
}

interface Asked { task: string; input: Record<string, unknown> }

function model(code: (file: string) => string = (file) => `export const from = ${JSON.stringify(file)};\n`, replan?: (input: Record<string, unknown>) => unknown) {
  const asked: Asked[] = [];
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '))!;
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    asked.push({ task: String(input['task']), input });
    let text: string;
    if (input['task'] === 'code') {
      text = JSON.stringify({ content: code((input['node'] as { path: string }).path) });
    } else {
      const decision = input['decision'] as { chosen: string };
      const replacing = input['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string; dependsOn: string[] }>;
      text = JSON.stringify(replan ? replan(input) : {
        steps: replacing.map((r) => ({ kind: r.kind, chapter: r.chapter, path: r.path, question: `${r.question} (following ${decision.chosen})`, options: r.options, recommended: r.chosen, why: r.why, dependsOn: r.dependsOn })),
      });
    }
    return Promise.resolve({ text, inputTokens: 10, outputTokens: 5, usd: 0.001, metered: true });
  };
  return { asked, run };
}

function depsFor(run: TutorCore['runLlm'], gs: string, target: string): DivergeDeps {
  const ledger = new AskLedger();
  ledgers.push(ledger);
  const core: TutorCore = {
    ...realCore,
    runLlm: () => Promise.reject(new Error('a test in derive-diverge.test.ts reached the real model')),
    availability: () => Promise.resolve({ ok: true, detail: 'stubbed' }),
  };
  return { ledger, globalStorageRoot: gs, target, dialCore, settings: { core, provider: 'claude', model: 'm', timeoutMs: 5_000, run }, now: () => new Date('2026-11-08T00:00:00.000Z') };
}

function input(plan: PlanLike, referenceRoot: string, stepId: string, answer = 'alt-1', walked: string[] = [], derivedRoot: string | null = null): DivergeInput {
  return { plan, referenceRoot, derivedRoot, stepId, answer, walked: new Set(walked) };
}

function setup() {
  return { plan: repoPlan(), root: repoOnDisk(), gs: tempDir('diverge-gs-'), target: tempDir('diverge-target-') };
}

const stepNamed = (plan: PlanLike, id: string): StepLike | undefined => plan.steps.find((s) => s.id === id);
/** A step as the walk sees it, minus its position. */
const content = (s: StepLike | undefined): string => JSON.stringify(s === undefined ? null : Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'ordinal')));

suite('divergePlan — a different road in a real repository (T-22)', () => {
  test('AC1: the steps downstream of the decision differ, and the steps independent of it do not', async () => {
    const { plan, root, gs, target } = setup();
    const m = model();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    for (const id of ['s-src', 's-store', 's-api', 's-view', 's-render', 's-docs']) assert.equal(content(stepNamed(out.plan, id)), content(stepNamed(plan, id)), `${id} is not downstream, so it does not change`);
    assert.equal(stepNamed(out.plan, 's-routes'), undefined, 'the file that imports the decision is re-derived');
    assert.equal(stepNamed(out.plan, 's-handle'), undefined, 'and its symbol steps go with it');
    assert.equal(stepNamed(out.plan, 's-status'), undefined);
    const fresh = out.plan.steps.find((s) => s.target.file === 'src/api/routes.ts')!;
    assert.match(fresh.decision.question, /\(following alt-1\)/);
    assert.equal(fresh.chapter, 'src/api', 'the alias came back as the real chapter');
    assert.ok(fresh.dependsOn.includes('s-parse'), 'the honesty rule: it depends on the decision');
    assert.equal(fresh.decision.whySource, 'interpret');
    assert.equal((fresh as unknown as { derivedFrom?: string }).derivedFrom, 's-parse');
  });

  test('the decision keeps its id and place, records the answer, and keeps the author\'s road as the author\'s', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const d = stepNamed(out.plan, 's-parse')!;
    assert.equal(d.decision.chosen, 'alt-1');
    assert.equal(d.decision.authorChoice, 'author');
    assert.deepEqual(d.decision.options.filter((o) => o.taken).map((o) => o.id), ['author']);
    assert.equal(d.ordinal, 2);
  });

  test('the derived tree holds only what was derived, and the walk\'s plan records the divergence', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(fs.readFileSync(path.join(out.derivedRoot, 'src/parse.ts'), 'utf8'), 'export const from = "src/parse.ts";\n');
    assert.ok(fs.existsSync(path.join(out.derivedRoot, 'src/api/routes.ts')));
    const newest = (out.plan as { divergences?: Array<{ tree: string }> }).divergences?.at(-1);
    assert.equal(fs.realpathSync(path.join(gs, 'derived', newest?.tree ?? 'nothing')), fs.realpathSync(out.derivedRoot), 'the plan names the tree its code is in');
    assert.ok(!fs.existsSync(path.join(out.derivedRoot, 'src/store.ts')), 'a kept file is read from the repository');
    const record = (out.plan as unknown as { divergences: Array<{ stepId: string; answer: string }> }).divergences;
    assert.deepEqual(record.map((r) => [r.stepId, r.answer]), [['s-parse', 'alt-1']]);
    assert.deepEqual(fs.readdirSync(target), [], 'the learner\'s folder is not touched');
  });

  test('M1: a walked step that stood on the old road is kept verbatim and named', async () => {
    const { plan, root, gs, target } = setup();
    const walked = ['s-src', 's-parse', 's-store', 's-api', 's-routes'];
    const out = await divergePlan(input(plan, root, 's-parse', 'alt-1', walked), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(content(stepNamed(out.plan, 's-routes')), content(stepNamed(plan, 's-routes')), 'a walked step is never re-derived');
    assert.deepEqual(out.staleDependents, ['s-routes']);
    assert.equal(fs.readFileSync(path.join(out.derivedRoot, 'src/parse.ts'), 'utf8'), 'export const from = "src/parse.ts";\n', 'and the decision\'s own code still follows the answer');
  });

  test('a decision at a symbol step re-derives its file: the step keeps its id and owns the file, and un-walked siblings go', async () => {
    const { plan, root, gs, target } = setup();
    const walked = ['s-src', 's-parse', 's-store', 's-api', 's-routes'];
    const m = model();
    const out = await divergePlan(input(plan, root, 's-handle', 'alt-1', walked), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const d = stepNamed(out.plan, 's-handle')!;
    assert.equal(d.kind, 'file');
    assert.deepEqual(d.target, { file: 'src/api/routes.ts' });
    assert.equal(d.decision.chosen, 'alt-1');
    assert.equal(stepNamed(out.plan, 's-status'), undefined, 'an un-walked sibling describes a file being rewritten');
    assert.deepEqual(out.staleDependents, ['s-routes'], 'the file\'s own walked step stood on the old road');
    assert.deepEqual(m.asked.map((a) => a.task), ['code'], 'nothing else follows from it, so only the file was asked for');
    assert.equal(content(stepNamed(out.plan, 's-routes')), content(stepNamed(plan, 's-routes')));
  });

  test('a decision about a chapter reaches its files, though the plan records only imports', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-api'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(stepNamed(out.plan, 's-routes'), undefined, 'the chapter\'s file is re-derived');
    assert.equal(content(stepNamed(out.plan, 's-render')), content(stepNamed(plan, 's-render')), 'another chapter\'s is not');
    assert.equal(content(stepNamed(out.plan, 's-parse')), content(stepNamed(plan, 's-parse')));
  });

  test('a file nothing depends on still re-derives its own code; a chapter with nothing in it changes nothing, and says so', async () => {
    const { plan, root, gs, target } = setup();
    const m = model();
    const own = await divergePlan(input(plan, root, 's-render'), depsFor(m.run, gs, target));
    if (!own.ok || !own.changed) assert.fail(own.ok ? 'nothing changed' : own.reason);
    assert.deepEqual(m.asked.map((a) => a.task), ['code']);
    const none = await divergePlan(input(plan, root, 's-docs'), depsFor(model().run, gs, target));
    assert.ok(none.ok && !none.changed, 'nothing follows and it owns no file');
  });

  test('the same choice again makes no call and gives the same plan', async () => {
    const { plan, root, gs, target } = setup();
    const m = model();
    const first = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!first.ok || !first.changed) assert.fail(first.ok ? 'nothing changed' : first.reason);
    const count = m.asked.length;
    const again = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!again.ok || !again.changed) assert.fail(again.ok ? 'nothing changed' : again.reason);
    assert.equal(m.asked.length, count, 'every answer came from the cache');
    assert.deepEqual(again.plan.steps, first.plan.steps);
  });

  test('a second divergence keeps what the first one wrote, and stacks on the record', async () => {
    const { plan, root, gs, target } = setup();
    const first = await divergePlan(input(plan, root, 's-parse'), depsFor(model().run, gs, target));
    if (!first.ok || !first.changed) assert.fail(first.ok ? 'nothing changed' : first.reason);
    const second = await divergePlan(input(first.plan, root, 's-render', 'alt-1', [], first.derivedRoot), depsFor(model().run, gs, target));
    if (!second.ok || !second.changed) assert.fail(second.ok ? 'nothing changed' : second.reason);
    assert.ok(fs.existsSync(path.join(second.derivedRoot, 'src/parse.ts')), 'the first divergence\'s file is still there');
    assert.ok(fs.existsSync(path.join(second.derivedRoot, 'src/view/render.ts')));
    assert.ok(fs.existsSync(path.join(first.derivedRoot, 'src/parse.ts')), 'and the first tree is untouched');
    assert.equal((second.plan as unknown as { divergences: unknown[] }).divergences.length, 2);
  });

  test('a package this repository does not use is refused, one it uses is allowed', async () => {
    const { plan, root, gs, target } = setup();
    const bad = model((file) => (file.endsWith('parse.ts') ? "import x from 'left-pad';\nexport const y = x;\n" : 'export {};\n'));
    const refused = await divergePlan(input(plan, root, 's-parse'), depsFor(bad.run, gs, target));
    assert.ok(!refused.ok, 'a new package would need installing');
    assert.match(refused.reason, /would need installing/);
    const good = model((file) => (file.endsWith('parse.ts') ? "import _ from 'lodash';\nexport const y = _;\n" : 'export {};\n'));
    const allowed = await divergePlan(input(plan, root, 's-parse'), depsFor(good.run, tempDir('diverge-gs-'), target));
    if (!allowed.ok) assert.fail(allowed.reason);
  });

  for (const [name, stepId, answer, pattern] of [
    ['an option the step does not have', 's-parse', 'nope', /not one of the options/],
    ['a step the plan does not have', 'ghost', 'alt-1', /not in this plan/],
  ] as Array<[string, string, string, RegExp]>) {
    test(`${name} is refused with nothing asked`, async () => {
      const { plan, root, gs, target } = setup();
      const m = model();
      const out = await divergePlan(input(plan, root, stepId, answer), depsFor(m.run, gs, target));
      assert.ok(!out.ok);
      assert.match(out.reason, pattern);
      assert.equal(m.asked.length, 0);
    });
  }

  test('a repository in a language the engine cannot read is refused in words', async () => {
    const { root, gs, target } = setup();
    const plan = repoPlan();
    plan.steps = plan.steps.map((s) => (s.kind === 'shape' ? s : { ...s, target: { file: s.target.file.replace('.ts', '.go') } }));
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(model().run, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /cannot re-derive/);
  });

  test('a decision that reaches more than one press can re-plan is refused in words, with nothing asked', async () => {
    const { root, gs, target } = setup();
    const plan = repoPlan();
    const many = Array.from({ length: 40 }, (_, i) => step(`s-many-${i}`, 20 + i, 'src/api', 'file', `src/api/m${i}.ts`, ['s-parse']));
    plan.steps = [...plan.steps, ...many];
    const m = model();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /more than the 30 one press can re-plan/);
    assert.equal(m.asked.length, 0);
  });

  test('a replanned step at the path of a step the plan keeps is refused, and not kept for next time', async () => {
    const { plan, root, gs, target } = setup();
    const clash = model(undefined, () => ({ steps: [{ kind: 'file', chapter: 'c1', path: 'src/store.ts', question: 'q?', options: options(), recommended: 'author', why: 'w', dependsOn: [] }] }));
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(clash.run, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /a step this plan keeps/);
    const good = model();
    const again = await divergePlan(input(plan, root, 's-parse'), depsFor(good.run, gs, target));
    if (!again.ok) assert.fail(`a good model was given no chance: ${again.reason}`);
    assert.ok(good.asked.some((a) => a.task === 'replan'), 'it was asked again');
  });

  test('a hostile path from the model is refused, by T-17\'s own rule', async () => {
    const { plan, root, gs, target } = setup();
    const hostile = model(undefined, () => ({ steps: [{ kind: 'file', chapter: 'c1', path: 'src/../../x.ts', question: 'q?', options: options(), recommended: 'author', why: 'w', dependsOn: [] }] }));
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(hostile.run, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /climbs out/);
  });

  test('the honesty rule: a re-derived step depends on the decision, and on what it was shown, even if the model forgets', async () => {
    const { plan, root, gs, target } = setup();
    const m = model(undefined, (replanInput) => ({
      steps: (replanInput['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string }>).map((r) => ({ kind: r.kind, chapter: r.chapter, path: r.path, question: r.question, options: r.options, recommended: r.chosen, why: r.why, dependsOn: [] })),
    }));
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const fresh = out.plan.steps.find((s) => s.target.file === 'src/api/routes.ts')!;
    assert.ok(fresh.dependsOn.includes('s-parse'), 'the decision it was derived from');
    assert.ok(fresh.dependsOn.includes('s-api'), 'the outside step it was shown');
  });

  test('a new step that depends on something no step provides is refused: the merged plan is checked', async () => {
    const { plan, root, gs, target } = setup();
    const dangling = model(undefined, () => ({ steps: [{ kind: 'file', chapter: 'c2', path: 'src/api/new.ts', question: 'q?', options: options(), recommended: 'author', why: 'w', dependsOn: ['src/ghost.ts'] }] }));
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(dangling.run, gs, target));
    assert.ok(!out.ok);
    assert.match(out.reason, /no step provides/);
  });
});
