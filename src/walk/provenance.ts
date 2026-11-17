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
 * `<globalStorage>/built/<sha256 of the target's real path>.json`. The build writes it right after
 * it writes `request.json` and before `plan.json` (`src/start/build.ts`), so a folder whose walk
 * can open (it has a plan) always has its record. The walk believes `request.json` only when the
 * record for this folder exists, names THESE BYTES of `request.json`, and names the same real
 * folder as the request's root (`believeRequest`, wired in `src/extension.ts`). Anything else is a
 * walk with no reference at all: the plan's decisions, whys and witnesses are on the page, and a
 * sentence says why nothing is read.
 *
 * **Bound to the bytes, not only to the path** (T-92's security review, F1). A record keyed by the
 * path alone outlives its folder: a tutorial built at a path, deleted, and a cloned repository
 * landing at the same path whose shipped `request.json` named the old root (even relatively) was
 * believed, its shipped `dial` with it. The record therefore carries the sha256 of the exact
 * `request.json` the build wrote. A repository cannot produce those bytes without the learner's
 * own folder, a hand-edited request is not the build's either, and nothing writes `request.json`
 * after a build (a re-plan never does, T-22's AC11), so a stale record vouches for nothing new.
 *
 * **The record is asked first** (the same review, N5). Nothing about an unbelieved request is
 * resolved, stat'd or realpath'd: the repository-chosen root of a shipped `request.json` is never
 * touched, which matters on a platform where touching a path can reach a network host.
 *
 * Keyed by the REAL path of the target, so a folder reached through a link is the same tutorial,
 * and compared by the REAL path of the root, so the same reference by another name is the same
 * reference. The folder is proved by equality, not containment (`provenStorageDir`, the derive
 * store's proof): a `built` that is a link is refused, read and write alike.
 *
 * What this does not do, said so the next reader does not assume it: it binds the request and its
 * root to the folder, not the PLAN to the build. A plan replaced after a build (a re-plan does this
 * on purpose, T-22) is read against the root its folder was built from, and every one of its file
 * names is still held to containment and to the withheld rule (`taughtFileWithheld` in
 * `src/dial/writer.ts`). The root is believed once, when the walk opens: a reference root replaced
 * by a link while a walk is open is followed by the reads after it, which takes write access to
 * the root's own parent folder, not anything a repository ships. And a tutorial built before this
 * record existed has none: it walks with no reference until it is built again, because an old
 * honest `request.json` and a hostile one are the same kind of bytes.
 *
 * No `vscode` import: the walk's unit bundle runs under plain mocha.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { provenStorageDir } from '../derive/storage.js';
import { BUILD_DIR } from '../start/request.js';
import type { ResolvedRequest } from './store.js';

/** The folder in the extension's global storage the records live in, beside `derived/` and `detours/`. */
export const BUILT_RECORDS_DIR = 'built';

/** A record is a few hundred bytes. Anything larger is not one, and is not read. */
const MAX_RECORD_BYTES = 16 * 1024;

/** A `request.json` is a form's worth of fields. One larger than this is not one the build wrote. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** What every sentence below ends with: what does not happen, and what to do about it. */
const NOTHING_IS_READ = 'so none of its reference files are read: nothing is written for you, checked, or sent to the tutor. To use them, build it again into an empty folder with Build Tutorials: Start.';

/** No record for this folder. The causes are listed because the learner may well have built it. */
export const NOT_BUILT_HERE = `This editor has no record of building this tutorial (it came with the folder, was built on another machine or profile, was moved, or was built by an earlier version of Build Tutorials), ${NOTHING_IS_READ}`;

/** A record for this folder, but for another `request.json` than the one here. */
export const NOT_THE_BUILDS_REQUEST = `This tutorial's request.json is not the one this editor wrote when it built here (it came with the folder, or was changed since), ${NOTHING_IS_READ}`;

/** The build's own request, whose root now resolves somewhere other than where the build found it. */
export const NOT_THE_BUILT_ROOT = `This tutorial's reference repository is no longer the folder this editor built it from (it was moved, or replaced by a link), ${NOTHING_IS_READ}`;

/** The build's own request, whose root is not a folder any more. */
export const REFERENCE_GONE = `The reference repository this tutorial was built from is not there any more, ${NOTHING_IS_READ}`;

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
  /** sha256 (hex) of the exact `request.json` bytes the build wrote */
  request: string;
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordName(realTarget: string): string {
  return `${sha256(Buffer.from(realTarget, 'utf8')).slice(0, 32)}.json`;
}

/** Where the record for `target` is: composed, not proved. Exported for the tests that plant one. */
export function builtRecordFile(globalStorageRoot: string, target: string): string {
  return path.join(path.resolve(globalStorageRoot), BUILT_RECORDS_DIR, recordName(realOrNull(target) ?? path.resolve(target)));
}

/**
 * `<target>/.repo-tour/build/request.json`'s bytes, or `null`: a regular file (never a link), and
 * small enough to be a request. Read once, by whoever needs the bytes, so what is hashed is what
 * is held.
 */
function requestBytes(realTarget: string): Buffer | null {
  const file = path.join(realTarget, ...BUILD_DIR, 'request.json');
  const stat = lstatOrNull(file);
  if (stat === null || !stat.isFile() || stat.size > MAX_REQUEST_BYTES) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * The build's half: `target` was built from `referenceRoot`, with the `request.json` it has just
 * written. Called by the build after it writes `request.json` and before `plan.json`, so the
 * record is bound to the very bytes on disk and a folder with a plan always has one. Throws a
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
  const request = requestBytes(realTarget);
  if (request === null) {
    throw new Error('the request.json this build wrote could not be read back, so where its reference lives could not be recorded');
  }
  const proof = provenStorageDir(globalStorageRoot, BUILT_RECORDS_DIR, true);
  if ('refused' in proof) {
    throw new Error(`where this tutorial's reference lives could not be recorded in the extension's storage: ${proof.refused}`);
  }
  const file = path.join(proof.dir, recordName(realTarget));
  const record: BuiltRecord = {
    version: 1, target: realTarget, referenceRoot: realRoot, request: sha256(request), builtAt: new Date().toISOString(),
  };
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
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return { withheld: notConfirmed('its record in the extension storage is damaged') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { withheld: notConfirmed('its record in the extension storage could not be read') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { withheld: notConfirmed('its record in the extension storage is damaged') };
  }
  const record = parsed as Record<string, unknown>;
  const root = record['referenceRoot'];
  const request = record['request'];
  if (record['version'] !== 1 || record['target'] !== realTarget || typeof root !== 'string' || root.length === 0
    || typeof request !== 'string' || !/^[0-9a-f]{64}$/.test(request)) {
    return { withheld: notConfirmed('its record in the extension storage is not one of this extension\'s records for this folder') };
  }
  return parsed as BuiltRecord;
}

/**
 * The walk's half: this folder's request, believed, or the sentence saying why it is not.
 *
 * The record is asked FIRST, and the request's own bytes against it, before `load` (the store's
 * `loadRequest`, which resolves and stats the request's root) is called at all: a request that is
 * not believed is never resolved. `null` means a folder with no readable `request.json`, which the
 * walk already answers. A believed request carries the RECORD's real root, never the string
 * `request.json` spelled. The folder compared is `target`, the one the walk opened, never
 * `request.json`'s own `target` field.
 */
export function believeRequest(
  target: string,
  globalStorageRoot: string,
  load: (target: string) => ResolvedRequest | null,
): ResolvedRequest | RequestWithheld | null {
  const realTarget = realOrNull(target);
  if (realTarget === null) return { withheld: notConfirmed('this folder could not be resolved') };
  const bytes = requestBytes(realTarget);
  // No request at all is the store's answer to give (it may be a hand-assembled folder); one that
  // is there but cannot be the build's is not believed.
  if (bytes === null) return lstatOrNull(path.join(realTarget, ...BUILD_DIR, 'request.json')) === null ? null : { withheld: NOT_THE_BUILDS_REQUEST };
  const record = readRecord(globalStorageRoot, realTarget);
  if ('withheld' in record) return record;
  if (sha256(bytes) !== record.request) return { withheld: NOT_THE_BUILDS_REQUEST };
  const request = load(target);
  // The build's own bytes, so they parse: a null now means their root is not a folder any more.
  if (request === null) return { withheld: REFERENCE_GONE };
  if (realOrNull(request.referenceRoot) !== record.referenceRoot) return { withheld: NOT_THE_BUILT_ROOT };
  return { ...request, referenceRoot: record.referenceRoot };
}
