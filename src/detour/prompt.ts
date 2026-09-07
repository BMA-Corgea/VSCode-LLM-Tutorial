// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The detour's two boundaries: what is ASKED of a model, and what is ACCEPTED back from one
 * (T-7, AC1). Nothing here talks to a provider and nothing here can — this module has no
 * runner, no timeout and no `LlmChoice`, only `path`, `fs` and two pure builders. A prompt
 * builder that cannot spend money is one you can unit-test at full strength, which is exactly
 * what AC1's check asks for and the same argument `src/tutor/context.ts` makes for itself.
 *
 * **No `vscode` import, value or type** — `esbuild.mjs`'s `test/unit/*.test.ts` bundle marks
 * `repo-tour` and `mocha` external and deliberately NOT `vscode`, so one such import fails the
 * build and takes the whole unit suite with it.
 *
 * ── Outbound: `Outbound` is the only door, and this module does not build a second one ───────
 *
 * The prompt states a concept read out of `plan.json`: `decision.question`, `decision.why`,
 * and the label and consequence of the option the author actually took. Those are third-party
 * docstrings and `interpretPlan`'s model output — untrusted, unvalidated, and the exact fields
 * T-6's security review (finding 2) measured at **19,906,863 characters in a single prompt
 * from one button press**. The fix T-6 shipped was not four patches; it was one object,
 * `Outbound` (`src/tutor/context.ts`), owning the question "what may leave this machine".
 *
 * So every plan-sourced string below goes through `Outbound.text` or `Outbound.options`, at
 * `Outbound`'s own budgets, and the announcement of a cut is `Outbound`'s `textCutNote` rather
 * than a second sentence invented here. **This module defines no outbound cap of its own.**
 * `MAX_DETOUR_PROMPT_CHARS` is not a cap: it is the SUM of `Outbound`'s budgets, the way
 * `MAX_CONTEXT_CHARS` is, so that what one press of the detour button can put in front of a
 * paid third party is arithmetic on named constants rather than on whatever `plan.json`
 * happened to contain. A test holds the real prompt on a hostile plan to it.
 *
 * ── Outbound, second property: an untrusted field cannot forge a section ─────────────────────
 *
 * The prompt has headed sections (`--- WHAT TO RETURN ---`). A `why` containing a newline and
 * that same header would otherwise write one, and the model would read this extension's own
 * instructions as having ended where an untrusted docstring said they did. This is T-6
 * security finding 8's shape — an announcement that content can forge — pointed the other way,
 * and it is answered the same way: **the tutor's own lines sit where content cannot occupy
 * them.** Every untrusted value is emitted JSON-ENCODED, which turns a newline into the two
 * characters `\n` and makes each value exactly one physical line. `U+2028`/`U+2029` are
 * escaped on top of `JSON.stringify`, which is allowed to emit them raw. The property the
 * tests pin is a line count: a hostile `why` produces a prompt with exactly as many lines as
 * a benign one.
 *
 * Encoding is not censoring. The field is still sent in full (up to its budget) and the model
 * still reads it; what it cannot do is stop being a value and become structure.
 *
 * ── Inbound: this module is the last thing before a real write to a real path ────────────────
 *
 * `parseDetourReply` takes whatever a model said and returns either a `Detour` or a
 * `DetourRefusal` — never a bare `null`, because the panel has to say WHY, and both T-6
 * reviews found "refused with no sentence" to be the failure mode that hides bugs.
 *
 * `files[].path` is the dangerous field: it becomes a real filesystem path under
 * `globalStorageRoot/detours/<stepId>/`. It is attacker-shaped in the ORDINARY case, not the
 * exotic one — a model asked for "a small example" will sometimes answer `../` or an absolute
 * path by accident. Containment therefore comes in two halves, kept apart because they fail
 * differently and are needed in different places, exactly as `src/walk/paths.ts` and
 * `src/dial/writer.ts` already keep them apart:
 *
 *   - **`parseDetourReply` does the lexical half**, which is all a pure function can do. It is
 *     an ALLOWLIST rather than a denylist: a segment must match `[A-Za-z0-9_][A-Za-z0-9._-]*`.
 *     Each of the named attacks (`..`, an absolute path, a drive letter, a UNC path, a NUL
 *     byte, a control character, a backslash, an empty segment, a reserved Windows device, a
 *     dot-leading segment) is checked FIRST anyway, so that the refusal carries the specific
 *     sentence the panel should show — but the allowlist is what covers the shape nobody has
 *     thought of yet. A worked example in an unrelated domain has never needed a character
 *     outside it.
 *   - **`prepareDetourWrite` does the filesystem half** — `realpath` on the parent, before and
 *     after the directory is created, plus an `lstat` on the final component. **T-5's
 *     merge-blocking HIGH was a symlinked directory component defeating a lexical check**
 *     (`up -> ../outside`, lexically contained, really elsewhere), and what let it ship was a
 *     header that read as though the job were finished. A lexical pass with no `realpath` is
 *     that bug; a `realpath` pass with no lexical pass would `mkdir -p` its way out before it
 *     ever thought to look. Neither is redundant.
 *
 * `prepareDetourWrite` re-runs the lexical half itself rather than trusting that anyone called
 * the parser. One forgotten call site is how this class of bug returns.
 *
 * ── The three inbound bounds that are NOT `Outbound`'s business ──────────────────────────────
 *
 * `Outbound` decides what LEAVES. These decide what may be written to the learner's disk from
 * a reply that has already arrived, which is a different question with a different blast
 * radius, so they live here:
 *
 *   - `MAX_DETOUR_REPLY_CHARS` — `DETOUR_LIMITS` bounds a file's LINES and says nothing about
 *     how long a line may be, so "≤ 5 files, ≤ 60 lines" permits a 300-line reply of 100 MB.
 *     One bound on the raw reply closes that, and every field under it, at once.
 *   - `MAX_DETOUR_PATH_SEGMENTS` — five files six levels deep is thirty directories; five
 *     files five thousand levels deep is a write amplification with no honest use.
 *   - `MAX_DETOUR_PATH_CHARS` — a path long enough to be its own denial of service, and to
 *     make a refusal message one too. (The message quotes a shortened path for the same
 *     reason `src/dial/writer.ts`'s `label` does.)
 *
 * ── `DETOUR_PROMPT_VERSION` ──────────────────────────────────────────────────────────────────
 *
 * AC5 caches a detour by step id and this number. **Bump it whenever the prompt's wording or
 * the shape this module accepts changes**, or a learner gets a cached answer to a question
 * that is no longer the one being asked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MAX_OPTION_TEXT, MAX_PAGE_TEXT, MAX_PROMPT_TEXT, Outbound } from '../tutor/context.js';
import type { PlanLike, StepKind, StepLike } from '../walk/model.js';
import { resolveInsideTarget } from '../walk/paths.js';
import { DETOUR_LIMITS, type Detour, type DetourFile, type DetourRefusal, type DetourStop } from './types.js';

/** The cache key's other half (AC5). See the header: bump this when the prompt changes. */
export const DETOUR_PROMPT_VERSION = 1;

/**
 * Room for the fixed instructions this module writes itself — the sections, the JSON shape and
 * the rules. Only the SCAFFOLDING; every plan-sourced value is budgeted by `Outbound` instead.
 *
 * It is a number rather than a measurement so `MAX_DETOUR_PROMPT_CHARS` stays a constant that
 * can be asserted, and a test renders the real scaffolding and holds it to this — otherwise
 * nothing would notice a paragraph being pasted into the prompt.
 */
export const MAX_DETOUR_INSTRUCTIONS_CHARS = 4000;

/**
 * The longest escape `JSON.stringify` emits for one character is six long (`\\u001f`). Every
 * untrusted value is JSON-encoded, so a field of control bytes is six times its budget on the
 * wire; the ceiling below has to survive that rather than assume ASCII.
 */
const JSON_ESCAPE_WORST_CASE = 6;

/**
 * What one press of the detour button can put in front of a model, worst case.
 *
 * **Not a cap** — nothing consults it at runtime. It is the sum of `Outbound`'s budgets, the
 * same thing `MAX_CONTEXT_CHARS` is and for the same reason: T-6's measurement was
 * 19,906,863 characters from one press, and the fix is only a fix if that number is now a
 * function of named constants rather than of `plan.json`. Two `MAX_PROMPT_TEXT` fields (the
 * question and the why), one option's label and consequence, and four `MAX_PAGE_TEXT` fields
 * (the repository, the file, the chapter and its subtitle).
 */
export const MAX_DETOUR_PROMPT_CHARS =
  JSON_ESCAPE_WORST_CASE * (MAX_PROMPT_TEXT * 2 + MAX_OPTION_TEXT * 2 + MAX_PAGE_TEXT * 4) +
  MAX_DETOUR_INSTRUCTIONS_CHARS;

/**
 * The largest reply this module will look at — see the header's third section. 256 KB against
 * a legitimate worst case of roughly 30 KB (5 files × 60 lines × 100 characters), so the
 * headroom is eight-fold and nothing honest is anywhere near it.
 */
export const MAX_DETOUR_REPLY_CHARS = 256 * 1024;

/** How deep a detour file may sit. `src/domain/orders/order.ts` is four; six is generous for
 *  a five-file example and bounds the directories one reply can create at thirty. */
export const MAX_DETOUR_PATH_SEGMENTS = 6;

/** How long one detour path may be. Longer than any honest name and short enough that a
 *  refusal can quote it. */
export const MAX_DETOUR_PATH_CHARS = 160;

// ── the prompt ──────────────────────────────────────────────────────────────────────────────

/**
 * What a `kind` means in a sentence, so the model is told the file's ROLE rather than a word
 * out of this repository's own vocabulary.
 *
 * Made total the way `context.ts`'s `whySourceLabel` is, and for the same reason: `kind` is
 * typed `StepKind` but its value is whatever `plan.json` said, so `'constructor'` and
 * `'__proto__'` index to inherited members rather than to `undefined`, and a function reaching
 * a template literal is not a label.
 */
const STEP_KIND_LABEL: Record<StepKind, string> = {
  shape: 'a whole part of the project — why it exists as its own piece',
  file: 'one file — why it exists and what belongs in it',
  symbol: 'one symbol inside a file — how it does its job',
};

const UNKNOWN_STEP_KIND = 'one step of the build (this plan names a kind we do not recognise)';

function stepKindLabel(kind: unknown): string {
  if (typeof kind !== 'string' || !Object.hasOwn(STEP_KIND_LABEL, kind)) return UNKNOWN_STEP_KIND;
  const label: unknown = (STEP_KIND_LABEL as Record<string, unknown>)[kind];
  return typeof label === 'string' ? label : UNKNOWN_STEP_KIND;
}

/** What is said when no option is marked as the road the author took. An honest "nobody wrote
 *  it down" beats naming an alternative as though the author had chosen it — `takenIdsOf` in
 *  `context.ts` gives the full argument for the same distinction. */
const NO_AUTHOR_CHOICE = 'this plan does not record which option the author took';

/**
 * One value, encoded so it can only ever be a value.
 *
 * `JSON.stringify` escapes every newline, quote and control character — so a field containing
 * `\n--- WHAT TO RETURN ---` occupies one physical line and cannot forge a section header.
 * It is explicitly ALLOWED to emit `U+2028`/`U+2029` raw, and those are line terminators to
 * enough readers to matter, so they are escaped on top.
 */
function jsonValue(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** A block of `"key": "value"` lines — one line per field, always, whatever the field holds. */
function jsonBlock(entries: Array<[string, string]>): string {
  const lines = entries.map(([key, value], i) => `  ${jsonValue(key)}: ${jsonValue(value)}${i === entries.length - 1 ? '' : ','}`);
  return `{\n${lines.join('\n')}\n}`;
}

/** The label and consequence of the road the author actually took, as one budgeted line —
 *  both halves out of `Outbound.options`, so the cap cannot fire on one and not the other. */
function authorRoad(step: StepLike): string {
  const taken = Outbound.options(step).options.find((o) => o.taken);
  return taken === undefined ? NO_AUTHOR_CHOICE : `${taken.label} — ${taken.consequence}`;
}

/**
 * The ask (AC1): a self-contained worked example of THIS step's concept, in a domain
 * deliberately unlike the learner's, as JSON matching `Detour`.
 *
 * Three things have to be in it and the parser is unforgiving about the third, so all three
 * are stated: the concept (the decision, why it was made, and what the author chose), the
 * learner's own domain named as the thing to AVOID, and the exact JSON shape with every limit
 * `parseDetourReply` enforces — interpolated from `DETOUR_LIMITS` so the ask and the check
 * cannot drift apart.
 *
 * `refName` is the reference repository's own folder name, the way `AskContext.repo` is: the
 * learner is rebuilding somebody else's project and the model should be told its name so it
 * can steer away from it.
 */
export function detourPrompt(step: StepLike, plan: PlanLike, refName: unknown): string {
  const chapters = Array.isArray(plan.chapters) ? plan.chapters : [];
  // `Outbound.text` answers a missing chapter with its own `NOT_TEXT_MESSAGE` ("the plan has
  // nothing readable here"), which is true and already this repository's sentence for it — a
  // second phrasing would be a second vocabulary for the same fact.
  const chapter = chapters.find((c) => c.key === step.chapter);

  const concept = jsonBlock([
    ['theDecisionTheLearnerIsStuckOn', Outbound.text(step.decision.question, MAX_PROMPT_TEXT)],
    ['whyItWasMadeThatWay', Outbound.text(step.decision.why, MAX_PROMPT_TEXT)],
    ['whatTheAuthorChose', authorRoad(step)],
  ]);

  const domain = jsonBlock([
    ['referenceRepository', Outbound.text(refName, MAX_PAGE_TEXT)],
    ['theFileTheyAreOn', Outbound.text(step.target.file, MAX_PAGE_TEXT)],
    ['whatThisStepTeaches', stepKindLabel(step.kind)],
    ['theChapterItIsIn', Outbound.text(chapter?.title, MAX_PAGE_TEXT)],
    ['whatThatChapterHolds', Outbound.text(chapter?.subtitle, MAX_PAGE_TEXT)],
  ]);

  const { maxFiles, maxLinesPerFile, minStops, maxStops } = DETOUR_LIMITS;

  return `You are teaching one idea to somebody who is rebuilding an existing project one decision at
a time. They are stuck on the decision below. Do not explain their own code to them: show the
same idea at work in a small, self-contained example somewhere else entirely, and narrate it.

--- THE CONCEPT TO TEACH ---
${concept}

--- THE LEARNER'S OWN DOMAIN, WHICH YOU MUST AVOID ---
${domain}

Your example must sit in a different domain from the one above — different subject matter,
different vocabulary, different file names. AVOID the reference repository's subject entirely.
If their build is about HTTP routing, do not write about HTTP routing. The whole point is that
they meet the idea somewhere it cannot be confused with the code they are stuck on.

--- WHAT TO RETURN ---
One JSON object and nothing else. No prose before it and none after it.

{
  "title": "a short name for the example",
  "domain": "the subject it is set in, in a few words",
  "files": [
    { "path": "coins.ts", "content": "the whole file, as one JSON string" }
  ],
  "stops": [
    { "file": "coins.ts", "startLine": 1, "endLine": 4, "text": "what to notice here, and why it is the same idea" }
  ]
}

Every rule below is enforced. A reply that breaks one is discarded unread, so keep inside them:
  - at most ${maxFiles} files, each at most ${maxLinesPerFile} lines.
  - between ${minStops} and ${maxStops} stops, in the order you want them read.
  - each stop's "file" must equal one of the "path" values, character for character.
  - "startLine" and "endLine" are 1-based and inclusive, and both must be inside that file.
  - every "path" is a plain relative path. No leading "/", no "..", no backslash, no drive
    letter, and no segment beginning with a dot. Letters, digits, ".", "-", "_" and "/" only,
    at most ${MAX_DETOUR_PATH_SEGMENTS} segments deep and ${MAX_DETOUR_PATH_CHARS} characters long.
  - the example must be readable on its own — nothing to install, nothing to look up.`;
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────

/** Narrows a parse result. Exported because a caller cannot reach `.files` without it, so the
 *  check is not one a `session.ts` can forget — it does not compile. */
export function isDetourRefusal(value: unknown): value is DetourRefusal {
  return typeof value === 'object' && value !== null && 'reason' in value;
}

/** An untrusted string, shortened for a message. A refusal that quotes half a megabyte back at
 *  the learner is its own small denial of service — `src/dial/writer.ts`'s `label`, verbatim. */
function label(value: unknown): string {
  const text = typeof value === 'string' ? value : describe(value);
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

/** What a non-string is, in words — never `String(value)`, which runs a `toString` a model
 *  supplied and would print `[object Object]` at best. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function badShape(detail: string): DetourRefusal {
  return { reason: 'bad-shape', detail };
}

function unsafePath(value: unknown, detail: string): DetourRefusal {
  return { reason: 'unsafe-path', path: label(value), detail };
}

// ── the path check ──────────────────────────────────────────────────────────────────────────

/** Windows opens these as devices whatever the extension, so `CON` and `nul.txt` are a write
 *  to the console rather than to a file. Cheap to refuse and never a legitimate example. */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** The allowlist — see the header. Underscore leads legitimately (`__init__.py`); a dash does
 *  not, because a leading dash is how a filename becomes a command-line flag. */
const SEGMENT_ALLOWED = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Why `value` may not become a file under the detour directory, or `null` if it may — the
 * LEXICAL half, and only that half. `prepareDetourWrite` is the other half and neither is
 * containment on its own; treating this one as if it were IS the T-5 bug.
 *
 * The named attacks are checked before the allowlist so the sentence the panel shows names
 * what was actually wrong. The allowlist is the backstop and would refuse every one of them
 * on its own.
 */
function unsafePathReason(value: unknown): string | null {
  if (typeof value !== 'string') return `is ${describe(value)}, not a string`;
  if (value.length === 0) return 'is empty';
  if (value.trim().length === 0) return 'is only whitespace';
  if (value.length > MAX_DETOUR_PATH_CHARS) return `is longer than ${MAX_DETOUR_PATH_CHARS} characters`;
  if (value.includes('\u0000')) return 'contains a NUL byte';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'contains a control character';
  }
  if (/^[A-Za-z]:/.test(value)) return 'names a Windows drive letter';
  if (/^(?:\/\/|\\\\)/.test(value)) return 'is a UNC path';
  if (value.startsWith('/') || path.isAbsolute(value)) return 'is an absolute path';
  if (value.includes('\\')) return 'contains a backslash, which is a path separator on Windows';
  if (value.endsWith('/')) return 'ends with a path separator, so it names a directory rather than a file';

  const segments = value.split('/');
  if (segments.length > MAX_DETOUR_PATH_SEGMENTS) return `is nested more than ${MAX_DETOUR_PATH_SEGMENTS} directories deep`;
  for (const segment of segments) {
    if (segment.length === 0) return 'has an empty path segment';
    if (segment === '..') return 'contains a ".." segment, which climbs out of the detour folder';
    if (segment === '.') return 'contains a "." segment';
    if (segment.startsWith('.')) return 'has a segment beginning with a dot';
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'has a segment ending in a dot or a space, which Windows silently strips';
    if (RESERVED_DEVICE_NAMES.has((segment.split('.')[0] ?? '').toLowerCase())) return 'names a reserved Windows device';
    if (!SEGMENT_ALLOWED.test(segment)) return 'has a segment with characters outside letters, digits, dot, dash and underscore';
  }

  // Belt and braces. Nothing that survived the allowlist can escape a root arithmetically —
  // but this is the repository's own containment check, it is free, and the day a rule above
  // is loosened it is the one that still says no.
  if (resolveInsideTarget(path.resolve('/detour'), value) === null) return 'does not resolve inside the detour folder';
  return null;
}

// ── containment, the half that needs a filesystem ───────────────────────────────────────────

/**
 * Where `p` really is, or `null` when the filesystem will not say — a broken link, a loop, a
 * path that is not there, a directory nobody may traverse. Duplicated from
 * `src/dial/writer.ts`, where it is module-private, exactly as `src/tutor/context.ts`
 * duplicates it: "I could not find out where this would land" has one safe answer and it is
 * the same for every caller.
 */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The deepest ancestor of `dir` (including `dir`) that is there right now — `writer.ts`'s
 *  `deepestExisting`, and its reasoning holds word for word: this is asked in order to be
 *  `realpath`'d, and walking past a dangling link lands on the last real directory above. */
function deepestExisting(dir: string): string {
  let at = dir;
  for (;;) {
    if (fs.existsSync(at)) return at;
    const up = path.dirname(at);
    if (up === at) return at;
    at = up;
  }
}

/**
 * CREATES the directory a detour file will be written into and proves it is really inside
 * `detourDir`. Returns the absolute path to write, or a `DetourRefusal`.
 *
 * **Call this, not `parseDetourReply` alone, before any write.** It re-runs the lexical check
 * rather than trusting that the parser ran, because one forgotten call site is how this class
 * of bug comes back.
 *
 * The order is the design, and it is four steps rather than two:
 *
 *   1. the deepest ancestor that ALREADY exists is resolved and checked BEFORE anything is
 *      created — otherwise `mkdirSync(…, { recursive: true })` follows a planted link and
 *      makes directories outside the detour folder on its way down. A check that has already
 *      had a side effect by the time it says no is not much of a check;
 *   2. the directory is created, because `realpath` can only answer about a path that exists,
 *      and the question is where the directory being written into really is;
 *   3. it is resolved AGAIN, on the directory that now exists, and used immediately;
 *   4. and the FINAL component is `lstat`ed, which no directory check covers. A pre-existing
 *      symlink there is followed by an ordinary `writeFileSync`, so `coins.ts -> ~/.ssh/authorized_keys`
 *      would be a write to the target. A temp-file-and-rename write replaces the link instead,
 *      but this module does not get to assume how its caller writes.
 *
 * **A stat is a moment, not a lock.** Between step 4 and the write the path could become
 * something else. Whoever could win that race already has write access to this extension's
 * own storage directory, which is a strictly larger capability than the one this bounds — so
 * the check is where the value is, and the residue is named rather than implied.
 */
export function prepareDetourWrite(detourDir: string, relPath: unknown): string | DetourRefusal {
  const lexical = unsafePathReason(relPath);
  if (lexical !== null) return unsafePath(relPath, lexical);
  const rel = relPath as string;

  const realRoot = realOrNull(detourDir);
  if (realRoot === null) {
    return unsafePath(rel, 'is meant for a detour folder the filesystem could not resolve, so where it would land is unknown');
  }
  const abs = resolveInsideTarget(realRoot, rel);
  if (abs === null) return unsafePath(rel, 'does not resolve inside the detour folder');

  const dir = path.dirname(abs);
  const anchor = realOrNull(deepestExisting(dir));
  if (anchor === null || resolveInsideTarget(realRoot, anchor) === null) {
    return unsafePath(rel, 'reaches outside the detour folder through a symlink');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return unsafePath(rel, `needs a folder that could not be created — ${messageOf(err)}`);
  }
  const realDir = realOrNull(dir);
  if (realDir === null || resolveInsideTarget(realRoot, realDir) === null) {
    return unsafePath(rel, 'reaches outside the detour folder through a symlink');
  }

  const target = path.join(realDir, path.basename(abs));
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(target);
  } catch {
    return target; // nothing there yet — the ordinary case
  }
  if (entry.isSymbolicLink()) return unsafePath(rel, 'is already a symlink, and a write would follow it out of the detour folder');
  if (!entry.isFile()) return unsafePath(rel, 'already exists and is not an ordinary file');
  return target;
}

// ── the reply ───────────────────────────────────────────────────────────────────────────────

/**
 * How many lines a detour file has — ONE definition, used by the `maxLinesPerFile` limit and
 * by every stop's range, so the two cannot disagree about what line 60 means.
 *
 * A single trailing newline does not invent a line. Models end files with one essentially
 * always, and counting it would refuse an honest sixty-line file at exactly the limit; an
 * editor does show a final empty line there, but a stop pointing at it has nothing to say.
 * CRLF and a lone CR count as LF, since the store writes the text the model sent.
 */
export function detourLineCount(content: string): number {
  const normalized = content.replace(/\r\n?/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.split('\n').length;
}

/**
 * The JSON a model meant, dug out of whatever it wrapped the JSON in.
 *
 * Fence-tolerant and nothing more: the raw text first, then the contents of the first fenced
 * block if there is one. Deliberately NOT "the substring from the first `{` to the last `}`",
 * which would happily assemble an object out of two halves of a reply that was never one.
 */
function jsonCandidates(raw: string): string[] {
  const text = raw.replace(/^\ufeff/, '').trim();
  const candidates = [text];
  const open = /(?:^|\n)[ \t]*(```|~~~)[^\n]*\n/.exec(text);
  if (open !== null) {
    const marker = open[1] ?? '```';
    const rest = text.slice(open.index + open[0].length);
    const close = new RegExp(`\\n[ \\t]*${marker}[ \\t]*(?:\\n|$)`).exec(rest);
    // No closing fence means the reply was cut off; the tail is still the best candidate.
    candidates.push(close === null ? rest : rest.slice(0, close.index));
  }
  return candidates;
}

function stringOf(source: Record<string, unknown>, key: string): string | null {
  const value: unknown = source[key];
  return typeof value === 'string' ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A model's reply, validated into a `Detour` — or the specific reason it was thrown away.
 *
 * The order of the checks is cost, not severity: the outcome of every refusal is identical
 * (nothing is written), so the reply is refused as early as it can be. A thousand-entry
 * `files` array is answered `too-many-files` without walking it, and a file's path is checked
 * before its contents are measured, because no path is trusted long enough to be measured
 * against.
 *
 * The returned object is REBUILT from the fields this module knows, never the parsed object
 * itself — the same discipline `sanitizeTranscript` uses, so an extra key a model invented
 * (`"mode": 511`, `"command": …`) is left behind here rather than reaching a writer.
 */
export function parseDetourReply(raw: unknown): Detour | DetourRefusal {
  if (typeof raw !== 'string') return { reason: 'not-json', detail: `the reply was ${describe(raw)}, not text` };
  if (raw.trim().length === 0) return { reason: 'not-json', detail: 'the reply was empty' };
  if (raw.length > MAX_DETOUR_REPLY_CHARS) {
    return badShape(`the reply is ${raw.length} characters, and a worked example may be at most ${MAX_DETOUR_REPLY_CHARS}`);
  }

  let parsed: unknown;
  let failure = 'the reply is not JSON';
  let ok = false;
  for (const candidate of jsonCandidates(raw)) {
    try {
      parsed = JSON.parse(candidate);
      ok = true;
      break;
    } catch (err) {
      failure = messageOf(err).slice(0, 200);
    }
  }
  if (!ok) return { reason: 'not-json', detail: failure };

  if (!isPlainObject(parsed)) return badShape(`the reply parsed as ${describe(parsed)}, not a JSON object`);

  const title = stringOf(parsed, 'title');
  if (title === null || title.trim().length === 0) return badShape('"title" is missing, empty, or not a string');
  const domain = stringOf(parsed, 'domain');
  if (domain === null || domain.trim().length === 0) return badShape('"domain" is missing, empty, or not a string');

  const rawFiles: unknown = parsed['files'];
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) return badShape('"files" is missing or is not a non-empty array');
  const rawStops: unknown = parsed['stops'];
  if (!Array.isArray(rawStops)) return badShape('"stops" is missing or is not an array');

  if (rawFiles.length > DETOUR_LIMITS.maxFiles) return { reason: 'too-many-files', found: rawFiles.length };

  const files: DetourFile[] = [];
  const lines = new Map<string, number>();
  const folded = new Set<string>();
  for (let i = 0; i < rawFiles.length; i += 1) {
    const entry: unknown = rawFiles[i];
    if (!isPlainObject(entry)) return badShape(`files[${i}] is ${describe(entry)}, not an object`);
    const filePath: unknown = entry['path'];
    if (typeof filePath !== 'string') return badShape(`files[${i}].path is ${describe(filePath)}, not a string`);
    const content = stringOf(entry, 'content');
    if (content === null) return badShape(`files[${i}].content is ${describe(entry['content'])}, not a string`);

    const unsafe = unsafePathReason(filePath);
    if (unsafe !== null) return unsafePath(filePath, unsafe);
    // A repeated path means the second write silently replaces the first, and a stop naming it
    // addresses whichever won. Folded case too: one filesystem in three would merge them.
    if (lines.has(filePath)) return badShape(`files[${i}].path repeats an earlier file: ${label(filePath)}`);
    const fold = filePath.toLowerCase();
    if (folded.has(fold)) return badShape(`files[${i}].path differs from an earlier file only in case: ${label(filePath)}`);

    const count = detourLineCount(content);
    if (count > DETOUR_LIMITS.maxLinesPerFile) return { reason: 'file-too-long', path: label(filePath), lines: count };

    files.push({ path: filePath, content });
    lines.set(filePath, count);
    folded.add(fold);
  }

  if (rawStops.length < DETOUR_LIMITS.minStops || rawStops.length > DETOUR_LIMITS.maxStops) {
    return { reason: 'bad-stop-count', found: rawStops.length };
  }

  const stops: DetourStop[] = [];
  for (let i = 0; i < rawStops.length; i += 1) {
    const entry: unknown = rawStops[i];
    if (!isPlainObject(entry)) return badShape(`stops[${i}] is ${describe(entry)}, not an object`);
    const file: unknown = entry['file'];
    if (typeof file !== 'string') return badShape(`stops[${i}].file is ${describe(file)}, not a string`);
    const text = stringOf(entry, 'text');
    if (text === null) return badShape(`stops[${i}].text is ${describe(entry['text'])}, not a string`);

    const count = lines.get(file);
    if (count === undefined) return { reason: 'stop-file-unknown', file: label(file) };

    const startLine: unknown = entry['startLine'];
    const endLine: unknown = entry['endLine'];
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      return { reason: 'bad-range', file: label(file), detail: 'startLine and endLine must both be whole numbers' };
    }
    const start = startLine as number;
    const end = endLine as number;
    if (start < 1) return { reason: 'bad-range', file: label(file), detail: `startLine is ${start}; lines are numbered from 1` };
    if (end < start) return { reason: 'bad-range', file: label(file), detail: `endLine ${end} is before startLine ${start}` };
    if (end > count) return { reason: 'bad-range', file: label(file), detail: `endLine is ${end} but that file has ${count} lines` };

    stops.push({ file, startLine: start, endLine: end, text });
  }

  return { title, domain, files, stops };
}
