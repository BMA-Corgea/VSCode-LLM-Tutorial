// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/derive/cache.ts` — the engine's memory, and the second door into model output (AC8).
 *
 * Every test makes its own storage root with `mkdtemp` and removes only that root. Nothing here
 * calls a model: the cache stores and returns text, and the engine's re-parse of what comes back
 * is pinned in the engine's own suite.
 */

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_DERIVE_CACHE_ENTRIES,
  deriveCacheKey,
  pruneDeriveCache,
  readCachedReply,
  writeCachedReply,
} from '../../src/derive/cache.js';
import { DERIVE_CACHE_DIR } from '../../src/derive/storage.js';
import { DERIVE_LIMITS, DERIVE_PROMPT_VERSION } from '../../src/derive/types.js';

const roots: string[] = [];

function newRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-cache-test-'));
  roots.push(dir);
  return dir;
}

teardown(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function entryFile(root: string, key: string): string {
  return path.join(root, DERIVE_CACHE_DIR, `${key}.json`);
}

suite('the derive cache — asked once, read back exactly, and never looser than the parser (AC4, AC8)', () => {
  test('the key is the prompt\'s hash with the shipped prompt version in it', () => {
    const expected = createHash('sha256').update(`${DERIVE_PROMPT_VERSION}\u0000a prompt`).digest('hex');
    assert.equal(deriveCacheKey('a prompt'), expected);
    assert.notEqual(deriveCacheKey('a prompt'), deriveCacheKey('a prompt '), 'one character of prompt is a different question');
  });

  test('what is written is what is read back, byte for byte', () => {
    const root = newRoot();
    const key = deriveCacheKey('outline: a tally counter');
    const reply = '{"title":"Tally"}\n  with odd spacing' + String.fromCharCode(0x2028) + 'and a separator';
    assert.equal(writeCachedReply(root, key, reply), true);
    assert.equal(readCachedReply(root, key), reply);
  });

  test('a read on a fresh machine is a miss and creates nothing', () => {
    const root = newRoot();
    assert.equal(readCachedReply(root, deriveCacheKey('x')), null);
    assert.equal(fs.existsSync(path.join(root, DERIVE_CACHE_DIR)), false);
  });

  test('an entry that is not JSON is a miss', () => {
    const root = newRoot();
    const key = deriveCacheKey('x');
    writeCachedReply(root, key, 'fine');
    fs.writeFileSync(entryFile(root, key), '{ not json');
    assert.equal(readCachedReply(root, key), null);
  });

  test('an entry moved under another key is a miss — the file must say which question it answers', () => {
    const root = newRoot();
    const a = deriveCacheKey('question a');
    const b = deriveCacheKey('question b');
    writeCachedReply(root, a, 'the answer to a');
    fs.renameSync(entryFile(root, a), entryFile(root, b));
    assert.equal(readCachedReply(root, b), null);
  });

  test('an entry that is a planted symlink is a miss, even to a well-formed reply', () => {
    const root = newRoot();
    const key = deriveCacheKey('x');
    writeCachedReply(root, key, 'real');
    const elsewhere = path.join(root, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ key, reply: 'planted' }));
    fs.rmSync(entryFile(root, key));
    fs.symlinkSync(elsewhere, entryFile(root, key));
    assert.equal(readCachedReply(root, key), null);
  });

  test('a cache folder that is a link to somewhere else is refused for reads AND writes; the far end stays empty', () => {
    const root = newRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-cache-outside-'));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, DERIVE_CACHE_DIR));
    const key = deriveCacheKey('x');
    assert.equal(writeCachedReply(root, key, 'would land outside'), false);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.writeFileSync(path.join(outside, `${key}.json`), JSON.stringify({ key, reply: 'planted outside' }));
    assert.equal(readCachedReply(root, key), null);
  });

  test('a reply longer than any the engine reads is neither written nor read', () => {
    const root = newRoot();
    const key = deriveCacheKey('x');
    const long = 'z'.repeat(DERIVE_LIMITS.maxReplyChars + 1);
    assert.equal(writeCachedReply(root, key, long), false);
    fs.mkdirSync(path.join(root, DERIVE_CACHE_DIR), { recursive: true });
    fs.writeFileSync(entryFile(root, key), JSON.stringify({ key, reply: long }));
    assert.equal(readCachedReply(root, key), null);
  });

  test('a key that is not a hash is refused, so no path can be smuggled through it', () => {
    const root = newRoot();
    assert.equal(writeCachedReply(root, '../../escape', 'x'), false);
    assert.equal(readCachedReply(root, '../../escape'), null);
  });

  test('pruning drops the OLDEST entries until both bounds hold, and touches nothing else', () => {
    const root = newRoot();
    const keys = ['one', 'two', 'three'].map((p) => deriveCacheKey(p));
    keys.forEach((k, i) => {
      writeCachedReply(root, k, `reply ${i}`);
      const t = new Date(Date.now() - (10 - i) * 60_000);
      fs.utimesSync(entryFile(root, k), t, t);
    });
    const bystander = path.join(root, DERIVE_CACHE_DIR, 'not-an-entry.txt');
    fs.writeFileSync(bystander, 'mine');
    assert.equal(pruneDeriveCache(root, { entries: 2, bytes: Number.MAX_SAFE_INTEGER }), 1);
    assert.equal(readCachedReply(root, keys[0]!), null, 'the oldest went');
    assert.equal(readCachedReply(root, keys[1]!), 'reply 1');
    assert.equal(readCachedReply(root, keys[2]!), 'reply 2');
    assert.equal(fs.readFileSync(bystander, 'utf8'), 'mine', 'a file that is not an entry is never removed');
    assert.ok(MAX_DERIVE_CACHE_ENTRIES >= 31 * 10, 'the shipped bound holds at least ten full derivations');
  });
  test('the shipped bound holds through the real writer: a full folder stays at the bound and loses its oldest', () => {
    const root = newRoot();
    fs.mkdirSync(path.join(root, DERIVE_CACHE_DIR), { recursive: true });
    const old = new Date(Date.now() - 3_600_000);
    const keys = Array.from({ length: MAX_DERIVE_CACHE_ENTRIES }, (_, i) => deriveCacheKey(`seed ${i}`));
    keys.forEach((k, i) => {
      const file = entryFile(root, k);
      fs.writeFileSync(file, JSON.stringify({ key: k, reply: 'x' }));
      const t = new Date(old.getTime() + i);
      fs.utimesSync(file, t, t);
    });
    const newest = deriveCacheKey('the newest');
    assert.equal(writeCachedReply(root, newest, 'y'), true);
    assert.equal(fs.readdirSync(path.join(root, DERIVE_CACHE_DIR)).length, MAX_DERIVE_CACHE_ENTRIES, 'held at the shipped bound');
    assert.equal(readCachedReply(root, keys[0]!), null, 'the oldest went');
    assert.equal(readCachedReply(root, newest), 'y', 'the newest stayed');
  });
});
