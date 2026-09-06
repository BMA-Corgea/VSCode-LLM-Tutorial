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
  if (await insideWorkTree(target, git)) return;
  await git(['init', '-q'], target);
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
