// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-92 (a): every read of a TAUGHT step's reference file refuses what the reproduce copy
 * withholds (`withheldReason`, T-12), by the name the plan spells and by the name the file
 * resolves to, and each refusal is a sentence.
 *
 * The four reads, each against the real core and a real disk: the dial's writer (`planWrite`,
 * scaffolded and automated), the outline (`fileShape`, manual), the check (`runCheck`, with
 * `checkRefusal` giving the session its sentence) and the tutor's diff (`tutorContext`). Before
 * T-92 the name rule ran only over `plan.reproduce`, so a plan that named `.env` as a taught
 * step had it copied into the learner's folder, outlined, parsed and diffed to a model.
 *
 * Every file a refused read must never touch carries a MARKER, and the tutor's tests look for
 * the marker in everything the tutor would be told, so "nothing was sent" is checked against the
 * bytes rather than against what the code believes it did.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { checkRefusal, runCheck } from '../../src/dial/check.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { fileShape, isRefusal, planWrite, type WritePlan } from '../../src/dial/writer.js';
import { realGit } from '../../src/start/build.js';
import { WITHHELD_FROM_TUTOR, tutorContext } from '../../src/tutor/context.js';
import type { PlanLike, StepLike } from '../../src/walk/model.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

let core: DialCore;
const made: string[] = [];

suiteSetup(async function () {
  this.timeout(60_000);
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  core = dialCoreFor(loaded.loaded);
});

suiteTeardown(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(root: string, rel: string, data: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

/** What the author's withheld files hold; none of it may leave the reference by any read. */
const AUTH_MARKER = 'AUTHOR-SECRET-7f3a';
const ENV_MARKER = 'ENV-SECRET-91bd';
const OUTSIDE_MARKER = 'OUTSIDE-SECRET-c2e0';
/** What the learner's own copy of a withheld file holds; the tutor may not send it either. */
const LEARNER_MARKER = 'LEARNER-SECRET-5d18';

const AUTH_TS = `import { createHash } from 'node:crypto';\n\nexport function sign(user: string): string {\n  return createHash('sha256').update('${AUTH_MARKER}' + user).digest('hex');\n}\n`;
const OK_TS = `import { join } from 'node:path';\n\nexport function where(name: string): string {\n  return join('/srv', name);\n}\n`;

/**
 * The reference: a source file whose NAME is withheld (`src/auth.ts`), a `.env` a tampered plan
 * names as a step, an innocent name that is a link to it (`src/config.ts -> ../.env`), a link
 * out of the reference (`src/escape.ts`), and an ordinary file as the control.
 */
function reference(): string {
  const root = tmpDir('t92-reference-');
  write(root, 'src/auth.ts', AUTH_TS);
  write(root, '.env', `API_KEY=${ENV_MARKER}\n`);
  write(root, 'src/ok.ts', OK_TS);
  fs.symlinkSync('../.env', path.join(root, 'src', 'config.ts'));
  const outside = tmpDir('t92-outside-');
  write(outside, 'outside.ts', `export const leaked = '${OUTSIDE_MARKER}';\n`);
  fs.symlinkSync(path.join(outside, 'outside.ts'), path.join(root, 'src', 'escape.ts'));
  return root;
}

function fileStep(file: string, loadBearing: Array<{ startLine: number; endLine: number }> = []): StepLike {
  return {
    id: `st-file-${file}`,
    ordinal: 1,
    kind: 'file',
    chapter: 'src',
    target: { file },
    decision: {
      question: `why is ${file} shaped this way?`,
      options: [{ id: 'author', label: 'What the author did', consequence: 'as written', taken: true }],
      authorChoice: 'author',
      chosen: 'author',
      why: 'because that is what the author did',
      whySource: 'interpret',
    },
    scaffold: { loadBearing, boilerplate: [] },
    dependsOn: [],
    witness: { sha: null, date: null, subject: null },
  };
}

function planOf(step: StepLike): PlanLike {
  return { schemaVersion: 1, chapters: [{ key: 'src', title: 'src', subtitle: '', tierPath: 'src' }], steps: [step] };
}

function refusalOf(result: WritePlan, what: string): string {
  if (result === null) assert.fail(`${what}: expected a refusal, got null (nothing to write)`);
  if (!isRefusal(result)) assert.fail(`${what}: the withheld file was planned for writing into ${result.path}`);
  return result.refused;
}

/** Every file under `dir`, relative. The empty list is what "nothing was written" means. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

/** A withheld taught step, three ways: by its own name, as `.env` itself, and through a link to it. */
const WITHHELD: Array<[string, string, RegExp]> = [
  ['a source file whose name is withheld', 'src/auth.ts', /src\/auth\.ts.*credentials/],
  ['a .env named as a taught step', '.env', /\.env.*credentials/],
  ['an innocent name that is a link to .env', 'src/config.ts', /src\/config\.ts.*link to a file that.*credentials/],
];

suite('T-92 (a): the dial\'s writer refuses a withheld taught file, in a sentence', () => {
  for (const [label, file, sentence] of WITHHELD) {
    test(`automated: ${label} is not copied, and nothing is written`, () => {
      const target = tmpDir('t92-target-');
      const step = fileStep(file);
      const refused = refusalOf(planWrite(step, 'automated', reference(), target, planOf(step), core), label);
      assert.match(refused, sentence);
      assert.deepEqual(filesUnder(target), [], 'a refused write left something in the learner\'s folder');
    });
  }

  test('scaffolded: a withheld source file is not stubbed from the reference either', () => {
    const target = tmpDir('t92-target-');
    const step = fileStep('src/auth.ts', [{ startLine: 3, endLine: 5 }]);
    const refused = refusalOf(planWrite(step, 'scaffolded', reference(), target, planOf(step), core), 'scaffolded');
    assert.match(refused, /src\/auth\.ts.*credentials/);
    assert.doesNotMatch(refused, new RegExp(AUTH_MARKER), 'the refusal quoted the file it refused to read');
    assert.deepEqual(filesUnder(target), []);
  });

  test('the control: an ordinary taught file is still copied byte for byte', () => {
    const target = tmpDir('t92-target-');
    const step = fileStep('src/ok.ts');
    const planned = planWrite(step, 'automated', reference(), target, planOf(step), core);
    assert.ok(planned !== null && !isRefusal(planned), `the ordinary file was refused: ${JSON.stringify(planned)}`);
    assert.equal(planned.content, OK_TS);
  });
});

suite('T-92 (a): the outline is not read off a withheld file, and says so', () => {
  for (const [label, file, sentence] of WITHHELD) {
    test(`manual: ${label} has no outline, and the shape carries why`, () => {
      const shape = fileShape(reference(), fileStep(file, [{ startLine: 3, endLine: 3 }]));
      assert.deepEqual([shape.signatures, shape.imports], [[], []], 'lines were lifted off a withheld file');
      assert.ok(shape.refused !== undefined, 'an empty outline with no reason reads as "this file declares nothing"');
      assert.match(shape.refused, sentence);
    });
  }

  test('the control: an ordinary file\'s outline is unchanged and carries no refusal', () => {
    const shape = fileShape(reference(), fileStep('src/ok.ts', [{ startLine: 3, endLine: 5 }]));
    assert.deepEqual(shape.imports, ["import { join } from 'node:path';"]);
    assert.deepEqual(shape.signatures, ['export function where(name: string): string {']);
    assert.equal(shape.refused, undefined);
  });
});

suite('T-92 (a): the check does not parse a withheld or escaping reference file', () => {
  for (const [label, file, sentence] of [
    ...WITHHELD,
    ['a link out of the reference', 'src/escape.ts', /src\/escape\.ts.*leaves the reference repository through a symlink/],
  ] as Array<[string, string, RegExp]>) {
    test(`${label}: no comparison, and a sentence for the page`, async () => {
      const ref = reference();
      const target = tmpDir('t92-target-');
      write(target, file, 'export const mine = 1;\n');
      const step = fileStep(file);
      const outcome = await runCheck(core, ref, target, step);
      assert.equal(outcome, null, `the check compared against the reference file: ${JSON.stringify(outcome?.report ?? null)}`);
      const said = checkRefusal(ref, step);
      assert.ok(said !== null, 'refused in silence: the session would say "has not been created" about a file that is there');
      assert.match(said, sentence);
    });
  }

  test('the control: an ordinary file is still compared, and nothing is refused', async () => {
    const ref = reference();
    const target = tmpDir('t92-target-');
    write(target, 'src/ok.ts', OK_TS);
    const step = fileStep('src/ok.ts');
    const outcome = await runCheck(core, ref, target, step);
    assert.equal(outcome?.report.ok, true, 'the ordinary check stopped working');
    assert.equal(checkRefusal(ref, step), null);
  });
});

suite('T-92 (a): the tutor is sent neither copy of a withheld file', () => {
  for (const [label, file] of WITHHELD) {
    test(`${label}: no diff, the reason instead, and no marker anywhere in what the tutor is told`, async () => {
      const ref = reference();
      const target = tmpDir('t92-target-');
      write(target, file, `const mine = '${LEARNER_MARKER}';\n`);
      const ctx = await tutorContext(fileStep(file), ref, target, realGit);
      const told = JSON.stringify(ctx);
      for (const marker of [AUTH_MARKER, ENV_MARKER, LEARNER_MARKER]) {
        assert.ok(!told.includes(marker), `${marker} would have been sent to the provider`);
      }
      assert.equal(ctx.build?.learnerDiff, WITHHELD_FROM_TUTOR);
    });
  }

  test('the learner\'s own copy that is a link to their .env is not sent either', async () => {
    const ref = reference();
    const target = tmpDir('t92-target-');
    write(target, '.env', `TOKEN=${LEARNER_MARKER}\n`);
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    fs.symlinkSync('../.env', path.join(target, 'src', 'ok.ts'));
    const ctx = await tutorContext(fileStep('src/ok.ts'), ref, target, realGit);
    assert.ok(!JSON.stringify(ctx).includes(LEARNER_MARKER), 'the learner\'s .env would have been sent to the provider');
    assert.equal(ctx.build?.learnerDiff, WITHHELD_FROM_TUTOR);
  });

  test('the control: an ordinary file\'s diff is still sent', async () => {
    const ref = reference();
    const target = tmpDir('t92-target-');
    write(target, 'src/ok.ts', OK_TS.replace('/srv', '/opt'));
    const ctx = await tutorContext(fileStep('src/ok.ts'), ref, target, realGit);
    assert.match(ctx.build?.learnerDiff ?? '', /\/opt/);
  });
});
