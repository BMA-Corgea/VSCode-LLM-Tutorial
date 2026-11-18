// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A divergence in a real repository's walk (T-22): the learner took a road the author did not, and
 * the steps that follow from it are re-derived. T-1 §2: a Mode A replan seeded by the Mode B prefix.
 *
 * It is the engine's own door. Every question goes through `askOnce`, every reply is judged by
 * T-17's parsers and file check, once, where it comes in, and the graph arithmetic is `graph.ts`'s.
 * What differs from Mode A is carried as parameters (`PathRules`, `ImportRules`), so no Mode A value
 * moves. `replanPlan` and its state door are untouched: a real plan is not a `DerivationState`.
 *
 * The plan is the seed, and step ids are the identities:
 *
 *   - **The file is the unit of re-derivation.** A decision at a `symbol` step is a decision about
 *     its file. That step keeps its id and its place and becomes the step that owns the re-derived
 *     file; the file's other un-walked symbol steps go with it, because their line ranges describe
 *     a file that is being rewritten.
 *   - **A file stands on its chapter's shape step.** repo-tour records a file's imports only, so the
 *     edge is added here, or a decision about a chapter would reach nothing in it.
 *   - **A walked step is kept, and so is what it stands on.** Walked steps the decision reaches are
 *     returned as `staleDependents` for the page to name (the foreman's ruling on M1: warn).
 *
 * Nothing here writes to the learner's folder or to `plan.json`. The caller does, once it has an
 * outcome. No `vscode` import — see `./types.ts`.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DialCore } from '../dial/core.js';
import { languageOf } from '../dial/core.js';
import { readReference, withheldReason } from '../dial/writer.js';
import { fileWriters, takenOverIn, treeNamedBy, type ChapterLike, type PlanDivergence, type PlanLike, type StepLike } from '../walk/model.js';
import { askOnce, newTally, type DeriveAskDeps } from './ask.js';
import { boilerplateRanges, lineCountOf, loadBearingRanges, stepIdFor, type DeriveCost, type ExtractLike } from './assemble.js';
import { costOf, extractAll, REPO_IMPORTS, refusalForFile, thrownSentence, type ImportRules } from './engine.js';
import { ancestorsOf, downstreamOf, externalDependencies, insertInOrder, keptBy, type GraphNode } from './graph.js';
import {
  codePrompt, parseCodeReply, parseReplanReply, replanPrompt, whyForRoad,
  type DecisionForPrompt, type DependencyForPrompt, type PathRules, type ReplanReply, type ShownStep,
} from './prompt.js';
import { writeReferenceTree, type DerivedFile } from './tree.js';
import { DERIVE_LIMITS, isDeriveRefusal, type CodeLanguage, type DeriveRefusal, type DerivedChapter, type DerivedNode } from './types.js';

export interface DivergeInput {
  /** the plan as it stands, before this choice */
  plan: PlanLike;
  /** the repository the plan was built from */
  referenceRoot: string;
  /** the tree of files earlier divergences wrote, when this plan has already diverged */
  derivedRoot: string | null;
  stepId: string;
  /** the option id the learner chose */
  answer: string;
  /** the step ids the learner has already walked */
  walked: ReadonlySet<string>;
}

export interface DivergeDeps extends DeriveAskDeps {
  dialCore: Pick<DialCore, 'extract'>;
  /** the learner's folder: only its path is used, to key the tree */
  target: string;
  onProgress?: (message: string) => void;
  now?: () => Date;
}

export type DivergeOutcome =
  /** Nothing follows from this decision and it owns no file: there is nothing to re-derive. */
  | { ok: true; changed: false; staleDependents: string[]; keptOnOldRoad?: string[]; cost: DeriveCost }
  /**
   * `derivedRoot` is `null` only when no divergence has ever written a tree (a record that re-planned nothing).
   * `replaced`: the plan's steps this press replaced, D never among them. `written`: the steps it wrote. A step
   * it writes can carry the id of one it replaced (an id is a hash of kind, path, question and labels, T-17's
   * F9), so an id that is in the new plan is not proof that its step's code is the one it had. `keptOnOldRoad`: steps
   * that stood on the old road and stay on it, not walked, because a walked step stands on them (NF3); absent means none.
   */
  | { ok: true; changed: true; plan: PlanLike; derivedRoot: string | null; staleDependents: string[]; keptOnOldRoad?: string[]; replaced: string[]; written: string[]; cost: DeriveCost }
  | { ok: false; reason: string; cost: DeriveCost };

/** How many files all of a plan's divergences together may have written. */
const MAX_DERIVED_FILES = 200;
/** A real repository's tree goes deeper than a Mode A app's. */
const REPO_MAX_PATH_SEGMENTS = 12;

function refuse(sentence: string): DeriveRefusal {
  return { refused: sentence };
}

function extensionsFor(language: CodeLanguage): readonly string[] {
  if (language === 'python') return ['.py'];
  if (language === 'javascript') return ['.js', '.mjs', '.cjs'];
  return ['.ts', '.tsx'];
}

function asCodeLanguage(language: string | undefined): CodeLanguage | null {
  return language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'python' ? language : null;
}

/**
 * New files, each after the new files it stands on, so that its code question is shown their new code (the re-review
 * of the fixes, R10). The model's own order otherwise. A cycle is broken where it is met, as repo-tour breaks one.
 */
function inDependencyOrder<T extends { id: string; dependsOn: readonly string[] }>(files: readonly T[]): T[] {
  const byId = new Map(files.map((f) => [f.id, f] as const));
  const seen = new Set<string>();
  const out: T[] = [];
  const visit = (f: T): void => {
    if (seen.has(f.id)) return; // written already, or on the way there: a cycle, broken here
    seen.add(f.id);
    for (const id of f.dependsOn) {
      const dep = byId.get(id);
      if (dep !== undefined) visit(dep);
    }
    out.push(f);
  };
  for (const f of files) visit(f);
  return out;
}

/** The step that writes a decision's file (`fileWriters`): itself, unless it is a symbol inside one. */
function fileStepOf(d: StepLike, writers: ReadonlyMap<string, StepLike>): StepLike {
  if (d.kind !== 'symbol') return d;
  return writers.get(d.target.file) ?? d;
}

/**
 * The plan as a graph over step ids, with the edge from each file to its chapter's shape step.
 *
 * One writer per file (the re-review of the fixes, R3, ruled 2026-11-11): a step that stands on a step whose file has
 * been taken over stands on that file, which its writer holds now, so the edge goes to the writer. A step at that same
 * file keeps its edge: a taken-over step stands on what it stood on when the learner walked it, and so anchors nothing
 * of the code that replaced it.
 */
function graphOf(steps: readonly StepLike[], writers: ReadonlyMap<string, StepLike>): GraphNode[] {
  const shapeOf = new Map(steps.filter((s) => s.kind === 'shape').map((s) => [s.chapter, s.id] as const));
  const byId = new Map(steps.map((s) => [s.id, s] as const));
  const edgeTo = (from: StepLike, id: string): string[] => {
    const to = byId.get(id);
    const writer = to === undefined ? undefined : takenOverIn(writers, to);
    if (to === undefined || writer === undefined) return [id];
    if (from.kind !== 'shape' && from.target.file === to.target.file) return [id];
    return [writer.id];
  };
  return steps.map((s) => {
    const shape = s.kind === 'file' ? shapeOf.get(s.chapter) : undefined;
    const edges = [...new Set(s.dependsOn.flatMap((id) => edgeTo(s, id)))];
    return { path: s.id, dependsOn: shape === undefined || edges.includes(shape) ? edges : [shape, ...edges] };
  });
}

/**
 * A judgment of the model's reply, said as one. T-17's parsers number the reply's own steps ("step 1
 * offers 1 option"), and the page that shows a refusal is a walk with a step 1 of its own.
 */
function ofTheAnswer<T>(value: T | DeriveRefusal): T | DeriveRefusal {
  return isDeriveRefusal(value) ? { refused: `in the model's answer, ${value.refused}` } : value;
}

function nameOf(plan: PlanLike): string {
  const source = plan.source as { root?: unknown; text?: unknown; url?: unknown };
  const named = [source.root, source.url].find((v): v is string => typeof v === 'string' && v.length > 0);
  return named === undefined ? 'this app' : path.basename(named.replace(/[\\/]+$/, '')) || 'this app';
}

interface FreshNode {
  id: string;
  node: DerivedNode;
  /** ids of what it stands on */
  dependsOn: string[];
}

interface Merged {
  fresh: FreshNode[];
  chapters: DerivedChapter[];
}

export async function divergePlan(input: DivergeInput, deps: DivergeDeps): Promise<DivergeOutcome> {
  const tally = newTally();
  const fail = (reason: string): DivergeOutcome => ({ ok: false, reason, cost: costOf(tally, deps) });
  try {
    const { plan, stepId, answer, walked, referenceRoot, derivedRoot } = input;
    const steps = [...plan.steps].sort((a, b) => a.ordinal - b.ordinal);
    const byId = new Map(steps.map((s) => [s.id, s] as const));
    const d = byId.get(stepId);
    if (d === undefined) return fail('that step is not in this plan');
    if (!d.decision.options.some((o) => o.id === answer)) return fail(`${JSON.stringify(answer.slice(0, 40))} is not one of the options at this step`);

    // One writer per file (the re-review of the fixes, R3, ruled 2026-11-11): a step whose file another step writes now
    // has been taken over, and its roads are chosen where the file is written. The walk offers no press there.
    const writers = fileWriters(plan);
    const writerOf = (s: StepLike): StepLike | undefined => (s.kind === 'shape' ? undefined : writers.get(s.target.file));
    const writes = (s: StepLike): boolean => s.kind === 'shape' || writerOf(s)?.id === s.id;
    // What a step stands on, as the graph reads it (the re-check's C1): an edge names the step that writes that file
    // now, never one its file was taken over from; an edge to a step at `file` itself is replaced by that step's own edges
    // (C5: a plan written before one writer per file has D standing on the file step it took over).
    const foundationsOf = (s: StepLike, file: string | null): StepLike[] => {
      const out: StepLike[] = [];
      const seen = new Set<string>([s.id]);
      const visit = (ids: readonly string[]): void => {
        for (const id of ids) {
          const dep = byId.get(id);
          if (dep === undefined || seen.has(dep.id)) continue;
          seen.add(dep.id);
          if (file !== null && dep.kind !== 'shape' && dep.target.file === file) { visit(dep.dependsOn); continue; }
          const live = takenOverIn(writers, dep) ?? dep;
          if (!out.includes(live)) out.push(live);
        }
      };
      visit(s.dependsOn);
      return out;
    };
    const over = takenOverIn(writers, d);
    if (over !== undefined) return fail(`the code for ${d.target.file} is written at step ${over.ordinal} (${over.target.file}) now, so its roads are chosen there`);

    const owner = fileStepOf(d, writers);
    const ownFile = d.kind === 'shape' ? null : owner.target.file;
    const graph = graphOf(steps, writers);
    const { replaced: reached } = keptBy(graph, owner.id, walked);
    const downstream = downstreamOf(graph, owner.id);
    // What a walked step stands on stays where it is (`keptBy`'s own rule).
    const anchored = ancestorsOf(graph, walked);
    // The file is the unit. The files being rewritten: D's own, and every file whose writer the decision reaches.
    const rewritten = new Set<string>(ownFile === null ? [] : [ownFile]);
    for (const s of steps) if (reached.has(s.id) && s.kind === 'file' && writes(s)) rewritten.add(s.target.file);
    // Every step at a rewritten file goes with it unless something walked stands on it: the file's own step at a symbol
    // press (T-22's code review, MF3), its symbol steps, and the steps an earlier re-plan took the file over from (R3).
    // A step at a file the plan keeps still describes it, so it stays (SF2), and a chapter step goes when it is reached.
    const replaced = new Set(steps
      .filter((s) => s.id !== d.id && (s.kind === 'shape' ? reached.has(s.id) : rewritten.has(s.target.file) && !anchored.has(s.id)))
      .map((s) => s.id));
    const staleDependents = steps
      .filter((s) => s.id !== d.id && walked.has(s.id) && (downstream.has(s.id) || s.id === owner.id))
      .map((s) => s.id);
    // Kept on the old road, though not walked, because a walked step stands on it (the stopped re-review's NF3). Named by
    // the step that writes it, or by its chapter step: a symbol step goes where its file goes, and a step that has been
    // taken over writes nothing. D's own file is D's.
    const keptOnOldRoad = steps
      .filter((s) => s.id !== d.id && downstream.has(s.id) && !walked.has(s.id) && !replaced.has(s.id) && writes(s) && (s.kind === 'shape' || s.target.file !== ownFile))
      .map((s) => s.id);
    const named = { staleDependents, ...(keptOnOldRoad.length === 0 ? {} : { keptOnOldRoad }) };
    if (ownFile === null && replaced.size === 0) {
      if (staleDependents.length === 0 && keptOnOldRoad.length === 0) return { ok: true, changed: false, staleDependents, keptOnOldRoad, cost: costOf(tally, deps) };
      // Something does follow, and all of it is kept (T-22's code review, MF1; NF3): there is nothing to re-derive and
      // nothing is asked, but the choice is recorded on a version that names those steps.
      const at = (deps.now?.() ?? new Date()).toISOString();
      const priorTree = treeNamedBy(plan);
      const prior = (plan as { divergences?: PlanDivergence[] }).divergences ?? [];
      const recorded: PlanLike & { divergences: PlanDivergence[] } = {
        ...plan,
        steps: plan.steps.map((s) => (s.id === d.id ? { ...s, decision: { ...s.decision, chosen: answer } } : s)),
        generatedAt: at,
        cost: costOf(tally, deps),
        divergences: [...prior, { stepId: d.id, answer, ...named, at, replanned: false, ...(priorTree === undefined ? {} : { tree: priorTree }) }],
      };
      return { ok: true, changed: true, plan: recorded, derivedRoot, staleDependents, keptOnOldRoad, replaced: [], written: [], cost: costOf(tally, deps) };
    }

    // Each rewritten file is asked about once, through the step that writes it (R3: it was asked once per file step, and a
    // reply with one step per entry was refused). D's own file is D's to write, so it is not one the model is asked to re-plan.
    const reachedUnits = steps.filter((s) => replaced.has(s.id) && (s.kind === 'shape' || (s.kind === 'file' && writes(s) && s.target.file !== ownFile)));
    if (reachedUnits.length > DERIVE_LIMITS.maxSteps) {
      return fail(`this decision reaches ${reachedUnits.length} later steps, more than the ${DERIVE_LIMITS.maxSteps} one press can re-plan`);
    }

    const languageFile = ownFile ?? steps.find((s) => s.kind === 'file' && s.chapter === d.chapter)?.target.file ?? steps.find((s) => s.kind === 'file')?.target.file;
    const language = languageFile === undefined ? null : asCodeLanguage(languageOf(languageFile));
    if (language === null) return fail('this repository is written in a language the engine cannot re-derive');

    // ── the model names a chapter by a short alias; the alias stands for a real directory ──
    const aliases = new Map<string, string>(plan.chapters.map((c, i) => [c.key, `c${i + 1}`]));
    const realKey = new Map<string, string>([...aliases].map(([key, alias]) => [alias, key]));
    const chapterDir = (alias: string): string | null => {
      const key = realKey.get(alias) ?? alias;
      return key.startsWith('@') ? null : key;
    };
    // Each file keeps its own language, and only a file the plan never had takes the decision's (T-22's
    // code review, SF8): a `.ts` decision may reach a `.js` file in a repository that has both.
    const reachedLanguages = new Set<CodeLanguage>([language]);
    for (const s of reachedUnits) {
      const own = s.kind === 'file' ? asCodeLanguage(languageOf(s.target.file)) : null;
      if (own !== null) reachedLanguages.add(own);
    }
    const pathRules: PathRules = { chapterDir, extensions: [...new Set([...reachedLanguages].flatMap(extensionsFor))], maxSegments: REPO_MAX_PATH_SEGMENTS };
    const replacedPaths = new Set(reachedUnits.filter((s) => s.kind === 'file').map((s) => s.target.file));
    const keyOf = (s: StepLike): string => (s.kind === 'shape' ? aliases.get(s.chapter) ?? s.chapter : s.target.file);
    const onRoad = (s: StepLike): string => s.decision.chosen ?? s.decision.authorChoice;
    // Every question this press asks is about the plan after it: D is on the learner's road there,
    // whatever this plan still says, and a file written after D is shown D on that road.
    const roadOf = (s: StepLike): string => (s.id === d.id ? answer : onRoad(s));
    // A step's `why` is the reason for its author's road: beside another road it is not sent (`whyForRoad`).
    const whyOn = (s: StepLike, chosen: string): string => whyForRoad(
      s.decision.why, chosen, s.decision.authorChoice, s.decision.options.find((o) => o.id === s.decision.authorChoice)?.label,
    );
    const shown = (s: StepLike, chosen: string): ShownStep => ({
      kind: s.kind === 'shape' ? 'shape' : 'file',
      chapter: aliases.get(s.chapter) ?? s.chapter,
      path: keyOf(s),
      question: s.decision.question,
      options: s.decision.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence })),
      chosen,
      why: whyOn(s, chosen),
      dependsOn: s.dependsOn.flatMap((id) => { const dep = byId.get(id); return dep === undefined ? [] : [keyOf(dep)]; }),
    });
    const decisionOf = (s: StepLike, chosen: string): DecisionForPrompt => {
      const option = s.decision.options.find((o) => o.id === chosen) ?? s.decision.options[0];
      return { path: keyOf(s), question: s.decision.question, chosen: { label: option?.label ?? '', consequence: option?.consequence ?? '' }, why: whyOn(s, option?.id ?? chosen) };
    };

    const contentOf = (file: string): string => {
      const fromDerived = derivedRoot === null ? null : readReference(derivedRoot, file);
      const read = fromDerived !== null && 'text' in fromDerived ? fromDerived : readReference(referenceRoot, file);
      return 'text' in read ? read.text : '';
    };

    // The packages this repository already uses: a new file may use those, and nothing new.
    const knownFiles: DerivedFile[] = steps
      .filter((s) => s.kind === 'file' && languageOf(s.target.file) !== undefined)
      .map((s) => ({ path: s.target.file, content: contentOf(s.target.file) }));
    const known = await extractAll(deps.dialCore, knownFiles);
    if (typeof known === 'string') return fail(known);
    const packages = new Set<string>();
    for (const e of known.values()) {
      for (const imp of e.imports) {
        if (imp.resolved !== null || imp.raw.startsWith('.')) continue;
        const parts = imp.raw.split('/');
        packages.add(imp.raw.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '').split('.')[0] ?? '');
      }
    }
    const importRules: ImportRules = { ...REPO_IMPORTS, allowsPackage: (name) => packages.has(name) };

    // ── the question, when anything follows from this decision ──
    deps.onProgress?.('re-planning the steps that follow…');
    const asked = steps.filter((s) => reachedUnits.includes(s));
    let merged: Merged = { fresh: [], chapters: [] };
    if (asked.length > 0) {
      const externals = externalDependencies(graph, owner.id, replaced);
      const inside = ancestorsOf(graph, [owner.id]);
      inside.delete(owner.id);
      const showIds = new Set([...inside, ...externals]);
      const decisionStep: StepLike = d.kind === 'symbol' ? { ...d, kind: 'file', target: { file: owner.target.file } } : d;
      const prompt = replanPrompt({
        idea: `The application in the repository "${nameOf(plan)}".`,
        title: nameOf(plan),
        language,
        entry: '',
        chapters: plan.chapters.map((c) => ({ key: aliases.get(c.key) ?? c.key, title: c.title, subtitle: c.subtitle })),
        decision: { ...shown(decisionStep, answer), recommended: d.decision.authorChoice },
        // "Steps that stay exactly as they are": never one this press replaces (the re-check's C6, a cycle through D).
        shown: steps.filter((s) => showIds.has(s.id) && s.kind !== 'symbol' && writes(s) && !replaced.has(s.id)).map((s) => shown(s, roadOf(s))),
        replacing: asked.map((s) => shown(s, roadOf(s))),
      });
      const owedKeys = [keyOf(owner), ...externals.flatMap((id) => { const e = byId.get(id); return e === undefined ? [] : [keyOf(e)]; })];
      const reply = await askOnce(deps, `derive:diverge:${d.id}`, prompt, (t) => {
        const parsed = parseReplanReply(t, language, pathRules);
        return ofTheAnswer(isDeriveRefusal(parsed) ? parsed : mergeReply(parsed, {
          steps, replaced, writes, aliases, keyOf, owedKeys, ownFile, decisionId: d.id, replacedPaths, newFileExtensions: extensionsFor(language),
          reserved: reservedIds(plan, replaced), salt: ((plan as { divergences?: unknown[] }).divergences ?? []).length,
        }));
      }, tally);
      if (isDeriveRefusal(reply)) return fail(reply.refused);
      merged = reply;
    }

    // ── the code: the decision's own file, then every new file, each after the new files it stands on ──
    // Keyed by step id, as `dependsOn` names them: keyed by path, the lookup below always missed, and a new file was
    // never shown the new file it stands on, nor allowed to import it (the re-review of the fixes, R10).
    const freshById = new Map(merged.fresh.map((f) => [f.id, f] as const));
    const written = new Map<string, string>();
    const plannedFiles = new Set([
      // D's own file is in the plan whether or not the file step it took over stays.
      ...(ownFile === null ? [] : [ownFile]),
      ...steps.filter((s) => s.kind === 'file' && !replaced.has(s.id)).map((s) => s.target.file),
      ...merged.fresh.filter((f) => f.node.kind === 'file').map((f) => f.node.path),
    ]);
    const shapeDecision = (chapter: string): DecisionForPrompt => {
      const shape = steps.find((s) => s.kind === 'shape' && s.chapter === chapter);
      if (shape !== undefined) return decisionOf(shape, roadOf(shape));
      return { path: chapter, question: `Where does ${chapter} belong?`, chosen: { label: 'its own folder', consequence: '' }, why: '' };
    };
    const judged = async (file: string, content: string, allowed: ReadonlySet<string>): Promise<DeriveRefusal | null> => {
      const tree = [...plannedFiles].filter((p) => languageOf(p) !== undefined).map((p) => ({ path: p, content: p === file ? content : written.get(p) ?? '' }));
      const extracts = await extractAll(deps.dialCore, tree);
      if (typeof extracts === 'string') return refuse(extracts);
      return refusalForFile({ path: file }, content, extracts.get(file), allowed, plannedFiles, asCodeLanguage(languageOf(file)) ?? language, importRules);
    };
    const writeFile = async (file: string, ticket: string, chapter: DecisionForPrompt, node: DecisionForPrompt, dependencies: DependencyForPrompt[], allowed: ReadonlySet<string>): Promise<DeriveRefusal | null> => {
      const code = await askOnce(deps, ticket, codePrompt({ idea: `The application in the repository "${nameOf(plan)}".`, title: nameOf(plan), language: asCodeLanguage(languageOf(file)) ?? language, chapter, node: { ...node, isEntry: false }, dependencies }), async (t) => {
        const reply = parseCodeReply(t, file);
        if (isDeriveRefusal(reply)) return ofTheAnswer(reply);
        const refused = await judged(file, reply.content, allowed);
        return refused === null ? reply : ofTheAnswer(refused);
      }, tally);
      if (isDeriveRefusal(code)) return code;
      written.set(file, code.content);
      return null;
    };

    if (ownFile !== null) {
      deps.onProgress?.(`writing ${ownFile}…`);
      // What D's file stood on, never a step at D's own file (see `dEdges` below).
      const fileDeps = foundationsOf(owner, ownFile).filter((dep) => dep.kind === 'file' && dep.id !== d.id);
      const dependencies: DependencyForPrompt[] = fileDeps.map((dep) => ({ ...decisionOf(dep, roadOf(dep)), ...shownContent(dep.target.file, written, contentOf) }));
      const refused = await writeFile(ownFile, `derive:code:${d.id}`, shapeDecision(d.chapter), { ...decisionOf(d, answer), path: ownFile }, dependencies, new Set(fileDeps.map((dep) => dep.target.file)));
      if (refused !== null) return fail(refused.refused);
    }
    for (const f of inDependencyOrder(merged.fresh.filter((x) => x.node.kind === 'file'))) {
      deps.onProgress?.(`writing ${f.node.path}…`);
      const dependencies: DependencyForPrompt[] = [];
      const allowed = new Set<string>();
      for (const id of f.dependsOn) {
        const dep = byId.get(id);
        const earlier = freshById.get(id);
        if (dep?.kind === 'file' || dep?.kind === 'symbol') {
          allowed.add(dep.target.file);
          dependencies.push({ ...decisionOf(dep, roadOf(dep)), ...shownContent(dep.target.file, written, contentOf) });
        } else if (earlier !== undefined && earlier.node.kind === 'file') {
          allowed.add(earlier.node.path);
          // Its code follows the road it recommends, which is the road its `why` was written for (`whyForRoad`).
          const road = earlier.node.options.find((o) => o.id === earlier.node.recommended) ?? earlier.node.options[0];
          dependencies.push({ path: earlier.node.path, question: earlier.node.question, chosen: { label: road?.label ?? '', consequence: road?.consequence ?? '' }, why: earlier.node.why, content: written.get(earlier.node.path) ?? '' });
        }
      }
      const chapter = shapeFor(f.node, merged, realKey, shapeDecision);
      const decision: DecisionForPrompt = { path: f.node.path, question: f.node.question, chosen: chosenOf(f.node), why: f.node.why };
      const refused = await writeFile(f.node.path, `derive:code:${f.id}`, chapter, decision, dependencies, allowed);
      if (refused !== null) return fail(refused.refused);
    }

    // ── the tree: everything earlier divergences wrote that is still in the plan, and the new ──
    const derivedFiles = new Map(written);
    if (derivedRoot !== null) {
      for (const s of steps) {
        if (s.kind !== 'file' || replaced.has(s.id) || derivedFiles.has(s.target.file)) continue;
        const prior = readReference(derivedRoot, s.target.file);
        if ('text' in prior) derivedFiles.set(s.target.file, prior.text);
      }
    }
    const files: DerivedFile[] = [...derivedFiles].map(([p, content]) => ({ path: p, content }));
    const extracts = await extractAll(deps.dialCore, files);
    if (typeof extracts === 'string') return fail(extracts);
    const tree = writeReferenceTree(deps.globalStorageRoot, deps.target, nameOf(plan), files, MAX_DERIVED_FILES);
    if (isDeriveRefusal(tree)) return fail(tree.refused);

    const at = (deps.now?.() ?? new Date()).toISOString();
    const stepsById = new Map<string, StepLike>();
    for (const s of steps) if (!replaced.has(s.id)) stepsById.set(s.id, s);
    // D is never replaced, so in a cycle through D it can stand on a step the press did replace: that edge now names
    // the new step at the same file, or goes (the re-review of the fixes, R6; MF2's "nothing depends on a removed step").
    const freshAtFile = new Map(merged.fresh.filter((f) => f.node.kind === 'file').map((f) => [f.node.path, f.id] as const));
    // At a symbol press D writes its file from now on, so it stands on what the file's step stood on, whether that step
    // went with the file (MF3) or stays, walked, taken over (R3). It never stands on a step at its own file: it replaced
    // their code (a plan written before one writer per file has D standing on the file step it took over).
    const dEdges = [...new Set(foundationsOf(owner, ownFile).flatMap((dep) => {
      if (dep.id === d.id) return [];
      if (!replaced.has(dep.id)) return [dep.id];
      const now = dep.kind === 'shape' ? undefined : freshAtFile.get(dep.target.file);
      return now === undefined || now === d.id ? [] : [now];
    }))];
    const answered: StepLike = {
      ...d,
      decision: { ...d.decision, chosen: answer },
      // Its code is the model's now. A step the model wrote in the first place keeps saying where it came from.
      ...(ownFile === null ? {} : { kind: 'file' as const, target: { file: ownFile }, scaffold: scaffoldOf(ownFile, derivedFiles, extracts), derivedFrom: d.derivedFrom ?? d.id }),
      dependsOn: dEdges,
    };
    stepsById.set(d.id, answered);
    for (const f of merged.fresh) stepsById.set(f.id, freshStep(f, d.id, realKey, derivedFiles, extracts));
    const order = insertInOrder<GraphNode>(
      steps.filter((s) => !replaced.has(s.id)).map((s) => ({ path: s.id, dependsOn: s.dependsOn })),
      merged.fresh.map((f) => ({ path: f.id, dependsOn: f.dependsOn })),
    );
    const nextSteps = order.map((n, i) => ({ ...stepsById.get(n.path)!, ordinal: i + 1 }));
    const used = new Set(nextSteps.map((s) => s.chapter));
    const newChapters: ChapterLike[] = merged.chapters.map((c) => ({ key: c.key, title: c.title, subtitle: c.subtitle, tierPath: c.key }));
    const chapters = [...plan.chapters, ...newChapters].filter((c) => used.has(c.key));
    const prior = (plan as { divergences?: PlanDivergence[] }).divergences ?? [];
    const next: PlanLike & { divergences: PlanDivergence[] } = {
      ...plan, chapters, steps: nextSteps, generatedAt: at, cost: costOf(tally, deps),
      divergences: [...prior, { stepId: d.id, answer, ...named, at, tree: tree.storeKey }],
    };
    return { ok: true, changed: true, plan: next, derivedRoot: tree.root, staleDependents, keptOnOldRoad, replaced: [...replaced], written: merged.fresh.map((f) => f.id), cost: costOf(tally, deps) };
  } catch (err) {
    return fail(`the re-plan stopped unexpectedly: ${thrownSentence(err)}`);
  }
}

/**
 * What a code question is shown of a file it may build on: what this press has written for it, else the
 * file as it stands. Never a file the reproduce copy refuses to ship (`withheldReason`: credentials, keys,
 * agent configuration): it is not shipped to a model either (T-22's security review, F3).
 */
function shownContent(file: string, written: ReadonlyMap<string, string>, contentOf: (file: string) => string): { content?: string } {
  const own = written.get(file);
  if (own !== undefined) return { content: own };
  return withheldReason(file) === null ? { content: contentOf(file) } : {};
}

function chosenOf(node: DerivedNode): { label: string; consequence: string } {
  const option = node.options.find((o) => o.id === node.recommended) ?? node.options[0];
  return { label: option?.label ?? '', consequence: option?.consequence ?? '' };
}

function shapeFor(node: DerivedNode, merged: Merged, realKey: ReadonlyMap<string, string>, shapeDecision: (chapter: string) => DecisionForPrompt): DecisionForPrompt {
  const fresh = merged.fresh.find((f) => f.node.kind === 'shape' && f.node.chapter === node.chapter);
  if (fresh !== undefined) return { path: fresh.node.path, question: fresh.node.question, chosen: chosenOf(fresh.node), why: fresh.node.why };
  return shapeDecision(realKey.get(node.chapter) ?? node.chapter);
}

function scaffoldOf(file: string, derived: ReadonlyMap<string, string>, extracts: ReadonlyMap<string, ExtractLike>): StepLike['scaffold'] {
  const total = lineCountOf(derived.get(file) ?? '');
  const extract = extracts.get(file);
  const loadBearing = extract === undefined ? [] : loadBearingRanges(extract, total);
  return { loadBearing, boilerplate: boilerplateRanges(loadBearing, total) };
}

/**
 * repo-tour labels the author's own row with these words, and the model is shown them on the steps
 * it is replacing, so a reply can copy them. A step the model wrote has no author to be labelled
 * after, and this label is what the page and the commit subject print.
 */
const AUTHORS_ROW_LABEL = /^\s*what the author did\s*$/i;
const NEW_STEPS_OWN_LABEL = 'The suggested road';

/** A re-derived step: the walk's shape, Mode A's truths, and a note of which decision it came from. */
function freshStep(f: FreshNode, decisionId: string, realKey: ReadonlyMap<string, string>, derived: ReadonlyMap<string, string>, extracts: ReadonlyMap<string, ExtractLike>): StepLike {
  const n = f.node;
  const chapter = realKey.get(n.chapter) ?? n.chapter;
  const step: StepLike & { derivedFrom: string } = {
    id: f.id,
    ordinal: 0,
    chapter,
    kind: n.kind,
    decision: {
      question: n.question,
      options: n.options.map((o) => ({ id: o.id, label: AUTHORS_ROW_LABEL.test(o.label) ? NEW_STEPS_OWN_LABEL : o.label, consequence: o.consequence, taken: o.id === n.recommended })),
      authorChoice: n.recommended,
      chosen: null,
      why: n.why,
      whySource: 'interpret',
    },
    target: { file: n.kind === 'shape' ? chapter : n.path },
    scaffold: n.kind === 'shape' ? { loadBearing: [], boilerplate: [] } : scaffoldOf(n.path, derived, extracts),
    dependsOn: f.dependsOn,
    witness: { sha: null, date: null, subject: null },
    derivedFrom: decisionId,
  };
  return step;
}

interface MergeContext {
  steps: readonly StepLike[];
  replaced: ReadonlySet<string>;
  /** whether a step writes its own file (or is a chapter step): a step whose file was taken over holds no key (R3) */
  writes: (s: StepLike) => boolean;
  aliases: ReadonlyMap<string, string>;
  keyOf: (s: StepLike) => string;
  owedKeys: readonly string[];
  ownFile: string | null;
  /** the step the road changed at, which owns `ownFile` once this lands */
  decisionId: string;
  /** the paths of the file steps being re-planned: each keeps its own language */
  replacedPaths: ReadonlySet<string>;
  /** what a file the plan never had may end in: the decision's language (T-22's code review, SF8) */
  newFileExtensions: readonly string[];
  /** ids a new step may not take (`reservedIds`), and what makes a fresh one for it: the number of earlier records */
  reserved: ReadonlySet<string>;
  salt: number;
}

/**
 * The ids a step this press writes may not take (the re-check's C4; the stopped re-review's NF4, its second fix): one
 * this press replaces, and one a record names. A step's id is a hash of its words, so a model that keeps a replaced
 * step's words would bring its id back, and with it the learner's tick and conversation about code that is gone, and
 * the plan's own record of a press nobody made at the new step.
 */
function reservedIds(plan: PlanLike, replaced: ReadonlySet<string>): Set<string> {
  const out = new Set(replaced);
  const all: unknown = plan['divergences'];
  for (const record of Array.isArray(all) ? all : []) {
    if (typeof record !== 'object' || record === null) continue;
    const r = record as { stepId?: unknown; staleDependents?: unknown; keptOnOldRoad?: unknown };
    for (const id of [r.stepId, ...(Array.isArray(r.staleDependents) ? r.staleDependents : []), ...(Array.isArray(r.keptOnOldRoad) ? r.keptOnOldRoad : [])]) {
      if (typeof id === 'string') out.add(id);
    }
  }
  return out;
}

/** A step's id, made fresh when its words would bring back one it may not take (`reservedIds`). */
function freshIdFor(node: Parameters<typeof stepIdFor>[0], reserved: ReadonlySet<string>, salt: number): string {
  const id = stepIdFor(node);
  return reserved.has(id) ? createHash('sha256').update(`${id}:${salt}`).digest('hex').slice(0, 16) : id;
}

/**
 * Turn a parsed replan into the new steps, or say why it cannot be. Pure, and run inside the door
 * (`askOnce`'s `parse`), so a reply this refuses is never cached.
 */
function mergeReply(reply: ReplanReply, ctx: MergeContext): Merged | DeriveRefusal {
  const { steps, replaced, writes, aliases, keyOf, owedKeys, ownFile, decisionId, replacedPaths, newFileExtensions, reserved, salt } = ctx;
  const known = new Set([...aliases.values(), ...aliases.keys()]);
  const newKeys = new Set<string>();
  for (const c of reply.chapters) {
    if (known.has(c.key)) return refuse(`the replan lists a new chapter "${c.key}" that the plan already has`);
    newKeys.add(c.key);
  }
  // A key is what a step stands for: a chapter, or a file the step writes. A step whose file a re-plan took over writes
  // nothing, so the file is not "a step this plan keeps" when it is being rewritten (the re-review of the fixes, R3).
  const kept = steps.filter((s) => !replaced.has(s.id) && s.kind !== 'symbol' && writes(s));
  const keptKeys = new Map(kept.map((s) => [keyOf(s).toLowerCase(), s.id] as const));
  // What a new step names is a file or a chapter, and what stands for it is that file's own step: a
  // symbol step shares its file's key, and Mode B's edges run file to file (T-22's live run found a
  // new lookup.js standing on one of lookup-data.js's variables). The re-derived file is D's now.
  const allKeys = new Map(kept.map((s) => [keyOf(s), s.id] as const));
  if (ownFile !== null) {
    keptKeys.set(ownFile.toLowerCase(), 'decision');
    allKeys.set(ownFile, decisionId);
  }

  const fresh: FreshNode[] = [];
  const freshKeys = new Map<string, string>();
  const seenShapes = new Set<string>();
  for (const n of reply.nodes) {
    if (keptKeys.has(n.path.toLowerCase())) return refuse(`the replan returned a step at ${JSON.stringify(n.path)}, which is a step this plan keeps`);
    if (freshKeys.has(n.path)) return refuse(`the replan returned two steps at ${JSON.stringify(n.path)}`);
    if (n.kind !== 'shape' && !replacedPaths.has(n.path) && !newFileExtensions.some((e) => n.path.endsWith(e))) {
      return refuse(`the replan adds a new file ${JSON.stringify(n.path)}, and a new file takes the decision's language (${newFileExtensions.join(' or ')})`);
    }
    if (!known.has(n.chapter) && !newKeys.has(n.chapter)) return refuse(`the replan put a step in a chapter ${JSON.stringify(n.chapter)} the plan does not have`);
    if (newKeys.has(n.chapter)) {
      if (n.kind === 'shape') seenShapes.add(n.chapter);
      else if (!seenShapes.has(n.chapter)) return refuse(`the replan opened chapter ${JSON.stringify(n.chapter)} with no shape step before its files`);
    }
    freshKeys.set(n.path, freshIdFor(n, reserved, salt));
  }
  // Every new step's key is known before any edge is resolved: in a real repository two files can
  // import each other (T-22's code review, MF2), so a new step may stand on one the reply lists later.
  for (const n of reply.nodes) {
    const own = freshKeys.get(n.path)!;
    const ids: string[] = [];
    for (const key of new Set([...owedKeys, ...n.dependsOn])) {
      const id = allKeys.get(key) ?? freshKeys.get(key);
      // A file's edge to its own chapter is only owed when the chapter still has a shape step.
      if (id === undefined && key === n.chapter) continue;
      if (id === undefined) return refuse(`the replanned step ${JSON.stringify(n.path)} depends on ${JSON.stringify(key)}, which no step provides, so the replanned steps do not make a plan`);
      if (id !== own) ids.push(id);
    }
    fresh.push({ id: own, node: n, dependsOn: [...new Set(ids)] });
  }
  return { fresh, chapters: reply.chapters };
}
