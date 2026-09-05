// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The start screen's form, as data — spec §5.2. `BuildRequest` is what the webview submits;
 * `validateRequest` is the one place that decides whether it is buildable. Pure (no
 * `vscode` import) and unit-testable on its own: `src/start/panel.ts` calls it on every
 * `form:changed`/`form:submit` message so the SAME rules run whether a test drives the
 * webview's message protocol or calls this function directly.
 *
 * "Pure" here means "independent of VS Code," not "free of the filesystem" — the repo field's
 * existence check is a plain synchronous `fs` read, deliberately: catching a typo'd path the
 * instant a field loses focus is worth more than deferring it to a failed clone attempt, and a
 * local, synchronous stat call costs nothing worth avoiding.
 *
 * **A control that silently declines is a broken control** (repo-tour lesson, T-3,
 * 2026-08-26): every branch below either returns `ok: true` or names a problem under a
 * specific field. There is no path that swallows a request and does nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

export type Dial = 'manual' | 'scaffolded' | 'automated';

export const DIALS: readonly Dial[] = ['manual', 'scaffolded', 'automated'];

export const DEFAULT_DIAL: Dial = 'manual';

export interface BuildRequest {
  idea: string;
  recreate: boolean;
  repo: string;
  target: string;
  dial: Dial;
}

export function emptyRequest(): BuildRequest {
  return { idea: '', recreate: false, repo: '', target: '', dial: DEFAULT_DIAL };
}

export type RequestField = 'idea' | 'repo' | 'target';

export interface ValidationResult {
  ok: boolean;
  problems: Partial<Record<RequestField, string>>;
}

/**
 * The exact honesty line AC2 names verbatim (spec §5.2): "Idea-first builds arrive with T-9
 * — tick 'recreate' to build from a repo." Exported so the panel's client-side fallback
 * rendering (a fresh page, before any message round-trip) and every test that checks this
 * wording read it from one place rather than retyping it.
 */
export const IDEA_FIRST_MESSAGE = "Idea-first builds arrive with T-9 — tick 'recreate' to build from a repo";

const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/;

/** `null` when `repo` is not a GitHub URL at all — not an error, just "try the local-path rule instead." */
export function parseGithubUrl(repo: string): { owner: string; name: string } | null {
  const m = GITHUB_URL_RE.exec(repo.trim());
  if (!m) return null;
  const owner = m[1];
  const name = m[2];
  if (!owner || !name) return null;
  return { owner, name };
}

function validateRepo(recreate: boolean, repo: string): string | null {
  const trimmed = repo.trim();
  if (recreate && !trimmed) return 'required when recreating';
  if (!trimmed) return null; // not recreating and nothing typed — not this field's problem
  if (parseGithubUrl(trimmed)) return null;
  if (!path.isAbsolute(trimmed)) {
    return 'use an absolute local path, or a https://github.com/<owner>/<repo> URL';
  }
  if (!fs.existsSync(trimmed)) return `no folder found at ${trimmed}`;
  if (!fs.statSync(trimmed).isDirectory()) return `${trimmed} is not a folder`;
  return null;
}

function validateIdea(recreate: boolean, idea: string): string | null {
  // Deliberately independent of whether `repo` is also filled in (broader than the literal
  // "&& !repo" shorthand in this ticket's plan): v1's BuildPlan.mode is ALWAYS 'recreate'
  // (T-1 spec §7), so unticking recreate can never produce a plan regardless of what else is
  // filled in — an idea typed alongside a repo, with recreate off, is exactly as much a dead
  // end as an idea typed alone, and deserves the same honest line rather than silence.
  if (recreate) return null;
  const trimmed = idea.trim();
  if (trimmed) return IDEA_FIRST_MESSAGE;
  return 'say what you want to build, or tick recreate';
}

function validateTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return 'pick an empty or new folder';
  if (!path.isAbsolute(trimmed)) return 'pick an absolute path for the target folder';
  if (!fs.existsSync(trimmed)) return null; // a new folder — created when the build starts
  if (!fs.statSync(trimmed).isDirectory()) return `${trimmed} is not a folder`;
  if (fs.readdirSync(trimmed).length > 0) return `${trimmed} is not empty — pick an empty or new folder`;
  return null;
}

export function validateRequest(req: BuildRequest): ValidationResult {
  const problems: Partial<Record<RequestField, string>> = {};

  const repoProblem = validateRepo(req.recreate, req.repo);
  if (repoProblem) problems.repo = repoProblem;

  const ideaProblem = validateIdea(req.recreate, req.idea);
  if (ideaProblem) problems.idea = ideaProblem;

  const targetProblem = validateTarget(req.target);
  if (targetProblem) problems.target = targetProblem;

  return { ok: Object.keys(problems).length === 0, problems };
}
