// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a tutorial's reference really is, in a record the repository cannot write (T-92 (b)).
 *
 * `request.json` names the reference root every taught-step read uses: the dial copies from it,
 * the outline shows lines of it, the check parses it and the tutor sends a diff against it. But
 * `request.json` sits in the learner's folder, at `<target>/.repo-tour/build/`, and a cloned
 * repository is free to ship that folder: its own `plan.json`, and a `request.json` whose
 * `referenceRoot` is any folder on the disk (`/`, a home folder, `/proc/self`). Believing it as
 * written let a repository choose what the walk reads, and the plan then names the file.
 *
 * So the root a walk reads from is the one THE BUILD resolved, and the build says so in the one
 * place a repository cannot write: this extension's own global storage, at
 * `<globalStorage>/built/<sha256 of the target's real path>.json`. The build writes it before it
 * writes `request.json` (`src/start/build.ts`); the walk believes `request.json`'s root only when
 * the record for this folder exists and names the same real folder (`believeRequest`, wired in
 * `src/extension.ts`). Anything else, no record, another root, a record that cannot be read,
 * is a walk with no reference at all: the plan's decisions, whys and witnesses are on the page,
 * and a sentence says why nothing is read.
 *
 * Keyed by the REAL path of the target, so a folder reached through a link is the same tutorial,
 * and compared by the REAL path of the root, so the same reference by another name is the same
 * reference. The folder is proved by equality, not containment (`provenStorageDir`, the derive
 * store's proof): a `built` that is a link is refused, read and write alike.
 *
 * What this does not do, said so the next reader does not assume it: it binds the ROOT to the
 * folder, not the plan to the build. A plan replaced after a build (a re-plan does this on
 * purpose, T-22) is read against the root its folder was built from, and every one of its
 * file names is still held to containment and to the withheld rule (`taughtFileWithheld` in
 * `src/dial/writer.ts`). And a tutorial built before this record existed has none: it walks with
 * no reference until it is built again, because an old honest `request.json` and a hostile one
 * are the same bytes.
 *
 * No `vscode` import: the walk's unit bundle runs under plain mocha.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { provenStorageDir } from '../derive/storage.js';
import type { ResolvedRequest } from './store.js';

/** The folder in the extension's global storage the records live in, beside `derived/` and `detours/`. */
export const BUILT_RECORDS_DIR = 'built';

/** A record is a few hundred bytes. Anything larger is not one, and is not read. */
const MAX_RECORD_BYTES = 16 * 1024;

/** What every sentence below ends with: what does not happen, and what to do about it. */
const NOTHING_IS_READ = 'so none of its reference files are read: nothing is written for you, checked, or sent to the tutor. To use them, build it again with Build Tutorials: Start.';

/** No record for this folder: the tutorial came with the folder, or was built somewhere else. */
export const NOT_BUILT_HERE = `This tutorial was not built in this editor (it came with the folder, or was built on another machine or in another profile), ${NOTHING_IS_READ}`;

/** A record, naming another root than `request.json` does. */
export const NOT_THE_BUILT_ROOT = `This tutorial's request.json names a different reference repository from the one it was built from in this editor, ${NOTHING_IS_READ}`;

/** A record that is there and cannot be trusted or read. */
export function notConfirmed(why: string): string {
  return `Where this tutorial was built could not be confirmed (${why}), ${NOTHING_IS_READ}`;
}

/**
 * A request this extension did not build here: walked, never read from. Carries the sentence and
 * nothing else, so no reader can pick an unbelieved root up off it.
 */
export interface RequestWithheld {
  withheld: string;
}

export function isWithheld(value: ResolvedRequest | RequestWithheld): value is RequestWithheld {
  return 'withheld' in value;
}

interface BuiltRecord {
  version: 1;
  /** the target's real path, as the build saw it */
  target: string;
  /** the reference root's real path, as the build resolved it */
  referenceRoot: string;
  builtAt: string;
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordName(realTarget: string): string {
  return `${createHash('sha256').update(realTarget).digest('hex').slice(0, 32)}.json`;
}

/** Where the record for `target` is: composed, not proved. Exported for the tests that plant one. */
export function builtRecordFile(globalStorageRoot: string, target: string): string {
  return path.join(path.resolve(globalStorageRoot), BUILT_RECORDS_DIR, recordName(realOrNull(target) ?? path.resolve(target)));
}

/**
 * The build's half: `target` was built from `referenceRoot`. Called by the build before it writes
 * `request.json`, so a folder never holds a request this record does not stand behind. Throws a
 * sentence on any failure, which the build reports as its own (`fail`, marker kept).
 */
export function recordBuiltReference(globalStorageRoot: string, target: string, referenceRoot: string): void {
  const realTarget = realOrNull(target);
  if (realTarget === null) {
    throw new Error('the folder being built in could not be resolved, so where its reference lives could not be recorded');
  }
  const realRoot = realOrNull(referenceRoot);
  if (realRoot === null || lstatOrNull(realRoot)?.isDirectory() !== true) {
    throw new Error('the reference repository could not be resolved to a folder, so where it lives could not be recorded');
  }
  const proof = provenStorageDir(globalStorageRoot, BUILT_RECORDS_DIR, true);
  if ('refused' in proof) {
    throw new Error(`where this tutorial's reference lives could not be recorded in the extension's storage: ${proof.refused}`);
  }
  const file = path.join(proof.dir, recordName(realTarget));
  const record: BuiltRecord = { version: 1, target: realTarget, referenceRoot: realRoot, builtAt: new Date().toISOString() };
  // Temp and rename, under a name nobody can guess: the same write every durable file here gets.
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never made, or already gone */
    }
    throw new Error(`where this tutorial's reference lives could not be recorded in the extension's storage — ${messageOf(err)}`);
  }
}

/** The record for `realTarget`, or the sentence saying why there is none worth believing. */
function readRecord(globalStorageRoot: string, realTarget: string): BuiltRecord | RequestWithheld {
  if (typeof globalStorageRoot !== 'string' || !path.isAbsolute(globalStorageRoot)) {
    return { withheld: notConfirmed('the extension storage folder was not given as an absolute path') };
  }
  // Nothing has ever been built in this editor: not a fault, just the commonest "not built here".
  const realStorage = realOrNull(globalStorageRoot);
  if (realStorage === null || lstatOrNull(path.join(realStorage, BUILT_RECORDS_DIR)) === null) return { withheld: NOT_BUILT_HERE };
  const proof = provenStorageDir(globalStorageRoot, BUILT_RECORDS_DIR, false);
  if ('refused' in proof) return { withheld: notConfirmed(proof.refused) };

  const file = path.join(proof.dir, recordName(realTarget));
  const stat = lstatOrNull(file);
  if (stat === null) return { withheld: NOT_BUILT_HERE };
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return { withheld: notConfirmed('its record in the extension storage is not one') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { withheld: notConfirmed('its record in the extension storage could not be read') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { withheld: notConfirmed('its record in the extension storage is not one') };
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1 || record['target'] !== realTarget || typeof record['referenceRoot'] !== 'string' || record['referenceRoot'].length === 0) {
    return { withheld: notConfirmed('its record in the extension storage is not one for this folder') };
  }
  return parsed as BuiltRecord;
}

/**
 * The walk's half: `request`, believed, or the sentence saying why its root is not.
 *
 * `null` stays `null` (a folder with no readable `request.json`, which the walk already answers).
 * A believed request carries the RECORD's real root, never the string `request.json` spelled; an
 * unbelieved one carries only the sentence. The folder compared is `target`, the one the walk
 * opened, never `request.json`'s own `target` field, which the repository also wrote.
 */
export function believeRequest(
  request: ResolvedRequest | null,
  target: string,
  globalStorageRoot: string,
): ResolvedRequest | RequestWithheld | null {
  if (request === null) return null;
  const realTarget = realOrNull(target);
  if (realTarget === null) return { withheld: notConfirmed('this folder could not be resolved') };
  const record = readRecord(globalStorageRoot, realTarget);
  if ('withheld' in record) return record;
  const realClaimed = realOrNull(request.referenceRoot);
  if (realClaimed === null || realClaimed !== record.referenceRoot) return { withheld: NOT_THE_BUILT_ROOT };
  if (lstatOrNull(record.referenceRoot)?.isDirectory() !== true) return { withheld: NOT_THE_BUILT_ROOT };
  return { ...request, referenceRoot: record.referenceRoot };
}
