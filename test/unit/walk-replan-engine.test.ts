// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The walk over the REAL engine (T-22): a `WalkSession` with `divergePlan` behind its press, the real store, repo-tour's
 * real extract and dial core, and a scripted model with `core.runLlm` poisoned. No test spends a token.
 *
 * `walk-replan.test.ts` hands the walk a stand-in engine's outcomes, and `derive-diverge.test.ts` hands the engine a
 * walked set made by hand. Neither can see what the re-review of the fixes found where the two meet (R3): at a press on
 * a symbol step the walk counts the file's own step as walked, so it stays, and two steps wrote one file. Here the
 * walked set is always the walk's own.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { divergePlan } from '../../src/derive/diverge.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import { emptyProgress, markDone, setCurrent, type PlanLike, type Progress, type StepLike } from '../../src/walk/model.js';
import { WalkSession, type Replanner, type WalkAdapters, type WalkView } from '../../src/walk/session.js';
import { buildDir, loadPlan, loadProgress, loadRequest, saveDivergedPlan, saveProgress } from '../../src/walk/store.js';
import { renderStepHtml } from '../../src/walk/step-view.js';
import type { SkinsModule } from '../../src/start/view.js';

let realCore: TutorCore;
let dialCore: DialCore;
const sessions: WalkSession[] = [];
const made: string[] = [];

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = tutorCoreFor(loaded.loaded);
  dialCore = dialCoreFor(loaded.loaded);
});

teardown(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const SKINS: SkinsModule = {
  SKINS: [{ name: 'system', label: 'System', note: 'follow the editor' }],
  baseCss: () => ':root{--bg:#fff}',
  alternateCss: () => '',
};

const options = () => [
  { id: 'author', label: 'What the author did', consequence: 'as written', taken: true },
  { id: 'alt-1', label: 'Another road', consequence: 'something else', taken: false },
];

function step(id: string, ordinal: number, chapter: string, kind: StepLike['kind'], file: string, dependsOn: string[] = [], range?: [number, number]): StepLike {
  return {
    id, ordinal, chapter, kind,
    decision: { question: `${id}?`, options: options(), authorChoice: 'author', chosen: null, why: 'because', whySource: 'interpret' },
    target: { file, ...(kind === 'symbol' ? { startLine: range?.[0] ?? 3, endLine: range?.[1] ?? 5 } : {}) },
    scaffold: { loadBearing: kind === 'file' ? [{ startLine: 3, endLine: 5 }] : [], boilerplate: [] },
    dependsOn,
    witness: { sha: null, date: null, subject: null },
  };
}

/** repo-tour's order: a file's symbol steps come right after its file step. render.ts imports routes.ts. */
function symbolPlan(): PlanLike {
  return {
    schemaVersion: 1, source: { kind: 'repo', root: '/somewhere/small-app', head: null }, mode: 'recreate', generatedAt: '2026-11-01T00:00:00.000Z',
    cost: { provider: 'claude', metered: true, calls: 1, cachedStops: 0, interpretedStops: 1, inputTokens: 0, outputTokens: 0, usd: 0, model: 'm', failures: [] },
    reproduce: [],
    chapters: ['src', 'src/api', 'src/view', 'docs'].map((key) => ({ key, title: key, subtitle: 's', tierPath: key })),
    steps: [
      step('s-src', 1, 'src', 'shape', 'src'),
      step('s-parse', 2, 'src', 'file', 'src/parse.ts'),
      step('s-store', 3, 'src', 'file', 'src/store.ts'),
      step('s-api', 4, 'src/api', 'shape', 'src/api'),
      step('s-routes', 5, 'src/api', 'file', 'src/api/routes.ts', ['s-parse']),
      step('s-handle', 6, 'src/api', 'symbol', 'src/api/routes.ts', ['s-routes'], [3, 5]),
      step('s-status', 7, 'src/api', 'symbol', 'src/api/routes.ts', ['s-routes'], [7, 9]),
      step('s-view', 8, 'src/view', 'shape', 'src/view'),
      step('s-render', 9, 'src/view', 'file', 'src/view/render.ts', ['s-routes']),
      step('s-docs', 10, 'docs', 'shape', 'docs'),
    ],
  };
}

const ROUTES = "import { tokenize } from '../parse';\n\nexport function handle(body: string): number {\n  return tokenize(body).length;\n}\n\nexport function status(): number {\n  return 200;\n}\n";
const REPO_FILES: Record<string, string> = {
  'src/parse.ts': "export function tokenize(line: string): string[] {\n  return line.split(' ');\n}\n",
  'src/store.ts': 'export const STORE = 1;\n',
  'src/api/routes.ts': ROUTES,
  'src/view/render.ts': "import { handle } from '../api/routes';\nexport function render(): string {\n  return String(handle('x'));\n}\n",
};
const MODELS = 'export const from = ';

interface Asked { task: string; input: Record<string, unknown> }

/** Code is a small file that names its path; a re-plan returns one step per step it is asked to replace. */
function scriptedModel() {
  const asked: Asked[] = [];
  const run: TutorCore['runLlm'] = (prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '))!;
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    asked.push({ task: String(input['task']), input });
    let text: string;
    if (input['task'] === 'code') {
      const file = (input['node'] as { path: string }).path;
      text = JSON.stringify({ content: `${MODELS}${JSON.stringify(file)};\n\nexport function handle(body: string): number {\n  return body.length;\n}\n` });
    } else {
      const decision = input['decision'] as { chosen: string };
      const replacing = input['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string; dependsOn: string[] }>;
      text = JSON.stringify({ steps: replacing.map((r) => ({ kind: r.kind, chapter: r.chapter, path: r.path, question: `${r.question} (following ${decision.chosen})`, options: r.options, recommended: r.chosen, why: r.why, dependsOn: r.dependsOn })) });
    }
    return Promise.resolve({ text, inputTokens: 10, outputTokens: 5, usd: 0.001, metered: true });
  };
  return { asked, run };
}

interface Harness {
  session: WalkSession;
  target: string;
  overwriteAsks: string[];
  view(): WalkView;
  html(): string;
  /** the options area's notes, as text */
  notes(): string;
}

function harness(progress: (plan: PlanLike) => Progress, run: TutorCore['runLlm'], dial: 'manual' | 'scaffolded' | 'automated', learners: Record<string, string> = {}): Harness {
  const target = tempDir('walk-engine-target-');
  const repo = tempDir('walk-engine-repo-');
  const gs = tempDir('walk-engine-gs-');
  for (const [root, files] of [[repo, REPO_FILES], [target, learners]] as const) {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  }
  const plan = symbolPlan();
  fs.mkdirSync(buildDir(target), { recursive: true });
  fs.writeFileSync(path.join(buildDir(target), 'plan.json'), JSON.stringify(plan, null, 2));
  saveProgress(target, progress(plan));
  fs.writeFileSync(path.join(buildDir(target), 'request.json'), JSON.stringify({ idea: '', recreate: true, repo, target, dial, referenceRoot: repo }));
  const overwriteAsks: string[] = [];
  const core: TutorCore = { ...realCore, runLlm: () => Promise.reject(new Error('a test in walk-replan-engine.test.ts reached the real model')), availability: () => Promise.resolve({ ok: true, detail: 'stubbed' }) };
  const store = path.join(gs, 'derived');
  const replanner: Replanner = {
    diverge: (input, hooks) => divergePlan(input, {
      ledger: hooks.ledger, isCancelled: hooks.isCancelled, onProgress: hooks.onProgress,
      settings: { core, provider: 'claude', model: 'm', timeoutMs: 5_000, run }, globalStorageRoot: gs, dialCore, target,
    }),
    savePlan: (t, p, before) => { saveDivergedPlan(t, p, undefined, before); },
  };
  const adapters: WalkAdapters = {
    setTree: () => undefined, setPanel: () => undefined, setStatus: () => undefined,
    revealEditor: () => undefined, clearEditor: () => undefined, openFile: () => undefined,
    fileExists: (p) => fs.existsSync(p),
    loadPlan, loadProgress, saveProgress,
    loadRequest: (t, p) => loadRequest(t, { plan: p, store }),
    reportError: () => undefined,
    core: () => Promise.resolve(dialCore),
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
    confirmOverwrite: (file) => { overwriteAsks.push(file); return Promise.resolve(true); },
    git: () => Promise.reject(new Error('no git here')),
    commitPerStep: () => false,
    replanner: () => Promise.resolve(replanner),
  };
  const session = WalkSession.open(target, adapters);
  sessions.push(session);
  const h: Harness = {
    session, target, overwriteAsks,
    view: () => { const v = session.getView(); assert.ok(v, 'the walk has a current step'); return v; },
    html: () => renderStepHtml({ ...h.view(), skin: 'system' }, SKINS),
    notes: () => {
      const m = /<div class="options-outcome" id="outcome-choice">([\s\S]*?)<\/div>/.exec(h.html());
      return m === null ? '' : m[1]!.replace(/<button[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    },
  };
  return h;
}

const at = (id: string, done: string[] = []) => (plan: PlanLike): Progress => {
  let p = setCurrent(emptyProgress(plan), id);
  for (const d of done) p = markDone(p, d);
  return p;
};

async function drain(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await h.session.settled();
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

const routesOf = (h: Harness): string => {
  try { return fs.readFileSync(path.join(h.target, 'src/api/routes.ts'), 'utf8'); } catch { return '(absent)'; }
};
const divergencesOf = (h: Harness): unknown[] => (loadPlan(h.target)['divergences'] as unknown[] | undefined) ?? [];
const chooseButtons = (html: string): string[] => [...html.matchAll(/<button type="button" class="btn option-choose"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);

/** The press the re-review drove: at the symbol step `s-handle`, from its own page, which leaves `s-routes` walked. */
async function symbolPress(h: Harness): Promise<void> {
  h.session.goTo('s-handle');
  await drain(h);
  h.session.choose('s-handle', 'alt-1');
  await drain(h);
  assert.match(h.view().choiceNote ?? '', /^Re-planned/, 'discriminates: the symbol press landed');
}

// The re-review of the fixes, R3 (must-fix) with R1, ruled 2026-11-11: one writer per file. D writes its file from the
// press on; the file's own step keeps its record as the learner left it and writes, outlines and checks nothing for it.
suite('one writer per file after a symbol press, through the walk and the real engine (T-22 re-review R3, R1)', () => {
  test('automated: the file step writes nothing once D has taken its file over, so moving between them never turns the file over', async () => {
    const h = harness(at('s-routes'), scriptedModel().run, 'automated');
    await drain(h);
    assert.equal(routesOf(h), ROUTES, 'discriminates: arriving at the file step wrote the author\'s file');
    await symbolPress(h);
    const record = JSON.stringify(loadProgress(h.target, loadPlan(h.target)).steps['s-routes']);
    h.session.goTo('s-routes'); await drain(h);
    assert.equal(routesOf(h), ROUTES, 'the landing wrote nothing, and nor did arriving at the file step');
    h.session.goTo('s-handle'); await drain(h);
    assert.ok(routesOf(h).startsWith(MODELS), 'D writes the file');
    assert.deepEqual(h.overwriteAsks, ['src/api/routes.ts'], 'asking first, because the file differs');
    h.session.goTo('s-routes'); await drain(h);
    assert.ok(routesOf(h).startsWith(MODELS), 'the file step does not write the author\'s file back');
    assert.deepEqual(h.overwriteAsks, ['src/api/routes.ts'], 'and asks nothing');
    assert.equal(JSON.stringify(loadProgress(h.target, loadPlan(h.target)).steps['s-routes']), record, 'its record is as the learner left it');
    h.session.goTo('s-handle'); await drain(h);
    assert.ok(routesOf(h).startsWith(MODELS));
    assert.doesNotMatch(h.view().writeNote ?? '', /you chose that earlier/);
  });

  test('scaffolded: the file step writes no stub of the author\'s file over the one D wrote', async () => {
    const h = harness(at('s-routes'), scriptedModel().run, 'scaffolded');
    await drain(h);
    const authors = routesOf(h);
    assert.notEqual(authors, '(absent)', 'discriminates: arriving at the file step wrote its stub');
    await symbolPress(h);
    h.session.goTo('s-handle'); await drain(h);
    const ds = routesOf(h);
    assert.notEqual(ds, authors, 'D wrote its own stub');
    h.session.goTo('s-routes'); await drain(h);
    assert.equal(routesOf(h), ds, 'the file step writes nothing over it');
    assert.equal(h.overwriteAsks.length, 1, 'and asks nothing');
  });

  test('manual: the file step outlines nothing, and Check my work there checks nothing and says which step checks the file now', async () => {
    const h = harness(at('s-routes'), scriptedModel().run, 'manual', { 'src/api/routes.ts': ROUTES });
    await drain(h);
    assert.ok(h.view().shape !== undefined, 'discriminates: before the press the file step outlines the author\'s file');
    await symbolPress(h);
    const record = JSON.stringify(loadProgress(h.target, loadPlan(h.target)).steps['s-routes'] ?? null);
    h.session.goTo('s-routes'); await drain(h);
    assert.equal(h.view().shape, undefined, 'no outline of a file another step writes now');
    h.session.runCheck(); await drain(h);
    assert.equal(h.view().check, undefined, 'no verdict');
    assert.match(h.view().writeNote ?? '', /step 6 \(src\/api\/routes\.ts\)/, `it says where the file is checked now: ${JSON.stringify(h.view().writeNote ?? null)}`);
    assert.equal(JSON.stringify(loadProgress(h.target, loadPlan(h.target)).steps['s-routes'] ?? null), record, 'and its record is as the learner left it');
  });

  test('the file step offers no road to press, its page says which step writes the file now, and a press there is refused in words, with nothing asked', async () => {
    const m = scriptedModel();
    const h = harness(at('s-routes'), m.run, 'manual');
    await drain(h);
    assert.ok(chooseButtons(h.html()).length > 0, 'discriminates: before the press the file step offers a road');
    await symbolPress(h);
    h.session.goTo('s-routes'); await drain(h);
    assert.deepEqual(chooseButtons(h.html()), [], 'no road to press');
    assert.match(h.notes(), /step 6 \(src\/api\/routes\.ts\)/, `the page says which step writes the file now: ${JSON.stringify(h.notes())}`);
    const asked = m.asked.length;
    h.session.choose('s-routes', 'alt-1'); await drain(h);
    assert.match(h.view().choiceNote ?? '', /step 6 \(src\/api\/routes\.ts\)/, `a forged press is refused in words: ${JSON.stringify(h.view().choiceNote ?? null)}`);
    // The re-check of 2026-11-17, C7: D keeps a decision of its own, so this step's roads are chosen nowhere now.
    assert.doesNotMatch(h.view().choiceNote ?? '', /chosen at/, 'and the refusal does not send the learner to choose them elsewhere');
    assert.equal(m.asked.length, asked, 'nothing was asked');
    assert.equal(divergencesOf(h).length, 1, 'nothing landed');
  });

  test('D\'s page names the file step as the author\'s version of its file, not as a step that may need revisiting', async () => {
    const h = harness(at('s-routes'), scriptedModel().run, 'manual');
    await drain(h);
    await symbolPress(h);
    const notes = h.notes();
    assert.match(notes, /step 5 \(src\/api\/routes\.ts\)/, `D's page names the file step: ${JSON.stringify(notes)}`);
    assert.match(notes, /author.s version of this file/);
    assert.doesNotMatch(notes, /may need revisiting/, 'revisiting it would do nothing: it writes nothing for the file now');
  });

  test('on another step\'s page a walked file step that was taken over is named with the step that writes its file now', async () => {
    const h = harness(at('s-routes'), scriptedModel().run, 'automated');
    await drain(h);
    await symbolPress(h);
    h.session.goTo('s-parse'); await drain(h);
    h.session.choose('s-parse', 'alt-1'); await drain(h);
    assert.match(h.view().choiceNote ?? '', /^Re-planned/, `discriminates: it landed: ${JSON.stringify(h.view().choiceNote ?? null)}`);
    const notes = h.notes();
    assert.match(notes, /step \d+ \(src\/api\/routes\.ts, written at step \d+ now\)/, `the walked file step is named with where its file is written now: ${JSON.stringify(notes)}`);
  });

  test('a press upstream after a symbol press asks about the file once, and lands with one step left for it', async () => {
    const m = scriptedModel();
    const h = harness(at('s-routes'), m.run, 'manual');
    await drain(h);
    await symbolPress(h);
    h.session.goTo('s-parse'); await drain(h);
    h.session.choose('s-parse', 'alt-1'); await drain(h);
    assert.match(h.view().choiceNote ?? '', /^Re-planned/, `it lands: ${JSON.stringify(h.view().choiceNote ?? null)}`);
    const replacing = ((m.asked.filter((a) => a.task === 'replan').at(-1)?.input['replacing'] as Array<{ path: string }> | undefined) ?? []).map((r) => r.path);
    assert.deepEqual(replacing.filter((p) => p === 'src/api/routes.ts'), ['src/api/routes.ts'], `routes.ts is asked about once: ${JSON.stringify(replacing)}`);
    assert.deepEqual(loadPlan(h.target).steps.filter((s) => s.target.file === 'src/api/routes.ts').map((s) => `${s.kind}:${s.derivedFrom ?? 'the author'}`), ['file:s-parse']);
  });
});

// The re-review of the fixes, R11: SF4's line says a choice was never re-planned, and the walk would not re-plan from it.
suite('a choice no re-plan followed can be re-planned from its own road (T-22 re-review R11)', () => {
  const t21Choice = (plan: PlanLike): Progress => {
    const p = at('s-parse', ['s-src'])(plan);
    return { ...p, steps: { ...p.steps, 's-parse': { status: 'pending', chosen: 'alt-1' } } };
  };

  test('the page offers to re-plan from it, and the press re-plans', async () => {
    const h = harness(t21Choice, scriptedModel().run, 'manual');
    await drain(h);
    assert.match(h.notes(), /was not re-planned from it/, 'discriminates: SF4\'s honest line');
    assert.ok(chooseButtons(h.html()).some((label) => /re-plan/i.test(label)), `the road it names can be pressed: ${JSON.stringify(chooseButtons(h.html()))}`);
    h.session.choose('s-parse', 'alt-1'); await drain(h);
    assert.match(h.view().choiceNote ?? '', /^Re-planned/, `it re-planned: ${JSON.stringify(h.view().choiceNote ?? null)}`);
    assert.equal(divergencesOf(h).length, 1);
  });

  test('once re-planned, the road is the one the step is on: no offer, and a press is refused with nothing asked', async () => {
    const m = scriptedModel();
    const h = harness(t21Choice, m.run, 'manual');
    await drain(h);
    h.session.choose('s-parse', 'alt-1'); await drain(h);
    assert.equal(divergencesOf(h).length, 1, 'discriminates: it landed');
    assert.ok(!chooseButtons(h.html()).some((label) => /re-plan/i.test(label)), 'no offer on the road it is on now');
    const asked = m.asked.length;
    h.session.choose('s-parse', 'alt-1'); await drain(h);
    assert.match(h.view().choiceNote ?? '', /already the road this step is on/);
    assert.equal(m.asked.length, asked);
  });

  // The re-check of 2026-11-17, C2: "Choose this instead" on the author's road re-planned the author's road, for 4
  // questions, and replaced the author's code, though the walk had never left it.
  test('from a choice no re-plan followed, the author\'s road drops the choice: nothing is asked, nothing is re-planned', async () => {
    const m = scriptedModel();
    const h = harness(t21Choice, m.run, 'manual');
    await drain(h);
    assert.ok(chooseButtons(h.html()).some((label) => /^Back to the author/.test(label)), `discriminates: the author's road says what its press does: ${JSON.stringify(chooseButtons(h.html()))}`);
    const plan = fs.readFileSync(path.join(buildDir(h.target), 'plan.json'), 'utf8');
    h.session.choose('s-parse', 'author'); await drain(h);
    assert.equal(m.asked.length, 0, 'nothing was asked');
    assert.equal(divergencesOf(h).length, 0, 'nothing was re-planned');
    assert.equal(fs.readFileSync(path.join(buildDir(h.target), 'plan.json'), 'utf8'), plan, 'the author\'s steps stand as they were');
    assert.equal(loadProgress(h.target, loadPlan(h.target)).steps['s-parse']?.chosen, undefined, 'and the choice is gone');
    assert.match(h.view().choiceNote ?? '', /^Back on the author.s road/);
    assert.doesNotMatch(h.notes(), /was not re-planned from it/, 'the step is on the author\'s road again');
  });

  test('a chapter choice nothing stands on is recorded, and stays without an offer to re-plan from it', async () => {
    const h = harness((plan) => {
      const p = at('s-docs')(plan);
      return { ...p, steps: { ...p.steps, 's-docs': { status: 'pending', chosen: 'alt-1' } } };
    }, scriptedModel().run, 'manual');
    await drain(h);
    assert.match(h.notes(), /Nothing later depended on it/, 'discriminates: the chapter step\'s own line');
    assert.deepEqual(chooseButtons(h.html()).filter((label) => /re-plan/i.test(label)), []);
  });
});

// The stopped re-review's NF3: a step downstream of D that a walked step stands on is kept, on the old road. It was named
// nowhere, and the landing said "No later step needed re-planning".
suite('a step kept on the old road because a walked step stands on it (T-22, the stopped re-review NF3)', () => {
  test('the landing says it stayed on the old road, and D\'s page names it', async () => {
    const h = harness(at('s-parse', ['s-render']), scriptedModel().run, 'manual');
    await drain(h);
    h.session.choose('s-parse', 'alt-1'); await drain(h);
    const note = h.view().choiceNote ?? '';
    assert.match(note, /^Re-planned/, 'discriminates: it landed');
    assert.doesNotMatch(note, /No later step needed re-planning/, `routes.ts stood on the old road: ${JSON.stringify(note)}`);
    assert.match(note, /old road/);
    const notes = h.notes();
    assert.match(notes, /step 5 \(src\/api\/routes\.ts\)/, `D's page names the step kept on the old road: ${JSON.stringify(notes)}`);
    assert.match(notes, /step 9 \(src\/view\/render\.ts\)/, 'beside the walked one that stands on it');
  });
});
