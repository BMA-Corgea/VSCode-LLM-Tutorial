// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one hand-written `BuildPlan` T-4's tests walk, plus the target folder that plan
 * describes. Shared, so the model, the store, the protocol and (later) `test/walk.test.ts`
 * all argue about the SAME four steps rather than each inventing a plausible-looking one.
 *
 * Deliberately NOT named `*.test.ts`: `esbuild.mjs`'s unit entry glob is `test/unit/*.test.ts`
 * only, so a helper sitting beside them is never picked up as its own entry point (mocha would
 * otherwise run an empty file), but bundles fine into whichever test file imports it. That
 * includes the top-level `test/walk.test.ts` — which is why nothing here imports `vscode`,
 * value or type: the unit bundle does not mark `vscode` external, so one such import would
 * fail the build outright.
 *
 * **Hand-written on purpose.** Producing a plan through repo-tour's real core costs a digest
 * (and, for `whySource: 'interpret'`, tokens) for data that is then whatever the core happened
 * to emit. The real sql-gauntlet plan is proof of the problem: 61 steps, every one with a
 * single option, `whySource` never `'interpret'`, every `witness.sha` null — so the
 * alternatives path and the witness sentence could not be exercised by it at all. This plan is
 * small enough to read in one screen and deliberately spans the cases the real one misses. It
 * is schema-validated against repo-tour's REAL `schema/build-plan.schema.json` in
 * `walk-model.test.ts`, so "hand-written" never means "not a legitimate plan".
 *
 * The shape, in full — the next worker should not have to re-derive this:
 *
 *   chapter `src`      "1 file · 20 lines"
 *     1  st-1-shape-src       shape   whySource none       1 option    witness null       target `src` (a DIRECTORY)
 *     2  st-2-file-parse      file    whySource interpret  2 options   witness non-null   target src/parse.ts        loadBearing 1-12
 *   chapter `src/api`  "2 files · 24 lines"
 *     3  st-3-symbol-handle   symbol  whySource docstring  1 option    witness null       target src/api/routes.ts   6-13
 *     4  st-4-symbol-render   symbol  whySource interpret  3 options   witness non-null   target src/api/render.ts   3-10
 *
 * Deliberate variations worth knowing about before you write against it:
 *   - step 1 is a `shape` step whose `target.file` is a DIRECTORY, exactly as repo-tour's real
 *     plans open. `fs.existsSync` says true for it, but `openTextDocument` on a directory
 *     rejects — a `fileExists` check alone is not enough to decide whether to reveal an editor.
 *   - step 4 has `chosen: null` (the learner has decided nothing there yet) while steps 1-3
 *     carry `chosen === authorChoice`, the recreate-mode norm.
 *   - every step's target really exists after `writeFixtureTarget`, with enough lines to cover
 *     its `scaffold` ranges. For a `!fileExists` case (the honest "you haven't created this
 *     file yet" control), delete one afterwards — `src/api/render.ts` is the safe one to remove,
 *     since nothing else in the fixture points at it.
 *
 * Every call returns a fresh object graph, so a test may mutate what it gets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { emptyProgress, markDone, nextStepId, setCurrent, setDial, type PlanLike, type Progress } from '../../src/walk/model.js';

/**
 * A complete `BuildPlan` — every top-level key repo-tour's schema requires, not just the
 * `chapters`/`steps` slice `PlanLike` duck-types, so this same object can be written straight
 * to `plan.json` and read back by code that expects the real thing.
 */
export function fixturePlan(): PlanLike {
  return {
    schemaVersion: 1,
    source: { kind: 'repo', root: '/fixture/source-repo', head: '1f4c9a02b7e35d6188aa0c4de9f7b210359ce8d4' },
    mode: 'recreate',
    generatedAt: '2026-09-05T00:00:00.000Z',
    // Consistent with two `interpret` steps: a provider really did run for this plan.
    cost: {
      provider: 'claude', metered: true, calls: 2, cachedStops: 0, interpretedStops: 2,
      inputTokens: 1200, outputTokens: 340, usd: 0.0042, model: 'claude-sonnet-4-5', failures: [],
    },
    reproduce: [],
    chapters: [
      { key: 'src', title: 'src', subtitle: '1 file · 20 lines', tierPath: 'src' },
      { key: 'src/api', title: 'src/api', subtitle: '2 files · 24 lines', tierPath: 'src/api' },
    ],
    steps: [
      {
        id: 'st-1-shape-src',
        ordinal: 1,
        chapter: 'src',
        kind: 'shape',
        decision: {
          question: 'Why does src exist as its own part, rather than living inside another one?',
          options: [
            { id: 'author', label: 'What the author did', consequence: 'src becomes its own chapter: 1 file, 20 lines.', taken: true },
          ],
          authorChoice: 'author',
          chosen: 'author',
          why: 'not inferable from the source',
          whySource: 'none',
        },
        target: { file: 'src' },
        scaffold: { loadBearing: [], boilerplate: [] },
        dependsOn: [],
        witness: { sha: null, date: null, subject: null },
      },
      {
        id: 'st-2-file-parse',
        ordinal: 2,
        chapter: 'src',
        kind: 'file',
        decision: {
          question: 'Why does the tokenizer get its own module?',
          options: [
            { id: 'author', label: 'What the author did', consequence: 'parse.ts owns 2 exported symbols and depends on 0 imports.', taken: true },
            { id: 'inline-in-routes', label: 'Tokenize inside the router', consequence: 'One less file, but the router can no longer be tested without HTTP.', taken: false },
          ],
          authorChoice: 'author',
          chosen: 'author',
          why: 'The parser is split out so the API layer can depend on it without dragging HTTP along.',
          whySource: 'interpret',
        },
        target: { file: 'src/parse.ts' },
        scaffold: { loadBearing: [{ startLine: 1, endLine: 12 }], boilerplate: [{ startLine: 13, endLine: 20 }] },
        dependsOn: ['st-1-shape-src'],
        witness: { sha: '9f1c0d2a4b6e8f0173c5', date: '2026-08-14T09:12:03Z', subject: 'split the tokenizer out of the router' },
      },
      {
        id: 'st-3-symbol-handle',
        ordinal: 3,
        chapter: 'src/api',
        kind: 'symbol',
        decision: {
          question: 'Fill in handleRequest — how should this function do its job?',
          options: [
            { id: 'author', label: 'What the author did', consequence: 'handleRequest is 8 lines of function, load-bearing in this file.', taken: true },
          ],
          authorChoice: 'author',
          chosen: 'author',
          // Byte-identical to routes.ts line 5 below: a real docstring, really the source of `why`.
          why: 'Turns a request body into a response — the step this chapter is about.',
          whySource: 'docstring',
        },
        target: { file: 'src/api/routes.ts', startLine: 6, endLine: 13 },
        scaffold: {
          loadBearing: [{ startLine: 6, endLine: 13 }],
          boilerplate: [{ startLine: 1, endLine: 5 }, { startLine: 14, endLine: 14 }],
        },
        dependsOn: ['st-2-file-parse'],
        witness: { sha: null, date: null, subject: null },
      },
      {
        id: 'st-4-symbol-render',
        ordinal: 4,
        chapter: 'src/api',
        kind: 'symbol',
        decision: {
          question: 'Fill in render — how should a response be turned into markup?',
          options: [
            { id: 'author', label: 'What the author did', consequence: 'The answer is wrapped in a <pre> block, so nothing needs escaping rules yet.', taken: true },
            { id: 'template-string', label: 'Build the markup with a template string', consequence: 'Shorter, but every future field has to remember to escape itself.', taken: false },
            { id: 'stream', label: 'Stream the response as it is produced', consequence: 'Faster first byte, at the cost of not knowing the length up front.', taken: false },
          ],
          authorChoice: 'author',
          // Nothing decided here yet — the one step whose `chosen` is null.
          chosen: null,
          why: 'A preformatted block keeps the first version honest about not escaping anything.',
          whySource: 'interpret',
        },
        target: { file: 'src/api/render.ts', startLine: 3, endLine: 10 },
        scaffold: { loadBearing: [{ startLine: 3, endLine: 10 }], boilerplate: [{ startLine: 1, endLine: 2 }] },
        dependsOn: ['st-3-symbol-handle'],
        witness: { sha: '0a7d3e5c1b9f4602ee81', date: '2026-08-21T17:40:55Z', subject: 'render responses as preformatted text' },
      },
    ],
  };
}

/**
 * A walk already under way: step 1 done, parked on step 2, whose dial has been dragged to
 * `scaffolded`. Every status `treeModel` can produce is therefore present at once (done /
 * current / pending × 2) and `statusText` reads `step 2 / 4 · scaffolded`.
 *
 * Built by calling `model.ts`'s own pure functions rather than by writing the `Progress`
 * literal out, so this fixture cannot drift from the shape the module actually produces —
 * the opposite choice from `writeFixtureTarget` below, and for the opposite reason.
 */
export function fixtureProgress(plan: PlanLike): Progress {
  const start = emptyProgress(plan);
  const first = start.current;
  const second = nextStepId(plan, start);
  if (first === null || second === null) return start;
  return setDial(setCurrent(markDone(start, first), second), second, 'scaffolded');
}

/**
 * The real files the plan's `target.file` paths point at. Line counts are load-bearing: each
 * file has at least as many lines as the highest `endLine` any step claims in it (20 / 14 /
 * 10), so a decoration or a reveal against these ranges addresses lines that genuinely exist.
 * `walk-store.test.ts` asserts exactly that, so an edit here that shortens a file is caught.
 */
const TARGET_FILES: Record<string, string> = {
  'src/parse.ts': `export interface Token {
  kind: 'word' | 'punct';
  value: string;
}

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  for (const raw of line.split(/\\s+/)) {
    if (raw.length > 0) out.push({ kind: /^\\w+$/.test(raw) ? 'word' : 'punct', value: raw });
  }
  return out;
}

/** Below here is plumbing, not a decision. */
export const VERSION = 1;

export default {
  tokenize,
  VERSION,
};
`,
  'src/api/routes.ts': `import { tokenize } from '../parse.js';

export type Handler = (body: string) => string;

/** Turns a request body into a response — the step this chapter is about. */
export function handleRequest(body: string): string {
  const tokens = tokenize(body);
  if (tokens.length === 0) return 'empty';
  return tokens
    .filter((t) => t.kind === 'word')
    .map((t) => t.value.toUpperCase())
    .join(' ');
}
export const routes: Record<string, Handler> = { '/echo': handleRequest };
`,
  'src/api/render.ts': `import { handleRequest } from './routes.js';

export function render(body: string): string {
  const answer = handleRequest(body);
  return [
    '<pre>',
    answer,
    '</pre>',
  ].join('\\n');
}
`,
};

/**
 * Makes `dir` look like a target repo-tour has already planned: `plan.json` beside the files
 * the plan talks about, and nothing else. No `progress.json` — a build that has never been
 * walked is exactly what `loadProgress`'s missing-file path has to survive, so writing one
 * here would quietly delete that test's subject.
 *
 * The build path is spelled out literally rather than borrowed from `store.ts`'s `buildDir`
 * on purpose: this fixture states where the layout IS, so `walk-store.test.ts` proves the
 * store finds a plan at the documented location instead of merely agreeing with itself.
 */
export function writeFixtureTarget(dir: string): void {
  const plan = fixturePlan();
  const build = path.join(dir, '.repo-tour', 'build');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

  for (const [rel, contents] of Object.entries(TARGET_FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  // `shape` steps point at a directory, not a file; every other kind's directory is already
  // there from the writes above, but saying it out loud keeps this true if a step moves.
  for (const step of plan.steps) {
    if (step.kind === 'shape') fs.mkdirSync(path.join(dir, step.target.file), { recursive: true });
  }
}
