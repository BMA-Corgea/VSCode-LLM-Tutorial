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
 * repo-tour's walk would visit, by its rules, and look at each `.gitattributes` it would read. The
 * real fix (`lstat` and a bounded read, in repo-tour) is banked as a patch for the owner; it also
 * covers what this cannot see, a file swapped between this check and that read.
 *
 * Asynchronous, so a large repository's walk never holds the extension host's thread.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The folders repo-tour's walk never enters: its `NEVER_DESCEND`, copied from
 * `../repo-tour/src/inventory.ts` (not exported there), so this check visits what that walk visits.
 * It also skips links and `.git` itself.
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
 * The first `.gitattributes` under `root` that repo-tour would read and must not, or `null`.
 *
 * A folder is a repository root, as repo-tour's `maybeRepo` decides, when it holds an entry named
 * `.git` of any kind. Its `.gitattributes` is a hazard when it is a link, a pipe or a device, or a
 * regular file over `GITATTRIBUTES_MAX_BYTES`. One that is missing, unreadable or a folder is not:
 * repo-tour's read of it fails at once and it carries on (a pipe, by contrast, blocks that read).
 */
export async function hazardousGitAttributes(root: string): Promise<GitAttributesHazard | null> {
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable: repo-tour's walk skips it the same way
    }
    if (entries.some((e) => e.name === '.git')) {
      const hazard = await hazardOf(path.join(dir, '.gitattributes'));
      if (hazard) return hazard;
    }
    // A link is never entered: `readdir` reports one as a link, never as a directory, as repo-tour's
    // walk relies on too.
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && !REPO_TOUR_NEVER_DESCEND.has(e.name)) pending.push(path.join(dir, e.name));
    }
  }
  return null;
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

/** The refusal, under Reference repo: which file, what is wrong with it, and what to do. */
export function gitAttributesRefusal(root: string, hazard: GitAttributesHazard): string {
  const where = path.relative(root, hazard.file).split(path.sep).join('/') || '.gitattributes';
  const what = hazard.why === 'link'
    ? 'is a link, which repo-tour would follow and might read without end'
    : hazard.why === 'not-a-file'
      ? 'is not a regular file (a pipe or a device), which repo-tour might read without end'
      : `is ${((hazard.bytes ?? 0) / (1024 * 1024)).toFixed(1)} MB, far too large to be a .gitattributes`;
  return `${where} ${what}: remove it from the reference repository, or build from a copy without it`;
}
