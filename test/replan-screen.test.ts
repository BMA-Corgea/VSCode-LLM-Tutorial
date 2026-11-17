// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-22's acceptance, read off the SCREEN: a learner takes a different road in the real Current Step
 * webview, and the walk re-plans (AC6, AC8, with AC3, AC9 and AC11 where the same drive reaches them).
 *
 * The press goes through the real `replannerFor`, the real `divergePlan`, the real `AskLedger` and
 * repo-tour's real `extract`. The one thing replaced is the model: `_walk.useTutorCore` puts a
 * scripted `runLlm` in front of it, so nothing here spends a token. The script can hold a question
 * open, which is what lets a test read the page while a re-plan is running.
 *
 * Every question carries a tag made for this run. Replies are cached in the host's global storage
 * under the hash of the prompt, so a repeated prompt would be answered from the cache and never
 * reach the script.
 *
 * Runs in the `screen` test host only, the one launched with a DevTools port (`.vscode-test.mjs`).
 */

import * as assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension.js';
import type { TutorCore } from '../src/tutor/core.js';
import type { PlanLike, StepLike } from '../src/walk/model.js';
import { CHOICE_ALREADY_REPLANNING, REPLAN_CANCELLED_BILLED, REPLAN_NOTHING_FOLLOWS } from '../src/walk/session.js';
import { AUTHOR_BADGE, DIVERGED_NOTE, REPLANNED_NOTE, WRITTEN_BY_THE_MODEL_NOTE } from '../src/walk/step-view.js';
import { Screen, sleep } from './support/screen.js';

const TITLE = 'Build Tutorials: Step';
const D = 's-parse';
const AFTER_D = 's-routes';
const NOTHING_AFTER = 's-docs';
const ROAD = 'alt-1';

/** What a person could see of the press and what became of it. */
const PAGE = `(() => {
  const list = document.querySelector('ul.options');
  const main = document.getElementById('step-main');
  if (!list || !main) return null;
  const rows = Array.from(list.querySelectorAll('li'));
  const text = (el) => (el ? el.textContent : '');
  return {
    step: main.getAttribute('data-step-id'),
    count: text(document.querySelector('.step-count')),
    on: rows.filter((li) => li.classList.contains('option-taken')).map((li) => li.getAttribute('data-option-id')),
    yours: rows.filter((li) => li.querySelector('.badge-chosen')).map((li) => li.getAttribute('data-option-id')),
    badges: Array.from(list.querySelectorAll('.badge')).map((b) => b.textContent),
    labels: Array.from(list.querySelectorAll('.option-label')).map((l) => l.textContent),
    choosable: Array.from(list.querySelectorAll('button.option-choose')).map((b) => b.getAttribute('data-option-id')),
    running: text(document.getElementById('replan-status')),
    cancel: document.getElementById('btn-replan-cancel') !== null,
    note: text(document.getElementById('choice-note')),
    notes: Array.from(document.querySelectorAll('.options-diverged:not(.options-stale)')).map((n) => n.textContent),
    stale: text(document.querySelector('.options-stale')),
    shape: Array.from(document.querySelectorAll('.shape-line')).map((l) => l.textContent),
  };
})()`;

interface Page {
  step: string;
  count: string;
  on: string[];
  yours: string[];
  badges: string[];
  labels: string[];
  choosable: string[];
  running: string;
  cancel: boolean;
  note: string;
  notes: string[];
  stale: string;
  shape: string[];
}

const choose = (optionId: string): string => `button.option-choose[data-option-id=${JSON.stringify(optionId)}]`;

/** Polls until `ok`, or fails naming what was on screen instead. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let now = await read();
  while (!ok(now) && Date.now() < deadline) {
    await sleep(100);
    now = await read();
  }
  assert.ok(ok(now), `${what} — the screen showed ${JSON.stringify(now)}`);
  return now;
}

/** The scripted model: answers as a model would, or holds a question open, or answers nonsense. */
function scriptedModel(): {
  run: TutorCore['runLlm'];
  hold(): void;
  release(): void;
  state: { calls: number; waiting: number; nonsense: boolean };
} {
  const state = { calls: 0, waiting: 0, nonsense: false };
  let gate: { opened: Promise<void>; open: () => void } | undefined;
  const answer = (prompt: string): string => {
    const line = prompt.split('\n').find((l) => l.startsWith('INPUT (JSON): '));
    assert.ok(line, 'the prompt carries its input');
    const input = JSON.parse(line.slice('INPUT (JSON): '.length)) as Record<string, unknown>;
    if (input['task'] === 'code') return JSON.stringify({ content: `export function writtenByTheModel(): string {\n  return ${JSON.stringify((input['node'] as { path: string }).path)};\n}\n` });
    const decision = input['decision'] as { chosen: string };
    const replacing = input['replacing'] as Array<{ kind: string; chapter: string; path: string; question: string; options: unknown[]; chosen: string; why: string; dependsOn: string[] }>;
    return JSON.stringify({
      // The options are echoed as they were shown, "What the author did" included: a real model can do the same.
      steps: replacing.map((r) => ({ kind: r.kind, chapter: r.chapter, path: r.path, question: `${r.question} (following ${decision.chosen})`, options: r.options, recommended: r.chosen, why: r.why, dependsOn: r.dependsOn })),
    });
  };
  return {
    state,
    hold: () => {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      gate = { opened, open };
    },
    release: () => {
      gate?.open();
      gate = undefined;
    },
    run: async (prompt) => {
      state.calls += 1;
      const held = gate;
      if (held !== undefined) {
        state.waiting += 1;
        await held.opened;
        state.waiting -= 1;
      }
      return { text: state.nonsense ? 'this is not what was asked for' : answer(prompt), inputTokens: 10, outputTokens: 5, usd: 0.001, metered: true };
    },
  };
}

function aStep(id: string, ordinal: number, chapter: string, kind: StepLike['kind'], file: string, dependsOn: string[], tag: string, extra: Partial<StepLike> = {}): StepLike {
  return {
    id, ordinal, chapter, kind,
    decision: {
      question: `${id}? ${tag}`,
      options: [
        { id: 'author', label: 'What the author did', consequence: 'as written', taken: true },
        { id: ROAD, label: 'Another road', consequence: 'something else', taken: false },
      ],
      authorChoice: 'author', chosen: null, why: 'because', whySource: 'interpret',
    },
    target: { file },
    scaffold: { loadBearing: [], boilerplate: [] },
    dependsOn,
    witness: { sha: null, date: null, subject: null },
    ...extra,
  };
}

function thePlan(repo: string, tag: string): PlanLike {
  return {
    schemaVersion: 1,
    source: { kind: 'repo', root: repo, head: null },
    mode: 'recreate',
    generatedAt: '2026-11-01T00:00:00.000Z',
    cost: { provider: 'none', metered: true, calls: 0, cachedStops: 0, interpretedStops: 0, inputTokens: 0, outputTokens: 0, usd: 0, model: 'none', failures: [] },
    reproduce: [],
    chapters: [
      { key: 'src', title: 'src', subtitle: 's', tierPath: 'src' },
      { key: 'src/api', title: 'api', subtitle: 's', tierPath: 'src/api' },
      { key: 'docs', title: 'docs', subtitle: 's', tierPath: 'docs' },
    ],
    steps: [
      aStep('s-src', 1, 'src', 'shape', 'src', [], tag),
      aStep(D, 2, 'src', 'file', 'src/parse.ts', [], tag),
      aStep('s-api', 3, 'src/api', 'shape', 'src/api', [], tag),
      aStep(AFTER_D, 4, 'src/api', 'file', 'src/api/routes.ts', [D], tag),
      aStep(NOTHING_AFTER, 5, 'docs', 'shape', 'docs', [], tag),
    ],
  };
}

/**
 * The re-review of the fixes, R3: a symbol step after its file's own step, as repo-tour orders them, so a press on the
 * symbol leaves the file step walked. Both files paint a load-bearing range, so the editor shows when a step paints none.
 */
const FILE_STEP = 's-routes-file';
const SYMBOL = 's-handle';
function symbolPlan(repo: string, tag: string): PlanLike {
  const plan = thePlan(repo, tag);
  const lines = { loadBearing: [{ startLine: 1, endLine: 2 }], boilerplate: [] };
  return {
    ...plan,
    steps: [
      aStep('s-src', 1, 'src', 'shape', 'src', [], tag),
      aStep(D, 2, 'src', 'file', 'src/parse.ts', [], tag, { scaffold: lines }),
      aStep('s-api', 3, 'src/api', 'shape', 'src/api', [], tag),
      aStep(FILE_STEP, 4, 'src/api', 'file', 'src/api/routes.ts', [D], tag, { scaffold: { loadBearing: [{ startLine: 3, endLine: 5 }], boilerplate: [] } }),
      aStep(SYMBOL, 5, 'src/api', 'symbol', 'src/api/routes.ts', [FILE_STEP], tag, { target: { file: 'src/api/routes.ts', startLine: 3, endLine: 5 } }),
      aStep(NOTHING_AFTER, 6, 'docs', 'shape', 'docs', [], tag),
    ],
  };
}

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** Every file under `root` by hash, leaving out the walk's own folder. */
function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.repo-tour') continue;
      const full = path.join(dir, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

interface Drive {
  api: ExtensionApi;
  target: string;
  build: string;
  planBefore: Buffer;
  model: ReturnType<typeof scriptedModel>;
  read: () => Promise<Page>;
  onStep: (stepId: string) => Promise<Page>;
  press: (selector: string) => Promise<void>;
  treeSteps: () => string[];
  /** The four things a re-plan that did not land must leave exactly as they were (AC11). */
  ac11: () => Record<string, string>;
}

suite('a different road, re-planned, read off the screen (T-22)', function () {
  this.timeout(180_000);

  async function drive(body: (d: Drive) => Promise<void>, planOf: (repo: string, tag: string) => PlanLike = thePlan): Promise<void> {
    const ext = vscode.extensions.getExtension<ExtensionApi>('bma-corgea.build-tutorials');
    assert.ok(ext);
    const api = await ext.activate();
    const realCore = await api._walk.tutorCore();
    assert.ok(realCore, 'repo-tour loads in this host');
    const model = scriptedModel();
    api._walk.useTutorCore({ ...realCore, availability: () => Promise.resolve({ ok: true, detail: 'a stand-in' }), runLlm: model.run });
    const screen = await Screen.open(api._context);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-screen-'));
    const repo = path.join(base, 'repo');
    const target = path.join(base, 'target');
    const build = path.join(target, '.repo-tour', 'build');
    write(repo, 'src/parse.ts', 'export function tokenize(line: string): string[] {\n  return line.split(" ");\n}\n');
    write(repo, 'src/api/routes.ts', "import { tokenize } from '../parse';\n\nexport function handle(body: string): number {\n  return tokenize(body).length;\n}\n");
    write(target, 'src/parse.ts', 'the learner wrote this\n');
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(build, 'plan.json'), `${JSON.stringify(planOf(repo, randomBytes(6).toString('hex')), null, 3)}\n`);
    fs.writeFileSync(path.join(build, 'request.json'), JSON.stringify({ idea: '', recreate: true, repo, target, dial: 'manual', referenceRoot: repo }));
    try {
      await api._walk.openAt(target);
      await vscode.commands.executeCommand('buildTutorials.step.focus');
      const reader = screen.reader<Page | null>(TITLE, PAGE);
      const read = async (): Promise<Page> => {
        const shown = await until(reader, (p) => p !== null, 'the step page');
        assert.ok(shown);
        return shown;
      };
      const planFile = path.join(build, 'plan.json');
      await body({
        api, target, build, model, read,
        planBefore: fs.readFileSync(planFile),
        onStep: (stepId) => {
          api._walk.session()!.goTo(stepId);
          return until(read, (p) => p.step === stepId, `the page for ${stepId}`);
        },
        press: async (selector) => { await screen.reader<unknown>(TITLE, `document.querySelector(${JSON.stringify(selector)}).click()`)(); },
        treeSteps: () => {
          const tree = api._walk.tree();
          assert.ok(tree);
          return tree.getChildren().flatMap((c) => tree.getChildren(c)).map((n) => (n.kind === 'step' ? n.step.id : 'not a step'));
        },
        ac11: () => {
          const out: Record<string, string> = {};
          for (const name of ['plan.json', 'request.json', 'progress.json']) {
            const file = path.join(build, name);
            out[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(none)';
          }
          out['versions'] = fs.existsSync(path.join(build, 'versions')) ? fs.readdirSync(path.join(build, 'versions')).join(',') : '(none)';
          return out;
        },
      });
    } finally {
      model.release();
      api._walk.useTutorCore(undefined);
      api._walk.session()?.dispose();
      screen.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.view.explorer');
      fs.rmSync(base, { recursive: true, force: true });
    }
  }

  test('press, re-planning, a press while it runs, done: the panel and the tree follow, on D, and a reload shows the same plan (AC6, AC8, AC3, AC4)', () => drive(async (d) => {
    const folder = hashes(d.target);
    const before = await d.onStep(D);
    assert.deepEqual(before.on, ['author']);
    assert.equal(before.cancel, false);
    const treeBefore = d.treeSteps();
    assert.ok(treeBefore.includes(AFTER_D), 'discriminates: the step that follows D is in the tree');

    d.model.hold();
    await d.press(choose(ROAD));
    const running = await until(d.read, (p) => p.cancel, 'the page says it is re-planning, and offers Cancel');
    assert.notDeepEqual(running, before, 'the press changed the page');
    assert.notEqual(running.running, '');
    assert.ok(fs.readFileSync(path.join(d.build, 'plan.json')).equals(d.planBefore), 'nothing is written while it runs');

    await d.press(choose(ROAD));
    const second = await until(d.read, (p) => p.note === CHOICE_ALREADY_REPLANNING, 'a press while one runs is answered');
    assert.notDeepEqual(second, running);
    await d.press(choose(ROAD));
    const third = await until(d.read, (p) => p.note === `${CHOICE_ALREADY_REPLANNING} Tried 2 times.`, 'and a repeat of it changes the page again');
    assert.notDeepEqual(third, second);
    assert.equal(third.cancel, true, 'the wait is still on the page');

    d.model.release();
    const done = await until(d.read, (p) => !p.cancel && p.note.startsWith('Re-planned'), 'the page says it landed');
    assert.notDeepEqual(done, third);
    assert.equal(done.step, D, 'and the learner is still on D');
    assert.deepEqual(done.on, [ROAD]);
    assert.deepEqual(done.yours, [ROAD]);
    assert.deepEqual(done.notes, [REPLANNED_NOTE]);
    assert.match(done.note, /and 1 later step now follow your choice/, 'the note counts the step that followed, not D itself');
    assert.match(done.note, /cost about \$/, 'what it cost is on the page (AC10)');

    const treeAfter = d.treeSteps();
    assert.ok(!treeAfter.includes(AFTER_D), 'the step that followed D is no longer in the tree');
    const fresh = treeAfter.filter((id) => !treeBefore.includes(id));
    assert.equal(fresh.length, 1, `one new step takes its place; the tree is ${JSON.stringify(treeAfter)}`);

    assert.deepEqual(hashes(d.target), folder, 'the learner\'s folder has not moved');
    assert.ok(fs.readFileSync(path.join(d.build, 'versions', '1.json')).equals(d.planBefore), 'the plan before is kept, byte for byte');

    const page = await d.onStep(fresh[0]!);
    assert.ok(page.notes.includes(WRITTEN_BY_THE_MODEL_NOTE), `the page says who wrote it; it shows ${JSON.stringify(page)}`);
    assert.ok(!page.badges.includes(AUTHOR_BADGE), 'no badge claims an author');
    assert.ok(!page.labels.some((l) => /what the author did/i.test(l)), `nor does any option: ${JSON.stringify(page.labels)}`);
    // Manual mode's outline of the file, which is read from the reference: the repository's file at
    // this path exports `handle`, and the re-derived one exports `writtenByTheModel` (AC5, by its effect).
    const outline = await until(d.read, (p) => p.step === fresh[0] && p.shape.length > 0, 'manual mode outlines the file');
    assert.ok(outline.shape.some((l) => l.includes('writtenByTheModel')), `the outline is the re-derived code; it shows ${JSON.stringify(outline.shape)}`);
    assert.ok(!outline.shape.some((l) => l.includes('handle')), 'and not the author\'s');

    d.api._walk.session()!.dispose();
    await d.api._walk.openAt(d.target);
    await vscode.commands.executeCommand('buildTutorials.step.focus');
    const reloaded = await d.onStep(D);
    assert.deepEqual(reloaded.on, [ROAD], 'a reload remembers the road');
    assert.deepEqual(reloaded.notes, [REPLANNED_NOTE]);
    assert.deepEqual(d.treeSteps(), treeAfter, 'and shows the same walk');
    await d.onStep(fresh[0]!);
    const again = await until(d.read, (p) => p.step === fresh[0] && p.shape.length > 0, 'manual mode outlines the file after a reload');
    assert.ok(again.shape.some((l) => l.includes('writtenByTheModel')), `a reload still reads the re-derived code; it shows ${JSON.stringify(again.shape)}`);
  }));

  test('refused, refused again, then cancelled: each says why, no byte moves, and the road can still be pressed (AC6, AC11)', () => drive(async (d) => {
    const before = await d.onStep(D);
    const disk = d.ac11();

    d.model.state.nonsense = true;
    await d.press(choose(ROAD));
    const refused = await until(d.read, (p) => p.note.startsWith('Nothing was changed, and the road is still there to press. Why: '), 'the refusal says why');
    assert.notDeepEqual(refused, before);
    assert.equal(refused.cancel, false, 'the wait is over');
    assert.deepEqual(refused.choosable, [ROAD], 'the road is still there to press');
    assert.deepEqual(d.ac11(), disk);

    await d.press(choose(ROAD));
    const again = await until(d.read, (p) => p.note.endsWith('Tried 2 times.'), 'the same refusal twice does not look the same');
    assert.notDeepEqual(again, refused);
    assert.deepEqual(d.ac11(), disk);

    d.model.state.nonsense = false;
    d.model.hold();
    await d.press(choose(ROAD));
    await until(d.read, (p) => p.cancel, 'running again');
    await until(() => Promise.resolve(d.model.state.waiting), (n) => n > 0, 'the question is with the model');
    await d.press('#btn-replan-cancel');
    const cancelled = await until(d.read, (p) => p.note === REPLAN_CANCELLED_BILLED, 'the cancel says what it could not stop');
    assert.equal(cancelled.cancel, false);
    assert.equal(cancelled.running, '');
    d.model.release();
    assert.deepEqual(d.ac11(), disk, 'a cancel moves nothing');

    await d.press(choose(ROAD));
    const landed = await until(d.read, (p) => p.note.startsWith('Re-planned'), 'and the road still works after all that');
    assert.deepEqual(landed.on, [ROAD]);
  }));

  test('a step nothing depends on: the page says the rest of the walk stands, and nothing is asked or rewritten (AC6)', () => drive(async (d) => {
    const before = await d.onStep(NOTHING_AFTER);
    await d.press(choose(ROAD));
    const after = await until(d.read, (p) => p.note === REPLAN_NOTHING_FOLLOWS, 'it says so');
    assert.notDeepEqual(after, before);
    assert.deepEqual(after.on, [ROAD]);
    assert.deepEqual(after.notes, [DIVERGED_NOTE]);
    assert.equal(d.model.state.calls, 0, 'there was nothing to ask');
    assert.ok(fs.readFileSync(path.join(d.build, 'plan.json')).equals(d.planBefore));
    assert.equal(fs.existsSync(path.join(d.build, 'versions')), false);
  }));

  test('a walked step that stood on the old road is named on D\'s page, and a reload still names it (AC9)', () => drive(async (d) => {
    await d.onStep(D);
    d.api._walk.session()!.markDone(AFTER_D);
    await d.press(choose(ROAD));
    const done = await until(d.read, (p) => p.note.startsWith('Re-planned'), 'it landed');
    assert.match(done.stale, /step 4 \(src\/api\/routes\.ts\)/);
    assert.match(done.note, /No later step needed re-planning/, 'the walked step stands, so nothing later was re-derived');
    assert.ok(d.treeSteps().includes(AFTER_D), 'and the walked step is still there');
    d.api._walk.session()!.dispose();
    await d.api._walk.openAt(d.target);
    await vscode.commands.executeCommand('buildTutorials.step.focus');
    const reloaded = await d.onStep(D);
    assert.match(reloaded.stale, /step 4 \(src\/api\/routes\.ts\)/, 'the plan itself remembers it');
  }));

  // The re-review of the fixes, R3 (must-fix), ruled 2026-11-11: one writer per file. From a symbol press on, D writes its
  // file; the file's own step, walked, offers no road and paints none of the author's lines over the learner's file.
  test('a symbol press: the file step D took over offers no road and paints no lines, and D names it (R3)', () => drive(async (d) => {
    const decorator = d.api._walk.decorator();
    assert.ok(decorator);
    write(d.target, 'src/api/routes.ts', "import { tokenize } from '../parse';\n\nexport function handle(body: string): number {\n  return tokenize(body).length;\n}\n");
    const before = await d.onStep(FILE_STEP);
    assert.deepEqual(before.choosable, [ROAD], 'discriminates: before the press the file step offers a road');
    await until(() => Promise.resolve(decorator.getLastRangeCountForTest()), (n) => n === 1, 'the file step paints its load-bearing lines');
    await d.onStep(SYMBOL);
    await d.press(choose(ROAD));
    const done = await until(d.read, (p) => p.note.startsWith('Re-planned'), 'it landed');
    assert.match(done.stale, /step 4 \(src\/api\/routes\.ts\)/, `D names the file step: ${JSON.stringify(done.stale)}`);
    assert.match(done.stale, /author.s version of this file/);
    await d.onStep(D);
    await until(() => Promise.resolve(decorator.getLastRangeCountForTest()), (n) => n === 1, 'discriminates: another step still paints its line');
    const taken = await d.onStep(FILE_STEP);
    assert.deepEqual(taken.choosable, [], 'the file step offers no road');
    assert.ok(taken.notes.some((n) => /step 5 \(src\/api\/routes\.ts\)/.test(n)), `and says which step writes the file now: ${JSON.stringify(taken.notes)}`);
    await until(() => Promise.resolve(decorator.getLastRangeCountForTest()), (n) => n === 0, 'the file step paints none of the author\'s lines');
  }, symbolPlan));

  // T-22's code review N6, through the real replanner: the store refuses to replace a plan that changed on
  // disk since the press, but only when the replanner hands it the plan the press was made from. No unit
  // test can see the wiring in `src/extension.ts` (the stopped re-review's NF9): this one can.
  test('a plan another window changed while it re-planned is not replaced: refused in words, and the change stands (N6)', () => drive(async (d) => {
    await d.onStep(D);
    d.model.hold();
    await d.press(choose(ROAD));
    await until(d.read, (p) => p.cancel, 'it is re-planning');
    const planFile = path.join(d.build, 'plan.json');
    const edited = `${JSON.stringify({ ...(JSON.parse(d.planBefore.toString('utf8')) as Record<string, unknown>), editedElsewhere: true }, null, 3)}\n`;
    fs.writeFileSync(planFile, edited);
    d.model.release();
    const ended = await until(d.read, (p) => !p.cancel && p.note !== '', 'the press ends');
    assert.match(ended.note, /the plan on disk changed while this re-planned/, `the landing is refused in words; the page says ${JSON.stringify(ended.note)}`);
    assert.equal(fs.readFileSync(planFile, 'utf8'), edited, 'the other window\'s change stands');
    assert.equal(fs.existsSync(path.join(d.build, 'versions')), false, 'and nothing was versioned');
  }));
});
