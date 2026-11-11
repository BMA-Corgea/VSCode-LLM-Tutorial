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
  BUILD_DIR, DEFAULT_DIAL, IDEA_FIRST_MESSAGE, MARKER_FILE, emptyRequest, parseGithubUrl, unfinishedBuildIn, validateRequest,
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
    // Retyped rather than derived, deliberately: this is the assertion that would catch
    // IDEA_FIRST_MESSAGE drifting away from the ticket's own spec text. Copied byte for byte
    // from .autodev/specs/T-3-start-screen.md line 12 — no quotes around recreate, no
    // trailing period (the older T-1 spec §5.2 words it differently; this ticket's own AC2
    // is canonical — T-3 rework, review advisory 1).
    assert.equal(problems.idea, 'Idea-first builds arrive with T-9 — tick recreate to build from a repo');
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

suite('T-71: a target that holds nothing but an unfinished build', () => {
  const DEAD = 2 ** 22 + 12_345; // above Linux's default pid_max: no process has this id
  const alive = (pid: number): boolean => pid !== DEAD;

  /** A target as a build that failed partway leaves it, with `marker` (or the real shape) and `extra` files in build/. */
  function leftBy(marker: unknown, extra: string[] = []): string {
    const target = tmpEmptyDir();
    const build = path.join(target, ...BUILD_DIR);
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(build, MARKER_FILE), typeof marker === 'string' ? marker : JSON.stringify(marker));
    for (const name of extra) fs.writeFileSync(path.join(build, name), '{}');
    return target;
  }
  const MARKER = (pid?: number): Record<string, unknown> => ({
    startedAt: new Date().toISOString(), phase: 'interpret', request: { ...emptyRequest(), recreate: true }, ...(pid === undefined ? {} : { pid }),
  });
  const target = (t: string): string | undefined =>
    validateRequest({ ...emptyRequest(), recreate: true, repo: tmpEmptyDir(), target: t }).problems.target;

  test('a marker this host left: the next press builds there again (it used to be "not empty")', () => {
    const t = leftBy(MARKER(process.pid));
    assert.equal(unfinishedBuildIn(t), 'build-again');
    assert.equal(target(t), undefined);
  });

  test("a marker whose host is gone (a reload, a crash): builds again; with request.json and an atomic write's temp file too", () => {
    const t = leftBy(MARKER(DEAD), ['request.json', 'plan.json.0123456789ab.tmp']);
    assert.equal(unfinishedBuildIn(t, process.pid, alive), 'build-again');
    assert.equal(unfinishedBuildIn(t), 'build-again', 'the real liveness check agrees: no process has that id');
  });

  test('a marker whose host is ALIVE elsewhere, or that names none: refused, saying it may still be running', () => {
    for (const marker of [MARKER(process.ppid), MARKER()]) {
      const t = leftBy(marker);
      assert.equal(unfinishedBuildIn(t), 'maybe-running');
      assert.equal(target(t), `${t} holds another build, which may still be running in another window — wait for it, or pick an empty or new folder`);
    }
  });

  test('anything else in the folder, a finished plan, or a marker that does not parse: "not empty", as before', () => {
    const cases: Array<[string, string]> = [];
    const withFile = leftBy(MARKER(process.pid));
    fs.writeFileSync(path.join(withFile, 'notes.md'), 'mine');
    cases.push(['a file of the learner beside it', withFile]);
    const inRepoTour = leftBy(MARKER(process.pid));
    fs.mkdirSync(path.join(inRepoTour, BUILD_DIR[0], 'cache'));
    cases.push(['another folder in .repo-tour', inRepoTour]);
    cases.push(['a finished plan', leftBy(MARKER(process.pid), ['request.json', 'plan.json'])]);
    cases.push(['a stray file in build/', leftBy(MARKER(process.pid), ['notes.json'])]);
    cases.push(['a marker that does not parse', leftBy('{ not json')]);
    cases.push(['a marker of the wrong shape', leftBy({ startedAt: 'x', phase: 'somewhere', request: {}, pid: process.pid })]);
    const noMarker = leftBy(MARKER(process.pid));
    fs.rmSync(path.join(noMarker, ...BUILD_DIR, MARKER_FILE));
    fs.writeFileSync(path.join(noMarker, ...BUILD_DIR, 'request.json'), '{}');
    cases.push(['request.json with no marker', noMarker]);
    for (const [what, t] of cases) {
      assert.equal(unfinishedBuildIn(t), null, what);
      assert.equal(target(t), `${t} is not empty — pick an empty or new folder`, what);
    }
  });

  test('a link anywhere on the way is refused: the next build would write through it', () => {
    const elsewhere = leftBy(MARKER(process.pid));
    const viaRepoTour = tmpEmptyDir();
    fs.symlinkSync(path.join(elsewhere, BUILD_DIR[0]), path.join(viaRepoTour, BUILD_DIR[0]));
    const viaBuild = tmpEmptyDir();
    fs.mkdirSync(path.join(viaBuild, BUILD_DIR[0]));
    fs.symlinkSync(path.join(elsewhere, ...BUILD_DIR), path.join(viaBuild, ...BUILD_DIR));
    const viaMarker = tmpEmptyDir();
    fs.mkdirSync(path.join(viaMarker, ...BUILD_DIR), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, ...BUILD_DIR, MARKER_FILE), path.join(viaMarker, ...BUILD_DIR, MARKER_FILE));
    for (const [what, t] of [['.repo-tour', viaRepoTour], ['build', viaBuild], ['the marker', viaMarker]] as const) {
      assert.equal(unfinishedBuildIn(t), null, `${what} as a link`);
      assert.match(target(t) ?? '', /is not empty/, `${what} as a link`);
    }
    assert.equal(unfinishedBuildIn(elsewhere), 'build-again', 'the real folder the links point at is the accepted shape');
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
