// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a detour lives on disk — `<globalStorageRoot>/detours/` — and the recursive delete
 * that takes one away again (T-7, ACs 2, 3 and 5).
 *
 * **Nothing this module writes ever goes inside the learner's workspace.** That is AC2 and it
 * is the reason the detour exists at all: the learner is midway through building their own
 * project, and a worked example that added files to their tree — even files it promised to
 * remove — would show up in their explorer, their `git status`, and eventually their commit.
 * The extension's global storage is somewhere they never look and we may freely own. Every
 * path here is composed from the `globalStorageRoot` the caller passes; no function in this
 * file reads the workspace, the cwd, or any ambient location, and `writeDetourFiles` refuses a
 * `globalStorageRoot` that is not absolute rather than quietly resolving one against the cwd.
 *
 * ## The layout
 *
 *     <globalStorageRoot>/detours/<32 hex>/…          one detour's files
 *     <globalStorageRoot>/detours/cache/<32 hex>.json  one cached generation (AC5)
 *
 * ## Two things this module is not allowed to assume
 *
 * **1. A step id is not a path segment.** `stepId` comes out of `plan.json`, which repo-tour
 * generates from a repository the learner pointed us at. It is a string and nothing more.
 * `detourDir` therefore HASHES it rather than sanitising it, and the choice is not stylistic:
 *
 *   - a sanitiser is lossy, so it COLLIDES. `a/b` and `a_b` fold onto one name under any
 *     plausible `replace(/[^A-Za-z0-9]/g, '_')`, and `Step-1` and `step-1` fold onto one name
 *     on any case-insensitive filesystem — which is the default on two of the three platforms
 *     this extension runs on. Two steps sharing a directory is not cosmetic: `removeDetour` on
 *     one deletes the other's files out from under its open tabs;
 *   - a sanitiser has to know every filesystem's rules — reserved names (`CON`, `NUL`, `AUX`),
 *     trailing dots and spaces on Windows, a component length ceiling, and `.`/`..` — and a
 *     rule it gets wrong is a path that escapes or a directory that cannot be created;
 *   - a hash is total. Every string in, one `[0-9a-f]{32}` segment out: legal everywhere,
 *     never reserved, never case-folded, fixed length, and injective for every input any
 *     plan will ever hold.
 *
 * What that costs is readability — a learner peering into global storage sees hex, not step
 * names — and that is the right trade here, because the human-readable name of a detour is its
 * `title`, which the narrator puts on screen. 32 hex characters (128 bits of a SHA-256) rather
 * than the full 64: collision resistance at 128 bits is far past anything a plan can reach, and
 * the 32 characters saved matter on Windows, where the whole path has to fit inside MAX_PATH
 * alongside a model-chosen relative path.
 *
 * **2. A cache entry is untrusted persisted model output.** What is in `cache/<hash>.json` was
 * written by a language model, stored on the learner's own disk, and is hand-editable, shared
 * with other tools and readable by a future version of this extension that wrote a richer
 * shape. `sanitizeDetour` treats it exactly the way `sanitizeTranscript` treats a stored
 * transcript (`src/tutor/transcript.ts`): DROP, never coerce, and REBUILD field by field so an
 * extra field cannot survive. The one difference is the unit of dropping, and it is deliberate
 * — a transcript drops one bad turn and keeps the rest, because the rest is still the learner's
 * conversation; a detour is a single object whose parts refer to each other (a stop names one
 * of the detour's own files), so any bad part makes the whole entry a MISS. There is no
 * half-trusted detour. A miss costs one regeneration; a half-trusted detour opens editor tabs.
 *
 * ## Containment, and why it is spelled out twice
 *
 * T-5's security review found a merge-blocking HIGH whose whole shape was that a path can stay
 * under a root as a STRING and land somewhere else on a DISK: a committed `src -> ../outside`
 * passes every lexical check and `mkdirSync(…, { recursive: true })` follows it without a
 * murmur. `realpath` is the only thing that can tell the two apart, because the difference is
 * not in the path — it is on the disk.
 *
 * This module is the one that DELETES, so it uses both halves everywhere and invents neither:
 *
 *   - the lexical half is `resolveInsideTarget` (`src/walk/paths.ts`), used on the model's own
 *     relative file paths;
 *   - the filesystem half is `writeTextAtomic`'s `root` argument (`src/dial/writer.ts`), which
 *     runs the three-step `prepareDirectory` dance — resolve the deepest EXISTING ancestor
 *     before creating anything, create, then resolve again and use that answer immediately.
 *
 * The root handed to `writeTextAtomic` is the **store** (`…/detours`), not the detour
 * directory, and that is load-bearing rather than incidental: handing in the detour directory
 * would make a planted `detours/<hash> -> /somewhere` symlink the root of the containment
 * question, and every write through it would be perfectly "contained" in the attacker's folder.
 * A root is only worth checking against if the root itself has been proved, which is what
 * `provenStoreRoot` below does — one directory further up, where nothing model-derived reaches.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from '../dial/writer.js';
import { resolveInsideTarget } from '../walk/paths.js';
import { DETOUR_LIMITS, type Detour, type DetourFile, type DetourStop } from './types.js';

/** The one directory this extension owns inside its global storage. */
const STORE_DIR = 'detours';

/** Where cached generations live — a sibling of the detours, never inside one. */
const CACHE_DIR = 'cache';

/**
 * How many hex characters of the SHA-256 name a detour. See this file's header for why it is
 * a hash at all and why 128 bits is the right amount of it.
 */
const NAME_HEX_CHARS = 16 * 2;

/** The only shape `removeDetour` will ever delete: one hashed segment, nothing else. */
const DETOUR_NAME = /^[0-9a-f]{32}$/;

/**
 * The most a cache entry may weigh before it is refused unread.
 *
 * T-6's security review, finding 4, in a new place: **a count is not a size.** `DETOUR_LIMITS`
 * bounds how many files a detour has and how many LINES each one has, and nothing in it bounds
 * how long a line is — so an entry can be shaped exactly right and still be gigabytes, and the
 * read path would pull all of it into memory before the shape check ever ran. The ceiling is
 * checked against `lstat().size` BEFORE the bytes are read, which is the only order that helps.
 *
 * 256 KiB against a worst case the limits actually permit: five files of sixty lines is 300
 * lines, and six narration stops. A legitimate detour that reached even a tenth of this would
 * be a wall of text no learner would read. There is a test on each side of the number — one
 * oversized entry refused, one near-maximum entry still served — because a ceiling set below
 * what the limits allow would make the cache silently never hit and AC5 would fail with every
 * test green.
 */
export const MAX_CACHE_BYTES: number = 256 * 1024;

// ── the paths ───────────────────────────────────────────────────────────────────────────────

/**
 * `<globalStorageRoot>/detours` — composed, not proved. Every operation below proves it for
 * real before touching anything; this is the arithmetic, and callers use it to name the folder
 * in a message or to prefix-match a tab's URI.
 */
export function detoursRoot(globalStorageRoot: string): string {
  return path.join(path.resolve(globalStorageRoot), STORE_DIR);
}

/**
 * The directory one step's detour is written into. A pure function of its two arguments:
 * asking creates nothing.
 */
export function detourDir(globalStorageRoot: string, stepId: string): string {
  return path.join(detoursRoot(globalStorageRoot), detourName(stepId));
}

/**
 * The cache entry for one step at one prompt version (AC5) — "cached by step id + prompt
 * version so retaking is free", with the version IN the key rather than beside it so a bumped
 * `DETOUR_PROMPT_VERSION` is a miss by construction and never a stale detour served against a
 * prompt that no longer asks for it.
 *
 * The version is a parameter rather than an import on purpose: `DETOUR_PROMPT_VERSION` belongs
 * to `src/detour/prompt.ts`, and the store's job is to key BY a version, not to know which one
 * is current. That also keeps this module buildable and testable without the prompt.
 */
export function detourCachePath(globalStorageRoot: string, stepId: string, promptVersion: number): string {
  return path.join(detoursRoot(globalStorageRoot), CACHE_DIR, cacheName(stepId, promptVersion));
}

/**
 * `JSON.stringify` frames the parts rather than a separator joining them, so no value of one
 * field can be spelled to look like the boundary between two — the ordinary way a composite
 * cache key collides on purpose.
 */
function hashOf(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, NAME_HEX_CHARS);
}

function detourName(stepId: string): string {
  return hashOf(['detour', stepId]);
}

function cacheName(stepId: string, promptVersion: number): string {
  return `${hashOf(['cache', promptVersion, stepId])}.json`;
}

// ── proving the store root ──────────────────────────────────────────────────────────────────

/** Why nothing happened. A closed set so a caller can branch and a test can assert the REASON
 *  rather than the absence of a result — T-6's reviews both found "refused with no sentence"
 *  to be the failure mode that hides bugs, and a bare `false` is that with extra steps. */
export type DetourRemoveReason =
  | 'bad-root'
  | 'no-store'
  | 'escaped-store'
  | 'absent'
  | 'not-a-directory'
  | 'not-a-detour'
  | 'escaped'
  | 'is-the-store-root'
  | 'failed';

/** What `removeDetour` answers: the path it really deleted, or a reason and a sentence. */
export type DetourRemoval =
  | { removed: true; path: string }
  | { removed: false; reason: DetourRemoveReason; detail: string };

type StoreProof = { store: string } | { reason: DetourRemoveReason; detail: string };

function refused(reason: DetourRemoveReason, detail: string): { reason: DetourRemoveReason; detail: string } {
  return { reason, detail };
}

/**
 * Where `p` really is, or `null` when the filesystem will not say. The same three lines as
 * `src/dial/writer.ts`'s private helper of this name, mirrored rather than exported from
 * there: this file must not reach into another module's internals for something this small,
 * and a local copy of a tiny predicate is the established pattern here (`transcript.ts` does
 * exactly this with `isRecord`). Every caller treats "cannot resolve" as a reason to stop
 * rather than an error to classify, because there is one safe answer to "I could not find out
 * where this path leads" and it is the same for all of them.
 */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return clamp(err instanceof Error ? err.message : String(err));
}

/** A sentence that may quote a path or an errno stays a sentence. An unbounded message is its
 *  own small denial of service once it reaches a notification (`writer.ts`'s `label`). */
function clamp(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
}

/**
 * `<globalStorageRoot>/detours`, PROVED: absolute, really there, and really that directory
 * rather than a link standing where it should be.
 *
 * This is the root every other containment answer in this file is relative to, which is why it
 * is checked one level further up than feels necessary. Containment is always relative to the
 * root you are handed: if `detours` were a symlink to somewhere else, every file written
 * "inside" it would land there, and every check inside it would agree that it had. The test
 * for this plants exactly that link and asserts the folder on the other end stays empty.
 *
 * The proof is an EQUALITY, not a containment: `realRoot` is already fully resolved, so
 * appending one genuine directory component to it yields a path `realpath` returns unchanged.
 * Anything else — a link to a sibling, a link outside, a link that resolves to nothing — is a
 * different string, and refusing all of them is both simpler to reason about and stricter than
 * asking whether the target happens to still be inside the storage root.
 *
 * `create` is what separates the write path from the read path. Creating the store is not
 * writing a detour, and a read that created the folder it was looking in would make
 * `removeDetour` on a fresh machine leave a directory behind for no reason.
 */
function provenStoreRoot(globalStorageRoot: unknown, create: boolean): StoreProof {
  if (typeof globalStorageRoot !== 'string' || globalStorageRoot.length === 0 || !path.isAbsolute(globalStorageRoot)) {
    return refused('bad-root', 'the extension storage folder was not given as an absolute path, so where it is cannot be established');
  }

  if (create) {
    // Before any check, and safe before any check: `mkdirSync` on a path that already exists
    // as a link to a real directory creates nothing at all, so this cannot dig through a
    // planted link on its way down. The proof below is what decides whether to proceed.
    try {
      fs.mkdirSync(path.join(globalStorageRoot, STORE_DIR), { recursive: true });
    } catch {
      /* the proof reports it in words a moment from now, with more context than errno has */
    }
  }

  const realRoot = realOrNull(globalStorageRoot);
  if (realRoot === null) {
    return refused('no-store', 'the extension storage folder could not be resolved, so where a detour would live is unknown');
  }
  const store = path.join(realRoot, STORE_DIR);
  const realStore = realOrNull(store);
  if (realStore === null) {
    // A link that resolves to nothing exists and is not a store; a path that is not there at
    // all is simply a machine that has never taken a detour. Different answers, because the
    // first is a thing to say out loud and the second is the ordinary first run.
    if (lstatOrNull(store) !== null) {
      return refused('escaped-store', 'the detours folder is a link that leads nowhere, so nothing under it can be trusted');
    }
    return refused('no-store', 'there is no detours folder in the extension storage, so there is nothing there to remove');
  }
  if (realStore !== store) {
    return refused('escaped-store', 'the detours folder is a link to somewhere else, so nothing under it is really in the extension storage');
  }
  if (lstatOrNull(store)?.isDirectory() !== true) {
    return refused('no-store', 'the detours folder in the extension storage is not a folder');
  }
  return { store };
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// ── writing a detour ────────────────────────────────────────────────────────────────────────

/** What landed and what did not. `problems` are sentences meant to be shown to the learner
 *  as-is, one per file, the way `reproduceFiles` reports a refused copy. */
export interface DetourWriteResult {
  /** The detour's directory as COMPOSED — the same string `detourDir` returns, so a caller
   *  can prefix-match an editor tab's URI against it without resolving anything. */
  dir: string;
  /** Absolute paths actually written, in `detour.files` order. */
  written: string[];
  /** One sentence per file that was refused or failed. Empty means everything landed. */
  problems: string[];
}

/**
 * REPLACES one step's detour on disk: the directory is cleared first, then each file is
 * written atomically under it.
 *
 * Cleared first because a detour is a whole, not a merge. Step 4 opens *the directory's* files
 * as tabs, so a leftover file from a session that crashed mid-detour would become a tab the
 * learner never asked for, in an example the narration does not describe. Clearing goes through
 * `removeDetour` rather than a second delete of its own — one recursive delete in this ticket,
 * with one set of refusals, driven by one set of tests. If it refuses for any reason other than
 * "there was nothing there", NOTHING is written: a directory we could not prove enough about to
 * empty is not a directory to fill.
 *
 * **Two guards overlap here, and which one does what was measured rather than assumed.** With
 * the write's root left as `proof.store` and the clearing deleted, a planted
 * `detours/<hash> -> /outside` is still refused and nothing lands outside; with the clearing
 * left in and the root changed to `dir`, it is also still refused. Remove BOTH and the planted
 * link is written through. So the containment guard is the ROOT — the clearing's own job is
 * staleness — and neither test can see the root's contribution while the clearing is in front
 * of it. That is worth stating because the tempting simplification is to hand `dir` in as the
 * root "since we just made it", and the suite would stay green all the way to the day the
 * clearing is refactored out.
 *
 * Each file passes both halves of containment. `resolveInsideTarget` refuses `..`, an absolute
 * path and a drive-relative one lexically — `parseDetourReply` is supposed to have refused
 * those already, and this refuses them anyway, because a defence that relies on a caller in
 * another file is not a defence this file has. `writeTextAtomic`'s `root` argument then refuses
 * anything that only LOOKS contained, and its temp-file-plus-rename means a symlink standing at
 * a destination is replaced rather than written through.
 *
 * One bad file does not cost the learner the others: a refusal is reported and the rest are
 * written, the same way `reproduceFiles` reports one entry without dropping the rest.
 */
export function writeDetourFiles(globalStorageRoot: string, stepId: string, detour: Detour): DetourWriteResult {
  const dir = detourDir(globalStorageRoot, stepId);

  const cleared = removeDetour(globalStorageRoot, stepId);
  if (!cleared.removed && cleared.reason !== 'absent' && cleared.reason !== 'no-store') {
    return { dir, written: [], problems: [`the detour folder could not be cleared, so nothing was written — ${cleared.detail}`] };
  }

  const proof = provenStoreRoot(globalStorageRoot, true);
  if (!('store' in proof)) {
    return { dir, written: [], problems: [`the detour could not be written — ${proof.detail}`] };
  }

  const written: string[] = [];
  const problems: string[] = [];
  for (const file of detour.files) {
    const abs = resolveInsideTarget(dir, file.path);
    if (abs === null) {
      problems.push(`${clamp(file.path)}: refused — it points outside the detour's own folder`);
      continue;
    }
    try {
      // `proof.store`, not `dir`: see this file's header. The root of a containment question
      // has to be a directory that has itself been proved, and the detour directory is one
      // model-derived name away from being whatever a planted link says it is.
      writeTextAtomic(abs, file.content, proof.store);
      written.push(abs);
    } catch (err) {
      problems.push(`${clamp(file.path)}: could not be written — ${messageOf(err)}`);
    }
  }
  return { dir, written, problems };
}

// ── the cache (AC5) ─────────────────────────────────────────────────────────────────────────

/**
 * The cached detour for this step at this prompt version, or `null` for a miss.
 *
 * Every failure is a miss and none is a throw: this runs on the path where a learner pressed a
 * button, and a corrupt cache file must cost them one model call, never a stack trace and never
 * a session. Missing, unreadable, not JSON, not the right shape, too big, or not a regular file
 * at all — one answer for all of them, because the useful thing to do next is the same.
 *
 * The size is checked against `lstat` before a byte is read (see `MAX_CACHE_BYTES`), and the
 * entry must be a REGULAR file: a symlink standing at `<hash>.json` would otherwise be followed
 * to whatever it names, and "whatever it names" is not a thing to read, parse and turn back
 * into files.
 */
export function readCachedDetour(globalStorageRoot: string, stepId: string, promptVersion: number): Detour | null {
  const proof = provenStoreRoot(globalStorageRoot, false);
  if (!('store' in proof)) return null;

  const file = path.join(proof.store, CACHE_DIR, cacheName(stepId, promptVersion));
  const stat = lstatOrNull(file);
  if (stat === null || !stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return sanitizeDetour(raw);
}

/**
 * Caches one generated detour. `false` means it was not cached — never a throw, because a
 * cache that cannot be written is a retake that costs a model call, not a detour that failed.
 *
 * It is sanitised on the way OUT as well as on the way in, and that is not belt-and-braces: it
 * is what makes a disagreement between this module and `parseDetourReply` VISIBLE. If the
 * parser ever accepts something `sanitizeDetour` refuses, this returns `false` and the cache
 * stays empty — which AC5's own acceptance check ("a second run makes no LLM call") fails on
 * loudly — rather than writing an entry that is silently refused on every read for the life of
 * the installation. Anyone debugging a cache that never hits should start here.
 */
export function writeCachedDetour(
  globalStorageRoot: string,
  stepId: string,
  promptVersion: number,
  detour: Detour,
): boolean {
  const clean = sanitizeDetour(detour);
  if (clean === null) return false;
  const text = JSON.stringify(clean, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_CACHE_BYTES) return false;

  const proof = provenStoreRoot(globalStorageRoot, true);
  if (!('store' in proof)) return false;

  try {
    writeTextAtomic(path.join(proof.store, CACHE_DIR, cacheName(stepId, promptVersion)), text, proof.store);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same predicate as `src/tutor/transcript.ts`'s and `src/walk/store.ts`'s, mirrored locally for
 * the reason they mirror each other: it is three lines, and the array exclusion is the whole
 * point — a bare `typeof value === 'object'` says an array is a record, and a `files` entry
 * spelled `["machine.ts", "…"]` would then be read for a `path` property it does not have.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A 1-based line number, and nothing that merely looks like one: `NaN`, `Infinity`, `1.5`,
 *  `0`, `-3` and `"1"` are all refused rather than rounded, floored or parsed. */
function isLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * How many lines a file's content has, with a trailing newline TERMINATING the last line
 * rather than starting an empty one — `"a\nb\n"` is two lines, the way every editor and `wc -l`
 * counts. Written down because it is the sort of off-by-one that would quietly make a
 * sixty-line file a sixty-one-line file and put every well-formed detour one over the limit.
 */
function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

/**
 * A `Detour` rebuilt from untrusted input, or `null` if it is not one.
 *
 * See this file's header for the discipline and where it comes from. Concretely: every field
 * is type-checked against exactly what `types.ts` declares, the shared `DETOUR_LIMITS` are
 * re-applied (the cache is a SECOND door into the same data and gets the same bounds as the
 * first), a stop must name one of THIS detour's files, and what comes back is built field by
 * field so `{ path, content, mode: 0o777 }` comes back as `{ path, content }` and a top-level
 * `command` is left on the floor.
 *
 * Exported because it is the interesting half of the read path and deserves to be driven
 * directly, without a disk in the way — the same reason `sanitizeTranscript` is exported.
 */
export function sanitizeDetour(raw: unknown): Detour | null {
  if (!isRecord(raw)) return null;
  const title = raw['title'];
  const domain = raw['domain'];
  if (typeof title !== 'string' || typeof domain !== 'string') return null;

  const rawFiles = raw['files'];
  if (!Array.isArray(rawFiles)) return null;
  if (rawFiles.length === 0 || rawFiles.length > DETOUR_LIMITS.maxFiles) return null;
  const files: DetourFile[] = [];
  for (const entry of rawFiles) {
    if (!isRecord(entry)) return null;
    const filePath = entry['path'];
    const content = entry['content'];
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    if (typeof content !== 'string') return null;
    if (lineCount(content) > DETOUR_LIMITS.maxLinesPerFile) return null;
    files.push({ path: filePath, content });
  }
  // Two files at one path is not a detour with a duplicate: it is two different contents for
  // one tab, and which one the learner reads would depend on write order.
  const known = new Set(files.map((file) => file.path));
  if (known.size !== files.length) return null;

  const rawStops = raw['stops'];
  if (!Array.isArray(rawStops)) return null;
  if (rawStops.length < DETOUR_LIMITS.minStops || rawStops.length > DETOUR_LIMITS.maxStops) return null;
  const stops: DetourStop[] = [];
  for (const entry of rawStops) {
    if (!isRecord(entry)) return null;
    const file = entry['file'];
    const text = entry['text'];
    const startLine = entry['startLine'];
    const endLine = entry['endLine'];
    if (typeof file !== 'string' || !known.has(file)) return null;
    if (typeof text !== 'string') return null;
    if (!isLineNumber(startLine) || !isLineNumber(endLine) || endLine < startLine) return null;
    stops.push({ file, startLine, endLine, text });
  }

  return { title, domain, files, stops };
}

// ── removing a detour ───────────────────────────────────────────────────────────────────────

/**
 * Deletes one step's detour directory and everything in it (AC3).
 *
 * **This is the most dangerous function in the ticket**: a recursive delete whose target is
 * derived from state. It is written on the assumption that every input is hostile, and it
 * refuses far more than it needs to, because the cost of a wrong refusal is one folder the
 * learner never sees left on disk and the cost of a wrong deletion is somebody's files.
 *
 * `removeDetourAt` below is where the refusals live; this is the only caller the extension
 * has, and the only path by which a `stepId` becomes a delete.
 */
export function removeDetour(globalStorageRoot: string, stepId: string): DetourRemoval {
  return removeDetourAt(globalStorageRoot, detourDir(globalStorageRoot, stepId));
}

/**
 * The refusals, in order. Exported so every one of them can be driven with a REAL path on a
 * real disk — `is-the-store-root` in particular is unreachable through `removeDetour`, because
 * a 32-hex name is never the empty string, and a guard nothing can reach is a guard nothing can
 * test. Inside the extension, `removeDetour` is the only caller.
 *
 * What it will delete, stated positively: a directory that (1) sits in an extension storage
 * folder given as an absolute path, (2) resolves — through `realpath`, not through string
 * arithmetic — to a DIRECT child of that folder's proven `detours/`, and (3) is named by
 * exactly 32 hex characters. Nothing else, ever. The name rule is what keeps `detours/cache/`
 * out of reach as much as it keeps `/` out of reach, and it is the reason a hostile `stepId`
 * can only ever aim this at its own hash.
 *
 * A path that is not there is `absent` rather than a throw: this runs on the return path, where
 * a throw would strand a learner inside a detour with no way back and no sentence saying why,
 * and "it is already gone" is the outcome the caller wanted in any case.
 *
 * The delete is aimed at the RESOLVED path, not the one that was handed in. A resolved path has
 * no symlink components left in it by construction, so the delete cannot follow one that the
 * check just looked past — which narrows the gap between the check and the act to a component
 * being swapped by another local process in between, rather than to anything a committed
 * repository or a stale state file can arrange.
 */
export function removeDetourAt(globalStorageRoot: string, dir: string): DetourRemoval {
  const proof = provenStoreRoot(globalStorageRoot, false);
  if (!('store' in proof)) return { removed: false, ...proof };
  const store = proof.store;

  // Typed `string`, checked anyway: the private validators in this file take `unknown` because
  // they are the defensive core, and an empty string is a legal `string` that `path.resolve`
  // turns into the current working directory — the one value that must never reach a recursive
  // delete by accident.
  if (typeof dir !== 'string' || dir.length === 0) {
    return { removed: false, ...refused('escaped', 'no detour folder was named, so there is nothing to remove') };
  }

  // Lexical first — it costs no syscalls and it puts `..`, `/` and any absolute path outside
  // the store on the floor before anything is stat'd. It is NOT containment on its own; the
  // two checks after the stat are the other half, and only the pair of them is an answer.
  //
  // Both spellings of the store are compared against, and that is not redundancy: a storage
  // root that is itself a symlink is the ORDINARY case on macOS, where `os.tmpdir()` sits
  // under one, so the path the caller composed and the path `realpath` gives back genuinely
  // differ for every legitimate detour on that platform. Comparing only against the resolved
  // one here would refuse every removal on a whole platform — which is the shape most
  // containment regressions actually take.
  const composed = detoursRoot(globalStorageRoot);
  const candidate = path.resolve(dir);
  if (candidate === store || candidate === composed) {
    return { removed: false, ...refused('is-the-store-root', 'that is the detours folder itself, which holds every step’s detour and the cache') };
  }
  if (resolveInsideTarget(store, candidate) === null && resolveInsideTarget(composed, candidate) === null) {
    return { removed: false, ...refused('escaped', 'that folder is not inside the extension’s detours folder') };
  }

  const stat = lstatOrNull(candidate);
  if (stat === null) {
    return { removed: false, ...refused('absent', 'there is no detour folder there — it has already been removed') };
  }
  if (!stat.isDirectory()) {
    // A symlink is refused rather than unlinked. `fs.rmSync` would unlink it and leave whatever
    // it points at alone, which is safe enough — but "the thing I was told to delete is not the
    // thing I would be deleting" is not a state to proceed quietly from, and a link standing
    // where a detour should be means something has already gone wrong that is worth saying.
    return { removed: false, ...refused('not-a-directory', 'what is there is a file or a link, not a detour folder') };
  }

  const real = realOrNull(candidate);
  if (real === null) {
    return { removed: false, ...refused('absent', 'the detour folder could not be resolved, so there is nothing safe to remove') };
  }
  if (real === store) {
    return { removed: false, ...refused('is-the-store-root', 'that resolves to the detours folder itself, which holds every step’s detour and the cache') };
  }
  // The check T-5's finding 1 was about, on the delete path. `<detours>/link/victim` with
  // `link -> ../outside` is contained as a string and outside on the disk, and only this can
  // tell the two apart.
  if (resolveInsideTarget(store, real) === null) {
    return { removed: false, ...refused('escaped', 'that folder really lives outside the extension’s detours folder, reached through a link') };
  }
  if (path.dirname(real) !== store || !DETOUR_NAME.test(path.basename(real))) {
    return { removed: false, ...refused('not-a-detour', 'that is not one step’s detour folder, so it is not this command’s to remove') };
  }

  try {
    fs.rmSync(real, { recursive: true, force: false });
  } catch (err) {
    return { removed: false, ...refused('failed', `the detour folder could not be removed — ${messageOf(err)}`) };
  }
  return { removed: true, path: real };
}
