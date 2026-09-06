// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One git commit per completed step, in the LEARNER'S OWN repository (spec §5.4, AC7). Of
 * the three dial modules built together against `./core.ts`'s pinned shape (`writer.ts`
 * decides what to write, `check.ts` decides whether a step passed), this is the only one
 * that touches git, and it touches nothing else — no parsing, no scaffolding, no structural
 * comparison. Given a target folder, the step that just finished, and the files that step
 * wrote, it stages exactly those files and commits them with a subject naming the ordinal,
 * the question, and the option the plan says was actually taken.
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
 * set" or "there is nothing to commit" as much as it is a real failure, so every call here is
 * wrapped: a rejected `git config` reads as an empty value, and a rejected `add`/`commit`
 * becomes a `CommitResult` with that message as `reason`. Nothing in this module ever lets a
 * `GitRunner` rejection propagate, because `commitStep` runs off a `step:check`/*Next* webview
 * message (`src/walk/session.ts`) — a promise nobody is holding a `.catch` on.
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
 * `git init -q` when `target` has no `.git` yet; a no-op — `git` is not even invoked — when it
 * already does. Cheap enough to call at the top of every `commitStep`, which is exactly how it
 * is used: "is this folder a repository" is answered by a plain `fs` check, not by asking git
 * and parsing its opinion, so an already-established repo's history and config are never
 * touched by a step that merely happens to run first.
 */
export async function ensureRepo(target: string, git: GitRunner): Promise<void> {
  if (fs.existsSync(path.join(target, '.git'))) return;
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
 * Ensures `target` is a repository, stages exactly `files` — containment-checked, nothing
 * else, so a second file sitting untouched in the same folder never rides along — and commits
 * them with `commitSubject(step)`.
 *
 * Refuses, gracefully, rather than committing: when there is nothing left to stage once
 * containment has filtered `files` (including the trivial case of an empty list), and when
 * this repository has no git identity configured (see this file's header — never invented,
 * never defaulted). Any OTHER git failure — a stale lock file, a detached HEAD git refuses to
 * commit onto, a full disk, anything this module did not anticipate — comes back the same way,
 * as `CommitResult.reason`, never as a thrown or rejected promise.
 */
export async function commitStep(
  target: string,
  step: StepLike,
  files: readonly string[],
  git: GitRunner,
): Promise<CommitResult> {
  await ensureRepo(target, git);

  const resolved = resolveFiles(target, files);
  if (resolved.length === 0) {
    return { committed: false, reason: 'no files to stage' };
  }

  if (!(await identityConfigured(target, git))) {
    return { committed: false, reason: 'no git identity configured in this folder' };
  }

  try {
    await git(['add', '--', ...resolved], target);
    await git(['commit', '-q', '-m', commitSubject(step)], target);
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
