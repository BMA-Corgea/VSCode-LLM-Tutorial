/**
 * The detour's shapes — written BEFORE the three modules that use them, by the orchestrator,
 * so that `prompt.ts`, `store.ts` and `narrator.ts` can be built in parallel without sharing a
 * file. (T-6's fan-out put one test file in two fences; the lesson recorded in
 * `.autodev/factory-findings/` is that a fence is only real if the surface is genuinely
 * disjoint. Hoisting the shared types is how that is made true rather than asserted.)
 *
 * Everything here describes MODEL OUTPUT. A `Detour` is what a language model proposed, parsed
 * and validated — never something this extension authored. Two consequences the whole feature
 * rests on:
 *
 *   - `DetourFile.path` becomes a real filesystem path. It is attacker-shaped input in the
 *     ordinary case, not the exotic one, because a model that has been asked for "a small
 *     example" will sometimes answer with `../` or an absolute path by accident. Nothing may
 *     write a `DetourFile` that has not been through `prompt.ts`'s path check.
 *   - `title`, `domain` and `DetourStop.text` are rendered in a webview and must be escaped at
 *     the point of render, the way T-6's AC5 escapes a tutor reply.
 *
 * The line numbers are 1-based and inclusive, matching `vscode.Range`'s constructor convention
 * once decremented — repo-tour's plan shapes use the same base, and `kb/wiki/repo-tour-plan-
 * shapes.md` is the page that explains why that is worth stating rather than assuming.
 */

/** One file of a worked example. `path` is RELATIVE and unvalidated until `parseDetourReply`. */
export interface DetourFile {
  path: string;
  content: string;
}

/** One narration stop: a range in one of the detour's own files, and what to say about it. */
export interface DetourStop {
  /** Must match one of the detour's `files[].path` exactly; the parser enforces it. */
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** A parsed, validated worked example in a domain deliberately unlike the learner's. */
export interface Detour {
  title: string;
  domain: string;
  files: DetourFile[];
  stops: DetourStop[];
}

/** The spec's limits (AC1), in one place so the parser and its tests cannot disagree. */
export const DETOUR_LIMITS = {
  maxFiles: 5,
  maxLinesPerFile: 60,
  minStops: 3,
  maxStops: 6,
} as const;

/**
 * Why a reply was refused. A discriminated union rather than a string so the panel can say
 * something specific and the tests can assert the REASON rather than the absence of a result —
 * T-6's reviews both found "refused with no sentence" to be the failure mode that hides bugs.
 */
export type DetourRefusal =
  | { reason: 'not-json'; detail: string }
  | { reason: 'bad-shape'; detail: string }
  | { reason: 'too-many-files'; found: number }
  | { reason: 'file-too-long'; path: string; lines: number }
  | { reason: 'bad-stop-count'; found: number }
  | { reason: 'stop-file-unknown'; file: string }
  | { reason: 'bad-range'; file: string; detail: string }
  | { reason: 'unsafe-path'; path: string; detail: string };
