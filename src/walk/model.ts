// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The walk's own state, as pure data (spec §5.3, T-1 §4.2) — no `vscode` import, same house
 * style as `src/start/request.ts`/`src/start/build.ts`. `Progress` is the ONLY thing this
 * extension ever writes into the target (`<target>/.repo-tour/build/progress.json`,
 * `src/walk/store.ts`); `BuildPlan` itself is repo-tour's own output and is read-only here
 * (T-1 §4: "never hand-edited, never repaired in place").
 *
 * The plan-shaped types below (`PlanLike`, `StepLike`, …) are a duck-typed slice of
 * repo-tour's real `BuildPlan`/`Step` (repo-tour `src/build/types.ts`) — never a full mirror,
 * same reasoning `src/start/build.ts`'s `BuildPlanLike` gives for its own boundary: this file
 * stays typecheckable with no dependency on repo-tour's own `dist/*.d.ts` actually being
 * present, and needs no edit if repo-tour's real types grow a field this walk never reads.
 */

import type { Dial } from '../start/request.js';

export type StepStatus = 'pending' | 'done';

export interface ProgressStep {
  status: StepStatus;
  /** Per-step override of the global (start-screen) dial — spec §5.4. Absent = "use the
   *  global setting", which is T-5's job to read; T-4 only renders and persists this. */
  dial?: Dial;
  /** One transcript slot per step, T-6's tutor. Untouched by T-4 — declared now so this
   *  shape never has to migrate later (same reasoning as repo-tour's own `Option[]` floor). */
  transcript?: unknown[];
  /** The last structural check for this step (T-5, AC5). Absent means nobody has pressed
   *  *Check my work* here yet, which is different from a check that ran and failed — the
   *  tree renders those differently, and a learner deserves that distinction. */
  check?: { ok: boolean; at: string };
  /**
   * The option the LEARNER chose at this step, when they chose one (T-21, T-10 E1) — an option id
   * of this step. Absent means the learner has not chosen, and the step stands as the plan has it.
   *
   * It lives HERE, in progress, not in `plan.json`: the plan is repo-tour's output and the walk
   * never writes it (one writer per file — the foreman's ruling at T-21's gate). The session
   * overlays it onto `decision.chosen` (`withChosen`) in the plan every consumer is handed, which
   * is where the replan (T-22) reads it. Latest wins until T-22 lands.
   */
  chosen?: string;
}

/** `<target>/.repo-tour/build/progress.json` — schema §5.3 refinement notes, verbatim. */
export interface Progress {
  schemaVersion: 1;
  current: string | null;
  steps: Record<string, ProgressStep>;
  /** When `plan.reproduce`'s never-taught files were copied into the target (ISO, T-5).
   *  Absent means never — the offer is still worth making. */
  reproduced?: string;
}

export interface RangeLike {
  startLine: number;
  endLine: number;
}

export interface OptionLike {
  id: string;
  label: string;
  consequence: string;
  taken: boolean;
}

export type StepKind = 'shape' | 'file' | 'symbol';
export type WhySource = 'interpret' | 'docstring' | 'none';

export interface StepLike {
  id: string;
  ordinal: number;
  chapter: string;
  kind: StepKind;
  decision: {
    question: string;
    options: OptionLike[];
    authorChoice: string;
    chosen: string | null;
    why: string;
    whySource: WhySource;
  };
  target: { file: string; startLine?: number; endLine?: number };
  scaffold: { loadBearing: RangeLike[]; boilerplate: RangeLike[] };
  dependsOn: string[];
  witness: { sha: string | null; date: string | null; subject: string | null };
}

export interface ChapterLike {
  key: string;
  title: string;
  subtitle: string;
  tierPath: string;
}

export interface PlanLike {
  chapters: ChapterLike[];
  steps: StepLike[];
  [key: string]: unknown;
}

/** A brand-new build's progress: nothing done yet, parked on the plan's first step (by
 *  ordinal — the flat `steps` array is documented as already ordered, but a fixture or a
 *  future producer is not obliged to hand it over pre-sorted). `null` only for a plan with
 *  no steps at all, which nothing downstream can usefully walk anyway. */
export function emptyProgress(plan: PlanLike): Progress {
  const first = orderedSteps(plan)[0];
  return { schemaVersion: 1, current: first?.id ?? null, steps: {} };
}

function orderedSteps(plan: PlanLike): StepLike[] {
  return [...plan.steps].sort((a, b) => a.ordinal - b.ordinal);
}

export function currentStep(plan: PlanLike, progress: Progress): StepLike | undefined {
  return progress.current ? plan.steps.find((s) => s.id === progress.current) : undefined;
}

/** The step after the current one; `null` at the END of the plan — no wraparound.
 *
 *  When `current` names no step in this plan (nothing is current yet, or a stale id survived
 *  a rebuild) this returns the FIRST step rather than `null`: "where does a walk with no
 *  usable position begin" has one sensible answer, and stranding the walk is not it.
 *  `prevStepId` is genuinely `null` in that case, since there is nothing before the start. */
export function nextStepId(plan: PlanLike, progress: Progress): string | null {
  const steps = orderedSteps(plan);
  const idx = steps.findIndex((s) => s.id === progress.current);
  if (idx === -1) return steps[0]?.id ?? null;
  return steps[idx + 1]?.id ?? null;
}

/** `null` at the start of the plan (or when the current id is not found at all). */
export function prevStepId(plan: PlanLike, progress: Progress): string | null {
  const steps = orderedSteps(plan);
  const idx = steps.findIndex((s) => s.id === progress.current);
  if (idx <= 0) return null;
  return steps[idx - 1]?.id ?? null;
}

export function setCurrent(progress: Progress, stepId: string): Progress {
  return { ...progress, current: stepId };
}

export function markDone(progress: Progress, stepId: string): Progress {
  const existing = progress.steps[stepId];
  return { ...progress, steps: { ...progress.steps, [stepId]: { ...existing, status: 'done' } } };
}

export function setDial(progress: Progress, stepId: string, dial: Dial): Progress {
  const existing = progress.steps[stepId];
  return { ...progress, steps: { ...progress.steps, [stepId]: { status: existing?.status ?? 'pending', ...existing, dial } } };
}

export function setChosen(progress: Progress, stepId: string, optionId: string): Progress {
  const existing = progress.steps[stepId];
  return { ...progress, steps: { ...progress.steps, [stepId]: { status: existing?.status ?? 'pending', ...existing, chosen: optionId } } };
}

/**
 * The plan as the walk shows it: each step's `decision.chosen` is the learner's choice when they
 * made one (T-21). Pure — a NEW plan; the original (repo-tour's, read from disk) is never mutated.
 *
 * A recorded choice that names no option of its step — a rebuilt plan whose options changed — is
 * IGNORED rather than shown: the page must never mark a road that is not on the table. Steps and
 * fields this function has no reason to touch are passed through by reference.
 */
export function withChosen(plan: PlanLike, progress: Progress): PlanLike {
  if (!Array.isArray(plan.steps)) return plan;
  let changed = false;
  const steps = plan.steps.map((step) => {
    const chosen = progress.steps[step.id]?.chosen;
    if (typeof chosen !== 'string' || !step.decision || !Array.isArray(step.decision.options)) return step;
    if (!step.decision.options.some((option) => option?.id === chosen)) return step;
    if (step.decision.chosen === chosen) return step;
    changed = true;
    return { ...step, decision: { ...step.decision, chosen } };
  });
  return changed ? { ...plan, steps } : plan;
}

export function setCheck(progress: Progress, stepId: string, ok: boolean, at: string): Progress {
  const existing = progress.steps[stepId];
  return { ...progress, steps: { ...progress.steps, [stepId]: { status: existing?.status ?? 'pending', ...existing, check: { ok, at } } } };
}

/**
 * The dial that actually applies to a step: its own override, else the GLOBAL one from the
 * start screen (`request.json`), else `manual`.
 *
 * This is the whole of AC1's "global, and overridable per step", and it is a pure function on
 * purpose — T-4 shipped only the override half and fell back to `manual`, which quietly
 * understated what mode the learner was in the moment they set a global. `manual` remains the
 * last resort because it is the only value that cannot overstate what has happened to their
 * files: it means nothing was written, and nothing written is always a safe thing to claim.
 */
export function stepDial(progress: Progress, stepId: string | null, globalDial?: Dial): Dial {
  const own = stepId ? progress.steps[stepId]?.dial : undefined;
  return own ?? globalDial ?? FALLBACK_DIAL;
}

// ── the decision tree (AC1) ─────────────────────────────────────────────────────────────────

export interface TreeStepNode {
  id: string;
  ordinal: number;
  kind: StepKind;
  /** the step's own question, doubling as its tree label — repo-tour's `Step` has no
   *  separate short title, and the question IS what the learner is here to see. */
  title: string;
  status: 'done' | 'current' | 'pending';
  /** The last check's verdict, when one has run (T-5, AC5). `undefined` means "not checked",
   *  which the tree must show differently from "checked and failed" — otherwise every step a
   *  learner has not reached yet looks like a step they got wrong. */
  check?: 'pass' | 'fail';
}

export interface TreeChapterNode {
  key: string;
  title: string;
  subtitle: string;
  steps: TreeStepNode[];
}

function stepStatus(progress: Progress, step: StepLike): TreeStepNode['status'] {
  if (step.id === progress.current) return 'current';
  return progress.steps[step.id]?.status === 'done' ? 'done' : 'pending';
}

/** Chapters in plan order, each with its steps in ordinal order; a chapter with no steps at
 *  all (should not happen in a real plan, but a hand-built fixture might) is omitted rather
 *  than shown as an empty, unclickable node. */
export function treeModel(plan: PlanLike, progress: Progress): TreeChapterNode[] {
  const byChapter = new Map<string, TreeStepNode[]>();
  for (const step of orderedSteps(plan)) {
    const recorded = progress.steps[step.id]?.check;
    const node: TreeStepNode = {
      id: step.id,
      ordinal: step.ordinal,
      kind: step.kind,
      title: step.decision.question,
      status: stepStatus(progress, step),
      ...(recorded ? { check: recorded.ok ? ('pass' as const) : ('fail' as const) } : {}),
    };
    const list = byChapter.get(step.chapter);
    if (list) list.push(node);
    else byChapter.set(step.chapter, [node]);
  }
  const declared = plan.chapters
    .map((chapter): TreeChapterNode => ({ key: chapter.key, title: chapter.title, subtitle: chapter.subtitle, steps: byChapter.get(chapter.key) ?? [] }))
    .filter((chapter) => chapter.steps.length > 0);

  // Steps whose `chapter` names nothing in `plan.chapters` get a chapter of their own rather
  // than vanishing (T-4 code review, finding 7). They were previously dropped silently, which
  // produced the one tree state that is worse than an ugly one: the learner is ON a step —
  // Next/Previous reach it, the panel renders it — that the tree does not contain, so the
  // tree stops agreeing with everything else on screen. A real plan has no orphans; a stale
  // or hand-edited one can, and an honest odd-looking chapter beats a silent hole.
  const declaredKeys = new Set(plan.chapters.map((chapter) => chapter.key));
  const orphans = [...byChapter.entries()]
    .filter(([key, steps]) => !declaredKeys.has(key) && steps.length > 0)
    .map(([key, steps]): TreeChapterNode => ({ key, title: key, subtitle: 'not listed in this plan\u2019s chapters', steps }));

  return [...declared, ...orphans];
}

// ── the status bar (AC6) ─────────────────────────────────────────────────────────────────────

/** repo-tour's own default, mirrored: `src/start/request.ts`'s `DEFAULT_DIAL` is what a
 *  brand-new build's global setting defaults to, and it is the honest fallback here too when
 *  a step has no per-step override recorded yet (T-5 threads the real global default through
 *  `request.json`; T-4 does not read that file, so "manual" — never built, nothing to type —
 *  is the fallback that can never overstate what has actually happened to this step). */
export const FALLBACK_DIAL: Dial = 'manual';

/** "step 7 / 40 · scaffolded" (AC6) — 1-indexed against the plan's own ordinal order. */
export function statusText(plan: PlanLike, progress: Progress, globalDial?: Dial): string {
  const steps = orderedSteps(plan);
  const idx = steps.findIndex((s) => s.id === progress.current);
  const n = idx === -1 ? 1 : idx + 1;
  const m = steps.length;
  return `step ${n} / ${m} · ${stepDial(progress, progress.current, globalDial)}`;
}
