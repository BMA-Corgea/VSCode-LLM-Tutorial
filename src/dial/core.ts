// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The slice of repo-tour the DIAL needs, duck-typed — `src/start/build.ts`'s `BuildCore` is
 * the precedent and the reasoning is identical: one cast site, and this extension stays
 * typecheckable with no dependency on repo-tour's own `dist/*.d.ts` actually being present.
 *
 * Three modules (`writer.ts`, `check.ts`, `commit.ts`) consume this and are written in
 * parallel, so the shape is pinned HERE rather than three times, slightly differently.
 *
 * `FileExtract` and `FileRecord` are deliberately opaque (`unknown`-shaped handles): nothing
 * in this extension reads inside them — they are produced by `extract()` and handed straight
 * back to `check()`. Typing them structurally would be a second, drifting copy of repo-tour's
 * own types for no benefit, and `kb/wiki/repo-tour-plan-shapes.md` records why we mirror only
 * what we actually read.
 */

import type { RangeLike, StepLike } from '../walk/model.js';

/** repo-tour's `StubQuestion` — what a stubbed range's TODO line says. */
export interface StubQuestion {
  ordinal: number;
  question: string;
}

/** repo-tour's `CheckReport` — structural ONLY, and its shape is the proof: no field here
 *  can express "the body does something different", because nothing upstream looks at one. */
export interface CheckReport {
  symbols: Array<{ name: string; kind: string; status: 'present' | 'missing' | 'extra' }>;
  imports: Array<{ raw: string; status: 'present' | 'missing' }>;
  parseErrors: number;
  /** Free text, present ONLY when `parseErrors > 0` — the count says a file did not parse
   *  but never why, and why is what a learner staring at a red check actually needs. */
  reason?: string;
  ok: boolean;
}

/** An opaque handle from `extract()`, handed straight back to `check()`. */
export type FileExtract = unknown;

/** The inventory-shaped record `extract()` takes. Built by `check.ts`; see repo-tour's own
 *  `test/build.test.ts`, which constructs one exactly this way for its `check` tests. */
export interface FileRecord {
  path: string;
  repo: string;
  bytes: number;
  loc: number;
  language: string;
  sha256: string;
  classification: string;
  signals: string[];
  binary: boolean;
}

export interface DialCore {
  stubFile(source: string, loadBearing: RangeLike[], language: string, questions: StubQuestion[]): string;
  check(learnerSource: string, referenceExtract: FileExtract, language: string, relPath: string): Promise<CheckReport>;
  extract(root: string, records: FileRecord[]): Promise<{ extracts: FileExtract[] }>;
}

/** Builds a `DialCore` from `CoreLoadResult.loaded` (src/core.ts) — the one cast site, exactly
 *  as `coreFor` is for the build side. */
export function dialCoreFor(loaded: Partial<Record<string, unknown>>): DialCore {
  const buildMod = loaded['build'] as { stubFile: DialCore['stubFile']; check: DialCore['check'] };
  const extractMod = loaded['extract'] as { extract: DialCore['extract'] };
  return { stubFile: buildMod.stubFile, check: buildMod.check, extract: extractMod.extract };
}

/** The language repo-tour labels this step's file with. The plan does not carry it per step,
 *  so it is derived from the extension the same way repo-tour's own inventory does — kept in
 *  one place because `writer.ts` (stubbing) and `check.ts` (comparing) must agree exactly. */
export function languageOf(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  if (dot === -1) return undefined;
  switch (file.slice(dot + 1).toLowerCase()) {
    case 'ts': return 'typescript';
    case 'tsx': return 'tsx';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'py': return 'python';
    default: return undefined;
  }
}

/** The `StubQuestion` for each load-bearing range of a `file` step: the SYMBOL steps that
 *  live inside it, in range order, so a stub's TODO names the step the learner will land on. */
export function stubQuestionsFor(step: StepLike, symbolSteps: readonly StepLike[]): StubQuestion[] {
  return step.scaffold.loadBearing.map((range) => {
    const owner = symbolSteps.find(
      (s) => s.target.file === step.target.file && s.target.startLine === range.startLine,
    );
    return owner
      ? { ordinal: owner.ordinal, question: owner.decision.question }
      : { ordinal: step.ordinal, question: step.decision.question };
  });
}
