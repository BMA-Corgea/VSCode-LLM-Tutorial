// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine's fixture idea, and the replies a model would give for it (T-17).
 *
 * Not a test file — bundled into the tests that import it, like `walk-fixtures.ts`. Everything a
 * suite needs to drive the engine without a model is built here, so every suite agrees on what
 * "the fixture idea" is.
 *
 * The app is deliberately tiny: a tally counter. It has two chapters (`core` and `cli`), each
 * with its shape step first, and two files, where `cli/main.mjs` imports `core/tally.mjs`. That
 * is the smallest plan with a real dependency edge, which is the least AC-A1 needs to be
 * meaningful: a step downstream of a decision and a step independent of it.
 */

export const FIXTURE_IDEA = 'A command-line tally counter: add numbers to a running total and print it.';

/** A reply the outline call might return for `FIXTURE_IDEA` — valid in every respect. */
export function fixtureOutlineReply(): Record<string, unknown> {
  return {
    title: 'Tally',
    language: 'javascript',
    entry: 'cli/main.mjs',
    chapters: [
      { key: 'core', title: 'The tally', subtitle: 'what a running total is' },
      { key: 'cli', title: 'The command line', subtitle: 'how a person talks to it' },
    ],
    steps: [
      {
        kind: 'shape', chapter: 'core', path: 'core',
        question: 'Where should the counting live?',
        options: [
          { id: 'a', label: 'One small module', consequence: 'easy to read; grows awkward if the app grows' },
          { id: 'b', label: 'A module per operation', consequence: 'clear boundaries; more files for a tiny app' },
        ],
        recommended: 'a', why: 'Start with the smallest shape that holds the idea.', dependsOn: [],
      },
      {
        kind: 'file', chapter: 'core', path: 'core/tally.mjs',
        question: 'How should a running total be kept?',
        options: [
          { id: 'pure', label: 'A pure function over a list', consequence: 'nothing to reset; recomputes each time' },
          { id: 'object', label: 'An object that remembers', consequence: 'fast; state to reason about' },
        ],
        recommended: 'pure', why: 'A pure function is the simplest thing that can be tested.', dependsOn: ['core'],
      },
      {
        kind: 'shape', chapter: 'cli', path: 'cli',
        question: 'How does a person reach the tally?',
        options: [
          { id: 'args', label: 'Arguments on the command line', consequence: 'one shot; no prompt to write' },
          { id: 'repl', label: 'An interactive prompt', consequence: 'feels alive; more to build' },
        ],
        recommended: 'args', why: 'Arguments are the smallest interface that works.', dependsOn: [],
      },
      {
        kind: 'file', chapter: 'cli', path: 'cli/main.mjs',
        question: 'What does the program print?',
        options: [
          { id: 'total', label: 'Only the total', consequence: 'quiet and scriptable' },
          { id: 'steps', label: 'Each step and the total', consequence: 'easier to follow; noisier' },
        ],
        recommended: 'total', why: 'Print the one fact the user asked for.', dependsOn: ['cli', 'core/tally.mjs'],
      },
    ],
  };
}

/** The same outline, as the text a model would send. */
export function fixtureOutlineText(): string {
  return JSON.stringify(fixtureOutlineReply());
}

/** A deep copy with one change applied — for the refusal matrix, so no test edits a shared object. */
export function outlineWith(change: (o: Record<string, unknown>) => void): string {
  const o = JSON.parse(fixtureOutlineText()) as Record<string, unknown>;
  change(o);
  return JSON.stringify(o);
}

/** The steps array of a parsed copy, typed loosely for editing in a test. */
export function stepsOf(o: Record<string, unknown>): Array<Record<string, unknown>> {
  return o['steps'] as Array<Record<string, unknown>>;
}
