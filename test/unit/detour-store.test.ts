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
  detourCachePath, detourDir, detoursRoot, MAX_CACHE_BYTES, readCachedDetour, removeDetour,
  removeDetourAt, sanitizeDetour, writeCachedDetour, writeDetourFiles,
  type DetourRemoval,
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
    const dir = detourDir(root, STEP);

    assert.equal(path.dirname(dir), detoursRoot(root));
    assert.equal(detoursRoot(root), path.join(root, 'detours'));
    assert.match(path.basename(dir), /^[0-9a-f]{32}$/);
  });

  test('the same step id always gives the same directory — a retake finds its own files', () => {
    const root = storage();
    assert.equal(detourDir(root, STEP), detourDir(root, STEP));
  });

  test('asking creates nothing — detourDir is a pure function of its two arguments', () => {
    const root = storage();
    detourDir(root, STEP);
    detourCachePath(root, STEP, 1);

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
      const dir = detourDir(root, id);
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
      assert.notEqual(detourDir(root, left), detourDir(root, right),
        `${JSON.stringify(left)} and ${JSON.stringify(right)} share a detour directory`);
    }
  });

  test('the cache lives beside the detours, never inside one', () => {
    const root = storage();
    const cache = detourCachePath(root, STEP, 1);

    assert.equal(path.dirname(cache), path.join(detoursRoot(root), 'cache'));
    assert.match(path.basename(cache), /^[0-9a-f]{32}\.json$/);
    assert.equal(cache.startsWith(detourDir(root, STEP)), false);
  });
});

// ── writing a detour ────────────────────────────────────────────────────────────────────────

suite('writeDetourFiles — the bytes land in global storage and nowhere else (AC2)', () => {
  test('round trip: every file, its exact bytes, in order, with no problems', () => {
    const root = storage();
    const d = detour();

    const result = writeDetourFiles(root, STEP, d);

    assert.deepEqual(result.problems, []);
    assert.equal(result.dir, detourDir(root, STEP));
    assert.deepEqual(result.written, [
      path.join(result.dir, 'machine.ts'),
      path.join(result.dir, 'lib', 'change.ts'),
    ]);
    for (const file of d.files) {
      assert.equal(fs.readFileSync(path.join(result.dir, file.path), 'utf8'), file.content);
    }
  });

  test('nested paths get their parent directories made for them', () => {
    const root = storage();
    const result = writeDetourFiles(root, STEP, detour({
      files: [{ path: 'a/b/c/deep.ts', content: 'export const D = 4;\n' }],
      stops: detour().stops.map((s) => ({ ...s, file: 'a/b/c/deep.ts' })),
    }));

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

    writeDetourFiles(store, STEP, detour());
    writeCachedDetour(store, STEP, 1, detour());
    readCachedDetour(store, STEP, 1);
    removeDetour(store, STEP);

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

    const result = writeDetourFiles(root, STEP, detour({
      files: [
        { path: '../../stolen.ts', content: 'pwned\n' },
        { path: '/etc/passwd', content: 'pwned\n' },
        { path: 'ok.ts', content: 'export const OK = 1;\n' },
      ],
      stops: detour().stops.map((s) => ({ ...s, file: 'ok.ts' })),
    }));

    assert.equal(result.problems.length, 2, `expected two refusals, got ${JSON.stringify(result.problems)}`);
    for (const problem of result.problems) assert.match(problem, /refused/);
    assert.equal(fs.readFileSync(outsideName, 'utf8'), 'someone else’s file\n');
    // Not all-or-nothing: the good file beside the bad one is still written, the way
    // `reproduceFiles` reports one entry without dropping the rest.
    assert.deepEqual(result.written, [path.join(result.dir, 'ok.ts')]);
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
    const dir = detourDir(root, STEP);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'machine.ts');
    fs.symlinkSync(outside, dest);

    const result = writeDetourFiles(root, STEP, detour({
      files: [{ path: 'machine.ts', content: 'export const COINS = [25];\n' }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 1 })),
    }));

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
    const dir = detourDir(root, STEP);
    fs.mkdirSync(detoursRoot(root), { recursive: true });
    fs.symlinkSync(outside, dir);

    const result = writeDetourFiles(root, STEP, detour());

    assert.ok(result.problems.length > 0, 'a detour wrote through a symlinked directory');
    assert.deepEqual(result.written, []);
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

    const result = writeDetourFiles(root, STEP, detour());

    assert.ok(result.problems.length > 0, 'a detour wrote through a symlinked store root');
    assert.deepEqual(result.written, []);
    assert.deepEqual(fs.readdirSync(outside), [], 'files landed through the planted store link');
  });

  test('a stale file from a previous detour does not survive into the new one', () => {
    // A crashed session leaves its files behind. Writing over them file-by-file would leave the
    // leftovers in place, and step 4 opens *the directory's* files as tabs — so the learner
    // would get a tab from a detour they never asked for, and `stops` would not match it.
    const root = storage();
    writeDetourFiles(root, STEP, detour({
      files: [{ path: 'stale.ts', content: 'export const OLD = 1;\n' }],
      stops: detour().stops.map((s) => ({ ...s, file: 'stale.ts', startLine: 1, endLine: 1 })),
    }));

    const result = writeDetourFiles(root, STEP, detour());

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

    const result = writeDetourFiles(root, STEP, detour());

    assert.deepEqual(result.problems, []);
    assert.equal(fs.readFileSync(path.join(real, 'detours', path.basename(result.dir), 'machine.ts'), 'utf8'),
      'export const COINS = [25, 10, 5, 1];\n');
  });

  test('a relative storage root is refused rather than resolved against the cwd', () => {
    const result = writeDetourFiles('detours-relative', STEP, detour());

    assert.ok(result.problems.length > 0);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'detours-relative')), false,
      'a relative storage root created a directory in the cwd');
  });

  test('no .tmp file is left behind — the write is temp-plus-rename', () => {
    const root = storage();
    const result = writeDetourFiles(root, STEP, detour());

    assert.deepEqual(treeFiles(result.dir).filter((f) => f.includes('.tmp')), []);
  });
});

// ── the cache (AC5) ─────────────────────────────────────────────────────────────────────────

suite('the cache — a retake is free, and a hand-edited entry is a MISS (AC5)', () => {
  test('write then read gives back an equal detour', () => {
    const root = storage();
    const d = detour();

    assert.equal(writeCachedDetour(root, STEP, 1, d), true);
    assert.deepEqual(readCachedDetour(root, STEP, 1), d);
    assert.ok(fs.existsSync(detourCachePath(root, STEP, 1)));
  });

  test('the key is the step id AND the prompt version — either one changing is a miss', () => {
    const root = storage();
    writeCachedDetour(root, STEP, 1, detour());

    assert.notEqual(readCachedDetour(root, STEP, 1), null, 'the same key must hit');
    assert.equal(readCachedDetour(root, STEP, 2), null, 'a new prompt version served a stale detour');
    assert.equal(readCachedDetour(root, 'st-9-other', 1), null, 'another step served this step’s detour');
    assert.notEqual(detourCachePath(root, STEP, 1), detourCachePath(root, STEP, 2));
  });

  test('two versions of one step coexist — bumping the version does not destroy the old entry', () => {
    const root = storage();
    writeCachedDetour(root, STEP, 1, detour({ title: 'v1' }));
    writeCachedDetour(root, STEP, 2, detour({ title: 'v2' }));

    assert.equal(readCachedDetour(root, STEP, 1)?.title, 'v1');
    assert.equal(readCachedDetour(root, STEP, 2)?.title, 'v2');
  });

  test('a missing entry is a miss, not a throw', () => {
    assert.equal(readCachedDetour(storage(), STEP, 1), null);
  });

  test('an unparseable entry is a miss, not a throw', () => {
    const root = storage();
    const file = detourCachePath(root, STEP, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');

    assert.equal(readCachedDetour(root, STEP, 1), null);
  });

  test('an entry that is a SYMLINK is a miss — a cache read never follows a planted link', () => {
    // `<hash>.json -> /home/you/.ssh/id_rsa` would be read, parsed (or not) and, if it happened
    // to be JSON of the right shape, written back out as a detour's files. Cheaper to refuse
    // anything that is not a regular file than to reason about what could be on the other end.
    const root = storage();
    const outside = path.join(root, 'secret.json');
    fs.writeFileSync(outside, JSON.stringify(detour()));
    const file = detourCachePath(root, STEP, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(outside, file);

    assert.equal(readCachedDetour(root, STEP, 1), null);
  });

  test('an entry through a symlinked store root is a miss, and a write there is refused', () => {
    const root = storage();
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, detoursRoot(root));

    assert.equal(writeCachedDetour(root, STEP, 1, detour()), false);
    assert.equal(readCachedDetour(root, STEP, 1), null);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('an oversized entry is a miss on its SIZE, before it is parsed', () => {
    // T-6's security review, finding 4, in a new place: a count is not a size. `DETOUR_LIMITS`
    // bounds how many files and how many LINES; nothing in it bounds how long a line is, so a
    // hand-edited entry can be arbitrarily large and still shaped exactly right.
    const root = storage();
    const file = detourCachePath(root, STEP, 1);
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

    assert.equal(readCachedDetour(root, STEP, 1), null);
  });

  test('a legitimately large entry, just under the ceiling, still hits', () => {
    // The other direction: the ceiling must be above anything the limits actually permit, or
    // the cache would silently never hit and AC5 would fail with every test green.
    const root = storage();
    const big = detour({
      files: [{ path: 'machine.ts', content: `${'x'.repeat(300)}\n`.repeat(DETOUR_LIMITS.maxLinesPerFile) }],
      stops: detour().stops.map((s) => ({ ...s, file: 'machine.ts', startLine: 1, endLine: 10 })),
    });

    assert.equal(writeCachedDetour(root, STEP, 1, big), true);
    assert.deepEqual(readCachedDetour(root, STEP, 1), big);
  });

  test('the cache write is atomic and leaves no .tmp behind', () => {
    const root = storage();
    writeCachedDetour(root, STEP, 1, detour());

    assert.deepEqual(fs.readdirSync(path.join(detoursRoot(root), 'cache')).filter((f) => f.includes('.tmp')), []);
  });

  test('a cache hit does not resurrect a deleted detour directory', () => {
    // AC3 says the directory is gone; AC5 says the retake is free. Both, at once: the cache
    // holds the ANSWER, not the files, so a hit after a return still has to write them again.
    const root = storage();
    writeDetourFiles(root, STEP, detour());
    writeCachedDetour(root, STEP, 1, detour());
    removeDetour(root, STEP);

    assert.equal(fs.existsSync(detourDir(root, STEP)), false);
    assert.notEqual(readCachedDetour(root, STEP, 1), null, 'the return deleted the cache along with the files');
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
    const file = detourCachePath(root, STEP, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...detour(), files: [{ path: '../../../etc/passwd', content: 'x' }] }));

    // A path this module would refuse to write is still a well-SHAPED entry, so it comes back
    // — and the refusal that matters happens at the write, which the suite above pins. What
    // must not happen is a crash on the read path.
    const back = readCachedDetour(root, STEP, 1);
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
    const { dir } = writeDetourFiles(root, STEP, detour());
    assert.ok(fs.existsSync(path.join(dir, 'lib', 'change.ts')));

    const result = removeDetour(root, STEP);

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(dir), false);
  });

  test('it deletes EXACTLY one detour — a sibling step and the cache both survive', () => {
    const root = storage();
    writeDetourFiles(root, STEP, detour());
    const other = writeDetourFiles(root, 'st-9-other', detour()).dir;
    writeCachedDetour(root, STEP, 1, detour());

    removeDetour(root, STEP);

    assert.equal(fs.existsSync(detourDir(root, STEP)), false);
    assert.ok(fs.existsSync(other), 'removing one detour took another step’s with it');
    assert.ok(fs.existsSync(detourCachePath(root, STEP, 1)), 'the return deleted the cache');
    assert.ok(fs.existsSync(detoursRoot(root)), 'the return deleted the whole store');
  });

  test('an absent detour is `absent`, not a throw and not a failure to report', () => {
    const root = storage();
    // A store with another step's detour in it, so "absent" is about THIS step rather than
    // about a machine that has never taken a detour — those are different answers below.
    writeDetourFiles(root, 'st-9-other', detour());

    const result = removeDetour(root, STEP);

    assert.equal(refusalOf(result), 'absent');
  });

  test('it is idempotent — the second return is `absent`, not an error', () => {
    const root = storage();
    writeDetourFiles(root, STEP, detour());

    assert.equal(removeDetour(root, STEP).removed, true);
    assert.equal(refusalOf(removeDetour(root, STEP)), 'absent');
  });

  test('no store at all is `no-store`, and nothing is created by asking', () => {
    const root = storage();

    assert.equal(refusalOf(removeDetour(root, STEP)), 'no-store');
    assert.deepEqual(fs.readdirSync(root), [], 'a refused removal created the store it was looking for');
  });

  test('a relative storage root is `bad-root` — never resolved against the cwd', () => {
    assert.equal(refusalOf(removeDetour('detours-relative', STEP)), 'bad-root');
    assert.equal(refusalOf(removeDetour('', STEP)), 'bad-root');
    assert.equal(refusalOf(removeDetourAt('relative/root', '/tmp')), 'bad-root');
  });

  test('the store root ITSELF is refused — `<globalStorageRoot>/detours` is never the target', () => {
    // Unreachable through `removeDetour`, because a 32-hex segment is never the empty string.
    // Driven through `removeDetourAt` for exactly that reason: a guard nothing can reach is a
    // guard nothing can test, and this is the one whose failure deletes every detour at once.
    const root = storage();
    writeDetourFiles(root, STEP, detour());

    assert.equal(refusalOf(removeDetourAt(root, detoursRoot(root))), 'is-the-store-root');
    assert.equal(refusalOf(removeDetourAt(root, `${detoursRoot(root)}${path.sep}`)), 'is-the-store-root');
    assert.equal(refusalOf(removeDetourAt(root, path.join(detoursRoot(root), '.'))), 'is-the-store-root');
    assert.ok(fs.existsSync(detourDir(root, STEP)), 'the store root was deleted with its contents');
  });

  test('the filesystem root, the storage root and the home directory are all refused', () => {
    // The argument the brief asks for: write the refusal you would want if the argument were
    // `/`. None of these is reachable from a hashed step id either; all three are one bad
    // caller away, and the reason each is refused is that it does not resolve UNDER the store.
    const root = storage();
    writeDetourFiles(root, STEP, detour());
    const targets = [path.parse(process.cwd()).root, root, os.homedir(), os.tmpdir()];

    for (const target of targets) {
      assert.equal(refusalOf(removeDetourAt(root, target)), 'escaped', `${target} was not refused`);
      assert.ok(fs.existsSync(target), `${target} was deleted`);
    }
    assert.ok(fs.existsSync(detourDir(root, STEP)));
  });

  test('a path outside the store is `escaped`, and the victim survives', () => {
    const root = storage();
    writeDetourFiles(root, STEP, detour());
    const victimDir = tmpDir('detour-victim-');
    fs.writeFileSync(path.join(victimDir, 'important.txt'), 'keep me\n');

    assert.equal(refusalOf(removeDetourAt(root, victimDir)), 'escaped');
    assert.equal(fs.readFileSync(path.join(victimDir, 'important.txt'), 'utf8'), 'keep me\n');
  });

  test('a path built out of the store with `..` is `escaped`', () => {
    const root = storage();
    writeDetourFiles(root, STEP, detour());
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
    writeCachedDetour(root, STEP, 1, detour());
    const cacheDir = path.dirname(detourCachePath(root, STEP, 1));

    assert.equal(refusalOf(removeDetourAt(root, cacheDir)), 'not-a-detour');
    assert.ok(fs.existsSync(detourCachePath(root, STEP, 1)));
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
    const dir = detourDir(root, STEP);
    fs.symlinkSync(outside, dir);

    assert.equal(refusalOf(removeDetour(root, STEP)), 'not-a-directory');
    assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep me\n');
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), true, 'a refused removal still unlinked the planted link');
  });

  test('a regular FILE where the detour directory should be is `not-a-directory`', () => {
    const root = storage();
    fs.mkdirSync(detoursRoot(root), { recursive: true });
    fs.writeFileSync(detourDir(root, STEP), 'not a directory\n');

    assert.equal(refusalOf(removeDetour(root, STEP)), 'not-a-directory');
    assert.ok(fs.existsSync(detourDir(root, STEP)));
  });

  test('a SYMLINKED STORE ROOT is `escaped-store`, and nothing under it is touched', () => {
    const root = storage();
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    const planted = path.join(outside, path.basename(detourDir(root, STEP)));
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, 'important.txt'), 'keep me\n');
    fs.symlinkSync(outside, detoursRoot(root));

    assert.equal(refusalOf(removeDetour(root, STEP)), 'escaped-store');
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
    const { dir } = writeDetourFiles(root, STEP, detour());
    fs.symlinkSync(outside, path.join(dir, 'escape'));
    fs.symlinkSync(path.join(outside, 'important.txt'), path.join(dir, 'lib', 'escape-file'));

    const result = removeDetour(root, STEP);

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
    const { dir } = writeDetourFiles(root, STEP, detour());
    assert.ok(fs.existsSync(dir));

    assert.equal(removeDetour(root, STEP).removed, true);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readdirSync(path.join(real, 'detours')), [], 'the removal did not reach through the linked root');
  });

  test('a read-only detour directory reports `failed` rather than throwing', () => {
    // Not every refusal is about containment. A delete that cannot happen must still come back
    // as a value: this runs on the return path, where a throw would strand the learner in a
    // detour with no way out and no sentence explaining why.
    const root = storage();
    const { dir } = writeDetourFiles(root, STEP, detour());
    const parent = detoursRoot(root);
    fs.chmodSync(parent, 0o500);
    try {
      const result = removeDetour(root, STEP);
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
    writeCachedDetour(root, STEP, 1, detour());
    const results: DetourRemoval[] = [
      removeDetour('relative', STEP),                                       // bad-root
      removeDetour(empty, STEP),                                            // no-store
      removeDetour(root, STEP),                                             // absent
      removeDetourAt(root, os.tmpdir()),                                    // escaped
      removeDetourAt(root, detoursRoot(root)),                              // is-the-store-root
      removeDetourAt(root, path.dirname(detourCachePath(root, STEP, 1))),   // not-a-detour
    ];
    fs.writeFileSync(detourDir(root, STEP), 'x');
    results.push(removeDetour(root, STEP));                                 // not-a-directory

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
      const result = removeDetour(root, id);
      assert.equal(result.removed, false, `step id ${JSON.stringify(id)} removed something`);
      assert.equal(refusalOf(result), 'absent', `step id ${JSON.stringify(id)} was refused for the wrong reason`);
    }
    assert.equal(fs.readFileSync(path.join(victimDir, 'important.txt'), 'utf8'), 'keep me\n');
    assert.ok(fs.existsSync(os.tmpdir()));
  });
});
