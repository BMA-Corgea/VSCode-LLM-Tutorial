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

import path from 'node:path';
import type { DialCore } from '../dial/core.js';
import { languageOf } from '../dial/core.js';
import { readReference } from '../dial/writer.js';
import type { ChapterLike, PlanLike, StepLike } from '../walk/model.js';
import { askOnce, newTally, type DeriveAskDeps } from './ask.js';
import { boilerplateRanges, lineCountOf, loadBearingRanges, stepIdFor, type DeriveCost, type ExtractLike } from './assemble.js';
import { costOf, extractAll, REPO_IMPORTS, refusalForFile, thrownSentence, type ImportRules } from './engine.js';
import { ancestorsOf, downstreamOf, externalDependencies, insertInOrder, keptBy, type GraphNode } from './graph.js';
import {
  codePrompt, parseCodeReply, parseReplanReply, replanPrompt,
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

/** One divergence, on the record, in the plan it produced. */
export interface Divergence {
  stepId: string;
  answer: string;
  /** walked steps that stood on the old road, by id, in plan order */
  staleDependents: string[];
  at: string;
}

export type DivergeOutcome =
  /** Nothing follows from this decision and it owns no file: there is nothing to re-derive. */
  | { ok: true; changed: false; staleDependents: string[]; cost: DeriveCost }
  | { ok: true; changed: true; plan: PlanLike; derivedRoot: string; staleDependents: string[]; cost: DeriveCost }
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

/** The step that owns a decision's file: itself, unless it is a symbol inside one. */
function fileStepOf(d: StepLike, steps: readonly StepLike[]): StepLike {
  if (d.kind !== 'symbol') return d;
  return steps.find((s) => s.kind === 'file' && s.target.file === d.target.file) ?? d;
}

/** The plan as a graph over step ids, with the edge from each file to its chapter's shape step. */
function graphOf(steps: readonly StepLike[]): GraphNode[] {
  const shapeOf = new Map(steps.filter((s) => s.kind === 'shape').map((s) => [s.chapter, s.id] as const));
  return steps.map((s) => {
    const shape = s.kind === 'file' ? shapeOf.get(s.chapter) : undefined;
    return { path: s.id, dependsOn: shape === undefined || s.dependsOn.includes(shape) ? [...s.dependsOn] : [shape, ...s.dependsOn] };
  });
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

    const owner = fileStepOf(d, steps);
    const graph = graphOf(steps);
    const { replaced: reached } = keptBy(graph, owner.id, walked);
    const replaced = new Set([...reached].filter((id) => id !== d.id && id !== owner.id));
    const downstream = downstreamOf(graph, owner.id);
    const staleDependents = steps
      .filter((s) => s.id !== d.id && walked.has(s.id) && (downstream.has(s.id) || s.id === owner.id))
      .map((s) => s.id);
    const ownFile = d.kind === 'shape' ? null : owner.target.file;
    if (ownFile === null && replaced.size === 0) return { ok: true, changed: false, staleDependents, cost: costOf(tally, deps) };

    const reachedUnits = steps.filter((s) => replaced.has(s.id) && s.kind !== 'symbol');
    if (reachedUnits.length > DERIVE_LIMITS.maxSteps) {
      return fail(`this decision reaches ${reachedUnits.length} later steps, more than the ${DERIVE_LIMITS.maxSteps} one press can re-plan, so nothing was changed`);
    }

    const languageFile = ownFile ?? steps.find((s) => s.kind === 'file' && s.chapter === d.chapter)?.target.file ?? steps.find((s) => s.kind === 'file')?.target.file;
    const language = languageFile === undefined ? null : asCodeLanguage(languageOf(languageFile));
    if (language === null) return fail('this repository is written in a language the engine cannot re-derive, so nothing was changed');

    // ── the model names a chapter by a short alias; the alias stands for a real directory ──
    const aliases = new Map<string, string>(plan.chapters.map((c, i) => [c.key, `c${i + 1}`]));
    const realKey = new Map<string, string>([...aliases].map(([key, alias]) => [alias, key]));
    const chapterDir = (alias: string): string | null => {
      const key = realKey.get(alias) ?? alias;
      return key.startsWith('@') ? null : key;
    };
    const pathRules: PathRules = { chapterDir, extensions: extensionsFor(language), maxSegments: REPO_MAX_PATH_SEGMENTS };
    const keyOf = (s: StepLike): string => (s.kind === 'shape' ? aliases.get(s.chapter) ?? s.chapter : s.target.file);
    const onRoad = (s: StepLike): string => s.decision.chosen ?? s.decision.authorChoice;
    const shown = (s: StepLike, chosen: string): ShownStep => ({
      kind: s.kind === 'shape' ? 'shape' : 'file',
      chapter: aliases.get(s.chapter) ?? s.chapter,
      path: keyOf(s),
      question: s.decision.question,
      options: s.decision.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence })),
      chosen,
      why: s.decision.why,
      dependsOn: s.dependsOn.flatMap((id) => { const dep = byId.get(id); return dep === undefined ? [] : [keyOf(dep)]; }),
    });
    const decisionOf = (s: StepLike, chosen: string): DecisionForPrompt => {
      const option = s.decision.options.find((o) => o.id === chosen) ?? s.decision.options[0];
      return { path: keyOf(s), question: s.decision.question, chosen: { label: option?.label ?? '', consequence: option?.consequence ?? '' }, why: s.decision.why };
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
        shown: steps.filter((s) => showIds.has(s.id) && s.kind !== 'symbol').map((s) => shown(s, onRoad(s))),
        replacing: asked.map((s) => shown(s, onRoad(s))),
      });
      const owedKeys = [keyOf(owner), ...externals.flatMap((id) => { const e = byId.get(id); return e === undefined ? [] : [keyOf(e)]; })];
      const reply = await askOnce(deps, `derive:diverge:${d.id}`, prompt, (t) => {
        const parsed = parseReplanReply(t, language, pathRules);
        return isDeriveRefusal(parsed) ? parsed : mergeReply(parsed, { steps, replaced, aliases, keyOf, owedKeys, ownFile });
      }, tally);
      if (isDeriveRefusal(reply)) return fail(reply.refused);
      merged = reply;
    }

    // ── the code: the decision's own file, then every new file ──
    const freshById = new Map(merged.fresh.map((f) => [f.node.path, f] as const));
    const written = new Map<string, string>();
    const plannedFiles = new Set([
      ...steps.filter((s) => s.kind === 'file' && !replaced.has(s.id)).map((s) => s.target.file),
      ...merged.fresh.filter((f) => f.node.kind === 'file').map((f) => f.node.path),
    ]);
    const shapeDecision = (chapter: string): DecisionForPrompt => {
      const shape = steps.find((s) => s.kind === 'shape' && s.chapter === chapter);
      if (shape !== undefined) return decisionOf(shape, onRoad(shape));
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
        if (isDeriveRefusal(reply)) return reply;
        return (await judged(file, reply.content, allowed)) ?? reply;
      }, tally);
      if (isDeriveRefusal(code)) return code;
      written.set(file, code.content);
      return null;
    };

    if (ownFile !== null) {
      deps.onProgress?.(`writing ${ownFile}…`);
      const fileDeps = owner.dependsOn.flatMap((id) => { const dep = byId.get(id); return dep?.kind === 'file' ? [dep] : []; });
      const dependencies: DependencyForPrompt[] = fileDeps.map((dep) => ({ ...decisionOf(dep, onRoad(dep)), content: contentOf(dep.target.file) }));
      const refused = await writeFile(ownFile, `derive:code:${d.id}`, shapeDecision(d.chapter), { ...decisionOf(d, answer), path: ownFile }, dependencies, new Set(fileDeps.map((dep) => dep.target.file)));
      if (refused !== null) return fail(refused.refused);
    }
    for (const f of merged.fresh.filter((x) => x.node.kind === 'file')) {
      deps.onProgress?.(`writing ${f.node.path}…`);
      const dependencies: DependencyForPrompt[] = [];
      const allowed = new Set<string>();
      for (const id of f.dependsOn) {
        const dep = byId.get(id);
        const earlier = freshById.get(id);
        if (dep?.kind === 'file' || dep?.kind === 'symbol') {
          allowed.add(dep.target.file);
          dependencies.push({ ...decisionOf(dep, onRoad(dep)), content: written.get(dep.target.file) ?? contentOf(dep.target.file) });
        } else if (earlier !== undefined && earlier.node.kind === 'file') {
          allowed.add(earlier.node.path);
          dependencies.push({ path: earlier.node.path, question: earlier.node.question, chosen: { label: earlier.node.options[0]?.label ?? '', consequence: '' }, why: earlier.node.why, content: written.get(earlier.node.path) ?? '' });
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
    const answered: StepLike = {
      ...d,
      decision: { ...d.decision, chosen: answer },
      ...(ownFile === null ? {} : { kind: 'file' as const, target: { file: ownFile }, scaffold: scaffoldOf(ownFile, derivedFiles, extracts) }),
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
    const prior = (plan as { divergences?: Divergence[] }).divergences ?? [];
    const next: PlanLike & { divergences: Divergence[] } = {
      ...plan, chapters, steps: nextSteps, generatedAt: at, cost: costOf(tally, deps),
      divergences: [...prior, { stepId: d.id, answer, staleDependents, at }],
    };
    return { ok: true, changed: true, plan: next, derivedRoot: tree.root, staleDependents, cost: costOf(tally, deps) };
  } catch (err) {
    return fail(`the re-plan stopped unexpectedly: ${thrownSentence(err)}`);
  }
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
      options: n.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence, taken: o.id === n.recommended })),
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
  aliases: ReadonlyMap<string, string>;
  keyOf: (s: StepLike) => string;
  owedKeys: readonly string[];
  ownFile: string | null;
}

/**
 * Turn a parsed replan into the new steps, or say why it cannot be. Pure, and run inside the door
 * (`askOnce`'s `parse`), so a reply this refuses is never cached.
 */
function mergeReply(reply: ReplanReply, ctx: MergeContext): Merged | DeriveRefusal {
  const { steps, replaced, aliases, keyOf, owedKeys, ownFile } = ctx;
  const known = new Set([...aliases.values(), ...aliases.keys()]);
  const newKeys = new Set<string>();
  for (const c of reply.chapters) {
    if (known.has(c.key)) return refuse(`the replan lists a new chapter "${c.key}" that the plan already has`);
    newKeys.add(c.key);
  }
  const kept = steps.filter((s) => !replaced.has(s.id));
  const keptKeys = new Map(kept.filter((s) => s.kind !== 'symbol').map((s) => [keyOf(s).toLowerCase(), s.id] as const));
  const allKeys = new Map(kept.map((s) => [keyOf(s), s.id] as const));
  if (ownFile !== null) keptKeys.set(ownFile.toLowerCase(), 'decision');

  const fresh: FreshNode[] = [];
  const freshKeys = new Map<string, string>();
  const seenShapes = new Set<string>();
  for (const n of reply.nodes) {
    if (keptKeys.has(n.path.toLowerCase())) return refuse(`the replan returned a step at ${JSON.stringify(n.path)}, which is a step this plan keeps`);
    if (freshKeys.has(n.path)) return refuse(`the replan returned two steps at ${JSON.stringify(n.path)}`);
    if (!known.has(n.chapter) && !newKeys.has(n.chapter)) return refuse(`the replan put a step in a chapter ${JSON.stringify(n.chapter)} the plan does not have`);
    if (newKeys.has(n.chapter)) {
      if (n.kind === 'shape') seenShapes.add(n.chapter);
      else if (!seenShapes.has(n.chapter)) return refuse(`the replan opened chapter ${JSON.stringify(n.chapter)} with no shape step before its files`);
    }
    const ids: string[] = [];
    for (const key of new Set([...owedKeys, ...n.dependsOn])) {
      const id = allKeys.get(key) ?? freshKeys.get(key);
      // A file's edge to its own chapter is only owed when the chapter still has a shape step.
      if (id === undefined && key === n.chapter) continue;
      if (id === undefined) return refuse(`the replanned step ${JSON.stringify(n.path)} depends on ${JSON.stringify(key)}, which no step provides, so the replanned steps do not make a plan`);
      ids.push(id);
    }
    const id = stepIdFor(n);
    fresh.push({ id, node: n, dependsOn: [...new Set(ids)] });
    freshKeys.set(n.path, id);
  }
  return { fresh, chapters: reply.chapters };
}
