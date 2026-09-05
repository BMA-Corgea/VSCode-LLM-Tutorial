// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `validateRequest` — pure, no VS Code, so this runs under plain mocha (`npm run test:unit`),
 * not vscode-test. One test per rule (plan step 4), plus a "should NOT fire" companion next
 * to each so a rule that always returns a problem (or never returns one) gets caught.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DIAL, IDEA_FIRST_MESSAGE, emptyRequest, parseGithubUrl, validateRequest,
} from '../../src/start/request.js';

function tmpEmptyDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-target-'));
}

suite('validateRequest', () => {
  test('recreate ticked with no repo -> repo: required (and nothing else complains about repo)', () => {
    const target = tmpEmptyDir();
    const { ok, problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: '', target });
    assert.equal(ok, false);
    assert.equal(problems.repo, 'required when recreating');
  });

  test('recreate ticked WITH a real repo path -> no repo problem (discriminates against the rule above)', () => {
    const repo = tmpEmptyDir();
    const target = tmpEmptyDir();
    const { problems } = validateRequest({ ...emptyRequest(), recreate: true, repo, target });
    assert.equal(problems.repo, undefined);
  });

  test('idea typed, recreate NOT ticked, no repo -> the exact T-9 honesty line under idea (AC2)', () => {
    const target = tmpEmptyDir();
    const { ok, problems } = validateRequest({
      ...emptyRequest(), idea: 'a chat app', recreate: false, repo: '', target,
    });
    assert.equal(ok, false);
    assert.equal(problems.idea, IDEA_FIRST_MESSAGE);
    assert.equal(problems.idea, "Idea-first builds arrive with T-9 — tick 'recreate' to build from a repo");
  });

  test('idea typed, recreate NOT ticked, repo ALSO filled in -> still the T-9 line (v1 has no guided mode)', () => {
    const repo = tmpEmptyDir();
    const target = tmpEmptyDir();
    const { problems } = validateRequest({
      ...emptyRequest(), idea: 'a chat app', recreate: false, repo, target,
    });
    assert.equal(problems.idea, IDEA_FIRST_MESSAGE);
  });

  test('idea typed AND recreate ticked -> no idea problem (discriminates: recreate silences the idea rule)', () => {
    const repo = tmpEmptyDir();
    const target = tmpEmptyDir();
    const { problems } = validateRequest({
      ...emptyRequest(), idea: 'a chat app', recreate: true, repo, target,
    });
    assert.equal(problems.idea, undefined);
  });

  test('neither idea nor recreate -> "say what you want to build, or tick recreate"', () => {
    const target = tmpEmptyDir();
    const { ok, problems } = validateRequest({ ...emptyRequest(), idea: '', recreate: false, target });
    assert.equal(ok, false);
    assert.equal(problems.idea, 'say what you want to build, or tick recreate');
  });

  test('no target -> target: pick an empty or new folder', () => {
    const { ok, problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: tmpEmptyDir(), target: '' });
    assert.equal(ok, false);
    assert.equal(problems.target, 'pick an empty or new folder');
  });

  test('target is a real, empty, absolute folder -> no target problem (discriminates against the rule above)', () => {
    const { problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: tmpEmptyDir(), target: tmpEmptyDir() });
    assert.equal(problems.target, undefined);
  });

  test('target is a NEW (not-yet-existing) absolute path -> allowed ("empty OR NEW folder")', () => {
    const parent = tmpEmptyDir();
    const brandNew = path.join(parent, 'not-created-yet');
    assert.equal(fs.existsSync(brandNew), false);
    const { problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: tmpEmptyDir(), target: brandNew });
    assert.equal(problems.target, undefined);
  });

  test('target exists but is NOT empty -> refused, names the folder', () => {
    const notEmpty = tmpEmptyDir();
    fs.writeFileSync(path.join(notEmpty, 'already-here.txt'), 'x');
    const { problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: tmpEmptyDir(), target: notEmpty });
    assert.equal(problems.target, `${notEmpty} is not empty — pick an empty or new folder`);
  });

  test('repo is a GitHub URL -> accepted without touching the filesystem', () => {
    const target = tmpEmptyDir();
    const { problems } = validateRequest({
      ...emptyRequest(), recreate: true, repo: 'https://github.com/BMA-Corgea/repo-tour', target,
    });
    assert.equal(problems.repo, undefined);
  });

  test('repo is a local path that does not exist -> refused, names the path', () => {
    const target = tmpEmptyDir();
    const missing = path.join(tmpEmptyDir(), 'nope');
    const { problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: missing, target });
    assert.equal(problems.repo, `no folder found at ${missing}`);
  });

  test('repo is a RELATIVE path (not absolute, not a URL) -> refused', () => {
    const target = tmpEmptyDir();
    const { problems } = validateRequest({ ...emptyRequest(), recreate: true, repo: '../somewhere', target });
    assert.match(problems.repo ?? '', /absolute local path/);
  });

  test('a fully well-formed recreate request -> ok: true, no problems at all', () => {
    const repo = tmpEmptyDir();
    const target = tmpEmptyDir();
    const result = validateRequest({ idea: '', recreate: true, repo, target, dial: DEFAULT_DIAL });
    assert.deepEqual(result, { ok: true, problems: {} });
  });
});

suite('parseGithubUrl', () => {
  test('parses owner and repo name from a plain https URL', () => {
    assert.deepEqual(parseGithubUrl('https://github.com/BMA-Corgea/repo-tour'), {
      owner: 'BMA-Corgea', name: 'repo-tour',
    });
  });

  test('strips a trailing .git', () => {
    assert.deepEqual(parseGithubUrl('https://github.com/BMA-Corgea/repo-tour.git'), {
      owner: 'BMA-Corgea', name: 'repo-tour',
    });
  });

  test('a local absolute path is not a GitHub URL (discriminates against the rule above)', () => {
    assert.equal(parseGithubUrl('/home/me/repo-tour'), null);
  });

  test('a non-github https URL is not accepted', () => {
    assert.equal(parseGithubUrl('https://gitlab.com/owner/name'), null);
  });
});
