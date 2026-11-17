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
import { emptyProgress, fileWriters, markDone, setCurrent, takenOverBy, walkedSteps, type PlanLike, type StepLike } from '../../src/walk/model.js';

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
/** The tree a press that re-derived something wrote: a re-plan always writes one. */
const treeOf = (out: { derivedRoot: string | null }): string => {
  assert.ok(out.derivedRoot !== null, 'a press that re-derived code wrote a tree');
  return out.derivedRoot;
};
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

  test('a step whose code was re-derived says so, and it keeps where it first came from (AC7)', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(stepNamed(out.plan, 's-parse')?.derivedFrom, 's-parse');

    const again = setup();
    stepNamed(again.plan, 's-render')!.derivedFrom = 'an-earlier-decision';
    const second = await divergePlan(input(again.plan, again.root, 's-render'), depsFor(model().run, again.gs, again.target));
    if (!second.ok || !second.changed) assert.fail(second.ok ? 'nothing changed' : second.reason);
    assert.equal(stepNamed(second.plan, 's-render')?.derivedFrom, 'an-earlier-decision', 'it never had an author to go back to');
  });

  test('a new step cannot claim to be what the author did, even when the model copies the words it was shown (AC7)', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const fresh = out.plan.steps.filter((s) => s.derivedFrom === 's-parse' && s.id !== 's-parse');
    assert.ok(fresh.some((s) => s.decision.options.length === 2), 'discriminates: the scripted reply echoes both options it was shown');
    for (const s of fresh) for (const o of s.decision.options) assert.doesNotMatch(o.label, /what the author did/i, s.id);
    assert.equal(stepNamed(out.plan, 's-parse')?.decision.options[0]?.label, 'What the author did', 'the step where the road changed keeps its author\'s row');
  });

  test('a shape decision has no code of its own, so it is not marked as if it did', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-api'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(stepNamed(out.plan, 's-api')?.derivedFrom, undefined);
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
    assert.equal(fs.readFileSync(path.join(treeOf(out), 'src/parse.ts'), 'utf8'), 'export const from = "src/parse.ts";\n');
    assert.ok(fs.existsSync(path.join(treeOf(out), 'src/api/routes.ts')));
    const newest = (out.plan as { divergences?: Array<{ tree: string }> }).divergences?.at(-1);
    assert.equal(fs.realpathSync(path.join(gs, 'derived', newest?.tree ?? 'nothing')), fs.realpathSync(treeOf(out)), 'the plan names the tree its code is in');
    assert.ok(!fs.existsSync(path.join(treeOf(out), 'src/store.ts')), 'a kept file is read from the repository');
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
    assert.equal(fs.readFileSync(path.join(treeOf(out), 'src/parse.ts'), 'utf8'), 'export const from = "src/parse.ts";\n', 'and the decision\'s own code still follows the answer');
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
    assert.ok(fs.existsSync(path.join(treeOf(second), 'src/parse.ts')), 'the first divergence\'s file is still there');
    assert.ok(fs.existsSync(path.join(treeOf(second), 'src/view/render.ts')));
    assert.ok(fs.existsSync(path.join(treeOf(first), 'src/parse.ts')), 'and the first tree is untouched');
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

  // T-22's live run (AC12): asked to write "Scan the ranges one by one" with the plan's reason for
  // the author's binary search beside it, the real model wrote the binary search.
  test('the road the learner chose is not argued for with the reason for the author\'s road (AC1, the live run)', async () => {
    const { plan, root, gs, target } = setup();
    const AUTHORS_REASON = 'The author wanted a tokenizer of its own, so it could be tested alone.';
    stepNamed(plan, 's-parse')!.decision.why = AUTHORS_REASON;
    const m = model();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const code = m.asked.find((a) => a.task === 'code' && (a.input['node'] as { path: string }).path === 'src/parse.ts');
    assert.ok(code, 'discriminates: the decision\'s own code was asked for');
    const node = code.input['node'] as { chosen: { label: string }; why: string };
    assert.equal(node.chosen.label, 'Another road', 'the code is asked for on the learner\'s road');
    assert.ok(!node.why.includes(AUTHORS_REASON), `and not with the reason for the author's road beside it: ${JSON.stringify(node.why)}`);
    const replan = m.asked.find((a) => a.task === 'replan');
    assert.ok(replan, 'discriminates: the steps that follow were re-planned');
    const decision = replan.input['decision'] as { chosen: string; why: string };
    assert.equal(decision.chosen, 'alt-1');
    assert.ok(!decision.why.includes(AUTHORS_REASON), `nor is the re-plan told that reason for the learner's road: ${JSON.stringify(decision.why)}`);
    const replacing = replan.input['replacing'] as Array<{ path: string; why: string }>;
    assert.equal(replacing.find((r) => r.path === 'src/api/routes.ts')?.why, 'because', 'a step on the road its reason was written for keeps that reason');
  });

  test('the files written after the press are told the road the decision takes now, not the one it had', async () => {
    const { plan, root, gs, target } = setup();
    const m = model();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const routes = m.asked.find((a) => a.task === 'code' && (a.input['node'] as { path: string }).path === 'src/api/routes.ts');
    assert.ok(routes, 'discriminates: the file that follows was written');
    const parse = (routes.input['dependencies'] as Array<{ path: string; chosen: { label: string } }>).find((dep) => dep.path === 'src/parse.ts');
    assert.equal(parse?.chosen.label, 'Another road', `the decision it stands on is on the learner's road; it was shown ${JSON.stringify(parse)}`);

    const again = setup();
    const atShape = model();
    const shaped = await divergePlan(input(again.plan, again.root, 's-api'), depsFor(atShape.run, again.gs, again.target));
    if (!shaped.ok || !shaped.changed) assert.fail(shaped.ok ? 'nothing changed' : shaped.reason);
    const inChapter = atShape.asked.find((a) => a.task === 'code' && (a.input['node'] as { path: string }).path.startsWith('src/api/'));
    assert.ok(inChapter, 'discriminates: a file in the chapter was written');
    assert.equal((inChapter.input['chapter'] as { chosen: { label: string } }).chosen.label, 'Another road', 'and a chapter decided differently is described on its new road');
  });

  test('a new step that imports a kept file stands on that file\'s step, not on one of its symbol steps', async () => {
    const { plan, root, gs, target } = setup();
    plan.steps.push(step('s-app', 11, 'src', 'file', 'src/app.ts', ['s-routes', 's-store']));
    fs.writeFileSync(path.join(root, 'src/app.ts'), "import { handle } from './api/routes';\nimport { STORE } from './store';\n\nexport const app = (): number => handle('x') + STORE;\n");
    const out = await divergePlan(input(plan, root, 's-store'), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const fresh = out.plan.steps.find((s) => s.target.file === 'src/app.ts' && s.id !== 's-app');
    assert.ok(fresh, 'discriminates: the file that imports the decision was re-derived');
    assert.ok(fresh.dependsOn.includes('s-routes'), `it depends on routes.ts's own step; it names ${JSON.stringify(fresh.dependsOn)}`);
    assert.ok(!fresh.dependsOn.some((id) => id === 's-handle' || id === 's-status'), `and on none of that file's symbol steps: ${JSON.stringify(fresh.dependsOn)}`);
    assert.ok(fresh.dependsOn.includes('s-store'), 'and on the decision');
  });

  // T-22's code review, MF2: repo-tour breaks an import cycle at the file with the fewest unmet
  // imports, so a file can be listed before a file it imports. Plan order is then not a topological order.
  test('an import cycle: a file listed before the file it imports is still reached, and nothing is left depending on a removed step', async () => {
    const root = tempDir('diverge-cycle-');
    for (const [rel, text] of Object.entries({ 'src/d.ts': 'export const D = 1;\n', 'src/a.ts': "import { B } from './b';\nexport const A = (): number => B;\n", 'src/b.ts': "import { D } from './d';\nimport { A } from './a';\nexport const B = D + A();\n" })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const cycle = (): PlanLike => ({ ...repoPlan(), chapters: [{ key: 'src', title: 'src', subtitle: 's', tierPath: 'src' }], steps: [
      step('s-src', 1, 'src', 'shape', 'src'), step('s-d', 2, 'src', 'file', 'src/d.ts'),
      step('s-a', 3, 'src', 'file', 'src/a.ts', ['s-b']), step('s-b', 4, 'src', 'file', 'src/b.ts', ['s-d', 's-a']),
    ] });
    const out = await divergePlan(input(cycle(), root, 's-d', 'alt-1', ['s-src']), depsFor(model().run, tempDir('diverge-gs-'), tempDir('diverge-target-')));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const ids = new Set(out.plan.steps.map((s) => s.id));
    assert.deepEqual(out.plan.steps.flatMap((s) => s.dependsOn.filter((dep) => !ids.has(dep)).map((dep) => `${s.id} -> ${dep}`)), [], 'no step depends on one the re-plan removed');
    assert.equal(stepNamed(out.plan, 's-a'), undefined, 'a.ts imports b.ts, which imports the decision: it is re-derived too');

    const walkedA = await divergePlan(input(cycle(), root, 's-d', 'alt-1', ['s-src', 's-a']), depsFor(model().run, tempDir('diverge-gs-'), tempDir('diverge-target-')));
    if (!walkedA.ok || !walkedA.changed) assert.fail(walkedA.ok ? 'nothing changed' : walkedA.reason);
    assert.ok(walkedA.staleDependents.includes('s-a'), `walked, a.ts stood on the old road and is named: ${JSON.stringify(walkedA.staleDependents)}`);
  });

  // The re-review of the fixes, R6: MF2's property for a cycle that runs THROUGH the decision. D is never replaced, so
  // its edges were copied as they were, and it went on standing on the step of the file that imports it, now gone.
  test('an import cycle through the decision: D is left standing on nothing the re-plan removed', async () => {
    const root = tempDir('diverge-cycle-d-');
    for (const [rel, text] of Object.entries({ 'src/api.ts': "import { Z } from './zed';\nexport const API = (): number => Z;\n", 'src/zed.ts': "import { API } from './api';\nexport const Z = 1;\nexport const twice = (): number => API() * 2;\n" })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const plan: PlanLike = { ...repoPlan(), chapters: [{ key: 'src', title: 'src', subtitle: 's', tierPath: 'src' }], steps: [
      step('s-src', 1, 'src', 'shape', 'src'), step('s-api', 2, 'src', 'file', 'src/api.ts', ['s-zed']), step('s-zed', 3, 'src', 'file', 'src/zed.ts', ['s-api']),
    ] };
    const out = await divergePlan(input(plan, root, 's-api', 'alt-1', ['s-src']), depsFor(model().run, tempDir('diverge-gs-'), tempDir('diverge-target-')));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(stepNamed(out.plan, 's-zed'), undefined, 'discriminates: zed.ts imports the decision, so it was replaced');
    const ids = new Set(out.plan.steps.map((s) => s.id));
    assert.deepEqual(out.plan.steps.flatMap((s) => s.dependsOn.filter((dep) => !ids.has(dep)).map((dep) => `${s.id} -> ${dep}`)), [], 'no step depends on one the re-plan removed');
  });

  // T-22's code review, SF2: the file is the unit, so a symbol step goes only with a file being rewritten.
  test('a kept file keeps its symbol steps: a decision upstream of a walked file does not delete its un-walked symbols', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-parse', 'alt-1', ['s-src', 's-parse', 's-store', 's-api', 's-routes']), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(content(stepNamed(out.plan, 's-routes')), content(stepNamed(plan, 's-routes')), 'discriminates: routes.ts is walked and kept verbatim');
    for (const id of ['s-handle', 's-status']) assert.equal(content(stepNamed(out.plan, id)), content(stepNamed(plan, id)), `${id} still describes the kept routes.ts, so it stays`);
  });

  // T-22's code review, MF3: at a symbol step D owns its file. Its file's own step, if nothing walked stands on it, goes with the file.
  test('a symbol press whose file step is not walked leaves one file step for that file: D, standing where the file step stood', async () => {
    const { plan, root, gs, target } = setup();
    const out = await divergePlan(input(plan, root, 's-handle', 'alt-1', ['s-src', 's-parse', 's-store', 's-api']), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const onRoutes = out.plan.steps.filter((s) => s.target.file === 'src/api/routes.ts' && s.kind === 'file');
    assert.deepEqual(onRoutes.map((s) => s.id), ['s-handle'], `one file step for routes.ts, and it is D: ${JSON.stringify(onRoutes.map((s) => s.id))}`);
    assert.deepEqual(stepNamed(out.plan, 's-handle')?.dependsOn, ['s-parse'], 'D stands on what routes.ts\'s step stood on');
    const ids = new Set(out.plan.steps.map((s) => s.id));
    assert.deepEqual(out.plan.steps.flatMap((s) => s.dependsOn.filter((dep) => !ids.has(dep))), [], 'and nothing is left depending on the step that went');
  });

  // The re-review of the fixes, R3 (must-fix), with R1, ruled 2026-11-11: one writer per file. A press on a symbol step is
  // made from that step's page, and its file's own step comes first in plan order, so the walk counts it as walked and it
  // stays. D writes the file from the press on; the file step, kept exactly as the learner left it, has been taken over,
  // and writes, outlines and checks nothing for the file any more. Each walked set below is the walk's own (`walkedSteps`).
  const walkedAt = (plan: PlanLike, id: string, done: string[] = []): string[] => {
    let progress = setCurrent(emptyProgress(plan), id);
    for (const d of done) progress = markDone(progress, d);
    return [...walkedSteps(plan, progress)];
  };
  const symbolPress = async (plan = repoPlan(), done: string[] = []) => {
    const { root, gs, target } = setup();
    const walked = walkedAt(plan, 's-handle', done);
    const first = await divergePlan(input(plan, root, 's-handle', 'alt-1', walked), depsFor(model().run, gs, target));
    if (!first.ok || !first.changed) assert.fail(first.ok ? 'nothing changed' : first.reason);
    return { plan, root, gs, target, walked, first };
  };

  test('after a symbol press from the walk, D writes its file: the walked file step is kept as it was, taken over, and D stands on what it stood on', async () => {
    const { plan, walked, first } = await symbolPress();
    assert.ok(walked.includes('s-routes'), 'discriminates: the walk counts the file step as walked when D is pressed');
    assert.equal(content(stepNamed(first.plan, 's-routes')), content(stepNamed(plan, 's-routes')), 'the walked file step is kept exactly');
    assert.equal(fileWriters(first.plan).get('src/api/routes.ts')?.id, 's-handle', 'D writes routes.ts');
    assert.equal(takenOverBy(first.plan, stepNamed(first.plan, 's-routes')!)?.id, 's-handle', 'it has taken the file over from the file step');
    assert.deepEqual(stepNamed(first.plan, 's-handle')?.dependsOn, ['s-parse'], 'D stands on what routes.ts\'s step stood on, not on the step it took over');
  });

  test('a press at a step whose file another step writes now is refused in words, with nothing asked', async () => {
    const { root, gs, target, first } = await symbolPress();
    const m = model();
    const out = await divergePlan(input(first.plan, root, 's-routes', 'alt-1', walkedAt(first.plan, 's-routes'), treeOf(first)), depsFor(m.run, gs, target));
    assert.ok(!out.ok, 'refused');
    assert.match(out.reason, /step 6 \(src\/api\/routes\.ts\)/, 'it names the step that writes the file now');
    assert.equal(m.asked.length, 0, 'before anything is asked or billed');
  });

  test('after a symbol press, a press upstream asks about the file once, through the step that writes it, and lands with one step for the file', async () => {
    const { root, gs, target, first } = await symbolPress();
    const m = model();
    const out = await divergePlan(input(first.plan, root, 's-parse', 'alt-1', walkedAt(first.plan, 's-parse'), treeOf(first)), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    const replacing = ((m.asked.find((a) => a.task === 'replan')?.input['replacing'] as Array<{ path: string }> | undefined) ?? []).map((r) => r.path);
    assert.deepEqual(replacing.filter((p) => p === 'src/api/routes.ts'), ['src/api/routes.ts'], `routes.ts is asked about once: ${JSON.stringify(replacing)}`);
    const onRoutes = out.plan.steps.filter((s) => s.target.file === 'src/api/routes.ts');
    assert.deepEqual(onRoutes.map((s) => `${s.kind}:${s.derivedFrom ?? 'the author'}`), ['file:s-parse'], 'one step for routes.ts, the new one: the file step and D, neither walked, went with their file');
  });

  test('after a symbol press, with the file step walked, a press upstream lands: the file step stays as it was, taken over by the new step', async () => {
    const { root, gs, target, first } = await symbolPress();
    const out = await divergePlan(input(first.plan, root, 's-parse', 'alt-1', walkedAt(first.plan, 's-parse', ['s-routes']), treeOf(first)), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(content(stepNamed(out.plan, 's-routes')), content(stepNamed(first.plan, 's-routes')), 'walked, it is kept exactly');
    const writer = fileWriters(out.plan).get('src/api/routes.ts');
    assert.equal(writer?.derivedFrom, 's-parse', 'the new routes.ts step writes the file');
    assert.equal(takenOverBy(out.plan, stepNamed(out.plan, 's-routes')!)?.id, writer?.id, 'and the walked file step is taken over by it');
    assert.equal(stepNamed(out.plan, 's-handle'), undefined, 'D, not walked, went with its file');
    assert.equal(out.plan.steps.filter((s) => s.target.file === 'src/api/routes.ts' && s.derivedFrom !== undefined).length, 1, 'one re-derived step for the file');
  });

  test('a second press at D names a walked step that imports its file: that step stood on the file D writes now', async () => {
    const plan = repoPlan();
    plan.steps = plan.steps.map((s) => (s.id === 's-render' ? { ...s, dependsOn: ['s-routes'] } : s));
    const { root, gs, target, first } = await symbolPress(plan, ['s-render']);
    assert.ok(first.staleDependents.includes('s-render'), 'discriminates: the first press names it');
    const second = await divergePlan(input(first.plan, root, 's-handle', 'author', walkedAt(first.plan, 's-handle', ['s-render']), treeOf(first)), depsFor(model().run, gs, target));
    if (!second.ok || !second.changed) assert.fail(second.ok ? 'nothing changed' : second.reason);
    assert.deepEqual(second.staleDependents, ['s-render'], 'render.ts imports routes.ts, and D writes routes.ts now');
  });

  test('a walked symbol step of a file another step writes now anchors nothing of it: a press upstream still rewrites the file', async () => {
    const plan = repoPlan();
    plan.steps = plan.steps.map((s) => (s.id === 's-status' ? { ...s, decision: { ...s.decision, options: options() } } : s));
    const { root, gs, target } = setup();
    // At s-status, s-handle comes first in plan order: walked, it is kept and taken over with the file step.
    const first = await divergePlan(input(plan, root, 's-status', 'alt-1', walkedAt(plan, 's-status')), depsFor(model().run, gs, target));
    if (!first.ok || !first.changed) assert.fail(first.ok ? 'nothing changed' : first.reason);
    assert.equal(takenOverBy(first.plan, stepNamed(first.plan, 's-handle')!)?.id, 's-status', 'discriminates: the walked symbol step was taken over');
    const out = await divergePlan(input(first.plan, root, 's-parse', 'alt-1', walkedAt(first.plan, 's-parse', ['s-handle']), treeOf(first)), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(fileWriters(out.plan).get('src/api/routes.ts')?.derivedFrom, 's-parse', 'routes.ts was rewritten: the walked symbol step stood on the author\'s file, not on the code that replaced it');
    assert.equal(content(stepNamed(out.plan, 's-handle')), content(stepNamed(first.plan, 's-handle')), 'and, walked, it is kept as it was');
  });

  test('D never stands on a step at its own file, even in a plan that had it standing on the file step it took over', async () => {
    const { root, gs, target, first } = await symbolPress();
    const old = { ...first.plan, steps: first.plan.steps.map((s) => (s.id === 's-handle' ? { ...s, dependsOn: ['s-routes'] } : s)) };
    const out = await divergePlan(input(old, root, 's-handle', 'author', walkedAt(old, 's-handle'), treeOf(first)), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.deepEqual(stepNamed(out.plan, 's-handle')?.dependsOn, [], `D stands on no step at routes.ts: ${JSON.stringify(stepNamed(out.plan, 's-handle')?.dependsOn)}`);
  });

  // The stopped re-review's NF3: a step downstream of D that a walked step stands on is kept, on the old road, and it was
  // named nowhere: the landing said "No later step needed re-planning".
  test('a step kept on the old road only because a walked step stands on it is recorded beside the walked ones', async () => {
    const { root, gs, target } = setup();
    const plan = repoPlan();
    plan.steps = plan.steps.map((s) => (s.id === 's-render' ? { ...s, dependsOn: ['s-routes'] } : s));
    const out = await divergePlan(input(plan, root, 's-parse', 'alt-1', walkedAt(plan, 's-parse', ['s-render'])), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.equal(content(stepNamed(out.plan, 's-routes')), content(stepNamed(plan, 's-routes')), 'discriminates: routes.ts is kept, because render.ts, walked, stands on it');
    assert.deepEqual(out.staleDependents, ['s-render']);
    assert.deepEqual((out as { keptOnOldRoad?: string[] }).keptOnOldRoad, ['s-routes'], 'kept and not walked: named, and its symbol steps are not named apart from their file');
    const record = (out.plan['divergences'] as Array<{ keptOnOldRoad?: string[] }>).at(-1);
    assert.deepEqual(record?.keptOnOldRoad, ['s-routes'], 'and the version records it');
  });

  test('a chapter decision whose only follower is kept for a walked step is recorded, never "nothing follows" (NF3)', async () => {
    const root = tempDir('diverge-kept-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const A = 1;\n');
    // A chapter step that stands on a file in its own chapter, walked: that file is downstream of it, and anchored by it.
    const plan: PlanLike = { ...repoPlan(), chapters: [{ key: 'src', title: 'src', subtitle: 's', tierPath: 'src' }], steps: [
      step('s-c', 1, 'src', 'shape', 'src', ['s-a']), step('s-a', 2, 'src', 'file', 'src/a.ts'),
    ] };
    const m = model();
    const out = await divergePlan(input(plan, root, 's-c', 'alt-1', ['s-c']), depsFor(m.run, tempDir('diverge-gs-'), tempDir('diverge-target-')));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'reported "nothing follows", and a.ts stood on this chapter' : out.reason);
    assert.deepEqual(out.staleDependents, [], 'discriminates: no walked step stood on the old road');
    assert.deepEqual(out.keptOnOldRoad, ['s-a']);
    assert.equal(m.asked.length, 0, 'nothing to re-derive, so nothing is asked');
    const record = (out.plan['divergences'] as Array<{ keptOnOldRoad?: string[]; replanned?: boolean }>).at(-1);
    assert.deepEqual(record && { keptOnOldRoad: record.keptOnOldRoad, replanned: record.replanned }, { keptOnOldRoad: ['s-a'], replanned: false });
  });

  // T-22's code review, MF1: "nothing follows" is about what is downstream, not about what is left to re-derive.
  // The stopped re-review's NF4 and NF5: the walk has to know which steps a press replaced and which it wrote,
  // and an id in the new plan does not say so, because a step's id is a hash of its kind, path, question and labels.
  test('the outcome names the steps the press replaced and the ones it wrote, D in neither; a step written again under its old id is in both', async () => {
    const { plan, root, gs, target } = setup();
    const keepsItsWords = (input: Record<string, unknown>): unknown => ({
      steps: (input['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string; dependsOn: string[] }>)
        .map((r) => ({ kind: r.kind, chapter: r.chapter, path: r.path, question: r.question, options: [{ id: 'one', label: 'One way', consequence: 'c1' }, { id: 'two', label: 'Another way', consequence: 'c2' }], recommended: 'one', why: r.why, dependsOn: r.dependsOn })),
    });
    const first = await divergePlan(input(plan, root, 's-parse'), depsFor(model(undefined, keepsItsWords).run, gs, target));
    if (!first.ok || !first.changed) assert.fail(first.ok ? 'nothing changed' : first.reason);
    const before = new Set(plan.steps.map((s) => s.id));
    const after = new Set(first.plan.steps.map((s) => s.id));
    assert.deepEqual([...first.replaced].sort(), plan.steps.filter((s) => !after.has(s.id)).map((s) => s.id).sort(), 'replaced: exactly the steps the plan lost');
    assert.deepEqual([...first.written].sort(), first.plan.steps.filter((s) => !before.has(s.id)).map((s) => s.id).sort(), 'written: exactly the steps it gained');
    assert.ok(!first.replaced.includes('s-parse') && !first.written.includes('s-parse'), 'D is in neither: it keeps its id, and its own code is counted apart');

    const routes = first.plan.steps.find((s) => s.target.file === 'src/api/routes.ts' && s.kind === 'file')!;
    const second = await divergePlan(input(first.plan, root, 's-parse', 'author', [], treeOf(first)), depsFor(model(undefined, keepsItsWords).run, gs, target));
    if (!second.ok || !second.changed) assert.fail(second.ok ? 'nothing changed' : second.reason);
    assert.ok(second.plan.steps.some((s) => s.id === routes.id), 'discriminates: the model kept the words, so the step came back under its old id');
    assert.ok(second.replaced.includes(routes.id), 'its code is gone, so it was replaced');
    assert.ok(second.written.includes(routes.id), 'and the step under that id is one this press wrote');
  });

  // The re-review of the review fixes, R10 (must-fix): a new file was never shown a new file it stands on, because
  // the map of new files was keyed by path and looked up by step id. Its code then dropped the import the plan
  // records, or imported it anyway and was refused, and billed again, on every press.
  for (const order of ['in the order they stand', 'in the opposite order'] as const) {
    test(`a new file that stands on another new file is shown it, with its new code, and may import it (${order})`, async () => {
      const { root, gs, target } = setup();
      const plan = repoPlan();
      plan.steps = plan.steps.map((s) => (s.id === 's-render' ? { ...s, dependsOn: ['s-routes'] } : s));
      const asked: Asked[] = [];
      const run: TutorCore['runLlm'] = (prompt) => {
        const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '))!;
        const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
        asked.push({ task: String(input['task']), input });
        if (input['task'] === 'code') {
          const file = (input['node'] as { path: string }).path;
          const content = file === 'src/view/render.ts'
            ? "import { handle } from '../api/routes';\n\nexport function render(): string {\n  return String(handle('x'));\n}\n"
            : file === 'src/api/routes.ts' ? 'export function handle(body: string): number {\n  return body.length;\n}\n' : `export const from = ${JSON.stringify(file)};\n`;
          return Promise.resolve({ text: JSON.stringify({ content }), inputTokens: 1, outputTokens: 1, usd: 0, metered: true });
        }
        const replacing = (input['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string }>).filter((r) => r.kind === 'file');
        const nodes = replacing.map((r) => ({ kind: r.kind, chapter: r.chapter, path: r.path, question: `${r.question} (new)`, options: r.options, recommended: r.chosen, why: r.why, dependsOn: r.path === 'src/view/render.ts' ? ['src/api/routes.ts'] : [] }));
        const steps = order === 'in the order they stand' ? nodes : [...nodes].reverse();
        return Promise.resolve({ text: JSON.stringify({ steps }), inputTokens: 1, outputTokens: 1, usd: 0, metered: true });
      };
      const out = await divergePlan(input(plan, root, 's-parse', 'alt-1', ['s-src']), depsFor(run, gs, target));
      const renderAsked = asked.find((a) => a.task === 'code' && (a.input['node'] as { path: string }).path === 'src/view/render.ts');
      const shown = ((renderAsked?.input['dependencies'] as Array<{ path: string; content?: string }> | undefined) ?? []);
      assert.ok(out.ok, `a new file may import the new file it stands on; refused: ${out.ok ? '' : out.reason}`);
      assert.ok(shown.some((s) => s.path === 'src/api/routes.ts' && (s.content ?? '').includes('export function handle')),
        `render.ts's code question is shown the new routes.ts with its new code: ${JSON.stringify(shown.map((s) => `${s.path} (${(s.content ?? '').length} chars)`))}`);
    });
  }

  test('a chapter decision whose every dependent is walked lands a record naming them, and asks the model nothing', async () => {
    const { plan, root, gs, target } = setup();
    const m = model();
    const walked = plan.steps.filter((s) => s.id !== 's-view' && s.id !== 's-docs').map((s) => s.id);
    const out = await divergePlan(input(plan, root, 's-view', 'alt-1', walked), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing landed, and render.ts stood on this chapter' : out.reason);
    assert.deepEqual(out.staleDependents, ['s-render']);
    assert.equal(m.asked.length, 0, 'there is nothing to re-derive, so nothing is asked');
    assert.equal(stepNamed(out.plan, 's-view')?.decision.chosen, 'alt-1', 'the choice is recorded on the plan');
    const record = (out.plan['divergences'] as Array<{ stepId: string; staleDependents: string[]; replanned?: boolean }>).at(-1);
    assert.deepEqual(record && { stepId: record.stepId, staleDependents: record.staleDependents, replanned: record.replanned }, { stepId: 's-view', staleDependents: ['s-render'], replanned: false });
    for (const s of plan.steps.filter((x) => x.id !== 's-view')) assert.equal(content(stepNamed(out.plan, s.id)), content(s), `${s.id} is kept`);

    const nothing = await divergePlan(input(repoPlan(), root, 's-docs', 'alt-1', walked), depsFor(model().run, gs, target));
    assert.ok(nothing.ok && !nothing.changed, 'a chapter nothing stands on still changes nothing');
  });

  // T-22's code review, SF8: each file keeps its own language; a NEW file takes the decision's.
  test('a TypeScript decision whose reach holds a JavaScript file re-plans it as JavaScript, and a new JavaScript file is refused', async () => {
    const { root, gs, target } = setup();
    fs.renameSync(path.join(root, 'src/api/routes.ts'), path.join(root, 'src/api/routes.js'));
    const mixed = (): PlanLike => {
      const p = repoPlan();
      p.steps = p.steps.filter((s) => s.kind !== 'symbol').map((s) => (s.target.file === 'src/api/routes.ts' ? { ...s, target: { file: 'src/api/routes.js' } } : s));
      return p;
    };
    const out = await divergePlan(input(mixed(), root, 's-parse', 'alt-1', ['s-src']), depsFor(model().run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.ok(out.plan.steps.some((s) => s.target.file === 'src/api/routes.js' && s.derivedFrom === 's-parse'), 'routes.js is re-planned, in its own language');

    const newJs = model(undefined, () => ({ steps: [{ kind: 'file', chapter: 'c2', path: 'src/api/extra.js', question: 'q?', options: options(), recommended: 'author', why: 'w', dependsOn: ['src/parse.ts'] }] }));
    const refused = await divergePlan(input(mixed(), root, 's-parse', 'alt-1', ['s-src']), depsFor(newJs.run, tempDir('diverge-gs-'), tempDir('diverge-target-')));
    assert.ok(!refused.ok, 'a file the plan never had takes the decision\'s language');
    assert.match(refused.reason, /extra\.js/);
  });

  // T-22's security review, F3: what the reproduce copy refuses to ship is not shipped to a model either.
  test('a dependency the reproduce copy would withhold (a credentials file) is never sent to the model', async () => {
    const { plan, root, gs, target } = setup();
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/.env'), 'API_KEY=a-secret-value\n');
    plan.steps.push(step('s-env', 11, 'src', 'file', 'config/.env'));
    stepNamed(plan, 's-routes')!.dependsOn = ['s-parse', 's-env'];
    const m = model();
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(m.run, gs, target));
    if (!out.ok || !out.changed) assert.fail(out.ok ? 'nothing changed' : out.reason);
    assert.ok(m.asked.some((a) => a.task === 'code' && (a.input['node'] as { path: string }).path === 'src/api/routes.ts'), 'discriminates: the file that stood on it was written');
    assert.ok(!JSON.stringify(m.asked).includes('a-secret-value'), 'the credentials file\'s contents are in no question');
  });

  test('a refusal of the model\'s answer says it was the model\'s answer: its "step 1" is not the walk\'s', async () => {
    const { plan, root, gs, target } = setup();
    const oneRoad = model(undefined, () => ({ steps: [{ kind: 'file', chapter: 'c2', path: 'src/api/routes.ts', question: 'q?', options: options().slice(0, 1), recommended: 'author', why: 'w', dependsOn: ['src/parse.ts'] }] }));
    const out = await divergePlan(input(plan, root, 's-parse'), depsFor(oneRoad.run, gs, target));
    assert.ok(!out.ok, 'discriminates: the answer is refused');
    assert.match(out.reason, /^in the model's answer, step 1 offers 1 option/);
  });
});
