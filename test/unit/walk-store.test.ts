// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * src/walk/store.ts — the walk's only conversation with the filesystem, exercised against real
 * temporary directories rather than a stubbed `fs`. That is the point: `plan.json` is
 * repo-tour's own output read back byte for byte, and `progress.json` is the ONE thing this
 * extension writes into a learner's folder, so a test that only proves the module talks to a
 * fake correctly would be testing the fake.
 *
 * Two guarantees here are the ones that bite in the field:
 *
 *   - **A build that has never been usefully walked is not an error.** No `progress.json`, a
 *     `progress.json` that does not parse, and — the case a `try/catch` alone silently
 *     misses — a `progress.json` that parses fine but is not progress at all (`null`, `[]`,
 *     `{}`) must ALL come back as `emptyProgress(plan)`, never a throw. Activation reads this
 *     file before anything is on screen; an exception there takes the whole walk down over a
 *     file the user has never even seen. The lenient direction matters too, and is pinned
 *     below: a genuinely progress-shaped file, including one carrying an unknown future
 *     `schemaVersion`, is read rather than discarded — throwing away real progress is the
 *     worse of the two failures.
 *   - **The write is atomic and leaves nothing behind.** `saveProgress` goes through
 *     `writeJsonAtomic`'s temp-file-plus-rename, so a `progress.json.tmp` lying around in a
 *     learner's repo after a normal save is a bug, not cosmetics — it is the only trace a
 *     half-finished write would leave.
 *
 * Note the signature `loadProgress(target, plan)` — the plan is a SECOND argument, because
 * seeding `emptyProgress`'s `current` on a first-ever load needs to know the first step.
 *
 * The last suite guards `walk-fixtures.ts`'s own on-disk half: `test/walk.test.ts` will reveal
 * these ranges in a real editor and decorate them, so a fixture file that is shorter than the
 * lines its plan claims would fail there, confusingly, instead of here.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentStep, emptyProgress, markDone, setCurrent, type Progress } from '../../src/walk/model.js';
import { buildDir, hasPlan, loadPlan, loadProgress, saveProgress } from '../../src/walk/store.js';
import { fixturePlan, fixtureProgress, writeFixtureTarget } from './walk-fixtures.js';

const madeDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-walk-store-'));
  madeDirs.push(dir);
  return dir;
}

/** A temp folder that looks like a target repo-tour has already planned. */
function fixtureTarget(): string {
  const dir = tmpDir();
  writeFixtureTarget(dir);
  return dir;
}

function progressPath(target: string): string {
  return path.join(buildDir(target), 'progress.json');
}

function lineCount(text: string): number {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

suiteTeardown(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

suite('buildDir / hasPlan / loadPlan — is there a build in this folder at all?', () => {
  test('buildDir is <target>/.repo-tour/build — re-exported by the store so callers need one import', () => {
    const target = tmpDir();
    assert.equal(buildDir(target), path.join(target, '.repo-tour', 'build'));
  });

  test('an empty folder has no plan; the folder the fixture wrote does', () => {
    assert.equal(hasPlan(tmpDir()), false, 'this is the check activation makes before paying for anything else');
    assert.equal(hasPlan(fixtureTarget()), true);
  });

  test('loadPlan reads back exactly the plan that was written — a full round trip through disk', () => {
    assert.deepEqual(loadPlan(fixtureTarget()), fixturePlan());
  });

  test('loadPlan throws when there is no plan — callers are expected to have asked hasPlan first', () => {
    assert.throws(() => loadPlan(tmpDir()), 'a missing plan is exceptional here, unlike missing progress');
  });
});

suite('loadProgress — a build that has never been walked is not an error', () => {
  test('no progress.json at all comes back as emptyProgress, parked on the first step', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    const progress = loadProgress(target, plan);

    assert.deepEqual(progress, emptyProgress(plan));
    assert.equal(progress.current, 'st-1-shape-src');
    assert.equal(fs.existsSync(progressPath(target)), false, 'reading progress must not write one as a side effect');
  });

  test('a corrupt, half-written progress.json comes back as emptyProgress too — never a throw', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    fs.writeFileSync(progressPath(target), '{"schemaVersion":1,"current":"st-2-file-p');

    assert.deepEqual(loadProgress(target, plan), emptyProgress(plan), 'a truncated write must not take activation down');
  });

  // The bug this pins: a `try/catch` around `JSON.parse` catches text that is not JSON, and
  // nothing else. Every value below parses perfectly and is fatal one property access later
  // — and `loadProgress` runs on ACTIVATION, before anything is on screen, so the symptom
  // would be a walk that silently never opens rather than an error anyone could report.
  // `{}` is the likeliest of them in the wild: a repaired truncation, a hand edit, another
  // tool sharing the folder.
  for (const [label, content] of [
    ['null', 'null'],
    ['an array', '[]'],
    ['a bare number', '42'],
    ['a bare string', '"nope"'],
    ['an empty object', '{}'],
    ['a record with no steps', '{"schemaVersion":1,"current":"st-2-file-parse"}'],
    ['a record whose current is the wrong type', '{"schemaVersion":1,"current":7,"steps":{}}'],
  ] as const) {
    test(`valid JSON that is not progress at all (${label}) comes back as emptyProgress`, () => {
      const target = fixtureTarget();
      const plan = loadPlan(target);
      fs.writeFileSync(progressPath(target), content);

      const progress = loadProgress(target, plan);
      assert.deepEqual(progress, emptyProgress(plan));
      // The real failure mode, proven rather than assumed: these are the two reads every
      // caller does immediately, and both threw before the shape guard existed.
      assert.doesNotThrow(() => currentStep(plan, progress));
      assert.doesNotThrow(() => Object.keys(progress.steps));
    });
  }

  test('a record that IS progress-shaped is returned as it stands (discriminates against the guard being too greedy)', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    const real: Progress = { schemaVersion: 1, current: 'st-3-symbol-handle', steps: { 'st-1-shape-src': { status: 'done' } } };
    fs.writeFileSync(progressPath(target), JSON.stringify(real));

    assert.deepEqual(loadProgress(target, plan), real, 'the guard must not throw away a perfectly good file');
  });

  test('an unknown future schemaVersion is read leniently, not discarded', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    fs.writeFileSync(progressPath(target), '{"schemaVersion":2,"current":"st-2-file-parse","steps":{},"somethingNew":true}');

    // Rejecting it would silently throw away a learner's real progress; reading it costs
    // nothing, because the fields this walk touches are exactly the ones just validated.
    assert.equal(loadProgress(target, plan).current, 'st-2-file-parse');
  });

  test('the plan is what seeds the starting position, so a different plan starts somewhere else', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    const shortened = { ...plan, steps: plan.steps.filter((s) => s.ordinal >= 3) };

    assert.equal(loadProgress(target, plan).current, 'st-1-shape-src');
    assert.equal(loadProgress(target, shortened).current, 'st-3-symbol-handle');
  });
});

suite('saveProgress — this extension\'s one write into a learner\'s folder', () => {
  test('what was saved is what loads back', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    const progress = fixtureProgress(plan);
    saveProgress(target, progress);

    assert.deepEqual(loadProgress(target, plan), progress);
  });

  test('the atomic write leaves no .tmp file behind', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    saveProgress(target, fixtureProgress(plan));
    saveProgress(target, markDone(fixtureProgress(plan), 'st-2-file-parse'));

    const left = fs.readdirSync(buildDir(target)).sort();
    assert.deepEqual(left, ['plan.json', 'progress.json'], 'temp + rename must leave exactly these two files');
    assert.ok(!left.some((name) => name.endsWith('.tmp')), 'a progress.json.tmp in a learner\'s repo is a bug, not cosmetics');
  });

  test('the reload drill (AC4): a fresh read from disk alone restores the same step and statuses', () => {
    const target = fixtureTarget();
    saveProgress(target, setCurrent(fixtureProgress(loadPlan(target)), 'st-4-symbol-render'));

    // Nothing carried over in memory — exactly what a reopened window has to work from.
    const plan = loadPlan(target);
    const progress = loadProgress(target, plan);
    assert.equal(progress.current, 'st-4-symbol-render');
    assert.equal(currentStep(plan, progress)?.target.file, 'src/api/render.ts');
    assert.deepEqual(progress.steps['st-1-shape-src'], { status: 'done' }, 'per-step status survives the reload, not just the position');
    assert.deepEqual(progress.steps['st-2-file-parse'], { status: 'pending', dial: 'scaffolded' }, 'and so does a per-step dial (T-5 reads it)');
  });
});

suite('the fixture target folder — what test/walk.test.ts will open for real', () => {
  test('every step\'s target exists, with enough lines for the ranges its plan claims', () => {
    const target = fixtureTarget();
    for (const step of loadPlan(target).steps) {
      const abs = path.join(target, step.target.file);
      assert.ok(fs.existsSync(abs), `${step.id} points at ${step.target.file}, which the fixture must write`);

      if (step.kind === 'shape') {
        // A shape step points at a DIRECTORY, exactly as repo-tour's real plans open — which
        // is why fileExists alone cannot decide whether an editor can be revealed.
        assert.ok(fs.statSync(abs).isDirectory(), `${step.id} is a shape step, so ${step.target.file} should be a directory`);
        continue;
      }

      const claimed = Math.max(
        step.target.endLine ?? 0,
        ...step.scaffold.loadBearing.map((r) => r.endLine),
        ...step.scaffold.boilerplate.map((r) => r.endLine),
      );
      const lines = lineCount(fs.readFileSync(abs, 'utf8'));
      assert.ok(lines >= claimed, `${step.target.file} has ${lines} lines but ${step.id} claims up to line ${claimed}`);
    }
  });
});
