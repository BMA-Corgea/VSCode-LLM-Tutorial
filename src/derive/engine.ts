// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The derivation engine (T-17): an idea becomes a plan the walk already renders.
 *
 * The technique, the two entry points and the honesty rule are the spec's
 * (`.autodev/specs/T-17-derivation-engine.md` in the ledger) and the plan's design decisions.
 * This file is the orchestration only. Every question goes through `askOnce` (`./ask.ts`), the one
 * door. The plan is built by `assemblePlan` (`./assemble.ts`) and its files are written by
 * `writeReferenceTree` (`./tree.ts`).
 *
 * **What is built so far (step 6b-1):** `derivePlan` for an idea and answers that do not differ
 * from the recommendations. It outlines, writes each file in plan order (each code prompt holding
 * exactly the node's chapter decision and the files it declares it depends on), checks every file
 * with repo-tour's real `extract`, writes the tree and assembles the plan. **A changed answer
 * needs the replan** (step 6b-2, with `replanPlan`), and until that exists `derivePlan` says so in
 * a sentence rather than quietly ignoring the answer. Ignoring it would be the one failure AC-A1
 * exists to catch.
 *
 * No `vscode` import — see `./types.ts`.
 */

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DialCore, FileRecord } from '../dial/core.js';
import { languageOf } from '../dial/core.js';
import { askOnce, newTally, type AskTally, type DeriveAskDeps } from './ask.js';
import { assemblePlan, lineCountOf, stepIdFor, type DeriveCost, type DerivedPlan, type ExtractLike } from './assemble.js';
import { codePrompt, outlinePrompt, parseCodeReply, parseOutlineReply, type DecisionForPrompt, type DependencyForPrompt } from './prompt.js';
import { writeReferenceTree, type DerivedFile } from './tree.js';
import { isDeriveRefusal, type DerivedNode, type Outline } from './types.js';

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
  /** the learner's answers so far, by step id */
  answers?: Readonly<Record<string, string>>;
}

export type DeriveOutcome =
  | { ok: true; plan: DerivedPlan; referenceRoot: string; files: DerivedFile[]; outline: Outline }
  | { ok: false; reason: string; cost: DeriveCost };

function costOf(tally: AskTally, deps: DeriveDeps): DeriveCost {
  return {
    provider: deps.settings.provider,
    model: deps.settings.model,
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

function effectiveOption(node: DerivedNode, answers: Readonly<Record<string, string>>): DerivedNode['options'][number] {
  const answer = answers[stepIdFor(node)];
  return node.options.find((o) => o.id === answer) ?? node.options.find((o) => o.id === node.recommended)!;
}

function decisionOf(node: DerivedNode, answers: Readonly<Record<string, string>>): DecisionForPrompt {
  const chosen = effectiveOption(node, answers);
  return { path: node.path, question: node.question, chosen: { label: chosen.label, consequence: chosen.consequence }, why: node.why };
}

/** JavaScript's own modules, with and without the `node:` prefix. */
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/**
 * Why a derived file may not stand, by repo-tour's own reading of it, or `null`. It must parse
 * cleanly. Every relative import must resolve to a file the node declares it depends on: the code
 * prompt showed it only those files, so an import of anything else is a guess at an API it never
 * saw. A JavaScript bare import must be one of Node's own modules (there is nothing to install).
 */
export function unsoundFileReason(extract: ExtractLike, allowedFiles: ReadonlySet<string>, language: 'javascript' | 'python'): string | null {
  if (extract.parseErrors > 0) return `does not parse (${extract.parseErrors} syntax error${extract.parseErrors === 1 ? '' : 's'})`;
  for (const imp of extract.imports) {
    if (imp.resolved !== null) {
      if (!allowedFiles.has(imp.resolved)) return `imports ${JSON.stringify(imp.raw)}, a file it does not depend on`;
      continue;
    }
    if (imp.raw.startsWith('.')) return `imports ${JSON.stringify(imp.raw)}, which is not one of its dependencies' files`;
    if (language === 'javascript' && !NODE_BUILTINS.has(imp.raw)) return `imports the package ${JSON.stringify(imp.raw)}, which would need installing`;
  }
  return null;
}

/** Run repo-tour's `extract` over the derived files, from a scratch folder this call made. */
async function extractAll(core: Pick<DialCore, 'extract'>, files: readonly DerivedFile[]): Promise<Map<string, ExtractLike> | string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-extract-'));
  try {
    const records: FileRecord[] = [];
    for (const f of files) {
      const abs = path.join(scratch, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
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

/** Derive a plan, and its reference tree, from an idea. See the header for what is built so far. */
export async function derivePlan(request: DeriveRequest, deps: DeriveDeps): Promise<DeriveOutcome> {
  const tally = newTally();
  const answers = request.answers ?? {};
  const fail = (reason: string): DeriveOutcome => ({ ok: false, reason, cost: costOf(tally, deps) });

  deps.onProgress?.('laying out the decisions…');
  const outline = await askOnce(deps, 'derive:outline', outlinePrompt(request.idea), parseOutlineReply, tally);
  if (isDeriveRefusal(outline)) return fail(outline.refused);

  for (const node of outline.nodes) {
    const answer = answers[stepIdFor(node)];
    if (answer !== undefined && answer !== node.recommended && node.options.some((o) => o.id === answer)) {
      return fail('an answer that differs from the recommendation needs the replan, which is not built yet (T-17 step 6b-2)');
    }
  }

  const byPath = new Map(outline.nodes.map((n) => [n.path, n] as const));
  const content = new Map<string, string>();
  const fileNodes = outline.nodes.filter((n) => n.kind === 'file');
  for (const [i, node] of fileNodes.entries()) {
    deps.onProgress?.(`writing ${node.path} (${i + 1} of ${fileNodes.length})…`);
    const chapter = byPath.get(node.chapter)!;
    const dependencies: DependencyForPrompt[] = node.dependsOn
      .filter((p) => p !== node.chapter)
      .map((p) => byPath.get(p)!)
      .map((d) => ({ ...decisionOf(d, answers), ...(d.kind === 'file' ? { content: content.get(d.path)! } : {}) }));
    const prompt = codePrompt({
      idea: request.idea, title: outline.title, language: outline.language,
      chapter: decisionOf(chapter, answers),
      node: { ...decisionOf(node, answers), isEntry: node.path === outline.entry },
      dependencies,
    });
    const code = await askOnce(deps, `derive:code:${stepIdFor(node)}`, prompt, (t) => parseCodeReply(t, node.path), tally);
    if (isDeriveRefusal(code)) return fail(code.refused);
    content.set(node.path, code.content);
  }

  const files: DerivedFile[] = fileNodes.map((n) => ({ path: n.path, content: content.get(n.path)! }));
  const extracts = await extractAll(deps.dialCore, files);
  if (typeof extracts === 'string') return fail(extracts);
  for (const node of fileNodes) {
    const extract = extracts.get(node.path);
    if (extract === undefined) return fail(`repo-tour returned no reading of ${node.path}`);
    const allowed = new Set(node.dependsOn.filter((p) => byPath.get(p)?.kind === 'file'));
    const unsound = unsoundFileReason(extract, allowed, outline.language);
    if (unsound !== null) return fail(`the derived file ${node.path} ${unsound}`);
  }

  const tree = writeReferenceTree(deps.globalStorageRoot, deps.target, outline.title, files);
  if (isDeriveRefusal(tree)) return fail(tree.refused);

  const plan = assemblePlan({
    idea: request.idea, title: outline.title, language: outline.language, chapters: outline.chapters,
    nodes: outline.nodes, answers, files: content, extracts, cost: costOf(tally, deps),
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  return { ok: true, plan, referenceRoot: tree.root, files, outline };
}
