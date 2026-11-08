// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AC-A1 made runnable (T-19): does a derivation LISTEN? Whether the plan is any GOOD is a different
 * question, and nothing here can answer it.
 *
 * Same idea, answers differing at exactly one decision D: the steps downstream of D differ, and
 * the steps independent of D do not. Neither half means anything alone. A derivation that rewrites
 * everything on any input satisfies the first; one that ignores the answers satisfies the second.
 * And neither can be evaluated at all unless the same idea and answers give the same plan, so
 * that comes first as a precondition.
 *
 * The derivation is a parameter, so the real engine and a deliberately wrong one go through exactly
 * the same judge. **"Downstream" is worked out here, from the plan's own `dependsOn`**, and this file
 * imports nothing from the engine: a wrong engine must not be able to agree with a wrong test.
 *
 * There are three possible answers, not two. A decision with nothing downstream makes the first
 * clause vacuous, one with nothing independent makes the second vacuous, and a derivation that
 * refuses leaves nothing to compare. Each of those is "cannot judge", with its reason, which is
 * never a pass (`autodev/instructions/empty-is-not-absence.md`).
 */

export interface StepLike {
  id: string;
  target: { file: string };
  dependsOn: string[];
  decision: { chosen: string | null };
  [key: string]: unknown;
}
export interface PlanLike {
  steps: StepLike[];
  [key: string]: unknown;
}
export interface DerivedFileLike {
  path: string;
  content: string;
}
export type Derived =
  | { ok: true; plan: PlanLike; files: readonly DerivedFileLike[] }
  | { ok: false; reason: string };
/** One derivation, from an empty cache: the caller's closure has to make that true. A shared cache
 *  would answer the second run, and a derivation that is not deterministic could not be seen. */
export type Derivation = (request: { idea: string; answers?: Readonly<Record<string, string>> }) => Promise<Derived>;

export interface Scenario {
  idea: string;
  /** The decision D, named by the file its step targets (a step's id can change; its target does not). */
  decision: string;
  /** What the two runs answer D with, by option id. They have to differ. */
  answers: readonly [string, string];
  /** Other decisions both runs answer the same, by target file: never D, never downstream of it. */
  alsoAnswered?: Readonly<Record<string, string>>;
}

export interface Clause {
  status: 'pass' | 'fail' | 'not-evaluated';
  why: string;
}
export type Verdict =
  | { kind: 'judged'; precondition: Clause; downstream: Clause; independent: Clause }
  | { kind: 'cannot-judge'; why: string };

/** "It listened", and nothing weaker: a verdict that could not judge is not a pass. */
export function passed(verdict: Verdict): boolean {
  return verdict.kind === 'judged'
    && verdict.precondition.status === 'pass'
    && verdict.downstream.status === 'pass'
    && verdict.independent.status === 'pass';
}

/**
 * Every step whose `dependsOn` chain reaches `decisionId`, not counting the decision itself. Its own
 * answer changing is the input, and counting it would let a derivation that changes nothing but
 * `chosen` look as though it had responded. Repeated passes rather than one forward pass, because
 * this must not assume the plan is in order: the plan is what is being judged.
 */
export function stepsReaching(plan: PlanLike, decisionId: string): Set<string> {
  const reached = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of plan.steps) {
      if (step.id === decisionId || reached.has(step.id)) continue;
      if (step.dependsOn.some((dep) => dep === decisionId || reached.has(dep))) {
        reached.add(step.id);
        grew = true;
      }
    }
  }
  return reached;
}

type Finished = Extract<Derived, { ok: true }>;

const PASS: Clause = { status: 'pass', why: '' };
const NOT_EVALUATED: Clause = { status: 'not-evaluated', why: 'the same input did not give the same plan, so a difference would mean nothing' };
const fail = (why: string): Clause => ({ status: 'fail', why });

/** `generatedAt` and `cost` describe the run, not the plan (T-17). Everything else has to match. */
function withoutRunFields(plan: PlanLike): Record<string, unknown> {
  return Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'generatedAt' && key !== 'cost'));
}

function bytesOf(derived: Finished, file: string): string | undefined {
  return derived.files.find((f) => f.path === file)?.content;
}

function stepFor(plan: PlanLike, file: string): StepLike | undefined {
  return plan.steps.find((s) => s.target.file === file);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A step without `ordinal`, which is only where it sits in the list. A replan can move what it
 * rewrites to later in the plan (T-17, `insertInOrder`), and every step after the old position then
 * has a smaller number without being a different step. "Did this step change?" is a question about the
 * step; the independent steps' order among themselves is checked on its own, in `checkIndependent`.
 */
function withoutPosition(step: StepLike): Record<string, unknown> {
  return Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'ordinal'));
}

/**
 * What a step itself decides and builds, for "did this step respond?". Not its position, not its
 * `id` (a hash of the decision), and not `dependsOn`, whose ids change as a side effect the moment
 * something it depends on is re-derived: a step nobody re-derived must not pass for one that was
 * (a one-hop re-derivation did, until this: the step after the direct dependent inherited a new id).
 */
function whatItDecides(step: StepLike): Record<string, unknown> {
  return Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'ordinal' && key !== 'id' && key !== 'dependsOn'));
}

function checkPrecondition(first: Finished, second: Finished): Clause {
  for (const step of first.plan.steps) {
    const other = stepFor(second.plan, step.target.file);
    if (!same(step, other)) return fail(`the step for ${step.target.file} differs between two runs of the same input`);
    if (bytesOf(first, step.target.file) !== bytesOf(second, step.target.file)) return fail(`the file ${step.target.file} differs between two runs of the same input`);
  }
  if (!same(withoutRunFields(first.plan), withoutRunFields(second.plan))) return fail('the plan differs between two runs of the same input');
  if (!same(sortedFiles(first), sortedFiles(second))) return fail('the files differ between two runs of the same input');
  return PASS;
}

function sortedFiles(derived: Finished): DerivedFileLike[] {
  return [...derived.files].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function checkDownstream(a: Finished, b: Finished, decision: StepLike, downstream: readonly StepLike[], answers: readonly [string, string]): Clause {
  const aDecision = decision.decision.chosen;
  const bDecision = stepFor(b.plan, decision.target.file)?.decision.chosen;
  if (aDecision === bDecision) return fail(`the decision itself did not take the answer: ${decision.target.file} chose ${String(aDecision)} in both runs (asked for ${answers[0]} and ${answers[1]})`);
  for (const step of downstream) {
    const counterpart = stepFor(b.plan, step.target.file);
    if (counterpart === undefined) continue; // gone is a difference
    if (same(whatItDecides(step), whatItDecides(counterpart)) && bytesOf(a, step.target.file) === bytesOf(b, step.target.file)) {
      return fail(`${step.target.file} is downstream of ${decision.target.file} and did not change`);
    }
  }
  return PASS;
}

function checkIndependent(a: Finished, b: Finished, decisionFile: string, independent: readonly StepLike[], bDownstream: ReadonlySet<string>): Clause {
  for (const step of independent) {
    const counterpart = stepFor(b.plan, step.target.file);
    if (counterpart === undefined) return fail(`${step.target.file} is independent of ${decisionFile} and is gone from the second run`);
    if (!same(withoutPosition(step), withoutPosition(counterpart))) return fail(`${step.target.file} is independent of ${decisionFile} and its step changed`);
    if (bytesOf(a, step.target.file) !== bytesOf(b, step.target.file)) return fail(`${step.target.file} is independent of ${decisionFile} and its file changed`);
  }
  const known = new Set(independent.map((s) => s.target.file));
  const inOrder = (derived: Finished): string[] => derived.plan.steps.map((s) => s.target.file).filter((f) => known.has(f));
  if (!same(inOrder(a), inOrder(b))) return fail(`the steps independent of ${decisionFile} are in a different order: ${inOrder(a).join(', ')} then ${inOrder(b).join(', ')}`);
  for (const step of b.plan.steps) {
    if (step.target.file === decisionFile || bDownstream.has(step.id) || known.has(step.target.file)) continue;
    return fail(`${step.target.file} appeared in the second run and is not downstream of ${decisionFile}`);
  }
  return PASS;
}

/**
 * Derives four times: once to learn the decisions, twice with the first set of answers (the
 * precondition), and once with the second.
 *
 * An answer is keyed by step id, and a step's id comes from its decision's words and not from the
 * answer, so the ids read from the first derivation stay good for D and for anything independent of
 * it. They do not stay good downstream of D, whose words a replan can rewrite, which is one reason a
 * scenario may not answer there; the other is that it would no longer differ at exactly one decision.
 */
export async function judgeResponsiveness(derive: Derivation, scenario: Scenario): Promise<Verdict> {
  const cannot = (why: string): Verdict => ({ kind: 'cannot-judge', why });
  const refused = (out: Extract<Derived, { ok: false }>): Verdict => cannot(`the derivation refused: ${out.reason}`);

  if (scenario.answers[0] === scenario.answers[1]) return cannot('the two runs answer the decision the same way: they have to differ at exactly one decision');

  const first = await derive({ idea: scenario.idea });
  if (!first.ok) return refused(first);
  const decision = stepFor(first.plan, scenario.decision);
  if (decision === undefined) return cannot(`no step targets ${scenario.decision}`);

  const reachable = stepsReaching(first.plan, decision.id);
  const shared: Record<string, string> = {};
  for (const [file, option] of Object.entries(scenario.alsoAnswered ?? {})) {
    const other = stepFor(first.plan, file);
    if (other === undefined) return cannot(`no step targets ${file}`);
    if (other.id === decision.id || reachable.has(other.id)) return cannot(`${file} is the decision or downstream of it: answering it too would not differ at exactly one decision`);
    shared[other.id] = option;
  }

  const answersA = { ...shared, [decision.id]: scenario.answers[0] };
  const answersB = { ...shared, [decision.id]: scenario.answers[1] };

  const a = await derive({ idea: scenario.idea, answers: answersA });
  if (!a.ok) return refused(a);
  const again = await derive({ idea: scenario.idea, answers: answersA });
  if (!again.ok) return refused(again);
  const precondition = checkPrecondition(a, again);
  if (precondition.status !== 'pass') return { kind: 'judged', precondition, downstream: NOT_EVALUATED, independent: NOT_EVALUATED };

  const b = await derive({ idea: scenario.idea, answers: answersB });
  if (!b.ok) return refused(b);

  const decided = stepFor(a.plan, scenario.decision);
  if (decided === undefined) return cannot(`the plan answered with ${scenario.answers[0]} has no step for ${scenario.decision}`);
  const down = stepsReaching(a.plan, decided.id);
  const downstream = a.plan.steps.filter((s) => down.has(s.id));
  const independent = a.plan.steps.filter((s) => s.id !== decided.id && !down.has(s.id));
  if (downstream.length === 0) return cannot(`nothing is downstream of ${scenario.decision}, so "the steps downstream differ" would be true of nothing`);
  if (independent.length === 0) return cannot(`nothing is independent of ${scenario.decision}, so "the independent steps do not differ" would be true of nothing`);

  const decidedInB = stepFor(b.plan, scenario.decision);
  const bDown = decidedInB === undefined ? new Set<string>() : stepsReaching(b.plan, decidedInB.id);
  return {
    kind: 'judged',
    precondition,
    downstream: checkDownstream(a, b, decided, downstream, scenario.answers),
    independent: checkIndependent(a, b, scenario.decision, independent, bDown),
  };
}
