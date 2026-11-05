// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The DevTools port that lets vscode-test read the screen (T-15) is for the test host ONLY.
 *
 * `.vscode-test.mjs` launches the test host with `--remote-debugging-port=0`. A debugging port in
 * the SHIPPED extension would let any local process drive a learner's editor, so this pins the two
 * things that keep it out: nothing that ships names the flag, and `.vscodeignore` keeps the test
 * config and the test sources out of the package. (Checked by reading the files that ship, not by
 * test — a new file under `src/` is covered because the walk below reads all of them.)
 */
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FLAG = 'remote-debugging';

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

suite('the screen-reading DevTools port never reaches what ships (T-15)', () => {
  test('nothing that ships names the debugging flag — the sources, the manifest, the launchers, the built bundles', () => {
    // The launchers and the bundles are in the .vsix too (security review finding 4): a flag added to
    // `build-tutorials` or compiled into `dist/extension.js` would ship while a src-only scan stayed green.
    const shipped = [
      ...filesUnder(path.join(ROOT, 'src')),
      ...['package.json', 'build-tutorials', 'start.sh', 'dist/extension.js', 'dist/doctor.js'].map((p) => path.join(ROOT, p)),
    ];
    for (const p of shipped) assert.ok(fs.existsSync(p), `expected to read ${p} (built first by \`npm run build\`)`);
    assert.ok(shipped.length > 10, `expected to read the shipped sources, found ${shipped.length} files`);
    const naming = shipped.filter((f) => fs.readFileSync(f, 'utf8').includes(FLAG));
    assert.deepEqual(naming, [], 'a shipped file names the DevTools debugging flag');
  });

  test('no shipped source imports the test harness', () => {
    const importing = filesUnder(path.join(ROOT, 'src')).filter((f) => /from ['"][./]*\.\.\/test\/|test\/support\//.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(importing, [], 'a file under src/ imports from test/ — the screen client would be bundled into the extension');
  });

  test('the only file that sets it is the test config, and the package excludes that file and test/', () => {
    assert.ok(fs.readFileSync(path.join(ROOT, '.vscode-test.mjs'), 'utf8').includes(FLAG), 'discriminates: the flag is where this test says it is');
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
    assert.ok(ignore.includes('.vscode-test.mjs'), '.vscodeignore must keep .vscode-test.mjs out of the .vsix');
    assert.ok(ignore.includes('test/**'), '.vscodeignore must keep test/ (and test/support/screen.ts) out of the .vsix');
  });
});
