// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/detour/store.ts` — where a detour lives on disk, and the recursive delete that takes it
 * away again (T-7, ACs 2, 3 and 5).
 *
 * Everything here runs under plain mocha against a REAL filesystem in real temp directories.
 * No `vscode` import, value or type: `esbuild.mjs` marks `repo-tour` and `mocha` external for
 * the unit bundle and deliberately does NOT mark `vscode`, so one such import here would fail
 * the build for every unit suite at once.
 *
 * **Why the symlinks are built for real.** T-5's security review found a merge-blocking HIGH
 * whose entire shape was that a path can stay under a root as a STRING and land somewhere else
 * on a DISK: `resolveInsideTarget` said `src/util.ts` was contained, `src` was a link to
 * `../outside`, and `mkdirSync(…, { recursive: true })` followed it without a murmur. Every
 * lexical test in the world passes that. This module is the one that *deletes* things, so a
 * lexical-only test here would be worse than none — it would read as coverage. Each test below
 * therefore plants an actual symlink on an actual disk and then asserts about the CANARY
 * outside it, never about the refusal message alone: a test that only checked the sentence
 * would pass just as happily if the refusal arrived after the damage.
 *
 * **And both directions.** A containment check that refuses everything passes every hostile
 * case here and breaks every real machine — `os.tmpdir()` sits under a symlink on macOS, which
 * is the ordinary case on a whole platform. So a symlinked `globalStorageRoot` is asserted to
 * still work, twice: once for writing and once for removing.
 *
 * **The workspace hash** is AC2's acceptance check in miniature. The real one lives in the
 * vscode-test suite where a real workspace is open; this one runs a whole detour lifecycle
 * (write → cache → remove) with a fake workspace sitting beside the storage root and asserts
 * the workspace tree is byte-for-byte identical afterwards. It is cheap, it runs on every unit
 * pass, and it fails the moment anything in this module learns to write relative to the cwd.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detourCachePath, detourDir, detoursRoot, isDetourWriteRefused, MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES, pruneDetourCache, readCachedDetour, removeDetour, removeDetourAt,
  sanitizeDetour, tutorialId, writeCachedDetour, writeDetourFiles,
  type DetourCacheKey, type DetourKey, type DetourRemoval, type DetourWriteRefused,
  type DetourWriteResult,
} from '../../src/detour/store.js';
import { DETOUR_LIMITS, type Detour } from '../../src/detour/types.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fresh, empty `globalStorageRoot` — what VS Code hands an extension, minus VS Code. */
function storage(): string {
  return tmpDir('detour-store-');
}

/** A sandbox with a storage root and a "workspace" beside it, for the AC2 mirror below. */
function sandbox(): { root: string; store: string; workspace: string } {
  const root = tmpDir('detour-sandbox-');
  const store = path.join(root, 'storage');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(store);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const A = 1;\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"mine"}\n');
  return { root, store, workspace };
}

/**
 * A hash of a directory TREE — every relative path and the bytes at it. Names alone are not
 * enough (a rewritten file keeps its name) and bytes alone are not enough (a moved file keeps
 * its bytes), so both go in, sorted, with the path length framed so `a/b` + `c` and `a` +
 * `b/c` cannot produce the same digest.
 */
function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (at: string, rel: string): void => {
    const entries = fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const child = path.join(at, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D${childRel.length}:${childRel}`);
        walk(child, childRel);
      } else if (entry.isSymbolicLink()) {
        hash.update(`L${childRel.length}:${childRel}=${fs.readlinkSync(child)}`);
      } else {
        hash.update(`F${childRel.length}:${childRel}=`);
        hash.update(fs.readFileSync(child));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/** Every file under `dir`, as sorted relative paths with `/` separators. */
function treeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(at, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

const STEP = 'st-3-decision-schema';

/**
 * The other half of every key (T-7 code review findings 1, 2 and 9). `globalStorageUri` is
 * per-EXTENSION, and repo-tour mints a step id with no repository in it, so a suite that only
 * ever drove ONE tutorial could not see either merge-blocking finding. `OTHER_TUTORIAL` exists
 * so that the collision tests below are two inputs sharing a key rather than one input twice.
 */
const TUTORIAL = 'tutorial-a-0000000000000000000000';
const OTHER_TUTORIAL = 'tutorial-b-1111111111111111111111';

/** One step of one tutorial. */
function key(stepId: string, tutorial: string = TUTORIAL): DetourKey {
  return { tutorial, stepId };
}

/** One step of one tutorial, at one prompt version, for one prompt. `prompt` defaults to a
 *  fixed string so a test that is not about invalidation does not have to name one. */
function cacheKey(
  stepId: string,
  promptVersion: number = 1,
  prompt: string = 'THE PROMPT',
  tutorial: string = TUTORIAL,
): DetourCacheKey {
  return { tutorial, stepId, promptVersion, prompt };
}

/** `writeDetourFiles`'s happy answer, or a failure that quotes the refusal it got instead. */
function wrote(result: DetourWriteResult | DetourWriteRefused): DetourWriteResult {
  assert.ok(!isDetourWriteRefused(result), `expected a write, got: ${isDetourWriteRefused(result) ? result.problem : ''}`);
  return result;
}

/** `writeDetourFiles`'s refusal sentence, or a failure. The two are told apart everywhere
 *  because "none of the files could be written" and "the folder could not be proved, so
 *  nothing was attempted" are different facts. */
function refusedWrite(result: DetourWriteResult | DetourWriteRefused): string {
  assert.ok(isDetourWriteRefused(result), 'expected a refusal, got a write');
  return isDetourWriteRefused(result) ? result.problem : '';
}

/** A well-formed detour, exactly as `parseDetourReply` would hand one over. */
function detour(over: Partial<Detour> = {}): Detour {
  return {
    title: 'A vending machine that makes change',
    domain: 'coins and a coin hopper',
    files: [
      { path: 'machine.ts', content: 'export const COINS = [25, 10, 5, 1];\n' },
      { path: 'lib/change.ts', content: 'export function change(n: number): number[] {\n  return [n];\n}\n' },
    ],
    stops: [
      { file: 'machine.ts', startLine: 1, endLine: 1, text: 'The coins the hopper can give back.' },
      { file: 'lib/change.ts', startLine: 1, endLine: 3, text: 'Greedy: biggest coin that fits, repeat.' },
      { file: 'lib/change.ts', startLine: 2, endLine: 2, text: 'The one line that does the work.' },
    ],
    ...over,
  };
}

/** Narrows a removal so a test can reach `.reason` without an `if` in every case. */
function refusalOf(result: DetourRemoval): string {
  assert.equal(result.removed, false, 'expected a refusal, got a removal');
  return result.removed ? '' : result.reason;
}

// ── detourDir — a step id is not a path segment ─────────────────────────────────────────────

/**
 * `stepId` comes out of `plan.json`, which repo-tour generates from a repository the learner
 * pointed us at. It is a string, and nothing about it is a promise that it is a legal, unique,
 * portable directory name. The module hashes rather than sanitises; the tests below are what
 * that choice has to buy, and the collision pair is the one that would be silently wrong under
 * a sanitiser — two different steps sharing one detour directory, which means one step's
 * *return* deletes the other's open tabs.
 */
suite('detourDir — the step id is hashed, and the hash is the safety property', () => {
  test('a detour lives under <globalStorageRoot>/detours/, one hashed segment deep', () => {
    const root = storage();
    const dir = detourDir(root, key(STEP));

    assert.equal(path.dirname(dir), detoursRoot(root));
    assert.equal(detoursRoot(root), path.join(root, 'detours'));
    assert.match(path.basename(dir), /^[0-9a-f]{32}$/);
  });

  test('the same step id always gives the same directory — a retake finds its own files', () => {
    const root = storage();
    assert.equal(detourDir(root, key(STEP)), detourDir(root, key(STEP)));
  });

  test('asking creates nothing — detourDir is a pure function of its two arguments', () => {
    const root = storage();
    detourDir(root, key(STEP));
    detourCachePath(root, cacheKey(STEP, 1));

    assert.deepEqual(fs.readdirSync(root), [], 'asking where a detour would go created something');
  });

  test('every hostile step id still lands on one hex segment inside the store', () => {
    const root = storage();
    const hostile = [
      '../../../etc/passwd',
      '..',
      '.',
      '/etc/passwd',
      'C:\\Windows\\System32',
      '\\\\server\\share',
      'con',
      'NUL',
      'a\u0000b',
      'trailing. ',
      '   ',
      '',
      'ünïcödé-🙂',
      'x'.repeat(4000),
    ];

    for (const id of hostile) {
      const dir = detourDir(root, key(id));
      assert.match(path.basename(dir), /^[0-9a-f]{32}$/, `step id ${JSON.stringify(id)} produced an unsafe segment`);
      assert.equal(path.dirname(dir), detoursRoot(root), `step id ${JSON.stringify(id)} escaped the store`);
    }
  });

  test('ids a sanitiser would COLLIDE get different directories — the reason it is a hash', () => {
    // Each pair is one a plausible `replace(/[^a-z0-9]/gi, '_')` maps onto a single name, and
    // the third is one a case-insensitive filesystem folds even without a sanitiser. Two steps
    // sharing a directory is not a cosmetic bug: `removeDetour` on one deletes the other.
    const root = storage();
    const pairs: [string, string][] = [
      ['a/b', 'a_b'],
      ['step 1', 'step-1'],
      ['Step-1', 'step-1'],
      ['x', 'x '],
    ];

    for (const [left, right] of pairs) {
      assert.notEqual(detourDir(root, key(left)), detourDir(root, key(right)),
        `${JSON.stringify(left)} and ${JSON.stringify(right)} share a detour directory`);
    }
  });

  test('the cache lives beside the detours, never inside one', () => {
    const root = storage();
    const cache = detourCachePath(root, cacheKey(STEP, 1));

    assert.equal(path.dirname(cache), path.join(detoursRoot(root), 'cache'));
    assert.match(path.basename(cache), /^[0-9a-f]{32}\.json$/);
    assert.equal(cache.startsWith(detourDir(root, key(STEP))), false);
  });
});

// ── writing a detour ────────────────────────────────────────────────────────────────────────

suite('writeDetourFiles — the bytes land in global storage and nowhere else (AC2)', () => {
  test('round trip: every file, its exact bytes, in order, with no problems', () => {
    const root = storage();
    const d = detour();

    const result = wrote(writeDetourFiles(root, key(STEP), d));

    assert.deepEqual(result.problems, []);
    assert.equal(result.dir, detourDir(root, key(STEP)));
    assert.deepEqual(result.written, [
      { path: 'machine.ts', abs: path.join(result.dir, 'machine.ts') },
      { path: 'lib/change.ts', abs: path.join(result.dir, 'lib', 'change.ts') },
    ], 'the model’s own relative path travels with the absolute one — the narrator needs both');
    for (const file of d.files) {
      assert.equal(fs.readFileSync(path.join(result.dir, file.path), 'utf8'), file.content);
    }
  });

  test('nested paths get their parent directories made for them', () => {
    const root = storage();
    const result = wrote(writeDetourFiles(root, key(STEP), detour({
      files: [{ path: 'a/b/c/deep.ts', content: 'export const D = 4;\n' }],
      stops: detour().stops.map((s) => ({ ...s, file: 'a/b/c/deep.ts' })),
    })));

    assert.deepEqual(result.problems, []);
    assert.equal(fs.readFileSync(path.join(result.dir, 'a', 'b', 'c', 'deep.ts'), 'utf8'), 'export const D = 4;\n');
  });

  test('a whole lifecycle leaves the learner’s workspace byte-for-byte identical (AC2)', () => {
    // The real proof is the vscode-test one, with a real workspace open. This is the same
    // question asked where it costs nothing: the module is handed a storage root, and a
    // workspace sits beside it as bait. Anything that ever wrote relative to the cwd, or
    // joined the wrong root, moves this hash.
    const { store, workspace } = sandbox();
    const before = treeHash(workspace);

    writeDetourFiles(store, key(STEP), detour());
    writeCachedDetour(store, cacheKey(STEP, 1), detour());
    readCachedDetour(store, cacheKey(STEP, 1));
    removeDetour(store, key(STEP));

    assert.equal(treeHash(workspace), before, 'a detour touched the learner’s workspace');
    assert.deepEqual(treeFiles(workspace).sort(), ['package.json', 'src/index.ts']);
  });

  test('a file path that escapes the detour directory is refused, and nothing lands outside', () => {
    // `parseDetourReply` is supposed to have rejected these already. This module refuses them
    // anyway: it is the last thing between a model-chosen string and a real filesystem path,
    // and a defence that relies on a caller in another file is not a defence this file has.
    const root = storage();
    const outsideName = path.join(root, 'stolen.ts');
    fs.writeFileSync(outsideName, 'someone else’s file\n');

    const result = wrote(writeDetourFiles(root, key(STEP), detour({
      files: [
        { path: '../../stolen.ts', content: 'pwned\n' },
        { path: '/etc/passwd', content: 'pwned\n' },
        { path: 'ok.ts', content: 'export const OK = 1;\n' },
      ],
      stops: detour().stops.map((s) => ({ ...s, file: 'ok.ts' })),
    })));

    assert.equal(result.problems.length, 2, `expected two refusals, got ${JSON.stringify(result.problems)}`);
    // The sentence is `refusalSentence`'s now — the one the panel shows — rather than a second
    // wording invented here, and it NAMES the rule that was broken. That is the point of the
    // union in `types.ts`, and asserting the rule rather than the word "refused" is what stops
    // this test passing on a refusal for the wrong reason.
    assert.match(result.problems[0] ?? '', /a "\.\." segment/);
    assert.match(result.problems[1] ?? '', /is an absolute path/);
    for (const problem of result.problems) assert.match(problem, /Nothing was written/);
    assert.equal(fs.readFileSync(outsideName, 'utf8'), 'someone else’s file\n');
    // Not all-or-nothing: the good file beside the bad one is still written, the way
    // `reproduceFiles` reports one entry without dropping the rest.
    assert.deepEqual(result.written, [{ path: 'ok.ts', abs: path.join(result.dir, 'ok.ts') }]);
  });

  test('a symlink planted at a destination FILE is never written through', () => {
    // The final-component half of the problem, and a different one from the directory half
    // below. Two things stop it here and both matter: the directory is cleared before the
    // write, so the planted link is gone by then, and `writeTextAtomic` writes through a temp
    // file and a rename — which REPLACES a link at the destination rather than following it,
    // the property `dial-writer.test.ts` pins on the primitive itself. What must not happen,
    // by either route, is the pointee changing; that is what is asserted.
    const root = storage();
    const outside = path.join(root, 'bashrc');
    fs.writeFileSync(outside, 'export PATH=$PATH\n');
    const dir = detourDir(root, key(STEP));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'machine.ts');
    fs.symlinkSync(outside, dest);

    const result = wrote(writeDetourFiles(root, key(STEP), detour({
      files: [{ path: 'machine.ts', content: 'export const COINS = [25];\n' }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 1 })),
    })));

    assert.deepEqual(result.problems, []);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'export PATH=$PATH\n', 'the write followed a symlink out of the store');
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const COINS = [25];\n');
  });

  test('a symlinked DETOUR DIRECTORY is refused — every file, and the canary is untouched', () => {
    // T-5's finding 1, moved one directory along. `<detours>/<hash> -> ../outside` is contained
    // lexically and lands outside on the disk; `writeTextAtomic`'s root check is what sees it,
    // and it only sees it because the root handed in is `<detours>` rather than the detour
    // directory itself. Handing in the detour directory would make the planted link the root
    // and every write "contained" in it.
    const root = storage();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const canary = path.join(outside, 'machine.ts');
    fs.writeFileSync(canary, 'someone else’s file\n');
    const dir = detourDir(root, key(STEP));
    fs.mkdirSync(detoursRoot(root), { recursive: true });
    fs.symlinkSync(outside, dir);

    const problem = refusedWrite(writeDetourFiles(root, key(STEP), detour()));

    assert.ok(problem.length > 0, 'a detour wrote through a symlinked directory');
    assert.equal(fs.readFileSync(canary, 'utf8'), 'someone else’s file\n');
    assert.deepEqual(fs.readdirSync(outside), ['machine.ts'], 'a refused write still created files outside the store');
  });

  test('a symlinked DETOURS root is refused before anything is written', () => {
    // One level up again: `<globalStorageRoot>/detours -> /somewhere` would make every detour,
    // and the whole cache, land wherever the link points while every containment check inside
    // it agreed. Containment is always relative to the root you are given, so the store root
    // itself has to be proved rather than assumed.
    const root = storage();
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, detoursRoot(root));

    const problem = refusedWrite(writeDetourFiles(root, key(STEP), detour()));

    assert.ok(problem.length > 0, 'a detour wrote through a symlinked store root');
    assert.deepEqual(fs.readdirSync(outside), [], 'files landed through the planted store link');
  });

  test('a stale file from a previous detour does not survive into the new one', () => {
    // A crashed session leaves its files behind. Writing over them file-by-file would leave the
    // leftovers in place, and step 4 opens *the directory's* files as tabs — so the learner
    // would get a tab from a detour they never asked for, and `stops` would not match it.
    const root = storage();
    writeDetourFiles(root, key(STEP), detour({
      files: [{ path: 'stale.ts', content: 'export const OLD = 1;\n' }],
      stops: detour().stops.map((s) => ({ ...s, file: 'stale.ts', startLine: 1, endLine: 1 })),
    }));

    const result = wrote(writeDetourFiles(root, key(STEP), detour()));

    assert.deepEqual(result.problems, []);
    assert.equal(fs.existsSync(path.join(result.dir, 'stale.ts')), false, 'a stale file survived a rewrite');
    assert.deepEqual(treeFiles(result.dir), ['lib/change.ts', 'machine.ts']);
  });

  test('a storage root that is itself a symlink still works — the ordinary case on macOS', () => {
    // The direction that stops the fix being "refuse everything": `os.tmpdir()` sits under a
    // symlink on macOS, so a check comparing a resolved path against an unresolved root would
    // refuse every real machine on a whole platform.
    const box = tmpDir('detour-sandbox-');
    const real = path.join(box, 'real-storage');
    fs.mkdirSync(real);
    const root = path.join(box, 'storage');
    fs.symlinkSync(real, root);

    const result = wrote(writeDetourFiles(root, key(STEP), detour()));

    assert.deepEqual(result.problems, []);
    assert.equal(fs.readFileSync(path.join(real, 'detours', path.basename(result.dir), 'machine.ts'), 'utf8'),
      'export const COINS = [25, 10, 5, 1];\n');
  });

  test('a relative storage root is refused rather than resolved against the cwd', () => {
    const problem = refusedWrite(writeDetourFiles('detours-relative', key(STEP), detour()));

    assert.ok(problem.length > 0);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'detours-relative')), false,
      'a relative storage root created a directory in the cwd');
  });

  test('no .tmp file is left behind — the write is temp-plus-rename', () => {
    const root = storage();
    const result = wrote(writeDetourFiles(root, key(STEP), detour()));

    assert.deepEqual(treeFiles(result.dir).filter((f) => f.includes('.tmp')), []);
  });
});

// ── the cache (AC5) ─────────────────────────────────────────────────────────────────────────

suite('the cache — a retake is free, and a hand-edited entry is a MISS (AC5)', () => {
  test('write then read gives back an equal detour', () => {
    const root = storage();
    const d = detour();

    assert.equal(writeCachedDetour(root, cacheKey(STEP, 1), d), true);
    assert.deepEqual(readCachedDetour(root, cacheKey(STEP, 1)), d);
    assert.ok(fs.existsSync(detourCachePath(root, cacheKey(STEP, 1))));
  });

  test('the key is the step id AND the prompt version — either one changing is a miss', () => {
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP, 1), detour());

    assert.notEqual(readCachedDetour(root, cacheKey(STEP, 1)), null, 'the same key must hit');
    assert.equal(readCachedDetour(root, cacheKey(STEP, 2)), null, 'a new prompt version served a stale detour');
    assert.equal(readCachedDetour(root, cacheKey('st-9-other', 1)), null, 'another step served this step’s detour');
    assert.notEqual(detourCachePath(root, cacheKey(STEP, 1)), detourCachePath(root, cacheKey(STEP, 2)));
  });

  test('two versions of one step coexist — bumping the version does not destroy the old entry', () => {
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP, 1), detour({ title: 'v1' }));
    writeCachedDetour(root, cacheKey(STEP, 2), detour({ title: 'v2' }));

    assert.equal(readCachedDetour(root, cacheKey(STEP, 1))?.title, 'v1');
    assert.equal(readCachedDetour(root, cacheKey(STEP, 2))?.title, 'v2');
  });

  test('a missing entry is a miss, not a throw', () => {
    assert.equal(readCachedDetour(storage(), cacheKey(STEP, 1)), null);
  });

  test('an unparseable entry is a miss, not a throw', () => {
    const root = storage();
    const file = detourCachePath(root, cacheKey(STEP, 1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');

    assert.equal(readCachedDetour(root, cacheKey(STEP, 1)), null);
  });

  test('an entry that is a SYMLINK is a miss — a cache read never follows a planted link', () => {
    // `<hash>.json -> /home/you/.ssh/id_rsa` would be read, parsed (or not) and, if it happened
    // to be JSON of the right shape, written back out as a detour's files. Cheaper to refuse
    // anything that is not a regular file than to reason about what could be on the other end.
    const root = storage();
    const outside = path.join(root, 'secret.json');
    fs.writeFileSync(outside, JSON.stringify(detour()));
    const file = detourCachePath(root, cacheKey(STEP, 1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(outside, file);

    assert.equal(readCachedDetour(root, cacheKey(STEP, 1)), null);
  });

  test('an entry through a symlinked store root is a miss, and a write there is refused', () => {
    const root = storage();
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, detoursRoot(root));

    assert.equal(writeCachedDetour(root, cacheKey(STEP, 1), detour()), false);
    assert.equal(readCachedDetour(root, cacheKey(STEP, 1)), null);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('an oversized entry is a miss on its SIZE, before it is parsed', () => {
    // T-6's security review, finding 4, in a new place: a count is not a size. `DETOUR_LIMITS`
    // bounds how many files and how many LINES; nothing in it bounds how long a line is, so a
    // hand-edited entry can be arbitrarily large and still shaped exactly right.
    const root = storage();
    const file = detourCachePath(root, cacheKey(STEP, 1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Perfectly SHAPED and perfectly within `DETOUR_LIMITS` — one file, one line, three stops
    // that all name it. Nothing but the size is wrong with it, so nothing but the size can be
    // what refuses it; a fixture that also failed the shape check would pass this test with
    // the ceiling deleted.
    const huge = detour({
      files: [{ path: 'machine.ts', content: 'x'.repeat(MAX_CACHE_BYTES + 1) }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 1 })),
    });
    fs.writeFileSync(file, JSON.stringify(huge));
    assert.ok(fs.statSync(file).size > MAX_CACHE_BYTES);
    assert.notEqual(sanitizeDetour(huge), null, 'the fixture must fail on its size alone');

    assert.equal(readCachedDetour(root, cacheKey(STEP, 1)), null);
  });

  test('a legitimately large entry, just under the ceiling, still hits', () => {
    // The other direction: the ceiling must be above anything the limits actually permit, or
    // the cache would silently never hit and AC5 would fail with every test green.
    const root = storage();
    const big = detour({
      files: [{ path: 'machine.ts', content: `${'x'.repeat(300)}\n`.repeat(DETOUR_LIMITS.maxLinesPerFile) }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 10 })),
    });

    assert.equal(writeCachedDetour(root, cacheKey(STEP, 1), big), true);
    assert.deepEqual(readCachedDetour(root, cacheKey(STEP, 1)), big);
  });

  test('the cache write is atomic and leaves no .tmp behind', () => {
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP, 1), detour());

    assert.deepEqual(fs.readdirSync(path.join(detoursRoot(root), 'cache')).filter((f) => f.includes('.tmp')), []);
  });

  test('a cache hit does not resurrect a deleted detour directory', () => {
    // AC3 says the directory is gone; AC5 says the retake is free. Both, at once: the cache
    // holds the ANSWER, not the files, so a hit after a return still has to write them again.
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());
    writeCachedDetour(root, cacheKey(STEP, 1), detour());
    removeDetour(root, key(STEP));

    assert.equal(fs.existsSync(detourDir(root, key(STEP))), false);
    assert.notEqual(readCachedDetour(root, cacheKey(STEP, 1)), null, 'the return deleted the cache along with the files');
  });
});

// ── sanitizeDetour — reading back untrusted, persisted model output ─────────────────────────

/**
 * The shape check, driven directly rather than through the disk. Same discipline as
 * `sanitizeTranscript` (`src/tutor/transcript.ts`): DROP, never coerce, and rebuild field by
 * field so an extra field cannot survive. The one difference is the unit — a transcript drops
 * a bad TURN and keeps the rest, because the rest is still the learner's conversation; a
 * detour is one object whose parts refer to each other (a stop names a file), so a bad part
 * means the whole entry is a miss. There is no half-trusted detour.
 */
suite('sanitizeDetour — drop, never coerce, and never a half-trusted object', () => {
  test('a well-formed detour survives, deep-equal and field for field', () => {
    const d = detour();
    const out = sanitizeDetour(JSON.parse(JSON.stringify(d)));

    assert.deepEqual(out, d);
  });

  test('extra fields do not survive — the object is rebuilt, not passed through', () => {
    const raw = {
      ...detour(),
      command: 'rm -rf /',
      files: [{ path: 'machine.ts', content: 'export const A = 1;\n', mode: 0o777, executable: true }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 1, decoration: '<script>' })),
    };

    const out = sanitizeDetour(raw);

    assert.ok(out !== null);
    assert.deepEqual(Object.keys(out).sort(), ['domain', 'files', 'stops', 'title']);
    assert.deepEqual(Object.keys(out.files[0] ?? {}).sort(), ['content', 'path']);
    assert.deepEqual(Object.keys(out.stops[0] ?? {}).sort(), ['endLine', 'file', 'startLine', 'text']);
  });

  test('every non-object is a miss', () => {
    for (const raw of [null, undefined, 0, 'a detour', true, [], [detour()]]) {
      assert.equal(sanitizeDetour(raw), null, `${JSON.stringify(raw)} survived`);
    }
  });

  test('a bad or missing scalar is a miss, never a coerced string', () => {
    const cases: Record<string, unknown> = {
      'title missing': { ...detour(), title: undefined },
      'title not a string': { ...detour(), title: 42 },
      'title an object': { ...detour(), title: { toString: 'x' } },
      'domain missing': { ...detour(), domain: undefined },
      'domain not a string': { ...detour(), domain: ['coins'] },
    };

    for (const [name, raw] of Object.entries(cases)) {
      assert.equal(sanitizeDetour(raw), null, `${name} survived`);
    }
  });

  test('a bad file entry is a miss for the WHOLE detour, not a shorter file list', () => {
    const cases: Record<string, unknown> = {
      'files not an array': { ...detour(), files: { 'machine.ts': 'x' } },
      'files empty': { ...detour(), files: [] },
      'a null entry': { ...detour(), files: [null, ...detour().files] },
      'an array entry': { ...detour(), files: [['machine.ts', 'x']] },
      'path not a string': { ...detour(), files: [{ path: 1, content: 'x' }] },
      'path empty': { ...detour(), files: [{ path: '', content: 'x' }] },
      'content not a string': { ...detour(), files: [{ path: 'machine.ts', content: null }] },
    };

    for (const [name, raw] of Object.entries(cases)) {
      assert.equal(sanitizeDetour(raw), null, `${name} survived`);
    }
  });

  test('a bad stop is a miss, including one naming a file the detour does not have', () => {
    const cases: Record<string, unknown> = {
      'stops not an array': { ...detour(), stops: 'three of them' },
      'a null stop': { ...detour(), stops: [null, ...detour().stops] },
      'file not a string': { ...detour(), stops: detour().stops.map((s) => ({ ...s, file: 3 })) },
      'file unknown': { ...detour(), stops: detour().stops.map((s) => ({ ...s, file: 'nowhere.ts' })) },
      'text not a string': { ...detour(), stops: detour().stops.map((s) => ({ ...s, text: {} })) },
      'startLine not a number': { ...detour(), stops: detour().stops.map((s) => ({ ...s, startLine: '1' })) },
      'startLine zero': { ...detour(), stops: detour().stops.map((s) => ({ ...s, startLine: 0, endLine: 1 })) },
      'startLine fractional': { ...detour(), stops: detour().stops.map((s) => ({ ...s, startLine: 1.5, endLine: 2 })) },
      'startLine NaN': { ...detour(), stops: detour().stops.map((s) => ({ ...s, startLine: Number.NaN })) },
      'endLine before startLine': { ...detour(), stops: detour().stops.map((s) => ({ ...s, startLine: 5, endLine: 2 })) },
      'endLine infinite': { ...detour(), stops: detour().stops.map((s) => ({ ...s, endLine: Number.POSITIVE_INFINITY })) },
    };

    for (const [name, raw] of Object.entries(cases)) {
      assert.equal(sanitizeDetour(raw), null, `${name} survived`);
    }
  });

  test('the shared limits are re-enforced on the way IN, not only on the way out', () => {
    // `DETOUR_LIMITS` lives in `types.ts` precisely so the parser and this cannot disagree. The
    // cache is a SECOND door into the same data — a file on the learner's own disk, editable
    // by hand and writable by a future version of this extension — so it gets the same bounds.
    const many = detour({
      files: Array.from({ length: DETOUR_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}.ts`, content: 'x\n' })),
      stops: detour().stops.map((s) => ({ ...s, file: 'f0.ts', startLine: 1, endLine: 1 })),
    });
    const long = detour({
      files: [{ path: 'machine.ts', content: 'x\n'.repeat(DETOUR_LIMITS.maxLinesPerFile + 1) }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 1 })),
    });
    const tooFew = detour({ stops: detour().stops.slice(0, DETOUR_LIMITS.minStops - 1) });
    const tooMany = detour({
      stops: Array.from({ length: DETOUR_LIMITS.maxStops + 1 }, () => ({
        file: 'machine.ts', startLine: 1, endLine: 1, text: 'again',
      })),
    });

    assert.equal(sanitizeDetour(many), null, 'too many files survived');
    assert.equal(sanitizeDetour(long), null, 'an over-long file survived');
    assert.equal(sanitizeDetour(tooFew), null, 'too few stops survived');
    assert.equal(sanitizeDetour(tooMany), null, 'too many stops survived');
  });

  test('the boundary values themselves are ACCEPTED — the limits are inclusive', () => {
    const atLimit = detour({
      files: Array.from({ length: DETOUR_LIMITS.maxFiles }, (_, i) => ({ path: `f${i}.ts`, content: 'x\n' })),
      stops: Array.from({ length: DETOUR_LIMITS.maxStops }, () => ({
        file: 'f0.ts', startLine: 1, endLine: 1, text: 'again',
      })),
    });
    const exactLines = detour({
      files: [{ path: 'machine.ts', content: 'x\n'.repeat(DETOUR_LIMITS.maxLinesPerFile) }],
      stops: detour().stops.slice(0, DETOUR_LIMITS.minStops).map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 1 })),
    });

    assert.notEqual(sanitizeDetour(atLimit), null, 'the maximum permitted detour was refused');
    assert.notEqual(sanitizeDetour(exactLines), null, 'a file of exactly the line limit was refused');
  });

  test('a hand-edited cache entry that fails the shape is a MISS on disk too', () => {
    const root = storage();
    const file = detourCachePath(root, cacheKey(STEP, 1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...detour(), files: [{ path: '../../../etc/passwd', content: 'x' }] }));

    // A path this module would refuse to write is still a well-SHAPED entry, so it comes back
    // — and the refusal that matters happens at the write, which the suite above pins. What
    // must not happen is a crash on the read path.
    const back = readCachedDetour(root, cacheKey(STEP, 1));
    assert.ok(back === null || back.files.length === 1);
  });
});

// ── removeDetour — the recursive delete ─────────────────────────────────────────────────────

/**
 * The most dangerous function in the ticket: a recursive delete whose target is derived from
 * state. Every refusal below is driven with a real path on a real disk, and every hostile case
 * asserts the CANARY survived rather than only that a refusal came back.
 */
suite('removeDetour — a recursive delete that refuses everything it cannot prove (AC3)', () => {
  test('the happy path: the directory and everything under it is gone', () => {
    const root = storage();
    const { dir } = wrote(writeDetourFiles(root, key(STEP), detour()));
    assert.ok(fs.existsSync(path.join(dir, 'lib', 'change.ts')));

    const result = removeDetour(root, key(STEP));

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(dir), false);
  });

  test('it deletes EXACTLY one detour — a sibling step and the cache both survive', () => {
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());
    const other = wrote(writeDetourFiles(root, key('st-9-other'), detour())).dir;
    writeCachedDetour(root, cacheKey(STEP, 1), detour());

    removeDetour(root, key(STEP));

    assert.equal(fs.existsSync(detourDir(root, key(STEP))), false);
    assert.ok(fs.existsSync(other), 'removing one detour took another step’s with it');
    assert.ok(fs.existsSync(detourCachePath(root, cacheKey(STEP, 1))), 'the return deleted the cache');
    assert.ok(fs.existsSync(detoursRoot(root)), 'the return deleted the whole store');
  });

  test('an absent detour is `absent`, not a throw and not a failure to report', () => {
    const root = storage();
    // A store with another step's detour in it, so "absent" is about THIS step rather than
    // about a machine that has never taken a detour — those are different answers below.
    writeDetourFiles(root, key('st-9-other'), detour());

    const result = removeDetour(root, key(STEP));

    assert.equal(refusalOf(result), 'absent');
  });

  test('it is idempotent — the second return is `absent`, not an error', () => {
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());

    assert.equal(removeDetour(root, key(STEP)).removed, true);
    assert.equal(refusalOf(removeDetour(root, key(STEP))), 'absent');
  });

  test('no store at all is `no-store`, and nothing is created by asking', () => {
    const root = storage();

    assert.equal(refusalOf(removeDetour(root, key(STEP))), 'no-store');
    assert.deepEqual(fs.readdirSync(root), [], 'a refused removal created the store it was looking for');
  });

  test('a relative storage root is `bad-root` — never resolved against the cwd', () => {
    assert.equal(refusalOf(removeDetour('detours-relative', key(STEP))), 'bad-root');
    assert.equal(refusalOf(removeDetour('', key(STEP))), 'bad-root');
    assert.equal(refusalOf(removeDetourAt('relative/root', '/tmp')), 'bad-root');
  });

  test('the store root ITSELF is refused — `<globalStorageRoot>/detours` is never the target', () => {
    // Unreachable through `removeDetour`, because a 32-hex segment is never the empty string.
    // Driven through `removeDetourAt` for exactly that reason: a guard nothing can reach is a
    // guard nothing can test, and this is the one whose failure deletes every detour at once.
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());

    assert.equal(refusalOf(removeDetourAt(root, detoursRoot(root))), 'is-the-store-root');
    assert.equal(refusalOf(removeDetourAt(root, `${detoursRoot(root)}${path.sep}`)), 'is-the-store-root');
    assert.equal(refusalOf(removeDetourAt(root, path.join(detoursRoot(root), '.'))), 'is-the-store-root');
    assert.ok(fs.existsSync(detourDir(root, key(STEP))), 'the store root was deleted with its contents');
  });

  test('the filesystem root, the storage root and the home directory are all refused', () => {
    // The argument the brief asks for: write the refusal you would want if the argument were
    // `/`. None of these is reachable from a hashed step id either; all three are one bad
    // caller away, and the reason each is refused is that it does not resolve UNDER the store.
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());
    const targets = [path.parse(process.cwd()).root, root, os.homedir(), os.tmpdir()];

    for (const target of targets) {
      assert.equal(refusalOf(removeDetourAt(root, target)), 'escaped', `${target} was not refused`);
      assert.ok(fs.existsSync(target), `${target} was deleted`);
    }
    assert.ok(fs.existsSync(detourDir(root, key(STEP))));
  });

  test('a path outside the store is `escaped`, and the victim survives', () => {
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());
    const victimDir = tmpDir('detour-victim-');
    fs.writeFileSync(path.join(victimDir, 'important.txt'), 'keep me\n');

    assert.equal(refusalOf(removeDetourAt(root, victimDir)), 'escaped');
    assert.equal(fs.readFileSync(path.join(victimDir, 'important.txt'), 'utf8'), 'keep me\n');
  });

  test('a path built out of the store with `..` is `escaped`', () => {
    const root = storage();
    writeDetourFiles(root, key(STEP), detour());
    const victimDir = tmpDir('detour-victim-');
    fs.writeFileSync(path.join(victimDir, 'important.txt'), 'keep me\n');
    const traversal = path.join(detoursRoot(root), '..', '..', path.basename(victimDir));

    assert.equal(refusalOf(removeDetourAt(root, traversal)), 'escaped');
    assert.equal(fs.readFileSync(path.join(victimDir, 'important.txt'), 'utf8'), 'keep me\n');
  });

  test('the cache directory is `not-a-detour` — the store’s own furniture is out of reach', () => {
    // A direct child of the store, like a detour, and deleting it would silently throw away
    // every cached generation on the machine (AC5 quietly stops holding). The name rule is what
    // keeps it out of reach: only a 32-hex directory is ever this command's to remove.
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP, 1), detour());
    const cacheDir = path.dirname(detourCachePath(root, cacheKey(STEP, 1)));

    assert.equal(refusalOf(removeDetourAt(root, cacheDir)), 'not-a-detour');
    assert.ok(fs.existsSync(detourCachePath(root, cacheKey(STEP, 1))));
  });

  test('a SYMLINKED DIRECTORY COMPONENT is refused — T-5 finding 1, on the delete path', () => {
    // The finding, exactly: `<detours>/link -> ../outside` is contained as a STRING, and every
    // lexical check agrees that `<detours>/link/victim` is inside the store. `realpath` is the
    // only thing that can tell the two apart, because the difference is not in the path — it is
    // on the disk. A recursive delete that gets this wrong deletes someone else's directory.
    const root = storage();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'victim'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'victim', 'important.txt'), 'keep me\n');
    fs.mkdirSync(detoursRoot(root), { recursive: true });
    fs.symlinkSync(path.join('..', 'outside'), path.join(detoursRoot(root), 'link'));

    const result = removeDetourAt(root, path.join(detoursRoot(root), 'link', 'victim'));

    assert.equal(refusalOf(result), 'escaped');
    assert.equal(fs.readFileSync(path.join(outside, 'victim', 'important.txt'), 'utf8'), 'keep me\n',
      'the delete followed a symlinked directory component out of the store');
  });

  test('the detour directory being ITSELF a symlink is refused, link and pointee both intact', () => {
    // Refused rather than unlinked, deliberately. `fs.rmSync` would unlink the link and leave
    // the pointee alone, which is safe — but "the thing I was asked to delete is not the thing
    // I would be deleting" is not a situation to proceed from quietly, and a link here means
    // something already went wrong that the learner should not have papered over for them.
    const root = storage();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'important.txt'), 'keep me\n');
    fs.mkdirSync(detoursRoot(root), { recursive: true });
    const dir = detourDir(root, key(STEP));
    fs.symlinkSync(outside, dir);

    assert.equal(refusalOf(removeDetour(root, key(STEP))), 'not-a-directory');
    assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep me\n');
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), true, 'a refused removal still unlinked the planted link');
  });

  test('a regular FILE where the detour directory should be is `not-a-directory`', () => {
    const root = storage();
    fs.mkdirSync(detoursRoot(root), { recursive: true });
    fs.writeFileSync(detourDir(root, key(STEP)), 'not a directory\n');

    assert.equal(refusalOf(removeDetour(root, key(STEP))), 'not-a-directory');
    assert.ok(fs.existsSync(detourDir(root, key(STEP))));
  });

  test('a SYMLINKED STORE ROOT is `escaped-store`, and nothing under it is touched', () => {
    const root = storage();
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    const planted = path.join(outside, path.basename(detourDir(root, key(STEP))));
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, 'important.txt'), 'keep me\n');
    fs.symlinkSync(outside, detoursRoot(root));

    assert.equal(refusalOf(removeDetour(root, key(STEP))), 'escaped-store');
    assert.equal(fs.readFileSync(path.join(planted, 'important.txt'), 'utf8'), 'keep me\n');
  });

  test('a symlink INSIDE the detour is unlinked, never followed out of the store', () => {
    // The other way a recursive delete escapes: not through the path it is given, but through
    // the tree it walks. `fs.rmSync` lstats each entry and unlinks a link rather than
    // descending into it — asserted here rather than assumed, because the whole directory being
    // deleted is model-authored content and this is the property that bounds the blast radius.
    const root = storage();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'important.txt'), 'keep me\n');
    const { dir } = wrote(writeDetourFiles(root, key(STEP), detour()));
    fs.symlinkSync(outside, path.join(dir, 'escape'));
    fs.symlinkSync(path.join(outside, 'important.txt'), path.join(dir, 'lib', 'escape-file'));

    const result = removeDetour(root, key(STEP));

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep me\n',
      'the recursive delete followed a symlink out of the detour');
  });

  test('a storage root that is itself a symlink still removes — the ordinary macOS case', () => {
    const box = tmpDir('detour-sandbox-');
    const real = path.join(box, 'real-storage');
    fs.mkdirSync(real);
    const root = path.join(box, 'storage');
    fs.symlinkSync(real, root);
    const { dir } = wrote(writeDetourFiles(root, key(STEP), detour()));
    assert.ok(fs.existsSync(dir));

    assert.equal(removeDetour(root, key(STEP)).removed, true);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readdirSync(path.join(real, 'detours')), [], 'the removal did not reach through the linked root');
  });

  test('a read-only detour directory reports `failed` rather than throwing', () => {
    // Not every refusal is about containment. A delete that cannot happen must still come back
    // as a value: this runs on the return path, where a throw would strand the learner in a
    // detour with no way out and no sentence explaining why.
    const root = storage();
    const { dir } = wrote(writeDetourFiles(root, key(STEP), detour()));
    const parent = detoursRoot(root);
    fs.chmodSync(parent, 0o500);
    try {
      const result = removeDetour(root, key(STEP));
      // Running as root defeats the permission bits entirely; the removal then simply succeeds
      // and there is nothing to assert about a failure that cannot be provoked.
      if (!result.removed) {
        assert.equal(result.reason, 'failed');
        assert.ok(result.detail.length > 0, 'a refusal came back with no sentence');
        assert.ok(fs.existsSync(dir));
      }
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });

  test('every refusal carries a sentence, and every reason is one of the declared ones', () => {
    // T-6's reviews both found "refused with no sentence" to be the failure mode that hides
    // bugs: a caller that can only see `false` cannot tell the learner anything, and a test
    // that only asserts `false` passes for the wrong reason.
    const empty = storage();
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP, 1), detour());
    const results: DetourRemoval[] = [
      removeDetour('relative', key(STEP)),                                       // bad-root
      removeDetour(empty, key(STEP)),                                            // no-store
      removeDetour(root, key(STEP)),                                             // absent
      removeDetourAt(root, os.tmpdir()),                                    // escaped
      removeDetourAt(root, detoursRoot(root)),                              // is-the-store-root
      removeDetourAt(root, path.dirname(detourCachePath(root, cacheKey(STEP, 1)))),   // not-a-detour
    ];
    fs.writeFileSync(detourDir(root, key(STEP)), 'x');
    results.push(removeDetour(root, key(STEP)));                                 // not-a-directory

    const reasons = new Set<string>();
    for (const result of results) {
      assert.equal(result.removed, false);
      if (result.removed) continue;
      assert.ok(result.detail.length > 0, `${result.reason} came back with no sentence`);
      assert.ok(result.detail.length <= 400, `${result.reason}'s sentence is unbounded`);
      reasons.add(result.reason);
    }
    // Seven of the nine declared reasons, each produced by a real filesystem. The other two
    // have suites of their own above: `escaped-store` (a planted store link) and `failed` (a
    // directory the process may not write into).
    assert.deepEqual([...reasons].sort(), [
      'absent', 'bad-root', 'escaped', 'is-the-store-root', 'no-store', 'not-a-detour', 'not-a-directory',
    ]);
  });

  test('a hostile step id cannot aim the delete anywhere but at its own hash', () => {
    // The end-to-end statement of the reason `detourDir` hashes: whatever `plan.json` says the
    // step is called, the only thing `removeDetour` can ever be pointed at is one 32-hex
    // directory directly under the store.
    const root = storage();
    const victimDir = tmpDir('detour-victim-');
    fs.writeFileSync(path.join(victimDir, 'important.txt'), 'keep me\n');
    fs.mkdirSync(detoursRoot(root), { recursive: true });

    for (const id of ['..', '../..', `../../${path.basename(victimDir)}`, '/', victimDir, '.']) {
      const result = removeDetour(root, key(id));
      assert.equal(result.removed, false, `step id ${JSON.stringify(id)} removed something`);
      assert.equal(refusalOf(result), 'absent', `step id ${JSON.stringify(id)} was refused for the wrong reason`);
    }
    assert.equal(fs.readFileSync(path.join(victimDir, 'important.txt'), 'utf8'), 'keep me\n');
    assert.ok(fs.existsSync(os.tmpdir()));
  });
});

// ── the key: two tutorials, one global store ────────────────────────────────────────────────

/**
 * **T-7 code review findings 1 and 2, and the lesson they left.**
 *
 *   > An identifier is only a key inside the space it was minted for. Moving state into a
 *   > global store requires re-deriving every key in it.
 *
 * repo-tour mints a step id as `sha256(file + ' ' + kind + ' ' + symbolName)` — no repository in
 * it at all — and T-7 moved per-step state from the learner's own `.repo-tour/` into
 * `globalStorageUri`, which is one directory for every tutorial this extension will ever open.
 * Two projects with a `src/index.ts` therefore shared a detour directory and a cache entry by
 * construction, and the suite could not see it because every test drove one tutorial.
 *
 * So every test below is **two inputs that share a key**, which is the shape this class of bug
 * needs. A suite that only ever passes one `tutorial` would pass with the old code.
 */
suite('the key — two tutorials in one global store do not collide', () => {

  test('the same step id in two tutorials is two directories and two cache entries', () => {
    const root = storage();

    assert.notEqual(
      detourDir(root, key(STEP)),
      detourDir(root, key(STEP, OTHER_TUTORIAL)),
      'two tutorials shared one detour directory — one tutorial’s return deletes the other’s open tabs',
    );
    assert.notEqual(
      detourCachePath(root, cacheKey(STEP)),
      detourCachePath(root, cacheKey(STEP, 1, 'THE PROMPT', OTHER_TUTORIAL)),
      'two tutorials shared one cache entry — one repository’s worked example served as another’s',
    );
  });

  test('one tutorial’s remove leaves the other’s detour standing', () => {
    // Driven in the review as a live session losing its files: a session being disposed awaited
    // `closeTabsUnder`, and deleted whatever was at the path when the await returned.
    const root = storage();
    const mine = wrote(writeDetourFiles(root, key(STEP), detour()));
    const theirs = wrote(writeDetourFiles(root, key(STEP, OTHER_TUTORIAL), detour()));
    assert.notEqual(mine.dir, theirs.dir);

    assert.equal(removeDetour(root, key(STEP)).removed, true);

    assert.equal(fs.existsSync(mine.dir), false, 'the one that was asked for is gone');
    assert.deepEqual(treeFiles(theirs.dir), ['lib/change.ts', 'machine.ts'],
      'and the other tutorial’s live detour is untouched');
  });

  test('a cache entry answers only for the tutorial that wrote it', () => {
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP), detour({ title: 'A’s example' }));

    assert.equal(readCachedDetour(root, cacheKey(STEP))?.title, 'A’s example', 'its own tutorial hits');
    assert.equal(
      readCachedDetour(root, cacheKey(STEP, 1, 'THE PROMPT', OTHER_TUTORIAL)),
      null,
      'another tutorial was served this tutorial’s example, free and unannounced',
    );
  });

  test('the cache key is the PROMPT — a plan rebuilt with a new question is a miss (finding 9)', () => {
    // The half a key alone cannot fix. `DETOUR_PROMPT_VERSION` is a source constant, so before
    // this a plan regenerated with a different `decision.question` served yesterday's example
    // forever and nothing a learner could press changed that.
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP, 1, 'ask about parsing'), detour({ title: 'about parsing' }));

    assert.equal(readCachedDetour(root, cacheKey(STEP, 1, 'ask about parsing'))?.title, 'about parsing');
    assert.equal(readCachedDetour(root, cacheKey(STEP, 1, 'ask about something else entirely')), null,
      'a changed question was answered out of the cache');
  });

  test('tutorialId separates by target folder AND by the plan’s source commit', () => {
    // Both halves, because each covers a case the other does not: the folder separates two
    // tutorials open at once, the commit separates one folder rebuilt against a newer reference.
    const planA = { source: { head: 'aaaaaaaa' } };
    const planB = { source: { head: 'bbbbbbbb' } };

    assert.notEqual(tutorialId('/one/project', planA), tutorialId('/another/project', planA),
      'two folders on one machine shared a tutorial identity');
    assert.notEqual(tutorialId('/one/project', planA), tutorialId('/one/project', planB),
      'a plan rebuilt against a new reference commit kept the old identity');
    assert.equal(tutorialId('/one/project', planA), tutorialId('/one/project', planA),
      'and it is stable — a key that moved between calls would orphan every detour');
    assert.equal(tutorialId('/one/project/', planA), tutorialId('/one/project', planA),
      'a trailing separator is the same folder');
  });

  test('tutorialId is total — a plan with no source, and no target at all, still key', () => {
    // It runs on the path where a learner pressed a button. A plan that arrived without a
    // `source` is an ordinary shape, not an error, and a throw here would be a dead button.
    for (const [target, plan] of [
      [undefined, undefined], ['/p', undefined], [undefined, { source: { head: 'x' } }],
      ['/p', {}], ['/p', { source: 'not an object' }], ['/p', { source: { head: 42 } }], ['', {}],
    ] as Array<[unknown, unknown]>) {
      assert.match(tutorialId(target, plan), /^[0-9a-f]{32}$/, `tutorialId(${String(target)}) should still be a name`);
    }
  });
});

// ── the cache is bounded, because the page says it is not forever ───────────────────────────

/**
 * **T-7 security review finding 3.** Nothing pruned `detours/cache/`: `removeDetourAt` refuses
 * it by name (correctly), `dispose()` does not touch it, and no other code referenced it — so
 * model-written file contents survived *Back to my build*, the window closing and everything
 * else, at up to `MAX_CACHE_BYTES` per step of every plan, while the narrator said on screen
 * that going back deletes them.
 *
 * Both halves were fixed, and both are pinned: the sentence is honest now
 * (`detour-narrator.test.ts`) and the copy is bounded here.
 */
suite('pruneDetourCache — the copy the narrator promises is bounded', () => {

  test('writing past the ceiling keeps the ceiling, and keeps what was just paid for', () => {
    const root = storage();
    const written: string[] = [];
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i += 1) {
      // A distinct prompt per entry is a distinct key, which is what a plan of many steps is.
      assert.equal(writeCachedDetour(root, cacheKey(`st-${i}`, 1, `prompt ${i}`), detour({ title: `d${i}` })), true);
      written.push(detourCachePath(root, cacheKey(`st-${i}`, 1, `prompt ${i}`)));
    }

    const cacheDir = path.join(detoursRoot(root), 'cache');
    assert.equal(fs.readdirSync(cacheDir).length, MAX_CACHE_ENTRIES,
      'the cache grew past its stated ceiling — the aside on the narrator is a promise again');
    // The one guarantee a learner can feel: the answer they just paid for is still there, and
    // is still theirs, whatever the filesystem thinks a timestamp is.
    const last = written[written.length - 1] ?? '';
    assert.ok(fs.existsSync(last), 'the entry just written was evicted by its own write');
    assert.equal(readCachedDetour(root, cacheKey(`st-${MAX_CACHE_ENTRIES + 4}`, 1, `prompt ${MAX_CACHE_ENTRIES + 4}`))?.title,
      `d${MAX_CACHE_ENTRIES + 4}`, 'and it still reads back — AC5 holds across the sweep');
  });

  test('eviction is oldest-first', () => {
    // Driven with the timestamps set by hand, because `mtime` resolution is a filesystem's
    // business and this property is not about the clock.
    const root = storage();
    const files: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      writeCachedDetour(root, cacheKey(`st-${i}`, 1, `prompt ${i}`), detour({ title: `d${i}` }));
      const file = detourCachePath(root, cacheKey(`st-${i}`, 1, `prompt ${i}`));
      const when = new Date(Date.now() + i * 2000);
      fs.utimesSync(file, when, when);
      files.push(file);
    }

    assert.equal(pruneDetourCache(root, 2), 3);

    assert.deepEqual(files.map((f) => fs.existsSync(f)), [false, false, false, true, true],
      'the sweep took the newest rather than the oldest');
  });

  test('it removes only 32-hex .json REGULAR files — never a symlink, never anything else', () => {
    // `removeDetourAt`'s allow-list, for the cache: a sweep that deleted what it did not
    // recognise would be a recursive delete with a wildcard in it.
    const root = storage();
    writeCachedDetour(root, cacheKey(STEP), detour());
    const cacheDir = path.join(detoursRoot(root), 'cache');
    const outside = path.join(root, 'precious.txt');
    fs.writeFileSync(outside, 'keep me\n');
    fs.writeFileSync(path.join(cacheDir, 'notes.md'), 'somebody else’s file\n');
    fs.symlinkSync(outside, path.join(cacheDir, 'ffffffffffffffffffffffffffffffff.json'));

    const removed = pruneDetourCache(root, 0);

    assert.equal(removed, 1, 'exactly the one real entry went');
    assert.ok(fs.existsSync(path.join(cacheDir, 'notes.md')), 'a file it did not write was deleted');
    assert.ok(fs.existsSync(path.join(cacheDir, 'ffffffffffffffffffffffffffffffff.json')), 'a symlink was followed or unlinked');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n', 'and the thing it pointed at was touched');
  });

  test('it never throws — no store, no cache folder, a bad root', () => {
    // It runs on the path where a learner pressed a button; a cache that cannot be tidied is
    // not a detour that failed.
    assert.equal(pruneDetourCache(storage()), 0, 'a store with no cache folder yet');
    assert.equal(pruneDetourCache('relative'), 0, 'a root that is not absolute');
    assert.equal(pruneDetourCache(path.join(storage(), 'nope')), 0, 'a root that is not there');
  });

  test('a detour’s own directory is never in reach of the sweep', () => {
    const root = storage();
    const { dir } = wrote(writeDetourFiles(root, key(STEP), detour()));
    writeCachedDetour(root, cacheKey(STEP), detour());

    pruneDetourCache(root, 0);

    assert.deepEqual(treeFiles(dir), ['lib/change.ts', 'machine.ts'], 'the sweep reached a live detour');
  });
});

// ── the cache is a SECOND door, and it gets the same bounds as the first ────────────────────

/**
 * **T-7 security review finding 2, and code review finding 7.**
 *
 * `store.ts`'s header said, and had said since it was written, that *"the cache is a SECOND
 * door into the same data and gets the same bounds as the first"*. It got the same COUNT
 * bounds. It did not get the path bound — the one this whole ticket exists for — nor the
 * stop-range bound, nor the parser's handling of a lone `\r`, nor its case-folded duplicate
 * rule. A hand-edited `cache/<hash>.json`, or one written by a future version of this extension
 * with a looser parser, produced a `Detour` whose `files[].path` was `../../…` and it went
 * straight to the writer without ever meeting `parseDetourReply`.
 *
 * Nothing escaped, because `prepareDetourWrite` re-runs the lexical half at the write. But the
 * whole defence rested on one function while this module's header read as though two
 * independent doors were each checking, and:
 *
 *   > If a validator's header says "the same bounds as the first", the bounds it means have to
 *   > be a value both of them IMPORT — not a property both of them are supposed to have
 *   > implemented.
 *
 * So the rules are `unsafeDetourPathReason` and `detourLineCount` from `./prompt.ts`, and the
 * tests below are the parser's own cases pointed at this door. Each one is CONFIRMED-accepted
 * text from the review.
 */
suite('sanitizeDetour — the same bounds as the parser, because they are the same functions', () => {
  /** A detour whose one file sits at `where`, otherwise well-formed. */
  function at(where: string): Record<string, unknown> {
    return {
      title: 'x',
      domain: 'y',
      files: [{ path: where, content: 'export const A = 1;\n' }],
      stops: [
        { file: where, startLine: 1, endLine: 1, text: 'a' },
        { file: where, startLine: 1, endLine: 1, text: 'b' },
        { file: where, startLine: 1, endLine: 1, text: 'c' },
      ],
    };
  }

  test('a relative escape and an absolute path are both refused — the path bound (security 2)', () => {
    // Both of these were driven through the real session off a poisoned cache file and were
    // ACCEPTED here, then caught downstream. Caught here now, at the door.
    assert.equal(sanitizeDetour(at('../../../../../../../tmp/pwned.ts')), null);
    assert.equal(sanitizeDetour(at('/tmp/T7-PWNED-ABS.txt')), null);
    assert.equal(sanitizeDetour(at('a/../../b.ts')), null);
    assert.equal(sanitizeDetour(at('C:\\evil.ts')), null);
    assert.equal(sanitizeDetour(at('.ssh/authorized_keys')), null);
    assert.equal(sanitizeDetour(at('con.ts')), null);
    assert.notEqual(sanitizeDetour(at('lib/coins.ts')), null, 'and an honest path still reads back');
  });

  test('a stop whose range runs past its file is refused — the stop-range bound (code 7)', () => {
    // `{startLine: 1, endLine: 9007199254740991}` over a two-line file survived a full
    // write→read round trip here while `parseDetourReply` refused it by name, and the narrator
    // drew `lines 1–9007199254740991` off the back of it.
    const two = {
      title: 'x',
      domain: 'y',
      files: [{ path: 'a.ts', content: 'one\ntwo\n' }],
      stops: [
        { file: 'a.ts', startLine: 1, endLine: Number.MAX_SAFE_INTEGER, text: 'a' },
        { file: 'a.ts', startLine: 1, endLine: 1, text: 'b' },
        { file: 'a.ts', startLine: 1, endLine: 1, text: 'c' },
      ],
    };
    assert.equal(sanitizeDetour(two), null);
    assert.notEqual(sanitizeDetour({ ...two, stops: two.stops.map((s) => ({ ...s, endLine: 2 })) }), null,
      'and a range that fits still reads back');
  });

  test('a lone CR ends a line here too — the line count is one function (security 4)', () => {
    // Measured: 200 lines separated by lone CRs were `file-too-long` to the parser and perfectly
    // acceptable to the cache, because one normalised `\r` and the other split on `\n` alone.
    const long = 'x\r'.repeat(DETOUR_LIMITS.maxLinesPerFile + 140);
    assert.equal(sanitizeDetour({
      title: 'x',
      domain: 'y',
      files: [{ path: 'a.ts', content: long }],
      stops: [
        { file: 'a.ts', startLine: 1, endLine: 1, text: 'a' },
        { file: 'a.ts', startLine: 1, endLine: 1, text: 'b' },
        { file: 'a.ts', startLine: 1, endLine: 1, text: 'c' },
      ],
    }), null, 'a lone-CR file walked past the ≤ 60-line bound the spec sets');
  });

  test('two paths differing only in case are refused — one filesystem in three would merge them', () => {
    // The parser's rule, with a comment explaining exactly this; the cache refused only exact
    // duplicates, so a cached `Coins.ts`/`coins.ts` pair was one tab holding whichever content
    // won the race to be written.
    assert.equal(sanitizeDetour({
      title: 'x',
      domain: 'y',
      files: [
        { path: 'Coins.ts', content: 'export const A = 1;\n' },
        { path: 'coins.ts', content: 'export const B = 2;\n' },
      ],
      stops: [
        { file: 'Coins.ts', startLine: 1, endLine: 1, text: 'a' },
        { file: 'coins.ts', startLine: 1, endLine: 1, text: 'b' },
        { file: 'Coins.ts', startLine: 1, endLine: 1, text: 'c' },
      ],
    }), null);
  });

  test('everything the PARSER accepts, this still accepts — or the cache never hits', () => {
    // The direction that matters for AC5, and it is why the rules above were imported rather
    // than re-implemented one notch tighter. `writeCachedDetour` sanitises on the way OUT, so a
    // rule stricter here than in the parser would make every write refuse silently, the cache
    // never hit, and "a second run makes no LLM call" fail with every test green.
    const root = storage();
    const good = detour();
    assert.equal(writeCachedDetour(root, cacheKey(STEP), good), true, 'a well-formed detour is cacheable');
    assert.deepEqual(readCachedDetour(root, cacheKey(STEP)), good, 'and reads back unchanged');

    // The exact edges the parser allows: a file at the line limit, and a stop on its last line.
    const atLimit = detour({
      files: [{ path: 'edge.ts', content: 'x\n'.repeat(DETOUR_LIMITS.maxLinesPerFile) }],
      stops: [
        { file: 'edge.ts', startLine: 1, endLine: DETOUR_LIMITS.maxLinesPerFile, text: 'a' },
        { file: 'edge.ts', startLine: DETOUR_LIMITS.maxLinesPerFile, endLine: DETOUR_LIMITS.maxLinesPerFile, text: 'b' },
        { file: 'edge.ts', startLine: 1, endLine: 1, text: 'c' },
      ],
    });
    assert.notEqual(sanitizeDetour(atLimit), null, 'a detour exactly at the limits became uncacheable');
  });
});

// ── one writer, and the assertion that a second one cannot appear quietly ────────────────────

/**
 * **T-7 code review finding 8, and security review findings 1 and 5.**
 *
 * `writeDetourFiles` shipped exported, with most of this file's suite behind it — including
 * the test that plants `detours -> /elsewhere` and asserts the far end stays empty — and **no
 * caller in `src/`**. The code that actually ran was a second writer in `session.ts` which
 * handed `writeTextAtomic` the COMPOSED detour directory instead of the proven store, and the
 * security reviewer swapped a symlink in between the check and the write and watched the file
 * land outside with nothing thrown.
 *
 *   > **The store's 972-line suite proved the "root must be the proven store" property against
 *   > the function nothing called.** A paragraph in the right file about the wrong function is
 *   > a defence that documents itself into a place the code never goes.
 *
 * The behavioural half of the fix is pinned by every write test above, which now runs against
 * the function `DetourSession` really calls. This is the OTHER half — the one that catches a
 * second writer appearing again — and it is a source-level scan, which is a weaker instrument
 * and is used here for the same reason `detour-narrator.test.ts` scans its own client script:
 * the property is "no other module does this", and no behavioural test can say "no other".
 *
 * **What it cannot prove**, stated rather than implied: it reads two files by path, so a third
 * module that started writing detour files would be invisible to it. It is a guard against the
 * regression that actually happened, not a proof of the general claim.
 */
suite('the ONE writer — no second write path in the detour', () => {
  function sourceOf(rel: string): string {
    const abs = path.join(process.cwd(), rel);
    assert.ok(fs.existsSync(abs), `${rel} should be readable from the repository root, not ${process.cwd()}`);
    return fs.readFileSync(abs, 'utf8');
  }

  /** Comments stripped, so a sentence ABOUT a sink is not mistaken for the sink — the same
   *  care `detour-narrator.test.ts` takes with `innerHTML`, and for the same reason: a scan
   *  that cannot tell those apart teaches the next reader to delete the explanation. */
  function code(source: string): string {
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(stripped.length < source.length, 'the comment strip did not run');
    return stripped;
  }

  test('src/detour/session.ts writes nothing itself — it routes through the store', () => {
    const session = code(sourceOf('src/detour/session.ts'));
    for (const sink of ['writeTextAtomic', 'writeFileSync', 'mkdirSync', 'renameSync']) {
      assert.ok(
        !session.includes(sink),
        `src/detour/session.ts calls \`${sink}\` — that is a second write path, and the last one `
        + 'disagreed with `store.ts` about which root contains a write. Route it through `writeDetourFiles`.',
      );
    }
  });

  test('the store\'s writer is the one the session calls, and it is called', () => {
    const session = code(sourceOf('src/detour/session.ts'));
    assert.ok(session.includes('writeDetourFiles('), 'the session does not call the store\'s writer at all');
    // The counterpart of the finding: an exported writer with no caller in `src/` is what let
    // the disagreement ship. If this ever fails, one of the two has been orphaned again.
    assert.ok(code(sourceOf('src/detour/store.ts')).includes('export function writeDetourFiles('),
      'the writer has moved or been renamed — check that the caller moved with it');
  });

  test('and it hands writeTextAtomic the PROVEN store, never the composed detour directory', () => {
    // Security finding 1, as a line of source rather than as a race. The behavioural half —
    // that a planted link is refused — is driven above; this catches the one-token edit that
    // reopens it, which is the edit that shipped.
    const store = code(sourceOf('src/detour/store.ts'));
    const call = /writeTextAtomic\(target, file\.content, ([A-Za-z.]+)\)/.exec(store);
    assert.ok(call, 'the detour write no longer looks like `writeTextAtomic(target, file.content, <root>)`');
    assert.equal(call?.[1], 'proof.store',
      'the containment root is not the proven store — a planted `detours/<hash> -> /outside` would '
      + 'make the attacker\'s folder the root of the containment question and every write "contained" in it',
    );
  });
});
