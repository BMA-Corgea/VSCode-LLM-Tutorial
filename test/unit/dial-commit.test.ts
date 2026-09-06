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
import { realGit, type GitRunner } from '../../src/start/build.js';
import { commitStep, commitSubject, ensureRepo, identityConfigured } from '../../src/dial/commit.js';
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
      [['rev-parse', '--is-inside-work-tree']],
      'the work-tree question, and nothing else — git init must not be attempted a second time',
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

    assert.deepEqual(result, { committed: false, reason: 'no git identity configured in this folder' });
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

    assert.deepEqual(result, { committed: false, reason: 'no files to stage' });
    await assert.rejects(realGit(['rev-parse', 'HEAD'], target), 'nothing was ever committed');
  });

  test('an empty file list is refused the same way — nothing to stage is not a throw', async () => {
    const target = await committableTarget();

    const result = await commitStep(target, fixtureStep(), [], realGit);

    assert.deepEqual(result, { committed: false, reason: 'no files to stage' });
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
