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
  BUILD_DIR, BUILDING_NOW, DEFAULT_DIAL, HEARTBEAT_MS, HEARTBEAT_STALE_MS, IDEA_FIRST_MESSAGE, MARKER_FILE, confirmNotRunning, emptyRequest, markerSaysRunning,
  onlyItsHeartbeatSaysDead, parseGithubUrl, pidSpace, sameRequest, unfinishedBuildIn, validateRequest, type ReaderClock,
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
    // IDEA_FIRST_MESSAGE drifting. T-3's words named an internal ticket ("arrive with T-9"), which a
    // stranger cannot read (T-141); these say it in the form's own words, naming the box to tick.
    assert.equal(problems.idea, 'Building from an idea is not available yet — tick "Just recreate the repo as it stands" and give a reference repo');
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
  /** A target as a build that failed partway leaves it, with `marker` (or the real shape) and `extra` files in build/. */
  function leftBy(marker: unknown, extra: string[] = []): string {
    const target = tmpEmptyDir();
    const build = path.join(target, ...BUILD_DIR);
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(build, MARKER_FILE), typeof marker === 'string' ? marker : JSON.stringify(marker));
    for (const name of extra) fs.writeFileSync(path.join(build, name), '{}');
    return target;
  }
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const MARKER = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    startedAt: ago(60_000), phase: 'interpret', request: { ...emptyRequest(), recreate: true }, ...fields,
  });
  const target = (t: string): string | undefined =>
    validateRequest({ ...emptyRequest(), recreate: true, repo: tmpEmptyDir(), target: t }).problems.target;

  test('a build that ENDED (a failure keeps its marker and says so): the next press builds there again; request.json and a temp file too', () => {
    const t = leftBy(MARKER({ heartbeatAt: ago(1_000), endedAt: ago(500) }), ['request.json', 'plan.json.0123456789ab.tmp']);
    assert.equal(unfinishedBuildIn(t), 'build-again');
    assert.equal(target(t), undefined, 'it used to be "not empty"');
  });

  test('a heartbeat older than 90 s (a reload, a crash, another machine): builds again; a fresh one: refused, it may still be running', () => {
    assert.equal(unfinishedBuildIn(leftBy(MARKER({ heartbeatAt: ago(HEARTBEAT_STALE_MS + 1_000) }))), 'build-again');
    const fresh = leftBy(MARKER({ heartbeatAt: ago(5_000) }));
    assert.equal(unfinishedBuildIn(fresh), 'maybe-running');
    assert.equal(target(fresh), `${fresh} holds a build that was still working a moment ago, perhaps in another window — wait for it to finish, or pick an empty or new folder`);
  });

  test('a marker with no heartbeat (written before T-71) is taken as running for 6 hours from its start, then not', () => {
    assert.equal(unfinishedBuildIn(leftBy(MARKER({ startedAt: ago(60 * 60 * 1000) }))), 'maybe-running');
    assert.equal(unfinishedBuildIn(leftBy(MARKER({ startedAt: ago(7 * 60 * 60 * 1000) }))), 'build-again', 'it used to wait for ever (review F4)');
  });

  test('a target THIS host is building is refused at once, even while the folder is still empty (a Resume cloning; review F1)', () => {
    const t = tmpEmptyDir();
    BUILDING_NOW.add(path.resolve(t));
    try {
      assert.equal(target(t), `a build is running in ${t} now — wait for it to finish, or pick an empty or new folder`);
      assert.equal(target(path.join(t, 'sub', '..')), target(t), 'the same folder however it is written');
    } finally {
      BUILDING_NOW.delete(path.resolve(t));
    }
    assert.equal(target(t), undefined);
  });

  test('anything else in the folder, a finished plan, or a marker that does not parse or is of the wrong shape: "not empty", as before', () => {
    const ended = { endedAt: ago(1) };
    const cases: Array<[string, string]> = [];
    const withFile = leftBy(MARKER(ended));
    fs.writeFileSync(path.join(withFile, 'notes.md'), 'mine');
    cases.push(['a file of the learner beside it', withFile]);
    const inRepoTour = leftBy(MARKER(ended));
    fs.mkdirSync(path.join(inRepoTour, BUILD_DIR[0], 'cache'));
    cases.push(['another folder in .repo-tour', inRepoTour]);
    cases.push(['a finished plan', leftBy(MARKER(ended), ['request.json', 'plan.json'])]);
    cases.push(['a stray file in build/', leftBy(MARKER(ended), ['notes.json'])]);
    cases.push(['a temp file not of an atomic write', leftBy(MARKER(ended), ['plan.json.tmp'])]);
    cases.push(['a marker that does not parse', leftBy('{ not json')]);
    cases.push(['a phase it never has', leftBy(MARKER({ ...ended, phase: 'somewhere' }))]);
    cases.push(['a startedAt that is not a string', leftBy(MARKER({ ...ended, startedAt: 12 }))]);
    cases.push(['no request', leftBy(MARKER({ ...ended, request: null }))]);
    const noMarker = leftBy(MARKER(ended));
    fs.rmSync(path.join(noMarker, ...BUILD_DIR, MARKER_FILE));
    fs.writeFileSync(path.join(noMarker, ...BUILD_DIR, 'request.json'), '{}');
    cases.push(['request.json with no marker', noMarker]);
    for (const [what, t] of cases) {
      assert.equal(unfinishedBuildIn(t), null, what);
      assert.equal(target(t), `${t} is not empty — pick an empty or new folder`, what);
    }
  });

  test('a link anywhere on the way is refused: the next build would write through it', () => {
    const elsewhere = leftBy(MARKER({ endedAt: ago(1) }));
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

suite('T-122: the request a press made, and the one a marker carries', () => {
  const pressed = { ...emptyRequest(), recreate: true, repo: '/work/ref', target: '/work/tutorial', dial: 'manual' as const };
  test('the same request is the same, whatever the build later wrote beside it', () => {
    assert.equal(sameRequest(pressed, { ...pressed }), true);
    assert.equal(sameRequest(pressed, { ...pressed, referenceRoot: '/home/learner/.config/refs/x' }), true, 'referenceRoot is the build\'s, not the press\'s');
  });
  test('any field the learner chose makes another request', () => {
    for (const [field, value] of [['repo', '/work/other'], ['target', '/work/elsewhere'], ['dial', 'automated'], ['recreate', false], ['idea', 'a chat app']] as const) {
      assert.equal(sameRequest(pressed, { ...pressed, [field]: value }), false, `a request with another ${field} was taken for the one pressed`);
    }
  });
  test('something that is not a request is not the one pressed', () => {
    for (const bad of [undefined, null, 'a string', 42, {}]) assert.equal(sameRequest(pressed, bad), false);
  });
});

suite('T-121: a heartbeat is a time on the WRITER\'s clock: one from the future is not trusted, and a stale one is read again by the reader\'s own clock', () => {
  const NOW = Date.parse('2026-11-17T20:00:00.000Z');
  const DEAD_PID = 2 ** 22 + 54_321; // above Linux's default pid_max: no process has it
  const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
  /** A marker from another machine (its pid cannot be asked here), so only its heartbeat speaks. */
  const elsewhere = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'elsewhere', pid: 4242, host: 'another-machine', startedAt: at(-900_000), phase: 'interpret', request: { ...emptyRequest(), recreate: true }, ...fields,
  });
  /** A reader clock on which a heartbeat passes at once; `onSleep` sees the monotonic time slept so far. */
  function fakeClock(onSleep?: (sleptMs: number) => void): ReaderClock & { slept(): number; sleeps(): number } {
    let t = 1_000;
    let slept = 0;
    let sleeps = 0;
    return {
      monotonic: () => t,
      sleep: (ms) => { t += ms; slept += ms; sleeps += 1; onSleep?.(slept); return Promise.resolve(); },
      slept: () => slept,
      sleeps: () => sleeps,
    };
  }

  test('a beat from further in the future than the stale window is not trusted (a crashed build whose clock ran ahead); one within it still is', () => {
    assert.equal(markerSaysRunning(elsewhere({ heartbeatAt: at(24 * 60 * 60 * 1000) }), NOW), false, 'a day ahead kept its folder refused for that day');
    assert.equal(markerSaysRunning(elsewhere({ heartbeatAt: at(HEARTBEAT_STALE_MS + 1_000) }), NOW), false);
    assert.equal(markerSaysRunning(elsewhere({ heartbeatAt: at(5_000) }), NOW), true, 'a clock a little ahead is still a live build');
    assert.equal(markerSaysRunning(elsewhere({ heartbeatAt: at(-5_000) }), NOW), true);
    assert.equal(onlyItsHeartbeatSaysDead(elsewhere({ heartbeatAt: at(24 * 60 * 60 * 1000) }), NOW), true, 'and it is a heartbeat\'s word: read again before a build goes over it');
  });

  test('a beat read as stale is read again ONCE, after one HEARTBEAT_MS of the reader\'s monotonic time: one that moved is a live build, whatever either clock says', async () => {
    const first = elsewhere({ heartbeatAt: at(-600_000) });
    let reads = 0;
    let readAfter = -1;
    const clock = fakeClock();
    const verdict = await confirmNotRunning(() => { reads += 1; readAfter = clock.slept(); return { ...first, heartbeatAt: at(-570_000) }; }, first, clock);
    assert.equal(verdict, false, 'a build that beat while the reader waited was called dead');
    assert.equal(reads, 1, 'read again more or less than once');
    assert.ok(readAfter >= HEARTBEAT_MS, `read again after ${readAfter} ms of the reader's monotonic time, not one heartbeat`);
  });

  test('a beat that stood still for that heartbeat: not running, after exactly one wait of one heartbeat and one read', async () => {
    const first = elsewhere({ heartbeatAt: at(-600_000) });
    let reads = 0;
    const clock = fakeClock();
    assert.equal(await confirmNotRunning(() => { reads += 1; return { ...first }; }, first, clock), true);
    assert.equal(reads, 1);
    assert.ok(clock.slept() >= HEARTBEAT_MS && clock.slept() < HEARTBEAT_MS + 1_000, `waited ${clock.slept()} ms`);
    // and a crashed build whose clock ran a day ahead: its beat never moves, so its folder is free after one heartbeat
    const ahead = elsewhere({ heartbeatAt: at(24 * 60 * 60 * 1000) });
    assert.equal(await confirmNotRunning(() => ({ ...ahead }), ahead, fakeClock()), true);
  });

  test('another build\'s marker there now is not ours to call dead; one that ended or went is', async () => {
    const first = elsewhere({ heartbeatAt: at(-600_000) });
    assert.equal(await confirmNotRunning(() => ({ ...first, id: 'a-new-build', heartbeatAt: at(-1_000) }), first, fakeClock()), false);
    assert.equal(await confirmNotRunning(() => ({ ...first, endedAt: at(-1_000) }), first, fakeClock()), true);
    assert.equal(await confirmNotRunning(() => null, first, fakeClock()), true);
  });

  test('a surer word is not waited on: an ended build, a host this machine sees gone, a fresh beat', async () => {
    for (const sure of [
      elsewhere({ heartbeatAt: at(-600_000), endedAt: at(-590_000) }),
      elsewhere({ heartbeatAt: at(-600_000), pid: DEAD_PID, host: os.hostname(), pidSpace: pidSpace() }),
    ]) {
      const clock = fakeClock();
      let reads = 0;
      assert.equal(onlyItsHeartbeatSaysDead(sure, NOW), false);
      assert.equal(await confirmNotRunning(() => { reads += 1; return sure; }, sure, clock), true);
      assert.deepEqual([clock.sleeps(), reads], [0, 0], 'waited on, or read again, though its end was already certain');
    }
    assert.equal(onlyItsHeartbeatSaysDead(elsewhere({ heartbeatAt: new Date().toISOString() })), false, 'a fresh beat is running, not dead');
  });

  test('a Cancel during the wait ends it at once, before the heartbeat has passed', async () => {
    const first = elsewhere({ heartbeatAt: at(-600_000) });
    const clock = fakeClock();
    let reads = 0;
    const verdict = await confirmNotRunning(() => { reads += 1; return first; }, first, clock, () => clock.sleeps() >= 2);
    assert.equal(verdict, 'cancelled');
    assert.equal(reads, 0);
    assert.ok(clock.slept() < HEARTBEAT_MS, `a Cancel waited ${clock.slept()} ms`);
  });
});
