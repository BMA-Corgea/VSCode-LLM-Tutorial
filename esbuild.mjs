// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundles this extension's OWN code to CommonJS. repo-tour is never bundled here — see
 * `src/core.ts` — because it must stay loadable via dynamic `import()` for its
 * `import.meta.url` asset lookups (skins, grammar paths) to keep resolving correctly.
 *
 * Twelve entry points (eleven fixed, plus one per `test/unit/*.test.ts` file), all CJS /
 * platform:node, so a plain `require()` or dynamic `import()` of the output works the same
 * inside the extension host and outside it:
 *   - src/extension.ts        -> dist/extension.js            (external: vscode, repo-tour) — the extension
 *   - src/start/build-worker.ts -> dist/build-worker.js        (external: repo-tour)         — the build's digest and buildPlan, off the host's thread (T-30)
 *   - src/doctor.ts           -> dist/doctor.js                (external: repo-tour)         — for build-tutorials' CLI doctor, no vscode needed
 *   - src/publish/index.ts    -> dist/publish.js               (no externals)                — the packaging + publish decision logic, for scripts/{package,publish}.mjs
 *   - test/extension.test.ts  -> dist/test/extension.test.js   (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/start.test.ts      -> dist/test/start.test.js       (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/walk.test.ts       -> dist/test/walk.test.js        (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/dial.test.ts       -> dist/test/dial.test.js        (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/tutor.test.ts      -> dist/test/tutor.test.js       (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/detour.test.ts     -> dist/test/detour.test.js      (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/build-off-thread.test.ts -> dist/test/build-off-thread.test.js (external: vscode, repo-tour, mocha) — vscode-test
 *   - test/start-screen.test.ts -> dist/test/screen/start-screen.test.js (external: vscode, repo-tour, mocha) — vscode-test's
 *     "screen" host, the only one launched with a DevTools port (T-15; see .vscode-test.mjs)
 *   - test/unit/*.test.ts     -> dist/test/unit/*.js           (external: repo-tour, mocha)  — plain mocha, no vscode
 *
 * The unit/vscode-test split is a directory split on purpose: `.vscode-test.mjs`'s own
 * `files` glob is non-recursive (`dist/test/*.test.js`) so it picks up the five vscode-test
 * files here but never wanders into `dist/test/unit/`, and `npm run test:unit` points
 * `mocha` at exactly that subdirectory. A file that imports `vscode` belongs at the top
 * level of `test/`; a file that must never need an extension host belongs in `test/unit/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

const unitTestDir = 'test/unit';
const unitEntryPoints = fs.existsSync(unitTestDir)
  ? fs.readdirSync(unitTestDir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(unitTestDir, f))
  : [];

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode', 'repo-tour'],
  },
  {
    ...shared,
    entryPoints: ['src/start/build-worker.ts'],
    outfile: 'dist/build-worker.js',
    external: ['repo-tour'],
  },
  {
    ...shared,
    entryPoints: ['src/doctor.ts'],
    outfile: 'dist/doctor.js',
    external: ['repo-tour'],
  },
  {
    ...shared,
    entryPoints: ['src/publish/index.ts'],
    outfile: 'dist/publish.js',
  },
  {
    ...shared,
    entryPoints: ['test/extension.test.ts'],
    outfile: 'dist/test/extension.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/start.test.ts'],
    outfile: 'dist/test/start.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/walk.test.ts'],
    outfile: 'dist/test/walk.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/dial.test.ts'],
    outfile: 'dist/test/dial.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/tutor.test.ts'],
    outfile: 'dist/test/tutor.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/detour.test.ts'],
    outfile: 'dist/test/detour.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/build-off-thread.test.ts'],
    outfile: 'dist/test/build-off-thread.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  {
    ...shared,
    entryPoints: ['test/start-screen.test.ts'],
    outfile: 'dist/test/screen/start-screen.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
  ...(unitEntryPoints.length > 0
    ? [
        {
          ...shared,
          entryPoints: unitEntryPoints,
          outdir: 'dist/test/unit',
          external: ['repo-tour', 'mocha'],
        },
      ]
    : []),
];

if (watch) {
  const contexts = await Promise.all(builds.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('esbuild watching (extension, doctor, tests)…');
} else {
  await Promise.all(builds.map((opts) => esbuild.build(opts)));
}
