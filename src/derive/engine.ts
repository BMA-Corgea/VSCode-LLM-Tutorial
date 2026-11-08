// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine (T-17): an idea becomes a plan the walk already renders, and an answer
 * that differs from the recommendation re-derives the steps that follow from it.
 *
 * The technique, the two entry points and the honesty rule are the spec's
 * (`.autodev/specs/T-17-derivation-engine.md` in the ledger) and the plan's design decisions.
 * This file is the orchestration only. Every question goes through `askOnce` (`./ask.ts`), the one
 * door. The graph arithmetic is `./graph.ts`'s, the plan is `assemblePlan`'s, and the files are
 * written by `writeReferenceTree`.
 *
 * ── Two entry points, and one of them is made of the other ─────────────────────────────────
 *
 *   - `replanPlan(state, step, answer, prefix)` is the walk's door (T-18 for an answer in Mode A,
 *     T-22 for a divergence). It keeps the walked prefix and everything the decision does not
 *     reach VERBATIM, decisions and code alike. It re-plans the rest of the decision's downstream,
 *     rewrites the code for the decision and the new steps, and writes a NEW tree. The state it was
 *     handed is never modified, which is the substrate plan versions stand on (T-22, T-14).
 *   - `derivePlan(idea, answers)` outlines the idea, writes every file for the recommendations,
 *     then folds the SAME internal step over the answers in plan order, with the steps before
 *     each one as its prefix — exactly what a learner answering in order does. So one call to
 *     `derivePlan` equals a walk of `replanPlan` calls by construction, and the suite pins it.
 *
 * ── The honesty rule ──────────────────────────────────────────────────────────────────────────
 *
 * A replan is shown the decision's own ancestors and the outside steps the old downstream stood
 * on (`externalDependencies`). So every step it produces is given `dependsOn` on the decision AND
 * on each of those outside steps. The edges are added here and never trusted to the model. That
 * keeps a step's recorded dependencies a superset of what shaped it, which is what lets AC-A1's
 * second clause hold: a step that was never shown a decision cannot change when it changes.
 *
 * No `vscode` import — see `./types.ts`.
 */

import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DialCore, FileRecord } from '../dial/core.js';
import { languageOf } from '../dial/core.js';
import { writeTextAtomic } from '../dial/writer.js';
import { askOnce, newTally, type AskTally, type DeriveAskDeps } from './ask.js';
import { assemblePlan, lineCountOf, stepIdFor, type DeriveCost, type DerivedPlan, type ExtractLike } from './assemble.js';
import { ancestorsOf, externalDependencies, insertInOrder, keptBy } from './graph.js';
import {
  codePrompt, outlinePrompt, parseChapter, parseCodeReply, parseNode, parseOutlineReply, parseReplanReply, quote, replanPrompt, unsoundCodeText, validatePlan, withChapterEdges,
  type DecisionForPrompt, type DependencyForPrompt, type ReplanReply, type ShownStep,
} from './prompt.js';
import { writeReferenceTree, type DerivedFile } from './tree.js';
import { DERIVE_LIMITS, isDeriveRefusal, type DeriveLanguage, type DeriveRefusal, type DerivedChapter, type DerivedNode } from './types.js';

export interface DeriveDeps extends DeriveAskDeps {
  /** repo-tour's `extract`, the same slice the dial's check uses */
  dialCore: Pick<DialCore, 'extract'>;
  /** the learner's folder — only its PATH is used, to key the tree; nothing is written there */
  target: string;
  /** for the progress notification T-20 shows; never required */
  onProgress?: (message: string) => void;
  /** a fixed clock for tests; the plan's `generatedAt` */
  now?: () => Date;
}

export interface DeriveRequest {
  idea: string;
  /** the learner's answers, by step id — applied in plan order, as a learner gives them */
  answers?: Readonly<Record<string, string>>;
}

/**
 * Everything a later replan needs: what the plan was derived from and what it holds. Plain data
 * (a `Record`, not a `Map`) so T-22 can keep each version of it on disk as it stands.
 */
export interface DerivationState {
  idea: string;
  title: string;
  language: DeriveLanguage;
  entry: string;
  chapters: DerivedChapter[];
  /** in plan order */
  nodes: DerivedNode[];
  /** each file node's code, by path */
  files: Record<string, string>;
  /** the learner's answers, by step id */
  answers: Record<string, string>;
}

export type DeriveOutcome =
  | { ok: true; plan: DerivedPlan; referenceRoot: string; files: DerivedFile[]; state: DerivationState }
  | { ok: false; reason: string; cost: DeriveCost };

/** What the plan's `cost.model` says when no model ran: the cache holds answers, not who gave them. */
const ALL_FROM_CACHE = 'none: every answer came from the cache';

function costOf(tally: AskTally, deps: DeriveDeps): DeriveCost {
  return {
    provider: deps.settings.provider,
    model: tally.calls === 0 && tally.cachedStops > 0 ? ALL_FROM_CACHE : deps.settings.model,
    metered: tally.unmetered === 0,
    calls: tally.calls,
    cachedStops: tally.cachedStops,
    interpretedStops: tally.interpretedStops,
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    usd: tally.usd,
    failures: [...tally.failures],
  };
}

function refuse(sentence: string): DeriveRefusal {
  return { refused: sentence };
}

function effectiveOption(node: DerivedNode, answers: Readonly<Record<string, string>>): DerivedNode['options'][number] {
  const answer = answers[stepIdFor(node)];
  return node.options.find((o) => o.id === answer) ?? node.options.find((o) => o.id === node.recommended)!;
}

function decisionOf(node: DerivedNode, answers: Readonly<Record<string, string>>): DecisionForPrompt {
  const chosen = effectiveOption(node, answers);
  return { path: node.path, question: node.question, chosen: { label: chosen.label, consequence: chosen.consequence }, why: node.why };
}

function shownStepOf(node: DerivedNode, answers: Readonly<Record<string, string>>): ShownStep {
  return {
    kind: node.kind, chapter: node.chapter, path: node.path, question: node.question, options: node.options,
    chosen: effectiveOption(node, answers).id, why: node.why, dependsOn: node.dependsOn,
  };
}

/**
 * Why a derived file may not stand, by repo-tour's own reading of it, or `null`. It must parse
 * cleanly. Every relative import must resolve to a file the node declares it depends on: the code
 * prompt showed it only those files, so an import of anything else is a guess at an API it never
 * saw. A JavaScript bare import must be one of Node's own modules (there is nothing to install).
 *
 * **This is a correctness check, never a sandbox.** It keeps the plan's graph true and the app
 * able to start. It does not make the code safe: a Node built-in can run a process or open a
 * socket, and the file runs as the learner the moment they run it. What the learner is told about
 * that belongs to the tickets that show it to them (T-61).
 */
export function unsoundFileReason(
  extract: ExtractLike, allowedFiles: ReadonlySet<string>, language: DeriveLanguage, plannedFiles: ReadonlySet<string> = allowedFiles,
): string | null {
  if (extract.parseErrors > 0) return `does not parse (${extract.parseErrors} syntax error${extract.parseErrors === 1 ? '' : 's'})`;
  const importerDir = path.posix.dirname(extract.path);
  for (const imp of extract.imports) {
    if (imp.resolved !== null) {
      if (!allowedFiles.has(imp.resolved)) return `imports ${quote(imp.raw)}, a file it does not depend on`;
      // repo-tour's resolver tries extensions and index files the way a bundler does. Node's ES
      // module loader does not, and this is the file the learner runs under Node.
      if (language === 'javascript' && path.posix.normalize(path.posix.join(importerDir, imp.raw)) !== imp.resolved) {
        return `imports ${quote(imp.raw)}, which Node cannot load: an ES module names a file in full, as ${quote(path.posix.relative(importerDir, imp.resolved))}`;
      }
      continue;
    }
    if (imp.raw.startsWith('.')) return `imports ${quote(imp.raw)}, which is not one of its dependencies' files`;
    if (language === 'javascript' && !isBuiltin(imp.raw)) return `imports the package ${quote(imp.raw)}, which would need installing`;
    if (language === 'python') {
      // A Python name with no dots in front reads like a package. It may be a file of this app.
      const fromRoot = `${imp.raw.replace(/\./g, '/')}.py`;
      if (plannedFiles.has(fromRoot)) return `imports ${quote(imp.raw)}, a file it does not depend on`;
      const sibling = path.posix.join(importerDir, fromRoot);
      if (plannedFiles.has(sibling)) {
        return `imports ${quote(imp.raw)}, a name that only works when this file is run directly; this app is run from its top folder, so it must import ${quote(sibling.slice(0, -3).replace(/\//g, '.'))}`;
      }
    }
  }
  return null;
}

/** The file's text without its comments, so a sentence ABOUT an import is not read as one. */
function codeWithoutComments(content: string, language: DeriveLanguage): string {
  if (language === 'python') return content.replace(/#.*$/gm, '');
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A dynamic import of anything but one plain string, in JavaScript. A plain string is `extract`'s to read. */
const COMPUTED_JS_IMPORT = /\bimport\s*\(\s*(?!(?:'[^'\n]*'|"[^"\n]*"|`[^`$\n]*`)\s*[,)])/;

/**
 * Why a file reaches for code nothing here can see, or `null`. `extract` reads plain string
 * imports only, so a computed one is a dependency the plan's graph cannot know about, and a replan
 * would then keep a file it should have re-derived. A sentence about an import in a comment is
 * fine. Lexical on purpose, and part of the correctness check above: not a sandbox.
 */
function computedImportReason(content: string, language: DeriveLanguage): string | null {
  const code = codeWithoutComments(content, language);
  const computed = language === 'python'
    ? /\b__import__\s*\(|\bimportlib\b/.test(code)
    : COMPUTED_JS_IMPORT.test(code) || /\bcreateRequire\b/.test(code);
  return computed ? 'uses a computed import, which nothing here can follow: a file of this app imports only what it names' : null;
}

/** Run repo-tour's `extract` over the derived files, from a scratch folder this call made. */
async function extractAll(core: Pick<DialCore, 'extract'>, files: readonly DerivedFile[]): Promise<Map<string, ExtractLike> | string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-extract-'));
  try {
    const records: FileRecord[] = [];
    for (const f of files) {
      // Contained, lexically and on disk: `writeTextAtomic` proves the destination is really
      // inside the scratch folder before a byte moves. The paths were checked when they were
      // parsed, but this write runs BEFORE the tree writer's own check, so it must not be the
      // place a bad path gets through first.
      const abs = path.join(scratch, ...f.path.split('/'));
      writeTextAtomic(abs, f.content, scratch);
      const language = languageOf(f.path);
      if (language === undefined) return `${f.path} has no grammar`;
      records.push({
        path: f.path, repo: '', bytes: Buffer.byteLength(f.content, 'utf8'), loc: lineCountOf(f.content), language,
        sha256: '', classification: 'source', signals: ['build-tutorials-derive'], binary: false,
      });
    }
    const { extracts } = await core.extract(scratch, records);
    const out = new Map<string, ExtractLike>();
    for (const e of extracts as ExtractLike[]) out.set(e.path, e);
    return out;
  } catch (err) {
    return `repo-tour could not read the derived files: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Why `node`'s file may not stand, from repo-tour's reading of it and its own text, or `null`. */
function refusalForFile(
  node: DerivedNode, content: string, extract: ExtractLike | undefined, allowedFiles: ReadonlySet<string>, plannedFiles: ReadonlySet<string>, language: DeriveLanguage,
): DeriveRefusal | null {
  if (extract === undefined) return refuse(`repo-tour returned no reading of ${node.path}`);
  const unsound = unsoundFileReason(extract, allowedFiles, language, plannedFiles) ?? computedImportReason(content, language);
  return unsound === null ? null : refuse(`the derived file ${node.path} ${unsound}`);
}

/**
 * The deeper half of judging a code reply: repo-tour's own parser over the real file, with the
 * files it depends on beside it so its imports resolve. It runs inside the door (`askOnce`'s
 * `parse`), so a reply that parses as JSON and fails here is never cached: the next press asks
 * again instead of being handed the same refusal for free, forever.
 */
async function refusalForCode(state: DerivationState, node: DerivedNode, content: string, deps: DeriveDeps): Promise<DeriveRefusal | null> {
  const kindOf = new Map(state.nodes.map((n) => [n.path, n.kind] as const));
  const dependencies: DerivedFile[] = [];
  for (const p of new Set(node.dependsOn)) {
    const code = kindOf.get(p) === 'file' ? state.files[p] : undefined;
    if (code !== undefined) dependencies.push({ path: p, content: code });
  }
  const extracts = await extractAll(deps.dialCore, [...dependencies, { path: node.path, content }]);
  if (typeof extracts === 'string') return refuse(extracts);
  const planned = new Set(state.nodes.filter((n) => n.kind === 'file').map((n) => n.path));
  return refusalForFile(node, content, extracts.get(node.path), new Set(dependencies.map((d) => d.path)), planned, state.language);
}

/**
 * Write the code of the file nodes in `paths`, in plan order, into `state.files` (the caller's
 * working copy). Each code prompt holds exactly the node's chapter decision and the decisions and
 * files it declares it depends on.
 */
async function writeCode(state: DerivationState, paths: ReadonlySet<string>, deps: DeriveDeps, tally: AskTally): Promise<DeriveRefusal | null> {
  const byPath = new Map(state.nodes.map((n) => [n.path, n] as const));
  const todo = state.nodes.filter((n) => n.kind === 'file' && paths.has(n.path));
  for (const [i, node] of todo.entries()) {
    deps.onProgress?.(`writing ${node.path} (${i + 1} of ${todo.length})…`);
    const chapter = byPath.get(node.chapter);
    if (chapter === undefined) return refuse(`${node.path} belongs to a chapter the plan does not have`);
    const dependencies: DependencyForPrompt[] = [];
    for (const p of node.dependsOn) {
      if (p === node.chapter) continue;
      const d = byPath.get(p);
      if (d === undefined) return refuse(`${node.path} depends on ${p}, which is not in the plan`);
      const content = d.kind === 'file' ? state.files[d.path] : undefined;
      if (d.kind === 'file' && content === undefined) return refuse(`${node.path} depends on ${p}, whose code is not written yet`);
      dependencies.push({ ...decisionOf(d, state.answers), ...(content === undefined ? {} : { content }) });
    }
    const prompt = codePrompt({
      idea: state.idea, title: state.title, language: state.language,
      chapter: decisionOf(chapter, state.answers),
      node: { ...decisionOf(node, state.answers), isEntry: node.path === state.entry },
      dependencies,
    });
    const code = await askOnce(deps, `derive:code:${stepIdFor(node)}`, prompt, async (t) => {
      const reply = parseCodeReply(t, node.path);
      if (isDeriveRefusal(reply)) return reply;
      return (await refusalForCode(state, node, reply.content, deps)) ?? reply;
    }, tally);
    if (isDeriveRefusal(code)) return code;
    state.files[node.path] = code.content;
  }
  return null;
}

/** Read every file with repo-tour's own parser, refuse an unsound one, then write the tree. */
async function checkAndWrite(state: DerivationState, deps: DeriveDeps): Promise<{ extracts: Map<string, ExtractLike>; root: string } | DeriveRefusal> {
  const fileNodes = state.nodes.filter((n) => n.kind === 'file');
  const files: DerivedFile[] = [];
  for (const n of fileNodes) {
    const content = state.files[n.path];
    if (content === undefined) return refuse(`${n.path} has no code`);
    files.push({ path: n.path, content });
  }
  const extracts = await extractAll(deps.dialCore, files);
  if (typeof extracts === 'string') return refuse(extracts);
  const kindOf = new Map(state.nodes.map((n) => [n.path, n.kind] as const));
  const planned = new Set(fileNodes.map((n) => n.path));
  for (const node of fileNodes) {
    const allowed = new Set(node.dependsOn.filter((p) => kindOf.get(p) === 'file'));
    const refused = refusalForFile(node, state.files[node.path]!, extracts.get(node.path), allowed, planned, state.language);
    if (refused !== null) return refused;
  }
  const tree = writeReferenceTree(deps.globalStorageRoot, deps.target, state.title, files);
  if (isDeriveRefusal(tree)) return tree;
  return { extracts, root: tree.root };
}

function finish(state: DerivationState, checked: { extracts: Map<string, ExtractLike>; root: string }, tally: AskTally, deps: DeriveDeps): DeriveOutcome {
  const plan = assemblePlan({
    idea: state.idea, title: state.title, language: state.language, chapters: state.chapters,
    nodes: state.nodes, answers: state.answers, files: new Map(Object.entries(state.files)),
    extracts: checked.extracts, cost: costOf(tally, deps),
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  const files = state.nodes.filter((n) => n.kind === 'file').map((n) => ({ path: n.path, content: state.files[n.path]! }));
  return { ok: true, plan, referenceRoot: checked.root, files, state };
}

interface MergedReplan {
  nodes: DerivedNode[];
  chapters: DerivedChapter[];
  entry: string;
  /** the steps this replan created, with the edges the honesty rule owes them */
  fresh: DerivedNode[];
}

/**
 * Merge a parsed replan into the plan, or say why it cannot be. Pure, and run inside the door
 * (`askOnce`'s `parse`), so a replan that parses and cannot be merged is never cached.
 */
function mergeReplan(
  prev: DerivationState, reply: ReplanReply, decisionPath: string, externals: readonly string[], kept: ReadonlySet<string>, replaced: ReadonlySet<string>,
): MergedReplan | DeriveRefusal {
  const known = new Set(prev.chapters.map((c) => c.key));
  for (const c of reply.chapters) {
    if (known.has(c.key)) return refuse(`the replan lists a new chapter "${c.key}" that the plan already has`);
  }
  // The honesty rule — see the header. Owed edges first, then the model's own, without repeats.
  const owed = [decisionPath, ...externals];
  const fresh = reply.nodes.map((n) => ({ ...n, dependsOn: [...new Set([...owed, ...n.dependsOn])] }));
  const keptFolded = new Set(prev.nodes.filter((n) => kept.has(n.path)).map((n) => n.path.toLowerCase()));
  for (const n of fresh) {
    if (keptFolded.has(n.path.toLowerCase())) return refuse(`the replan returned a step at ${JSON.stringify(n.path)}, which is a step it was told to keep`);
  }
  const nodes = insertInOrder(prev.nodes.filter((n) => kept.has(n.path)), fresh);
  // The entry moves only if the step that held it was replaced: a replan that re-creates it at the
  // same path keeps it; one that drops the path must name the new one.
  let entry = prev.entry;
  if (replaced.has(prev.entry)) {
    const recreated = nodes.some((n) => n.path === prev.entry && n.kind === 'file');
    const named = reply.entry;
    if (named !== null) entry = named;
    else if (!recreated) return refuse('the replan replaced the file that starts the app without naming a new one');
  }
  const used = new Set(nodes.map((n) => n.chapter));
  const chapters = [...prev.chapters, ...reply.chapters].filter((c) => used.has(c.key));
  const problem = validatePlan(chapters, nodes, entry);
  if (problem !== null) return refuse(`the replanned steps do not make a plan: ${problem.refused}`);
  return { nodes, chapters, entry, fresh };
}

/**
 * The step both entry points share: record `answer` at `decisionPath`; if it changes what that
 * decision shapes, re-plan its downstream (minus the kept set) and, when `writeCodeNow`, rewrite
 * the code it reaches. Works on a COPY of `prev`, which is never modified.
 *
 * `derivePlan` passes `writeCodeNow: false` and writes every file once at the end, as the spec
 * orders it: nothing about a replan needs code, so writing it per answer only pays for files a
 * later answer throws away. A walk has no "end" to wait for, so `replanPlan` writes as it goes.
 */
async function replanCore(
  prev: DerivationState, decisionPath: string, answer: string, prefix: ReadonlySet<string>, deps: DeriveDeps, tally: AskTally, writeCodeNow: boolean,
): Promise<DerivationState | DeriveRefusal> {
  const node = prev.nodes.find((n) => n.path === decisionPath);
  if (node === undefined) return refuse(`there is no step at ${JSON.stringify(decisionPath)} in this plan`);
  if (!node.options.some((o) => o.id === answer)) return refuse(`${JSON.stringify(answer)} is not one of the options at ${JSON.stringify(decisionPath)}`);
  const id = stepIdFor(node);
  const before = effectiveOption(node, prev.answers).id;
  const state: DerivationState = {
    ...prev, chapters: [...prev.chapters], nodes: [...prev.nodes], files: { ...prev.files }, answers: { ...prev.answers, [id]: answer },
  };
  if (answer === before) return state; // recorded; nothing it shapes can change

  const { kept, replaced } = keptBy(prev.nodes, decisionPath, prefix);
  const rewrite = new Set<string>(node.kind === 'file' ? [node.path] : []);
  if (replaced.size > 0) {
    deps.onProgress?.(`re-planning the steps after ${decisionPath}…`);
    const externals = externalDependencies(prev.nodes, decisionPath, replaced);
    const inside = ancestorsOf(prev.nodes, [decisionPath]);
    inside.delete(decisionPath);
    const shownPaths = new Set([...inside, ...externals]);
    const prompt = replanPrompt({
      idea: prev.idea, title: prev.title, language: prev.language, entry: prev.entry, chapters: prev.chapters,
      decision: { ...shownStepOf(node, state.answers), recommended: node.recommended },
      shown: prev.nodes.filter((n) => shownPaths.has(n.path)).map((n) => shownStepOf(n, state.answers)),
      replacing: prev.nodes.filter((n) => replaced.has(n.path)).map((n) => shownStepOf(n, state.answers)),
    });
    const merged = await askOnce(deps, `derive:replan:${id}`, prompt, (t) => {
      const reply = parseReplanReply(t, prev.language);
      return isDeriveRefusal(reply) ? reply : mergeReplan(prev, reply, decisionPath, externals, kept, replaced);
    }, tally);
    if (isDeriveRefusal(merged)) return merged;
    state.nodes = merged.nodes;
    state.chapters = merged.chapters;
    state.entry = merged.entry;
    for (const p of replaced) delete state.files[p];
    for (const n of merged.fresh) if (n.kind === 'file') rewrite.add(n.path);
  }
  if (!writeCodeNow) return state;
  const wrote = await writeCode(state, rewrite, deps, tally);
  if (wrote !== null) return wrote;
  return state;
}

/** Why a derivation may not start, or `null`. Checked before anything can be spent. */
function startRefusal(deps: DeriveDeps): string | null {
  // An empty model does not mean "the default" further down: `resolveTutorChoice` turns it into
  // the provider's STRONGEST model, so a caller that passed the raw setting would quietly buy
  // the expensive one. The caller resolves it, as `src/extension.ts`'s `resolveLlmSettings` does.
  const model = deps.settings.model as unknown;
  if (typeof model !== 'string' || model.trim().length === 0) return 'the derivation names no model, so nothing was asked';
  return null;
}

function ideaRefusal(idea: unknown): string | null {
  if (typeof idea !== 'string' || idea.trim().length === 0) return 'there is no idea to plan, so nothing was asked';
  if (idea.length > DERIVE_LIMITS.maxIdeaChars) {
    return `the idea is ${idea.length} characters, more than the ${DERIVE_LIMITS.maxIdeaChars} this engine plans from, so nothing was asked`;
  }
  return null;
}

function thrownSentence(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why a state handed in from OUTSIDE may not be replanned, or `null`. T-22 will keep each version
 * of a `DerivationState` on disk, so a state reaching `replanPlan` is model output re-entering from
 * a file. That makes it a second door exactly as the cache is (T-7), so it is judged by the FIRST
 * door's own functions rather than a shorter list of its own: every chapter and step goes back
 * through the parser, and must come out exactly as it went in, because a stored state can only
 * hold what the parser produced. Then the whole-plan rules, then the code.
 *
 * Total on purpose: anything the parser cannot read is a sentence here, never a throw further on.
 */
export function unsoundStateReason(state: DerivationState): string | null {
  const s = state as unknown;
  if (!isPlainRecord(s)) return 'it is not a plan state';
  const language = s['language'];
  if (language !== 'javascript' && language !== 'python') return 'it names a language this engine does not write';
  const idea = ideaRefusal(s['idea']);
  if (idea !== null) return idea;
  const title = s['title'];
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > DERIVE_LIMITS.maxTitleChars) return 'its title is not a title this engine could have written';
  const { chapters, nodes, files, answers, entry } = s;
  if (!Array.isArray(chapters) || !Array.isArray(nodes) || !isPlainRecord(files) || !isPlainRecord(answers) || typeof entry !== 'string') {
    return 'it is missing one of its chapters, steps, files, answers or entry';
  }
  if (chapters.length > DERIVE_LIMITS.maxChapters) return `it has ${chapters.length} chapters, more than ${DERIVE_LIMITS.maxChapters}`;
  if (nodes.length > DERIVE_LIMITS.maxSteps) return `it has ${nodes.length} steps, more than ${DERIVE_LIMITS.maxSteps}`;

  const parsedChapters: DerivedChapter[] = [];
  for (const [i, raw] of chapters.entries()) {
    const parsed = parseChapter(raw, i);
    if (isDeriveRefusal(parsed)) return parsed.refused;
    if (JSON.stringify(parsed) !== JSON.stringify(raw)) return `its chapter ${i + 1} is not what the parser would have kept`;
    parsedChapters.push(parsed);
  }
  const parsedNodes: DerivedNode[] = [];
  for (const [i, raw] of nodes.entries()) {
    const parsed = parseNode(raw, i, language);
    if (isDeriveRefusal(parsed)) return parsed.refused;
    parsedNodes.push(parsed);
  }
  // The chapter edge is one the engine owes every file step, so a stored step must already carry it.
  const edged = withChapterEdges(parsedNodes);
  for (const [i, n] of edged.entries()) {
    if (JSON.stringify(n) !== JSON.stringify(nodes[i])) return `its step ${i + 1} is not what the parser would have kept`;
  }
  const problem = validatePlan(parsedChapters, edged, entry);
  if (problem !== null) return problem.refused;

  const filePaths = new Set(edged.filter((n) => n.kind === 'file').map((n) => n.path));
  for (const [p, content] of Object.entries(files)) {
    if (!filePaths.has(p)) return `it holds code for ${JSON.stringify(p.slice(0, 60))}, which is not one of its file steps`;
    const unsound = unsoundCodeText(content, p);
    if (unsound !== null) return unsound;
  }
  for (const p of filePaths) {
    if (typeof files[p] !== 'string') return `it holds no code for ${JSON.stringify(p.slice(0, 60))}, one of its file steps`;
  }
  for (const value of Object.values(answers)) {
    if (typeof value !== 'string') return 'one of its answers is not text';
  }
  return null;
}

/**
 * The walk's door: the learner answered `stepId` with `answer`; `prefixStepIds` are the steps they
 * have walked, kept verbatim whatever the answer reaches. Returns the NEW plan and its new tree;
 * `prev` is untouched.
 */
export async function replanPlan(
  prev: DerivationState, stepId: string, answer: string, prefixStepIds: readonly string[], deps: DeriveDeps,
): Promise<DeriveOutcome> {
  const tally = newTally();
  const fail = (reason: string): DeriveOutcome => ({ ok: false, reason, cost: costOf(tally, deps) });
  try {
    const refused = startRefusal(deps);
    if (refused !== null) return fail(refused);
    const unsound = unsoundStateReason(prev);
    if (unsound !== null) return fail(`the plan handed in cannot be replanned: ${unsound}`);
    const byId = new Map(prev.nodes.map((n) => [stepIdFor(n), n] as const));
    const node = byId.get(stepId);
    if (node === undefined) return fail(`there is no step ${JSON.stringify(stepId)} in this plan`);
    const prefix = new Set<string>();
    for (const pid of prefixStepIds) {
      const p = byId.get(pid);
      if (p !== undefined) prefix.add(p.path);
    }
    const next = await replanCore(prev, node.path, answer, prefix, deps, tally, true);
    if (isDeriveRefusal(next)) return fail(next.refused);
    const checked = await checkAndWrite(next, deps);
    if (isDeriveRefusal(checked)) return fail(checked.refused);
    return finish(next, checked, tally, deps);
  } catch (err) {
    return fail(`the replan stopped unexpectedly: ${thrownSentence(err)}`);
  }
}

/**
 * Derive a plan, and its reference tree, from an idea and the learner's answers. The answers are
 * applied in plan order with the steps before each as its prefix — `replanPlan`'s own step, so one
 * call here equals a walk of calls there (see the header).
 */
export async function derivePlan(request: DeriveRequest, deps: DeriveDeps): Promise<DeriveOutcome> {
  const tally = newTally();
  const fail = (reason: string): DeriveOutcome => ({ ok: false, reason, cost: costOf(tally, deps) });
  try {
    const refused = startRefusal(deps) ?? ideaRefusal(request.idea);
    if (refused !== null) return fail(refused);

    deps.onProgress?.('laying out the decisions…');
    const outline = await askOnce(deps, 'derive:outline', outlinePrompt(request.idea), parseOutlineReply, tally);
    if (isDeriveRefusal(outline)) return fail(outline.refused);

    let state: DerivationState = {
      idea: request.idea, title: outline.title, language: outline.language, entry: outline.entry,
      chapters: outline.chapters, nodes: outline.nodes, files: {}, answers: {},
    };

    const answers = request.answers ?? {};
    const applied = new Set<string>();
    for (let i = 0; i < state.nodes.length; i += 1) {
      const node = state.nodes[i]!;
      const id = stepIdFor(node);
      const answer = answers[id];
      if (answer === undefined) continue;
      applied.add(id);
      const prefix = new Set(state.nodes.slice(0, i).map((n) => n.path));
      const next = await replanCore(state, node.path, answer, prefix, deps, tally, false);
      if (isDeriveRefusal(next)) return fail(next.refused);
      state = next;
    }
    const stray = Object.keys(answers).filter((id) => !applied.has(id));
    if (stray.length > 0) {
      return fail(`${stray.length === 1 ? 'an answer matches' : `${stray.length} answers match`} no step in this plan (${JSON.stringify(stray[0]!.slice(0, 40))}), so nothing was written`);
    }

    // The code comes last and once, for the decisions that stand (the spec's order).
    const wrote = await writeCode(state, new Set(state.nodes.map((n) => n.path)), deps, tally);
    if (wrote !== null) return fail(wrote.refused);

    const checked = await checkAndWrite(state, deps);
    if (isDeriveRefusal(checked)) return fail(checked.refused);
    return finish(state, checked, tally, deps);
  } catch (err) {
    return fail(`the derivation stopped unexpectedly: ${thrownSentence(err)}`);
  }
}
