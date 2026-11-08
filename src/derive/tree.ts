// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The reference tree: the derived app's files, written where the walk reads a reference from
 * (T-17, AC9). The ONLY permanent writer of model-written files in the engine (`extractAll` writes
 * the same files to a scratch folder for a moment, so repo-tour can read them, and removes it).
 *
 * ── Where, and why there ──────────────────────────────────────────────────────────────────────
 *
 * `<globalStorage>/derived/<tutorial key>/<slug>-<content key>/` — never inside the learner's
 * folder. Like the detour (T-7), this is model-written content the learner should not meet in
 * their explorer or their search results, and in Mode A it is the answer key. The walk reaches it
 * exactly as it reaches a cloned repository: through `request.json`'s `referenceRoot`.
 *
 *   - **The tutorial key** is a hash of the target folder. A per-extension store must be keyed
 *     per tutorial (T-7: two tutorials that happen to share a path collided by construction).
 *   - **The content key** is a hash of every (path, bytes) pair. Two derivations that produced the
 *     same files produce the same key, which is what lets a determinism check compare roots.
 *
 * ── Immutable, which is the substrate T-22 and T-14 stand on ───────────────────────────────
 *
 * A tree is written ONCE, by staging it in a fresh sibling folder and renaming that into place,
 * so a crash leaves either no tree or a whole one. It is never modified afterwards. A plan
 * version that pointed at it can therefore always be walked against it again, which is what
 * undoing a divergence (T-14) needs. If the folder for a key already exists, its bytes are checked
 * file by file. If they match, it is reused. If they do not (someone edited it), it is replaced
 * atomically by a correct copy, because the key promises exactly those bytes.
 *
 * ── Containment, both halves ─────────────────────────────────────────────────────────────────
 *
 * The lexical half is the shared rule (`src/relative-path.ts`), re-run HERE on every path rather
 * than trusted to the parser that already ran it: one forgotten call site is how this class of
 * bug comes back (the detour's `prepareDetourWrite` does the same). The filesystem half is the
 * proved `derived/` folder (`./storage.ts`, equality not containment), a tutorial folder proved
 * the same way, and `writeTextAtomic`'s last-instant `prepareDirectory` against that proved
 * folder for every file.
 *
 * No `vscode` import — see `./types.ts`.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from '../dial/writer.js';
import { unsafeRelativePathReason } from '../relative-path.js';
import { DERIVED_TREES_DIR, lstatOrNull, provenStorageDir } from './storage.js';
import { DERIVE_LIMITS, type DeriveRefusal } from './types.js';

export interface DerivedFile {
  path: string;
  content: string;
}

export interface ReferenceTree {
  /** the tree's folder, resolved — what `request.json`'s `referenceRoot` should name */
  root: string;
  contentKey: string;
}

/** Which tutorial a tree belongs to — the target folder, resolved, hashed. */
export function tutorialKey(target: string): string {
  return createHash('sha256').update(`derive-tutorial\u0000${path.resolve(target)}`).digest('hex').slice(0, 16);
}

/** A hash of every (path, bytes) pair, in path order — the same files give the same key. */
export function treeContentKey(files: readonly DerivedFile[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path}\u0000${Buffer.byteLength(f.content, 'utf8')}\u0000`).update(f.content, 'utf8');
  }
  return hash.digest('hex').slice(0, 16);
}

/** A folder name a person can read in the tutor's context ("tally-3f2a…"), never a model's raw text. */
export function treeSlug(title: unknown): string {
  const base = typeof title === 'string' ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
  const cut = base.slice(0, 32).replace(/-+$/g, '');
  return cut.length > 0 ? cut : 'app';
}

function refuse(sentence: string): DeriveRefusal {
  return { refused: sentence };
}

/** The tutorial's own folder under the proved `derived/`, created and proved the same way. */
function provenTutorialDir(derived: string, key: string): string | DeriveRefusal {
  const dir = path.join(derived, key);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* proved or refused just below */
  }
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return refuse('the tutorial\'s folder in the extension storage could not be resolved');
  }
  if (real !== dir || lstatOrNull(dir)?.isDirectory() !== true) {
    return refuse('the tutorial\'s folder in the extension storage is a link to somewhere else, so nothing under it is really there');
  }
  return dir;
}

/** True when `dir` holds exactly `files`, byte for byte, and nothing else. */
function holdsExactly(dir: string, files: readonly DerivedFile[]): boolean {
  const want = new Map(files.map((f) => [f.path, f.content]));
  const seen: string[] = [];
  const walk = (rel: string): boolean => {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, rel));
    } catch {
      return false;
    }
    for (const name of names) {
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const st = lstatOrNull(path.join(dir, relPath));
      if (st === null) return false;
      if (st.isDirectory()) {
        if (!walk(relPath)) return false;
      } else if (st.isFile()) {
        const expected = want.get(relPath);
        if (expected === undefined) return false;
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(path.join(dir, relPath));
        } catch {
          return false;
        }
        if (!bytes.equals(Buffer.from(expected, 'utf8'))) return false;
        seen.push(relPath);
      } else {
        return false; // a link, a fifo, a device: not something this writer ever makes
      }
    }
    return true;
  };
  return walk('') && seen.length === want.size;
}

/**
 * Write `files` as the reference tree for `target`, or reuse the identical tree already there.
 * Every refusal is a sentence and leaves nothing half-written: the staging folder is removed on
 * any failure, and the final folder only ever appears whole, by rename.
 */
export function writeReferenceTree(
  globalStorageRoot: string,
  target: string,
  title: string,
  files: readonly DerivedFile[],
): ReferenceTree | DeriveRefusal {
  if (files.length === 0) return refuse('there are no files to write');
  if (files.length > DERIVE_LIMITS.maxSteps) return refuse(`there are ${files.length} files, more than ${DERIVE_LIMITS.maxSteps}`);
  const folded = new Set<string>();
  for (const f of files) {
    const unsafe = unsafeRelativePathReason(f.path, {
      folder: 'reference tree',
      maxChars: DERIVE_LIMITS.maxPathChars,
      maxSegments: DERIVE_LIMITS.maxPathSegments,
    });
    if (unsafe !== null) return refuse(`the file path ${JSON.stringify(String(f.path).slice(0, 60))} ${unsafe}`);
    if (folded.has(f.path.toLowerCase())) return refuse(`two files share the path ${JSON.stringify(f.path)}, ignoring case`);
    folded.add(f.path.toLowerCase());
    if (typeof f.content !== 'string' || f.content.length > DERIVE_LIMITS.maxFileChars || f.content.includes('\u0000')) {
      return refuse(`the file ${JSON.stringify(f.path)} is not text within the engine's bounds`);
    }
  }

  const derived = provenStorageDir(globalStorageRoot, DERIVED_TREES_DIR, true);
  if ('refused' in derived) return derived;
  const tutorialDir = provenTutorialDir(derived.dir, tutorialKey(target));
  if (typeof tutorialDir !== 'string') return tutorialDir;

  const contentKey = treeContentKey(files);
  const finalDir = path.join(tutorialDir, `${treeSlug(title)}-${contentKey}`);
  const existing = lstatOrNull(finalDir);
  if (existing !== null) {
    if (existing.isDirectory() && holdsExactly(finalDir, files)) return { root: finalDir, contentKey };
    if (!existing.isDirectory() && !existing.isSymbolicLink() && !existing.isFile()) {
      return refuse('something that is neither a file nor a folder stands where the tree belongs');
    }
  }

  // Stage the whole tree beside its final place, then rename it in.
  const staging = path.join(tutorialDir, `.staging-${randomBytes(6).toString('hex')}`);
  try {
    fs.mkdirSync(staging);
    // The root is the PROVED folder, not the one just composed: containment is always relative to
    // the root you are handed, and a staging folder swapped for a link would agree with itself.
    for (const f of files) writeTextAtomic(path.join(staging, ...f.path.split('/')), f.content, tutorialDir);
    if (existing !== null) {
      // The folder for this key holds the wrong bytes (or is a link or a file): move it aside
      // under a name only this call knows, put the right tree in, and only then remove it.
      const aside = path.join(tutorialDir, `.replaced-${randomBytes(6).toString('hex')}`);
      fs.renameSync(finalDir, aside);
      fs.renameSync(staging, finalDir);
      fs.rmSync(aside, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, finalDir);
    }
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* the staging folder is ours and hidden; litter, not harm */
    }
    // Another derivation may have written the same key a moment ago — that tree is correct by
    // definition if its bytes match, and using it is the right answer.
    if (lstatOrNull(finalDir)?.isDirectory() === true && holdsExactly(finalDir, files)) return { root: finalDir, contentKey };
    return refuse(`the reference tree could not be written: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`);
  }
  return { root: finalDir, contentKey };
}
