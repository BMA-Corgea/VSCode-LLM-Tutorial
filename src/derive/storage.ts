// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine's two folders in the extension's global storage — `derive-cache/` (model
 * replies) and `derived/` (reference trees) — and the PROOF that each is really where it says
 * (T-17, AC8 and AC9).
 *
 * The proof is the detour store's (`src/detour/store.ts`'s `provenStoreRoot`), and its reasoning
 * is quoted rather than re-derived: containment is always relative to the root you are handed.
 * If `derived` were a symlink to somewhere else, every file written "inside" it would land there,
 * and every containment check inside it would agree that it had. So the root is proved by
 * EQUALITY, not containment: `realpath(<real storage root>/<name>)` must return that exact
 * string, and anything else — a link to a sibling, a link outside, a link to nothing — is
 * refused. It is mirrored here rather than exported from the detour because that function speaks
 * the detour's refusal vocabulary, and this one speaks the engine's (`DeriveRefusal`).
 *
 * No `vscode` import — see `./types.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DeriveRefusal } from './types.js';

/** The two folder names, beside the detour's `detours/` in the same storage root. */
export const DERIVE_CACHE_DIR = 'derive-cache';
export const DERIVED_TREES_DIR = 'derived';

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * `<globalStorageRoot>/<name>`, proved: absolute, really there, and really that directory rather
 * than a link standing where it should be. `create` separates the write path from the read path:
 * a read must not create the folder it is looking in.
 */
export function provenStorageDir(globalStorageRoot: unknown, name: string, create: boolean): { dir: string } | DeriveRefusal {
  if (typeof globalStorageRoot !== 'string' || globalStorageRoot.length === 0 || !path.isAbsolute(globalStorageRoot)) {
    return { refused: 'the extension storage folder was not given as an absolute path, so where the engine keeps its files cannot be established' };
  }
  if (create) {
    // Safe before any check: `mkdirSync` on a path that is already a link to a directory
    // creates nothing, so it cannot dig through a planted link. The proof below decides.
    try {
      fs.mkdirSync(path.join(globalStorageRoot, name), { recursive: true });
    } catch {
      /* the proof reports it in words a moment from now */
    }
  }
  const realRoot = realOrNull(globalStorageRoot);
  if (realRoot === null) return { refused: 'the extension storage folder could not be resolved' };
  const dir = path.join(realRoot, name);
  const realDir = realOrNull(dir);
  if (realDir === null) {
    if (lstatOrNull(dir) !== null) return { refused: `the ${name} folder is a link that leads nowhere, so nothing under it can be trusted` };
    return { refused: `there is no ${name} folder in the extension storage yet` };
  }
  if (realDir !== dir) return { refused: `the ${name} folder is a link to somewhere else, so nothing under it is really in the extension storage` };
  if (lstatOrNull(dir)?.isDirectory() !== true) return { refused: `the ${name} folder in the extension storage is not a folder` };
  return { dir };
}
