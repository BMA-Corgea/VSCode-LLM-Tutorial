// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-72: a `.gitattributes` that repo-tour would read without end, found before the digest runs.
 *
 * repo-tour's `readGitAttributes` (`../repo-tour/src/inventory.ts`) reads `<repo>/.gitattributes`
 * with a plain `readFileSync`: no `lstat`, no bound. It does that for the scan root and for every
 * nested folder holding a `.git`, as its walk finds them. The walk itself skips links, but this file
 * is read by name, and `git clone` recreates a committed link. A link to `/dev/zero` is then read in
 * a native loop that neither V8's heap limit nor `worker.terminate()` can stop. Driven by T-30's
 * security review: Cancel returned at once, and the abandoned thread allocated until the extension
 * host died.
 *
 * This side cannot change that read. It can refuse the repository first: visit the folders
 * repo-tour's walk would visit, by its rules and in its order, and look at each `.gitattributes` it
 * would read. The real fix (`lstat`, then an open that follows no link and waits for no pipe, and a
 * bounded read, in repo-tour) is banked as a patch for the owner; it also covers what this cannot
 * see, a file swapped between this check and that read.
 *
 * Asynchronous, so a large repository's walk never holds the extension host's thread.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The folders repo-tour's walk never enters: its `NEVER_DESCEND`, copied from
 * `../repo-tour/src/inventory.ts` (not exported there), so this check visits what that walk visits.
 * It also skips links and `.git` itself. `test/unit/gitattributes.test.ts` reads repo-tour's list
 * and fails when the two differ.
 */
export const REPO_TOUR_NEVER_DESCEND: ReadonlySet<string> = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache',
  '.gradle', '.idea', '.vscode-test', 'site-packages', '.terraform',
  '.repo-tour',
]);

/** A real `.gitattributes` is a few hundred bytes. Past this, refuse rather than have it read. */
export const GITATTRIBUTES_MAX_BYTES = 1024 * 1024;

export interface GitAttributesHazard {
  /** Absolute path of the `.gitattributes` repo-tour would read. */
  file: string;
  why: 'link' | 'not-a-file' | 'too-large';
  bytes?: number;
}

/**
 * The first `.gitattributes` under `root` that repo-tour would read and must not, or `null`. Or
 * `'cancelled'`, when `isCancelled` returned true before the walk was done: it has cleared nothing.
 *
 * The walk is repo-tour's own (`walk` and `maybeRepo` in `../repo-tour/src/inventory.ts`), in its
 * order. In each folder it first looks for `.git` by name, of any kind (a folder, a worktree's or a
 * submodule's file, a link), as `maybeRepo` does with `lstat`. When there is one, it looks at that
 * folder's `.gitattributes`. Only then does it list the folder. A folder it cannot list is not
 * descended, as repo-tour's walk does not descend it either. Both checks come before the listing, as
 * they do in `maybeRepo`, and both are by name, because repo-tour reads that file whether or not the
 * folder can be listed. A folder that can be searched but not listed (mode 0311) has its
 * `.gitattributes` read all the same, and a `.GIT` on a volume that ignores case answers to the name
 * `.git` (T-72 reviews: the first version listed first, and missed both).
 *
 * A `.gitattributes` is a hazard when it is a link, a pipe or a device, or a regular file over
 * `GITATTRIBUTES_MAX_BYTES`. One that is missing, unreadable or a folder is not: repo-tour's read of
 * it fails at once and it carries on (a pipe, by contrast, blocks that read).
 *
 * `isCancelled` is asked before each folder, so a Cancel stops the walk within one folder's work.
 */
export async function hazardousGitAttributes(
  root: string,
  isCancelled?: () => boolean,
): Promise<GitAttributesHazard | 'cancelled' | null> {
  const pending: string[] = [root];
  while (pending.length > 0) {
    if (isCancelled?.()) return 'cancelled';
    const dir = pending.pop()!;
    if (await named(path.join(dir, '.git'))) {
      const hazard = await hazardOf(path.join(dir, '.gitattributes'));
      if (hazard) return hazard;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // not listed, so not descended, as in repo-tour's walk; its .gitattributes was looked at above
    }
    // A link is never entered: `readdir` reports one as a link, never as a directory, as repo-tour's
    // walk relies on too.
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && !REPO_TOUR_NEVER_DESCEND.has(e.name)) pending.push(path.join(dir, e.name));
    }
  }
  return null;
}

/** Whether anything at all has this name, a dangling link included: `maybeRepo`'s `lstat`. */
async function named(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function hazardOf(file: string): Promise<GitAttributesHazard | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(file);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { file, why: 'link' };
  if (st.isDirectory()) return null;
  if (!st.isFile()) return { file, why: 'not-a-file' };
  if (st.size > GITATTRIBUTES_MAX_BYTES) return { file, why: 'too-large', bytes: st.size };
  return null;
}

/**
 * The refusal, under Reference repo: which file, what is wrong with it, and what to do.
 *
 * A link is "a link, which repo-tour would follow", and no more: one to `/dev/zero` is read without
 * end, but one to a small file is not, so the words do not say that every link is. The size is
 * rounded up, so the figure shown is never at or under the bound it is said to be over.
 */
/**
 * The refusal's words. `from` is where the reference came from (T-72 code review, finding 5). For a
 * GitHub URL the reference is this extension's own clone, which a later build only ever `fetch`es, so
 * its files never change. Removing the file upstream would leave the learner refused for ever, so
 * those words name the way that works instead.
 */
export function gitAttributesRefusal(root: string, hazard: GitAttributesHazard, from: 'folder' | 'url' = 'folder'): string {
  const where = path.relative(root, hazard.file).split(path.sep).join('/') || '.gitattributes';
  const mb = (bytes: number): string => (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
  const what = hazard.why === 'link'
    ? 'is a link, which repo-tour would follow'
    : hazard.why === 'not-a-file'
      ? 'is not a regular file (a pipe or a device), which repo-tour might read without end'
      : `is ${mb(hazard.bytes ?? 0)} MB, over the ${GITATTRIBUTES_MAX_BYTES / (1024 * 1024)} MB a .gitattributes may be`;
  return from === 'url'
    ? `${where} ${what}: clone the repository yourself, remove it in your copy, and build from that folder`
    : `${where} ${what}: remove it from the reference repository, or build from a copy without it`;
}
