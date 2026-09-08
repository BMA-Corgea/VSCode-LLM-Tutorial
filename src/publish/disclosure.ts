// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE DISCLOSURE CHECK (T-8, step 6): what must NOT leave this machine inside a .vsix, and
 * what must be inside it for the extension to work at all.
 *
 * Packaging is the one stage of this project whose failure mode is not a crash. A `.vsix` is
 * a zip that goes to strangers, permanently, and the risk is that it carries something that
 * was only ever meant to be local — the factory ledger under `.autodev/`, the knowledge base,
 * a stray `.env`, a source map with the whole source tree inside it, or the owner's own name
 * in a public artifact. None of those break anything. That is exactly why a checklist does not
 * work for them: nothing goes red, and the person reading the list has read it nine times.
 *
 * So this is a set of pure predicates, exercised by unit tests against hostile synthetic input,
 * and run for real by `scripts/package.mjs` against the finished archive. A violation fails the
 * packaging step. There is no path that produces a .vsix without this having run over it.
 *
 * ── Three barriers, and the one that has to cover the other two's leftovers ───────────────
 *
 * `.vscodeignore` is the first barrier and `scripts/package.mjs`'s staging ALLOWLIST is the
 * second: the staging copy contains only the top-level entries that were named, so a directory
 * that did not exist when `.vscodeignore` was written cannot reach the archive by default. This
 * file is the third, and the only one that looks at what was actually produced rather than at
 * what was intended.
 *
 * That third barrier has to cover what the PIPELINE ITSELF creates, which is the half T-8
 * originally missed (review finding 3): the allowlist governs the copy, and `package.mjs` then
 * plants a 920 KB `vendor/<core>.tgz` inside it afterwards, because `npm install` needs the
 * tarball there. A re-zipped archive carrying that tarball passed every rule here and printed
 * its own size in the script's summary table. So `PATH_RULES` now names the intermediates a
 * packaging run creates for itself — `vendor/`, `.package-staging/`, `*.tgz` — alongside the
 * `src/`, `**\/*.ts` and `.npmrc` that `.vscodeignore` was the only thing keeping out.
 * When you argue "N independent barriers", enumerate the artifacts and check each against all N.
 *
 * ── Why the owner's name is not written down here ─────────────────────────────────────────
 *
 * This repository is public. Hardcoding the string to search for would publish the very thing
 * the rule exists to keep out of published artifacts. The needles are therefore supplied at run
 * time — `BUILD_TUTORIALS_OWNER_NAMES`, else the local git identity.
 *
 * Saying so was not enough. T-8 shipped a run that derived NO needles, printed
 * `passed VACUOUSLY`, and **exited 0** — and that is the default shape of a CI runner, where
 * `actions/checkout` configures no git identity and the environment variable is unset. So the
 * check that exists to stop the owner's name shipping did nothing, and reported success, in the
 * one place it most needed to work (review finding 2). `certifyNameScan` below is the fix, and
 * the rule it encodes is general: **the failure of a check's INPUT is a failure of the check.**
 * An empty needle list is a REFUSAL TO CERTIFY with a non-zero exit code, and the only way past
 * it is a waiver the caller types out loud — the same shape `verify-install.mjs` already uses
 * for its own unprovable half (`--allow-missing-editors`).
 *
 * ── Word boundaries, and the two false positives that are already known ───────────────────
 *
 * Short personal names hide inside ordinary English words. The AGPL text shipped as
 * `LICENSE.txt` contains a common word that has a four-letter first name sitting inside it,
 * and a substring search flags it on every single run. A check that cries wolf on every run is
 * a check people learn to pass with `|| true`. So short needles are matched with WORD
 * BOUNDARIES, which drops that class of hit entirely — see the `banana`/`ana` test, which is
 * the same shape as the real one without naming anybody.
 *
 * The other known false positive is the GitHub organisation. It is already in `package.json`'s
 * `repository` URL and in the git remote — it is public by construction, it is not a person's
 * name, and flagging it would be the same "cry wolf" failure. It is allowlisted by name below.
 *
 * ── What the short-needle scan does NOT cover, said out loud ──────────────────────────────
 *
 * Word-matching is skipped for files whose EXTENSION says a word boundary cannot mean anything
 * there — `.wasm`, `.jpg`, fonts, archives. It used to be skipped for any file with a NUL byte
 * in its first 8 KiB, which is a different question with a different answer: repo-tour's
 * `dist/architecture.js` joins two map keys with a NUL separator, so 9 KB of ordinary compiled
 * JavaScript was classified binary and exempted (review finding 4). Extensions are asked now,
 * and the exemptions are reported BY NAME rather than as a count, because a count makes an
 * exclusion look surveyed — a list would have shown a `.js` file sitting among the `.wasm`s.
 *
 * The limit that remains, stated rather than left to be discovered: **image metadata is in
 * scope for specific needles and for every credential rule, and out of scope for short names.**
 * `assets/img/hero-alt.jpg` really does ship XMP carrying a third party's name in
 * `<dc:creator>` (correctly credited in `credits.json`, so not a breach of the "the owner"
 * rule). XMP and IPTC are literal ASCII inside the file, so the latin1 scan reads them: an
 * email, anything twelve characters or longer, and every credential shape WOULD be caught in
 * there. A short first name inside a JPEG's metadata would not be. Narrowing that further means
 * decoding image metadata, which is a parser this check does not want to own.
 */

import { EXPECTED_GRAMMARS } from '../doctor.js';

/** A thing found in the archive that should not be there. */
export interface Violation {
  /** which rule fired — stable, so tests and output agree */
  rule: string;
  /** the archive entry it fired on */
  entry: string;
  /** what was found, in a sentence */
  detail: string;
}

/** A path that must never appear in a shipped archive. */
export interface PathRule {
  id: string;
  why: string;
  /**
   * @param rel  the path relative to the extension root (`extension/` already stripped)
   * @param entry the raw archive entry, for rules that care about archive metadata
   */
  matches: (rel: string, entry: string) => boolean;
}

const segments = (p: string): string[] => p.split('/').filter((s) => s.length > 0);
const basename = (p: string): string => segments(p).at(-1) ?? '';

/**
 * `.env.example` and its siblings are the placeholders projects commit ON PURPOSE. Withholding
 * them is the failure T-12's review found in the product half of this same idea, and flagging
 * them here would be the cry-wolf version of it: a violation on every run of a project that
 * ships a perfectly ordinary example file.
 */
const ENV_PLACEHOLDERS = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults']);

export const PATH_RULES: readonly PathRule[] = [
  {
    id: 'autodev-ledger',
    why: 'the factory ledger, every review and every piece of evidence live under .autodev/ and are local-only',
    matches: (rel) => segments(rel).includes('.autodev'),
  },
  {
    id: 'shop-overlay',
    why: 'autodev/ is the process config for BUILDING this extension, not part of it',
    matches: (rel) => rel === 'autodev' || rel.startsWith('autodev/'),
  },
  {
    id: 'knowledge-base',
    why: 'kb/ holds working notes and day pages — internal, and kb/days/ is untracked for a reason',
    matches: (rel) => rel === 'kb' || rel.startsWith('kb/'),
  },
  {
    id: 'env-file',
    why: 'a .env is where credentials live; there is no version of shipping one that is fine',
    matches: (rel) => {
      const base = basename(rel);
      if (ENV_PLACEHOLDERS.has(base)) return false;
      return base === '.env' || base.startsWith('.env.');
    },
  },
  {
    id: 'source-map',
    why: 'a .map embeds the original sources — it re-ships src/ through the back door after .vscodeignore excluded it',
    matches: (rel) => rel.endsWith('.map'),
  },
  {
    id: 'test-bundle',
    why: 'dist/test/ is the compiled test suite: unreachable from main, and a quarter of a megabyte of it',
    matches: (rel) => rel === 'dist/test' || rel.startsWith('dist/test/'),
  },
  {
    id: 'git-directory',
    why: 'a .git directory in an archive carries the entire history, including anything ever committed and removed',
    matches: (rel) => segments(rel).includes('.git'),
  },
  {
    id: 'scratch-directory',
    why: '.scratch/ and .vscode-test/ are local working directories; neither is part of the extension',
    matches: (rel) => segments(rel).some((s) => s === '.scratch' || s === '.vscode-test'),
  },
  {
    id: 'packaging-intermediate',
    why: 'vendor/, .package-staging/ and *.tgz are what a packaging run builds for ITSELF — the core tarball is 920 KB of duplicate, and the staging copy is a second manifest',
    matches: (rel) =>
      segments(rel).some((s) => s === 'vendor' || s === '.package-staging') || rel.endsWith('.tgz'),
  },
  {
    id: 'source-tree',
    why: 'src/ and test/ are the sources dist/ was built from; shipping them re-ships the whole repository through the door .vscodeignore closed',
    matches: (rel) => {
      const first = segments(rel)[0];
      return first === 'src' || first === 'test';
    },
  },
  {
    id: 'typescript-source',
    why: 'a .ts or .d.ts is source, not the bundle — the same back door as a source map, one file at a time',
    matches: (rel) => rel.endsWith('.ts') || rel.endsWith('.tsx') || rel.endsWith('.mts') || rel.endsWith('.cts'),
  },
  {
    id: 'npm-config',
    why: 'an .npmrc is where a registry auth token lives; it is the .env of the npm world and there is no version of shipping one that is fine',
    matches: (rel) => basename(rel) === '.npmrc' || basename(rel) === '.yarnrc' || basename(rel) === '.yarnrc.yml',
  },
];

/** A credential shape worth failing a build over. */
export interface SecretRule {
  id: string;
  /**
   * Cheap literal prefilter(s) run over raw bytes before the regex, so 50 MB of wasm stays
   * fast. Any one of them present is enough to pay for the regex; none present means the
   * pattern cannot match, so it is never run.
   */
  prefilter: string | readonly string[];
  pattern: RegExp;
}

/**
 * The shapes, in the order they were added. The first four were T-8's; the rest are what a
 * fifteen-shape probe found missing (review finding 5) — chosen for what THIS project is most
 * likely to leak rather than for what a generic scanner ships with. `sk-ant-` is first among
 * them because it is the credential this extension's own tutor and detour spend money through.
 *
 * Every pattern demands a plausible payload after its prefix, so prose that merely names a
 * shape ("the token starts with glpat-") is not a violation. A rule that fires on a README is
 * a rule people learn to pass with `|| true`.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'stripe-live-key', prefilter: 'sk_live_', pattern: /sk_live_[A-Za-z0-9]{8,}/ },
  { id: 'github-token', prefilter: 'ghp_', pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { id: 'aws-access-key-id', prefilter: 'AKIA', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    id: 'private-key-header',
    prefilter: '-----BEGIN',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
  { id: 'anthropic-key', prefilter: 'sk-ant-', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-project-key', prefilter: 'sk-proj-', pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-fine-grained-token', prefilter: 'github_pat_', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  {
    id: 'github-oauth-token',
    prefilter: ['ghs_', 'gho_', 'ghu_', 'ghr_'],
    pattern: /\b(?:ghs|gho|ghu|ghr)_[A-Za-z0-9]{20,}/,
  },
  { id: 'gitlab-token', prefilter: 'glpat-', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  {
    id: 'slack-token',
    prefilter: ['xoxb-', 'xoxp-', 'xoxa-', 'xoxs-', 'xoxe-'],
    pattern: /xox[bpase]-[A-Za-z0-9-]{20,}/,
  },
  {
    id: 'npm-auth-token',
    prefilter: '_authToken',
    pattern: /_authToken\s*=\s*[A-Za-z0-9_\-.~+/=]{16,}/,
  },
  {
    // Contextual on purpose. A bare 40-character base64 run cannot be told apart from compiled
    // data, and a rule that fires inside every .wasm is a rule that gets deleted — so this asks
    // for the key's NAME beside the value, which is the shape a leaked config actually has.
    id: 'aws-secret-access-key',
    prefilter: ['aws_secret_access_key', 'aws-secret-access-key', 'AWS_SECRET_ACCESS_KEY'],
    pattern: /aws[_-]secret[_-]access[_-]key["'\s]*[:=]["'\s]*[A-Za-z0-9/+=]{40}/i,
  },
  {
    id: 'jwt',
    prefilter: 'eyJ',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
];

/**
 * Identities that LOOK like a personal name to a naive check but are public by construction:
 * the GitHub organisation, the marketplace publisher id, and the git author name this project
 * commits under. All three are already in `package.json` and in the git remote URL. Flagging
 * them would produce a violation on every run, which is how a check gets ignored.
 */
export const PUBLIC_IDENTITIES: readonly string[] = ['corgea', 'bma-corgea', 'build-tutorials', 'repo-tour'];

export interface OwnerNeedleSources {
  /** BUILD_TUTORIALS_OWNER_NAMES — comma separated. When set, it is the whole list. */
  envValue?: string | null;
  gitName?: string | null;
  gitEmail?: string | null;
  publicIdentities?: readonly string[];
}

/**
 * Works out what personal identifiers to search the archive for, without any of them being
 * written down in this repository.
 *
 * An explicit `BUILD_TUTORIALS_OWNER_NAMES` REPLACES the derived list rather than adding to it:
 * the caller who sets it knows exactly who they are checking for, and silently appending a
 * derived value would make the result depend on whose machine it ran on.
 */
export function ownerNeedlesFrom(sources: OwnerNeedleSources): string[] {
  const publicIds = (sources.publicIdentities ?? PUBLIC_IDENTITIES).map((s) => s.toLowerCase());
  const raw =
    typeof sources.envValue === 'string' && sources.envValue.trim().length > 0
      ? sources.envValue.split(',')
      : [sources.gitName ?? '', sources.gitEmail ?? ''];

  const seen = new Set<string>();
  const needles: string[] = [];
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (trimmed.length < 3) continue; // two characters is not an identity, it is a coincidence
    const lower = trimmed.toLowerCase();
    if (publicIds.includes(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    needles.push(trimmed);
  }
  return needles;
}

/** The one way past an empty needle list, and the caller has to type it. */
export const VACUOUS_NAME_SCAN_FLAG = '--allow-vacuous-name-scan';

export interface NameScanSources extends OwnerNeedleSources {
  /**
   * Why `git` could not be consulted, when it could not — the binary missing from `PATH`, a
   * non-zero exit, a spawn error. NEVER conflated with a git that answered empty: those are two
   * different facts, and reading the first as the second is the failure kb/wiki/lessons.md
   * records as "an absent value read as a meaningful one" (T-13).
   */
  gitUnavailable?: string | null;
  /** the caller said, in the invocation, that it accepts an archive whose name half was not checked */
  allowVacuous?: boolean;
}

export interface NameScanCertification {
  /** `certified` — needles were derived and searched for; `refused` — none were, and that is a
   *  failure; `waived` — none were, and the caller said out loud that it accepts that. */
  kind: 'certified' | 'refused' | 'waived';
  needles: string[];
  /**
   * The exit code this certification demands. `2` is deliberately distinct from the `1` a real
   * violation produces: "I could not check" and "I checked and found something" are different
   * answers, and a caller that cannot tell them apart will eventually treat one as the other.
   */
  exitCode: 0 | 2;
  /** the line to print — for a refusal, what was not done and why */
  message: string;
  /** how to make the check able to run, in the caller's own hands */
  remedy: string;
}

/**
 * Decides whether the NAME half of the disclosure check may report a result at all.
 *
 * THE RULE: the failure of a check's input is a failure of the check. T-8 shipped the other
 * answer — with no `BUILD_TUTORIALS_OWNER_NAMES` and no usable git identity it printed
 * `passed VACUOUSLY` and exited 0, which is the default shape of a GitHub Actions runner, so
 * the check that exists to stop the owner's name shipping did nothing and said "verified" in
 * the one place it most needed to work (review finding 2).
 *
 * `scripts/package.mjs` already applies exactly this rule to `unzip`, and with exactly the
 * right argument: *"an unverified archive is the failure this whole script exists to prevent."*
 * The dependency that decides whether half the check runs at all now gets the same treatment.
 *
 * Pure, so the rule is testable without a filesystem, an archive or a git.
 */
export function certifyNameScan(sources: NameScanSources): NameScanCertification {
  const needles = ownerNeedlesFrom(sources);
  if (needles.length > 0) {
    return {
      kind: 'certified',
      needles,
      exitCode: 0,
      message: `personal identifiers checked: ${needles.length}`,
      remedy: '',
    };
  }

  const why =
    typeof sources.gitUnavailable === 'string' && sources.gitUnavailable.length > 0
      ? `git could not be consulted (${sources.gitUnavailable})`
      : 'the local git identity supplied nothing to search for — it was unset, or entirely public identifiers';
  const remedy =
    `set BUILD_TUTORIALS_OWNER_NAMES to a comma-separated list of the identifiers that must not ship ` +
    `(a name and an email; supply it from a secret — never commit it to this public repository), ` +
    `or configure a git identity in this checkout (git config user.name / git config user.email). ` +
    `To package an archive whose name half is knowingly unchecked, pass ${VACUOUS_NAME_SCAN_FLAG} ` +
    `and read the line it prints: that archive is not certified against a personal name.`;

  if (sources.allowVacuous === true) {
    return {
      kind: 'waived',
      needles: [],
      exitCode: 0,
      message:
        `the name half was NOT checked (${why}), and ${VACUOUS_NAME_SCAN_FLAG} was given. ` +
        `This archive is NOT certified against a personal name.`,
      remedy,
    };
  }

  return {
    kind: 'refused',
    needles: [],
    exitCode: 2,
    message:
      `the name half of the disclosure check was NOT performed: BUILD_TUTORIALS_OWNER_NAMES is unset and ${why}. ` +
      `A check that checked nothing does not get to report success.`,
    remedy,
  };
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A needle long and distinctive enough to be searched for in ANY file, binary included: an
 * email address, or something long enough that a chance match in compiled wasm is not a real
 * possibility. Short needles are word-matched in text only — a "word boundary" is a property of
 * text, and asserting one inside a 2 MB grammar binary means nothing.
 */
function isSpecificNeedle(needle: string): boolean {
  return needle.includes('@') || needle.length >= 12;
}

/**
 * "No NUL byte in the first 8 KiB" — the heuristic git uses, kept for one job only: the
 * STATISTIC the packaging script prints beside the file count.
 *
 * It is deliberately NOT what decides whether a file is word-scanned any more. Those are two
 * different questions — "does this look like text to a diff tool" and "can a word boundary
 * mean anything here" — and answering the second with the first is what exempted 9 KB of
 * ordinary compiled JavaScript from the name scan because byte 7254 was a NUL used as a map-key
 * separator (T-8 review, finding 4).
 */
export function looksTextual(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

/**
 * File types in which a WORD BOUNDARY is not a thing that exists: compiled modules, images,
 * fonts, archives, media. Asserting `\bana\b` inside a 2 MB grammar binary means nothing, and
 * that is still true — but it is true because of what the file IS, not because of which bytes
 * happen to sit in its first page.
 */
const OPAQUE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.wasm', '.node', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat', '.class', '.pyc',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff', '.psd',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.br', '.zst',
  '.pdf', '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.db', '.sqlite', '.sqlite3',
]);

/**
 * Whether a short needle can be word-matched in this entry, decided by what kind of file it is.
 *
 * Anything not on the opaque list is scanned, including a file with no extension at all
 * (`build-tutorials`, `NOTICE`) and a dotfile (`.npmrc`) — the default is COVERAGE, and an
 * exemption has to be named. That is the direction the old NUL probe had backwards: it let any
 * shipped `.js`, `.json` or `.md` fall out of the scan silently, and reported the fact as a
 * count that read like coverage.
 */
export function isWordScannable(entry: string): boolean {
  const base = basename(relativeToExtension(entry)).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true; // no extension, or a dotfile — both are text until proven otherwise
  return !OPAQUE_EXTENSIONS.has(base.slice(dot));
}

export interface ArchiveScanOptions {
  /** personal identifiers that must not appear anywhere in the archive */
  ownerNeedles: readonly string[];
  pathRules?: readonly PathRule[];
  secretRules?: readonly SecretRule[];
}

export interface ArchiveScanResult {
  violations: Violation[];
  filesScanned: number;
  /** the git heuristic's answer, reported as a statistic — see `looksTextual` */
  textFilesScanned: number;
  /**
   * Every entry the short-needle word scan could not cover, BY NAME.
   *
   * A count made the exclusion look surveyed: `42 binaries excluded` is a number nobody can
   * audit, and it was hiding one `.js` file among 39 `.wasm`s and 2 `.jpg`s. A list is a thing
   * a reader can disagree with. Reported whether or not a short needle exists, because it is a
   * property of the archive rather than of the run.
   */
  nameScanExemptions: string[];
  needlesChecked: readonly string[];
}

/** Strips the `extension/` prefix every payload entry in a .vsix carries. */
export function relativeToExtension(entry: string): string {
  return entry.startsWith('extension/') ? entry.slice('extension/'.length) : entry;
}

/** Path rules only — cheap, and the half that needs no file contents. */
export function checkPaths(entries: readonly string[], rules: readonly PathRule[] = PATH_RULES): Violation[] {
  const violations: Violation[] = [];
  for (const entry of entries) {
    const rel = relativeToExtension(entry);
    for (const rule of rules) {
      if (rule.matches(rel, entry)) {
        violations.push({ rule: rule.id, entry, detail: rule.why });
      }
    }
  }
  return violations;
}

/** Content rules for one file: credential shapes anywhere, personal identifiers as words. */
export function checkContent(entry: string, bytes: Buffer, options: ArchiveScanOptions): Violation[] {
  const violations: Violation[] = [];
  const secretRules = options.secretRules ?? SECRET_RULES;
  const wordScannable = isWordScannable(entry);

  // latin1 keeps a 1:1 byte-to-char mapping, so an ASCII credential is found in a binary file
  // just as reliably as in a text one, and no byte sequence becomes a replacement character.
  let decoded: string | null = null;
  const text = (): string => (decoded ??= bytes.toString('latin1'));

  for (const rule of secretRules) {
    const prefilters = typeof rule.prefilter === 'string' ? [rule.prefilter] : rule.prefilter;
    if (!prefilters.some((p) => bytes.includes(p))) continue;
    const hit = rule.pattern.exec(text());
    if (hit) {
      violations.push({
        rule: `secret:${rule.id}`,
        entry,
        detail: `matched ${rule.id} at byte ${hit.index} — a credential shape must never be inside a published archive`,
      });
    }
  }

  for (const needle of options.ownerNeedles) {
    if (isSpecificNeedle(needle)) {
      // Long and distinctive: searched byte-for-byte, in every file, case-insensitively.
      const index = text().toLowerCase().indexOf(needle.toLowerCase());
      if (index >= 0) {
        violations.push({
          rule: 'owner-identity',
          entry,
          detail: `a personal identifier appears at byte ${index} — this repository is public and its artifacts say "the owner"`,
        });
      }
      continue;
    }
    // A word boundary is a text concept. Which files that excludes is reported BY NAME by the
    // caller, so the gap is auditable rather than a number.
    if (!wordScannable) continue;
    const pattern = new RegExp(`\\b${escapeForRegex(needle)}\\b`, 'i');
    const hit = pattern.exec(text());
    if (hit) {
      violations.push({
        rule: 'owner-identity',
        entry,
        detail: `a personal name appears as a whole word at byte ${hit.index} — this repository is public and its artifacts say "the owner"`,
      });
    }
  }

  return violations;
}

/**
 * The whole check, over a real archive's entry list plus a reader for its bytes. `read` is
 * injected so the unit tests drive this with a Map and never touch a filesystem, while
 * `scripts/package.mjs` drives it over the actual unzipped .vsix.
 */
export function checkArchive(
  entries: readonly string[],
  read: (entry: string) => Buffer,
  options: ArchiveScanOptions,
): ArchiveScanResult {
  const violations = checkPaths(entries, options.pathRules);
  let filesScanned = 0;
  let textFilesScanned = 0;
  const nameScanExemptions: string[] = [];

  for (const entry of entries) {
    const bytes = read(entry);
    filesScanned += 1;
    if (looksTextual(bytes)) textFilesScanned += 1;
    if (!isWordScannable(entry)) nameScanExemptions.push(entry);
    violations.push(...checkContent(entry, bytes, options));
  }

  return {
    violations,
    filesScanned,
    textFilesScanned,
    nameScanExemptions,
    needlesChecked: options.ownerNeedles,
  };
}

// ── The other half: what MUST be in the archive ───────────────────────────────────────────
//
// AC2 is not "nothing bad shipped", it is "the core shipped". A .vsix missing the WASM
// grammars installs, activates, and looks perfectly healthy right up until the first real
// digest — which is a long way from the packaging change that caused it. So the required
// content is asserted with the same force as the forbidden content, in the same place.

export interface ContentRequirement {
  id: string;
  why: string;
  matches: (rel: string) => boolean;
  /** how many matching entries are the minimum for this to count as present */
  atLeast: number;
}

/**
 * The four grammars `src/doctor.ts` asks `initParsers` for — the ones a naive files list drops.
 *
 * IMPORTED, not copied. This was a second literal whose only connection to the first was a
 * comment saying which file to go and read (T-8 review, finding 11 — T-7's recorded
 * `DETOUR_LIMITS` lesson, one ticket later). Neither module touches `vscode`, so the archive
 * check reads the doctor's own list and a fifth grammar added there is shipped by definition.
 */
export const REQUIRED_GRAMMARS = EXPECTED_GRAMMARS;

export const REQUIRED_CONTENT: readonly ContentRequirement[] = [
  {
    id: 'core-dist',
    why: 'repo-tour\'s compiled core — without it the extension resolves nothing and the doctor reports "core NOT found"',
    matches: (rel) => rel.startsWith('node_modules/repo-tour/dist/') && rel.endsWith('.js'),
    atLeast: 5,
  },
  {
    id: 'core-package-json',
    why: 'the core\'s package.json carries the exports map that makes the doctor report via: exports',
    matches: (rel) => rel === 'node_modules/repo-tour/package.json',
    atLeast: 1,
  },
  {
    id: 'core-schema',
    why: 'repo-tour/schema/*.json is read by filesystem path, not through the exports map',
    matches: (rel) => rel.startsWith('node_modules/repo-tour/schema/'),
    atLeast: 1,
  },
  {
    id: 'web-tree-sitter',
    why: 'the tree-sitter runtime repo-tour loads its grammars into',
    matches: (rel) => rel.startsWith('node_modules/web-tree-sitter/'),
    atLeast: 1,
  },
  {
    id: 'web-tree-sitter-wasm',
    why: 'web-tree-sitter is a WASM runtime: its own tree-sitter.wasm has to travel with it',
    matches: (rel) => rel.startsWith('node_modules/web-tree-sitter/') && rel.endsWith('.wasm'),
    atLeast: 1,
  },
  ...REQUIRED_GRAMMARS.map((lang) => ({
    id: `grammar-${lang}`,
    why: `the ${lang} grammar the doctor asks initParsers() for — its absence is invisible until the first real digest`,
    matches: (rel: string) => rel === `node_modules/tree-sitter-wasms/out/tree-sitter-${lang}.wasm`,
    atLeast: 1,
  })),
];

export interface RequirementResult {
  id: string;
  why: string;
  count: number;
  atLeast: number;
  ok: boolean;
}

export function checkRequiredContent(
  entries: readonly string[],
  requirements: readonly ContentRequirement[] = REQUIRED_CONTENT,
): RequirementResult[] {
  const rels = entries.map(relativeToExtension);
  return requirements.map((req) => {
    const count = rels.filter((rel) => req.matches(rel)).length;
    return { id: req.id, why: req.why, count, atLeast: req.atLeast, ok: count >= req.atLeast };
  });
}
