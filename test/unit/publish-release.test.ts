// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE RELEASE, pinned (T-140). `src/publish/release.ts` decides which bytes may go on a draft
 * GitHub release, and it is pure precisely so this suite can drive every one of its refusals
 * with no GitHub, no git, no `unzip` and no network.
 *
 * Two properties are protected here, and both are the kind a later "simplification" would undo
 * while every other test stayed green:
 *
 *   1. **The release carries the bytes ONE green CI run verified, never a build from a laptop.**
 *      So the run is chosen by exact sha, push, main, completed, success, and EVERY step of
 *      every job green; the artifact is the one that run uploaded, unexpired, and its zip hashes
 *      to the digest GitHub recorded at upload; the .vsix inside is this extension at the
 *      commit's own version. Each refusal is pinned by WHICH rule fired and by the facts its
 *      sentence names, so a function that refuses everything does not pass a refusal test.
 *   2. **Nothing this produces writes to GitHub on its own.** The commands the shell runs are
 *      reads, and `isReadOnlyGh` says so about every one of them; the commands it PRINTS are
 *      always a draft, at a full sha, and `isReadOnlyGh` refuses every one of those, so the
 *      shell cannot run them even by mistake.
 *
 * The fixtures are the shapes `gh` really returned for commit 7050fd2 (run 43141446029, green,
 * a 0.0.1 artifact) and for 75a6c7c (run 43138386008, red), read on 2026-11-17. The step names
 * are read from `.github/workflows/ci.yml` rather than typed, and the last suite asserts that
 * every name this module holds is the one that ships (`autodev/instructions/testing-the-shipped-value.md`).
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXTENSION_NAME, EXTENSION_PUBLISHER, PROVEN_ON_LINUX, RELEASES_URL, RELEASE_BRANCH, RELEASE_EVENT,
  RELEASE_REPO, RELEASE_WORKFLOW, REPOSITORY_ONLY, REQUIRED_STEPS, VSIX_ARTIFACT_NAME,
  checkArtifactDigest, checkArtifactEntries, checkDraftAsset, checkDraftRelease, checkDraftsVisible, checkExtraction,
  checkOnMain, checkReleaseList, checkResolvedSha, checkRunSteps, checkTagTarget, checkVsixManifest, chooseArtifact, chooseRun,
  composeReleaseNotes, ghRead, isReadOnlyGh, minimumVscode, parseShaArgument, peelTagObject, readCommitManifest,
  readExistingRelease, readRunnerVscode, readTagRef, refusalText, releaseCommands, releaseTag, releaseTitle, sha256Hex, vsixFileName,
  type Checked, type CiArtifact, type CiRun, type CommandResult, type ExistingRelease, type Refusal,
} from '../../src/publish/release.js';
import { expectedArtifactName } from '../../src/publish/plan.js';

// ── what ships, read from where it ships ─────────────────────────────────────────────────

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MANIFEST = JSON.parse(read('package.json')) as {
  name: string; publisher: string; version: string; engines: { vscode: string }; repository: { url: string };
};
const CI = read('.github/workflows/ci.yml');

/** The step names ci.yml declares, in order: what a real run of it reports, between its own. */
function ciStepNames(): string[] {
  return [...CI.matchAll(/^\s*- name:\s*(.+?)\s*$/gm)].map((m) => m[1] ?? '');
}

/** The artifact name the upload step gives, read out of ci.yml rather than typed. */
const CI_ARTIFACT = /uses: actions\/upload-artifact@v\d+\s+with:\s+name:\s*(\S+)/.exec(CI)?.[1] ?? '(none in ci.yml)';

// ── fixtures: the shapes gh really returned ──────────────────────────────────────────────

const SHA = '7050fd2b79604751ad6b2d48e52f6b8f467f594d';
const RED_SHA = '75a6c7ce38aae591b503b2d6a5263acc895ab713';
const RUN_ID = 43141446029;
const RED_RUN_ID = 43138386008;
const RUN_URL = `https://github.com/BMA-Corgea/VSCode-LLM-Tutorial/actions/runs/${RUN_ID}`;
const VERSION = '0.0.1';
const VSIX = 'build-tutorials-0.0.1.vsix';

const ran = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });
const failed = (stderr: string, status: number | null = 1): CommandResult => ({ status, stdout: '', stderr });

function runRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: 'success', databaseId: RUN_ID, event: 'push', headBranch: 'main',
    headSha: SHA, status: 'completed', url: RUN_URL, ...over,
  };
}
const runList = (...rows: Record<string, unknown>[]): CommandResult => ran(JSON.stringify(rows));

const RUN: CiRun = {
  id: RUN_ID, url: RUN_URL, headSha: SHA, event: 'push', headBranch: 'main', status: 'completed', conclusion: 'success',
};

interface StepRow { conclusion: string | null; name: string; number: number; status: string }

/** `gh run view <id> --json jobs` for one job running exactly ci.yml's steps, all green unless `mutate` says. */
function jobsView(mutate: (steps: StepRow[]) => StepRow[] = (s) => s, job: Record<string, unknown> = {}): CommandResult {
  const names = ['Set up job', ...ciStepNames(), 'Post Checkout this repo', 'Complete job'];
  const steps = names.map((name, i): StepRow => ({ conclusion: 'success', name, number: i + 1, status: 'completed' }));
  return ran(JSON.stringify({
    jobs: [{
      conclusion: 'success', databaseId: 130929135909, name: 'build-and-test', status: 'completed',
      steps: mutate(steps), url: `${RUN_URL}/job/130929135909`, ...job,
    }],
  }));
}

const ZIP = Buffer.from('the zip GitHub holds, as far as this suite is concerned');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

function artifactRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 13910310691, name: CI_ARTIFACT, size_in_bytes: ZIP.length, expired: false,
    digest: `sha256:${ZIP_SHA}`, created_at: '2026-11-12T02:30:27Z', expires_at: '2027-02-10T02:26:39Z',
    workflow_run: { id: RUN_ID, head_branch: 'main', head_sha: SHA },
    ...over,
  };
}
const artifactList = (...rows: Record<string, unknown>[]): CommandResult =>
  ran(JSON.stringify({ total_count: rows.length, artifacts: rows }));

const ARTIFACT: CiArtifact = {
  id: 13910310691, name: CI_ARTIFACT, digest: `sha256:${ZIP_SHA}`, sizeInBytes: ZIP.length, expiresAt: '2027-02-10T02:26:39Z',
};

// ── how a verdict is read ────────────────────────────────────────────────────────────────

/** A reason or a remedy is a sentence: it starts like one and it ends with a full stop. */
const SENTENCE = /^[A-Z0-9`].*\.$/s;

function accepted<T>(result: Checked<T>): T {
  if (!result.ok) assert.fail(`expected acceptance, got ${result.code}: ${refusalText(result)}`);
  return result.value;
}

/**
 * A refusal, by the rule that fired and the facts it names. The code alone would let a function
 * that refuses everything pass; the mentions are what tie each refusal to the input that caused it.
 */
function refused<T>(result: Checked<T>, code: Refusal['code'], ...mentions: string[]): Refusal {
  if (result.ok) assert.fail(`expected a refusal (${code}), got ${JSON.stringify(result.value)}`);
  const text = refusalText(result);
  assert.equal(result.code, code, text);
  assert.match(result.reason, SENTENCE, `the reason is a sentence: ${result.reason}`);
  assert.match(result.remedy, SENTENCE, `the remedy is a sentence that says what to do: ${result.remedy}`);
  for (const m of mentions) assert.ok(text.includes(m), `the refusal should name ${m}: ${text}`);
  return result;
}

// ── the commit ───────────────────────────────────────────────────────────────────────────

suite('release: the commit', () => {
  test('the argument is a hex sha of at least seven characters, lower-cased', () => {
    assert.equal(accepted(parseShaArgument('7050fd2')), '7050fd2');
    assert.equal(accepted(parseShaArgument(SHA.toUpperCase())), SHA);
  });

  test('a branch name, a tag, nothing at all or anything with a shell character in it is refused', () => {
    // GitHub's main and this checkout's main can disagree, so a release names a commit, not a ref.
    refused(parseShaArgument('main'), 'bad-sha-argument', 'main');
    refused(parseShaArgument('v0.1.0'), 'bad-sha-argument', 'v0.1.0');
    refused(parseShaArgument('7050fd'), 'bad-sha-argument', '7050fd');
    refused(parseShaArgument(undefined), 'bad-sha-argument', 'release-draft.mjs');
    refused(parseShaArgument('7050fd2;true'), 'bad-sha-argument', '7050fd2;true');
  });

  test('the checkout resolves it to the FULL sha, which must start with what was given', () => {
    assert.equal(accepted(checkResolvedSha('7050fd2', ran(`${SHA}\n`))), SHA);
    refused(checkResolvedSha('7050fd2', ran(`${RED_SHA}\n`)), 'commit-not-found', '7050fd2', RED_SHA);
    refused(checkResolvedSha('7050fd2', ran('7050fd2\n')), 'commit-not-found', '7050fd2');
  });

  test('a commit this checkout does not have is refused, and the remedy is to fetch it', () => {
    const r = refused(checkResolvedSha('deadbee', failed('', 1)), 'commit-not-found', 'deadbee');
    assert.ok(r.remedy.includes('git fetch'), r.remedy);
  });

  test('the version is the one in the commit\'s OWN package.json', () => {
    assert.deepEqual(accepted(readCommitManifest(ran(JSON.stringify({ name: 'x', version: '0.0.1' })), SHA)), { version: '0.0.1' });
    assert.deepEqual(accepted(readCommitManifest(ran(JSON.stringify({ version: '1.2.3-rc.1' })), SHA)), { version: '1.2.3-rc.1' });
  });

  test('a package.json git could not show, could not parse, or whose version cannot be a tag is refused', () => {
    refused(readCommitManifest(failed('fatal: path does not exist', 128), SHA), 'commit-manifest-unreadable', SHA, 'fatal: path does not exist');
    refused(readCommitManifest(ran('{ not json'), SHA), 'commit-manifest-unreadable', SHA);
    refused(readCommitManifest(ran(JSON.stringify({ name: 'x' })), SHA), 'commit-manifest-unreadable', SHA);
    // The version becomes a tag, a file name and a word on a printed command line.
    refused(readCommitManifest(ran(JSON.stringify({ version: '0.1.0 && true' })), SHA), 'commit-manifest-unreadable', '0.1.0 && true');
    refused(readCommitManifest(ran(JSON.stringify({ version: 'v0.1.0' })), SHA), 'commit-manifest-unreadable', 'v0.1.0');
  });
});

// ── on GitHub's main ─────────────────────────────────────────────────────────────────────

suite('release: the commit is on GitHub\'s main', () => {
  const compare = (status: string, over: Record<string, unknown> = {}): CommandResult => ran(JSON.stringify({
    status, ahead_by: status === 'ahead' ? 7 : 0, behind_by: 0, base_commit: { sha: SHA }, ...over,
  }));

  test('identical, or main ahead of it (main contains it), is accepted', () => {
    assert.equal(accepted(checkOnMain(compare('identical'), SHA)).status, 'identical');
    const ahead = accepted(checkOnMain(compare('ahead'), SHA));
    assert.equal(ahead.status, 'ahead');
    assert.equal(ahead.aheadBy, 7);
  });

  test('behind or diverged is refused: main does not contain the commit', () => {
    refused(checkOnMain(compare('behind', { behind_by: 2 }), SHA), 'not-on-main', SHA, 'behind');
    refused(checkOnMain(compare('diverged', { ahead_by: 3, behind_by: 1 }), SHA), 'not-on-main', SHA, 'diverged');
  });

  test('"ahead" that is also behind, or a compare of a different commit, is refused', () => {
    refused(checkOnMain(compare('ahead', { behind_by: 1 }), SHA), 'not-on-main', SHA);
    refused(checkOnMain(compare('identical', { base_commit: { sha: RED_SHA } }), SHA), 'compare-unreadable', RED_SHA);
  });

  test('a compare that did not run, or said nothing, is "could not tell", never "on main"', () => {
    refused(checkOnMain(failed('gh: Not Found (HTTP 404)'), SHA), 'compare-unreadable', 'HTTP 404');
    refused(checkOnMain(ran(''), SHA), 'compare-unreadable', SHA);
    refused(checkOnMain(ran('{}'), SHA), 'compare-unreadable', SHA);
  });
});

// ── choosing the run ─────────────────────────────────────────────────────────────────────

suite('release: choosing the CI run', () => {
  test('the green push to main of exactly this sha is accepted', () => {
    assert.deepEqual(accepted(chooseRun(runList(runRow()), SHA)), RUN);
  });

  test('a commit with no run is refused in a sentence that says what to do', () => {
    const r = refused(chooseRun(runList(), SHA), 'no-run', SHA);
    assert.ok(/push/.test(r.remedy), r.remedy);
  });

  test('a red run is refused, naming the run and how it ended', () => {
    refused(
      chooseRun(runList(runRow({ databaseId: RED_RUN_ID, headSha: RED_SHA, conclusion: 'failure' })), RED_SHA),
      'run-not-green', String(RED_RUN_ID), 'failure',
    );
  });

  test('cancelled, skipped, neutral, timed_out, action_required and startup_failure are all refusals', () => {
    for (const conclusion of ['cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
      refused(chooseRun(runList(runRow({ conclusion })), SHA), 'run-not-green', String(RUN_ID), conclusion);
    }
  });

  test('a run still going is refused, and the remedy is to wait for it', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const r = refused(chooseRun(runList(runRow({ status, conclusion: '' })), SHA), 'run-not-green', String(RUN_ID), status);
      assert.ok(/wait/i.test(r.remedy), r.remedy);
    }
  });

  test('only a PUSH to MAIN is a CI-verified release: a pull request, a dispatch or another branch is not', () => {
    refused(chooseRun(runList(runRow({ event: 'pull_request' })), SHA), 'no-run', 'pull_request');
    refused(chooseRun(runList(runRow({ event: 'workflow_dispatch' })), SHA), 'no-run', 'workflow_dispatch');
    refused(chooseRun(runList(runRow({ headBranch: 'feature/T-140-release' })), SHA), 'no-run', 'feature/T-140-release');
  });

  test('headSha must equal the sha EXACTLY: a run of another commit is not this commit\'s run', () => {
    refused(chooseRun(runList(runRow({ headSha: RED_SHA })), SHA), 'no-run', SHA);
    refused(chooseRun(runList(runRow({ headSha: SHA.slice(0, 39) })), SHA), 'no-run', SHA);
    refused(chooseRun(runList(runRow({ headSha: SHA.toUpperCase() })), SHA), 'no-run', SHA);
  });

  test('of two green runs of the same commit, the newest is the one released', () => {
    const newer = RUN_ID + 5;
    const chosen = accepted(chooseRun(runList(runRow(), runRow({ databaseId: newer, url: `${RUN_URL}5` })), SHA));
    assert.equal(chosen.id, newer);
  });

  test('a green run beside a red one for the same commit: the green one is the run that verified its artifact', () => {
    const chosen = accepted(chooseRun(runList(runRow({ databaseId: RUN_ID + 9, conclusion: 'failure' }), runRow()), SHA));
    assert.equal(chosen.id, RUN_ID);
  });

  test('a run list that could not be read is "could not tell", never "no run"', () => {
    refused(chooseRun(failed('HTTP 401: Bad credentials'), SHA), 'run-list-unreadable', 'HTTP 401');
    refused(chooseRun(failed('', null), SHA), 'run-list-unreadable', SHA);
    refused(chooseRun(ran('not json'), SHA), 'run-list-unreadable', SHA);
    refused(chooseRun(ran('{}'), SHA), 'run-list-unreadable', SHA);
    refused(chooseRun(runList({ headSha: SHA }), SHA), 'run-list-unreadable', SHA);
  });
});

// ── every step of every job ──────────────────────────────────────────────────────────────

suite('release: every step of every job is green', () => {
  test('the real workflow, every step green, is accepted, naming the job that ran the install check', () => {
    const counted = accepted(checkRunSteps(jobsView(), RUN));
    assert.equal(counted.jobs, 1);
    assert.equal(counted.steps, ciStepNames().length + 3);
    assert.equal(counted.installJobId, 130929135909, 'its log is where the runner\'s VS Code version is read (review S3)');
  });

  test('a job without a numeric id cannot name the log the notes are read from', () => {
    refused(checkRunSteps(jobsView(undefined, { databaseId: 'x' }), RUN), 'jobs-unreadable', 'build-and-test');
  });

  test('a skipped step refuses, naming the step, its job and how it ended', () => {
    const view = jobsView((steps) => steps.map((s) => (s.name.startsWith('Publish dry run') ? { ...s, conclusion: 'skipped' } : s)));
    refused(checkRunSteps(view, RUN), 'step-not-green', 'Publish dry run', 'build-and-test', 'skipped', String(RUN_ID));
  });

  test('a cancelled step, a failed one and one with no conclusion yet each refuse', () => {
    for (const conclusion of ['cancelled', 'failure', 'neutral', '', null]) {
      const view = jobsView((steps) => steps.map((s) => (s.name === 'Lint' ? { ...s, conclusion } : s)));
      refused(checkRunSteps(view, RUN), 'step-not-green', 'Lint', 'build-and-test');
    }
  });

  test('a run that reports no jobs, or a job with no steps, is "could not tell", not green', () => {
    refused(checkRunSteps(ran(JSON.stringify({ jobs: [] })), RUN), 'jobs-unreadable', String(RUN_ID));
    refused(checkRunSteps(jobsView(() => []), RUN), 'jobs-unreadable', 'build-and-test');
    refused(checkRunSteps(ran('{}'), RUN), 'jobs-unreadable', String(RUN_ID));
    refused(checkRunSteps(ran('nope'), RUN), 'jobs-unreadable', String(RUN_ID));
    refused(checkRunSteps(failed('HTTP 502'), RUN), 'jobs-unreadable', 'HTTP 502');
  });

  test('the steps the release relies on must be IN the run: a workflow without the install check verified nothing', () => {
    assert.deepEqual(REQUIRED_STEPS.map((r) => r.prefix), ['Package', 'Install the .vsix', 'Upload .vsix'],
      'the control: an empty list of required steps would make this loop, and this test, vacuous');
    for (const required of REQUIRED_STEPS) {
      const view = jobsView((steps) => steps.filter((s) => !s.name.startsWith(required.prefix)));
      refused(checkRunSteps(view, RUN), 'required-step-missing', required.prefix, String(RUN_ID));
    }
  });

  test('a job that did not succeed refuses even when every step it reports says success', () => {
    refused(checkRunSteps(jobsView(undefined, { conclusion: 'failure' }), RUN), 'job-not-green', 'build-and-test', 'failure');
  });
});

// ── which VS Code the run proved it on (review S3) ───────────────────────────────────────

suite('release: the runner\'s VS Code, as the run\'s own job log names it', () => {
  const JOB = 130929135909;
  // The shape of run 43141446029's job log (gh api …/actions/jobs/130929135909/logs), trimmed to the lines
  // the reader looks at, with the runner's work paths left out.
  const LOG = [
    '2026-11-12T02:28:25.0346631Z ✔ Validated version: 1.146.0',
    '2026-11-12T02:29:31.8210616Z ✔ Validated version: 1.146.0',
    '2026-11-12T02:30:20.2544169Z verifying build-tutorials-0.0.1.vsix (6.72 MB)',
    '2026-11-12T02:30:26.0096182Z AC1 - installs and activates on both editors',
    '2026-11-12T02:30:26.0096627Z   UNPROVEN VSCodium - not on PATH',
    '2026-11-12T02:30:26.0097330Z   PROVEN   Visual Studio Code (downloaded by @vscode/test-electron into .vscode-test/, not a system install)',
  ].join('\n');

  test('the version its tests validated, beside its install check\'s PROVEN Visual Studio Code, is the runner\'s', () => {
    assert.deepEqual(accepted(readRunnerVscode(ran(LOG), RUN, JOB)), { version: '1.146.0' });
  });

  test('colour codes in the log hide neither line', () => {
    const coloured = LOG
      .replace('Validated version: 1.146.0', 'Validated version: \x1b[1m1.146.0\x1b[22m')
      .replace('PROVEN   Visual', '\x1b[32mPROVEN\x1b[0m   Visual');
    assert.deepEqual(accepted(readRunnerVscode(ran(coloured), RUN, JOB)), { version: '1.146.0' });
  });

  test('a log naming no validated version, or two different ones, is refused: the notes would be guessing', () => {
    const none = LOG.split('\n').filter((l) => !l.includes('Validated version')).join('\n');
    refused(readRunnerVscode(ran(none), RUN, JOB), 'runner-version-unknown', String(JOB), 'Validated version');
    const two = `${LOG}\n2026-11-12T02:31:00.0000000Z ✔ Validated version: 1.147.0`;
    refused(readRunnerVscode(ran(two), RUN, JOB), 'runner-version-unknown', '1.146.0', '1.147.0');
  });

  test('an install check that proved no VS Code is refused, and UNPROVEN never reads as PROVEN', () => {
    const unproven = LOG.replace('  PROVEN   Visual Studio Code (downloaded', '  UNPROVEN Visual Studio Code - not on PATH (downloaded');
    refused(readRunnerVscode(ran(unproven), RUN, JOB), 'runner-version-unknown', String(JOB), 'PROVEN');
  });

  test('a job log that could not be read is refused, never read as a version', () => {
    refused(readRunnerVscode(failed('gh: Not Found (HTTP 404)'), RUN, JOB), 'job-log-unreadable', String(JOB), 'HTTP 404');
  });

  test('the job log is a read of this repository', () => {
    assert.deepEqual(ghRead.jobLog(JOB), ['api', `repos/${RELEASE_REPO}/actions/jobs/${JOB}/logs`]);
    assert.equal(isReadOnlyGh(ghRead.jobLog(JOB)), true);
  });

  test('the lines it reads are the ones this repository prints: verify-install\'s verdict, on ci.yml\'s Ubuntu runner', () => {
    const verifyInstall = read('scripts/verify-install.mjs');
    assert.ok(verifyInstall.includes("label: 'Visual Studio Code'"), 'verify-install labels the editor "Visual Studio Code"');
    assert.match(verifyInstall, /PROVEN\$\{OFF\} {3}\$\{r\.editor\.label\}/, 'verify-install prints "PROVEN   <label>"');
    assert.match(CI, /^\s*runs-on:\s*ubuntu-latest\s*$/m, 'the notes call the runner GitHub\'s Ubuntu runner');
  });
});

// ── the artifact ─────────────────────────────────────────────────────────────────────────

suite('release: the artifact that run uploaded', () => {
  test('the run\'s build-tutorials-vsix artifact is chosen, with its digest', () => {
    assert.deepEqual(accepted(chooseArtifact(artifactList(artifactRow()), RUN)), ARTIFACT);
  });

  test('a run with no artifact of that name is refused', () => {
    refused(chooseArtifact(artifactList(), RUN), 'no-artifact', CI_ARTIFACT, String(RUN_ID));
    refused(chooseArtifact(artifactList(artifactRow({ name: 'coverage' })), RUN), 'no-artifact', CI_ARTIFACT, 'coverage');
  });

  test('two of that name are refused: which one the run verified would be a guess', () => {
    refused(chooseArtifact(artifactList(artifactRow(), artifactRow({ id: 2 })), RUN), 'artifact-ambiguous', CI_ARTIFACT);
  });

  test('an expired artifact is refused, saying its bytes are gone', () => {
    refused(chooseArtifact(artifactList(artifactRow({ expired: true })), RUN), 'artifact-expired', '2027-02-10T02:26:39Z');
  });

  test('an artifact of another run, or of another commit, is refused', () => {
    refused(chooseArtifact(artifactList(artifactRow({ workflow_run: { id: RED_RUN_ID, head_sha: SHA } })), RUN), 'artifact-not-from-run', String(RED_RUN_ID));
    refused(chooseArtifact(artifactList(artifactRow({ workflow_run: { id: RUN_ID, head_sha: RED_SHA } })), RUN), 'artifact-not-from-run', RED_SHA);
    refused(chooseArtifact(artifactList(artifactRow({ workflow_run: null })), RUN), 'artifact-not-from-run', String(RUN_ID));
  });

  test('an artifact with no sha256 digest is refused: nothing binds its bytes to what the run uploaded', () => {
    for (const digest of [null, '', 'md5:abc', `sha256:${ZIP_SHA.slice(1)}`, `sha256:${ZIP_SHA.toUpperCase()}`, ZIP_SHA]) {
      refused(chooseArtifact(artifactList(artifactRow({ digest })), RUN), 'digest-missing', CI_ARTIFACT);
    }
  });

  test('an artifact list that could not be read is "could not tell", never "no artifact"', () => {
    refused(chooseArtifact(failed('HTTP 403'), RUN), 'artifacts-unreadable', 'HTTP 403');
    refused(chooseArtifact(ran('[]'), RUN), 'artifacts-unreadable', String(RUN_ID));
    refused(chooseArtifact(artifactList({ name: CI_ARTIFACT }), RUN), 'artifacts-unreadable', String(RUN_ID));
  });
});

// ── the bytes ────────────────────────────────────────────────────────────────────────────

suite('release: the bytes are the bytes CI uploaded', () => {
  test('sha256Hex is sha256, in lower-case hex', () => {
    assert.equal(sha256Hex(ZIP), ZIP_SHA);
    assert.equal(sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('a zip that hashes to the recorded digest is accepted', () => {
    assert.deepEqual(accepted(checkArtifactDigest(ARTIFACT, ran(''), ZIP)), { sha256: ZIP_SHA });
  });

  test('one changed byte is refused, naming both hashes', () => {
    const tampered = Buffer.from(ZIP);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    refused(checkArtifactDigest(ARTIFACT, ran(''), tampered), 'digest-mismatch', ZIP_SHA, sha256Hex(tampered));
  });

  test('a download that failed is refused before its (partial) bytes are hashed', () => {
    refused(checkArtifactDigest(ARTIFACT, failed('HTTP 410: Gone'), ZIP), 'artifact-download', 'HTTP 410', String(ARTIFACT.id));
  });

  test('the zip holds exactly one entry, the .vsix named for the commit\'s version', () => {
    assert.deepEqual(accepted(checkArtifactEntries(ran(`${VSIX}\n`), VERSION)), { vsixName: VSIX });
  });

  test('no .vsix, two, the wrong version, a path, or anything beside it is refused before anything is unpacked', () => {
    const cases: Array<[string, string]> = [
      ['', VSIX],
      ['build-tutorials-0.0.1.vsix\nbuild-tutorials-0.0.2.vsix\n', 'build-tutorials-0.0.2.vsix'],
      ['build-tutorials-0.0.2.vsix\n', 'build-tutorials-0.0.2.vsix'],
      ['../build-tutorials-0.0.1.vsix\n', '../build-tutorials-0.0.1.vsix'],
      ['dist/build-tutorials-0.0.1.vsix\n', 'dist/build-tutorials-0.0.1.vsix'],
      ['build-tutorials-0.0.1.vsix\nREADME.md\n', 'README.md'],
      ['other-extension-0.0.1.vsix\n', 'other-extension-0.0.1.vsix'],
    ];
    for (const [listing, named] of cases) {
      refused(checkArtifactEntries(ran(listing), VERSION), 'archive-contents', named, VSIX);
    }
  });

  test('a listing unzip could not produce is refused', () => {
    refused(checkArtifactEntries(failed('End-of-central-directory signature not found', 9), VERSION), 'archive-contents', 'End-of-central-directory');
  });

  test('what was unpacked is exactly the one .vsix the listing promised', () => {
    assert.deepEqual(accepted(checkExtraction(ran(''), [VSIX], VSIX)), { vsixName: VSIX });
    refused(checkExtraction(failed('write error', 50), [], VSIX), 'archive-contents', 'write error');
    refused(checkExtraction(ran(''), [], VSIX), 'archive-contents', VSIX);
    refused(checkExtraction(ran(''), [VSIX, 'extra'], VSIX), 'archive-contents', 'extra');
  });

  const vsixManifest = (over: Record<string, unknown> = {}): CommandResult => ran(JSON.stringify({
    name: 'build-tutorials', publisher: 'bma-corgea', version: VERSION, engines: { vscode: '^1.95.0', node: '>=20' }, ...over,
  }));

  test('the manifest inside is this extension at the commit\'s version, and says which VS Code it needs', () => {
    assert.deepEqual(accepted(checkVsixManifest(vsixManifest(), VERSION)), { minimumVscode: '1.95' });
  });

  test('a wrong name, publisher or version is refused, naming the field, what it is and what it should be', () => {
    refused(checkVsixManifest(vsixManifest({ name: 'some-other-extension' }), VERSION), 'vsix-manifest-mismatch', 'name', 'some-other-extension', 'build-tutorials');
    refused(checkVsixManifest(vsixManifest({ publisher: 'someone-else' }), VERSION), 'vsix-manifest-mismatch', 'publisher', 'someone-else', 'bma-corgea');
    refused(checkVsixManifest(vsixManifest({ version: '0.0.2' }), VERSION), 'vsix-manifest-mismatch', 'version', '0.0.2', VERSION);
    refused(checkVsixManifest(vsixManifest({ engines: { vscode: '*' } }), VERSION), 'vsix-manifest-mismatch', 'engines.vscode', '*');
    refused(checkVsixManifest(vsixManifest({ engines: undefined }), VERSION), 'vsix-manifest-mismatch', 'engines.vscode');
  });

  test('a manifest unzip could not read, or that is not JSON, is refused', () => {
    refused(checkVsixManifest(failed('caution: filename not matched:  extension/package.json', 11), VERSION), 'vsix-manifest-unreadable', 'filename not matched');
    refused(checkVsixManifest(ran('<xml/>'), VERSION), 'vsix-manifest-unreadable', 'extension/package.json');
  });

  test('the shipped package.json, as a .vsix carries it, passes at its own version', () => {
    const minimum = accepted(checkVsixManifest(ran(read('package.json')), MANIFEST.version)).minimumVscode;
    assert.equal(minimum, minimumVscode(MANIFEST.engines.vscode));
  });

  test('minimumVscode reads a caret or a >= range and refuses to guess at anything else', () => {
    assert.equal(minimumVscode('^1.95.0'), '1.95');
    assert.equal(minimumVscode('>=1.95.0'), '1.95');
    assert.equal(minimumVscode('^1.101.2'), '1.101');
    for (const engine of ['*', '1.95.0', '~1.95.0', '^1.95.0 || ^2.0.0', '', undefined, 195]) {
      assert.equal(minimumVscode(engine), null, String(engine));
    }
  });
});

// ── the notes ────────────────────────────────────────────────────────────────────────────

suite('release: the notes a stranger reads', () => {
  const V = MANIFEST.version;
  const NAME = vsixFileName(V);
  const VSIX_SHA = 'ef14025732e191e8c4f0742be9eef2e277bc3affc88d4ba817d058ecf3e1af08';
  const notes = (minimum = '1.95', runner = '1.146.0'): string => composeReleaseNotes({
    version: V, sha: SHA, run: { id: RUN_ID, url: RUN_URL }, vsixName: NAME, vsixSha256: VSIX_SHA, minimumVscode: minimum,
    runnerVscode: runner,
  });
  /** Prose wraps; what is being compared is the words. */
  const flat = (s: string): string => s.replace(/\s+/g, ' ');

  test('they say what it is', () => {
    const text = flat(notes());
    assert.ok(text.includes('VS Code extension that turns an existing repository into a step-by-step tutorial for rebuilding it'), text);
  });

  test('they say what it needs: VS Code or VSCodium 1.95 or later, git, and a logged-in claude CLI', () => {
    // Review N12: VSCodium is held to the same engines.vscode floor as VS Code.
    const text = flat(notes());
    for (const needed of ['VS Code or VSCodium 1.95 or later', 'git', '`claude` CLI', 'logged in']) {
      assert.ok(text.includes(needed), `the notes should say ${needed}`);
    }
  });

  test('the minimum VS Code they state is the one passed in (the .vsix\'s own engines), not a literal', () => {
    const text = flat(notes('1.99'));
    assert.ok(text.includes('VS Code or VSCodium 1.99 or later'), text);
    assert.ok(!text.includes('1.95'), 'a second, typed copy of the minimum would drift from the manifest');
  });

  test('they say what THIS file\'s own run proved: the runner\'s VS Code as that run reported it, Linux only', () => {
    // Review S3. The notes used to carry the project's dated record word for word, "VS Code 1.146.0 on
    // GitHub's runner", which run 43141446029 proved of the 0.0.1 build. The run the notes link is a
    // different one, so the version they name is now the one that run's own log names, passed in.
    const text = flat(notes('1.95', '1.147.3'));
    assert.ok(text.includes("Proven on Linux only: the install check in the CI run below installed this file into VS Code 1.147.3 on GitHub's Ubuntu runner and proved it activates."), text);
    assert.ok(text.includes('macOS and Windows are unproven'), text);
    assert.ok(text.includes(REPOSITORY_ONLY), text);
    for (const never of ['1.146.0', '1.145.2', 'maintainer', 'build machine', PROVEN_ON_LINUX]) {
      assert.ok(!text.includes(never), `the notes must not carry a claim this file's run did not make: ${never}`);
    }
  });

  test('the project\'s dated record names the maintainer\'s machine, not "the build machine" a stranger reads as CI', () => {
    assert.ok(PROVEN_ON_LINUX.startsWith('Proven on Linux only'), PROVEN_ON_LINUX);
    assert.ok(PROVEN_ON_LINUX.includes("the maintainer's machine"), PROVEN_ON_LINUX);
    assert.ok(!PROVEN_ON_LINUX.includes('build machine'), PROVEN_ON_LINUX);
    assert.ok(PROVEN_ON_LINUX.includes('macOS and Windows are unproven'), PROVEN_ON_LINUX);
    assert.ok(REPOSITORY_ONLY.includes('existing repository only'), REPOSITORY_ONLY);
  });

  test('they say how to install from the file, with the file\'s exact name', () => {
    const text = flat(notes());
    for (const needed of [
      `Download \`${NAME}\``, `code --install-extension ${NAME}`, `codium --install-extension ${NAME}`,
      'Install from VSIX', 'Build Tutorials: Doctor',
    ]) {
      assert.ok(text.includes(needed), `the notes should say ${needed}`);
    }
  });

  test('they name the .vsix sha256, the CI run and the commit it came from', () => {
    const text = notes();
    for (const needed of [VSIX_SHA, RUN_URL, SHA, `sha256sum ${NAME}`]) {
      assert.ok(text.includes(needed), `the notes should name ${needed}`);
    }
  });

  test('each paragraph is one line: GitHub renders a single newline in a release body as a line break', () => {
    let inFence = false;
    let prose = 0;
    for (const line of notes().split('\n')) {
      if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
      if (inFence || line.trim() === '' || line.startsWith('#')) continue;
      prose += 1;
      assert.match(line, /[.:]$/, `a line that does not end a sentence breaks mid-sentence on GitHub: ${line}`);
    }
    assert.ok(prose >= 10, `the control: the notes have prose to check (${prose} lines)`);
  });

  test('they carry no ticket number and no local path', () => {
    const text = notes();
    assert.ok(text.includes(RUN_URL), 'the control: these are the notes, not an empty string that contains nothing');
    assert.ok(!/\bT-\d/.test(text), 'an internal ticket number is not something a stranger can read');
    assert.ok(!text.includes('/home/'), 'a local path is not something a stranger can read');
    assert.ok(!text.includes(ROOT), 'nor is this checkout');
  });
});

// ── the command, printed and never run ───────────────────────────────────────────────────

suite('release: the command is printed, never run, and makes a DRAFT', () => {
  const V = MANIFEST.version;
  const NOTES = '/a path with spaces/.scratch/release/v0.1.0/run-1-abc/notes.md';
  const FILE = `/a path with spaces/.scratch/release/v0.1.0/run-1-abc/ci-vsix/${vsixFileName(V)}`;
  const draft: ExistingRelease = { tagName: `v${V}`, isDraft: true, targetCommitish: RED_SHA, assets: [] };
  const plan = (existing: ExistingRelease | null, over: Partial<{ sha: string; notesPath: string; vsixPath: string }> = {}) =>
    releaseCommands({ version: V, sha: SHA, notesPath: NOTES, vsixPath: FILE, existing, ...over });

  test('no release yet: one `gh release create`, a draft, at the full sha, with the notes and the .vsix', () => {
    const value = accepted(plan(null));
    assert.equal(value.mode, 'create');
    assert.deepEqual(value.commands.map((c) => c.argv), [[
      'gh', 'release', 'create', `v${V}`, '--repo', 'BMA-Corgea/VSCode-LLM-Tutorial', '--draft', '--target', SHA,
      '--title', `Build Tutorials ${V}`, '--notes-file', NOTES, FILE,
    ]]);
  });

  test('the printed line is runnable as printed, though the paths have spaces', () => {
    const line = accepted(plan(null)).commands[0]?.line ?? '';
    assert.ok(line.startsWith(`gh release create v${V} `), line);
    for (const quoted of [`'${NOTES}'`, `'${FILE}'`, `'Build Tutorials ${V}'`]) assert.ok(line.includes(quoted), line);
    assert.ok(!line.includes(` ${NOTES}`), 'an unquoted path with a space in it is two words');
  });

  test('a draft already there: upload the .vsix over its asset, then edit it back to a draft at this sha', () => {
    const value = accepted(plan(draft));
    assert.equal(value.mode, 'update');
    assert.deepEqual(value.commands.map((c) => c.argv), [
      ['gh', 'release', 'upload', `v${V}`, FILE, '--clobber', '--repo', 'BMA-Corgea/VSCode-LLM-Tutorial'],
      ['gh', 'release', 'edit', `v${V}`, '--repo', 'BMA-Corgea/VSCode-LLM-Tutorial', '--draft', '--target', SHA,
        '--title', `Build Tutorials ${V}`, '--notes-file', NOTES],
    ]);
  });

  test('a release already PUBLISHED is refused: nothing this prints may turn it back into a draft', () => {
    refused(plan({ ...draft, isDraft: false }), 'release-published', `v${V}`);
  });

  test('a draft carrying any other asset is refused, naming it: the upload would add beside it, not replace it', () => {
    // Review N4. "These replace its .vsix" was untrue whenever the draft's asset had another name.
    const asset = (name: string): { name: string; size: number } => ({ name, size: 1 });
    assert.equal(accepted(plan({ ...draft, assets: [asset(vsixFileName(V))] })).mode, 'update', 'the control: its own .vsix is replaced');
    refused(plan({ ...draft, assets: [asset('build-tutorials-0.0.9.vsix')] }), 'draft-asset', 'build-tutorials-0.0.9.vsix');
    refused(plan({ ...draft, assets: [asset(vsixFileName(V)), asset(`${vsixFileName(V)}.zip`)] }), 'draft-asset', `${vsixFileName(V)}.zip`);
  });

  test('every command it can print is a draft release command, at a full sha, and the shell may not run one', () => {
    for (const existing of [null, draft]) {
      for (const { argv } of accepted(plan(existing)).commands) {
        assert.deepEqual(argv.slice(0, 2), ['gh', 'release']);
        assert.ok(['create', 'upload', 'edit'].includes(argv[2] ?? ''), argv.join(' '));
        if (argv[2] !== 'upload') {
          assert.ok(argv.includes('--draft'), `${argv.join(' ')} must keep the release a draft`);
          assert.equal(argv[argv.indexOf('--target') + 1], SHA);
        }
        for (const never of ['--latest', '--prerelease', '--draft=false', '--verify-tag', 'delete', 'publish']) {
          assert.ok(!argv.includes(never), `${argv.join(' ')} must not carry ${never}`);
        }
        assert.equal(isReadOnlyGh(argv.slice(1)), false, `the shell must refuse to run ${argv.join(' ')}`);
      }
    }
  });

  test('a short sha, a relative path, or a "#" in the .vsix path (gh reads it as a label) is refused', () => {
    refused(plan(null, { sha: '7050fd2' }), 'unsafe-argument', '7050fd2');
    refused(plan(null, { notesPath: 'notes.md' }), 'unsafe-argument', 'notes.md');
    refused(plan(null, { vsixPath: '/tmp/a#b/x.vsix' }), 'unsafe-argument', '/tmp/a#b/x.vsix');
  });

  test('the tag, the title and the file name all come from the one version', () => {
    assert.equal(releaseTag('0.1.0'), 'v0.1.0');
    assert.equal(releaseTitle('0.1.0'), 'Build Tutorials 0.1.0');
    assert.equal(vsixFileName('0.1.0'), 'build-tutorials-0.1.0.vsix');
  });
});

// ── an existing release, and --verify-draft ──────────────────────────────────────────────

suite('release: what is already on GitHub', () => {
  const V = MANIFEST.version;
  const TAG = `v${V}`;
  const view = (over: Record<string, unknown> = {}): CommandResult => ran(JSON.stringify({
    tagName: TAG, isDraft: true, targetCommitish: SHA, assets: [{ name: vsixFileName(V), size: 7043069 }], ...over,
  }));
  const H = 'ef14025732e191e8c4f0742be9eef2e277bc3affc88d4ba817d058ecf3e1af08';
  const OTHER = 'a'.repeat(64);

  test('a release that exists is read: tag, draft or not, target and assets', () => {
    assert.deepEqual(accepted(readExistingRelease(view(), V)), {
      tagName: TAG, isDraft: true, targetCommitish: SHA, assets: [{ name: vsixFileName(V), size: 7043069 }],
    });
  });

  test('"release not found" means none, and it is the only answer that does', () => {
    assert.equal(accepted(readExistingRelease(failed('release not found\n'), V)), null);
  });

  test('any other failure is "could not tell", never "none": a create over a draft that IS there would collide', () => {
    refused(readExistingRelease(failed('HTTP 401: Bad credentials'), V), 'release-state-unknown', TAG, 'HTTP 401');
    refused(readExistingRelease(failed(''), V), 'release-state-unknown', TAG);
    refused(readExistingRelease(failed('release not found', null), V), 'release-state-unknown', TAG);
    refused(readExistingRelease(ran('not json'), V), 'release-state-unknown', TAG);
    refused(readExistingRelease(view({ tagName: 'v9.9.9' }), V), 'release-state-unknown', 'v9.9.9');
  });

  test('--verify-draft: a draft at this sha is the one to check', () => {
    const release = accepted(readExistingRelease(view(), V));
    assert.ok(release);
    assert.equal(accepted(checkDraftRelease(release, V, SHA)).targetCommitish, SHA);
  });

  test('--verify-draft: no release, or one that targets something else, is refused', () => {
    refused(checkDraftRelease(null, V, SHA), 'no-draft', TAG);
    const onMain: ExistingRelease = { tagName: TAG, isDraft: true, targetCommitish: 'main', assets: [{ name: vsixFileName(V), size: 1 }] };
    refused(checkDraftRelease(onMain, V, SHA), 'draft-target', 'main', SHA);
  });

  test('--verify-draft: the draft must carry exactly one asset, the .vsix, so a stray one cannot pass beside a MATCH', () => {
    // Review N4: the download takes only `*.vsix`, so a `.vsix.zip` or a `.VSIX` on the draft was never looked at.
    const withAssets = (...names: string[]): ExistingRelease => ({
      tagName: TAG, isDraft: true, targetCommitish: SHA, assets: names.map((name) => ({ name, size: 1 })),
    });
    refused(checkDraftRelease(withAssets(), V, SHA), 'draft-asset', vsixFileName(V), 'none');
    refused(checkDraftRelease(withAssets(vsixFileName(V), `${vsixFileName(V)}.zip`), V, SHA), 'draft-asset', `${vsixFileName(V)}.zip`);
    refused(checkDraftRelease(withAssets(vsixFileName(V).toUpperCase()), V, SHA), 'draft-asset', vsixFileName(V).toUpperCase());
  });

  test('--verify-draft: the draft\'s .vsix hashing to the CI artifact\'s is a MATCH', () => {
    const files = [{ name: vsixFileName(V), sha256: H }];
    assert.deepEqual(accepted(checkDraftAsset({ version: V, download: ran(''), files, expectedSha256: H })), { sha256: H });
  });

  test('--verify-draft: a different hash is refused, naming both', () => {
    const files = [{ name: vsixFileName(V), sha256: OTHER }];
    refused(checkDraftAsset({ version: V, download: ran(''), files, expectedSha256: H }), 'draft-mismatch', H, OTHER);
  });

  test('--verify-draft: no .vsix, two, a wrongly named one, or a download that failed is refused', () => {
    const check = (files: Array<{ name: string; sha256: string }>, download = ran('')) =>
      checkDraftAsset({ version: V, download, files, expectedSha256: H });
    refused(check([]), 'draft-asset', vsixFileName(V));
    refused(check([{ name: vsixFileName(V), sha256: H }, { name: 'build-tutorials-0.0.9.vsix', sha256: H }]), 'draft-asset', 'build-tutorials-0.0.9.vsix');
    refused(check([{ name: 'renamed.vsix', sha256: H }]), 'draft-asset', 'renamed.vsix');
    refused(check([], failed('no assets match the file pattern')), 'draft-asset', 'no assets match');
  });
});

// ── no tag and no second draft in the way (review S1, S2) ────────────────────────────────

suite('release: no tag elsewhere, no second release, and drafts this login can see', () => {
  const V = MANIFEST.version;
  const TAG = `v${V}`;
  const TAG_OBJECT = 'c089584ac8dedc3aa7c2c404839bc098050298a2';
  const NOT_FOUND = 'gh: Not Found (HTTP 404)\n';
  const refRow = (type: string, sha: string, ref = `refs/tags/${TAG}`): CommandResult =>
    ran(JSON.stringify({ ref, object: { sha, type, url: `https://api.github.com/x/${sha}` } }));
  const tagObject = (type: string, sha: string, own = TAG_OBJECT): CommandResult =>
    ran(JSON.stringify({ sha: own, tag: TAG, object: { sha, type } }));
  const draftOf = (isDraft = true): ExistingRelease => ({ tagName: TAG, isDraft, targetCommitish: SHA, assets: [] });
  const releases = (...rows: Array<Record<string, unknown>>): CommandResult => ran(JSON.stringify(rows));

  test('S1: exactly gh\'s "Not Found (HTTP 404)" means there is no tag', () => {
    assert.deepEqual(accepted(readTagRef(failed(NOT_FOUND), V)), { kind: 'none' });
  });

  test('S1: any other failure, or an answer that is not this tag\'s ref, is "could not tell", never "no tag"', () => {
    refused(readTagRef(failed('gh: Bad credentials (HTTP 401)'), V), 'tag-state-unknown', TAG, 'HTTP 401');
    refused(readTagRef(failed(NOT_FOUND, 2), V), 'tag-state-unknown', TAG);
    refused(readTagRef(failed('', null), V), 'tag-state-unknown', TAG);
    refused(readTagRef(ran('not json'), V), 'tag-state-unknown', TAG);
    refused(readTagRef(refRow('commit', SHA, 'refs/tags/v9.9.9'), V), 'tag-state-unknown', 'refs/tags/v9.9.9');
    refused(readTagRef(refRow('tree', SHA), V), 'tag-state-unknown', 'tree');
    refused(readTagRef(refRow('commit', 'not-a-sha'), V), 'tag-state-unknown', TAG);
  });

  test('S1: a lightweight tag names its commit; an annotated one names a tag object, read once more', () => {
    assert.deepEqual(accepted(readTagRef(refRow('commit', SHA), V)), { kind: 'commit', sha: SHA });
    assert.deepEqual(accepted(readTagRef(refRow('tag', TAG_OBJECT), V)), { kind: 'tag', sha: TAG_OBJECT });
    assert.equal(accepted(peelTagObject(tagObject('commit', RED_SHA), V, TAG_OBJECT)), RED_SHA);
  });

  test('S1: a tag object that cannot be read, is another object, or names a tag again is "could not tell"', () => {
    refused(peelTagObject(failed('gh: Server Error (HTTP 502)'), V, TAG_OBJECT), 'tag-state-unknown', TAG_OBJECT, 'HTTP 502');
    refused(peelTagObject(tagObject('commit', SHA, RED_SHA), V, TAG_OBJECT), 'tag-state-unknown', TAG_OBJECT);
    refused(peelTagObject(tagObject('tag', RED_SHA), V, TAG_OBJECT), 'tag-state-unknown', TAG_OBJECT, 'tag');
    refused(peelTagObject(ran('{}'), V, TAG_OBJECT), 'tag-state-unknown', TAG_OBJECT);
  });

  test('S1: a tag at another commit is refused, because GitHub ignores --target when the tag exists', () => {
    const r = refused(checkTagTarget(RED_SHA, V, SHA), 'tag-elsewhere', TAG, RED_SHA, SHA, '--target');
    assert.ok(/owner/.test(r.remedy), r.remedy);
  });

  test('S1: no tag, or a tag already at the commit being released, is accepted', () => {
    assert.equal(accepted(checkTagTarget(null, V, SHA)), 'none');
    assert.equal(accepted(checkTagTarget(SHA, V, SHA)), 'at-commit');
  });

  test('S2: a login that can push sees drafts; one that cannot is refused, never read as "no draft"', () => {
    assert.equal(accepted(checkDraftsVisible(ran('true\n'))), null);
    const r = refused(checkDraftsVisible(ran('false\n')), 'drafts-invisible', RELEASE_REPO);
    assert.ok(/gh auth status/.test(r.remedy), r.remedy);
    refused(checkDraftsVisible(ran('null\n')), 'release-state-unknown', 'null');
    refused(checkDraftsVisible(failed('gh: Bad credentials (HTTP 401)')), 'release-state-unknown', 'HTTP 401');
  });

  test('S2: two releases carrying the tag are refused, naming both: gh view, upload, edit and download act on one', () => {
    const two = releases({ id: 111111, tag_name: TAG, draft: true }, { id: 222222, tag_name: TAG, draft: true });
    refused(checkReleaseList(two, V, draftOf()), 'release-ambiguous', TAG, '111111', '222222');
  });

  test('S2: a full page of releases is "could not tell": a release with the tag could be on the next page', () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: `v0.0.${i}-old`, draft: false }));
    refused(checkReleaseList(releases(...page), V, null), 'release-state-unknown', '100');
  });

  test('S2: the list and gh release view must agree, or which release is meant cannot be told', () => {
    assert.deepEqual(accepted(checkReleaseList(releases(), V, null)), { withTag: 0 });
    assert.deepEqual(accepted(checkReleaseList(releases({ id: 1, tag_name: 'v0.0.1', draft: false }), V, null)), { withTag: 0 });
    assert.deepEqual(accepted(checkReleaseList(releases({ id: 7, tag_name: TAG, draft: true }), V, draftOf())), { withTag: 1 });
    refused(checkReleaseList(releases({ id: 7, tag_name: TAG, draft: true }), V, null), 'release-state-unknown', TAG);
    refused(checkReleaseList(releases(), V, draftOf()), 'release-state-unknown', TAG);
    refused(checkReleaseList(releases({ id: 7, tag_name: TAG, draft: false }), V, draftOf()), 'release-state-unknown', TAG);
  });

  test('S2: a release list that could not be read is "could not tell"', () => {
    refused(checkReleaseList(failed('gh: Not Found (HTTP 404)'), V, null), 'release-state-unknown', 'HTTP 404');
    refused(checkReleaseList(ran('{}'), V, null), 'release-state-unknown', TAG);
    refused(checkReleaseList(releases({ id: 'x', tag_name: TAG }), V, null), 'release-state-unknown', TAG);
  });
});

// ── the shell only reads ─────────────────────────────────────────────────────────────────

suite('release: every gh command the shell runs is a read', () => {
  test('each command the shell is given to run passes the read-only check', () => {
    const reads = [
      ghRead.compare(SHA), ghRead.runList(SHA), ghRead.runView(RUN_ID), ghRead.artifacts(RUN_ID),
      ghRead.artifactZip(13910310691), ghRead.releaseView('0.1.0'), ghRead.releaseDownload('0.1.0', '/a dir/draft-asset'),
      ghRead.pushPermission(), ghRead.releases(), ghRead.tagRef('0.1.0'), ghRead.tagObject('c089584ac8dedc3aa7c2c404839bc098050298a2'),
    ];
    for (const args of reads) assert.equal(isReadOnlyGh(args), true, `gh ${args.join(' ')}`);
    for (const args of reads) {
      const target = args[1] ?? '';
      assert.ok(args.includes('--repo') || target === `repos/${RELEASE_REPO}` || target.startsWith(`repos/${RELEASE_REPO}/`), `gh ${args.join(' ')} names the repository`);
    }
  });

  test('the tag, release-list and permission reads are the ones the review names', () => {
    assert.deepEqual(ghRead.tagRef('0.1.0'), ['api', `repos/${RELEASE_REPO}/git/ref/tags/v0.1.0`]);
    assert.deepEqual(ghRead.tagObject('abc'), ['api', `repos/${RELEASE_REPO}/git/tags/abc`]);
    assert.deepEqual(ghRead.releases(), ['api', `repos/${RELEASE_REPO}/releases?per_page=100`]);
    assert.deepEqual(ghRead.pushPermission(), ['api', `repos/${RELEASE_REPO}`, '--jq', '.permissions.push']);
  });

  test('the commands it asks gh for are the ones the ticket names', () => {
    assert.deepEqual(ghRead.runList(SHA).slice(0, 8), ['run', 'list', '--repo', RELEASE_REPO, '--workflow', RELEASE_WORKFLOW, '--commit', SHA]);
    assert.deepEqual(ghRead.runView(RUN_ID), ['run', 'view', String(RUN_ID), '--repo', RELEASE_REPO, '--json', 'jobs']);
    assert.equal(ghRead.artifactZip(13910310691)[1], `repos/${RELEASE_REPO}/actions/artifacts/13910310691/zip`);
    assert.deepEqual(ghRead.releaseDownload('0.1.0', '/d'), ['release', 'download', 'v0.1.0', '--repo', RELEASE_REPO, '--pattern', '*.vsix', '--dir', '/d']);
    for (const field of ['databaseId', 'headSha', 'event', 'headBranch', 'status', 'conclusion', 'url']) {
      assert.ok((ghRead.runList(SHA).at(-1) ?? '').split(',').includes(field), field);
    }
  });

  test('a write, in any of the shapes gh accepts, is refused', () => {
    const writes = [
      ['release', 'create', 'v0.1.0'], ['release', 'edit', 'v0.1.0'], ['release', 'upload', 'v0.1.0', 'x'],
      ['release', 'delete', 'v0.1.0'], ['run', 'rerun', '1'], ['run', 'cancel', '1'], ['workflow', 'run', 'CI'],
      ['api', `repos/${RELEASE_REPO}/releases`, '-X', 'POST'], ['api', `repos/${RELEASE_REPO}/releases`, '-XPOST'],
      ['api', `repos/${RELEASE_REPO}/releases`, '--method', 'POST'], ['api', `repos/${RELEASE_REPO}/releases`, '--method=PATCH'],
      ['api', `repos/${RELEASE_REPO}/releases`, '-f', 'tag_name=v0.1.0'], ['api', `repos/${RELEASE_REPO}/releases`, '-F', 'draft=true'],
      ['api', `repos/${RELEASE_REPO}/releases`, '--field', 'x=y'], ['api', `repos/${RELEASE_REPO}/releases`, '--raw-field', 'x=y'],
      ['api', `repos/${RELEASE_REPO}/releases`, '--input', 'body.json'], ['api', 'graphql'], ['api', 'repos/someone/else/releases'],
      ['api', `repos/${RELEASE_REPO}-other/releases`], ['api', `repos/${RELEASE_REPO}`, '-X', 'DELETE'], ['api', `repos/${RELEASE_REPO}`, '-f', 'private=true'],
      [], ['auth', 'token'],
    ];
    assert.equal(isReadOnlyGh(ghRead.runView(RUN_ID)), true, 'the control: a check that refuses everything is not a check');
    for (const args of writes) assert.equal(isReadOnlyGh(args), false, `gh ${args.join(' ')} must not count as a read`);
  });
});

// ── the copies agree with what ships ─────────────────────────────────────────────────────

suite('release: every name this holds is the one that ships', () => {
  test('the repository, workflow, branch, event and artifact are the ones package.json and ci.yml use', () => {
    assert.equal(MANIFEST.repository.url, `https://github.com/${RELEASE_REPO}`);
    assert.equal(RELEASES_URL, `https://github.com/${RELEASE_REPO}/releases`);
    assert.equal(/^name:\s*(.+?)\s*$/m.exec(CI)?.[1], RELEASE_WORKFLOW);
    assert.match(CI, new RegExp(`^\\s*${RELEASE_EVENT}:\\s*\\n\\s*branches:\\s*\\[\\s*${RELEASE_BRANCH}\\s*\\]`, 'm'));
    assert.equal(VSIX_ARTIFACT_NAME, CI_ARTIFACT);
  });

  test('every step the release relies on is a step ci.yml runs, exactly once', () => {
    assert.ok(REQUIRED_STEPS.length >= 3, 'packaging, the install check and the upload');
    for (const required of REQUIRED_STEPS) {
      const matching = ciStepNames().filter((name) => name.startsWith(required.prefix));
      assert.equal(matching.length, 1, `${required.prefix} should name one ci.yml step, found ${JSON.stringify(matching)}`);
    }
  });

  test('the extension is package.json\'s, and the .vsix name is the one scripts/package.mjs writes', () => {
    assert.equal(EXTENSION_NAME, MANIFEST.name);
    assert.equal(EXTENSION_PUBLISHER, MANIFEST.publisher);
    assert.equal(vsixFileName(MANIFEST.version), expectedArtifactName({
      publisher: MANIFEST.publisher, name: MANIFEST.name, version: MANIFEST.version,
      license: null, private: true, repository: null,
    }));
  });

  test('package-lock.json\'s own two version fields are package.json\'s', () => {
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(lock.version, MANIFEST.version);
    assert.equal(lock.packages['']?.version, MANIFEST.version);
  });

  test('CHANGELOG.md has an entry for this version, in the notes\' own words, and no ticket number anywhere', () => {
    // The personal-name half of "nothing internal in it" is the disclosure scan's: CHANGELOG.md
    // ships inside the .vsix (scripts/package.mjs stages it), and `npm run package` reads every
    // text file in the archive for the names it is given at run time.
    const changelog = read('CHANGELOG.md');
    assert.ok(!/\bT-\d/.test(changelog), 'an internal ticket number in a public changelog');
    const start = changelog.indexOf(`## ${MANIFEST.version} (`);
    assert.ok(start >= 0, `CHANGELOG.md has no "## ${MANIFEST.version} (<date>)" entry`);
    const next = changelog.indexOf('\n## ', start + 1);
    const entry = changelog.slice(start, next < 0 ? undefined : next).replace(/\s+/g, ' ');
    const minimum = minimumVscode(MANIFEST.engines.vscode) ?? '(unreadable engines.vscode)';
    for (const needed of [
      PROVEN_ON_LINUX, REPOSITORY_ONLY, `VS Code or VSCodium ${minimum} or later`, 'git', '`claude` CLI', 'logged in',
      // Review N7: imports are present or missing, never "extra" (src/dial/core.ts).
      'the imports that are present or missing',
    ]) {
      assert.ok(entry.includes(needed), `the ${MANIFEST.version} entry should say ${needed}`);
    }
    assert.ok(!entry.includes('exports and imports that are present, missing or extra'), 'imports are never "extra"');
  });

  test('README.md\'s Install links the Releases page, names this version\'s .vsix, and states the same requirements', () => {
    // A version bump that leaves the README's commands naming the old file goes red here: the
    // Install section is what a stranger copies, and a stale name is a command that fails.
    const readme = read('README.md');
    const start = readme.indexOf('\n## Install\n');
    assert.ok(start >= 0, 'README.md has an "## Install" section');
    const end = readme.indexOf('\n---', start + 1);
    const section = readme.slice(start, end < 0 ? undefined : end);
    const text = section.replace(/\s+/g, ' ');
    const name = vsixFileName(MANIFEST.version);
    const minimum = minimumVscode(MANIFEST.engines.vscode) ?? '(unreadable engines.vscode)';
    for (const needed of [
      RELEASES_URL, 'latest release', `codium --install-extension ${name}`, `code --install-extension ${name}`,
      `VS Code or VSCodium ${minimum} or later`, 'git', '`claude` CLI', 'logged in', PROVEN_ON_LINUX, REPOSITORY_ONLY,
    ]) {
      assert.ok(text.includes(needed), `the Install section should say ${needed}`);
    }
    const named = [...section.matchAll(/build-tutorials-\d+\.\d+\.\d+[^\s`]*?\.vsix/g)].map((m) => m[0]);
    assert.ok(named.length >= 2 && named.every((n) => n === name), `every .vsix the Install section names is ${name}: ${named.join(', ')}`);
  });
});
