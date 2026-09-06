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
 * Two things this suite exists to prove above everything else, because they are the two ways
 * this module could quietly do the wrong thing to a learner's own repository:
 *   - **A configured identity commits; an absent one refuses, with a reason, and leaves no
 *     commit behind.** `commit.ts`'s own header explains why a missing identity is a refusal
 *     rather than an invented default — this is that promise, checked against real git.
 *   - **Only the files `commitStep` is handed are ever staged.** A second, real, untouched
 *     file sitting in the same folder must never ride along, and a path `resolveInsideTarget`
 *     refuses must never reach `git add` at all.
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

/**
 * Wraps the REAL `realGit` so a test can additionally assert which commands were actually
 * run, without ever substituting a fake in git's place. `ensureRepo`'s "a no-op on an existing
 * repo" claim is precisely a claim about how many times `git` gets invoked — only counting a
 * real invocation honestly, rather than asking a stub whether it was called, can prove it.
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

suite('ensureRepo — git-inits a bare folder, and leaves an existing one alone', () => {
  test('a folder with no .git becomes a repository', async () => {
    const target = tmpDir();
    assert.equal(fs.existsSync(path.join(target, '.git')), false);

    await ensureRepo(target, realGit);

    assert.equal(fs.existsSync(path.join(target, '.git')), true);
  });

  test('is a no-op on a folder that is already a repository — git is not invoked again', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);

    const { git, calls } = countingGit();
    await ensureRepo(target, git);

    assert.deepEqual(calls, [], 'git init must not even be attempted a second time');
  });
});

suite('identityConfigured — both halves, resolved the way a real commit would resolve them', () => {
  test('true once both user.name and user.email are set locally', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'Test Learner', 'learner@example.test');

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
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'Test Learner', 'learner@example.test');
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

  test('only the named files are staged — an untouched sibling stays out of the commit', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'Test Learner', 'learner@example.test');
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

  test('an escaping path is refused rather than staged', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'Test Learner', 'learner@example.test');
    const step = fixtureStep();

    const result = await commitStep(target, step, ['../../../etc/passwd'], realGit);

    assert.deepEqual(result, { committed: false, reason: 'no files to stage' });
    await assert.rejects(realGit(['rev-parse', 'HEAD'], target), 'nothing was ever committed');
  });

  test('an empty file list is refused the same way — nothing to stage is not a throw', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'Test Learner', 'learner@example.test');

    const result = await commitStep(target, fixtureStep(), [], realGit);

    assert.deepEqual(result, { committed: false, reason: 'no files to stage' });
  });

  test('a git failure at the commit step becomes a CommitResult, never a rejection', async () => {
    const target = tmpDir();
    await ensureRepo(target, realGit);
    await setLocalIdentity(target, 'Test Learner', 'learner@example.test');
    const step = fixtureStep();
    writeFile(target, step.target.file);

    const result = await commitStep(target, step, [step.target.file], failingOn('commit', 'git commit failed: simulated failure'));

    assert.equal(result.committed, false);
    assert.match(result.reason ?? '', /simulated failure/);
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
