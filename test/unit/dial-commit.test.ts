// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/dial/commit.ts`, exercised against real temporary directories and the REAL `git`
 * binary — never a faked `GitRunner`. The whole point of that module is the exact shape of
 * the commands it runs and how honestly it reads git's own answers back; a fake that always
 * "succeeds" would prove only that the module calls its own mock correctly, not that a
 * learner's repository ends up holding the commit spec §5.4/AC7 promises.
 *
 * **Local git identity ONLY.** `setLocalIdentity`/`clearLocalIdentity` below both write
 * `user.name`/`user.email` into the temp repo's OWN `.git/config` — never the machine's
 * global one, which this suite never reads, writes, or relies on. Git resolves those two keys
 * system → global → local, most specific wins, so an explicit LOCAL value — even an explicit
 * empty one — always beats whatever the global config says. That is what makes both halves of
 * the identity story below deterministic on any machine, including a developer's own, which
 * may well have a perfectly ordinary global identity already configured: `clearLocalIdentity`
 * shadows it locally without ever touching it, which is exactly what "no identity configured
 * in this folder" has to mean, since the same global identity can still commit fine anywhere
 * else on that machine.
 *
 * Three things this suite exists to prove above everything else, because they are the ways
 * this module could quietly do the wrong thing to a learner's own repository:
 *   - **A configured identity commits; an absent one refuses, with a reason, and leaves no
 *     commit behind.** `commit.ts`'s own header explains why a missing identity is a refusal
 *     rather than an invented default — this is that promise, checked against real git.
 *   - **Only the files `commitStep` is handed are ever COMMITTED.** Not a real but untouched
 *     file sitting in the same folder, and — the case that actually costs the learner
 *     something — not a file THEY have already staged, because `git add <paths>` does not
 *     scope a commit and a bare `git commit` takes the whole index. So the assertions below
 *     ask git what the commit CONTAINS (`diff-tree`/`show` against the object git wrote) and
 *     what is left staged afterwards. Asserting the argv handed to a fake would prove the
 *     staging and never the commit: a fake that records arguments can only ever tell you what
 *     was asked for, not what happened.
 *   - **A folder is git-inited only when it needs to be, and every git failure comes back as
 *     a `CommitResult`.** A target inside a repository the learner already keeps must not get
 *     a nested one, and a `git init` that cannot run must not reject out of `commitStep` —
 *     the caller reports rejections outside its once-per-session guard.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_TIMEOUT_MS, GitTimeoutError, realGit, type GitRunner } from '../../src/start/build.js';
import {
  commitStep,
  commitSubject,
  ensureRepo,
  ensureTranscriptIgnored,
  identityConfigured,
  TUTORIAL_DIR_IGNORE,
  TUTORIAL_IGNORE_HEADER,
} from '../../src/dial/commit.js';
import type { StepLike } from '../../src/walk/model.js';

const madeDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-dial-commit-'));
  madeDirs.push(dir);
  return dir;
}

suiteTeardown(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal but fully real `StepLike` — `commit.ts` reads only `ordinal` and `decision`, but
 * the whole shape is filled in so this never drifts from the real type. `overrides.decision`,
 * when given, replaces the decision wholesale (every test that needs a different one passes a
 * complete replacement, never a partial one that would leave the two out of sync).
 */
function fixtureStep(overrides: Partial<StepLike> = {}): StepLike {
  return {
    id: 'st-2-file-parse',
    ordinal: 2,
    chapter: 'src',
    kind: 'file',
    decision: {
      question: 'Why does the tokenizer get its own module?',
      options: [
        { id: 'author', label: 'Split the tokenizer out of the router', consequence: 'One file, no HTTP dependency.', taken: true },
        { id: 'inline-in-routes', label: 'Tokenize inside the router', consequence: 'One less file, but harder to test alone.', taken: false },
      ],
      authorChoice: 'author',
      chosen: 'author',
      why: 'The parser is split out so the API layer can depend on it without dragging HTTP along.',
      whySource: 'docstring',
    },
    target: { file: 'src/parse.ts' },
    scaffold: { loadBearing: [], boilerplate: [] },
    dependsOn: [],
    witness: { sha: null, date: null, subject: null },
    ...overrides,
  };
}

/** Every path under `target` except `.git/`, with its bytes — what "nothing of YOURS was
 *  edited" is a claim about. `.git/` is excluded on purpose: this module writes there, and the
 *  file's header spends a paragraph on why that is not the learner's content. */
function snapshotOutsideGit(target: string, rel = '', out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(path.join(target, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) snapshotOutsideGit(target, next, out);
    else out[next] = fs.readFileSync(path.join(target, next), 'utf8');
  }
  return out;
}

function writeFile(target: string, rel: string, contents = 'export const x = 1;\n'): void {
  const abs = path.join(target, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

/** Writes `user.name`/`user.email` into `target`'s OWN `.git/config` — see this file's header. */
async function setLocalIdentity(target: string, name: string, email: string): Promise<void> {
  await realGit(['config', 'user.name', name], target);
  await realGit(['config', 'user.email', email], target);
}

/** Explicit, empty, LOCAL values — see this file's header for why that is what "no identity"
 *  has to mean, rather than relying on there happening to be no global identity either. */
async function clearLocalIdentity(target: string): Promise<void> {
  await realGit(['config', 'user.name', ''], target);
  await realGit(['config', 'user.email', ''], target);
}

/** The ordinary starting point for a commit test: a temp folder that is already a repository
 *  and has a LOCAL identity, so the commit itself is the only thing under test. */
async function committableTarget(): Promise<string> {
  const target = tmpDir();
  await ensureRepo(target, realGit);
  await setLocalIdentity(target, 'Test Learner', 'learner@example.test');
  return target;
}

/**
 * The paths a commit actually CONTAINS, read back off the object git wrote rather than off
 * the argv this module handed it. `--root` is not optional here: without it `diff-tree`
 * prints nothing at all for a repository's FIRST commit, which is precisely the commit this
 * module usually makes, having just `git init`ed the folder itself.
 */
async function committedPaths(target: string, rev = 'HEAD'): Promise<string[]> {
  const out = await realGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', rev], target);
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** What is left STAGED afterwards — the learner's own work, which a step's commit must leave
 *  exactly where they put it. Answers on an unborn branch too, where there is no HEAD yet. */
async function stagedPaths(target: string): Promise<string[]> {
  const out = await realGit(['diff', '--cached', '--name-only'], target);
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Wraps the REAL `realGit` so a test can additionally assert which commands were actually
 * run, without ever substituting a fake in git's place. `ensureRepo`'s "it does not re-init an
 * existing repo" claim is precisely a claim about which git commands get invoked — only
 * counting real invocations honestly, rather than asking a stub whether it was called, can
 * prove it.
 */
function countingGit(): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push(args);
    return realGit(args, cwd);
  };
  return { git, calls };
}

/**
 * The real `git` for everything except one subcommand, which fails outright — the only way to
 * prove `commitStep` turns a git failure into a `CommitResult` rather than an unhandled
 * rejection without waiting for a real, hard-to-reproduce git failure at exactly that step.
 */
function failingOn(subcommand: string, message: string): GitRunner {
  return async (args, cwd) => {
    if (args[0] === subcommand) throw new Error(message);
    return realGit(args, cwd);
  };
}

/**
 * The real `git` for everything except one subcommand, which is STOPPED at its bound (T-13).
 *
 * The rejection is built rather than provoked, and that is the honest trade: provoking a real
 * one means a subprocess that really hangs and a suite that really waits thirty seconds. What
 * a real one looks like coming out of the runner is pinned in `test/unit/build.test.ts`
 * against a real hanging `git` — so what is faked here is only the WAIT.
 */
function timingOutOn(subcommand: string): GitRunner {
  return async (args, cwd) => {
    if (args[0] === subcommand) throw new GitTimeoutError(args, GIT_TIMEOUT_MS.short);
    return realGit(args, cwd);
  };
}

suite('commitSubject — the one string the panel, the commit, and this suite all read', () => {
  test('ordinal, question and the taken option\'s label, joined by an em dash (AC7)', () => {
    const step = fixtureStep();
    assert.equal(
      commitSubject(step),
      '2: Why does the tokenizer get its own module? — Split the tokenizer out of the router',
    );
  });

  test('falls back honestly, never guessing a label, when no option is marked taken', () => {
    const base = fixtureStep();
    const step: StepLike = {
      ...base,
      decision: { ...base.decision, options: base.decision.options.map((o) => ({ ...o, taken: false })) },
    };
    assert.equal(
      commitSubject(step),
      '2: Why does the tokenizer get its own module? — (no option marked taken)',
    );
  });
});

suite('ensureRepo — git-inits a folder that is not in a work tree, and only then', () => {
  test('a folder with no .git becomes a repository', async () => {
    const target = tmpDir();
    assert.equal(fs.existsSync(path.join(target, '.git')), false);

    await ensureRepo(target, realGit);

    assert.equal(fs.existsSync(path.join(target, '.git')), true);
  });

  test('a folder that is already a repository is asked, never re-inited', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);

    const { git, calls } = countingGit();
    await ensureRepo(target, git);

    assert.deepEqual(
      calls,
      // The work-tree question, then the one `ensureTranscriptIgnored` asks — and NO init.
      // The second `rev-parse` is what locates `info/exclude`; it is a read, and it is asked
      // on this path deliberately, because a learner working inside a repository of their own
      // is exactly the person whose `git add -A` would otherwise commit their conversation.
      [['rev-parse', '--is-inside-work-tree'], ['rev-parse', '--git-dir']],
      'git init must not be attempted a second time',
    );
  });

  test('a target INSIDE an existing repository gets no nested repository of its own', async () => {
    const outer = tmpDir();
    await ensureRepo(outer, realGit);
    const target = path.join(outer, 'learner', 'tutorial');
    fs.mkdirSync(target, { recursive: true });
    assert.equal(fs.existsSync(path.join(target, '.git')), false, 'nothing here yet, and there must not be');

    await ensureRepo(target, realGit);

    assert.equal(
      fs.existsSync(path.join(target, '.git')),
      false,
      'a repository nested here would hide every step commit from the learner\'s own git log',
    );
  });

  test('a linked worktree — where .git is a FILE, not a directory — is left exactly as it is', async () => {
    const source = await committableTarget();
    writeFile(source, 'seed.ts');
    await realGit(['add', '--', 'seed.ts'], source);
    await realGit(['commit', '-q', '-m', 'seed'], source);
    const target = path.join(tmpDir(), 'linked');
    await realGit(['worktree', 'add', '-q', target, '-b', 'linked'], source);
    assert.equal(fs.statSync(path.join(target, '.git')).isFile(), true, 'a gitfile pointing at the real gitdir');

    const { git, calls } = countingGit();
    await ensureRepo(target, git);

    assert.deepEqual(
      calls.filter((args) => args[0] === 'init'),
      [],
      'this IS a work tree — whatever question gets asked, the answer must not be an init',
    );
    assert.equal(fs.statSync(path.join(target, '.git')).isFile(), true, 'and its gitdir pointer is untouched');
  });
});

suite('identityConfigured — both halves, resolved the way a real commit would resolve them', () => {
  test('true once both user.name and user.email are set locally', async () => {
    const target = await committableTarget();

    assert.equal(await identityConfigured(target, realGit), true);
  });

  test('false with neither set locally — shadowing whatever this machine sets globally', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await clearLocalIdentity(target);

    assert.equal(await identityConfigured(target, realGit), false);
  });

  test('false with only the name set — half an identity is not an identity', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await clearLocalIdentity(target);
    await realGit(['config', 'user.name', 'Only A Name'], target);

    assert.equal(await identityConfigured(target, realGit), false);
  });
});

suite('commitStep — the learner\'s commit, or an honest reason there is not one', () => {
  test('a target with identity configured gets the commit', async () => {
    const target = await committableTarget();
    const step = fixtureStep();
    writeFile(target, step.target.file);

    const result = await commitStep(target, step, [step.target.file], realGit);

    assert.deepEqual(result, { committed: true });
    const subject = await realGit(['log', '-1', '--format=%s'], target);
    assert.equal(subject.trim(), commitSubject(step));
  });

  test('a target with NO identity gets no commit, and the reason names it', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await clearLocalIdentity(target);
    const step = fixtureStep();
    writeFile(target, step.target.file);

    const result = await commitStep(target, step, [step.target.file], realGit);

    assert.deepEqual(result, {
      committed: false, reason: 'no git identity configured in this folder', refusal: 'no-identity',
    }, 'the reason is the sentence to show; the refusal is the value callers branch on (T-13 finding 3)');
    await assert.rejects(realGit(['rev-parse', 'HEAD'], target), 'the repository genuinely has no commit yet');
  });

  test('an untracked sibling the learner never staged stays out of the commit', async () => {
    const target = await committableTarget();
    const step = fixtureStep();
    writeFile(target, step.target.file);
    writeFile(target, 'src/untouched.ts');

    const result = await commitStep(target, step, [step.target.file], realGit);

    assert.equal(result.committed, true);
    const committedFiles = (await realGit(['show', '--name-only', '--format=', 'HEAD'], target)).trim().split('\n');
    assert.deepEqual(committedFiles, [step.target.file]);
    const status = await realGit(['status', '--porcelain'], target);
    assert.match(status, /\?\? src\/untouched\.ts/, 'the second file is untracked, never committed');
  });

  test('a file the learner STAGED themselves stays out of the commit, and stays staged', async () => {
    // The repository this extension `git init`ed for them, with no commit in it yet, and a
    // learner who has pressed VS Code's *Stage All Changes* — one click in the SCM view —
    // over a folder holding their own `.env` and scratch notes as well as the step's file.
    // A bare `git commit` here writes all three into a commit titled for the step.
    const target = await committableTarget();
    const step = fixtureStep();
    writeFile(target, step.target.file);
    writeFile(target, '.env', 'OPENAI_API_KEY=sk-not-a-real-key\n');
    writeFile(target, 'notes.md', '# what I still do not get\n');
    await realGit(['add', '-A'], target);

    const result = await commitStep(target, step, [step.target.file], realGit);

    assert.deepEqual(result, { committed: true });
    assert.deepEqual(
      await committedPaths(target),
      [step.target.file],
      'the commit holds the step\'s file and nothing else',
    );
    assert.equal((await realGit(['log', '-1', '--format=%s'], target)).trim(), commitSubject(step));
    assert.deepEqual(
      await stagedPaths(target),
      ['.env', 'notes.md'],
      'their own staged work survives the step\'s commit, still staged, still theirs to commit',
    );
  });

  test('the same holds on a repository that already has a history of its own', async () => {
    const target = await committableTarget();
    writeFile(target, 'README.md', '# my tutorial\n');
    await realGit(['add', '--', 'README.md'], target);
    await realGit(['commit', '-q', '-m', 'my own first commit'], target);
    const step = fixtureStep();
    writeFile(target, step.target.file);
    writeFile(target, '.env', 'TOKEN=hunter2\n');
    await realGit(['add', '-A'], target);

    const result = await commitStep(target, step, [step.target.file], realGit);

    assert.deepEqual(result, { committed: true });
    const stat = await realGit(['show', '--stat', '--format=', 'HEAD'], target);
    assert.match(stat, /src\/parse\.ts \|/, 'the step\'s file is in the commit');
    assert.doesNotMatch(stat, /\.env/, 'and the learner\'s key is not');
    assert.match(stat, /1 file changed/, 'one file, not three');
    assert.deepEqual(await stagedPaths(target), ['.env']);
  });

  test('a file stranded by a FAILED commit does not ride into the NEXT step\'s commit', async () => {
    // The self-inflicted half of the same bug: `add` succeeds, `commit` does not (a stale
    // index.lock, someone's pre-commit hook), and the step's file is left in the index. With
    // no pathspec, the next step sweeps it up under the next step's subject.
    const target = await committableTarget();
    const stranded = fixtureStep();
    writeFile(target, stranded.target.file);

    const failed = await commitStep(
      target,
      stranded,
      [stranded.target.file],
      failingOn('commit', 'git commit failed: Unable to create .git/index.lock: File exists.'),
    );

    assert.equal(failed.committed, false);
    assert.deepEqual(await stagedPaths(target), [stranded.target.file], 'the add did succeed, so it is staged');

    const next = fixtureStep({ id: 'st-3-file-route', ordinal: 3, target: { file: 'src/route.ts' } });
    writeFile(target, next.target.file);

    const result = await commitStep(target, next, [next.target.file], realGit);

    assert.deepEqual(result, { committed: true });
    assert.deepEqual(
      await committedPaths(target),
      [next.target.file],
      'step 3\'s commit holds step 3\'s file — the stranded one is not in it under step 3\'s subject',
    );
    assert.deepEqual(await stagedPaths(target), [stranded.target.file], 'still staged, still uncommitted');
  });

  test('a target inside an existing repository commits into THAT repository', async () => {
    const outer = await committableTarget();
    const target = path.join(outer, 'learner', 'tutorial');
    fs.mkdirSync(target, { recursive: true });
    const step = fixtureStep();
    writeFile(target, step.target.file);

    const result = await commitStep(target, step, [step.target.file], realGit);

    assert.deepEqual(result, { committed: true });
    assert.equal(fs.existsSync(path.join(target, '.git')), false, 'no repository of its own was created');
    assert.equal(
      (await realGit(['log', '-1', '--format=%s'], outer)).trim(),
      commitSubject(step),
      'the learner\'s own git log, where they already run it, shows the step',
    );
    assert.deepEqual(await committedPaths(outer), ['learner/tutorial/src/parse.ts']);
  });

  test('an escaping path is refused rather than staged', async () => {
    const target = await committableTarget();
    const step = fixtureStep();

    const result = await commitStep(target, step, ['../../../etc/passwd'], realGit);

    assert.deepEqual(result, { committed: false, reason: 'no files to stage', refusal: 'nothing-to-stage' });
    await assert.rejects(realGit(['rev-parse', 'HEAD'], target), 'nothing was ever committed');
  });

  test('an empty file list is refused the same way — nothing to stage is not a throw', async () => {
    const target = await committableTarget();

    const result = await commitStep(target, fixtureStep(), [], realGit);

    assert.deepEqual(result, { committed: false, reason: 'no files to stage', refusal: 'nothing-to-stage' });
  });

  test('a git failure at the commit step becomes a CommitResult, never a rejection', async () => {
    const target = await committableTarget();
    const step = fixtureStep();
    writeFile(target, step.target.file);

    const result = await commitStep(target, step, [step.target.file], failingOn('commit', 'git commit failed: simulated failure'));

    assert.equal(result.committed, false);
    assert.match(result.reason ?? '', /simulated failure/);
  });

  test('a git failure at the INIT step becomes one too — the throttle only sees values', async () => {
    // No `git` on the learner's PATH is the ordinary cause, and `init` is then the first call
    // to fail. A rejection out of `commitStep` reaches the caller's error reporting OUTSIDE
    // its once-per-session guard: one raw `spawn git ENOENT` toast per step, on a plan sixty
    // steps long. So this has to come back as a value, exactly like a failing `commit` does.
    const target = tmpDir();
    const step = fixtureStep();
    writeFile(target, step.target.file);

    const result = await commitStep(target, step, [step.target.file], failingOn('init', 'git init -q failed: spawn git ENOENT'));

    assert.equal(result.committed, false);
    assert.match(result.reason ?? '', /spawn git ENOENT/);
    assert.equal(fs.existsSync(path.join(target, '.git')), false, 'and nothing was half-created');
  });

  test('commitStep git-inits an ungoverned folder itself, not only through a prior ensureRepo call', async () => {
    const target = tmpDir();
    assert.equal(fs.existsSync(path.join(target, '.git')), false, 'genuinely bare — no setup call at all this time');
    const step = fixtureStep();
    writeFile(target, step.target.file);

    // Deliberately no local identity is configured either way: whether this ends up
    // `committed: true` or `false` depends on whatever this MACHINE'S global git identity
    // happens to be, which is exactly the ambient state the rest of this suite is careful
    // never to depend on (see the header). The one fact that is true regardless of that
    // ambient state, and the one this test is actually for, is that a repository exists here
    // afterwards — proving `commitStep` reaches for `ensureRepo` itself rather than assuming
    // its caller always has.
    await commitStep(target, step, [step.target.file], realGit);

    assert.equal(fs.existsSync(path.join(target, '.git')), true, 'commitStep must have initialised a repository to get this far');
  });
});

// ── T-6 review, security finding 12: a transcript nobody can commit by accident ────────────

/**
 * `progress.json` used to hold statuses, a dial and a verdict. Since T-6 it holds free text —
 * the learner's own questions and a model's answers — in `<target>/.repo-tour/`, a folder this
 * module `git init`s for them. `commitStep`'s own commits are pathspec-scoped and never sweep
 * it up, which `the commit CONTAINS exactly the step's files` already proves. What sweeps it up
 * is the learner's own `git add -A`, one click of *Stage All Changes*, in a repository this
 * extension created.
 *
 * Every test here runs the REAL `git` in a real temporary repository, and the load-bearing
 * assertion is `git check-ignore` — git's own answer to "would this be committed", rather than
 * this suite's opinion about what a pattern means.
 */
suite('ensureTranscriptIgnored — the tutor conversation is uncommittable by default', () => {
  /** git's own verdict, not a string comparison against a pattern. `check-ignore` exits 1 when
   *  nothing matched, which `realGit` surfaces as a rejection — that is the "not ignored"
   *  answer, not a failure. */
  async function isIgnored(target: string, rel: string): Promise<boolean> {
    try {
      await realGit(['check-ignore', '-q', '--no-index', rel], target);
      return true;
    } catch {
      return false;
    }
  }

  function excludePath(target: string): string {
    return path.join(target, '.git', 'info', 'exclude');
  }

  test('a freshly inited target ignores .repo-tour/ — git says so, not this test', async () => {
    const target = tmpDir();
    assert.equal(fs.existsSync(path.join(target, '.git')), false);

    await ensureRepo(target, realGit);

    assert.equal(await isIgnored(target, '.repo-tour/build/progress.json'), true,
      'the learner\'s questions and the model\'s answers must not be committable by an ordinary `git add -A`');
    assert.equal(await isIgnored(target, 'src/parse.ts'), false,
      'and nothing else of theirs was swept into the rule');
  });

  test('a target that was ALREADY a repository gets the rule too — the case that matters most', async () => {
    // `ensureRepo` no-ops the init here, and it would have been easy to make the ignore rule
    // follow it. That would cover the wrong half: a learner working inside a repository of
    // their own — their real project, with their real history, which they push — is exactly
    // the person for whom a committed transcript costs something.
    const target = tmpDir();
    await realGit(['init', '-q'], target);
    fs.rmSync(excludePath(target), { force: true });

    await ensureTranscriptIgnored(target, realGit);

    assert.equal(await isIgnored(target, '.repo-tour/build/progress.json'), true);
  });

  test('a target INSIDE the learner\'s repository is covered from the repository root', async () => {
    // The pattern is deliberately unanchored: `<target>` can be a subdirectory, in which case
    // the folder is at `<repo>/<sub>/.repo-tour/` and a rooted `/.repo-tour/` would miss it.
    const outer = tmpDir();
    await realGit(['init', '-q'], outer);
    const target = path.join(outer, 'learner', 'tutorial');
    fs.mkdirSync(target, { recursive: true });

    await ensureTranscriptIgnored(target, realGit);

    assert.equal(await isIgnored(outer, 'learner/tutorial/.repo-tour/build/progress.json'), true,
      'asked from the repository ROOT, which is where the learner runs `git add -A`');
    assert.equal(fs.existsSync(path.join(target, '.gitignore')), false,
      'and nothing tracked was written into their project to do it');
  });

  test('the rule goes in .git/info/exclude and NOT into a tracked .gitignore', async () => {
    // The choice is argued in `ensureTranscriptIgnored`'s header: a tracked `.gitignore` is
    // this extension writing a file into somebody's project that shows up in their `git
    // status`, rides into their next commit and travels to everyone who clones it.
    const target = tmpDir();
    await ensureRepo(target, realGit);

    assert.ok(fs.readFileSync(excludePath(target), 'utf8').includes(TUTORIAL_DIR_IGNORE));
    assert.equal(fs.existsSync(path.join(target, '.gitignore')), false);
    const status = await realGit(['status', '--porcelain'], target);
    assert.equal(status.trim(), '', 'nothing this wrote is visible to the learner as a change to their repository');
  });

  test('running it twice does not write the rule twice', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    const once = fs.readFileSync(excludePath(target), 'utf8');

    await ensureTranscriptIgnored(target, realGit);
    await ensureTranscriptIgnored(target, realGit);
    await ensureRepo(target, realGit);

    const after = fs.readFileSync(excludePath(target), 'utf8');
    assert.equal(after, once, 'idempotent — and `ensureRepo` runs at the top of every commitStep, on all sixty-one steps');
    assert.equal(after.split('\n').filter((line) => line.trim() === TUTORIAL_DIR_IGNORE).length, 1);
  });

  test('an exclude file the learner already wrote is APPENDED to, never replaced', async () => {
    const target = tmpDir();
    await realGit(['init', '-q'], target);
    // No trailing newline on purpose: the pattern must not join itself onto their last line
    // and silently change what it matches.
    fs.writeFileSync(excludePath(target), '# mine\nscratch/\n*.local');

    await ensureTranscriptIgnored(target, realGit);

    const after = fs.readFileSync(excludePath(target), 'utf8');
    assert.ok(after.startsWith('# mine\nscratch/\n*.local'), 'their rules are still there, unchanged');
    assert.ok(after.split('\n').includes('*.local'), 'and the last one did not get a pattern glued onto the end of it');
    assert.equal(await isIgnored(target, '.repo-tour/build/progress.json'), true);
    assert.equal(await isIgnored(target, 'scratch/x'), true, 'and theirs still works');
  });

  test('it names itself in the file, so a learner who finds it knows who to blame', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);

    assert.ok(fs.readFileSync(excludePath(target), 'utf8').includes(TUTORIAL_IGNORE_HEADER),
      'an ignore rule nobody can attribute is its own small mystery');
  });

  test('a folder that is not a repository at all is a no-op, not a throw', async () => {
    // It runs in front of a commit the learner asked for and in front of a question they
    // asked; a hardening step that could not happen is not a reason to refuse either.
    const target = tmpDir();

    await assert.doesNotReject(() => ensureTranscriptIgnored(target, realGit));
    assert.equal(fs.existsSync(path.join(target, '.git')), false, 'and it did not create one to have somewhere to write');
  });

  test('a git that rejects everything is swallowed rather than failing the commit', async () => {
    const exploding: GitRunner = () => Promise.reject(new Error('git: command not found'));

    await assert.doesNotReject(() => ensureTranscriptIgnored(tmpDir(), exploding));
  });
});

// ── T-13: a git that was STOPPED is not a git that said no ──────────────────────────────────

/**
 * `src/dial/commit.ts` reads a `GitRunner` rejection as git's ordinary ANSWER in two places —
 * `rev-parse` rejecting means "not a repository yet", `config` rejecting means "that key is
 * unset at every level" — and both readings are false for a subprocess that was killed. These
 * pin the difference from the outside: what ends up on disk, and what the learner is told.
 *
 * **What they cannot see.** They do not wait out a real thirty seconds — the rejection is
 * constructed, and `test/unit/build.test.ts` is where a real hanging `git` proves the runner
 * really produces that shape.
 *
 * What this paragraph used to say is worth keeping as a warning: it claimed the panel's
 * `.git/index.lock` sentence was "git's behaviour under SIGTERM, checked by inspection and by
 * git's own documentation". Driven, git does the OPPOSITE — it registers its lock files with
 * `sigchain` and removes them on `SIGTERM`. The sentence is gone (T-13 review finding 2), and
 * an honest "checked by inspection" is not a licence: it says what you are holding, and what
 * this one was holding was wrong.
 */
suite('T-13 — a timed-out git is never mistaken for git answering', () => {
  test('a stopped `rev-parse` does NOT init a second repository inside the learner’s own', async () => {
    const outer = tmpDir();
    await ensureRepo(outer, realGit);
    const target = path.join(outer, 'learner', 'tutorial');
    fs.mkdirSync(target, { recursive: true });
    writeFile(target, 'seed.ts');

    const result = await commitStep(target, fixtureStep(), ['seed.ts'], timingOutOn('rev-parse'));

    assert.equal(result.committed, false);
    assert.equal(
      fs.existsSync(path.join(target, '.git')), false,
      'reading the timeout as "not a repository" would git init here — and every later step would '
      + 'commit into a nested repo the learner’s own git log never shows',
    );
    assert.match(result.reason ?? '', /timed out after 30 seconds and was stopped/,
      'and it says what actually happened instead of a claim about their repository');
    assert.equal(result.refusal, 'git-stopped',
      'and the caller is handed a VALUE for it, so no sentence has to be matched to find out');
  });

  test('a stopped `git config` is not reported as a missing identity', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'A Learner', 'learner@example.com');
    writeFile(target, 'seed.ts');

    const result = await commitStep(target, fixtureStep(), ['seed.ts'], timingOutOn('config'));

    assert.equal(result.committed, false);
    assert.doesNotMatch(result.reason ?? '', /no git identity/,
      'their identity is configured perfectly well; nobody found out, which is a different sentence — '
      + 'and the advice attached to that one would send them to fix something that is not broken');
    assert.match(result.reason ?? '', /timed out after 30 seconds and was stopped/);
  });

  test('a stopped `git commit` comes back as a reason, never as a rejected promise', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'A Learner', 'learner@example.com');
    writeFile(target, 'seed.ts');

    const result = await commitStep(target, fixtureStep(), ['seed.ts'], timingOutOn('commit'));

    assert.equal(result.committed, false);
    assert.match(result.reason ?? '', /timed out after 30 seconds and was stopped/);
    assert.match(result.reason ?? '', /^git commit /, 'the runner’s own sentence, carried whole');
    assert.equal(result.refusal, 'git-stopped');
  });

  test('identityConfigured lets a stopped `config` through rather than answering false', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'A Learner', 'learner@example.com');

    await assert.rejects(
      () => identityConfigured(target, timingOutOn('config')),
      /timed out after 30 seconds/,
      'this function answers a yes/no question, and "nobody asked in time" is neither — the rejection '
      + 'is caught by commitStep’s single try, which is where every git outcome becomes a value',
    );
  });

  test('and the ordinary unset key still reads as false — the discriminator', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await clearLocalIdentity(target);
    assert.equal(await identityConfigured(target, realGit), false,
      'git’s non-zero exit for an unset key is still git ANSWERING, and still means no identity');
  });

  /**
   * Review finding 3, driven the way the review drove it: real `git`, a real ordinary failure
   * (nothing to commit, exit 1), and a plan whose QUESTION is one of this extension's own
   * sentences. `commitStep` runs `git commit -q -m <commitSubject(step)>` and the runner puts
   * the whole argv into the message, so the forged sentence really is in `reason` — what must
   * not happen is any caller reading it as the classification.
   */
  test('a plan that names itself after a timeout does not become one — the classifier is a value, not a sentence', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'A Learner', 'learner@example.com');
    writeFile(target, 'seed.ts');
    // Committed once already, so the second commit of the same unchanged path is a real exit 1.
    await commitStep(target, fixtureStep(), ['seed.ts'], realGit);

    const forging = fixtureStep({
      decision: {
        ...fixtureStep().decision,
        question: 'timed out after 1 second and was stopped',
      },
    });
    const result = await commitStep(target, forging, ['seed.ts'], realGit);

    assert.equal(result.committed, false, 'nothing changed, so git refuses — an ordinary failure');
    assert.match(result.reason ?? '', /timed out after 1 second and was stopped/,
      'the plan’s text really does reach the reason, through git’s own argv — this is the input, not the bug');
    assert.equal(result.refusal, 'git-failed',
      'git ANSWERED. A plan.json — "a repository someone else pointed the build at" — must not be able to '
      + 'make this extension say a subprocess was stopped when none was');
  });

  test('and one that names itself after a missing identity does not become one either', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'A Learner', 'learner@example.com');
    writeFile(target, 'seed.ts');
    await commitStep(target, fixtureStep(), ['seed.ts'], realGit);

    const forging = fixtureStep({
      decision: { ...fixtureStep().decision, question: 'no git identity configured in this folder' },
    });
    const result = await commitStep(target, forging, ['seed.ts'], realGit);

    assert.equal(result.refusal, 'git-failed',
      'this half of the hole pre-dates T-13 and the same field closes it: their identity is set, and the '
      + 'advice attached to `no-identity` would send them to fix what is not broken');
  });

  /**
   * Review finding 6. The header used to justify the learner-facing "nothing of yours was
   * edited" with *"this module only ever stages and commits; it writes nothing"*, three lines
   * below an `fs.mkdirSync` + `fs.appendFileSync` and a `git init`. The learner-facing sentence
   * survives; the absolute did not, and this is the precise version of it: every write this
   * module makes is inside `.git/`.
   */
  test('a stopped commit leaves everything outside `.git/` byte-for-byte — the claim the notice actually makes', async () => {
    const target = tmpDir();
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    writeFile(target, 'seed.ts', 'export const mine = 1;\n');
    fs.writeFileSync(path.join(target, 'src', 'untouched.ts'), 'export const theirs = 2;\n');

    const before = snapshotOutsideGit(target);
    const result = await commitStep(target, fixtureStep(), ['seed.ts'], timingOutOn('commit'));

    assert.equal(result.committed, false);
    assert.deepEqual(snapshotOutsideGit(target), before,
      'not one byte of the learner’s own tree changed — which is what "nothing of yours was edited" claims, '
      + 'and is a narrower claim than "it writes nothing" because this module DOES write: `git init` and '
      + '`.git/info/exclude`, both inside `.git/`');
    assert.ok(fs.existsSync(path.join(target, '.git', 'info', 'exclude')),
      'and it really did write one of them, so the test above is discriminating rather than vacuous');
  });

  /**
   * The other end of the sentence that was removed from `src/walk/session.ts` (finding 2): a
   * stale `.git/index.lock` is rare rather than impossible, and when it happens the learner is
   * told what to do — by GIT, verbatim, because the runner passes its stderr through. Nothing
   * in this extension has to guess at the advice, which is why it no longer offers it blind.
   */
  test('a stale `.git/index.lock` comes back carrying git’s OWN advice about it', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'A Learner', 'learner@example.com');
    writeFile(target, 'seed.ts');
    fs.writeFileSync(path.join(target, '.git', 'index.lock'), '');

    const result = await commitStep(target, fixtureStep(), ['seed.ts'], realGit);

    assert.equal(result.committed, false);
    assert.equal(result.refusal, 'git-failed', 'git answered — nothing here was stopped by us');
    assert.match(result.reason ?? '', /index\.lock/, 'git names the file');
    assert.match(result.reason ?? '', /remove the file manually/i,
      'and gives the advice itself, at the moment it is true. That is why `commitNotice` no longer gives it '
      + 'to every stopped git on a premise that, driven, does not hold');
  });

  test('a stopped `rev-parse --git-dir` inside ensureTranscriptIgnored is still swallowed', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    // Deliberate, and the one exception in that file: this hardening step asks nothing of the
    // learner and reports nothing on any path, so a bound it hit is not a different kind of
    // "could not". What it costs — thirty seconds of their wait — is stated in the code.
    await assert.doesNotReject(() => ensureTranscriptIgnored(target, timingOutOn('rev-parse')));
  });
});
