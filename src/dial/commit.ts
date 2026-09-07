// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One git commit per completed step, in the LEARNER'S OWN repository (spec §5.4, AC7). Of
 * the three dial modules built together against `./core.ts`'s pinned shape (`writer.ts`
 * decides what to write, `check.ts` decides whether a step passed), this is the only one
 * that touches git, and it touches nothing else — no parsing, no scaffolding, no structural
 * comparison. Given a target folder, the step that just finished, and the files that step
 * wrote, it stages exactly those files and commits exactly those paths — `git commit … --
 * <paths>`, never a bare `git commit` — with a subject naming the ordinal, the question, and
 * the option the plan says was actually taken.
 *
 * ## Why a missing identity is a REFUSAL, never a default
 *
 * The easy shortcut is `git commit -c user.name=... -c user.email=...`, or `--author`, which
 * would make every target committable on the first try — in a fresh clone, in CI, in a
 * container with no `~/.gitconfig` at all. That ease is exactly the problem: the resulting
 * history would carry an identity the learner never chose, permanently, on a repository that
 * is theirs to keep and push and be credited by. A tutorial extension inventing a commit
 * author on someone's behalf is not a convenience; it is graffiti with a name attached that
 * is not the person who actually typed the code.
 *
 * So `identityConfigured` exists to tell the difference between "there is no identity here"
 * and "there is one", and `commitStep` acts on that difference honestly: no identity means no
 * commit, reported once through `CommitResult.reason` so the panel can say so and move on
 * (`buildTutorials.commitPerStep` also lets a learner turn this off entirely). The learner
 * keeps exactly the option every git user already has — run `git config user.name`/
 * `user.email` themselves, locally or globally, whenever they like — and the very next
 * completed step commits normally, with no state this module needs to remember in between.
 * Any fallback identity here would be a guess wearing the costume of a fact.
 *
 * ## Why the commit NAMES its paths
 *
 * `git add <paths>` does not scope a commit. A bare `git commit -m <subject>` takes the WHOLE
 * INDEX, so staging exactly the step's files buys nothing on its own: whatever the learner had
 * already staged rides along, into the step's commit, under the step's subject. That is not a
 * hypothetical — this extension `git init`s the folder for them, VS Code's *Stage All Changes*
 * is one click, and the result is a learner's `.env` and their scratch notes landing in a
 * commit titled `7: Why does the tokenizer get its own module? — What the author did`, on the
 * repository they are about to push under their own name.
 *
 * So the commit carries a pathspec: `git commit -q -m <subject> -- <paths>`. A pathspec
 * implies `--only`, which builds the commit from HEAD plus exactly those paths and leaves
 * every other staged entry staged — still the learner's, to commit when and how they choose.
 * Checked against the real binary, including the no-HEAD case of a repository this module has
 * only just created, where the partial commit leaves the rest of the index intact; "nothing to
 * commit" remains the ordinary refusal it always was when the named paths hold no change.
 *
 * It also closes the self-inflicted variant: when `commit` fails after `add` has succeeded (a
 * stale `index.lock`, someone's `pre-commit` hook), the step's file is left staged — and the
 * NEXT step's commit, named to its own paths, no longer sweeps it up under the wrong subject.
 *
 * The `add` is still load-bearing, not a leftover: a pathspec matching nothing git knows about
 * is a hard error rather than an empty commit, so a brand-new file has to enter the index
 * before the commit is allowed to name it.
 *
 * ## No `vscode`, and no unhandled rejections
 *
 * Deliberately no `vscode` import, same house style as `src/start/build.ts`, `src/dial/
 * core.ts` and `src/dial/check.ts`: this runs under the plain-mocha unit bundle
 * (`esbuild.mjs` marks `repo-tour`/`mocha` external for `test/unit/*`, not `vscode`), and its
 * tests below run it against real temporary directories and the real `git` binary — a faked
 * `GitRunner` would only prove this file calls its own mock correctly, not that `git add`/
 * `git commit` do what the paragraphs above claim.
 *
 * `GitRunner` (`src/start/build.ts`) is async and REJECTS on a non-zero exit, with git's own
 * stderr as the message. That is git's normal way of saying "the key you asked for is not
 * set", "there is nothing to commit" or "this is not a repository" as much as it is a real
 * failure, so every call here is wrapped: a rejected `git config` reads as an empty value, a
 * rejected `rev-parse` as "not a repository yet", and a rejected `init`/`add`/`commit` becomes
 * a `CommitResult` with that message as `reason`. Nothing in this module ever lets a
 * `GitRunner` rejection propagate, because `commitStep` runs off a `step:check`/*Next* webview
 * message (`src/walk/session.ts`) — a promise nobody is holding a `.catch` on, and whose
 * once-per-session error notice can only throttle what comes back as a VALUE. That is why
 * `commitStep`'s `try` opens at `ensureRepo` rather than after it: `git init` is a `GitRunner`
 * call like every other, and on a machine with no `git` on `PATH` it is the FIRST one to fail
 * — once per step, on all sixty-one of them, if its rejection is left to escape.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { GitRunner } from '../start/build.js';
import type { StepLike } from '../walk/model.js';
import { resolveInsideTarget } from '../walk/paths.js';

/** What `commitStep` (and, upstream of it, `identityConfigured`) actually did — never a throw,
 *  see this file's header. `reason` is set on every `committed: false`, so the panel always
 *  has something to show rather than a silent no-op. */
export interface CommitResult {
  committed: boolean;
  reason?: string;
}

/**
 * "Would a `git commit` run here land in a repository that already exists?" — asked of git
 * itself, cwd `target`, because no `fs` check can answer it. Outside any repository git exits
 * non-zero, which is its ordinary way of saying "no" (exactly like the unset key in
 * `configValue`), so that rejection reads as `false` rather than propagating.
 */
async function insideWorkTree(target: string, git: GitRunner): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], target)).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * `git init -q` when `target` is not inside a working tree yet; a no-op — no `init`, nothing
 * written — when it already is. Cheap enough to call at the top of every `commitStep`, which
 * is exactly how it is used.
 *
 * The question is "is this INSIDE a working tree", not "is there a `.git` HERE", and the
 * difference is a learner's history. `fs.existsSync(<target>/.git)` answers the second: it is
 * true only at the ROOT of a repository, so a target that sits *inside* one — a folder the
 * learner made under a repo they already keep — reads as ungoverned and gets a brand-new
 * NESTED repository created inside it. Every step then commits into that inner repo, and the
 * learner's own `git log`, run where they expect to run it, never shows a single one of them.
 *
 * `git rev-parse --is-inside-work-tree` is the question AC7's "git-inited if needed" actually
 * means, and it answers `true` for all three shapes that must not be re-inited: the root of a
 * repository, any subdirectory of one, and a `.git` that is a FILE rather than a directory (a
 * linked worktree or a submodule, whose real gitdir lives elsewhere). It is read-only in every
 * one of them, so an already-established repo's history and config are never touched by a step
 * that merely happens to run first.
 */
export async function ensureRepo(target: string, git: GitRunner): Promise<void> {
  const already = await insideWorkTree(target, git);
  if (!already) await git(['init', '-q'], target);
  // Written on BOTH paths, and the already-a-repository path is the one that matters most —
  // see `ensureTranscriptIgnored`. Awaited rather than fired off so that `commitStep`'s single
  // `try` covers it like everything else here.
  await ensureTranscriptIgnored(target, git);
}

/**
 * The directory this extension keeps a tutorial in, as a `.gitignore` pattern.
 *
 * Unanchored on purpose: `<target>` can itself be a subdirectory of the learner's repository,
 * in which case the folder is at `<repo>/<something>/.repo-tour/` and a rooted `/.repo-tour/`
 * would miss it entirely. An unanchored directory pattern matches at any depth, which is
 * exactly the question being asked — "wherever this thing is, do not commit it".
 */
export const TUTORIAL_DIR_IGNORE = '.repo-tour/';

/** The line written above the pattern, so a learner who does open the file finds out who put
 *  it there and can delete it. An ignore rule nobody can attribute is its own small mystery. */
export const TUTORIAL_IGNORE_HEADER =
  '# Added by the Build Tutorials extension: this folder holds the tutorial plan, your';

const TUTORIAL_IGNORE_BLOCK = [
  '',
  TUTORIAL_IGNORE_HEADER,
  '# progress, and your conversations with the tutor. Delete these three lines to commit it.',
  TUTORIAL_DIR_IGNORE,
  '',
].join('\n');

/**
 * Make `.repo-tour/` uncommittable in whatever repository `target` sits in (security review
 * finding 12).
 *
 * `progress.json` used to hold statuses, a dial and a verdict. Since T-6 it holds free text —
 * the learner's own questions and a model's answers — at `<target>/.repo-tour/build/
 * progress.json`, in a folder this module `git init`s for them. `commitStep`'s own commits are
 * pathspec-scoped and never sweep it up, which was checked and is true. What sweeps it up is
 * the learner's own `git add -A`, one click of VS Code's *Stage All Changes*, in a repository
 * this extension created — the ordinary path, where nobody did anything wrong.
 *
 * ## `.git/info/exclude`, not a `.gitignore` in their project
 *
 * The two mechanisms differ in exactly the way that decides this. A tracked `.gitignore` is
 * this extension writing a file into somebody's project that then shows up in their `git
 * status`, rides into their next commit, and travels to everyone who clones it — a permanent
 * edit to their repository's content, made without asking, to say something that is only true
 * while this extension is running on this machine. `.git/info/exclude` is git's own mechanism
 * for exactly that: a per-checkout ignore list, invisible in `git status`, never committed,
 * never pushed. It does not survive a clone — and it does not need to, because what it hides
 * is a directory this extension creates where it runs, and it writes the rule again wherever
 * it next runs.
 *
 * ## Written when the repository already existed, too
 *
 * `ensureRepo` no-ops when `target` is already inside a working tree, and it would have been
 * easy to make this follow it. That would cover the wrong half. A learner working inside a
 * repository of their own — their real project, with their real history, which they push — is
 * precisely the case where a committed transcript costs them something, and the fresh-init
 * case is the one where the repository is a scratch folder this extension just made. So the
 * rule is written on both paths.
 *
 * ## Never throws, and never writes twice
 *
 * Idempotent by reading first: the pattern is matched line-by-line, so running this on every
 * commit — which is what `ensureRepo` does — appends nothing after the first time, and an
 * exclude file the learner already has is appended to rather than replaced. Every failure is
 * swallowed: a repository whose `.git` is unreadable, a `--git-dir` git will not answer, a
 * read-only checkout. This runs in front of a commit the learner asked for and in front of a
 * question they asked; a hardening step that could not happen is not a reason to refuse either
 * of them, and `commitStep` has no channel for a sentence about it that would not read as the
 * commit having failed.
 */
export async function ensureTranscriptIgnored(target: string, git: GitRunner): Promise<void> {
  try {
    // `--git-dir` rather than `fs.existsSync(<target>/.git)`, for the reason `insideWorkTree`
    // gives: the answer is a path (absolute, or relative to `target`), and it is correct for a
    // subdirectory of a repository, for a linked worktree and for a submodule, all three of
    // which keep their real gitdir somewhere else entirely.
    const raw = (await git(['rev-parse', '--git-dir'], target)).trim();
    if (raw === '') return;
    const info = path.resolve(target, raw, 'info');
    const excludeFile = path.join(info, 'exclude');

    let existing = '';
    try {
      existing = fs.readFileSync(excludeFile, 'utf8');
    } catch {
      // No exclude file yet is the ordinary state of a repository git just created; the write
      // below makes one. Any other read failure lands here too and is treated the same way,
      // which is safe in the one direction that matters: the pattern is appended rather than
      // the file replaced, so nothing a learner wrote can be lost by a read that failed.
      existing = '';
    }
    if (existing.split('\n').some((line) => line.trim() === TUTORIAL_DIR_IGNORE)) return;

    fs.mkdirSync(info, { recursive: true });
    // A leading newline when the file does not already end in one, so this never joins itself
    // onto somebody's last pattern and silently changes what it matches.
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludeFile, separator + TUTORIAL_IGNORE_BLOCK);
  } catch {
    // See the header: hardening that could not happen is not a reason to refuse the commit or
    // the question it runs in front of.
  }
}

/**
 * One config key, resolved the way `git commit` itself would resolve it from inside `target`
 * — local overriding global overriding system — never forced to `--local` alone, because a
 * learner with a perfectly good identity in their global `~/.gitconfig` and nothing set
 * locally is not missing an identity. A `GitRunner` rejection means the key is not set at any
 * level; that is git's ordinary answer for an unset key, not a failure, so it reads back as
 * `''` rather than throwing.
 */
async function configValue(target: string, key: string, git: GitRunner): Promise<string> {
  try {
    return (await git(['config', key], target)).trim();
  } catch {
    return '';
  }
}

/**
 * True only when BOTH `user.name` and `user.email` resolve to something non-empty in this
 * repository. Half an identity is not an identity `git commit` can actually use — it fails
 * the commit the same way "neither" does — so `commitStep` treats the two cases identically
 * rather than reporting a more specific reason for a distinction that changes nothing about
 * what happens next.
 */
export async function identityConfigured(target: string, git: GitRunner): Promise<boolean> {
  const [name, email] = await Promise.all([
    configValue(target, 'user.name', git),
    configValue(target, 'user.email', git),
  ]);
  return name.length > 0 && email.length > 0;
}

/**
 * `"<ordinal>: <question> — <label of the taken option>"` (AC7). Exported so the panel and
 * `test/unit/dial-commit.test.ts` both read this ONE function rather than three hand-copied
 * templates that drift the first time the format changes.
 *
 * Reads `taken` alone — deliberately UNLIKE `src/walk/step-view.ts`'s rendering, which falls
 * back to `decision.authorChoice` when no option carries `taken` (a real plan can apparently
 * ship that way; see that file's header). A commit subject is not a rendering nicety where a
 * best-effort guess is harmless: it is text a learner's own `git log` carries forever, on
 * their own repository, and `authorChoice` names an option that `chosen` — the field that
 * actually reflects what happened in THIS walk — may not agree with. If nothing is marked
 * `taken`, the honest move is to say so in the subject, not to guess a label that might be
 * describing the wrong decision.
 */
export function commitSubject(step: StepLike): string {
  const taken = step.decision.options.find((option) => option.taken);
  const label = taken ? taken.label : '(no option marked taken)';
  return `${step.ordinal}: ${step.decision.question} — ${label}`;
}

/**
 * Every entry of `files` goes through `resolveInsideTarget` (`src/walk/paths.ts`) before it is
 * ever handed to `git add` — the same containment rule the read side already lives by, now
 * guarding a write instead of an `openTextDocument`. A path that escapes `target` is silently
 * dropped rather than staged: it is not the learner's mistake to be told about (the plan is
 * not theirs to have written), and it is exactly the shape of value this module cannot trust,
 * since `step.target.file` and any plan-derived path ultimately come from a repository someone
 * else pointed the build at.
 */
function resolveFiles(target: string, files: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const file of files) {
    const abs = resolveInsideTarget(target, file);
    if (abs !== null) resolved.push(abs);
  }
  return resolved;
}

/**
 * Ensures `target` is inside a repository, stages exactly `files` — containment-checked,
 * nothing else — and commits exactly those same paths with `commitSubject(step)`, so neither
 * a second file sitting untouched in the same folder nor one the learner has already STAGED
 * ever rides along. The pathspec on the commit, not the `add`, is what makes that true; this
 * file's header has the whole story.
 *
 * Refuses, gracefully, rather than committing: when there is nothing left to stage once
 * containment has filtered `files` (including the trivial case of an empty list), and when
 * this repository has no git identity configured (see this file's header — never invented,
 * never defaulted). Any OTHER git failure — a `git init` that could not run, a stale lock
 * file, a detached HEAD git refuses to commit onto, a full disk, anything this module did not
 * anticipate — comes back the same way, as `CommitResult.reason`, never as a thrown or
 * rejected promise. That is what the single `try` around the whole body is for, `ensureRepo`
 * included.
 */
export async function commitStep(
  target: string,
  step: StepLike,
  files: readonly string[],
  git: GitRunner,
): Promise<CommitResult> {
  try {
    await ensureRepo(target, git);

    const resolved = resolveFiles(target, files);
    if (resolved.length === 0) {
      return { committed: false, reason: 'no files to stage' };
    }

    if (!(await identityConfigured(target, git))) {
      return { committed: false, reason: 'no git identity configured in this folder' };
    }

    await git(['add', '--', ...resolved], target);
    await git(['commit', '-q', '-m', commitSubject(step), '--', ...resolved], target);
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
