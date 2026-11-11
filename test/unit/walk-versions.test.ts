// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `saveDivergedPlan` (T-22, AC4): the plan before a divergence is kept, byte for byte, and a crash
 * at any point leaves one whole plan paired with its own code.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFsWriteOps, type FsWriteOps } from '../../src/start/build.js';
import type { PlanLike } from '../../src/walk/model.js';
import { buildDir, loadPlan, loadRequest, saveDivergedPlan } from '../../src/walk/store.js';
import { fixturePlan } from './walk-fixtures.js';

const made: string[] = [];
teardown(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Laid out in a way `writeJsonAtomic` never would, so a re-serialised copy cannot pass. */
function oddlyWritten(plan: PlanLike): string {
  return `${JSON.stringify(plan, null, 3)}\n\n`;
}

function planNaming(tree: string | undefined): PlanLike {
  const plan = fixturePlan();
  return tree === undefined ? plan : { ...plan, divergences: [{ stepId: 'st-2-file-parse', answer: 'alt-1', staleDependents: [], at: 't', tree }] };
}

function setup(before: PlanLike = planNaming(undefined)): { target: string; planFile: string; bytes: string } {
  const target = tempDir('ver-target-');
  const dir = buildDir(target);
  fs.mkdirSync(dir, { recursive: true });
  const repo = tempDir('ver-repo-');
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ idea: '', recreate: true, repo, target, dial: 'manual', referenceRoot: repo }));
  const bytes = oddlyWritten(before);
  const planFile = path.join(dir, 'plan.json');
  fs.writeFileSync(planFile, bytes);
  return { target, planFile, bytes };
}

const versionsOf = (target: string): string => path.join(buildDir(target), 'versions');

suite('saveDivergedPlan — the plan before is kept (AC4)', () => {
  test('version 1 is byte for byte the plan before, and plan.json is the new one', () => {
    const { target, bytes } = setup();
    const next = planNaming('k/new');
    assert.equal(saveDivergedPlan(target, next), 1);
    assert.equal(fs.readFileSync(path.join(versionsOf(target), '1.json'), 'utf8'), bytes);
    assert.deepEqual(loadPlan(target), next);
  });

  test('a second divergence stacks a second version, and the first is not touched', () => {
    const { target, planFile, bytes } = setup();
    const second = planNaming('k/second');
    saveDivergedPlan(target, planNaming('k/first'));
    const firstPlanBytes = fs.readFileSync(planFile, 'utf8');
    assert.equal(saveDivergedPlan(target, second), 2);
    assert.equal(fs.readFileSync(path.join(versionsOf(target), '1.json'), 'utf8'), bytes);
    assert.equal(fs.readFileSync(path.join(versionsOf(target), '2.json'), 'utf8'), firstPlanBytes);
    assert.deepEqual(loadPlan(target), second);
  });

  test('the next number is past the highest there is, and other files in the folder do not count', () => {
    const { target } = setup();
    fs.mkdirSync(versionsOf(target), { recursive: true });
    fs.writeFileSync(path.join(versionsOf(target), '7.json'), 'old');
    fs.writeFileSync(path.join(versionsOf(target), 'notes.txt'), 'x');
    fs.writeFileSync(path.join(versionsOf(target), '12.json.ab12.tmp'), 'x');
    assert.equal(saveDivergedPlan(target, planNaming('k/next')), 8);
  });

  test('an existing version is never overwritten', () => {
    const { target } = setup();
    fs.mkdirSync(versionsOf(target), { recursive: true });
    fs.writeFileSync(path.join(versionsOf(target), '1.json'), 'one');
    saveDivergedPlan(target, planNaming('k/next'));
    assert.equal(fs.readFileSync(path.join(versionsOf(target), '1.json'), 'utf8'), 'one');
  });

  test('a plan that cannot be read is an error, and nothing is written', () => {
    const { target, planFile } = setup();
    fs.rmSync(planFile);
    assert.throws(() => saveDivergedPlan(target, planNaming('k/next')));
    assert.equal(fs.existsSync(versionsOf(target)), false);
    assert.equal(fs.existsSync(planFile), false);
  });
});

suite('saveDivergedPlan — a crash at any point (AC4)', () => {
  /** Every write op, in order, the ones after `crashAt` not happening: the process died there. */
  function crashing(crashAt: number): { ops: FsWriteOps; count: () => number } {
    let n = 0;
    const step = <A extends unknown[]>(real: (...args: A) => void) => (...args: A): void => {
      if (n === crashAt) { n += 1; throw new Error('the process died here'); }
      n += 1;
      real(...args);
    };
    return {
      ops: {
        mkdirSync: step((dir: string) => { realFsWriteOps.mkdirSync(dir); }),
        writeFileSync: step((file: string, data: string | Uint8Array) => { realFsWriteOps.writeFileSync(file, data); }),
        renameSync: step((from: string, to: string) => { realFsWriteOps.renameSync(from, to); }),
      },
      count: () => n,
    };
  }

  function writesInACleanRun(): number {
    const { target } = setup();
    const run = crashing(Number.MAX_SAFE_INTEGER);
    saveDivergedPlan(target, planNaming('k/new'), run.ops);
    return run.count();
  }

  test('there are some writes to crash between', () => {
    assert.ok(writesInACleanRun() >= 6, 'a mkdir, a temp write and a rename, for each of two files');
  });

  for (const [name, before] of [['a first divergence', undefined], ['a later one', 'k/old']] as const) {
    test(`${name}: at every point, the plan loads whole and reads its own tree`, () => {
      const store = tempDir('ver-store-');
      for (const tree of ['k/old', 'k/new']) fs.mkdirSync(path.join(store, tree), { recursive: true });
      const next = planNaming('k/new');
      const seen = new Set<string>();
      for (let crashAt = 0; crashAt < writesInACleanRun(); crashAt += 1) {
        const { target } = setup(planNaming(before));
        assert.throws(() => saveDivergedPlan(target, next, crashing(crashAt).ops), /the process died here/);
        const plan = loadPlan(target);
        const isNew = (plan as { divergences?: Array<{ tree: string }> }).divergences?.at(-1)?.tree === 'k/new';
        assert.deepEqual(plan, isNew ? next : planNaming(before), `crash ${crashAt}: one whole plan, not a mix`);
        const root = loadRequest(target, { plan, store })?.derivedRoot;
        const expected = isNew ? 'k/new' : before;
        assert.equal(root, expected === undefined ? undefined : fs.realpathSync(path.join(store, expected)), `crash ${crashAt}: the plan reads the tree written for it`);
        seen.add(isNew ? 'new' : 'old');
      }
      assert.deepEqual([...seen], ['old'], 'every crash in this run was before the last rename, so the old plan always stood');
    });
  }
});

// T-22's security review, F1: a repository can ship its own `.repo-tour/`, and git recreates a link on
// clone. A write through a planted link lands wherever it points (`kb/wiki/lessons.md`: "A lexical path
// check is not a filesystem check", three times).
suite('saveDivergedPlan — nothing is written through a link (security review F1)', () => {
  test('a versions folder that is a link to somewhere else: refused, and nothing lands there or in the plan', () => {
    const { target, planFile, bytes } = setup();
    const outside = tempDir('ver-outside-');
    fs.symlinkSync(outside, versionsOf(target));
    assert.throws(() => saveDivergedPlan(target, planNaming('k/new')), /versions folder is a link to somewhere else/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written where the link points');
    assert.equal(fs.readFileSync(planFile, 'utf8'), bytes, 'and the plan is as it was');
  });

  test('a versions folder that is a link leading nowhere: refused', () => {
    const { target, planFile, bytes } = setup();
    fs.symlinkSync(path.join(tempDir('ver-gone-'), 'nothing-here'), versionsOf(target));
    assert.throws(() => saveDivergedPlan(target, planNaming('k/new')), /versions folder is a link/);
    assert.equal(fs.readFileSync(planFile, 'utf8'), bytes);
  });

  test('a build folder that is itself a link: refused, and the plan it points at is not touched', () => {
    const target = tempDir('ver-target-');
    const elsewhere = tempDir('ver-elsewhere-');
    const bytes = oddlyWritten(planNaming(undefined));
    fs.writeFileSync(path.join(elsewhere, 'plan.json'), bytes);
    fs.mkdirSync(path.join(target, '.repo-tour'));
    fs.symlinkSync(elsewhere, buildDir(target));
    assert.equal(loadPlan(target).steps.length, planNaming(undefined).steps.length, 'discriminates: the plan reads through the link');
    assert.throws(() => saveDivergedPlan(target, planNaming('k/new')), /build folder is a link to somewhere else/);
    assert.deepEqual(fs.readdirSync(elsewhere), ['plan.json'], 'no versions folder was made there');
    assert.equal(fs.readFileSync(path.join(elsewhere, 'plan.json'), 'utf8'), bytes, 'and the plan there was not replaced');
  });
});

// T-22's code review, N5: `Number` on a name of digits past 2^53 rounds, and two divergences then shared a number.
suite('saveDivergedPlan — a version is never overwritten, whatever is planted (code review N5)', () => {
  test('a version named past 2^53 does not make two divergences write the same number', () => {
    const { target } = setup();
    fs.mkdirSync(versionsOf(target));
    fs.writeFileSync(path.join(versionsOf(target), '9007199254740993.json'), '{}');
    const first = saveDivergedPlan(target, planNaming('k/one'));
    const second = saveDivergedPlan(target, planNaming('k/two'));
    assert.notEqual(first, second, 'a later divergence stacks another version, never overwrites one');
    assert.ok(Number.isSafeInteger(first) && Number.isSafeInteger(second), `numbers that name one file each: ${first}, ${second}`);
    assert.equal(fs.readFileSync(path.join(versionsOf(target), '9007199254740993.json'), 'utf8'), '{}', 'and the planted file is not touched');
  });
});

// T-22's code review, N6: the version must be the plan the press was derived from. If the plan on disk
// changed meanwhile (the folder open in a second window), replacing it would drop that change silently.
suite('saveDivergedPlan — the plan the press was derived from (code review N6)', () => {
  test('a plan that changed on disk since the press is not replaced, and no version is written', () => {
    const before = planNaming(undefined);
    const { target, planFile } = setup(before);
    const changed = oddlyWritten(planNaming('k/elsewhere'));
    fs.writeFileSync(planFile, changed);
    assert.throws(() => saveDivergedPlan(target, planNaming('k/new'), realFsWriteOps, before), /the plan on disk changed while this re-planned/);
    assert.equal(fs.readFileSync(planFile, 'utf8'), changed, 'the other change stands');
    assert.equal(fs.existsSync(versionsOf(target)), false, 'and nothing was versioned');
  });

  test('the plan as it was at the press is replaced, and versioned byte for byte', () => {
    const before = planNaming(undefined);
    const { target, bytes } = setup(before);
    assert.equal(saveDivergedPlan(target, planNaming('k/new'), realFsWriteOps, before), 1);
    assert.equal(fs.readFileSync(path.join(versionsOf(target), '1.json'), 'utf8'), bytes);
  });
});
