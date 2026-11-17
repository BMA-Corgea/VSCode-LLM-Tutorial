// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE RELEASE: which bytes may go on a draft GitHub release, decided as values (T-140).
 *
 * A stranger installs this extension from the `.vsix` on the repository's Releases page. That
 * file has to be the one CI built and checked for one exact commit on `main` (the artifact whose
 * Package step read the archive back and whose install step proved it activates) and never one
 * built on somebody's machine, where nothing records what went into it. This module is how that
 * sentence is made true by construction rather than by care.
 *
 * ── What is decided here, and what is not ─────────────────────────────────────────────────
 *
 * Every function is pure. It takes what a command PRINTED (a `CommandResult`) or the bytes a
 * download wrote, and returns a verdict. It runs nothing and touches no file, so nothing in this
 * file, its tests, or an import of it can talk to GitHub. `scripts/release-draft.mjs` is the
 * shell: it runs the read-only commands `ghRead` builds, hands each result here, and prints.
 *
 * The chain, in the order the shell walks it. Every link that fails is a `Refusal`: a reason and
 * a remedy, each a sentence, so the person reading it knows what is wrong and what to do.
 *
 *   1. the commit    a hex sha (never a ref: GitHub's main and this checkout's can disagree),
 *                    resolved by this checkout to the full sha. Its version is the one in ITS
 *                    OWN package.json (`git show <sha>:package.json`), not the working tree's.
 *   2. on main       GitHub's compare of `<sha>...main` is `identical` or `ahead`: main has it.
 *   3. the run       exact headSha, event push, branch main, completed, success; and EVERY step
 *                    of every job success, including the three steps the notes' claim rests on.
 *   4. the artifact  `build-tutorials-vsix`, of that run and that commit, unexpired, carrying the
 *                    sha256 digest GitHub recorded at upload; the zip downloaded hashes to it.
 *   5. the .vsix     the zip holds exactly `build-tutorials-<version>.vsix` and nothing else, and
 *                    its `extension/package.json` is this extension at that version.
 *   6. the notes and the command, composed here and PRINTED by the shell, never run.
 *
 * ── THE LINE: nothing here writes to GitHub ───────────────────────────────────────────────
 *
 * Creating the draft is the owner's act. So the commands that write exist only as text to print
 * (`releaseCommands`), and they always leave a DRAFT at a full sha: `gh release create --draft`,
 * or, over a draft that is already there, `upload --clobber` and `edit --draft`. A release that
 * is already published is refused rather than offered an `edit --draft`, which would quietly
 * take it down again.
 *
 * The commands the shell RUNS come from `ghRead` and pass `isReadOnlyGh`, an allowlist of read
 * shapes: `run list|view`, `release view|download`, and `api` GETs of this repository with only
 * `--jq` after the path (a single `-f` turns `gh api` into a POST). The shell checks every argv
 * against it before running anything, and the unit suite asserts that every command this module
 * can print FAILS it, so a printed write cannot be run by some later edit's mistake.
 *
 * ── Two refusals that are easy to get wrong ───────────────────────────────────────────────
 *
 * "Could not tell" is never "found nothing" (`autodev/instructions/empty-is-not-absence.md`). A
 * run list `gh` failed to fetch is `run-list-unreadable`, not `no-run`. A `gh release view` that
 * failed for any reason other than "release not found" is `release-state-unknown`, not "there is
 * none", because printing a `create` over a draft that IS there is the collision to avoid.
 *
 * What the checks bind, exactly. The digest binds BYTES, the entry check binds a FILE NAME, and
 * the manifest check binds what is INSIDE: the asset is the zip GitHub stored for that run,
 * unchanged, holding this extension at that version. None of them says the run tested what it
 * should have. That is what "every step green, and the three named steps present" is for.
 *
 * ── What the notes say was proven, and where that comes from ──────────────────────────────
 *
 * The notes name only what THIS file's own run proved: its install check installed this .vsix into
 * VS Code <X> on GitHub's Ubuntu runner, where <X> is read from that run's own job log
 * (`readRunnerVscode`: the one version its tests validated, beside the install check's
 * "PROVEN   Visual Studio Code"). They used to carry `PROVEN_ON_LINUX` word for word, whose "1.146.0
 * on GitHub's runner" was run 43141446029's proof of the 0.0.1 build, not of the file a later run
 * builds (review S3). `PROVEN_ON_LINUX` stays as the project's dated record, in CHANGELOG.md and the
 * README, where it says which machines proved which build.
 */

import { createHash } from 'node:crypto';
import { commandLine } from './plan.js';

/** What a command printed, as the shell hands it over. The shell interprets none of it. */
export interface CommandResult {
  /** the exit status, or null when the command could not be run at all */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type ReleaseRefusalCode =
  | 'bad-sha-argument'
  | 'commit-not-found'
  | 'commit-manifest-unreadable'
  | 'compare-unreadable'
  | 'not-on-main'
  | 'run-list-unreadable'
  | 'no-run'
  | 'run-not-green'
  | 'jobs-unreadable'
  | 'job-log-unreadable'
  | 'runner-version-unknown'
  | 'step-not-green'
  | 'job-not-green'
  | 'required-step-missing'
  | 'artifacts-unreadable'
  | 'no-artifact'
  | 'artifact-ambiguous'
  | 'artifact-expired'
  | 'artifact-not-from-run'
  | 'digest-missing'
  | 'artifact-download'
  | 'digest-mismatch'
  | 'archive-contents'
  | 'vsix-manifest-unreadable'
  | 'vsix-manifest-mismatch'
  | 'release-state-unknown'
  | 'release-published'
  | 'drafts-invisible'
  | 'release-ambiguous'
  | 'tag-state-unknown'
  | 'tag-elsewhere'
  | 'unsafe-argument'
  | 'no-draft'
  | 'draft-target'
  | 'draft-asset'
  | 'draft-mismatch';

/** A link of the chain that did not hold: what is wrong, and what to do, each a sentence. */
export interface Refusal {
  ok: false;
  code: ReleaseRefusalCode;
  reason: string;
  remedy: string;
}

export type Checked<T> = { ok: true; value: T } | Refusal;

const accept = <T>(value: T): Checked<T> => ({ ok: true, value });
const refuse = (code: ReleaseRefusalCode, reason: string, remedy: string): Refusal => ({ ok: false, code, reason, remedy });

/** A refusal as the shell prints it: the reason, then the remedy. */
export function refusalText(refusal: Refusal): string {
  return `${refusal.reason} ${refusal.remedy}`;
}

// ── what is released, and from where ─────────────────────────────────────────────────────

/** Where the release lives. `package.json`'s `repository.url` names the same one (unit-tested). */
export const RELEASE_REPO = 'BMA-Corgea/VSCode-LLM-Tutorial';
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;
/** `.github/workflows/ci.yml`'s `name:`, its `on.push.branches`, and the event that is a release. */
export const RELEASE_WORKFLOW = 'CI';
/** The workflow by its FILE, which is unique, where its display name need not be (review N9). */
const RELEASE_WORKFLOW_FILE = 'ci.yml';
export const RELEASE_BRANCH = 'main';
export const RELEASE_EVENT = 'push';
/** The `name:` ci.yml's "Upload .vsix" step gives the artifact. */
export const VSIX_ARTIFACT_NAME = 'build-tutorials-vsix';
/** `package.json`'s `name` and `publisher`: what the .vsix's own manifest must say. */
export const EXTENSION_NAME = 'build-tutorials';
export const EXTENSION_PUBLISHER = 'bma-corgea';

/**
 * The steps whose success the release notes describe, matched by the start of their names in
 * ci.yml. Every step must be green anyway; these must also be THERE, because a workflow that
 * lost its install check would still go green, and the notes would then claim a check that never
 * ran. Renaming one of these steps in ci.yml without renaming it here makes every release refuse,
 * and the unit suite goes red first.
 */
const INSTALL_STEP_PREFIX = 'Install the .vsix';
export const REQUIRED_STEPS: readonly { prefix: string; why: string }[] = [
  { prefix: 'Package', why: 'the step that builds the .vsix and reads the finished archive back' },
  { prefix: INSTALL_STEP_PREFIX, why: 'the step that installs that .vsix into an isolated profile and proves it activates' },
  { prefix: 'Upload .vsix', why: 'the step that uploads the artifact a release carries' },
];

/**
 * The project's dated record of what has been proven, word for word as CHANGELOG.md's 0.1.0 entry
 * and the README say it (unit-tested). NOT what the release notes say: see the header.
 */
export const PROVEN_ON_LINUX =
  "Proven on Linux only: VS Code 1.145.2 and VSCodium on the maintainer's machine, and VS Code 1.146.0 on GitHub's runner. macOS and Windows are unproven.";
/** What is not built yet, as CHANGELOG.md says it. */
export const REPOSITORY_ONLY =
  'It builds from an existing repository only. Building from an idea, in your own words, is not available yet.';

export function releaseTag(version: string): string {
  return `v${version}`;
}

export function releaseTitle(version: string): string {
  return `Build Tutorials ${version}`;
}

/** The name `scripts/package.mjs` gives the archive, which is `plan.ts`'s `expectedArtifactName` too. */
export function vsixFileName(version: string): string {
  return `${EXTENSION_NAME}-${version}.vsix`;
}

// ── the reads the shell runs ─────────────────────────────────────────────────────────────

const RUN_FIELDS = 'databaseId,headSha,event,headBranch,status,conclusion,url';
/** One page of the release list. A FULL page is "could not tell": the next one may carry the tag. */
const RELEASES_PAGE = 100;
const RELEASE_FIELDS = 'tagName,isDraft,targetCommitish,assets';
/** The compare, cut down by gh to the four fields read here: its file list grows with the diff. */
const COMPARE_JQ = '{status, ahead_by, behind_by, base_commit: {sha: .base_commit.sha}}';

/**
 * Every command the shell runs against GitHub, as an argv for `gh` with no shell in between.
 * Each one names the repository itself (`--repo`, or a `repos/<owner>/<repo>/` path), so the
 * answer does not depend on which directory the script was started in.
 */
export const ghRead = {
  compare: (sha: string): string[] => ['api', `repos/${RELEASE_REPO}/compare/${sha}...${RELEASE_BRANCH}`, '--jq', COMPARE_JQ],
  runList: (sha: string): string[] => [
    'run', 'list', '--repo', RELEASE_REPO, '--workflow', RELEASE_WORKFLOW_FILE, '--commit', sha, '--limit', '100', '--json', RUN_FIELDS,
  ],
  runView: (runId: number): string[] => ['run', 'view', String(runId), '--repo', RELEASE_REPO, '--json', 'jobs'],
  artifacts: (runId: number): string[] => ['api', `repos/${RELEASE_REPO}/actions/runs/${runId}/artifacts?per_page=100`],
  artifactZip: (artifactId: number): string[] => ['api', `repos/${RELEASE_REPO}/actions/artifacts/${artifactId}/zip`],
  releaseView: (version: string): string[] => ['release', 'view', releaseTag(version), '--repo', RELEASE_REPO, '--json', RELEASE_FIELDS],
  releaseDownload: (version: string, dir: string): string[] => [
    'release', 'download', releaseTag(version), '--repo', RELEASE_REPO, '--pattern', '*.vsix', '--dir', dir,
  ],
  /** Drafts are shown only to a login that can push, so a "no draft" from any other login means nothing. */
  pushPermission: (): string[] => ['api', `repos/${RELEASE_REPO}`, '--jq', '.permissions.push'],
  /** Every release, drafts included for such a login: `gh release view` names just one per tag. */
  releases: (): string[] => ['api', `repos/${RELEASE_REPO}/releases?per_page=${RELEASES_PAGE}`],
  /** The tag itself. GitHub ignores `--target` when it exists, so where it points decides the release. */
  tagRef: (version: string): string[] => ['api', `repos/${RELEASE_REPO}/git/ref/tags/${releaseTag(version)}`],
  /** An annotated tag's own object, which names the commit. */
  tagObject: (tagObjectSha: string): string[] => ['api', `repos/${RELEASE_REPO}/git/tags/${tagObjectSha}`],
  /** The plain-text log of the job that ran the install check, which names the VS Code it ran in. */
  jobLog: (jobId: number): string[] => ['api', `repos/${RELEASE_REPO}/actions/jobs/${jobId}/logs`],
};

/**
 * Whether `gh <args>` only reads. An ALLOWLIST of read shapes, not a list of write flags: `gh api`
 * becomes a POST on a single `-f`, and a cluster such as `-iX POST` is a write no list of flag
 * spellings anticipates. So after an `api` path the only thing allowed is `--jq <filter>`, which
 * is all `ghRead` uses. `release download` writes files, but on this machine, not on GitHub.
 */
export function isReadOnlyGh(args: readonly string[]): boolean {
  const [command, sub, ...rest] = args;
  if (command === 'run') return sub === 'list' || sub === 'view';
  if (command === 'release') return sub === 'view' || sub === 'download';
  if (command === 'api') {
    const ofThisRepository = sub === `repos/${RELEASE_REPO}` || (typeof sub === 'string' && sub.startsWith(`repos/${RELEASE_REPO}/`));
    const onlyAFilter = rest.length === 0 || (rest.length === 2 && rest[0] === '--jq');
    return ofThisRepository && onlyAFilter;
  }
  return false;
}

/**
 * What the shell may run WITHOUT a check: `git` (rev-parse and show, in this checkout) and `unzip`
 * (listing, unpacking and reading what was downloaded). Anything else, `gh` above all, is refused
 * there, so the only door to GitHub stays `gh()`, behind `isReadOnlyGh` (review N1).
 */
export const DIRECT_COMMANDS: readonly string[] = ['git', 'unzip'];

export function isDirectCommand(command: string): boolean {
  return DIRECT_COMMANDS.includes(command);
}

// ── small readers, so a JSON shape that changed is a refusal rather than a crash ─────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A value from a JSON answer, quoted for a sentence. */
function show(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'nothing';
  return JSON.stringify(value);
}

/** What a failed command said, as its first non-empty line, quoted, for a sentence. */
function said(stderr: string): string {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line === undefined ? 'nothing' : `"${line.replace(/[.\s]+$/, '')}"`;
}

const AUTH_REMEDY = 'Check `gh auth status` and run this again: a list that could not be read is not an empty one.';

// ── 1. the commit ────────────────────────────────────────────────────────────────────────

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * The commit to release, as the person typed it. Hex only: a branch or a tag is refused because
 * GitHub's `main` and this checkout's can point at different commits, and a release names one.
 */
export function parseShaArgument(arg: string | undefined): Checked<string> {
  const usage = 'Run `node scripts/release-draft.mjs <sha>` with the commit to release, written as seven to forty hex characters of its sha.';
  if (arg === undefined || arg.length === 0) return refuse('bad-sha-argument', 'No commit was given.', usage);
  if (!/^[0-9a-fA-F]{7,40}$/.test(arg)) {
    return refuse('bad-sha-argument', `\`${arg}\` is not a commit sha.`,
      `${usage} A branch or a tag is refused on purpose, because GitHub's ${RELEASE_BRANCH} and this checkout's can disagree.`);
  }
  return accept(arg.toLowerCase());
}

/** `git rev-parse --verify --quiet <given>^{commit}`: the full sha, which must extend what was given. */
export function checkResolvedSha(given: string, revParse: CommandResult): Checked<string> {
  const full = revParse.stdout.trim();
  if (revParse.status !== 0 || !/^[0-9a-f]{40}$/.test(full)) {
    return refuse('commit-not-found', `This checkout has no commit ${given}.`,
      `Run \`git fetch origin ${RELEASE_BRANCH}\` in this checkout so it has the commit, then run this again.`);
  }
  if (!full.startsWith(given)) {
    return refuse('commit-not-found', `This checkout resolved ${given} to ${full}, which is a different commit.`,
      'Pass the full 40-character sha of the commit to release.');
  }
  return accept(full);
}

/** `git show <sha>:package.json`: the version the commit itself declares, which names the release. */
export function readCommitManifest(show: CommandResult, sha: string): Checked<{ version: string }> {
  if (show.status !== 0) {
    return refuse('commit-manifest-unreadable', `Git could not show package.json at ${sha}: it said ${said(show.stderr)}.`,
      'Release a commit of this repository that has a package.json, and run this again.');
  }
  const manifest = parseJson(show.stdout);
  const version = isRecord(manifest) ? manifest.version : undefined;
  const remedy = 'Release a commit whose package.json gives its version as plain semver, such as 0.1.0.';
  if (typeof version !== 'string') {
    return refuse('commit-manifest-unreadable', `The package.json at ${sha} has no version that can be read.`, remedy);
  }
  if (!VERSION_SHAPE.test(version)) {
    // It becomes a tag, a file name and a word on a printed command line, so it is held to a shape.
    return refuse('commit-manifest-unreadable',
      `The package.json at ${sha} gives its version as "${version}", which cannot name a tag and a file.`, remedy);
  }
  return accept({ version });
}

// ── 2. on GitHub's main ──────────────────────────────────────────────────────────────────

/**
 * `gh api repos/<repo>/compare/<sha>...main`. `identical` and `ahead` (main is ahead of the
 * commit) both mean main contains it; `behind` and `diverged` mean it does not.
 */
export function checkOnMain(compare: CommandResult, sha: string): Checked<{ status: string; aheadBy: number }> {
  const unreadable = (why: string): Refusal => refuse('compare-unreadable',
    `GitHub's comparison of ${sha} with ${RELEASE_BRANCH} could not be read: ${why}.`,
    'If the commit was never pushed it cannot be released; otherwise check `gh auth status` and run this again.');
  if (compare.status !== 0) return unreadable(`gh said ${said(compare.stderr)}`);
  const body = parseJson(compare.stdout);
  if (!isRecord(body)) return unreadable('it printed no JSON');
  const { status, ahead_by: aheadBy, behind_by: behindBy } = body;
  const base = isRecord(body.base_commit) ? body.base_commit.sha : undefined;
  if (typeof status !== 'string' || typeof aheadBy !== 'number' || typeof behindBy !== 'number' || typeof base !== 'string') {
    return unreadable('it did not say how the two commits relate');
  }
  if (base !== sha) return unreadable(`it compared ${base}, not ${sha}`);
  if ((status === 'identical' || status === 'ahead') && behindBy === 0) return accept({ status, aheadBy });
  return refuse('not-on-main',
    `GitHub's ${RELEASE_BRANCH} does not contain ${sha}: comparing the two says "${status}" (${aheadBy} ahead, ${behindBy} behind).`,
    `Release a commit that is on ${RELEASE_BRANCH}. Merging this one is the owner's act, and its own push to ${RELEASE_BRANCH} is what gives it a CI run.`);
}

// ── 3. the run, and every step of it ─────────────────────────────────────────────────────

/** One row of `gh run list --json databaseId,headSha,event,headBranch,status,conclusion,url`. */
export interface CiRun {
  id: number;
  url: string;
  headSha: string;
  event: string;
  headBranch: string;
  status: string;
  /** '' while the run has not finished */
  conclusion: string;
}

function readRun(row: unknown): CiRun | null {
  if (!isRecord(row)) return null;
  const { databaseId, url, headSha, event, headBranch, status } = row;
  const conclusion = row.conclusion === null ? '' : row.conclusion;
  if (typeof databaseId !== 'number' || typeof url !== 'string' || typeof headSha !== 'string' || typeof event !== 'string'
    || typeof headBranch !== 'string' || typeof status !== 'string' || typeof conclusion !== 'string') {
    return null;
  }
  return { id: databaseId, url, headSha, event, headBranch, status, conclusion };
}

const newest = (runs: readonly CiRun[]): CiRun | undefined =>
  runs.reduce<CiRun | undefined>((best, run) => (best === undefined || run.id > best.id ? run : best), undefined);

/**
 * The run that verified this commit: headSha EXACTLY the sha, a push, to main, completed,
 * success. Of several such runs the newest; a red run beside a green one does not unverify what
 * the green one checked, because each run built and checked its own artifact.
 */
export function chooseRun(list: CommandResult, sha: string): Checked<CiRun> {
  const unreadable = (why: string): Refusal => refuse('run-list-unreadable',
    `The list of ${RELEASE_WORKFLOW} runs for ${sha} could not be read: ${why}.`, AUTH_REMEDY);
  if (list.status !== 0) return unreadable(`gh said ${said(list.stderr)}`);
  const rows = parseJson(list.stdout);
  if (!Array.isArray(rows)) return unreadable('it printed no JSON list');
  const runs: CiRun[] = [];
  for (const row of rows) {
    const run = readRun(row);
    if (run === null) return unreadable(`one of its rows is not a run: ${show(row)}`);
    runs.push(run);
  }

  const ofThisCommit = runs.filter((run) => run.headSha === sha);
  const pushesToMain = ofThisCommit.filter((run) => run.event === RELEASE_EVENT && run.headBranch === RELEASE_BRANCH);
  if (pushesToMain.length === 0) {
    const others = ofThisCommit.map((run) => `run ${run.id} (${run.event} on ${run.headBranch})`);
    return refuse('no-run',
      `Commit ${sha} has no ${RELEASE_WORKFLOW} run for a ${RELEASE_EVENT} to ${RELEASE_BRANCH}${others.length > 0 ? `, only ${others.join(', ')}` : ''}, so no .vsix was built and checked for it as a release.`,
      `Release the newest commit of the push that brought it to ${RELEASE_BRANCH}, or any later commit on ${RELEASE_BRANCH} whose run is green: CI runs once per push, on its newest commit, so a commit inside a merged branch has no run of its own. If it was pushed moments ago, wait for its run to appear and run this again.`);
  }

  const green = newest(pushesToMain.filter((run) => run.status === 'completed' && run.conclusion === 'success'));
  if (green !== undefined) return accept(green);

  const latest = newest(pushesToMain) as CiRun; // not undefined: pushesToMain is not empty
  if (latest.status !== 'completed') {
    return refuse('run-not-green', `${RELEASE_WORKFLOW} run ${latest.id} for ${sha} is still ${latest.status}, so nothing it builds has been checked yet.`,
      'Wait for it to finish, then run this again.');
  }
  return refuse('run-not-green',
    `${RELEASE_WORKFLOW} run ${latest.id} for ${sha} concluded "${latest.conclusion || 'nothing'}", not "success", so its artifact was never verified (${latest.url}).`,
    `Release only a commit whose own run is green: fix ${RELEASE_BRANCH}, and release the commit whose run passes.`);
}

/**
 * `gh run view <id> --json jobs`: every step of every job concluded `success`, and the steps the
 * notes rely on are among them. A run whose jobs or steps cannot be read is not a run whose steps
 * passed, so an empty list is a refusal of its own rather than a vacuous pass.
 */
export function checkRunSteps(view: CommandResult, run: CiRun): Checked<{ jobs: number; steps: number; installJobId: number }> {
  const unreadable = (why: string): Refusal => refuse('jobs-unreadable',
    `The jobs of ${RELEASE_WORKFLOW} run ${run.id} could not be read: ${why}.`,
    'Check `gh auth status` and run this again: a run whose steps cannot be read is not a run whose steps passed.');
  if (view.status !== 0) return unreadable(`gh said ${said(view.stderr)}`);
  const body = parseJson(view.stdout);
  const jobs = isRecord(body) ? body.jobs : undefined;
  if (!Array.isArray(jobs)) return unreadable('it printed no list of jobs');
  if (jobs.length === 0) return unreadable('it reports no jobs at all');

  const stepNames: string[] = [];
  let installJobId: number | null = null;
  for (const job of jobs) {
    if (!isRecord(job) || typeof job.name !== 'string' || !Array.isArray(job.steps)) return unreadable(`one of its jobs is not a job: ${show(job)}`);
    if (typeof job.databaseId !== 'number') return unreadable(`its job ${job.name} has no id (${show(job.databaseId)}), so its log cannot be named`);
    if (job.steps.length === 0) return unreadable(`its job ${job.name} reports no steps`);
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.name !== 'string') return unreadable(`a step of its job ${job.name} is not a step: ${show(step)}`);
      const conclusion = typeof step.conclusion === 'string' && step.conclusion.length > 0 ? step.conclusion : null;
      if (conclusion !== 'success') {
        const number = typeof step.number === 'number' ? `${step.number} ` : '';
        const ended = conclusion === null
          ? `with no conclusion yet (its status is ${show(step.status)})`
          : `"${conclusion}"`;
        return refuse('step-not-green',
          `Step ${number}"${step.name}" of job ${job.name} in ${RELEASE_WORKFLOW} run ${run.id} ended ${ended}, not "success".`,
          'Release only a commit whose run passed every step: a step that was skipped or cancelled checked nothing, so the artifact is not a verified one.');
      }
      stepNames.push(step.name);
      if (installJobId === null && step.name.startsWith(INSTALL_STEP_PREFIX)) installJobId = job.databaseId;
    }
    if (job.conclusion !== 'success') {
      return refuse('job-not-green',
        `Job ${job.name} of ${RELEASE_WORKFLOW} run ${run.id} concluded ${show(job.conclusion)}, not "success", though every step it reports passed.`,
        'Release only a commit whose run passed in full, and look at this run on GitHub before trusting any of it.');
    }
  }

  for (const required of REQUIRED_STEPS) {
    if (!stepNames.some((name) => name.startsWith(required.prefix))) {
      return refuse('required-step-missing',
        `${RELEASE_WORKFLOW} run ${run.id} has no step named "${required.prefix}…", ${required.why}.`,
        'Release a commit whose workflow still runs that step: without it the run did not verify what the release notes say it did.');
    }
  }
  if (installJobId === null) {
    return unreadable(`no job of it ran a step named "${INSTALL_STEP_PREFIX}…"`);
  }
  return accept({ jobs: jobs.length, steps: stepNames.length, installJobId });
}

/**
 * `gh api repos/<repo>/actions/jobs/<install job>/logs`: which VS Code this run's install check proved
 * the file on (review S3). The tests' `@vscode/test-electron` logs "Validated version: X" for the build
 * it downloads into `.vscode-test/`, which is the build the install check then runs; the install
 * check itself (`scripts/verify-install.mjs`) ends with "PROVEN   Visual Studio Code". Both must be
 * there, and the validated version must be ONE version: otherwise the notes would be guessing, so
 * this refuses rather than name a version the run did not show.
 */
export function readRunnerVscode(log: CommandResult, run: CiRun, jobId: number): Checked<{ version: string }> {
  if (log.status !== 0) {
    return refuse('job-log-unreadable', `The log of job ${jobId} in ${RELEASE_WORKFLOW} run ${run.id} could not be read: gh said ${said(log.stderr)}.`,
      'Run this again; if the log has expired or been deleted, release a newer green commit, whose log says what its install check proved.');
  }
  // eslint-disable-next-line no-control-regex -- the escape sequences colour codes are made of
  const text = log.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const versions = [...new Set([...text.matchAll(/Validated version:\s*(\d+\.\d+\.\d+)/g)].map((m) => m[1] ?? ''))];
  const remedy = 'Look at the run\'s log on GitHub, and release a commit whose run shows one VS Code version and its install check proving it; if the log\'s wording has changed, change readRunnerVscode with it.';
  if (versions.length !== 1) {
    return refuse('runner-version-unknown',
      versions.length === 0
        ? `The log of job ${jobId} in ${RELEASE_WORKFLOW} run ${run.id} names no "Validated version", so which VS Code its install check ran in is not on record.`
        : `The log of job ${jobId} in ${RELEASE_WORKFLOW} run ${run.id} names ${versions.length} validated VS Code versions (${versions.join(', ')}), so which one its install check ran in would be a guess.`,
      remedy);
  }
  if (!/(?:^|\s)PROVEN\s+Visual Studio Code\b/m.test(text)) {
    return refuse('runner-version-unknown',
      `The log of job ${jobId} in ${RELEASE_WORKFLOW} run ${run.id} has no "PROVEN   Visual Studio Code" from its install check, so it does not show the file proven on VS Code ${versions[0] ?? ''}.`,
      remedy);
  }
  return accept({ version: versions[0] ?? '' });
}

// ── 4. the artifact that run uploaded ────────────────────────────────────────────────────

/** The one `build-tutorials-vsix` artifact of a run, as `gh api …/runs/<id>/artifacts` lists it. */
export interface CiArtifact {
  id: number;
  name: string;
  /** `sha256:<64 hex>`, recorded by GitHub when the run uploaded it */
  digest: string;
  sizeInBytes: number | null;
  expiresAt: string | null;
}

export function chooseArtifact(list: CommandResult, run: CiRun): Checked<CiArtifact> {
  const unreadable = (why: string): Refusal => refuse('artifacts-unreadable',
    `The artifacts of ${RELEASE_WORKFLOW} run ${run.id} could not be read: ${why}.`, AUTH_REMEDY);
  if (list.status !== 0) return unreadable(`gh said ${said(list.stderr)}`);
  const body = parseJson(list.stdout);
  const rows = isRecord(body) ? body.artifacts : undefined;
  if (!Array.isArray(rows)) return unreadable('it printed no list of artifacts');
  // Review N3: one page. A list shorter than its own total is a list with something past the page.
  const total = isRecord(body) ? body.total_count : undefined;
  if (total !== rows.length) return unreadable(`it lists ${rows.length} artifact${rows.length === 1 ? '' : 's'} where its total_count says ${show(total)}`);

  const named: Array<Record<string, unknown> & { id: number }> = [];
  const otherNames: string[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== 'string' || typeof row.id !== 'number') {
      return unreadable(`one of its rows is not an artifact: ${show(row)}`);
    }
    if (row.name === VSIX_ARTIFACT_NAME) named.push({ ...row, id: row.id });
    else otherNames.push(row.name);
  }
  const [row, ...more] = named;
  if (row === undefined) {
    return refuse('no-artifact',
      `${RELEASE_WORKFLOW} run ${run.id} uploaded no artifact named ${VSIX_ARTIFACT_NAME}${otherNames.length > 0 ? `, only ${otherNames.join(', ')}` : ''}.`,
      `Release a commit whose run uploaded one: ci.yml's "Upload .vsix" step names it ${VSIX_ARTIFACT_NAME}.`);
  }
  if (more.length > 0) {
    return refuse('artifact-ambiguous',
      `${RELEASE_WORKFLOW} run ${run.id} has ${named.length} artifacts named ${VSIX_ARTIFACT_NAME}, so which one it verified would be a guess.`,
      'Look at the run on GitHub, and release a commit whose run uploaded exactly one.');
  }

  const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;
  if (typeof row.expired !== 'boolean') return unreadable(`it does not say whether artifact ${row.id} has expired`);
  if (row.expired) {
    return refuse('artifact-expired',
      `The ${VSIX_ARTIFACT_NAME} artifact of run ${run.id} expired${expiresAt === null ? '' : ` at ${expiresAt}`}, so its bytes are gone.`,
      'Release a newer green commit, or have CI build this one again (re-running a workflow is the owner\'s act) and run this against that run.');
  }

  const from = isRecord(row.workflow_run) ? row.workflow_run : null;
  if (from === null || from.id !== run.id || from.head_sha !== run.headSha) {
    const which = from === null ? 'no run at all' : `run ${show(from.id)} of commit ${show(from.head_sha)}`;
    return refuse('artifact-not-from-run',
      `The ${VSIX_ARTIFACT_NAME} artifact listed for run ${run.id} says it came from ${which}, not from run ${run.id} of ${run.headSha}.`,
      'Run this again; if it persists, the artifact is not the one this run made, so do not release it.');
  }

  const digest = row.digest;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return refuse('digest-missing',
      `The ${VSIX_ARTIFACT_NAME} artifact of run ${run.id} carries no sha256 digest (it says ${show(digest)}), so nothing binds the bytes a download returns to the bytes the run uploaded.`,
      'Release a commit whose run uploaded its artifact with actions/upload-artifact v4 or later, which records one.');
  }
  return accept({
    id: row.id, name: VSIX_ARTIFACT_NAME, digest,
    sizeInBytes: typeof row.size_in_bytes === 'number' ? row.size_in_bytes : null, expiresAt,
  });
}

// ── the bytes ────────────────────────────────────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * `gh api …/artifacts/<id>/zip > <file>`: the bytes are the ones the run uploaded only if they
 * hash to the digest GitHub recorded at upload. A download that failed is refused before its
 * partial bytes are hashed, so a truncated file never reaches the comparison.
 */
export function checkArtifactDigest(artifact: CiArtifact, download: CommandResult, zipBytes: Uint8Array): Checked<{ sha256: string }> {
  if (download.status !== 0) {
    return refuse('artifact-download', `Downloading artifact ${artifact.id} (${artifact.name}) failed: gh said ${said(download.stderr)}.`,
      'Run this again; nothing a failed download left on disk is hashed or used.');
  }
  const actual = sha256Hex(zipBytes);
  const recorded = artifact.digest.replace(/^sha256:/, '');
  if (actual !== recorded) {
    return refuse('digest-mismatch',
      `The zip downloaded for artifact ${artifact.id} hashes to sha256:${actual}, but GitHub recorded sha256:${recorded} when the run uploaded it.`,
      'Do not release these bytes. Run this again for a fresh download; if the two still differ, the artifact is not what the run uploaded.');
  }
  return accept({ sha256: actual });
}

/**
 * `unzip -Z1 <zip>`, read BEFORE anything is unpacked: exactly one entry, the .vsix named for the
 * commit's version. Lines are compared as printed, untrimmed, so `../x`, `dir/x` and ` x` are
 * three different names and none of them is the one expected.
 */
export function checkArtifactEntries(listing: CommandResult, version: string): Checked<{ vsixName: string }> {
  const expected = vsixFileName(version);
  if (listing.status !== 0) {
    return refuse('archive-contents', `The artifact's zip could not be listed: unzip said ${said(listing.stderr)}.`,
      'Run this again for a fresh download; nothing has been unpacked from this one.');
  }
  const entries = listing.stdout.split('\n').filter((line) => line.length > 0);
  if (entries.length !== 1 || entries[0] !== expected) {
    return refuse('archive-contents',
      `The artifact's zip should hold exactly ${expected} and nothing beside it, and it holds ${entries.length === 0 ? 'nothing' : entries.map((entry) => JSON.stringify(entry)).join(', ')}.`,
      `Release a commit whose run packaged version ${version}: CI uploads only the one .vsix that \`npm run package\` names for package.json's version.`);
  }
  return accept({ vsixName: expected });
}

/** `unzip -qq <zip> -d <new empty directory>`: it produced exactly the one file the listing promised. */
export function checkExtraction(unzip: CommandResult, files: readonly string[], vsixName: string): Checked<{ vsixName: string }> {
  if (unzip.status !== 0) {
    return refuse('archive-contents', `The artifact's zip could not be unpacked: unzip said ${said(unzip.stderr)}.`,
      'Run this again; nothing from a failed unpack is used.');
  }
  if (files.length !== 1 || files[0] !== vsixName) {
    return refuse('archive-contents',
      `Unpacking the artifact's zip should have produced exactly ${vsixName}, and it produced ${files.length === 0 ? 'nothing' : files.join(', ')}.`,
      'Run this again; if it persists, do not release this artifact.');
  }
  return accept({ vsixName });
}

/**
 * The oldest VS Code an `engines.vscode` range admits, as the notes state it: `^1.95.0` and
 * `>=1.95.0` are "1.95". Anything else is null rather than a guess, because the notes would
 * then promise an editor the .vsix refuses to install into.
 */
export function minimumVscode(engine: unknown): string | null {
  if (typeof engine !== 'string') return null;
  const match = /^(?:\^|>=)\s*(\d+)\.(\d+)(?:\.\d+)?$/.exec(engine.trim());
  const major = match?.[1];
  const minor = match?.[2];
  return major !== undefined && minor !== undefined ? `${major}.${minor}` : null;
}

/**
 * `unzip -p <vsix> extension/package.json`, read as data and never loaded: the .vsix is this
 * extension (name, publisher) at the commit's own version, and it names its minimum VS Code.
 */
export function checkVsixManifest(read: CommandResult, version: string): Checked<{ minimumVscode: string }> {
  if (read.status !== 0) {
    return refuse('vsix-manifest-unreadable', `The .vsix's extension/package.json could not be read: unzip said ${said(read.stderr)}.`,
      'Do not release this artifact: every .vsix this extension packages carries extension/package.json.');
  }
  const manifest = parseJson(read.stdout);
  if (!isRecord(manifest)) {
    return refuse('vsix-manifest-unreadable', 'The .vsix\'s extension/package.json is not JSON.',
      'Do not release this artifact: every .vsix this extension packages carries its manifest as JSON.');
  }
  const fields: Array<[string, unknown, string]> = [
    ['name', manifest.name, EXTENSION_NAME],
    ['publisher', manifest.publisher, EXTENSION_PUBLISHER],
    ['version', manifest.version, version],
  ];
  for (const [field, actual, wanted] of fields) {
    if (actual !== wanted) {
      return refuse('vsix-manifest-mismatch', `The .vsix's extension/package.json has ${field} ${show(actual)}, and it should be "${wanted}".`,
        `Release a commit whose artifact is ${EXTENSION_PUBLISHER}.${EXTENSION_NAME} at that commit's own version, ${version}.`);
    }
  }
  const engine = isRecord(manifest.engines) ? manifest.engines.vscode : undefined;
  const minimum = minimumVscode(engine);
  if (minimum === null) {
    return refuse('vsix-manifest-mismatch',
      `The .vsix's extension/package.json has engines.vscode ${show(engine)}, which names no minimum VS Code the notes can state.`,
      'Release a commit whose package.json gives engines.vscode as a caret or >= range, such as ^1.95.0.');
  }
  return accept({ minimumVscode: minimum });
}

// ── 6. the notes a stranger reads ────────────────────────────────────────────────────────

export interface NotesInput {
  version: string;
  sha: string;
  run: { id: number; url: string };
  vsixName: string;
  vsixSha256: string;
  /** from the .vsix's own `engines.vscode`, so the notes promise what the file enforces */
  minimumVscode: string;
  /** the VS Code this file's own run installed it into, from that run's job log (`readRunnerVscode`) */
  runnerVscode: string;
}

/**
 * The release notes, in Markdown. They say what it is, what it needs, what is proven and what is
 * not, how to install from the file, and exactly which bytes these are and where they came from.
 * No ticket number and no local path: a stranger can read neither. Each paragraph is one line,
 * because GitHub renders a single newline in a release body as a line break.
 */
export function composeReleaseNotes(input: NotesInput): string {
  const { version, sha, run, vsixName, vsixSha256 } = input;
  return [
    'Build Tutorials is a VS Code extension that turns an existing repository into a step-by-step tutorial for rebuilding it: '
      + 'one decision at a time, each with the options the author had, the why behind the one they took, and the commit where it '
      + 'happened. Then you build it yourself, typing as much of it as you choose.',
    '',
    '## What it needs',
    '',
    `- VS Code or VSCodium ${input.minimumVscode} or later.`,
    '- git.',
    "- The `claude` CLI on your PATH and logged in. The build asks it for each step's why, and the tutor and the detour talk to it.",
    '',
    '## What is proven, and what is not',
    '',
    `- Proven on Linux only: the install check in the CI run below installed this file into VS Code ${input.runnerVscode} on GitHub's Ubuntu runner and proved it activates. VSCodium is not on that runner, and macOS and Windows are unproven.`,
    `- ${REPOSITORY_ONLY}`,
    '',
    '## Install it from the file',
    '',
    `1. Download \`${vsixName}\` from this release's assets, below.`,
    '2. Install it from a terminal:',
    '',
    '   ```bash',
    `   code --install-extension ${vsixName}     # VS Code`,
    `   codium --install-extension ${vsixName}   # VSCodium`,
    '   ```',
    '',
    '   or from the Extensions view: *⋯ → Install from VSIX…*, and pick the file.',
    '3. Run **Build Tutorials: Doctor** from the Command Palette. It says in plain sentences whether it found the core, its '
      + 'four grammars and the `claude` CLI.',
    '',
    'Then **Build Tutorials: Start** builds a tutorial from a GitHub URL or a local folder. '
      + `The [README](https://github.com/${RELEASE_REPO}#readme) walks through the rest.`,
    '',
    '## Where this file came from',
    '',
    `\`${vsixName}\` is the artifact CI built and checked for one commit, byte for byte. It was not built on anyone's machine.`,
    '',
    `- sha256: \`${vsixSha256}\`. Check your download with \`sha256sum ${vsixName}\`.`,
    `- CI run: ${run.url}. Every step of it passed, including packaging, which reads the finished archive back, and the `
      + 'install check, which installs this file into an isolated profile and proves it activates.',
    `- Commit: [\`${sha}\`](https://github.com/${RELEASE_REPO}/commit/${sha}), version ${version}.`,
    '',
  ].join('\n');
}

// ── what is already on GitHub ────────────────────────────────────────────────────────────

export interface ExistingRelease {
  tagName: string;
  isDraft: boolean;
  /** what the tag will be created at when the release is published */
  targetCommitish: string;
  assets: { name: string; size: number | null }[];
}

/**
 * `gh release view v<version> --json tagName,isDraft,targetCommitish,assets`. Exit 1 with exactly
 * "release not found" is the only "there is none"; any other failure could not tell.
 */
export function readExistingRelease(view: CommandResult, version: string): Checked<ExistingRelease | null> {
  const tag = releaseTag(version);
  const unknown = (why: string): Refusal => refuse('release-state-unknown',
    `Whether release ${tag} already exists could not be told: ${why}.`,
    'Check `gh auth status` and run this again: a create printed over a release that is there, or an edit of one that is not, would be wrong either way.');
  if (view.status === 1 && view.stderr.trim() === 'release not found') return accept(null);
  if (view.status !== 0) return unknown(`gh said ${said(view.stderr)}`);
  const body = parseJson(view.stdout);
  if (!isRecord(body) || typeof body.tagName !== 'string' || typeof body.isDraft !== 'boolean'
    || typeof body.targetCommitish !== 'string' || !Array.isArray(body.assets)) {
    return unknown('gh printed no release that can be read');
  }
  if (body.tagName !== tag) return unknown(`gh answered with release ${body.tagName}, not ${tag}`);
  const assets: ExistingRelease['assets'] = [];
  for (const asset of body.assets) {
    if (!isRecord(asset) || typeof asset.name !== 'string') return unknown(`one of its assets is not an asset: ${show(asset)}`);
    assets.push({ name: asset.name, size: typeof asset.size === 'number' ? asset.size : null });
  }
  return accept({ tagName: body.tagName, isDraft: body.isDraft, targetCommitish: body.targetCommitish, assets });
}

/**
 * `gh api repos/<repo> --jq .permissions.push`. GitHub lists draft releases only to a login that can
 * push, so from any other login "release not found" would be true of the drafts it was shown and
 * say nothing about the ones it was not. `false` is therefore a refusal, never "none" (review S2).
 */
export function checkDraftsVisible(read: CommandResult): Checked<null> {
  const unknown = (why: string): Refusal => refuse('release-state-unknown',
    `Whether this gh login can see draft releases could not be told: ${why}.`,
    'Check `gh auth status` and run this again.');
  if (read.status !== 0) return unknown(`gh said ${said(read.stderr)}`);
  const answer = read.stdout.trim();
  if (answer === 'true') return accept(null);
  if (answer === 'false') {
    return refuse('drafts-invisible',
      `This gh login cannot push to ${RELEASE_REPO}, and GitHub shows draft releases only to logins that can, so "no draft" from it would not mean there is none.`,
      'Log gh in as an account that can push to the repository (`gh auth status` says which one this is), then run this again.');
  }
  return unknown(`GitHub answered ${show(answer)} where it says true or false`);
}

/**
 * `gh api repos/<repo>/releases?per_page=100`: at most ONE release may carry the tag. A draft makes
 * no tag, so GitHub lets several drafts share one tag name, and `gh release view`, `upload`, `edit`
 * and `download` each act on just one of them: which draft was verified would be a guess (review S2).
 * The list must also agree with what `gh release view` found, or which release is meant cannot be
 * told either. A full page could hide the tag on the next one, so it is "could not tell".
 */
export function checkReleaseList(list: CommandResult, version: string, existing: ExistingRelease | null): Checked<{ withTag: number }> {
  const tag = releaseTag(version);
  const unknown = (why: string): Refusal => refuse('release-state-unknown',
    `Which releases carry the tag ${tag} could not be told: ${why}.`,
    'Check `gh auth status` and the Releases page, then run this again.');
  if (list.status !== 0) return unknown(`gh said ${said(list.stderr)}`);
  const rows = parseJson(list.stdout);
  if (!Array.isArray(rows)) return unknown('it printed no JSON list');
  if (rows.length >= RELEASES_PAGE) {
    return unknown(`the list filled a whole page of ${RELEASES_PAGE} releases, so one with that tag could be on the next page`);
  }
  const withTag: Array<{ id: number; draft: boolean }> = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'number' || typeof row.tag_name !== 'string' || typeof row.draft !== 'boolean') {
      return unknown(`one of its rows is not a release: ${show(row)}`);
    }
    if (row.tag_name === tag) withTag.push({ id: row.id, draft: row.draft });
  }
  if (withTag.length > 1) {
    return refuse('release-ambiguous',
      `${withTag.length} releases carry the tag ${tag} (${withTag.map((r) => `release ${r.id}${r.draft ? ', a draft' : ''}`).join('; ')}), and gh release view, upload, edit and download each act on just one of them, so which one was checked would be a guess.`,
      'Delete all but one of them on GitHub (the owner\'s act), then run this again.');
  }
  const listed = withTag[0];
  const viewed = existing === null ? 'found none' : `found ${existing.isDraft ? 'a draft' : 'a published release'}`;
  const inList = listed === undefined ? 'has none' : `has ${listed.draft ? 'a draft' : 'a published release'}`;
  if ((listed === undefined) !== (existing === null) || (listed !== undefined && existing !== null && listed.draft !== existing.isDraft)) {
    return unknown(`gh release view ${viewed}, but the list of releases ${inList}`);
  }
  return accept({ withTag: withTag.length });
}

// ── the tag (review S1) ──────────────────────────────────────────────────────────────────

/** What `git/ref/tags/v<version>` names: no tag, a commit (lightweight), or a tag object (annotated). */
export type TagRef = { kind: 'none' } | { kind: 'commit'; sha: string } | { kind: 'tag'; sha: string };

const SHA_SHAPE = /^[0-9a-f]{40}$/;
const tagUnknown = (tag: string, why: string): Refusal => refuse('tag-state-unknown',
  `Whether the tag ${tag} already exists on GitHub, and where, could not be told: ${why}.`,
  'Check `gh auth status` and run this again: GitHub ignores --target when the tag exists, so a tag nobody looked at would decide where the release lands.');

/**
 * `gh api repos/<repo>/git/ref/tags/v<version>`. Exit 1 with exactly gh's `gh: Not Found (HTTP 404)`
 * is the only "there is no tag"; any other failure, or an answer that is not this tag's ref, could
 * not tell. A tag pushed by hand or by an earlier attempt is the case this exists for: GitHub ignores
 * `target_commitish` when the tag exists, so the release would be published at the TAG's commit.
 */
export function readTagRef(read: CommandResult, version: string): Checked<TagRef> {
  const tag = releaseTag(version);
  if (read.status === 1 && read.stderr.trim() === 'gh: Not Found (HTTP 404)') return accept({ kind: 'none' });
  if (read.status !== 0) return tagUnknown(tag, `gh said ${said(read.stderr)}`);
  const body = parseJson(read.stdout);
  const object = isRecord(body) && isRecord(body.object) ? body.object : null;
  if (!isRecord(body) || body.ref !== `refs/tags/${tag}` || object === null) {
    return tagUnknown(tag, `GitHub's answer is not the ref refs/tags/${tag} (its ref is ${show(isRecord(body) ? body.ref : undefined)})`);
  }
  if (typeof object.sha !== 'string' || !SHA_SHAPE.test(object.sha)) return tagUnknown(tag, `the ref names no object sha (${show(object.sha)})`);
  if (object.type === 'commit') return accept({ kind: 'commit', sha: object.sha });
  if (object.type === 'tag') return accept({ kind: 'tag', sha: object.sha });
  return tagUnknown(tag, `the ref points at a ${show(object.type)}, not a commit or a tag object`);
}

/** `gh api repos/<repo>/git/tags/<sha>`: an annotated tag's object, read once more for its commit. */
export function peelTagObject(read: CommandResult, version: string, tagObjectSha: string): Checked<string> {
  const tag = releaseTag(version);
  if (read.status !== 0) return tagUnknown(tag, `its tag object ${tagObjectSha} could not be read: gh said ${said(read.stderr)}`);
  const body = parseJson(read.stdout);
  const object = isRecord(body) && isRecord(body.object) ? body.object : null;
  if (!isRecord(body) || body.sha !== tagObjectSha || object === null || typeof object.sha !== 'string' || !SHA_SHAPE.test(object.sha)) {
    return tagUnknown(tag, `GitHub's answer for its tag object ${tagObjectSha} is not that object`);
  }
  if (object.type !== 'commit') {
    return tagUnknown(tag, `its tag object ${tagObjectSha} names a ${show(object.type)}, not a commit, and this reads one level only`);
  }
  return accept(object.sha);
}

/** A tag that already exists must be at the commit being released; no tag at all is fine. */
export function checkTagTarget(tagCommit: string | null, version: string, sha: string): Checked<'none' | 'at-commit'> {
  const tag = releaseTag(version);
  if (tagCommit === null) return accept('none');
  if (tagCommit === sha) return accept('at-commit');
  return refuse('tag-elsewhere',
    `The tag ${tag} already exists on GitHub at ${tagCommit}, not ${sha}. GitHub ignores --target when the tag exists, so publishing this release would attach it, and its source archives, to ${tagCommit}.`,
    'Move or delete that tag on GitHub (the owner\'s act), or release under a new version, then run this again.');
}

// ── the command, printed and never run ───────────────────────────────────────────────────

/** A command for the owner to read and run: the argv, and the same thing quoted for a shell. */
export interface PrintedCommand {
  argv: string[];
  line: string;
}

export interface ReleaseCommandsInput {
  version: string;
  /** the full sha: gh hands `--target` to GitHub, which takes a branch name or a FULL sha */
  sha: string;
  notesPath: string;
  vsixPath: string;
  existing: ExistingRelease | null;
}

/**
 * The commands that would put the CI artifact on a DRAFT release, for the owner to run. With no
 * release of that tag, one `gh release create --draft --target <sha>`. Over a draft that is already
 * there, `gh release upload --clobber` (the asset) and `gh release edit --draft --target <sha>`
 * (the rest), so the draft ends where a create would have left it. A published release is refused.
 *
 * `line` is quoted by `commandLine` because this checkout's own path has a space in it, and a
 * printed command that splits a path in two is a different command (T-8 review, finding 8).
 */
export function releaseCommands(input: ReleaseCommandsInput): Checked<{ mode: 'create' | 'update'; commands: PrintedCommand[] }> {
  const { version, sha, notesPath, vsixPath, existing } = input;
  const tag = releaseTag(version);
  const title = releaseTitle(version);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return refuse('unsafe-argument', `The release would target ${sha}, which is not a full 40-character sha.`,
      'Pass the full sha: GitHub takes --target as a branch name or a full commit sha, and a draft must name one exact commit.');
  }
  for (const [what, file] of [['notes file', notesPath], ['.vsix', vsixPath]] as const) {
    if (!file.startsWith('/')) {
      return refuse('unsafe-argument', `The ${what} path ${file} is not absolute.`,
        'Pass absolute paths, so the printed command means the same file from whichever directory it is run in.');
    }
  }
  if (vsixPath.includes('#')) {
    return refuse('unsafe-argument', `The .vsix path ${vsixPath} contains "#", which gh reads as the start of an asset's display label.`,
      'Move this checkout, or its scratch folder, to a path without "#" and run this again.');
  }
  if (existing !== null && !existing.isDraft) {
    return refuse('release-published', `Release ${tag} already exists and is published, not a draft.`,
      `This script only prepares drafts, so it prints nothing for ${tag}: bump the version in package.json for a new release, or change ${tag} by hand on GitHub if that is really what is meant.`);
  }
  // Review N4: `upload --clobber` replaces only an asset of the SAME name, so any other asset on the
  // draft would still be there beside the CI .vsix afterwards, and "these replace its .vsix" would be false.
  const others = (existing?.assets ?? []).map((asset) => asset.name).filter((name) => name !== vsixFileName(version));
  if (others.length > 0) {
    return refuse('draft-asset',
      `Draft ${tag} carries ${others.join(', ')}, and uploading the CI .vsix would add it beside ${others.length === 1 ? 'that asset' : 'those assets'} rather than replace ${others.length === 1 ? 'it' : 'them'}.`,
      `Remove ${others.length === 1 ? 'that asset' : 'those assets'} from the draft on GitHub (the owner's act), then run this again.`);
  }
  const argvs: string[][] = existing === null
    ? [['gh', 'release', 'create', tag, '--repo', RELEASE_REPO, '--draft', '--target', sha, '--title', title, '--notes-file', notesPath, vsixPath]]
    : [
        ['gh', 'release', 'upload', tag, vsixPath, '--clobber', '--repo', RELEASE_REPO],
        ['gh', 'release', 'edit', tag, '--repo', RELEASE_REPO, '--draft', '--target', sha, '--title', title, '--notes-file', notesPath],
      ];
  return accept({ mode: existing === null ? 'create' : 'update', commands: argvs.map((argv) => ({ argv, line: commandLine(argv) })) });
}

// ── --verify-draft ───────────────────────────────────────────────────────────────────────

/** The release to verify exists and targets the commit CI verified, or publishing it would tag another. */
export function checkDraftRelease(existing: ExistingRelease | null, version: string, sha: string): Checked<ExistingRelease> {
  const tag = releaseTag(version);
  if (existing === null) {
    return refuse('no-draft', `There is no release ${tag} to verify.`,
      'Run this without --verify-draft first, and run the command it prints to create the draft.');
  }
  if (existing.targetCommitish !== sha) {
    return refuse('draft-target',
      `Release ${tag} targets "${existing.targetCommitish}", not commit ${sha}, so publishing it would tag something other than the commit CI verified.`,
      'Point it at that commit with the `gh release edit` command this script prints without --verify-draft, then verify again.');
  }
  // Review N4: the download below takes only `*.vsix`, so the draft's asset list is checked as a whole:
  // a `.vsix.zip` or a `.VSIX` beside the right file would otherwise ship unexamined beside a MATCH.
  const expected = vsixFileName(version);
  const names = existing.assets.map((asset) => asset.name);
  if (names.length !== 1 || names[0] !== expected) {
    return refuse('draft-asset',
      `Release ${tag} should carry exactly one asset, ${expected}, and it carries ${names.length === 0 ? 'none' : names.join(', ')}.`,
      `Make ${expected} its only asset (removing one on GitHub is the owner's act; uploading it is the command this script prints without --verify-draft), then verify again.`);
  }
  return accept(existing);
}

export interface DraftAssetInput {
  version: string;
  /** what `gh release download v<version> --pattern '*.vsix' --dir <new empty directory>` printed */
  download: CommandResult;
  /** every file that download left in its directory, hashed */
  files: readonly { name: string; sha256: string }[];
  /** the sha256 of the .vsix inside the CI artifact */
  expectedSha256: string;
}

/** The draft's own .vsix, as downloaded, is byte for byte the one CI built and checked. */
export function checkDraftAsset(input: DraftAssetInput): Checked<{ sha256: string }> {
  const { version, download, files, expectedSha256 } = input;
  const tag = releaseTag(version);
  const expected = vsixFileName(version);
  if (download.status !== 0) {
    return refuse('draft-asset', `Downloading the .vsix of release ${tag} failed: gh said ${said(download.stderr)}.`,
      `Upload ${expected} to the draft with the command this script prints without --verify-draft, then verify again.`);
  }
  const only = files[0];
  if (files.length !== 1 || only === undefined || only.name !== expected) {
    return refuse('draft-asset',
      `Release ${tag} should carry exactly one .vsix, ${expected}, and it carries ${files.length === 0 ? 'none' : files.map((f) => f.name).join(', ')}.`,
      `Make ${expected} its only .vsix (removing an asset on GitHub is the owner's act), then verify again.`);
  }
  if (only.sha256 !== expectedSha256) {
    return refuse('draft-mismatch',
      `The ${expected} on release ${tag} hashes to sha256:${only.sha256}, and the CI artifact's .vsix hashes to sha256:${expectedSha256}.`,
      'Replace it with the CI artifact using the `gh release upload … --clobber` command this script prints without --verify-draft, then verify again.');
  }
  return accept({ sha256: only.sha256 });
}
