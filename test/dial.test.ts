// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vscode-test suite for the dial (T-5): the whole machine, end to end, on a tutorial this file
 * BUILDS rather than hand-writes. `test/unit/dial-{writer,check,commit}.test.ts` and
 * `test/unit/walk-session.test.ts` already own every rule the dial follows — what to write per
 * position, when to prompt, what a pass earns, what a missing identity refuses — against fake
 * adapters and a fixture plan. Re-asserting any of that here would buy nothing but minutes.
 *
 * **What only a real extension host, and a real plan, can prove — which is why this file
 * exists:**
 *   - **AC6, the headline.** A hand-written fixture can promise that `reproduceFiles` copies
 *     the entries it was given; it cannot promise that those entries plus the plan's `file`
 *     steps COVER every file repo-tour's inventory saw. That is a claim about what the core
 *     generates, so the only honest way to make it is to generate one: this file builds a real
 *     plan through `buildFromRequest` (`cachedOnly`, so it never spends a token), walks it in
 *     automated mode through the REGISTERED session, and then compares the target with the
 *     reference file by file, as BYTES. Bytes and not strings, and the suite proves the
 *     difference on itself: the fixture's `data/seed.bin` holds `ff` where one mutation puts
 *     `fe`, and UTF-8 decodes both to U+FFFD — so a string comparison passes over exactly the
 *     corruption a `diff -r` would catch.
 *   - **AC7.** That the commits are real `git` commits in the learner's own folder, made by
 *     the real `realGit` runner the extension wires in, with the subject `commitSubject`
 *     composes — and made under the identity configured IN THAT FOLDER. The identity half
 *     cannot be tested with a fake git at all, and it cannot be tested honestly against a
 *     machine that has a global `user.name` (this one does) unless the fixture sets a LOCAL
 *     one and then asserts the commits carry it. Nothing here touches the machine's global
 *     config, by design.
 *   - **AC3.** That the core loaded INSIDE the extension host — Electron, `web-tree-sitter`
 *     wasm and all — really stubs a file that still parses. The unit suite proves the same
 *     claim under plain node; this proves the host does not quietly break the grammar it
 *     depends on, and it carries its own discriminator (a deliberately unparseable source that
 *     must report ERROR nodes) so a parser that had stopped working could not pass it.
 *   - **AC2.** That the shape block reaches the real webview's own page, and that opening a
 *     `file` step in manual mode leaves the learner's tree byte-identical. `getStateForTest`
 *     can see the state; only `webview.html` can see what was drawn from it.
 *   - **AC5.** That a failed check reaches the REGISTERED `TreeDataProvider` as the ✗ a
 *     learner sees (`stepMark` → `stepItem` → `vscode.TreeItem`), and that a step nobody has
 *     checked still shows neither mark — the distinction `TreeStepNode.check` exists for.
 *
 * **One thing deliberately NOT covered:** the step panel's client-side `note` channel. T-5
 * removed the placeholder that used to feed it and nothing produces one until T-6's tutor
 * arrives; `test/unit/walk-step-view.test.ts` already proves the channel itself, script and
 * all. Coverage for a field with no producer would be coverage of nothing.
 *
 * **No token is ever spent.** Every build runs with `cachedOnly: true` and each one asserts
 * its own `cost` came back at zero dollars and zero tokens, so a fixture that quietly started
 * reaching for a model would fail here rather than bill for it.
 *
 * Every test opens its own freshly built tutorial and disposes its session in `teardown`: the
 * four surfaces are window-wide singletons created once in `activate()` (see
 * `test/walk.test.ts`'s header), and a session left running would keep driving them into
 * whichever test runs next.
 */

import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_REPO_TOUR_PATH, loadCore, resolveCoreRoot, type CoreLoadResult } from '../src/core.js';
import { commitSubject } from '../src/dial/commit.js';
import { dialCoreFor, type DialCore, type FileRecord } from '../src/dial/core.js';
import type { ExtensionApi } from '../src/extension.js';
import {
  buildFromRequest, coreFor, gitRunnerWith, GIT_TIMEOUT_MS, GitTimeoutError, realGit,
  type ExecFileLike,
} from '../src/start/build.js';
import { emptyRequest, type BuildRequest, type Dial } from '../src/start/request.js';
import type { PlanLike, Progress, StepLike } from '../src/walk/model.js';
import { WalkSession, type WalkAdapters } from '../src/walk/session.js';
import { CHECK_HEADING, SHAPE_HEADING, SHAPE_NOTE_MESSAGE } from '../src/walk/step-view.js';
import { loadPlan, loadProgress, loadRequest, saveProgress } from '../src/walk/store.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

/** VS Code auto-generates `<viewId>.focus` for every contributed view — the only way to make
 *  the host call `resolveWebviewView`, and therefore the only way to read a real page back. */
const STEP_VIEW_FOCUS = 'buildTutorials.step.focus';

/** The identity the fixture configures LOCALLY in each temp target, and nowhere else. It is
 *  deliberately nothing like the identity this machine's global git config holds, so a commit
 *  carrying it is proof the folder's own config is what git used (AC7 — "commits are the
 *  learner's, not ours"). Nothing in this file writes to `--global`. */
const LEARNER_NAME = 'The Learner';
const LEARNER_EMAIL = 'learner@build-tutorials.invalid';

// ── the reference repository this suite teaches ────────────────────────────────────────────

/**
 * A small, complete project: two TypeScript modules (one of which imports the other, so the
 * shape block has imports to show), one JavaScript module, one GENERATED file and one data
 * file. The last two are the point of the fixture as much as the first three — repo-tour
 * classifies them as never-taught, so they must reach `plan.reproduce` and must never appear
 * as steps, and AC6 is only satisfiable at all because the two lists together cover the whole
 * inventory.
 *
 * Written out here rather than derived, because several assertions below quote these exact
 * lines — a signature the panel must show, an export the check must miss — and a test that
 * computed them the way the code does would agree with a change instead of catching one.
 */
const REFERENCE_TEXT: Readonly<Record<string, string>> = {
  'src/util.ts':
    'export function add(a: number, b: number): number {\n'
    + '  return a + b;\n'
    + '}\n'
    + '\n'
    + 'export function multiply(a: number, b: number): number {\n'
    + '  return a * b;\n'
    + '}\n',
  'src/format.js':
    'export function greet(name) {\n'
    + "  return 'hello, ' + name;\n"
    + '}\n'
    + '\n'
    + 'export function shout(name) {\n'
    + '  return greet(name).toUpperCase();\n'
    + '}\n',
  'src/app.ts':
    "import { add, multiply } from './util.js';\n"
    + '\n'
    + 'export function compute(a: number, b: number): number {\n'
    + '  return add(a, b) + multiply(a, b);\n'
    + '}\n',
  'src/generated.ts':
    '// @generated by a codegen tool — do not edit\n'
    + 'export const VERSION = 1;\n',
  'data/seed.json': '{"rows": [1, 2, 3]}\n',
};

/**
 * The fixture's one file that is not text at all — and the reason every comparison below is a
 * `Buffer.equals` rather than a string equality. `ff` and `fe` are both invalid UTF-8 lead
 * bytes and both decode to U+FFFD, so a single-byte change here is INVISIBLE to a string
 * comparison and plain as day to a byte one. The AC6 test mutates exactly this byte to prove
 * its own assertion discriminates.
 */
const SEED_BIN = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]);

/** The reference paths repo-tour must classify as never-taught, so they arrive through
 *  `plan.reproduce` and never as a step (AC6's second half). */
const NEVER_TAUGHT = ['data/seed.bin', 'data/seed.json', 'src/generated.ts'];

/** `.repo-tour/` is on BOTH sides — the digest writes its own cache into the reference, the
 *  build writes plan/request/progress into the target — and `.git/` is the target's own
 *  history. Neither is the project, so neither is compared. */
const NOT_THE_PROJECT = new Set(['.repo-tour', '.git']);

// ── the harness ────────────────────────────────────────────────────────────────────────────

/** Per-test folders, emptied by `teardownDial`. */
const targets: string[] = [];
/** Sessions this file constructed itself (the overwrite prompt — see that suite), disposed
 *  alongside the registered one so nothing keeps writing after its test has ended. */
const ownSessions: WalkSession[] = [];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  return await ext.activate();
}

/**
 * repo-tour, resolved the way `src/extension.ts` itself resolves it — the configured
 * `repoTourPath` against the extension's own install directory — so this suite reads the same
 * checkout the walk under test is reading, rather than whatever `process.cwd()` happens to be
 * inside an Extension Development Host. Memoised: `import()` caches the modules anyway, and
 * the grammars behind them are not cheap to load twice.
 */
let coreOnce: Promise<CoreLoadResult> | undefined;
function loadedCore(): Promise<CoreLoadResult> {
  coreOnce ??= (async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
    const setting = vscode.workspace.getConfiguration('buildTutorials').get<string>('repoTourPath', DEFAULT_REPO_TOUR_PATH);
    const loaded = await loadCore(resolveCoreRoot(setting, ext.extensionUri.fsPath));
    assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should load from the configured checkout');
    return loaded;
  })();
  return coreOnce;
}

async function dialCore(): Promise<DialCore> {
  return dialCoreFor((await loadedCore()).loaded);
}

/** One reference tree for the whole file: no test writes into it, and re-digesting it per
 *  build is exactly what a learner building several tutorials from one repository does. */
let referenceOnce: string | undefined;
/** repo-tour's clone cache; nothing is cloned here (the reference is a local path) but
 *  `BuildContext` requires somewhere to put one. */
let storageOnce: string | undefined;

function referenceRoot(): string {
  if (referenceOnce !== undefined) return referenceOnce;
  const root = tmpDir('dial-test-reference-');
  for (const [rel, text] of Object.entries(REFERENCE_TEXT)) writeInto(root, rel, Buffer.from(text, 'utf8'));
  writeInto(root, 'data/seed.bin', SEED_BIN);
  referenceOnce = root;
  return root;
}

function writeInto(root: string, rel: string, bytes: Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

/** A tutorial as the start screen would have produced it: a REAL plan and a real
 *  `request.json` carrying the global dial, built by the real core out of the fixture
 *  reference. Not cached between tests — the walk writes progress into it, and a plan that
 *  had already been walked would make "nothing was written" mean nothing. */
async function newTutorial(dial: Dial): Promise<{ target: string; refRoot: string; plan: PlanLike }> {
  const loaded = await loadedCore();
  const refRoot = referenceRoot();
  const target = tmpDir('dial-test-target-');
  targets.push(target);
  storageOnce ??= tmpDir('dial-test-storage-');

  const request: BuildRequest = { ...emptyRequest(), recreate: true, repo: refRoot, target, dial };
  const outcome = await buildFromRequest(request, {
    core: coreFor(loaded.loaded),
    globalStorageRoot: storageOnce,
    provider: 'claude',
    model: (loaded.loaded['interpret'] as { DEFAULT_MODEL: string }).DEFAULT_MODEL,
    // The suite's own operating rule, asserted rather than trusted three lines below.
    cachedOnly: true,
  });

  assert.equal(outcome.ok, true, outcome.reason ?? 'the fixture tutorial should build');
  const cost = outcome.cost;
  assert.ok(cost, 'a finished build reports its cost');
  assert.equal(cost.usd, 0, 'this suite must never spend a token — cachedOnly should have kept the cost at zero');
  assert.equal(cost.inputTokens + cost.outputTokens, 0, 'and should not have sent or received one either');

  return { target, refRoot, plan: loadPlan(target) };
}

/** `git init` plus an identity in THIS FOLDER ONLY. `--local` is not decoration: `git config
 *  user.name` falls through to the machine's global, this machine has one, and a fixture that
 *  relied on that would pass without proving anything about the folder AC7 is about. */
async function initRepoWithIdentity(target: string): Promise<void> {
  await realGit(['init', '-q'], target);
  await realGit(['config', '--local', 'user.name', LEARNER_NAME], target);
  await realGit(['config', '--local', 'user.email', LEARNER_EMAIL], target);
}

/** Opens the walk through the real activation path and hands back the REGISTERED surfaces,
 *  with the entry pass for the step it opened on already finished. */
async function openWalk(dir: string) {
  const api = await getApi();
  await api._walk.openAt(dir);
  const session = api._walk.session();
  const tree = api._walk.tree();
  const panel = api._walk.panel();
  assert.ok(session, 'opening the walk should leave a live session behind');
  assert.ok(tree, 'the decision tree provider should have been registered in activate()');
  assert.ok(panel, 'the step view provider should have been registered in activate()');
  assert.equal(session.target, dir, 'the session should be walking the folder it was opened at');
  await session.settled();
  return { api, session, tree, panel };
}

/** The command every tree leaf carries, followed by the wait the walk's own contract asks for:
 *  `WalkSession.settled()` is the tail of the session's serialised job chain, and the dial's
 *  write is on it. Reading a file before that resolves is reading it mid-rename. */
async function goTo(session: WalkSession, stepId: string): Promise<void> {
  await vscode.commands.executeCommand('buildTutorials.goToStep', stepId);
  await session.settled();
}

/**
 * Arrive at every step in ordinal order — the whole plan, the way a learner clicking each leaf
 * in turn does — letting each arrival finish before asking for the next.
 *
 * The waiting is the meaning, not an optimisation. `WalkSession.applyDial` re-reads the step
 * by id when the job actually RUNS and abandons it if the walk has since moved on, so an
 * arrival that is queued but never settled is an arrival that writes nothing. "Walking every
 * step" is therefore arriving at every step, which is exactly what AC6 says.
 */
async function walkEveryStep(session: WalkSession, plan: PlanLike): Promise<void> {
  for (const step of orderedSteps(plan)) await goTo(session, step.id);
}

function orderedSteps(plan: PlanLike): StepLike[] {
  return [...plan.steps].sort((a, b) => a.ordinal - b.ordinal);
}

/** Every `file` step in the generated plan, in ordinal order — the steps that own a file of
 *  their own, and so the steps a completed automated walk commits. */
function fileSteps(plan: PlanLike): StepLike[] {
  return orderedSteps(plan).filter((step) => step.kind === 'file');
}

/** The `file` step that teaches `rel`. Looked up by target rather than by ordinal because the
 *  order is repo-tour's to choose: a ranking change should move this test, not break it. */
function fileStepFor(plan: PlanLike, rel: string): StepLike {
  const step = fileSteps(plan).find((s) => s.target.file === rel);
  assert.ok(step, `the generated plan should teach ${rel} as a file step`);
  return step;
}

function progressOf(target: string, plan: PlanLike): Progress {
  return loadProgress(target, plan);
}

function readBytes(root: string, rel: string): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(root, rel));
  } catch {
    return undefined;
  }
}

/** Every file under `root`, relative and sorted, skipping the two directories that are not
 *  the project (see `NOT_THE_PROJECT`). */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (NOT_THE_PROJECT.has(entry.name)) continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else found.push(next);
    }
  };
  walk('');
  return found.sort();
}

/**
 * The acceptance criterion itself: `diff -r`, in three answers rather than one — a file the
 * reference has and the target does not, a file the target has and the reference does not, and
 * a file both have whose BYTES differ. Empty means the target reproduces the reference.
 *
 * Compared as `Buffer`s throughout. A string comparison would decode both sides before looking
 * at them, and UTF-8 decoding is lossy for exactly the bytes a binary fixture is made of — see
 * `SEED_BIN`, and the mutation the AC6 test performs on it.
 */
function differences(refRoot: string, target: string): string[] {
  const left = filesUnder(refRoot);
  const right = new Set(filesUnder(target));
  const found: string[] = [];

  for (const rel of left) {
    if (!right.has(rel)) {
      found.push(`${rel}: in the reference, missing from the target`);
      continue;
    }
    const a = fs.readFileSync(path.join(refRoot, rel));
    const b = fs.readFileSync(path.join(target, rel));
    if (!a.equals(b)) {
      found.push(`${rel}: the bytes differ (${a.length} in the reference, ${b.length} in the target)`);
    }
  }
  for (const rel of right) {
    if (!left.includes(rel)) found.push(`${rel}: in the target, not in the reference`);
  }
  return found.sort();
}

/** The real core's ERROR-node count for a source (AC3's own measure, not a proxy for it) —
 *  the same shape `test/unit/dial-writer.test.ts` uses, run here inside the extension host so
 *  that the wasm grammars Electron loads are the ones being asked. */
async function parseErrorsOf(source: string, language: string, ext: string): Promise<number> {
  const core = await dialCore();
  const dir = tmpDir('dial-test-parse-');
  targets.push(dir);
  const rel = `probe.${ext}`;
  fs.writeFileSync(path.join(dir, rel), source);
  const record: FileRecord = {
    path: rel,
    repo: '',
    bytes: Buffer.byteLength(source, 'utf8'),
    loc: source.split(/\r?\n/).length,
    language,
    sha256: '',
    classification: 'source',
    signals: ['build-tutorials-dial-test'],
    binary: false,
  };
  const { extracts } = await core.extract(dir, [record]);
  assert.equal(extracts.length, 1, `extract() produced nothing for a ${language} fixture`);
  return (extracts[0] as { parseErrors: number }).parseErrors;
}

/** `git log` oldest-first, one subject per line — the order the steps were walked in. */
async function commitSubjects(target: string): Promise<string[]> {
  const log = await realGit(['log', '--reverse', '--format=%s'], target);
  return log.split('\n').filter((line) => line.length > 0);
}

async function commitAuthors(target: string): Promise<string[]> {
  const log = await realGit(['log', '--format=%an <%ae>'], target);
  return [...new Set(log.split('\n').filter((line) => line.length > 0))];
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Long enough for a reveal to make it back across the extension-host boundary — the same
 *  reason (and the same number) `test/walk.test.ts` pays it. */
function settle(): Promise<void> {
  return delay(300);
}

async function teardownDial(): Promise<void> {
  const api = await getApi();
  api._walk.session()?.dispose();
  api._walk.decorator()?.clear();
  for (const session of ownSessions.splice(0)) session.dispose();
  // A reveal already in flight when the session was disposed still finishes and still opens
  // its document; closing the editors before it lands would leave it opening one behind us.
  await settle();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const dir of targets.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The shared reference and clone cache outlive every test, so they go at the very end. */
suiteTeardown(() => {
  for (const dir of [referenceOnce, storageOnce]) {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
  referenceOnce = undefined;
  storageOnce = undefined;
});

// ── AC6: the whole point ───────────────────────────────────────────────────────────────────

/**
 * **AC6 GAINED AN EXCEPTION IN T-12, AND THIS SUITE DOES NOT TEST IT.** Read before trusting a
 * green run here as proof of the criterion.
 *
 * AC6 says an automated walk leaves the target identical to the reference. Since T-12,
 * `reproduceFiles` **withholds** any `plan.reproduce` entry whose name says it carries
 * credentials or configures an agent that would then run in the learner's folder. Against a
 * reference repo carrying such a file, a fully-walked target therefore CANNOT `diff -r` clean —
 * and **repo-tour is one such reference**: it commits `.claude/settings.json`, and it is the
 * obvious repository to point this extension at, since the project is defined as its inverse.
 *
 * So the criterion now reads: *identical to the reference, except for entries the name rule
 * withholds, each of which is reported to the learner.* That is a deliberate trade — the
 * alternative is copying someone's credentials into a folder this extension runs `git commit`
 * in — but it is an exception to the headline AC and it is not written in the AC's own words
 * anywhere else.
 *
 * **The tests below pass only because this fixture happens to be clean.** `NEVER_TAUGHT` is
 * `['data/seed.bin', 'data/seed.json', 'src/generated.ts']` — three names the rule has no
 * opinion about. Add one withheld name to the fixture and the byte-for-byte assertion fails,
 * correctly. That is worth knowing before someone reads a green AC6 as "the exception is
 * covered": it is not covered, it is absent. The rule's own behaviour is pinned in
 * `test/unit/dial-writer.test.ts`; what is missing here is the *interaction*, and the honest
 * statement is that this suite proves the criterion for references with no withheld files.
 */
suite('an automated walk reproduces the reference byte for byte (AC6)', () => {
  teardown(teardownDial);

  test('AC6: the plan\'s file steps and its reproduce list together cover every file the digest saw', async () => {
    const { plan } = await newTutorial('automated');

    // The reproduce half, first: these are the generated / data files repo-tour classified as
    // never-taught. The claim is BOTH that they are listed and that they are not steps — a
    // lockfile turned into a step would be a tutorial asking a learner to type a lockfile.
    assert.deepEqual([...(plan['reproduce'] as string[])].sort(), NEVER_TAUGHT);
    const taught = new Set(plan.steps.map((step) => step.target.file));
    for (const rel of NEVER_TAUGHT) {
      assert.equal(taught.has(rel), false, `${rel} is reproduced, so it must never be presented as a step`);
    }

    // …and together they account for the whole reference, which is the only reason a clean
    // diff is reachable at all. Asserted against the FILESYSTEM rather than against a list
    // written here, so a file added to the fixture and forgotten by the plan fails this.
    const covered = new Set([...fileSteps(plan).map((step) => step.target.file), ...NEVER_TAUGHT]);
    assert.deepEqual([...covered].sort(), filesUnder(referenceRoot()));
  });

  test('AC6: walking every step in automated mode leaves the target identical to the reference', async () => {
    const { target, refRoot, plan } = await newTutorial('automated');
    const { session } = await openWalk(target);

    assert.deepEqual(filesUnder(target), [], 'the target starts with none of the project in it');

    await walkEveryStep(session, plan);

    // The whole criterion, both directions at once: nothing missing, nothing extra, no file
    // whose bytes differ. Rendered as a list rather than a boolean so a failure says WHICH.
    assert.deepEqual(
      differences(refRoot, target),
      [],
      'a fully walked automated target must be the reference, file for file and byte for byte',
    );
    assert.deepEqual(filesUnder(target), filesUnder(refRoot));

    // The never-taught files came from `plan.reproduce`, not from a step, and they arrived as
    // bytes: `data/seed.bin` is not valid UTF-8 anywhere along its path.
    assert.ok(readBytes(target, 'data/seed.bin')?.equals(SEED_BIN), 'the binary fixture survived the copy unchanged');

    // `ensureRepo` git-inits a target that is not a repository yet (AC7's first clause). This
    // fixture never ran `git init`, so a `.git` here can only be the walk's own doing.
    assert.equal(fs.existsSync(path.join(target, '.git')), true, 'the walk should have git-inited the target it commits into');

    // ── the assertion, tested ────────────────────────────────────────────────────────────
    // A comparison that would pass over a corrupted file is not a comparison. So corrupt one
    // — one byte, in the file where a byte comparison and a string comparison genuinely give
    // different answers — and require the check above to notice.
    const victim = path.join(target, 'data/seed.bin');
    const original = fs.readFileSync(victim);
    const corrupted = Buffer.from(original);
    corrupted[1] = 0xfe; // was 0xff
    fs.writeFileSync(victim, corrupted);

    assert.equal(
      original.toString('utf8'),
      corrupted.toString('utf8'),
      'both 0xff and 0xfe decode to U+FFFD, so a STRING comparison cannot see this change — which is why the one above is a byte comparison',
    );
    assert.deepEqual(
      differences(refRoot, target),
      ['data/seed.bin: the bytes differ (5 in the reference, 5 in the target)'],
      'one corrupted byte must fail the AC6 comparison, or it was never testing anything',
    );

    fs.writeFileSync(victim, original);
    assert.deepEqual(differences(refRoot, target), [], 'and the restored file must come back clean');

    // The same proof for a text file, where the corruption is a plain edit rather than an
    // encoding trick — the two halves of "no file differs".
    const source = path.join(target, 'src/util.ts');
    const sourceBytes = fs.readFileSync(source);
    fs.writeFileSync(source, Buffer.concat([sourceBytes, Buffer.from('\n', 'utf8')]));
    assert.deepEqual(
      differences(refRoot, target),
      [`src/util.ts: the bytes differ (${sourceBytes.length} in the reference, ${sourceBytes.length + 1} in the target)`],
    );

    // …and the two directions, which a same-files comparison would never exercise.
    fs.writeFileSync(source, sourceBytes);
    fs.writeFileSync(path.join(target, 'src', 'mine.ts'), 'export const mine = 1;\n');
    assert.deepEqual(differences(refRoot, target), ['src/mine.ts: in the target, not in the reference']);
    fs.rmSync(path.join(target, 'src', 'mine.ts'));
    fs.rmSync(path.join(target, 'src', 'generated.ts'));
    assert.deepEqual(differences(refRoot, target), ['src/generated.ts: in the reference, missing from the target']);
  });
});

// ── AC7: one commit per completed step, in the learner's own repository ────────────────────

suite('a commit per completed file step, in the learner\'s own repository (AC7)', () => {
  teardown(teardownDial);

  test('AC7: each file step commits once, with commitSubject\'s subject, under the folder\'s OWN identity', async () => {
    const { target, plan } = await newTutorial('automated');
    await initRepoWithIdentity(target);

    const { session } = await openWalk(target);
    await walkEveryStep(session, plan);

    const expected = fileSteps(plan).map((step) => commitSubject(step));
    assert.equal(expected.length, 3, 'the fixture teaches three files, so three steps can complete');
    assert.deepEqual(
      await commitSubjects(target),
      expected,
      'one commit per completed file step, in the order they were walked — no more, no fewer',
    );
    // Not purely self-referential: the shape AC7 spells out, checked against the real log.
    for (const subject of expected) assert.match(subject, /^\d+: .+ — .+$/);

    assert.deepEqual(
      await commitAuthors(target),
      [`${LEARNER_NAME} <${LEARNER_EMAIL}>`],
      'the commits must carry the identity configured in THIS folder — this machine has a global one, and using it would be the bug',
    );

    // A `symbol` step has no file of its own and an automated `shape` step nothing to write, so
    // neither can add a commit; and re-entering a step already written must not add one either.
    await goTo(session, fileStepFor(plan, 'src/util.ts').id);
    await goTo(session, fileStepFor(plan, 'src/util.ts').id);
    assert.deepEqual(await commitSubjects(target), expected, 'walking back over a finished step commits nothing more');

    // The other half of "completed": progress says so, durably.
    const progress = progressOf(target, plan);
    for (const step of fileSteps(plan)) {
      assert.equal(progress.steps[step.id]?.status, 'done', `${step.target.file} should be marked done by an automated walk`);
    }
  });

  test('AC7: the setting turns it off — the same walk, with commitPerStep false, commits nothing', async () => {
    const config = vscode.workspace.getConfiguration('buildTutorials');
    const { target, plan } = await newTutorial('automated');
    await initRepoWithIdentity(target);

    await config.update('commitPerStep', false, vscode.ConfigurationTarget.Global);
    try {
      const { session } = await openWalk(target);
      await walkEveryStep(session, plan);

      assert.deepEqual(await commitSubjects(target).catch(() => []), [], 'commitPerStep off means no commit at all');
      // …and the files still landed, so this is the setting being obeyed rather than the walk
      // failing to do anything.
      assert.deepEqual(differences(referenceRoot(), target), []);
    } finally {
      await config.update('commitPerStep', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

// ── AC3: scaffolded — the core's stubs, in the host's own parser ───────────────────────────

suite('scaffolded writes a file that still parses (AC3)', () => {
  teardown(teardownDial);

  test('AC3: the TypeScript and JavaScript files written by scaffolded parse with zero ERROR nodes, and are not the reference', async () => {
    // The discriminator FIRST: if the grammars loaded in this host were broken they would
    // report zero errors for everything, and every assertion below would be vacuous.
    assert.ok(await parseErrorsOf('export function broken(: {\n', 'typescript', 'ts') > 0, 'a source that cannot parse must report ERROR nodes');
    assert.ok(await parseErrorsOf('function broken(: {\n', 'javascript', 'js') > 0);

    const { target, refRoot, plan } = await newTutorial('scaffolded');
    const { session } = await openWalk(target);

    for (const [rel, language, ext] of [['src/util.ts', 'typescript', 'ts'], ['src/format.js', 'javascript', 'js']] as const) {
      await goTo(session, fileStepFor(plan, rel).id);

      const written = fs.readFileSync(path.join(target, rel), 'utf8');
      assert.equal(await parseErrorsOf(written, language, ext), 0, `the scaffolded ${rel} does not parse:\n${written}`);
      assert.notEqual(
        written,
        REFERENCE_TEXT[rel],
        `scaffolded must not hand over the answer — ${rel} came out identical to the reference`,
      );
      // The boilerplate line the plan named IS copied verbatim; it is the load-bearing bodies
      // that are gone. Both halves, or "not the reference" would also pass for an empty file.
      assert.ok(written.length > 0, 'and it is not empty either');
      assert.equal(readBytes(target, rel)?.equals(fs.readFileSync(path.join(refRoot, rel))), false);
    }

    // Nothing marks a scaffolded step done — the learner still has to fill the stubs in — so
    // nothing commits, which is the difference between AC3 and AC4.
    const progress = progressOf(target, plan);
    assert.notEqual(progress.steps[fileStepFor(plan, 'src/util.ts').id]?.status, 'done');
  });
});

// ── AC2: manual — nothing written, and the shape on the real page ─────────────────────────

suite('manual writes nothing and shows the file\'s shape instead (AC2)', () => {
  teardown(teardownDial);

  test('AC2: opening a file step in manual mode leaves the target tree untouched', async () => {
    const { target, plan } = await newTutorial('manual');
    const { session } = await openWalk(target);

    // `.repo-tour/` is the walk's own bookkeeping and is deliberately outside this comparison:
    // AC2 is about the LEARNER'S files, and `progress.json` moving is the walk working.
    const before = filesUnder(target);
    assert.deepEqual(before, [], 'a freshly built tutorial has none of the project in it yet');

    for (const step of fileSteps(plan)) await goTo(session, step.id);

    assert.deepEqual(filesUnder(target), before, 'manual mode must not write a single file — not even an empty one');
    assert.equal(session.getView()?.dial, 'manual', 'and the position that did nothing is the one the request asked for');
  });

  test('AC2: the panel\'s REAL page carries the shape block — the signature lines and the imports, never a body', async () => {
    const { target, plan } = await newTutorial('manual');
    const { session, panel } = await openWalk(target);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();
    assert.ok(panel.webview, `the step view did not resolve in this host, so ${STEP_VIEW_FOCUS} proves nothing about what is on screen`);

    // `src/app.ts` is the fixture's one module with imports, so it is the step whose shape has
    // both halves to show.
    await goTo(session, fileStepFor(plan, 'src/app.ts').id);
    await settle();

    const html = panel.webview?.html ?? '';
    assert.match(html, new RegExp(SHAPE_HEADING), 'the shape block should be on the page manual mode drew');
    assert.match(html, new RegExp(SHAPE_NOTE_MESSAGE), 'including the line that says what it is NOT');
    assert.ok(
      html.includes("import { add, multiply } from './util.js';"),
      'the reference\'s import line is part of the shape a learner is asked to write',
    );
    assert.ok(
      html.includes('export function compute(a: number, b: number): number {'),
      'and so is the signature line of the load-bearing range',
    );
    assert.equal(
      html.includes('return add(a, b) + multiply(a, b);'),
      false,
      'the BODY is the answer — a shape block that carried it would make manual mode automated with extra steps',
    );
  });
});

// ── AC5: check my work, and the mark it leaves on the tree ────────────────────────────────

suite('a failed check reaches the real tree as a ✗ (AC5)', () => {
  teardown(teardownDial);

  test('AC5: a broken learner file records a failure, names what is missing, and marks the step ✗', async () => {
    const { target, plan } = await newTutorial('manual');
    const step = fileStepFor(plan, 'src/util.ts');
    const other = fileStepFor(plan, 'src/format.js');

    // The learner's own work, deliberately incomplete: `add` is there, `multiply` is not. It
    // PARSES — the interesting AC5 case is a structural miss, not a syntax error.
    writeInto(target, 'src/util.ts', Buffer.from('export function add(a: number, b: number): number {\n  return a + b;\n}\n', 'utf8'));

    const { session, tree, panel } = await openWalk(target);
    await vscode.commands.executeCommand(STEP_VIEW_FOCUS);
    await settle();
    await goTo(session, step.id);

    // The panel's own *Check my work* button, through the real message path.
    panel.dispatchForTest({ type: 'step:check' });
    await session.settled();

    const view = session.getView();
    assert.equal(view?.check?.report.ok, false, 'a file missing an export must not pass the structural check');
    assert.match(view?.check?.summary ?? '', /missing export: multiply/, 'and the sentence has to name it');
    assert.equal(
      progressOf(target, plan).steps[step.id]?.check?.ok,
      false,
      'the verdict is durable — a reload must not forget that this step failed',
    );
    assert.equal(
      progressOf(target, plan).steps[step.id]?.status,
      'pending',
      'a failed check records its verdict against a step that is still PENDING — recording it as done would be the bug',
    );

    assert.match(panel.webview?.html ?? '', new RegExp(CHECK_HEADING), 'the report reaches the page, not just the state');
    assert.match(panel.webview?.html ?? '', /multiply/);

    // Away from the step, so the mark is the icon rather than the current-step arrow — this is
    // what `stepMark` composes and `stepItem` renders, read back off the REGISTERED provider.
    await goTo(session, other.id);
    const failed = itemFor(tree, step.id);
    assert.equal(failed.description, `${step.ordinal} ✗`);
    assert.equal(iconOf(failed), 'error');
    assert.equal(colourOf(failed), 'testing.iconFailed');
    const tooltip = failed.tooltip;
    assert.ok(typeof tooltip === 'string', 'stepItem writes a plain-string tooltip');
    assert.match(tooltip, /check failed/);

    // And the discrimination that makes it mean something: a step nobody has checked shows
    // NEITHER mark. Without this, a tree that painted ✗ on everything would pass above.
    const unchecked = itemFor(tree, orderedSteps(plan).at(-1)!.id);
    assert.equal(unchecked.description, String(orderedSteps(plan).at(-1)!.ordinal), 'an unchecked step carries no verdict at all');
    assert.equal(iconOf(unchecked), 'circle-outline');
    assert.equal(colourOf(unchecked), undefined);
  });

  test('AC5: the learner\'s completed file passes, and the same tree turns to ✓', async () => {
    const { target, plan } = await newTutorial('manual');
    const step = fileStepFor(plan, 'src/util.ts');

    // The whole file this time — with the local variable renamed, which the check must forgive
    // because it is structural by design (spec §4.4).
    writeInto(target, 'src/util.ts', Buffer.from(
      'export function add(first: number, second: number): number {\n'
      + '  return first + second;\n'
      + '}\n'
      + '\n'
      + 'export function multiply(first: number, second: number): number {\n'
      + '  return first * second;\n'
      + '}\n',
      'utf8',
    ));

    const { session, tree, panel } = await openWalk(target);
    await goTo(session, step.id);
    panel.dispatchForTest({ type: 'step:check' });
    await session.settled();

    assert.equal(session.getView()?.check?.report.ok, true, 'a renamed local must still pass — the check is structural');
    assert.equal(progressOf(target, plan).steps[step.id]?.status, 'done', 'and a pass is what marks the step done');

    await goTo(session, orderedSteps(plan)[0]!.id);
    const passed = itemFor(tree, step.id);
    assert.equal(passed.description, `${step.ordinal} ✓`);
    assert.equal(iconOf(passed), 'pass-filled');
    assert.equal(colourOf(passed), 'testing.iconPassed');
  });
});

/** The `TreeItem` the REGISTERED provider would hand VS Code for one step. */
function itemFor(tree: NonNullable<ReturnType<ExtensionApi['_walk']['tree']>>, stepId: string): vscode.TreeItem {
  const node = tree.getChildren()
    .flatMap((chapter) => tree.getChildren(chapter))
    .find((child) => child.kind === 'step' && child.step.id === stepId);
  assert.ok(node, `the tree should contain a step ${stepId}`);
  return tree.getTreeItem(node);
}

function iconOf(item: vscode.TreeItem): string {
  return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : `not a ThemeIcon: ${JSON.stringify(item.iconPath)}`;
}

function colourOf(item: vscode.TreeItem): string | undefined {
  return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.color?.id : undefined;
}

// ── the Overwrite / Keep mine prompt ──────────────────────────────────────────────────────

/**
 * **Driven through `WalkAdapters`, not through the registered session, and here is why.**
 *
 * The shipped `confirmOverwrite` (`src/extension.ts`) is a MODAL `showWarningMessage`. In an
 * Extension Development Host there is nobody to press either button, so the promise the
 * session awaits inside its job chain never settles — `settled()` would never resolve and this
 * suite would hang rather than fail. There is no supported way to answer a modal from a test,
 * and no seam on `_walk` that injects one.
 *
 * So the prompt is driven at the session's own adapter boundary — which is the seam that
 * exists precisely so the rule is testable "with no editor anywhere near it" (see
 * `WalkAdapters.confirmOverwrite`). EVERYTHING ELSE in this adapter set is the real thing: the
 * real `store.ts` load/save, the real plan on a real disk, the real `writer.ts` atomic write,
 * the real repo-tour core, a real reference. What is faked is one button press.
 *
 * `test/unit/walk-session.test.ts` already owns the prompt's full rule (asked on a real
 * difference, asked once per step and file, obeyed afterwards) against fake adapters. What is
 * added here is that the learner's BYTES survive a real write path — the temp-file-and-rename
 * that would destroy them if the answer were ignored.
 */
suite('a learner\'s own edit is not overwritten silently', () => {
  teardown(teardownDial);

  const MINE = 'export function add(a: number, b: number): number {\n  return a + b; // mine, and I meant it\n}\n';

  async function walkWith(target: string, confirm: boolean): Promise<WalkSession> {
    const core = await dialCore();
    const adapters: WalkAdapters = {
      setTree: () => { /* the registered surfaces belong to the registered session */ },
      setPanel: () => { /* … */ },
      setStatus: () => { /* … */ },
      revealEditor: () => { /* no editor is part of this question */ },
      clearEditor: () => { /* … */ },
      openFile: () => { /* … */ },
      fileExists: (absPath) => fs.existsSync(absPath),
      loadPlan,
      loadProgress,
      saveProgress,
      loadRequest,
      reportError: (message) => { assert.fail(`nothing here should have failed: ${message}`); },
      core: () => Promise.resolve(core),
      readText: (absPath) => {
        try {
          return fs.readFileSync(absPath, 'utf8');
        } catch {
          return undefined;
        }
      },
      confirmOverwrite: () => Promise.resolve(confirm),
      git: realGit,
      // The commit is AC7's question and is answered above; keeping it off here keeps this
      // test about the one thing it is about, and out of the machine's git config entirely.
      commitPerStep: () => false,
    };
    const session = WalkSession.open(target, adapters);
    ownSessions.push(session);
    await session.settled();
    return session;
  }

  test('Keep mine leaves the learner\'s bytes exactly as they were, and says so', async () => {
    const { target, plan } = await newTutorial('automated');
    const step = fileStepFor(plan, 'src/util.ts');
    writeInto(target, 'src/util.ts', Buffer.from(MINE, 'utf8'));

    const session = await walkWith(target, false);
    session.goTo(step.id);
    await session.settled();

    assert.equal(fs.readFileSync(path.join(target, 'src/util.ts'), 'utf8'), MINE, 'the learner\'s file must survive untouched');
    assert.match(session.getView()?.writeNote ?? '', /was kept/, 'and the panel has to say that is what happened');
    assert.equal(session.getView()?.step.id, step.id);
  });

  test('Overwrite really does write the reference over it — which is what makes "kept" mean something', async () => {
    const { target, refRoot, plan } = await newTutorial('automated');
    const step = fileStepFor(plan, 'src/util.ts');
    writeInto(target, 'src/util.ts', Buffer.from(MINE, 'utf8'));

    const session = await walkWith(target, true);
    session.goTo(step.id);
    await session.settled();

    assert.ok(
      readBytes(target, 'src/util.ts')?.equals(fs.readFileSync(path.join(refRoot, 'src/util.ts'))),
      'answering Overwrite must leave the reference\'s bytes, not the learner\'s',
    );
    assert.notEqual(fs.readFileSync(path.join(target, 'src/util.ts'), 'utf8'), MINE);
  });
});

// ── T-13: the bound holds inside the extension host, not only under plain node ───────────────

/**
 * `test/unit/build.test.ts` owns this invariant — that no git subprocess is unbounded, that
 * the clone gets minutes and everything else seconds, and what each caller does with a stopped
 * git. None of that needs an extension host and none of it is repeated here.
 *
 * What only a host can answer is whether the option is honoured where the extension actually
 * runs. `realGit` is spawned by ELECTRON's Node, not by the `node` binary the unit suite uses:
 * different runtime, different child-process wiring, and a `timeout` that were silently ignored
 * here would leave the whole fix inert in production while every unit test stayed green. This
 * suite is that one question, asked twice — once for a git that hangs, once for a git that
 * behaves — and nothing else.
 *
 * **What it cannot see:** it does not wait out the real thirty-second bound or the real
 * five-second escalation grace (the seams shorten the WAIT, not the sentence — the literal
 * 30,000 reaching the child is pinned by a spy under plain node), and it says nothing about
 * which tier any call site asks for.
 */
suite('T-13 — a git that never returns is stopped inside the extension host too', () => {
  test('a real hanging `git`, spawned by the host, really ends', async function () {
    this.timeout(15_000);
    // `git hash-object --stdin` reads stdin to EOF and `execFile` never closes the child's,
    // so this runs until something stops it. Before this ticket nothing did — and in the host
    // that meant a learner's button press with no end and no spinner (T-6 finding 5).
    const impatient: ExecFileLike = (file, args, options, callback) =>
      // `Math.min`, not a flat 600: if the runner ever stopped supplying a timeout this would
      // be NaN, and the test would fail rather than quietly proving that `execFile` honours a
      // number the seam put there itself.
      execFile(file, args, { ...options, timeout: Math.min(options.timeout, 600) }, callback);

    const err = await gitRunnerWith(impatient)(['hash-object', '--stdin'], os.tmpdir())
      .then(() => null, (e: unknown) => e);

    assert.ok(err instanceof GitTimeoutError, `expected a GitTimeoutError, got ${String(err)}`);
    assert.equal(err.gitTimedOutAfterMs, GIT_TIMEOUT_MS.short);
    assert.match(err.message, /timed out after 30 seconds and was stopped/);
  });

  test('and a child that ignores SIGTERM is still ended, and still settles, inside the host', async function () {
    if (process.platform === 'win32') { this.skip(); return; }
    this.timeout(15_000);
    // The half `execFile`'s own `timeout` cannot do: it sends one signal and then waits for a
    // `close` that never comes. The escalation is `child.kill('SIGKILL')` plus a settle on the
    // runner's own timer, and both go through the host's child-process wiring rather than
    // plain node's — the same reason this whole suite exists.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-host-stubborn-'));
    const stubborn = path.join(dir, 'stubborn.sh');
    fs.writeFileSync(stubborn, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 0.2; done\n");
    fs.chmodSync(stubborn, 0o755);

    let pid: number | undefined;
    const substitute: ExecFileLike = (_file, _args, options, callback) => {
      const spawned = execFile(stubborn, [], options, callback);
      pid = spawned.pid;
      return spawned;
    };

    const err = await gitRunnerWith(substitute, { boundMs: 400, killGraceMs: 400 })(['commit'], os.tmpdir())
      .then(() => null, (e: unknown) => e);

    assert.ok(err instanceof GitTimeoutError, `the promise must settle in the host too — got ${String(err)}`);
    await new Promise((r) => setTimeout(r, 250));
    let alive = true;
    try { if (pid) process.kill(pid, 0); else alive = false; } catch { alive = false; }
    assert.equal(alive, false, 'and the escalation really reaches the child through the host’s wiring');
  });

  test('and an ordinary git in the host is untouched by the option — the discriminator', async () => {
    // A `timeout` that broke the normal path would be worse than the defect it closes, and the
    // real commits this file makes elsewhere would fail in ways that read as anything but this.
    assert.match(await realGit(['--version'], os.tmpdir()), /^git version /);
  });
});
