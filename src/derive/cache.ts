// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine's memory — and the reason it is deterministic (T-17, AC4 and AC8).
 *
 * A live model gives different words to the same prompt on two calls, so determinism cannot come
 * from the model. It comes from asking each distinct prompt AT MOST ONCE: the answer is stored
 * under `sha256(DERIVE_PROMPT_VERSION + "\0" + prompt)`, and every later derivation that builds
 * the same prompt reads it back instead of calling. The proof is observable: the second
 * derivation of the same idea and answers makes zero calls.
 *
 * ── A cache is a second parser, so it is not allowed to be one ─────────────────────────────
 *
 * T-7's lesson: persisting model output means the validated shape is re-entered from disk by a
 * function that is not the parser, and that function will be the looser one. So this module
 * stores only the model's RAW reply text, and returns only raw text. **The caller re-parses every
 * cached reply with the same parser that judged it live** (`./prompt.ts`), so there is exactly one
 * definition of an acceptable reply and the cache cannot be a looser door than the model. A
 * cached reply that no longer parses is treated as a miss and asked again.
 *
 * What this cannot stop, said rather than implied: a VALID reply edited by someone who can write
 * to the extension's own storage (a question reworded, an option relabelled) is served as it
 * stands. Anything the parser refuses still cannot get in. Detecting edits that stay inside the
 * rules would need a key nobody else on the machine can read, and a process that can rewrite
 * this folder can rewrite the extension's own code. So no such key is kept, on purpose.
 *
 * Only replies that parsed are ever WRITTEN (the engine's rule): a bad reply is asked again on
 * the next press rather than served forever.
 *
 * No `vscode` import — see `./types.ts`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from '../dial/writer.js';
import { DERIVE_CACHE_DIR, lstatOrNull, provenStorageDir } from './storage.js';
import { DERIVE_LIMITS, DERIVE_PROMPT_VERSION } from './types.js';

/**
 * How many replies are kept, and how many bytes in all. A derivation of a 30-step plan asks at
 * most 31 questions; 2,000 entries is dozens of derivations and their replans. 64 MB bounds the
 * folder whatever the replies weigh (each is at most `maxReplyChars`).
 */
export const MAX_DERIVE_CACHE_ENTRIES = 2000;
export const MAX_DERIVE_CACHE_BYTES = 64 * 1024 * 1024;

/** The key: the prompt's hash, with the prompt version in it so a new wording never meets an old answer. */
export function deriveCacheKey(prompt: string): string {
  return createHash('sha256').update(`${DERIVE_PROMPT_VERSION}\u0000${prompt}`).digest('hex');
}

const KEY_SHAPE = /^[0-9a-f]{64}$/;

function entryPath(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

/**
 * The raw reply stored under `key`, or `null` for a miss — and every way an entry can be wrong
 * is a miss: absent, not a regular file (a planted link), unreadable, not JSON, the wrong shape,
 * stored under a different key, or longer than any reply the engine reads. The caller still
 * re-parses what comes back (see the header).
 */
export function readCachedReply(globalStorageRoot: string, key: string): string | null {
  if (!KEY_SHAPE.test(key)) return null;
  const proof = provenStorageDir(globalStorageRoot, DERIVE_CACHE_DIR, false);
  if ('refused' in proof) return null;
  const file = entryPath(proof.dir, key);
  if (lstatOrNull(file)?.isFile() !== true) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = parsed as { key?: unknown; reply?: unknown };
  if (entry.key !== key || typeof entry.reply !== 'string') return null;
  if (entry.reply.length > DERIVE_LIMITS.maxReplyChars) return null;
  return entry.reply;
}

/**
 * Store `reply` under `key`. Never throws: a cache that could not be written is a derivation
 * that will cost again next time, not a reason to fail this one. Prunes afterwards.
 */
export function writeCachedReply(globalStorageRoot: string, key: string, reply: string): boolean {
  if (!KEY_SHAPE.test(key) || reply.length > DERIVE_LIMITS.maxReplyChars) return false;
  const proof = provenStorageDir(globalStorageRoot, DERIVE_CACHE_DIR, true);
  if ('refused' in proof) return false;
  try {
    writeTextAtomic(entryPath(proof.dir, key), JSON.stringify({ key, reply }), proof.dir);
  } catch {
    return false;
  }
  pruneDeriveCache(globalStorageRoot);
  return true;
}

/**
 * Drop the oldest entries until the folder is within both bounds. Oldest by modification time —
 * a read does not refresh it, so this is first-written-first-dropped, which is what the bounds
 * are for: a folder that cannot grow without limit. Only regular files named like an entry are
 * ever removed, and only from the proved folder.
 */
export function pruneDeriveCache(
  globalStorageRoot: string,
  limits: { entries: number; bytes: number } = { entries: MAX_DERIVE_CACHE_ENTRIES, bytes: MAX_DERIVE_CACHE_BYTES },
): number {
  const proof = provenStorageDir(globalStorageRoot, DERIVE_CACHE_DIR, false);
  if ('refused' in proof) return 0;
  let names: string[];
  try {
    names = fs.readdirSync(proof.dir);
  } catch {
    return 0;
  }
  const entries: Array<{ file: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(proof.dir, name);
    const st = lstatOrNull(file);
    if (st?.isFile() !== true) continue;
    entries.push({ file, size: st.size, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.file < b.file ? -1 : 1));
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  let count = entries.length;
  let removed = 0;
  for (const e of entries) {
    if (count <= limits.entries && total <= limits.bytes) break;
    try {
      fs.unlinkSync(e.file);
      removed += 1;
      count -= 1;
      total -= e.size;
    } catch {
      /* gone already, or not ours to remove — either way, on to the next */
    }
  }
  return removed;
}
