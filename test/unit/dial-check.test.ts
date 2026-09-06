// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/dial/check.ts` — *Check my work* (AC5), against the REAL repo-tour core and real
 * temporary directories. No stub of `check()`, no stub of `extract()`, no fake `fs`.
 *
 * That is deliberate and it is most of this suite's value. The thing being pinned is a
 * behaviour of a tree-sitter parse — "a renamed local variable is invisible to the check" —
 * and a fake core would happily agree with whatever this module asked it, which is precisely
 * the assertion that must not be taken on trust. Everything here therefore goes through the
 * same two roots a real walk uses: a reference tree (repo-tour's `request.json` repo) and a
 * learner's target tree, both written by `walk-fixtures.ts`'s own `writeFixtureTarget`, so
 * this file argues about the same four steps and the same source files as the rest of T-4's
 * suite rather than inventing a second plausible-looking fixture.
 *
 * No token is spent anywhere in here. `check()` and `extract()` are parsers; the interpret
 * stage — the only part of repo-tour that talks to a model — is never reached, and nothing in
 * this module's contract could make it.
 *
 * Both directions are pinned everywhere it matters. A check that refused everything would
 * "pass" a suite that only tested refusals, so each of the three `null` answers — no learner
 * file, no grammar for the language, a path that escapes the target — is paired with the
 * nearly-identical case that must still work: the same step once the file exists, the same
 * bytes under a name repo-tour has a grammar for, the same file reached by a contained path.
 * Without those pairs, a module that did nothing at all would be green.
 *
 * The fixture's `src/api/routes.ts` is the main subject because it is the only file in the
 * fixture with both exported symbols AND an import: three exports (`Handler` type,
 * `handleRequest` function, `routes` variable) and one import (`../parse.js`), read off the
 * real extractor, not counted by hand. `src/parse.ts` covers the other shape — exports, no
 * imports — which is a different sentence out of `summarize`.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { referenceExtract, runCheck } from '../../src/dial/check.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import type { PlanLike, StepLike } from '../../src/walk/model.js';
import { fixturePlan, writeFixtureTarget } from './walk-fixtures.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

/** The fixture file with both exports and an import — see this file's header. */
const ROUTES = 'src/api/routes.ts';
/** The fixture file with exports and NO imports. */
const PARSE = 'src/parse.ts';

let core: DialCore;
let plan: PlanLike;
/** Holds BOTH roots, so a `../` step has somewhere real to point (see the containment suite). */
let box: string;
let refRoot: string;
let target: string;

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  core = dialCoreFor(loaded.loaded);

  plan = fixturePlan();
  box = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-dial-check-'));
  refRoot = path.join(box, 'reference');
  target = path.join(box, 'learner');
  fs.mkdirSync(refRoot, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  writeFixtureTarget(refRoot);
});

/** The learner starts every test from a byte-identical copy of the reference, then edits it —
 *  so what any one test proves is the effect of ITS edit and nothing left over from another. */
setup(() => {
  writeFixtureTarget(target);
});

suiteTeardown(() => {
  fs.rmSync(box, { recursive: true, force: true });
});

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(root: string, rel: string, source: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, source);
}

/** The same bytes in both trees — a control file that differs only in where it lives. */
function writeBoth(rel: string, source: string): void {
  write(refRoot, rel, source);
  write(target, rel, source);
}

function stepById(id: string): StepLike {
  const step = plan.steps.find((s) => s.id === id);
  assert.ok(step, `the fixture plan should contain a step ${id}`);
  return step;
}

/** A step for a file the fixture plan does not describe. `runCheck` reads exactly one thing
 *  off a step — `target.file` — because the check is per FILE, whatever kind of step asked. */
function stepFor(file: string): StepLike {
  return {
    id: `st-for-${file}`,
    ordinal: 1,
    chapter: 'src',
    kind: 'file',
    decision: { question: 'why this file?', options: [], authorChoice: 'author', chosen: null, why: '', whySource: 'none' },
    target: { file },
    scaffold: { loadBearing: [], boilerplate: [] },
    dependsOn: [],
    witness: { sha: null, date: null, subject: null },
  };
}

/** A small, real, parseable TypeScript file — used wherever the question under test is WHERE
 *  a file is rather than what is in it. */
const CONTROL_SOURCE = 'export function control(n: number): number {\n  return n + 1;\n}\n';

// ── the check is structural, and only ever structural ───────────────────────────────────────

suite('runCheck — a structural check, and only ever a structural check', () => {
  test('a renamed local variable passes — AC5 names this case, and it is the whole point', async () => {
    const reference = read(refRoot, ROUTES);
    const renamed = reference.replace(/\btokens\b/g, 'words');
    assert.notEqual(renamed, reference, 'the rename has to actually change the file, or this test proves nothing');
    write(target, ROUTES, renamed);

    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome, 'a file that exists in a language repo-tour parses must produce a report');
    assert.equal(outcome.report.ok, true, outcome.summary);
    assert.deepEqual(outcome.report.symbols, [
      { name: 'Handler', kind: 'type', status: 'present' },
      { name: 'handleRequest', kind: 'function', status: 'present' },
      { name: 'routes', kind: 'variable', status: 'present' },
    ]);
    assert.deepEqual(outcome.report.imports, [{ raw: '../parse.js', status: 'present' }]);
    assert.equal(outcome.report.parseErrors, 0);
    assert.equal(outcome.report.reason, undefined, 'a clean report carries no reason — the field exists to explain a failure');
  });

  test('a body rewritten from scratch passes too: nothing here ever reads inside a function', async () => {
    // Same three exports, same one import, an implementation the author never wrote. If this
    // ever fails, someone has turned the structural check into a semantic diff — read
    // src/dial/check.ts's header before "fixing" it.
    write(target, ROUTES, [
      "import { tokenize } from '../parse.js';",
      '',
      'export type Handler = (body: string) => string;',
      '',
      'export function handleRequest(body: string): string {',
      '  let out = \'\';',
      '  for (const t of tokenize(body)) {',
      '    if (t.kind !== \'word\') continue;',
      '    out = out.length === 0 ? t.value : out + \' \' + t.value;',
      '  }',
      '  return out.length === 0 ? \'empty\' : out.toUpperCase();',
      '}',
      '',
      "export const routes: Record<string, Handler> = { '/echo': handleRequest, '/shout': handleRequest };",
      '',
    ].join('\n'));

    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome);
    assert.equal(outcome.report.ok, true, outcome.summary);
  });

  test('an export the reference never had is `extra`, and extras alone never fail', async () => {
    write(target, ROUTES, `${read(refRoot, ROUTES)}\nexport function bonus(): number {\n  return 0;\n}\n`);

    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome);
    assert.deepEqual(
      outcome.report.symbols.filter((s) => s.status !== 'present'),
      [{ name: 'bonus', kind: 'function', status: 'extra' }],
    );
    assert.equal(outcome.report.ok, true, 'an extra symbol is reported, never punished');
    assert.equal(
      outcome.summary,
      'every part is there: 3 exports and 1 import present · plus 1 export of your own (bonus) — extras never fail the check',
    );
  });
});

// ── the summary: the one line a learner actually reads ──────────────────────────────────────

suite('runCheck — the summary is the thing a learner actually reads', () => {
  test('a pass counts what was there, and says so differently when the reference has no imports', async () => {
    const both = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(both);
    assert.equal(both.summary, 'every part is there: 3 exports and 1 import present');

    const noImports = await runCheck(core, refRoot, target, stepById('st-2-file-parse'));
    assert.ok(noImports);
    assert.equal(noImports.report.imports.length, 0, `${PARSE} is the fixture's file with no imports`);
    assert.equal(noImports.summary, 'every part is there: 3 exports present, and no imports to match');
  });

  test('a missing export is NAMED in the summary, not merely counted', async () => {
    // `routes` dropped entirely; handleRequest and the import survive untouched.
    write(target, ROUTES, [
      "import { tokenize } from '../parse.js';",
      '',
      'export type Handler = (body: string) => string;',
      '',
      'export function handleRequest(body: string): string {',
      "  return tokenize(body).map((t) => t.value).join(' ');",
      '}',
      '',
    ].join('\n'));

    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome);
    assert.equal(outcome.report.ok, false);
    assert.deepEqual(
      outcome.report.symbols.filter((s) => s.status === 'missing'),
      [{ name: 'routes', kind: 'variable', status: 'missing' }],
    );
    assert.equal(outcome.summary, 'missing export: routes', 'a name is a next action; "1 missing" is a riddle');
  });

  test('a missing import is named too, alongside the missing export', async () => {
    write(target, ROUTES, [
      'export type Handler = (body: string) => string;',
      '',
      'export function handleRequest(body: string): string {',
      '  return body.toUpperCase();',
      '}',
      '',
    ].join('\n'));

    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome);
    assert.equal(outcome.report.ok, false);
    assert.deepEqual(outcome.report.imports, [{ raw: '../parse.js', status: 'missing' }]);
    assert.equal(outcome.summary, 'missing export: routes · missing import: ../parse.js');
  });

  test('more missing names than fit on one line are capped, and the tail is honest about it', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `export function a${i + 1}(): number {\n  return ${i + 1};\n}\n`).join('\n');
    write(refRoot, 'src/many.ts', nine);
    write(target, 'src/many.ts', 'export function a1(): number {\n  return 1;\n}\n');

    const outcome = await runCheck(core, refRoot, target, stepFor('src/many.ts'));
    assert.ok(outcome);
    assert.equal(outcome.report.symbols.filter((s) => s.status === 'missing').length, 8);
    assert.equal(outcome.summary, 'missing exports: a2, a3, a4, a5, a6, a7 … and 2 more');
  });

  test('a file that did not parse leads with the core’s own reason, not with a count', async () => {
    write(target, ROUTES, 'export function handleRequest( { {{{ broken');

    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome);
    assert.ok(outcome.report.parseErrors > 0, 'a file that does not parse is never reported clean');
    assert.equal(outcome.report.ok, false);
    assert.equal(typeof outcome.report.reason, 'string', 'the count says a file did not parse but never why');
    assert.equal(outcome.summary, outcome.report.reason);
    assert.ok(outcome.summary.includes('error'), outcome.summary);
    assert.ok(
      !outcome.summary.startsWith('missing'),
      'everything looks missing in a file that did not parse; leading with that would send the learner after the wrong thing',
    );
  });
});

// ── nothing to check is an ordinary answer ──────────────────────────────────────────────────

suite('runCheck — nothing to check is an ordinary answer, never a throw', () => {
  test('a learner file that is not there yet is null — and the same step checks fine once it is', async () => {
    // Manual mode writes nothing at all, so this is the commonest state this module sees.
    fs.rmSync(path.join(target, ROUTES));
    assert.equal(await runCheck(core, refRoot, target, stepById('st-3-symbol-handle')), null);

    write(target, ROUTES, read(refRoot, ROUTES));
    const outcome = await runCheck(core, refRoot, target, stepById('st-3-symbol-handle'));
    assert.ok(outcome, 'without this half, a runCheck that always returned null would pass the line above');
    assert.equal(outcome.report.ok, true);
  });

  test('a language repo-tour has no grammar for is null — the SAME bytes under a .ts name are checked', async () => {
    writeBoth('notes.md', CONTROL_SOURCE);
    writeBoth('notes.ts', CONTROL_SOURCE);

    assert.equal(await runCheck(core, refRoot, target, stepFor('notes.md')), null, 'the file is right there; the language is what refuses');
    const parsed = await runCheck(core, refRoot, target, stepFor('notes.ts'));
    assert.ok(parsed);
    assert.equal(parsed.report.ok, true);
  });

  test('a `shape` step, whose target is a directory rather than a file, is null', async () => {
    // The fixture's step 1 points at `src` — a real directory in both trees.
    assert.ok(fs.statSync(path.join(target, 'src')).isDirectory());
    assert.equal(await runCheck(core, refRoot, target, stepById('st-1-shape-src')), null);
  });

  test('a path that escapes the target is null even though the file it names really exists', async () => {
    // `<box>/outside.ts` sits one level above BOTH roots — so containment, not absence, is
    // the only thing that can refuse it. `path.join(target, '../outside.ts')` would have
    // opened it happily, which is exactly the bug `resolveInsideTarget` exists to prevent.
    fs.writeFileSync(path.join(box, 'outside.ts'), CONTROL_SOURCE);
    writeBoth('inside.ts', CONTROL_SOURCE);

    assert.equal(await runCheck(core, refRoot, target, stepFor('../outside.ts')), null);
    assert.equal(await runCheck(core, refRoot, target, stepFor(path.join(box, 'outside.ts'))), null, 'an absolute path escapes too');
    assert.ok(fs.existsSync(path.join(box, 'outside.ts')), 'the refusal must not be "no such file"');

    const contained = await runCheck(core, refRoot, target, stepFor('inside.ts'));
    assert.ok(contained, 'the same bytes at a contained path are checked normally');
    assert.equal(contained.report.ok, true);
  });
});

// ── the reference half ──────────────────────────────────────────────────────────────────────

suite('referenceExtract — built the way repo-tour’s own tests build one', () => {
  test('a real reference file extracts, and what comes back is what `check` compares against', async () => {
    const extract = await referenceExtract(core, refRoot, ROUTES);
    assert.ok(extract, 'the fixture reference really contains this file');

    // Handed straight back to the core, exactly as `runCheck` does — the extract is opaque
    // here on purpose (`src/dial/core.ts`), so the only honest assertion about it is that the
    // core accepts it and agrees the reference matches itself.
    const report = await core.check(read(refRoot, ROUTES), extract, 'typescript', ROUTES);
    assert.equal(report.ok, true);
    assert.equal(report.parseErrors, 0);
    assert.equal(report.symbols.length, 3);
    assert.deepEqual(report.imports, [{ raw: '../parse.js', status: 'present' }]);
  });

  test('a file that is not there, a language with no grammar, and a path that escapes are each null', async () => {
    write(refRoot, 'README.md', '# not a language repo-tour parses\n');
    fs.writeFileSync(path.join(box, 'outside-reference.ts'), CONTROL_SOURCE);

    assert.equal(await referenceExtract(core, refRoot, 'src/never-written.ts'), null);
    assert.equal(await referenceExtract(core, refRoot, 'README.md'), null);
    assert.equal(await referenceExtract(core, refRoot, 'src'), null, 'a directory is not a file to extract');
    assert.equal(await referenceExtract(core, refRoot, '../outside-reference.ts'), null);
    assert.ok(fs.existsSync(path.join(box, 'outside-reference.ts')), 'again: containment, not absence');

    // Non-vacuous: the same call on an ordinary file in the same tree still produces one.
    assert.ok(await referenceExtract(core, refRoot, PARSE));
  });
});
