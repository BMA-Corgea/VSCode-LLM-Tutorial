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
   * It lives HERE so it can be overlaid (`withChosen`) on any plan the walk is handed. A replan
   * that lands (T-22) also writes it into the new plan's `decision.chosen`, because a plan version
   * has to say by itself what it was derived with; this field is written then too, and only then,
   * so the two agree. A press that did not land leaves no trace here.
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
  /** T-22: the step whose decision produced this one. Set only on a step a re-plan wrote, which has no author. */
  derivedFrom?: string;
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

/** One re-plan on the record, in the plan it produced (T-22), oldest first. */
export interface PlanDivergence {
  stepId: string;
  /** the option id taken */
  answer: string;
  /** walked steps that stood on the old road, by id, in plan order (the M1 warning) */
  staleDependents: string[];
  /** steps that stood on the old road and were kept on it, not walked, because a walked step stands on them, by id, in
   *  plan order (the stopped re-review's NF3). Absent when there are none. */
  keptOnOldRoad?: string[];
  at: string;
  /** which tree in the `derived/` store holds this plan's re-derived files; absent while none was ever written */
  tree?: string;
  /** `false` when nothing was re-derived: every later step that stood on the old road was already walked
   *  (T-22's code review, MF1). Absent means it was re-planned. */
  replanned?: false;
}

/**
 * The store path of the tree this plan's re-derived files live in, or `undefined` for a plan that
 * has not diverged. The plan names its own tree so one atomic write of `plan.json` is the whole
 * switch: a plan can never be paired with another plan's code, whatever a crash interrupted.
 * `plan.json` can be edited by hand, so this reads it as `unknown`, and the caller proves the path.
 */
export function treeNamedBy(plan: PlanLike): string | undefined {
  const all: unknown = plan['divergences'];
  if (!Array.isArray(all)) return undefined;
  const last: unknown = all[all.length - 1];
  const tree = typeof last === 'object' && last !== null ? (last as { tree?: unknown }).tree : undefined;
  return typeof tree === 'string' && tree.length > 0 ? tree : undefined;
}

/**
 * The reason a plan gives at a decision is the reason for the road it RECOMMENDS: repo-tour's `why` is
 * why the author did it their way, and a derived node's is why its `recommended` option is the one.
 * Sent beside any other road it argues for the road not taken, and a model asked for that road's code
 * follows the reason over the choice: T-22's live run asked for "Scan the ranges one by one" with "Binary
 * search on a sorted flat array of [start, end] pairs." as the why, and got a binary search. So another
 * road goes out with a sentence that says whose road it is, and the reason stays with its own road.
 */
export function whyForRoad(why: string, chosenId: string, recommendedId: string, recommendedLabel: string | undefined): string {
  if (chosenId === recommendedId) return why;
  const named = recommendedLabel === undefined ? '' : ` ("${recommendedLabel}")`;
  return `The learner chose this road instead of the recommended one${named}. The plan's reason for the recommended road does not apply to this one.`;
}


/**
 * The road a step's code follows: what a re-plan derived it with (`decision.chosen`), else the one it
 * recommends. Only a re-derived step's code follows `chosen`; an author's step is the author's road.
 */
export function roadItsCodeFollows(step: StepLike): string {
  return step.derivedFrom !== undefined && step.decision.chosen !== null ? step.decision.chosen : step.decision.authorChoice;
}

/** The step's `why`, sent only beside the road it was written for (`whyForRoad`): a re-derived step's code may follow another. */
export function whyOfStep(step: StepLike): string {
  const why = typeof step.decision.why === 'string' ? step.decision.why : '';
  if (step.derivedFrom === undefined) return why;
  return whyForRoad(why, roadItsCodeFollows(step), step.decision.authorChoice, step.decision.options.find((o) => o.id === step.decision.authorChoice)?.label);
}

/**
 * Whether anything later stands on this step: a step whose `dependsOn` names it, or, for a chapter's shape
 * step, a file in that chapter (the edge the engine adds, `graphOf` in `../derive/diverge.ts`).
 */
export function stepHasDependents(plan: PlanLike, stepId: string): boolean {
  // Total over a hand-edited plan: the page asks this of every chapter step it draws (`pressRules`).
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const step = steps.find((s) => s?.id === stepId);
  if (step === undefined) return false;
  return steps.some((s) => s?.id !== stepId && ((Array.isArray(s?.dependsOn) && s.dependsOn.includes(stepId)) || (step.kind === 'shape' && s?.kind === 'file' && s.chapter === step.chapter)));
}

/**
 * T-22 (the re-review's R3 and R1, ruled 2026-11-11: one writer per file). The step that writes each file of this
 * plan: the re-derived `file` step at it, else the author's `file` step.
 *
 * A re-plan that rewrites a file takes it over from the steps the author had at it. At a press on a symbol step the
 * file's own step comes first in plan order, so it is walked and stays (T-23: a walked step is never removed or
 * rewritten), and so do the file's walked symbol steps. Each keeps its own record exactly as the learner left it
 * (walked, its verdict, its commit), and from the press on it writes, outlines and checks nothing for the file: the
 * step that writes it now does, and its roads are chosen there. Total over a hand-edited plan: of two re-derived file
 * steps at one file, the later in plan order writes it.
 */
export function fileWriters(plan: PlanLike): Map<string, StepLike> {
  const steps = Array.isArray(plan.steps) ? [...plan.steps].sort((a, b) => a.ordinal - b.ordinal) : [];
  const authors = new Map<string, StepLike>();
  const derived = new Map<string, StepLike>();
  for (const s of steps) {
    const file: unknown = s?.target?.file;
    if (s?.kind !== 'file' || typeof file !== 'string') continue;
    if (s.derivedFrom !== undefined) derived.set(file, s);
    else if (!authors.has(file)) authors.set(file, s);
  }
  for (const [file, s] of derived) authors.set(file, s);
  return authors;
}

/** The re-derived step that writes this step's file now, when that is another step (see `fileWriters`). */
export function takenOverBy(plan: PlanLike, step: StepLike): StepLike | undefined {
  return takenOverIn(fileWriters(plan), step);
}

/** `takenOverBy`, with the writers worked out once by a caller that asks about many steps. */
export function takenOverIn(writers: ReadonlyMap<string, StepLike>, step: StepLike): StepLike | undefined {
  if (step.kind === 'shape' || typeof step.target?.file !== 'string') return undefined;
  const writer = writers.get(step.target.file);
  return writer !== undefined && writer.id !== step.id && writer.derivedFrom !== undefined ? writer : undefined;
}

/** The steps whose file `writer` has taken over (see `fileWriters`), in plan order. */
export function stepsTakenOverBy(plan: PlanLike, writer: StepLike): StepLike[] {
  const writers = fileWriters(plan);
  const steps = Array.isArray(plan.steps) ? [...plan.steps].sort((a, b) => a.ordinal - b.ordinal) : [];
  return steps.filter((s) => takenOverIn(writers, s)?.id === writer.id);
}

/** T-22: the plan's own record of the last re-plan decided at this step, if it has one. */
export function divergenceAt(plan: PlanLike, stepId: string): { staleDependents: string[]; keptOnOldRoad: string[]; replanned: boolean } | undefined {
  const all: unknown = plan['divergences'];
  if (!Array.isArray(all)) return undefined;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const entry: unknown = all[i];
    if (typeof entry !== 'object' || entry === null || (entry as { stepId?: unknown }).stepId !== stepId) continue;
    const stale: unknown = (entry as { staleDependents?: unknown }).staleDependents;
    const kept: unknown = (entry as { keptOnOldRoad?: unknown }).keptOnOldRoad;
    return {
      staleDependents: Array.isArray(stale) ? stale.filter((id): id is string => typeof id === 'string') : [],
      keptOnOldRoad: Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : [],
      replanned: (entry as { replanned?: unknown }).replanned !== false,
    };
  }
  return undefined;
}

/** The steps this learner has walked: done, or before where they stand now (T-22's definition). */
export function walkedSteps(plan: PlanLike, progress: Progress): Set<string> {
  const here = currentStep(plan, progress)?.ordinal ?? -Infinity;
  return new Set(plan.steps.filter((s) => s.ordinal < here || progress.steps[s.id]?.status === 'done').map((s) => s.id));
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

/**
 * T-51: whether the walk stands at either end of the plan, decided by the very functions a press of
 * *Previous* or *Next* uses, so "disabled" and "a press would not move" can never disagree: `atFirst` exactly
 * when `prevStepId` is `null`, `atLast` exactly when `nextStepId` is. A one-step plan is both.
 */
export function planEnds(plan: PlanLike, progress: Progress): { atFirst: boolean; atLast: boolean } {
  return { atFirst: prevStepId(plan, progress) === null, atLast: nextStepId(plan, progress) === null };
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
 * A recorded choice the page could not show — a rebuilt plan whose options changed, an id past the
 * window the page draws, an id two rows share — is IGNORED rather than shown: the page must never
 * mark a road that is not on the table, and whatever is overlaid here is what the replan reads
 * (T-22), so the screen and `decision.chosen` must agree. `optionsTable` is what decides. Steps and
 * fields this function has no reason to touch are passed through by reference.
 */
export function withChosen(plan: PlanLike, progress: Progress): PlanLike {
  if (!Array.isArray(plan.steps)) return plan;
  let changed = false;
  const steps = plan.steps.map((step) => {
    const chosen = progress.steps[step.id]?.chosen;
    if (typeof chosen !== 'string' || !step.decision || !Array.isArray(step.decision.options)) return step;
    if (!optionsTable(step).keys.includes(chosen)) return step;
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

// ── what a step's options list can show, decided once (T-21) ─────────────────────────────────

/**
 * How many options this panel will draw for one step.
 *
 * Measured, not guessed. A plan built with no interpretation gives every step exactly ONE
 * option ("What the author did") — that is all 61 steps of the real sql-gauntlet plan. A fully
 * interpreted step gives THREE: the author's own, plus the "exactly two OTHER reasonable ways"
 * repo-tour's interpreter prompt asks for by name. Nothing repo-tour can legitimately produce
 * goes past three, so 24 leaves eight times the headroom a real plan needs — while a hostile
 * `alternatives` array (repo-tour's `parseAlternatives` keeps every entry the model emitted,
 * unbounded) stops here instead of at ten thousand `<li>`s.
 */
export const MAX_OPTIONS_RENDERED = 24;

/** The longest option id `step:choose` carries (T-21) — ids are keys, and a key longer than this is not one a plan carries. */
export const MAX_OPTION_ID = 256;

/** Whether a value is an option id the panel can carry: what the message parser accepts and what a button may post. One copy, so the page never draws a control whose press is dropped. */
export function isOptionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OPTION_ID;
}

/** A step's options as the panel draws them. Rows are indices into `rows`; -1 means "no such row". */
export interface OptionsTable {
  /** What the page draws, in order: the first `MAX_OPTIONS_RENDERED`, with the author's option taking the last slot when a plan buries it past them. */
  rows: OptionLike[];
  /** How many of the plan's options are not among `rows`. */
  omitted: number;
  /** Each row's id when a press can name it — a key the message can carry, that no other row shares — and `null` when it cannot. */
  keys: Array<string | null>;
  /** The author's road. `taken` first, `authorChoice` when no option carries it. */
  author: number;
  /** The road this step is ON: the learner's when `decision.chosen` names a row, else the author's. */
  on: number;
  /** The step is on a road that is not the author's. */
  diverged: boolean;
  /** One per row: a press there can be taken, so the page draws a control and the session accepts it. */
  choosable: boolean[];
  /** The road this step is on can itself be pressed: it is a choice no re-plan followed (`PressRules`, the re-review's R11). */
  replansOn: boolean;
}

/**
 * T-22: what a press on a step's roads may do beyond T-21's table, read from the plan the step is in. Decided once,
 * here, for the page that draws the controls and the session that takes the press, so the two cannot disagree.
 */
export interface PressRules {
  /** The step that writes this step's file now (`takenOverBy`): no road of this step is pressed (the re-review's R3). */
  takenOverBy?: StepLike;
  /**
   * A choice no re-plan followed, at a step something stands on, re-plans when its own road is pressed (the re-review's
   * R11). The page says such a choice "was not re-planned" (SF4), and every folder walked before T-22 can hold one in
   * `progress.json`. A choice at a chapter step nothing stands on has nothing to re-plan: it stays recorded.
   */
  replansOwnRoad: boolean;
}

export function pressRules(plan: PlanLike, step: StepLike): PressRules {
  const writer = takenOverBy(plan, step);
  const replansOwnRoad = divergenceAt(plan, step.id) === undefined && !(step.kind === 'shape' && !stepHasDependents(plan, step.id));
  return { ...(writer === undefined ? {} : { takenOverBy: writer }), replansOwnRoad };
}

/**
 * "The road this step is on" and "what the page can show", decided ONCE (T-21, the code and
 * security reviews' C4/C5/C6). The page draws from this, `WalkSession.choose` accepts by this, and
 * `withChosen` overlays by this, all from the same overlaid step. Each used to work it out alone:
 * the page read `taken` first where the session read `chosen ?? authorChoice`, the session accepted
 * ids past the window the page draws, and the page drew buttons for ids the parser drops — three
 * ways a control and its press could disagree, each found by pressing one.
 *
 * Which option is the AUTHOR'S is `taken` first and `authorChoice` only when `taken` answers nothing
 * (T-4 code review, finding 6): a plan from an older builder can carry `authorChoice` with no
 * `taken` anywhere. It is resolved to one row, so two rows can never both light up. The learner's
 * choice sets `decision.chosen` and never `taken`. A row whose id a press could not name gets no
 * control, and neither does any row when the step itself has no id the page could report.
 *
 * Total over whatever `plan.json` said: every field is read defensively, because the types above
 * are a cast over `JSON.parse`.
 */
export function optionsTable(step: Pick<StepLike, 'id' | 'decision'>, rules?: PressRules): OptionsTable {
  const decision = step.decision as Partial<StepLike['decision']> | undefined;
  const all = Array.isArray(decision?.options) ? decision.options : [];

  const taken = all.findIndex((option) => option?.taken === true);
  const authorChoice = decision?.authorChoice;
  const authorInPlan = taken !== -1 || typeof authorChoice !== 'string' || authorChoice === ''
    ? taken
    : all.findIndex((option) => option?.id === authorChoice);

  // AC2 outranks the cap: the option that must be marked takes the window's last slot rather than
  // being one of the ones dropped.
  const rows = all.slice(0, MAX_OPTIONS_RENDERED);
  let author = authorInPlan;
  if (authorInPlan >= MAX_OPTIONS_RENDERED) {
    rows[MAX_OPTIONS_RENDERED - 1] = all[authorInPlan]!;
    author = MAX_OPTIONS_RENDERED - 1;
  }

  const ids = rows.map((option) => option?.id);
  const keys = ids.map((id) => (isOptionKey(id) && ids.indexOf(id) === ids.lastIndexOf(id) ? id : null));

  const chosen = decision?.chosen;
  const learners = isOptionKey(chosen) ? keys.indexOf(chosen) : -1;
  const on = learners !== -1 ? learners : author;
  const diverged = learners !== -1 && learners !== author;
  // T-22: a step whose file another step writes now offers no road (R3); a choice no re-plan followed offers its own (R11).
  const canPress = rows.length >= 2 && typeof step.id === 'string' && step.id !== '' && rules?.takenOverBy === undefined;
  const replansOn = canPress && diverged && rules?.replansOwnRoad === true && keys[on] !== null;
  return {
    rows,
    omitted: all.length - rows.length,
    keys,
    author,
    on,
    diverged,
    choosable: keys.map((key, row) => canPress && key !== null && (row !== on || replansOn)),
    replansOn,
  };
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
