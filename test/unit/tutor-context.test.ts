// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `src/tutor/context.ts` — what the tutor is told, asserted through the REAL repo-tour core
 * and the REAL `git` binary, against real temporary directories. AC1's own check is "unit
 * test on the context block contents", and the *block* is the thing under test rather than
 * the object: nothing this module puts in an `AskContext` matters until repo-tour's
 * `buildContextBlock` renders it, and a field this extension fills that repo-tour's persona
 * never prints would pass every assertion about the object and reach no model at all.
 *
 * So the core is loaded the way `dial-check.test.ts` loads it, and every content assertion
 * below reads the rendered block. **No token is spent anywhere in here.** `buildContextBlock`
 * is a string builder; `runLlm` — the only part of repo-tour that talks to a provider — is
 * never reached, imported or stubbed, and nothing in this module's contract could make it.
 *
 * `git` is real for the same reason `dial-commit.test.ts` gives for `commitStep`: the whole
 * point of this module's diff is how honestly it reads git's own answers back, and the answer
 * that matters most is a **non-zero exit**. `git diff --no-index` exits 1 whenever the two
 * files differ — the ordinary case — and `realGit` rejects on that, discarding stdout as it
 * goes. A faked `GitRunner` that resolved with a canned diff would prove only that the module
 * calls its own mock correctly, and would agree just as happily with a version that treated
 * exit 1 as a failure and shipped a tutor that could see a learner's work only when there was
 * nothing to see. One test below therefore pins the premise itself — that real `git` really
 * does reject there — so the day `realGit` changes, this suite says so rather than quietly
 * passing on a mock.
 *
 * Both directions are pinned everywhere it matters, the way T-4's suites are: each of the
 * three answers that produce NO diff — nothing written, nothing different, a path that leaves
 * its tree — is paired with the nearly identical case that must still produce one. Without
 * those pairs, a module that returned `undefined` for everything would be green.
 *
 * The clip is checked against git rather than against itself: `rawDiff` below measures what
 * git really produces, from the same directory and with the same relative names the module
 * uses, so "the whole diff is N bytes" is verified as a fact rather than as an echo.
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { realGit, type GitRunner } from '../../src/start/build.js';
import { tutorCoreFor, type TutorCore } from '../../src/tutor/core.js';
import {
  MAX_DIFF_CHARS,
  NO_DIFFERENCE,
  NO_FILE_YET,
  clipMarker,
  renderOptionsText,
  tutorContext,
} from '../../src/tutor/context.js';
import type { PlanLike, StepLike } from '../../src/walk/model.js';
import { fixturePlan, writeFixtureTarget } from './walk-fixtures.js';

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

/** The fixture's three-option step (`whySource: 'interpret'`) — the only one that can show an
 *  author's road AND alternatives at once, which is most of what this module renders. */
const RENDER = 'src/api/render.ts';
/** The fixture's one-option step, and the only one whose `why` really is a docstring. */
const ROUTES = 'src/api/routes.ts';

let core: TutorCore;
let plan: PlanLike;
/** Holds BOTH roots, so a `../` step has somewhere real to point — and it is also the deepest
 *  directory the two roots share, which is where the module runs `git` from. */
let box: string;
let refRoot: string;
let target: string;

const madeDirs: string[] = [];

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(CORE_ROOT);
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  core = tutorCoreFor(loaded.loaded);

  plan = fixturePlan();
  box = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-tutor-context-'));
  madeDirs.push(box);
  refRoot = path.join(box, 'reference');
  target = path.join(box, 'learner');
  fs.mkdirSync(refRoot, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  writeFixtureTarget(refRoot);
});

/** The learner starts every test from a byte-identical copy of the reference, then edits it,
 *  so what any one test proves is the effect of ITS edit and nothing left over from another. */
setup(() => {
  writeFixtureTarget(target);
});

suiteTeardown(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function stepById(id: string): StepLike {
  const step = plan.steps.find((s) => s.id === id);
  assert.ok(step, `the fixture plan should contain a step ${id}`);
  return step;
}

/** A step for a file the fixture plan does not describe — this module reads exactly one thing
 *  off a step to find the two files, `target.file`, whatever kind of step asked. */
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

/** `n` distinct lines, so every one of them shows up in the diff as its own `+` line. */
function longSource(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `export const value${i} = ${i};`).join('\n')}\n`;
}

/**
 * What `git` really produces for `rel` across the two trees, and how many bytes of it there
 * are — measured here, independently of the module under test.
 *
 * Run from `box` with names relative to it because that is what the module does: `box` is the
 * deepest directory the two roots share, and git echoes the names it was handed straight into
 * the `diff --git a/… b/…` header, so a measurement taken with absolute paths would produce a
 * different header, different bytes, and a "clipped" assertion that agreed with nothing.
 */
async function rawDiff(rel: string): Promise<{ text: string; bytes: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tutorials-tutor-raw-'));
  madeDirs.push(dir);
  const out = path.join(dir, 'raw.diff');
  try {
    await realGit(
      ['diff', '--no-index', `--output=${out}`, '--', path.join('reference', rel), path.join('learner', rel)],
      box,
    );
  } catch {
    // Exit 1 — they differ. Every caller of this helper is here for exactly that case.
  }
  return { text: fs.readFileSync(out, 'utf8'), bytes: fs.statSync(out).size };
}

async function blockFor(step: StepLike): Promise<string> {
  return core.buildContextBlock(await tutorContext(step, refRoot, target, realGit));
}

// ── the block itself (AC1) ──────────────────────────────────────────────────────────────────

suite('the context block — everything the tutor is told about the step', () => {
  test('it carries the question, the road taken, an alternative, the why with its source, and the diff', async () => {
    write(target, RENDER, fs.readFileSync(path.join(refRoot, RENDER), 'utf8').replace("'<pre>'", "'<div>'"));
    const step = stepById('st-4-symbol-render');
    const block = await blockFor(step);

    assert.ok(block.includes(step.decision.question), `the question itself is missing:\n${block}`);
    assert.ok(
      block.includes('[author] What the author did — The answer is wrapped in a <pre> block, so nothing needs escaping rules yet.'),
      `the road the author took is not marked as the author's:\n${block}`,
    );
    assert.ok(
      block.includes('[alternative] Build the markup with a template string — Shorter, but every future field has to remember to escape itself.'),
      `an alternative is not marked as one:\n${block}`,
    );
    assert.ok(block.includes(step.decision.why), `the why is missing:\n${block}`);
    assert.ok(
      block.includes('from the model, reading the code'),
      `the why arrived without its source, so the tutor cannot tell an inference from the author:\n${block}`,
    );
    assert.ok(block.includes("+    '<div>',"), `the learner's own edit is not in the block:\n${block}`);
    assert.ok(block.includes("-    '<pre>',"), `the author's line is not in the block:\n${block}`);
    assert.ok(block.includes('Repository: reference'), `the reference repository is not named:\n${block}`);
    assert.ok(block.includes(`File on screen: ${RENDER}`), `the file is not named by its relative path:\n${block}`);
  });

  test('the author’s road and the alternatives are marked distinguishably, and only one is the author’s', () => {
    const text = renderOptionsText(stepById('st-4-symbol-render'));
    const lines = text.split('\n');
    assert.equal(lines.length, 3, `one line per option:\n${text}`);
    assert.equal(lines.filter((l) => l.startsWith('[author] ')).length, 1, text);
    assert.equal(lines.filter((l) => l.startsWith('[alternative] ')).length, 2, text);
    assert.ok(lines[0]?.startsWith('[author] What the author did — '), text);
  });

  test('the three why-sources read as three different things — the author, a model, or nobody', async () => {
    // A docstring `why` really is the author's own sentence; an `interpret` one is a guess
    // about them. Telling a learner the second in the voice of the first is the failure this
    // field exists to prevent, so all three labels are pinned, not just the interesting one.
    assert.ok((await blockFor(stepById('st-3-symbol-handle'))).includes("from the author's own comment"));
    assert.ok((await blockFor(stepById('st-2-file-parse'))).includes('from the model, reading the code'));
    assert.ok((await blockFor(stepById('st-1-shape-src'))).includes('not inferable from the source'));
  });

  test('what the page is showing and the structured decision agree with each other', async () => {
    // `stopText` is the panel's half and `build.options` the structured half; they are two
    // renderings of one set of options inside a single prompt, and a model handed two that
    // disagreed about which road was taken would have no way to choose between them.
    const step = stepById('st-4-symbol-render');
    const ctx = await tutorContext(step, refRoot, target, realGit);
    assert.equal(ctx.stopTitle, step.decision.question);
    assert.equal(ctx.stopText, renderOptionsText(step));
    assert.deepEqual(
      ctx.build?.options.map((o) => o.taken),
      [true, false, false],
    );
    assert.deepEqual(
      ctx.build?.options.map((o) => `[${o.taken ? 'author' : 'alternative'}] ${o.label} — ${o.consequence}`).join('\n'),
      ctx.stopText,
    );
  });
});

// ── the diff: exit code 1 is the answer, not a failure ──────────────────────────────────────

suite('learnerDiff — git’s exit code 1 means “they differ”, and that is the ordinary case', () => {
  test('the premise: real `git diff --no-index` REJECTS through realGit on files that differ', async () => {
    // The whole module is built around this. Pinned here so that a change to `realGit` — or a
    // git that one day stopped implying --exit-code — fails a test with a sentence on it
    // rather than silently emptying every tutor prompt in the extension.
    write(target, RENDER, 'export function render(): string {\n  return "";\n}\n');
    await assert.rejects(
      () => realGit(['diff', '--no-index', '--', path.join(refRoot, RENDER), path.join(target, RENDER)]),
      'git is expected to exit non-zero when the two files differ',
    );
    await assert.doesNotReject(
      () => realGit(['diff', '--no-index', '--', path.join(refRoot, ROUTES), path.join(target, ROUTES)]),
      'and to exit zero when they do not — otherwise the test above proves nothing about "differ"',
    );
  });

  test('a file the learner has edited comes back as git’s own diff, byte for byte', async () => {
    write(target, RENDER, fs.readFileSync(path.join(refRoot, RENDER), 'utf8').replace("'<pre>'", "'<div>'"));
    const ctx = await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit);
    const raw = await rawDiff(RENDER);

    assert.ok(raw.text.length > 0, 'the edit has to actually change the file, or this test proves nothing');
    assert.equal(ctx.build?.learnerDiff, raw.text);
    assert.ok(
      raw.text.includes(`a/${path.join('reference', RENDER)}`),
      `the diff should name the two trees by short relative paths, never by the learner’s home directory:\n${raw.text}`,
    );
  });

  test('an untouched copy of the author’s file is a sentence, never an empty diff', async () => {
    // git's own answer here is the empty string, which `buildContextBlock` drops entirely —
    // leaving a tutor unable to tell a perfect reproduction from a question it was given no
    // material for. The pair below is the point: identical says so, edited diffs.
    const identical = await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit);
    assert.equal(identical.build?.learnerDiff, NO_DIFFERENCE);
    assert.ok((await blockFor(stepById('st-4-symbol-render'))).includes(NO_DIFFERENCE));

    write(target, RENDER, `${fs.readFileSync(path.join(refRoot, RENDER), 'utf8')}\nexport const extra = 1;\n`);
    const edited = await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit);
    assert.ok(edited.build?.learnerDiff?.startsWith('diff --git '), edited.build?.learnerDiff);
  });

  test('a file the learner has not created yet says so in plain words — manual mode’s ordinary state', async () => {
    fs.rmSync(path.join(target, RENDER));
    assert.ok((await blockFor(stepById('st-4-symbol-render'))).includes(NO_FILE_YET));

    writeFixtureTarget(target);
    const written = await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit);
    assert.notEqual(written.build?.learnerDiff, NO_FILE_YET, 'the same step must stop saying that once the file is there');
  });

  test('a `shape` step, whose target is a whole directory, still gets a diff', async () => {
    // repo-tour's real plans open on one of these. Both trees have `src`; deleting a file from
    // the learner's makes the directory diff non-empty and says which file is missing, which
    // is exactly what a learner stuck on "what goes in here" needs the tutor to know.
    fs.rmSync(path.join(target, 'src/parse.ts'));
    const diff = (await tutorContext(stepById('st-1-shape-src'), refRoot, target, realGit)).build?.learnerDiff;
    assert.ok(diff?.includes('src/parse.ts'), diff);
  });

  test('a runner that ignores --output and resolves with the diff on stdout still works', async () => {
    // The shape a hand-written fake naturally takes. `realGit` throws stdout away on a non-zero
    // exit, which is why this module asks git for a file; a runner that does neither must not
    // be the one case that produces no diff at all.
    const canned = 'diff --git a/reference/x b/learner/x\n@@ -1 +1 @@\n-author\n+learner\n';
    const stdoutOnly: GitRunner = async () => Promise.resolve(canned);
    const ctx = await tutorContext(stepById('st-4-symbol-render'), refRoot, target, stdoutOnly);
    assert.equal(ctx.build?.learnerDiff, canned);
  });

  test('a git that fails outright leaves the diff out rather than throwing out of the ask', async () => {
    const broken: GitRunner = () => Promise.reject(new Error('git diff --no-index failed: not a thing'));
    const ctx = await tutorContext(stepById('st-4-symbol-render'), refRoot, target, broken);
    assert.equal(ctx.build?.learnerDiff, undefined);
    assert.ok(ctx.build?.question, 'and the rest of the context is still built — the step is still answerable');
    assert.ok(!core.buildContextBlock(ctx).includes('diff --git '), 'nothing diff-shaped should reach the block');
  });
});

// ── the clip: a reply is billed by the token ────────────────────────────────────────────────

suite('learnerDiff — the clip, because an unbounded diff is the learner’s money', () => {
  test('a diff that fits is sent whole, with nothing appended to it', async () => {
    write(target, RENDER, fs.readFileSync(path.join(refRoot, RENDER), 'utf8').replace("'<pre>'", "'<div>'"));
    const diff = (await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit)).build?.learnerDiff;
    const raw = await rawDiff(RENDER);
    assert.ok(raw.bytes < MAX_DIFF_CHARS, 'this fixture edit has to fit, or the test below has no opposite');
    assert.equal(diff, raw.text);
    assert.ok(!diff?.includes(clipMarker(raw.bytes)), 'a diff that fits must not claim to be clipped');
  });

  test('a diff too big for the budget announces itself, with git’s own byte count in it', async () => {
    write(target, RENDER, longSource(500));
    const raw = await rawDiff(RENDER);
    assert.ok(raw.bytes > MAX_DIFF_CHARS, `the fixture must overflow the budget: ${raw.bytes}`);

    const diff = (await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit)).build?.learnerDiff;
    assert.ok(diff);
    assert.ok(diff.length <= MAX_DIFF_CHARS, `${diff.length} characters were sent against a budget of ${MAX_DIFF_CHARS}`);
    assert.ok(diff.startsWith('diff --git '), 'the beginning of the diff is what survives, not the end');
    assert.ok(diff.endsWith(clipMarker(raw.bytes)), `the clip must say so, with the real size:\n${diff.slice(-200)}`);
  });

  test('the announcement survives repo-tour’s own clip, which is the entire reason for the number', async () => {
    // `buildContextBlock` clips this field at 8,000 with a bare `… (truncated)` of its own.
    // Anything longer than that leaving here is billed to the learner, never reaches the
    // model, and takes our marker with it — so the marker still being in the RENDERED block
    // is the proof that the two caps do not fight.
    write(target, RENDER, longSource(500));
    const raw = await rawDiff(RENDER);
    const block = await blockFor(stepById('st-4-symbol-render'));
    assert.ok(block.includes(clipMarker(raw.bytes)), `repo-tour re-clipped the diff and cut our marker off:\n${block.slice(-400)}`);
  });

  test('a diff far larger than anything worth reading is still measured honestly', async () => {
    // Past the point where the whole answer is pulled into memory at all: only a bounded
    // prefix is read, and the size it reports is still git's real one rather than the size of
    // the prefix. A version that reported what it had read would understate it by 100 times.
    write(target, RENDER, longSource(20000));
    const raw = await rawDiff(RENDER);
    assert.ok(raw.bytes > MAX_DIFF_CHARS * 4, `the fixture must exceed the read ceiling: ${raw.bytes}`);

    const diff = (await tutorContext(stepById('st-4-symbol-render'), refRoot, target, realGit)).build?.learnerDiff;
    assert.ok(diff);
    assert.ok(diff.length <= MAX_DIFF_CHARS, `${diff.length} characters`);
    assert.ok(diff.endsWith(clipMarker(raw.bytes)), diff.slice(-200));
  });
});

// ── containment: what is read here is sent to somebody else, and billed ─────────────────────

suite('learnerDiff — a path that leaves its tree yields no diff, never a throw', () => {
  test('a `..` path and an absolute one are both refused, though the file they name really exists', async () => {
    // `<box>/outside.ts` sits one level above BOTH roots, so containment — not absence — is the
    // only thing that can refuse it. `path.join(target, '../outside.ts')` would have opened it
    // happily and put its contents in a prompt somebody pays a model to read.
    fs.writeFileSync(path.join(box, 'outside.ts'), 'export const secret = 1;\n');
    assert.equal((await tutorContext(stepFor('../outside.ts'), refRoot, target, realGit)).build?.learnerDiff, undefined);
    assert.equal((await tutorContext(stepFor(path.join(box, 'outside.ts')), refRoot, target, realGit)).build?.learnerDiff, undefined);
    assert.ok(fs.existsSync(path.join(box, 'outside.ts')), 'the refusal must not be "no such file"');

    writeBoth('inside.ts', 'export const control = 1;\n');
    write(target, 'inside.ts', 'export const control = 2;\n');
    const contained = await tutorContext(stepFor('inside.ts'), refRoot, target, realGit);
    assert.ok(contained.build?.learnerDiff?.startsWith('diff --git '), 'the same bytes at a contained path are diffed normally');
  });

  test('a path that stays inside as a string but leaves through a symlink is refused too', async () => {
    // The half `resolveInsideTarget` says out loud it cannot do. A repository can commit a
    // directory symlink and git recreates it on clone, so it costs an attacker nothing — and
    // the payload here is not an overwritten file, it is a file's contents in somebody else's
    // prompt, paid for by the learner.
    //
    // The REFERENCE half of this pair is set up first and left alone throughout, so the
    // refusal below can only come from the link. Without it both files exist, both differ, and
    // git would happily produce a diff of a file that lives outside the learner's folder —
    // which is precisely the difference between this test passing and passing vacuously.
    write(refRoot, 'vendor/keys.ts', 'export const key = "the author’s";\n');
    const away = path.join(box, 'away');
    fs.mkdirSync(away, { recursive: true });
    fs.writeFileSync(path.join(away, 'keys.ts'), 'export const key = "private";\n');
    const link = path.join(target, 'vendor');
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(away, link, 'dir');
    assert.ok(fs.existsSync(path.join(target, 'vendor/keys.ts')), 'the link has to actually resolve, or this proves nothing');

    const escaped = await tutorContext(stepFor('vendor/keys.ts'), refRoot, target, realGit);
    assert.equal(escaped.build?.learnerDiff, undefined);

    // The same relative path, the same two contents, reached without the link: a normal diff.
    fs.rmSync(link);
    write(target, 'vendor/keys.ts', 'export const key = "private";\n');
    const contained = await tutorContext(stepFor('vendor/keys.ts'), refRoot, target, realGit);
    assert.ok(contained.build?.learnerDiff?.includes('+export const key = "private";'), contained.build?.learnerDiff);
  });
});

// ── what a plan can get wrong ───────────────────────────────────────────────────────────────

suite('renderOptionsText — a plan is parsed, not trusted', () => {
  function withDecision(overrides: Partial<StepLike['decision']>): StepLike {
    const step = stepById('st-4-symbol-render');
    return { ...step, decision: { ...step.decision, ...overrides } };
  }

  test('when no option carries `taken`, the author’s road is found through authorChoice', () => {
    const step = stepById('st-4-symbol-render');
    const text = renderOptionsText(withDecision({ options: step.decision.options.map((o) => ({ ...o, taken: false })) }));
    assert.equal(text.split('\n').filter((l) => l.startsWith('[author] ')).length, 1, text);
    assert.ok(text.startsWith('[author] What the author did — '), text);
  });

  test('when nothing at all says which road was taken, nothing is marked as the author’s', () => {
    const step = stepById('st-4-symbol-render');
    const text = renderOptionsText(
      withDecision({ options: step.decision.options.map((o) => ({ ...o, taken: false })), authorChoice: 'nobody' }),
    );
    assert.ok(!text.includes('[author] '), `an honest "we do not know" beats the author's name on someone else's idea:\n${text}`);
    assert.equal(text.split('\n').length, 3, text);
  });

  test('a whySource the panel has no words for is named as such, not guessed at', async () => {
    const step = { ...stepById('st-4-symbol-render'), decision: { ...stepById('st-4-symbol-render').decision, whySource: 'constructor' } } as unknown as StepLike;
    const block = core.buildContextBlock(await tutorContext(step, refRoot, target, realGit));
    assert.ok(!block.includes("from the author's own comment"), block);
    assert.ok(!block.includes('from the model, reading the code'), block);
    assert.ok(block.includes("this plan names a source we don't recognise"), block);
  });

  test('a step with no options at all still produces a context, just without them', async () => {
    assert.equal(renderOptionsText(stepFor('inside.ts')), '');
    const ctx = await tutorContext(stepFor(RENDER), refRoot, target, realGit);
    assert.deepEqual(ctx.build?.options, []);
    assert.ok(core.buildContextBlock(ctx).includes('--- THE BUILD STEP ---'));
  });
});
