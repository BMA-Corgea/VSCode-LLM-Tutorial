// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundles this extension's OWN code to CommonJS. repo-tour is never bundled here — see
 * `src/core.ts` — because it must stay loadable via dynamic `import()` for its
 * `import.meta.url` asset lookups (skins, grammar paths) to keep resolving correctly.
 *
 * Three entry points, all CJS / platform:node, so a plain `require()` or dynamic `import()`
 * of the output works the same inside the extension host and outside it:
 *   - src/extension.ts        -> dist/extension.js       (external: vscode, repo-tour) — the extension
 *   - src/doctor.ts           -> dist/doctor.js           (external: repo-tour)         — for build-tutorials' CLI doctor, no vscode needed
 *   - test/extension.test.ts  -> dist/test/extension.test.js (external: vscode, repo-tour, mocha)
 */
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

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode', 'repo-tour'],
  },
  {
    ...shared,
    entryPoints: ['src/doctor.ts'],
    outfile: 'dist/doctor.js',
    external: ['repo-tour'],
  },
  {
    ...shared,
    entryPoints: ['test/extension.test.ts'],
    outfile: 'dist/test/extension.test.js',
    external: ['vscode', 'repo-tour', 'mocha'],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('esbuild watching (extension, doctor, tests)…');
} else {
  await Promise.all(builds.map((opts) => esbuild.build(opts)));
}
