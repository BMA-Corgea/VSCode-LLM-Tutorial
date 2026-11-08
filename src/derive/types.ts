// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine's shared surface (T-17) — the limits, the prompt version, and the shapes
 * every other file in `src/derive/` is written against. Committed before any of them, so they
 * share one definition by construction rather than by agreement (`autodev/instructions/fences.md`).
 *
 * The engine turns an IDEA into the same kind of plan repo-tour extracts from a repository, and
 * its spec (`.autodev/specs/T-17-derivation-engine.md` in the ledger) gives the technique: a graph
 * of decisions, three kinds of model call, each answer cached under the hash of exactly what the
 * model was shown. What is here is only the vocabulary.
 *
 * **No `vscode` import, value or type** — the plain-mocha unit bundle marks `vscode` as NOT
 * external, so one import breaks the whole suite (`src/dial/writer.ts`'s header).
 */

/**
 * The cache key's other half. **Bump it whenever a prompt's wording or the shape a parser
 * accepts changes**, or a derivation is served an answer to a question that is no longer the one
 * being asked — the detour's `DETOUR_PROMPT_VERSION` rule, for the same reason.
 */
export const DERIVE_PROMPT_VERSION = 2;

/**
 * Every bound the engine applies, in one place, each with the reason for its number. A test
 * holds the parsers and the prompt builders to these values by importing them, never by retyping
 * them (`autodev/instructions/testing-the-shipped-value.md`).
 */
export const DERIVE_LIMITS = {
  /**
   * The idea as the learner typed it, budgeted through `Outbound.text` before it leaves. A
   * paragraph is the honest size of an idea; 4,000 characters is several of them, and the bound
   * is what keeps one box on a form from becoming an unbounded bill.
   */
  maxIdeaChars: 4000,
  /**
   * The largest reply any of the three calls may return. An outline of 30 nodes at its widest
   * field budgets is under 40,000 characters, and a file is at most `maxFileChars` JSON-escaped
   * (at worst six characters per character), so 200,000 is generous to every honest reply and a
   * hard stop on a runaway one — the bound the detour learned it needed (T-7 security review).
   */
  maxReplyChars: 200_000,
  /**
   * How many questions one press may send. An outline and all its files is at most 31, and a
   * walk's one answer re-derives at most what it reaches, so twice a whole plan is the honest
   * ceiling. Past it the press stops and says so. What was answered stays cached, so pressing again
   * carries on from there: the bound can cost a second press, and never the work.
   */
  maxCallsPerPress: 64,
  /** "Simple shapes": a small app has a handful of parts. Six is room to spare. */
  maxChapters: 6,
  /** Steps in the whole plan, after every replan. Thirty is a long evening's tutorial. */
  maxSteps: 30,
  /** A decision with one option is not a decision (T-1 §4.2: "ALWAYS ≥ 2 once interpreted"). */
  minOptions: 2,
  /** More than four roads is a menu, not a decision a learner can weigh. */
  maxOptions: 4,
  /** An option id is a handle, not prose. */
  maxOptionIdChars: 24,
  maxTitleChars: 80,
  maxQuestionChars: 300,
  maxLabelChars: 120,
  maxConsequenceChars: 400,
  maxWhyChars: 1200,
  /**
   * One derived file. 150 lines is a module a beginner can read in one sitting and the shape of
   * every file in a "simple shapes" app; 12,000 characters bounds a file of very long lines.
   */
  maxFileLines: 150,
  maxFileChars: 12_000,
  /** A chapter is one or two directories deep; a file sits inside it. */
  maxPathSegments: 4,
  maxPathChars: 120,
} as const;

/** The two languages a Mode A app is written in: each runs with no install step. */
export type DeriveLanguage = 'javascript' | 'python';

/**
 * The one extension each language's files carry. JavaScript is ES modules as `.mjs`, which Node
 * runs with no `package.json`; Python is plain `.py`. TypeScript needs a compile step, so a
 * derived TypeScript app could not "build and start" without an install, and it is out of v1.
 */
export const LANGUAGE_EXTENSION: Readonly<Record<DeriveLanguage, string>> = {
  javascript: '.mjs',
  python: '.py',
};

/** One road at a decision. `id` is the model's own handle for it within the step. */
export interface DerivedOption {
  id: string;
  label: string;
  consequence: string;
}

/**
 * One decision node, as a model proposed it and the parser accepted it.
 *
 * `path` is the node's handle in every reply: a `shape` node's path is its chapter's directory,
 * a `file` node's path is the file. Paths are unique in a plan (file paths are, and a chapter
 * directory has no dot in it so it can never equal a file path), so they need no second id.
 */
export interface DerivedNode {
  kind: 'shape' | 'file';
  /** the chapter key — a directory */
  chapter: string;
  path: string;
  question: string;
  options: DerivedOption[];
  /** the option id the engine recommends — `authorChoice` in the plan, `taken` on its option */
  recommended: string;
  why: string;
  /** paths of EARLIER nodes this one builds on, as declared; the engine adds the edges it owes */
  dependsOn: string[];
}

export interface DerivedChapter {
  /** a directory — every file node in the chapter lies inside it */
  key: string;
  title: string;
  subtitle: string;
}

/** What the outline call returns once parsed. */
export interface Outline {
  title: string;
  language: DeriveLanguage;
  /** the path of the file node that starts the app — the last file in the outline (a later replan may add steps after it) */
  entry: string;
  chapters: DerivedChapter[];
  nodes: DerivedNode[];
}

/**
 * Every "no" in the engine is a sentence, never a bare `null` or a throw: the start screen and the
 * walk have to say WHY, and both T-6 reviews found "refused with no sentence" to be the failure
 * that hides bugs.
 */
export interface DeriveRefusal {
  refused: string;
}

export function isDeriveRefusal(value: unknown): value is DeriveRefusal {
  return typeof value === 'object' && value !== null && typeof (value as { refused?: unknown }).refused === 'string';
}
