// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-92 (b): a reference root is believed only on the build's own record.
 *
 * `request.json` sits in the learner's folder, and a cloned repository can ship its own
 * `.repo-tour/build/` with one in it naming any folder on the disk as the reference. Everything
 * the dial copies, the outline shows, the check parses and the tutor sends is read from that
 * folder, so "the root the build resolved" needs a record the repository cannot write: the
 * extension's own storage, keyed by the target's real path, bound to the exact `request.json`
 * bytes the build wrote, written by the build. These tests drive `src/walk/provenance.ts` against
 * real temp folders, because the whole question is about where things really are on a disk.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NOT_BUILT_HERE, NOT_THE_BUILDS_REQUEST, NOT_THE_BUILT_ROOT, REFERENCE_GONE,
  believeRequest, builtRecordFile, isWithheld, recordBuiltReference,
} from '../../src/walk/provenance.js';
import { buildDir, loadRequest } from '../../src/walk/store.js';
import { writeFixtureTarget } from './walk-fixtures.js';

const made: string[] = [];

function tmpDir(prefix = 'build-tutorials-provenance-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

suiteTeardown(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function requestFile(target: string): string {
  return path.join(buildDir(target), 'request.json');
}

/** A target with a plan in it, and a `request.json` naming `root` as its reference. */
function tutorialNaming(root: string, target: string = tmpDir(), extra: Record<string, unknown> = {}): string {
  writeFixtureTarget(target);
  fs.writeFileSync(requestFile(target), JSON.stringify({
    idea: '', recreate: true, repo: root, referenceRoot: root, target, dial: 'automated', ...extra,
  }));
  return target;
}

function believed(target: string, storage: string): ReturnType<typeof believeRequest> {
  return believeRequest(target, storage, loadRequest);
}

function withheld(answer: ReturnType<typeof believeRequest>, what: string): string {
  assert.ok(answer !== null && isWithheld(answer), `${what}: believed ${JSON.stringify(answer)}`);
  return answer.withheld;
}

suite('T-92: a reference root is believed only on the build\'s own record', () => {
  test('a root the build recorded for this folder is believed, as the folder it really is', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    const answer = believed(target, storage);
    assert.ok(answer !== null && !isWithheld(answer), `the build's own root must be believed, got ${JSON.stringify(answer)}`);
    assert.equal(answer.referenceRoot, fs.realpathSync(ref));
    assert.equal(answer.dial, 'automated', 'everything else the request says still stands');
  });

  test('a folder whose .repo-tour/ came with it (no record) is not believed, and the answer says why', () => {
    const storage = tmpDir();
    const target = tutorialNaming(tmpDir());
    const answer = believed(target, storage);
    assert.equal(withheld(answer, 'a root nobody built here'), NOT_BUILT_HERE);
    assert.equal('referenceRoot' in (answer ?? {}), false, 'an unbelieved root must not ride along for a reader to pick up');
  });

  test('the sentences say why, what does not happen, and what to do (into an EMPTY folder)', () => {
    assert.match(NOT_BUILT_HERE, /has no record of building this tutorial/);
    assert.match(NOT_BUILT_HERE, /earlier version of Build Tutorials/);
    for (const sentence of [NOT_BUILT_HERE, NOT_THE_BUILDS_REQUEST, NOT_THE_BUILT_ROOT, REFERENCE_GONE]) {
      assert.match(sentence, /nothing is written for you, checked, or sent to the tutor/);
      assert.match(sentence, /build it again into an empty folder with Build Tutorials: Start/);
    }
  });

  test('a path where a tutorial was once built, reused by a cloned repository naming the old root, is not believed (security review F1)', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    // The folder goes, and a repository lands at the same path shipping its own .repo-tour/, whose
    // request names the old root (relatively, against the host's working directory) with the dial up.
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target);
    const here = process.cwd();
    process.chdir(path.dirname(ref));
    try {
      tutorialNaming(path.basename(ref), target, { idea: 'shipped', target: '/nowhere' });
      assert.equal(withheld(believed(target, storage), 'a shipped request riding on an old record'), NOT_THE_BUILDS_REQUEST);
    } finally {
      process.chdir(here);
    }
  });

  test('the build\'s request changed since the build is not believed either, its dial with it', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref, tmpDir(), { dial: 'manual' });
    recordBuiltReference(storage, target, ref);
    const raw = JSON.parse(fs.readFileSync(requestFile(target), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(requestFile(target), JSON.stringify({ ...raw, dial: 'automated' }));
    assert.equal(withheld(believed(target, storage), 'an edited request'), NOT_THE_BUILDS_REQUEST);
  });

  test('with no record, the root the repository chose is never resolved or stat\'d (security review N5)', () => {
    const storage = tmpDir();
    const chosen = path.join(os.tmpdir(), `t92-repository-chose-${process.pid}-${Date.now()}`);
    const target = tutorialNaming(chosen);
    const touched: string[] = [];
    const real = { statSync: fs.statSync, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, existsSync: fs.existsSync };
    const spy = <F extends (...args: never[]) => unknown>(name: keyof typeof real, fn: F): F => ((...args: Parameters<F>) => {
      touched.push(`${name} ${String(args[0])}`);
      return fn(...args);
    }) as F;
    const patched = fs as unknown as Record<string, unknown>;
    patched['statSync'] = spy('statSync', real.statSync);
    patched['lstatSync'] = spy('lstatSync', real.lstatSync);
    patched['realpathSync'] = spy('realpathSync', real.realpathSync);
    patched['existsSync'] = spy('existsSync', real.existsSync);
    let answer: ReturnType<typeof believeRequest>;
    try {
      answer = believed(target, storage);
    } finally {
      Object.assign(patched, real);
    }
    assert.equal(withheld(answer, 'no record'), NOT_BUILT_HERE);
    assert.deepEqual(touched.filter((call) => call.includes(chosen)), [], 'the repository-chosen root was touched');
  });

  test('a request naming another root than the one recorded is not believed', () => {
    const storage = tmpDir();
    const recorded = tmpDir();
    const claimed = tmpDir();
    const target = tutorialNaming(claimed);
    recordBuiltReference(storage, target, recorded);
    assert.equal(withheld(believed(target, storage), 'a root other than the recorded one'), NOT_THE_BUILT_ROOT);
  });

  test('a recorded root replaced by a link since the build is not believed', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    fs.renameSync(ref, `${ref}-moved`);
    made.push(`${ref}-moved`);
    fs.symlinkSync(tmpDir(), ref, 'dir');
    assert.equal(withheld(believed(target, storage), 'a root swapped for a link'), NOT_THE_BUILT_ROOT);
  });

  test('a recorded root that is gone says so', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    fs.rmSync(ref, { recursive: true, force: true });
    assert.equal(withheld(believed(target, storage), 'a root that is gone'), REFERENCE_GONE);
  });

  test('another tutorial\'s record does not vouch for this folder', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    recordBuiltReference(storage, tutorialNaming(ref), ref);
    assert.equal(withheld(believed(tutorialNaming(ref), storage), 'a record for another folder vouched for this one'), NOT_BUILT_HERE);
  });

  test('a link to the recorded root is the same root, and a target reached through a link is the same tutorial', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const links = tmpDir();
    const refLink = path.join(links, 'ref');
    fs.symlinkSync(ref, refLink, 'dir');
    const target = tutorialNaming(refLink);
    const targetLink = path.join(links, 'target');
    fs.symlinkSync(target, targetLink, 'dir');
    recordBuiltReference(storage, targetLink, ref);
    const answer = believed(target, storage);
    assert.ok(answer !== null && !isWithheld(answer), `the same folders by other names were refused: ${JSON.stringify(answer)}`);
    assert.equal(answer.referenceRoot, fs.realpathSync(ref));
  });

  test('a built/ folder that is a link is refused: nothing is written through it, and nothing is believed from it', () => {
    const storage = tmpDir();
    const outside = tmpDir();
    fs.symlinkSync(outside, path.join(storage, 'built'), 'dir');
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    assert.throws(() => recordBuiltReference(storage, target, ref), /link/);
    assert.deepEqual(fs.readdirSync(outside), [], 'a record was written through the link');
    // A record planted where the link leads, otherwise a perfect one, is not read either.
    fs.writeFileSync(path.join(outside, path.basename(builtRecordFile(storage, target))), JSON.stringify({
      version: 1, target: fs.realpathSync(target), referenceRoot: fs.realpathSync(ref),
      request: createHash('sha256').update(fs.readFileSync(requestFile(target))).digest('hex'), builtAt: new Date().toISOString(),
    }));
    withheld(believed(target, storage), 'a record behind a link');
  });

  test('a request.json that is a link is not the build\'s', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    const elsewhere = path.join(tmpDir(), 'request.json');
    fs.copyFileSync(requestFile(target), elsewhere);
    fs.rmSync(requestFile(target));
    fs.symlinkSync(elsewhere, requestFile(target));
    assert.equal(withheld(believed(target, storage), 'a linked request.json'), NOT_THE_BUILDS_REQUEST);
  });

  test('no request.json at all is no request, record or not', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    fs.rmSync(requestFile(target));
    assert.equal(believed(target, storage), null);
  });

  // Each planted record is otherwise the build's own, so exactly one check refuses it.
  for (const [label, plant] of [
    ['not JSON', (): string => '{"version":'],
    ['not a record', (): string => '[]'],
    ['a record for another folder', (good: Record<string, unknown>): string => JSON.stringify({ ...good, target: '/elsewhere' })],
    ['a record with no root', (good: Record<string, unknown>): string => JSON.stringify({ ...good, referenceRoot: undefined })],
    ['a record with no request', (good: Record<string, unknown>): string => JSON.stringify({ ...good, request: undefined })],
    ['a record of another version', (good: Record<string, unknown>): string => JSON.stringify({ ...good, version: 2 })],
    ['far too large to be a record', (good: Record<string, unknown>): string => JSON.stringify({ ...good, pad: 'x'.repeat(200_000) })],
  ] as Array<[string, (good: Record<string, unknown>) => string]>) {
    test(`a record that is ${label} is not believed`, () => {
      const storage = tmpDir();
      const ref = tmpDir();
      const target = tutorialNaming(ref);
      recordBuiltReference(storage, target, ref);
      const file = builtRecordFile(storage, target);
      fs.writeFileSync(file, plant(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>));
      withheld(believed(target, storage), label);
    });
  }

  test('a record that is a link to a good record is not believed', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    recordBuiltReference(storage, target, ref);
    const file = builtRecordFile(storage, target);
    const copy = path.join(tmpDir(), 'record.json');
    fs.copyFileSync(file, copy);
    fs.rmSync(file);
    fs.symlinkSync(copy, file);
    withheld(believed(target, storage), 'a linked record');
  });

  test('the walk asks storage given as an absolute path only', () => {
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    withheld(believeRequest(target, 'relative/storage', loadRequest), 'a relative storage root');
  });

  test('the storage root must be an absolute path, or nothing is recorded', () => {
    const ref = tmpDir();
    const target = tutorialNaming(ref);
    // Run from an empty folder, so a relative root that WAS used would land here, not in the tree.
    const here = process.cwd();
    const box = tmpDir();
    process.chdir(box);
    try {
      assert.throws(() => recordBuiltReference('relative/storage', target, ref), /absolute/);
      assert.deepEqual(fs.readdirSync(box), [], 'a relative storage root was created against the working directory');
    } finally {
      process.chdir(here);
    }
  });
});
