// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a derived plan becomes indistinguishable in shape from an extracted one (T-17, AC1;
 * T-1 §9 criterion 2: one walk, not two code paths).
 *
 * Input: the decisions the engine settled (in final plan order), the learner's answers, each file
 * node's code, and repo-tour's `extract` over each derived file. Output: a `BuildPlan` with
 * exactly the fields the walk reads, filled the way repo-tour's own `buildPlan` fills them for a
 * repository — except where Mode A has a different truth to tell, and then it tells it:
 *
 *   - `source: { kind: 'idea', text }` and `mode: 'idea'` — already in repo-tour's schema.
 *   - **Options:** the recommendation is `taken` and is `authorChoice`; `chosen` is the learner's
 *     answer, or `null` before they give one. There is no author: these fields carry the engine's
 *     recommendation because that is the only "default" Mode A has (T-1 §2), and the step panel's
 *     wording for it is T-18's to change.
 *   - **`whySource: 'interpret'`** — a model reasoned the `why`; it is never passed off as the
 *     author's own words (`docstring`), which is the distinction `src/tutor/context.ts` protects.
 *   - **`witness` is all `null`** — there is no history, and the panel already says so honestly.
 *   - **`reproduce: []`** — a Mode A app has no never-taught files.
 *
 * ── Step ids hash the DECISION, not the answer and not the code ──────────────────────────────
 *
 * So a step keeps its id when its own answer changes — the walk's `current` and the learner's
 * progress survive answering — while a replanned step with a different decision gets a new id,
 * and its tutor transcript and detour cache do not follow it to different code (T-7: a key is only
 * a key inside the space it was minted for). `(kind, path)` is already unique within a plan, so
 * the ids are unique by construction.
 *
 * ── Scaffold ranges come from the derived file itself ────────────────────────────────────────
 *
 * The exported symbols are what later steps use, so they are what a learner fills in: at most five,
 * non-overlapping (the widest wins a clash), in line order — load-bearing; every other line is
 * boilerplate. A file with no export worth stubbing (nothing exported, or only one-line values),
 * which is usually the entry point with a `main()` nothing imports, takes its own functions and
 * multi-line variables instead: with no load-bearing lines at all, `planWrite` copies the whole file
 * in scaffolded mode, handing over the answer in the one position that exists to hide it. The live
 * run (AC-A2 b) found that on the first real entry point. repo-tour's `selectLoadBearing` has the
 * same fallback for a file that exports nothing (its T-15), with the same screen; this does not
 * claim to equal it beyond that.
 *
 * No `vscode` import — see `./types.ts`.
 */

import { createHash } from 'node:crypto';
import type { InterpretCostLike } from '../start/build.js';
import type { ChapterLike, RangeLike, StepLike } from '../walk/model.js';
import type { DerivedChapter, DerivedNode, DeriveLanguage } from './types.js';

/** The slice of repo-tour's `SymbolRecord` this file reads — mirrored, never imported. */
export interface SymbolLike {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  exported: boolean;
}

/** The slice of repo-tour's `FileExtract` the engine reads. */
export interface ExtractLike {
  path: string;
  symbols: SymbolLike[];
  imports: Array<{ raw: string; resolved: string | null }>;
  parseErrors: number;
}

/**
 * What the derivation cost, in repo-tour's `InterpretCost` shape — all ten fields its schema
 * requires. `metered: false` means the numbers are UNKNOWN, never free (`src/tutor/ask.ts`).
 * `cachedStops` counts answers read back from the cache, `interpretedStops` answers asked live.
 */
export interface DeriveCost extends InterpretCostLike {
  provider: string;
  model: string;
  calls: number;
  cachedStops: number;
  interpretedStops: number;
  failures: string[];
}

/** At most this many load-bearing ranges per file — the number repo-tour uses for symbol steps. */
export const MAX_LOAD_BEARING = 5;

/** `sha256([kind, path, question, option labels])`, first 16 hex — see the header. */
export function stepIdFor(node: Pick<DerivedNode, 'kind' | 'path' | 'question' | 'options'>): string {
  const material = JSON.stringify([node.kind, node.path, node.question, node.options.map((o) => [o.id, o.label])]);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Lines in a file as a person counts them: a final newline does not start a new line. */
export function lineCountOf(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** The kinds whose span is always their own body, whatever its size (repo-tour's own list). */
const ALWAYS_LOAD_BEARING_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'class', 'interface', 'enum']);
/** Below this many lines a `variable` is a reference, not code to fill in (repo-tour's number). */
const TRIVIAL_SPAN = 3;

/** Code a learner could fill in, as opposed to a one-line reference. */
function worthStubbing(s: SymbolLike): boolean {
  return ALWAYS_LOAD_BEARING_KINDS.has(s.kind) || s.endLine - s.line + 1 >= TRIVIAL_SPAN;
}

/**
 * The exported symbols, or, in a file with no export worth stubbing, its own functions and
 * multi-line variables (see the header). Widest first through any clash, then in line order, at
 * most five.
 */
export function loadBearingRanges(extract: ExtractLike, totalLines: number): RangeLike[] {
  const inFile = extract.symbols
    .filter((s) => Number.isInteger(s.line) && Number.isInteger(s.endLine) && s.line >= 1 && s.endLine >= s.line && s.endLine <= totalLines);
  const exported = inFile.filter((s) => s.exported);
  const pool = exported.some(worthStubbing) ? exported : inFile.filter(worthStubbing);
  const candidates = [...pool].sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line) || a.line - b.line);
  const chosen: RangeLike[] = [];
  for (const s of candidates) {
    if (chosen.length >= MAX_LOAD_BEARING) break;
    if (chosen.some((r) => s.line <= r.endLine && r.startLine <= s.endLine)) continue;
    chosen.push({ startLine: s.line, endLine: s.endLine });
  }
  return chosen.sort((a, b) => a.startLine - b.startLine);
}

/** Every line of 1..totalLines that no load-bearing range covers, as ranges. */
export function boilerplateRanges(loadBearing: readonly RangeLike[], totalLines: number): RangeLike[] {
  const out: RangeLike[] = [];
  let next = 1;
  for (const r of loadBearing) {
    if (r.startLine > next) out.push({ startLine: next, endLine: r.startLine - 1 });
    next = Math.max(next, r.endLine + 1);
  }
  if (next <= totalLines) out.push({ startLine: next, endLine: totalLines });
  return out;
}

export interface AssembleInput {
  idea: string;
  title: string;
  language: DeriveLanguage;
  chapters: readonly DerivedChapter[];
  /** the settled decisions, in final plan order */
  nodes: readonly DerivedNode[];
  /** the learner's answers, by step id; an answer that is not one of a step's options is ignored */
  answers: Readonly<Record<string, string>>;
  /** each file node's code, by path */
  files: ReadonlyMap<string, string>;
  /** repo-tour's extract over each file, by path */
  extracts: ReadonlyMap<string, ExtractLike>;
  cost: DeriveCost;
  generatedAt: string;
}

/** The plan, in repo-tour's `BuildPlan` shape (validated against its real schema in the suite). */
export interface DerivedPlan {
  schemaVersion: 1;
  source: { kind: 'idea'; text: string };
  mode: 'idea';
  chapters: ChapterLike[];
  steps: StepLike[];
  generatedAt: string;
  cost: DeriveCost;
  reproduce: string[];
  [key: string]: unknown;
}

export function assemblePlan(input: AssembleInput): DerivedPlan {
  const idByPath = new Map(input.nodes.map((n) => [n.path, stepIdFor(n)] as const));
  const steps: StepLike[] = input.nodes.map((n, i) => {
    const id = idByPath.get(n.path)!;
    const answer = input.answers[id];
    const chosen = typeof answer === 'string' && n.options.some((o) => o.id === answer) ? answer : null;
    let scaffold: StepLike['scaffold'] = { loadBearing: [], boilerplate: [] };
    if (n.kind === 'file') {
      const content = input.files.get(n.path) ?? '';
      const total = lineCountOf(content);
      const extract = input.extracts.get(n.path);
      const loadBearing = extract ? loadBearingRanges(extract, total) : [];
      scaffold = { loadBearing, boilerplate: boilerplateRanges(loadBearing, total) };
    }
    return {
      id,
      ordinal: i + 1,
      chapter: n.chapter,
      kind: n.kind,
      decision: {
        question: n.question,
        options: n.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence, taken: o.id === n.recommended })),
        authorChoice: n.recommended,
        chosen,
        why: n.why,
        whySource: 'interpret',
      },
      target: { file: n.path },
      scaffold,
      dependsOn: n.dependsOn.map((p) => idByPath.get(p)).filter((d): d is string => d !== undefined),
      witness: { sha: null, date: null, subject: null },
    };
  });

  const firstStep = new Map<string, number>();
  input.nodes.forEach((n, i) => { if (!firstStep.has(n.chapter)) firstStep.set(n.chapter, i); });
  const chapters: ChapterLike[] = input.chapters
    .filter((c) => firstStep.has(c.key))
    .sort((a, b) => firstStep.get(a.key)! - firstStep.get(b.key)!)
    .map((c) => ({ key: c.key, title: c.title, subtitle: c.subtitle, tierPath: c.key }));

  return {
    schemaVersion: 1,
    source: { kind: 'idea', text: input.idea },
    mode: 'idea',
    chapters,
    steps,
    generatedAt: input.generatedAt,
    cost: input.cost,
    reproduce: [],
  };
}
