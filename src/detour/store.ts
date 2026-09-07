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
 * ## Three things this module is not allowed to assume
 *
 * **0. A step id is not a KEY here, because this is not the space it was minted in.** This is
 * the lesson T-7's review left, and it is the one that cost two merge-blocking findings:
 *
 *   > **An identifier is only a key inside the space it was minted for. Moving state into a
 *   > global store requires re-deriving every key in it.**
 *
 * repo-tour mints a step id as `sha256(file + ' ' + kind + ' ' + symbolName).slice(0, 16)` —
 * **with no repository identity in it at all.** Up to T-6 every per-step thing lived in the
 * learner's own `<target>/.repo-tour/progress.json`, where "unique per plan" was the whole
 * requirement and a step id met it. T-7 moved per-step state into `globalStorageUri`, which is
 * ONE directory for every tutorial this extension will ever open — and two tutorials built from
 * two different repositories that share a file path (`src/index.ts`, `README.md`, a symbol
 * called `main`) mint the same step id **by construction**. Driven, that was a session being
 * disposed deleting a LIVE session's detour directory out from under three open editor tabs,
 * and one repository's worked example served silently as another's.
 *
 * So nothing here is keyed by a step id. Everything is keyed by a `DetourKey`, which is the
 * step id **and** the tutorial it belongs to, and `tutorialId` is where that second half is
 * derived — from the learner's own target folder and the commit their plan was built from.
 * Section 1 below is right about why a step id must be HASHED; what it never asked is whether
 * a step id is UNIQUE in the space it is being used as a key for. Here it is not.
 *
 * The test to write for this class of bug is **two inputs that share a key**, not one input
 * twice: a suite that only ever drives one tutorial cannot see any of it.
 *
 * **1. A step id is not a path segment.** `stepId` comes out of `plan.json`, which repo-tour
 * generates from a repository the learner pointed us at. It is a string and nothing more.
 * `detourName` therefore HASHES it rather than sanitising it, and the choice is not stylistic:
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
 *
 * ## One writer, and why that sentence is here rather than in a review
 *
 * `writeDetourFiles` is **the only function in this extension that writes a detour**, and it
 * is the only one that may be. T-7 shipped with two: this one, which obeyed the paragraph
 * above, carried most of this file's suite, and **had no caller in `src/`**; and a second one
 * in `session.ts` that shipped, and handed `writeTextAtomic` the COMPOSED detour directory
 * instead. The security review swapped a symlink in between the check and the write and the
 * file landed outside with nothing thrown — invisible to the suite, because the suite's
 * strongest containment result was attached to the function nobody ran.
 *
 * The lesson, which is about tests and not about symlinks: **a paragraph in the right file
 * about the wrong function is a defence that documents itself into a place the code never
 * goes.** The builder's stated reason for the split was real — clearing the directory has to
 * precede the `realpath` that `prepareDetourWrite` needs — and it argues for the clearing
 * moving INSIDE the one writer, which is where it now is. It never argued for two writers.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from '../dial/writer.js';
import { resolveInsideTarget } from '../walk/paths.js';
import { detourLineCount, prepareDetourWrite, refusalSentence, unsafeDetourPathReason } from './prompt.js';
import { DETOUR_LIMITS, type Detour, type DetourFile, type DetourRefusal, type DetourStop } from './types.js';

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

/** The only shape `pruneDetourCache` will ever delete — `DETOUR_NAME`'s rule for the cache,
 *  for the same reason: a sweep that removed what it did not recognise is a wildcard delete. */
const CACHE_NAME = /^[0-9a-f]{32}\.json$/;

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

// ── the key ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a detour is keyed by. **Both halves, always together** — see this file's header,
 * section 0, for the two merge-blocking findings that came of keying by the step id alone.
 *
 * It is an OBJECT rather than two positional strings so that a call site cannot supply one
 * half and forget the other, and so that adding a third component one day is an edit in this
 * file rather than at every caller. Every path this module composes goes through it.
 */
export interface DetourKey {
  /**
   * Which TUTORIAL — `tutorialId`'s answer. Not the step, not the plan object: the identity
   * of the thing the learner is building, which is what `globalStorageUri` does not carry and
   * a repo-tour step id does not either.
   */
  tutorial: string;
  /** Which step of that tutorial. Untrusted `plan.json` text; hashed, never sanitised. */
  stepId: string;
}

/**
 * What a CACHE entry is keyed by: the detour's key, plus the two things that decide whether a
 * stored answer is still an answer to the question being asked.
 *
 * `prompt` is the sharper of the two and it is T-7 code review finding 9. A cache is a memo of
 * `prompt -> reply`, and the only honest key for a memo is its input — so a plan rebuilt with
 * a different `decision.question` under the same step id is a MISS rather than yesterday's
 * example served silently and forever. Before this it was keyed by step id and version alone,
 * and driven, a changed question served the stale example with `runLlm` calls = 0.
 *
 * `promptVersion` stays even though the prompt text almost always moves with it: it is what
 * invalidates the cache when the SHAPE this extension accepts changes while the words happen
 * not to, and it costs one number.
 */
export interface DetourCacheKey extends DetourKey {
  promptVersion: number;
  /** The exact prompt this entry answers. Hashed, never stored. */
  prompt: string;
}

/**
 * Which tutorial this is — the component a repo-tour step id does not carry.
 *
 * Two things identify a tutorial and both are used, because each covers a case the other does
 * not. **The target folder** is where the learner is building, and it is what separates two
 * tutorials open at once on one machine. **The plan's `source.head`** is the commit the plan
 * was generated from, and it is what separates one folder rebuilt against a newer reference —
 * a plan whose steps mean something different under the same ids.
 *
 * Total, and deliberately so: it takes `unknown` because `PlanLike` is an index signature over
 * `unknown` and a plan that arrived without a `source` is an ordinary shape rather than an
 * error. Every input produces a key; what a missing half costs is discrimination, never a
 * throw on the path where a learner pressed a button.
 *
 * `path.resolve` rather than `realpath`: this is a pure function and a key, and a key that
 * needed the disk could not be computed before the disk was proved.
 */
export function tutorialId(target: unknown, plan: unknown): string {
  const source: unknown = isRecord(plan) ? plan['source'] : undefined;
  const head: unknown = isRecord(source) ? source['head'] : undefined;
  return hashOf([
    'tutorial',
    typeof target === 'string' && target.length > 0 ? path.resolve(target) : null,
    typeof head === 'string' && head.length > 0 ? head : null,
  ]);
}

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
 * The directory one step of one tutorial writes its detour into. A pure function of its two
 * arguments: asking creates nothing.
 */
export function detourDir(globalStorageRoot: string, key: DetourKey): string {
  return path.join(detoursRoot(globalStorageRoot), detourName(key));
}

/**
 * The cache entry for one step of one tutorial, at one prompt version, for one prompt (AC5) —
 * "cached by step id + prompt version so retaking is free", with everything that decides
 * whether the answer is still the answer IN the key rather than beside it, so a stale entry is
 * a miss by construction rather than something a caller has to remember to check.
 */
export function detourCachePath(globalStorageRoot: string, key: DetourCacheKey): string {
  return path.join(detoursRoot(globalStorageRoot), CACHE_DIR, cacheName(key));
}

/**
 * `JSON.stringify` frames the parts rather than a separator joining them, so no value of one
 * field can be spelled to look like the boundary between two — the ordinary way a composite
 * cache key collides on purpose. That framing is what makes it safe to put the tutorial beside
 * the step id: `{tutorial:'ab', stepId:'cd'}` and `{tutorial:'abcd', stepId:''}` are different
 * strings to `JSON.stringify` and would be one string to a `+`.
 */
function hashOf(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, NAME_HEX_CHARS);
}

function detourName(key: DetourKey): string {
  return hashOf(['detour', key.tutorial, key.stepId]);
}

function cacheName(key: DetourCacheKey): string {
  return `${hashOf(['cache', key.promptVersion, key.tutorial, key.stepId, key.prompt])}.json`;
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
  /** The same directory RESOLVED. On macOS, where `os.tmpdir()` and often the extension's own
   *  storage sit under a symlink, this is a genuinely different string for every honest
   *  detour, and it is the one every written path is actually under. Callers prefix-match
   *  against both (`tabPrefixes`). */
  realDir: string;
  /** What actually landed, in `detour.files` order: the model's own relative path, and the
   *  absolute path `prepareDetourWrite` handed back — never a path this composed. */
  written: Array<{ path: string; abs: string }>;
  /** One sentence per file that was refused or failed. Empty means everything landed. */
  problems: string[];
}

/** Nothing was written, and this is the sentence saying why. Distinguished from an empty
 *  `written` because \"none of the five files could be written\" and \"the folder could not be
 *  proved, so nothing was attempted\" are different facts and the learner is owed the one that
 *  is true. */
export interface DetourWriteRefused {
  problem: string;
}

export function isDetourWriteRefused(value: DetourWriteResult | DetourWriteRefused): value is DetourWriteRefused {
  return 'problem' in value;
}

/**
 * REPLACES one step's detour on disk — **the one writer** (see this file's header), and the
 * file this whole ticket's risk lives in (AC2).
 *
 * The order is the design, and each step does a job the next one cannot:
 *
 *   1. **`removeDetour` first.** It clears any leftover from a session that crashed mid-detour
 *      — the caller opens *the directory's* files as tabs, so a stale file would become a tab
 *      in an example the narration does not describe. A detour is a whole, not a merge. It
 *      also does something nothing below it can: `provenStoreRoot` establishes that
 *      `<storage>/detours` is really that directory and not a link standing where it should
 *      be, which is the one containment question a level ABOVE anything model-derived, and the
 *      one `prepareDetourWrite` — which resolves the directory it is HANDED — cannot ask. A
 *      refusal for any reason other than \"there was nothing there\" stops everything: a folder
 *      we could not prove enough about to empty is not a folder to fill.
 *   2. **Prove the store again**, now with `create`, and keep the answer. `proof.store` is the
 *      root every write below is contained by, and it is the reason this function exists in
 *      one copy: it is a directory that has itself been proved, one level above anything the
 *      model chose. See the header's \"one writer\" section for what shipped instead.
 *   3. **Create the detour directory, then resolve it and CHECK the answer.** `realpath` can
 *      only speak about a path that exists, so the create has to come first — and it is safe
 *      here and nowhere earlier, because step 1 has just established that the store is a real
 *      directory and that this detour's own folder is gone, so there is no planted link left
 *      for `mkdir -p` to follow down. The check is the half `session.ts`'s copy skipped: it
 *      resolved the directory and then never compared it to anything.
 *   4. **`prepareDetourWrite` per file, and its ANSWER is the path written.** The lexical half
 *      is re-run inside it (one forgotten call site is how this class of bug returns), the
 *      parent is resolved before and after creation, and the final component is `lstat`ed so a
 *      symlink standing at `coins.ts` is refused rather than written through. The composed
 *      path is never used.
 *   5. **`writeTextAtomic` with `proof.store` as its root.** Not `dir`. This is T-7 security
 *      finding 1: with `dir` handed in, a directory swapped for a link between step 4 and the
 *      write is contained *in the attacker's folder* and nothing throws — driven, the file
 *      landed outside; with `proof.store`, the identical swap throws by name and the outside
 *      folder stays empty. Temp-file-and-rename covers the FINAL component of the same race;
 *      the directory is a different residue and this is what closes it.
 *
 * One bad file does not cost the learner the others: a refusal becomes a sentence and the rest
 * are written, the same way `reproduceFiles` reports one entry without dropping the rest.
 */
export function writeDetourFiles(
  globalStorageRoot: string,
  key: DetourKey,
  detour: Detour,
): DetourWriteResult | DetourWriteRefused {
  const dir = detourDir(globalStorageRoot, key);

  const cleared = removeDetour(globalStorageRoot, key);
  if (!cleared.removed && cleared.reason !== 'absent' && cleared.reason !== 'no-store') {
    return { problem: `The example's folder could not be cleared, so nothing was written — ${cleared.detail}.` };
  }

  const proof = provenStoreRoot(globalStorageRoot, true);
  if (!('store' in proof)) {
    return { problem: `The example could not be written — ${proof.detail}.` };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { problem: `The example's folder could not be created, so nothing was written — ${messageOf(err)}.` };
  }
  const realDir = realOrNull(dir);
  if (realDir === null) {
    return { problem: 'Where the example would be written could not be established, so nothing was.' };
  }
  // Resolved AND compared — the half the shipped writer left out. `realDir` under a proved
  // store is the only thing that makes the per-file containment below mean anything.
  if (resolveInsideTarget(proof.store, realDir) === null) {
    return { problem: 'The example\'s folder really lives outside the extension\'s detours folder, reached through a link, so nothing was written.' };
  }

  const written: Array<{ path: string; abs: string }> = [];
  const problems: string[] = [];
  for (const file of detour.files) {
    const target = prepareDetourWrite(dir, file.path);
    if (isRefusal(target)) {
      problems.push(refusalSentence(target));
      continue;
    }
    try {
      // `proof.store`, not `dir`: see step 5 above and this file's header.
      writeTextAtomic(target, file.content, proof.store);
      written.push({ path: file.path, abs: target });
    } catch (err) {
      problems.push(`${clamp(file.path)} could not be written — ${messageOf(err)}.`);
    }
  }
  return { dir, realDir, written, problems };
}

/** `prepareDetourWrite`'s two answers told apart. Local rather than imported so this module
 *  does not depend on `prompt.ts`'s public predicate for a narrowing it does once. */
function isRefusal(value: string | DetourRefusal): value is DetourRefusal {
  return typeof value !== 'string';
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
export function readCachedDetour(globalStorageRoot: string, key: DetourCacheKey): Detour | null {
  const proof = provenStoreRoot(globalStorageRoot, false);
  if (!('store' in proof)) return null;

  const file = path.join(proof.store, CACHE_DIR, cacheName(key));
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
  key: DetourCacheKey,
  detour: Detour,
): boolean {
  const clean = sanitizeDetour(detour);
  if (clean === null) return false;
  const text = JSON.stringify(clean, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_CACHE_BYTES) return false;

  const proof = provenStoreRoot(globalStorageRoot, true);
  if (!('store' in proof)) return false;

  const file = path.join(proof.store, CACHE_DIR, cacheName(key));
  try {
    writeTextAtomic(file, text, proof.store);
  } catch {
    return false;
  }
  // Bounded HERE, on the one path that grows it — see `MAX_CACHE_ENTRIES`. After the write, and
  // holding on to the file just written: eviction is by `mtime`, `mtime` is coarse on some
  // filesystems, and "the entry a learner just paid for is never the one evicted" has to be a
  // guarantee rather than a hope about clock resolution.
  pruneDetourCache(globalStorageRoot, MAX_CACHE_ENTRIES, file);
  return true;
}

/**
 * How many cached generations this extension keeps, across every tutorial and every step.
 *
 * **T-7 security review, finding 3, and it is a promise rather than a size problem.** Nothing
 * used to prune this: `removeDetourAt` refuses `detours/cache` by name (correctly — the 32-hex
 * rule is what keeps the cache out of reach as much as it keeps `/` out of reach), `dispose()`
 * does not touch it, and no other code referenced it. Model-written file CONTENTS therefore
 * survived *Back to my build*, survived the window closing, and survived forever — while the
 * narrator said on screen that going back deletes them. This repository's honest-controls rule
 * does not allow a page to state something the code does not do, so both halves moved: the
 * sentence now says a copy is kept (`DETOUR_ASIDE`, `src/detour/narrator.ts`), and the copy is
 * bounded here.
 *
 * 64 against `MAX_CACHE_BYTES` of 256 KiB is a stated worst case of 16 MiB and a realistic one
 * of a few hundred kilobytes — and it is far past any one session's use, so a learner walking a
 * plan never evicts their own earlier steps. AC5 ("a second run makes no LLM call") is about
 * the retake that follows a generation, which this cannot reach.
 */
export const MAX_CACHE_ENTRIES = 64;

/**
 * Drops the oldest cache entries beyond `maxEntries`, and answers how many went.
 *
 * Never throws, for `readCachedDetour`'s reason one door over: this runs on the path where a
 * learner pressed a button, and a cache that cannot be tidied is not a detour that failed.
 *
 * Only `[0-9a-f]{32}.json` REGULAR files are considered, which is the same allow-list
 * `removeDetourAt` applies to a detour directory and for the same reason — anything else in
 * there was not put there by this module, and a sweep that deleted what it did not recognise
 * would be a recursive delete with a wildcard in it. A symlink is left alone rather than
 * unlinked: \"the thing I was told to delete is not the thing I would be deleting\".
 *
 * Oldest by `mtime`, which is the write of the entry itself — a hit does not refresh it, so
 * this is insertion order rather than a true LRU. Stated rather than glossed: a genuine LRU
 * would mean writing to the cache on every read, which is a disk write on the free path.
 *
 * `keep` is one file that is never evicted whatever its timestamp says — the entry the caller
 * has just written. It is a parameter rather than a rule about time because `mtime` resolution
 * is a filesystem's business and "what a learner just paid for survives" is this module's.
 */
export function pruneDetourCache(
  globalStorageRoot: string,
  maxEntries: number = MAX_CACHE_ENTRIES,
  keep?: string,
): number {
  const proof = provenStoreRoot(globalStorageRoot, false);
  if (!('store' in proof)) return 0;
  const dir = path.join(proof.store, CACHE_DIR);

  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const entries: Array<{ file: string; mtime: number }> = [];
  for (const entry of names) {
    if (!entry.isFile() || !CACHE_NAME.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = lstatOrNull(file);
    // `lstat`, so a symlink is never counted and never removed by this.
    if (stat === null || !stat.isFile()) continue;
    entries.push({ file, mtime: stat.mtimeMs });
  }
  if (entries.length <= maxEntries) return 0;

  // Newest first, and `keep` — the entry the caller has just written — pinned to the front, so
  // it survives whatever the filesystem thinks its timestamp is.
  entries.sort((a, b) => {
    if (a.file === keep) return -1;
    if (b.file === keep) return 1;
    return b.mtime - a.mtime;
  });
  let removed = 0;
  for (const entry of entries.slice(Math.max(maxEntries, 0))) {
    try {
      fs.unlinkSync(entry.file);
      removed += 1;
    } catch {
      /* one entry that will not go is one entry kept, not a sweep that failed */
    }
  }
  return removed;
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

// How many lines a file's content has is `detourLineCount` (`./prompt.ts`) and nothing else.
//
// This module used to carry its own, and the two disagreed: the parser normalised a lone `\r`
// to a line break and this one split on `\n` alone, so 200 lines separated by lone CRs were
// `file-too-long` to one door and perfectly acceptable to the other (T-7 security finding 4,
// code finding 7). **If a validator's header says "the same bounds as the first", the bounds it
// means have to be a value both of them IMPORT — not a property both of them are supposed to
// have implemented.** That is the rule; the import above is what enforces it.

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
 * **"The same bounds as the first" is now a shared function rather than a shared intention.**
 * The claim was here before T-7's reviews and three of the parser's rules were not: the path
 * allow-list (security 2), a stop's range fitting its file, and a lone `\r` ending a line
 * (security 4 / code 7). All three are imported from `./prompt.ts` now — `unsafeDetourPathReason`
 * and `detourLineCount` — so the two doors cannot drift again without the import breaking.
 *
 * The direction of any REMAINING looseness is checked and deliberate: everything the parser
 * accepts, this accepts. It has to be, because `writeCachedDetour` sanitises on the way OUT —
 * a rule stricter here than in the parser would make every write refuse silently, the cache
 * never hit, and AC5 fail with every test green.
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
  const lines = new Map<string, number>();
  const folded = new Set<string>();
  for (const entry of rawFiles) {
    if (!isRecord(entry)) return null;
    const filePath = entry['path'];
    const content = entry['content'];
    // **The path bound, and it is the one this whole ticket is about** (T-7 security finding
    // 2). The cache is a second door into the write path: a hand-edited `cache/<hash>.json`,
    // or one written by a future version of this extension with a looser parser, reaches
    // `present()` and the writer without ever meeting `parseDetourReply`. A `Detour` carries
    // no "paths already checked" mark in its type, so the read path has to re-apply the rule
    // itself — the same function the parser calls, not a second implementation of it. Nothing
    // escaped before this, because `prepareDetourWrite` re-runs the lexical half at the write;
    // what was wrong was that the whole defence rested on one function while this module's
    // header read as though two independent doors were each checking. One door, one rule.
    if (unsafeDetourPathReason(filePath) !== null) return null;
    if (typeof content !== 'string') return null;
    const count = detourLineCount(content);
    if (count > DETOUR_LIMITS.maxLinesPerFile) return null;
    const safePath = filePath as string;
    // Two files at one path is not a detour with a duplicate: it is two different contents for
    // one tab, and which one the learner reads would depend on write order. Case-folded too,
    // and that half is the parser's rule arriving here: one filesystem in three would merge
    // `Coins.ts` and `coins.ts`, so a cached pair is one tab holding whichever content won the
    // race to be written.
    const fold = safePath.toLowerCase();
    if (lines.has(safePath) || folded.has(fold)) return null;
    files.push({ path: safePath, content });
    lines.set(safePath, count);
    folded.add(fold);
  }

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
    if (typeof file !== 'string') return null;
    const count = lines.get(file);
    if (count === undefined) return null;
    if (typeof text !== 'string') return null;
    if (!isLineNumber(startLine) || !isLineNumber(endLine) || endLine < startLine) return null;
    // The stop-range bound, the parser's other rule this door was missing: a range has to fit
    // the file it names. `{startLine: 1, endLine: 9007199254740991}` over a two-line file used
    // to survive a full write→read round trip here while `parseDetourReply` refused it by
    // name, and the narrator drew `lines 1–9007199254740991` off the back of it.
    if (endLine > count) return null;
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
export function removeDetour(globalStorageRoot: string, key: DetourKey): DetourRemoval {
  return removeDetourAt(globalStorageRoot, detourDir(globalStorageRoot, key));
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
 * can only ever aim this at its own hash — its own tutorial's hash, since T-7's review: the
 * key is a `DetourKey` and a step id no longer names a directory by itself.
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
