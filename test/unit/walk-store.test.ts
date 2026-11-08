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
import { currentStep, emptyProgress, markDone, setCurrent, treeModel, type Progress } from '../../src/walk/model.js';
import { buildDir, hasPlan, loadPlan, loadProgress, loadRequest, saveProgress } from '../../src/walk/store.js';
import { DEFAULT_DIAL } from '../../src/start/request.js';
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

function planPath(target: string): string {
  return path.join(buildDir(target), 'plan.json');
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

suite('loadPlan — a plan that is not a plan fails LOUDLY, not deep inside a render', () => {
  // The asymmetry with `loadProgress` above is deliberate and is the whole point. Missing or
  // malformed PROGRESS is an ordinary state — a build nobody has walked yet — so it degrades
  // to `emptyProgress`. A malformed PLAN is not: there is nothing to walk, and pretending
  // otherwise produced the worst version of the failure. Before the shape check, `{}` reached
  // `orderedSteps` as "plan.steps is not iterable" and `null` reached `treeModel` as "Cannot
  // read properties of null" — thrown from inside a render, out of a `void`ed activation
  // promise, where nothing was listening. The walk silently never opened, and the panel said
  // "No tutorial in this folder yet" with a plan.json sitting right there.
  for (const [label, content] of [
    ['an empty object', '{}'],
    ['null', 'null'],
    ['an array', '[]'],
    ['steps present but chapters missing', '{"steps":[]}'],
    ['chapters present but steps missing', '{"chapters":[]}'],
    ['steps that is not an array', '{"chapters":[],"steps":{}}'],
  ] as const) {
    test(`${label} throws a message written for a person to read`, () => {
      const target = fixtureTarget();
      fs.writeFileSync(planPath(target), content);
      assert.throws(() => loadPlan(target), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /not a build plan/, 'the message has to explain itself — it is shown in the panel');
        return true;
      });
    });
  }

  test('unparseable JSON still throws (the read itself is allowed to fail)', () => {
    const target = fixtureTarget();
    fs.writeFileSync(planPath(target), '{"chapters":[],"steps":[');
    assert.throws(() => loadPlan(target));
  });

  test('a real plan loads unchanged (discriminates against the guard being too greedy)', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.chapters.length, 2);
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

suite('loadRequest — the reference root and the GLOBAL dial (T-5 AC1)', () => {
  // Nothing read this file until T-5. `repo` is where scaffolded/automated mode copy the
  // learner's files FROM — the plan records decisions, never contents — and `dial` is the
  // global setting T-4 rendered but never consulted, which is why the status bar falls back
  // to "manual" for any step without a per-step override.
  function writeRequest(target: string, body: unknown): void {
    fs.writeFileSync(path.join(buildDir(target), 'request.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }

  test('a real request round-trips, carrying the RESOLVED reference root and the global dial', () => {
    const target = fixtureTarget();
    const ref = tmpDir();
    writeRequest(target, { idea: '', recreate: true, repo: ref, referenceRoot: ref, target, dial: 'automated' });
    const req = loadRequest(target);
    assert.equal(req?.referenceRoot, ref);
    assert.equal(req?.dial, 'automated');
  });

  test('a GitHub URL in `repo` is not a path — `referenceRoot` is what gets used', () => {
    // The bug (T-5 security review, finding 2): for a URL build, `repo` is the URL and the
    // clone path used to be computed and thrown away. Everything downstream then resolved the
    // URL as a relative path and refused one read at a time, silently.
    const target = fixtureTarget();
    const clone = tmpDir();
    writeRequest(target, { idea: '', recreate: true, repo: 'https://github.com/o/n', referenceRoot: clone, target, dial: 'automated' });
    assert.equal(loadRequest(target)?.referenceRoot, clone);
  });

  test('a reference root that is not an existing directory is refused ONCE, here', () => {
    // Rather than failing one read at a time, deeper in, where each failure looks like an
    // ordinary "that file is not written yet".
    const target = fixtureTarget();
    for (const root of ['https://github.com/o/n', '/nowhere/at/all', planPath(target)]) {
      writeRequest(target, { idea: '', recreate: true, repo: root, referenceRoot: root, target, dial: 'manual' });
      assert.equal(loadRequest(target), null, `${root} is not a usable reference root`);
    }
  });

  test('a request written before `referenceRoot` existed falls back to `repo`', () => {
    // Correct precisely because a build old enough to lack the field could only have been a
    // local path — the URL case is what introduced the field.
    const target = fixtureTarget();
    const ref = tmpDir();
    writeRequest(target, { idea: '', recreate: true, repo: ref, target, dial: 'scaffolded' });
    assert.equal(loadRequest(target)?.referenceRoot, ref);
  });

  test('no request.json at all is null — a walkable tutorial that simply cannot be written into', () => {
    assert.equal(loadRequest(fixtureTarget()), null);
  });

  for (const [label, body] of [
    ['unparseable', '{"repo":'],
    ['valid JSON that is not a record', 'null'],
    ['an array', '[]'],
    ['a request with no repo', '{"dial":"automated"}'],
    ['a repo of the wrong type', '{"repo":42,"dial":"automated"}'],
  ] as const) {
    test(`${label} is null, never a throw on the interaction path`, () => {
      const target = fixtureTarget();
      writeRequest(target, body);
      assert.equal(loadRequest(target), null);
    });
  }

  test('a dial outside DIALS falls back to the default rather than being trusted', () => {
    const target = fixtureTarget();
    const ref = tmpDir();
    writeRequest(target, { repo: ref, referenceRoot: ref, dial: 'turbo' });
    // "manual" is the only fallback that cannot overstate what has happened to the
    // learner's files, so a hand-edited or future value must not survive as itself.
    assert.equal(loadRequest(target)?.dial, DEFAULT_DIAL);
  });
});

suite('a malformed check verdict is dropped, not drawn as a failure (T-5 code review, finding 9)', () => {
  // `TreeStepNode.check` is three-valued so that a step nobody has reached looks different
  // from the one they got wrong. `treeModel` asks `recorded.ok ? 'pass' : 'fail'`, so a
  // malformed `check` — `ok` of `undefined`, which is falsy — would draw ✗ on a step nobody
  // ever checked. That is the exact distinction the field was added to protect, arriving
  // through the file this codebase already treats as untrusted.
  for (const [label, check] of [
    ['a bare string', '"passed"'],
    ['a boolean', 'true'],
    ['missing `ok`', '{"at":"2026-01-01"}'],
    ['an `ok` of the wrong type', '{"ok":"yes","at":"2026-01-01"}'],
    ['missing `at`', '{"ok":true}'],
    ['null', 'null'],
  ] as const) {
    test(`${label} is dropped`, () => {
      const target = fixtureTarget();
      const plan = loadPlan(target);
      fs.writeFileSync(progressPath(target), `{"schemaVersion":1,"current":"st-2-file-parse","steps":{"st-2-file-parse":{"status":"done","check":${check}}}}`);

      const progress = loadProgress(target, plan);
      assert.equal(progress.steps['st-2-file-parse']?.check, undefined, 'an unreadable verdict is no verdict');
      // And the proof it is dropped rather than the whole file refused: the position and the
      // status survive, which are worth far more to the learner than the verdict was.
      assert.equal(progress.current, 'st-2-file-parse');
      assert.equal(progress.steps['st-2-file-parse']?.status, 'done');
      assert.equal(treeModel(plan, progress).flatMap((c) => c.steps).find((n) => n.id === 'st-2-file-parse')?.check, undefined);
    });
  }

  test('the learner\'s choice survives a malformed verdict beside it (T-21) — a divergence is never undone by a load', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    fs.writeFileSync(progressPath(target), '{"schemaVersion":1,"current":"st-4-symbol-render","steps":{"st-4-symbol-render":{"status":"pending","chosen":"stream","check":"garbage"}}}');
    assert.equal(loadProgress(target, plan).steps['st-4-symbol-render']?.chosen, 'stream');
  });

  test('a saved choice loads back exactly — the reload drill for T-21', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    const progress = { ...loadProgress(target, plan), steps: { 'st-4-symbol-render': { status: 'pending' as const, chosen: 'template-string' } } };
    saveProgress(target, progress);
    assert.equal(loadProgress(target, plan).steps['st-4-symbol-render']?.chosen, 'template-string');
  });

  test('a well-formed verdict survives untouched (discriminates against dropping everything)', () => {
    const target = fixtureTarget();
    const plan = loadPlan(target);
    fs.writeFileSync(progressPath(target), '{"schemaVersion":1,"current":"st-2-file-parse","steps":{"st-2-file-parse":{"status":"done","dial":"automated","check":{"ok":false,"at":"2026-01-01"}}}}');

    const progress = loadProgress(target, plan);
    assert.deepEqual(progress.steps['st-2-file-parse'], { status: 'done', dial: 'automated', check: { ok: false, at: '2026-01-01' } });
    assert.equal(treeModel(plan, progress).flatMap((c) => c.steps).find((n) => n.id === 'st-2-file-parse')?.check, 'fail');
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
