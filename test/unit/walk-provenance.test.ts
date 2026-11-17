// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-92 (b): a reference root is believed only on the build's own record.
 *
 * `request.json` sits in the learner's folder, and a cloned repository can ship its own
 * `.repo-tour/build/` with one in it naming any folder on the disk as the reference. Everything
 * the dial copies, the outline shows, the check parses and the tutor sends is read from that
 * folder, so "the root the build resolved" needs a record the repository cannot write: the
 * extension's own storage, keyed by the target's real path, written by the build. These tests
 * drive `src/walk/provenance.ts` against real temp folders, because the whole question is about
 * where things really are on a disk.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NOT_BUILT_HERE, NOT_THE_BUILT_ROOT, believeRequest, builtRecordFile, isWithheld, recordBuiltReference,
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

/** A target with a plan in it, and a `request.json` naming `root` as its reference. */
function tutorialNaming(root: string, target: string = tmpDir()): string {
  writeFixtureTarget(target);
  fs.writeFileSync(
    path.join(buildDir(target), 'request.json'),
    JSON.stringify({ idea: '', recreate: true, repo: root, referenceRoot: root, target, dial: 'automated' }),
  );
  return target;
}

function believed(target: string, storage: string): ReturnType<typeof believeRequest> {
  return believeRequest(loadRequest(target), target, storage);
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
    assert.ok(answer !== null && isWithheld(answer), `a root nobody built here was believed: ${JSON.stringify(answer)}`);
    assert.equal(answer.withheld, NOT_BUILT_HERE);
    assert.equal('referenceRoot' in answer, false, 'an unbelieved root must not ride along for a reader to pick up');
  });

  test('the sentence says why, what does not happen, and what to do', () => {
    assert.match(NOT_BUILT_HERE, /not built in this editor/);
    assert.match(NOT_BUILT_HERE, /nothing is written for you, checked, or sent to the tutor/);
    assert.match(NOT_BUILT_HERE, /Build Tutorials: Start/);
    assert.match(NOT_THE_BUILT_ROOT, /different reference repository/);
  });

  test('a request naming another root than the one recorded is not believed', () => {
    const storage = tmpDir();
    const recorded = tmpDir();
    const claimed = tmpDir();
    const target = tutorialNaming(claimed);
    recordBuiltReference(storage, target, recorded);
    const answer = believed(target, storage);
    assert.ok(answer !== null && isWithheld(answer), `a root other than the recorded one was believed: ${JSON.stringify(answer)}`);
    assert.equal(answer.withheld, NOT_THE_BUILT_ROOT);
  });

  test('another tutorial\'s record does not vouch for this folder', () => {
    const storage = tmpDir();
    const ref = tmpDir();
    recordBuiltReference(storage, tutorialNaming(ref), ref);
    const answer = believed(tutorialNaming(ref), storage);
    assert.ok(answer !== null && isWithheld(answer), `a record for another folder vouched for this one: ${JSON.stringify(answer)}`);
    assert.equal(answer.withheld, NOT_BUILT_HERE);
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
    // A record planted where the link leads is not read either.
    fs.writeFileSync(path.join(outside, path.basename(builtRecordFile(storage, target))), JSON.stringify({
      version: 1, target: fs.realpathSync(target), referenceRoot: fs.realpathSync(ref), builtAt: new Date().toISOString(),
    }));
    const answer = believed(target, storage);
    assert.ok(answer !== null && isWithheld(answer), `a record behind a link was believed: ${JSON.stringify(answer)}`);
  });

  for (const [label, body] of [
    ['not JSON', '{"version":'],
    ['not a record', '[]'],
    // The right root under this folder's name, for another folder: only the target check refuses it.
    ['a record for another folder', 'ELSEWHERE'],
    ['a record with no root', JSON.stringify({ version: 1 })],
    ['far too large to be a record (a valid one, padded)', 'PADDED'],
  ] as const) {
    test(`a record that is ${label} is not believed`, () => {
      const storage = tmpDir();
      const ref = tmpDir();
      const target = tutorialNaming(ref);
      recordBuiltReference(storage, target, ref);
      const file = builtRecordFile(storage, target);
      // The padded case is otherwise a perfectly good record, so only the size bound refuses it.
      const good = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const planted = body === 'PADDED' ? JSON.stringify({ ...good, pad: 'x'.repeat(200_000) })
        : body === 'ELSEWHERE' ? JSON.stringify({ ...good, target: '/elsewhere' })
        : body;
      fs.writeFileSync(file, planted);
      const answer = believed(target, storage);
      assert.ok(answer !== null && isWithheld(answer), `${label}: believed ${JSON.stringify(answer)}`);
    });
  }

  test('no request stays no request', () => {
    assert.equal(believeRequest(null, tmpDir(), tmpDir()), null);
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
