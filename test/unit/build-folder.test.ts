// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-91: the Start build never writes, removes or reads its own files through a link.
 *
 * Everything the build keeps lives in `<target>/.repo-tour/build/`: the write-ahead marker, `request.json`, `plan.json`.
 * A repository can ship a `.repo-tour/` of its own and git recreates a link on clone, so either folder can be a link
 * by the time a build writes there; a write through it lands wherever it points (T-22's security review, F1, for the
 * walk's own writers). Each test plants a link to an OUTSIDE folder and checks that folder afterwards, byte for byte.
 * The learner's folder itself may be a link: that one is theirs, and the last test builds through one.
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, resolveCoreRoot } from '../../src/core.js';
import {
  buildDir, buildFromRequest, coreFor, markerPath, readFreshMarker, readMarker, realFsWriteOps, resumeIfMarked,
  type BuildContext, type BuildCore, type FsWriteOps,
} from '../../src/start/build.js';
import { emptyRequest, type BuildRequest } from '../../src/start/request.js';

let realCore: BuildCore;

suiteSetup(async () => {
  const core = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
  assert.equal(core.found, true, core.reason ?? 'repo-tour should be found at the sibling checkout');
  realCore = coreFor(core.loaded);
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tsFixture(): string {
  const root = tmp('t91-ref-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), "import { add } from './util.js';\n\nexport function twice(a: number): number {\n  return add(a, a);\n}\n");
  return root;
}

function context(more: Partial<BuildContext> = {}): BuildContext {
  return { core: realCore, globalStorageRoot: tmp('t91-storage-'), provider: 'claude', model: 'claude-haiku-4-5-20251001', cachedOnly: true, ...more };
}

function requestFor(repo: string, target: string): BuildRequest {
  return { ...emptyRequest(), recreate: true, repo, target };
}

/** Every path under `root` with its bytes: what "left exactly as it was" compares. */
function contents(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(`${path.relative(root, p)}/`); walk(p); } else out.push(`${path.relative(root, p)} ${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(root);
  return out;
}

/** Another build's files, where the planted link points: its marker, its request, an atomic write's temp file. */
function someoneElses(dir: string, request: BuildRequest): void {
  fs.mkdirSync(dir, { recursive: true });
  const marker = { startedAt: new Date(Date.now() - 60_000).toISOString(), phase: 'interpret', request, id: 'elsewhere', endedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'building.json'), JSON.stringify(marker));
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
  fs.writeFileSync(path.join(dir, 'plan.json.0123456789ab.tmp'), '{');
}

const refused = (p: string): string => `${p} is a link to somewhere else, so this build writes nothing through it — pick an empty or new folder`;

suite('T-91: the Start build never writes, removes or reads its files through a link', () => {
  test('a target whose .repo-tour is a link: refused in a sentence, and nothing is written where it points', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    fs.symlinkSync(outside, path.join(target, '.repo-tour'));
    const outcome = await buildFromRequest(requestFor(tsFixture(), target), context());
    assert.deepEqual(contents(outside), [], 'the build wrote through the linked .repo-tour');
    assert.equal(outcome.reason, refused(path.join(target, '.repo-tour')));
    assert.equal(outcome.ok, false);
  });

  test('a target whose .repo-tour/build is a link: the same', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    fs.mkdirSync(path.join(target, '.repo-tour'));
    fs.symlinkSync(outside, buildDir(target));
    const outcome = await buildFromRequest(requestFor(tsFixture(), target), context());
    assert.deepEqual(contents(outside), [], 'the build wrote through the linked .repo-tour/build');
    assert.equal(outcome.reason, refused(buildDir(target)));
  });

  test('a link that leads nowhere is refused too, and nothing is made at its end', async () => {
    const target = tmp('t91-target-');
    const nowhere = path.join(tmp('t91-outside-'), 'not-yet');
    fs.symlinkSync(nowhere, path.join(target, '.repo-tour'));
    const outcome = await buildFromRequest(requestFor(tsFixture(), target), context()).catch((err: Error) => ({ ok: false, reason: `threw: ${err.message}` }));
    assert.equal(fs.existsSync(nowhere), false, 'the build made a folder at the end of a dangling link');
    assert.equal(outcome.reason, refused(path.join(target, '.repo-tour')));
  });

  test('a .repo-tour that is a file is refused in a sentence, not an ENOTDIR', async () => {
    const target = tmp('t91-target-');
    fs.writeFileSync(path.join(target, '.repo-tour'), 'not a folder');
    const outcome = await buildFromRequest(requestFor(tsFixture(), target), context()).catch((err: Error) => ({ ok: false, reason: `threw: ${err.message}` }));
    assert.equal(outcome.reason, `${path.join(target, '.repo-tour')} is not a folder, so this build writes nothing there — pick an empty or new folder`);
    assert.equal(fs.readFileSync(path.join(target, '.repo-tour'), 'utf8'), 'not a folder');
  });

  test('a link swapped in mid-build, this build\'s marker copied through it, is not written through: the build stops', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    const request = requestFor(tsFixture(), target);
    let before: string[] = [];
    const core: BuildCore = {
      ...realCore,
      digest: (...args) => {
        // As the read runs: the build folder moves away, and a link takes its name, holding a copy of the marker.
        fs.cpSync(buildDir(target), outside, { recursive: true });
        fs.renameSync(buildDir(target), path.join(target, '.repo-tour', 'moved'));
        fs.symlinkSync(outside, buildDir(target));
        before = contents(outside);
        return realCore.digest(...args);
      },
    };
    const outcome = await buildFromRequest(request, context({ core }));
    assert.ok(before.length > 0, 'the fixture has to swap the link in during the read');
    assert.deepEqual(contents(outside), before, 'the build went on writing through the link swapped in for its folder');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, `${buildDir(target)} became a link to somewhere else while this build was running — it stopped and wrote nothing more; pick an empty or new folder`);
  });

  test('a link swapped in as the plan is about to be written: neither the request nor the plan goes through it', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    let before: string[] = [];
    const swapAtTheWrite: FsWriteOps = {
      ...realFsWriteOps,
      renameSync: (from, to) => {
        realFsWriteOps.renameSync(from, to);
        // Right after the marker says "write": the folder moves away, and a link holding a copy takes its name.
        if (before.length === 0 && to === markerPath(target) && (JSON.parse(fs.readFileSync(to, 'utf8')) as { phase?: string }).phase === 'write') {
          fs.cpSync(buildDir(target), outside, { recursive: true });
          fs.renameSync(buildDir(target), path.join(target, '.repo-tour', 'moved'));
          fs.symlinkSync(outside, buildDir(target));
          before = contents(outside);
        }
      },
    };
    const outcome = await buildFromRequest(requestFor(tsFixture(), target), context({ writeOps: swapAtTheWrite }));
    assert.ok(before.length > 0, 'the fixture has to swap the link in as the write begins');
    assert.deepEqual(contents(outside), before, 'the request or the plan was written through the link');
    assert.equal(outcome.reason, refused(buildDir(target)));
  });

  test('a link the lstat does not see (one swapped in just after it) is caught by where the folder resolves', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    fs.mkdirSync(path.join(target, '.repo-tour'));
    fs.symlinkSync(outside, buildDir(target));
    // The lstat of the build folder answers for the folder the link points at, as if the link came a moment later.
    const mutable = fs as unknown as { lstatSync: typeof fs.lstatSync };
    const realLstat = mutable.lstatSync;
    mutable.lstatSync = ((p: fs.PathLike, opts?: fs.StatSyncOptions) => realLstat(String(p) === buildDir(target) ? outside : p, opts)) as typeof fs.lstatSync;
    let outcome;
    try {
      assert.equal(fs.lstatSync(buildDir(target)).isSymbolicLink(), false, 'the fixture has to hide the link from the lstat');
      outcome = await buildFromRequest(requestFor(tsFixture(), target), context());
    } finally {
      mutable.lstatSync = realLstat;
    }
    assert.deepEqual(contents(outside), [], 'the build wrote through a link it took for a folder');
    assert.equal(outcome.reason, refused(buildDir(target)));
  });

  test('a Cancel over a linked .repo-tour removes nothing where it points: another build\'s marker, request and temp file stay', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    const request = requestFor(tsFixture(), target);
    someoneElses(path.join(outside, 'build'), request);
    fs.symlinkSync(outside, path.join(target, '.repo-tour'));
    const before = contents(outside);
    const outcome = await buildFromRequest(request, context({ isCancelled: () => true }));
    assert.deepEqual(contents(outside), before, 'the Cancel removed files through the linked .repo-tour');
    assert.equal(outcome.ok, false);
  });

  test('the reload offers nothing it reads through a link, and touches nothing there', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    const request = requestFor(tsFixture(), target);
    someoneElses(path.join(outside, 'build'), request);
    fs.symlinkSync(outside, path.join(target, '.repo-tour'));
    const before = contents(outside);
    assert.equal(readMarker(target), null, 'a marker read through a link was taken for this folder\'s own');
    assert.equal(readFreshMarker(target), null);
    let asked = 0;
    const outcome = await resumeIfMarked(target, { ...context(), confirm: () => { asked += 1; return Promise.resolve('Discard'); } });
    assert.equal(asked, 0, 'the reload offered to resume or discard a build it read through a link');
    assert.equal(outcome, undefined);
    assert.deepEqual(contents(outside), before);
  });

  test('a marker that is itself a link is no marker: nothing is offered, nothing is read through it', async () => {
    const target = tmp('t91-target-');
    const outside = tmp('t91-outside-');
    const request = requestFor(tsFixture(), target);
    someoneElses(outside, request);
    fs.mkdirSync(buildDir(target), { recursive: true });
    fs.symlinkSync(path.join(outside, 'building.json'), markerPath(target));
    assert.equal(readMarker(target), null, 'a marker file that is a link was read');
    let asked = 0;
    await resumeIfMarked(target, { ...context(), confirm: () => { asked += 1; return Promise.resolve('Discard'); } });
    assert.equal(asked, 0);
    assert.equal(fs.existsSync(path.join(outside, 'building.json')), true);
  });

  test('the digest is told a cache folder nobody could have planted: a fresh name each build', async () => {
    const seen: string[] = [];
    const core: BuildCore = { ...realCore, digest: (root, opts, control) => { seen.push(String((opts as { outDir?: unknown }).outDir)); return realCore.digest(root, opts, control); } };
    for (let i = 0; i < 2; i++) {
      const target = tmp('t91-target-');
      const outcome = await buildFromRequest(requestFor(tsFixture(), target), context({ core }));
      assert.equal(outcome.ok, true, outcome.reason);
    }
    assert.equal(seen.length, 2);
    for (const outDir of seen) assert.match(path.basename(outDir), /^no-digest-cache-[0-9a-f]{12}$/, `a cache path a repository could plant a link at: ${outDir}`);
    assert.notEqual(path.basename(seen[0]!), path.basename(seen[1]!));
  });

  test('the learner\'s own folder may be a link: a build through it works, and its files are where it points', async () => {
    const real = tmp('t91-real-');
    const linkedTarget = path.join(tmp('t91-links-'), 'my-tutorial');
    fs.symlinkSync(real, linkedTarget);
    const outcome = await buildFromRequest(requestFor(tsFixture(), linkedTarget), context());
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(fs.existsSync(path.join(real, '.repo-tour', 'build', 'plan.json')), true);
    assert.equal(readMarker(linkedTarget), null, 'the marker goes on success');
  });
});
