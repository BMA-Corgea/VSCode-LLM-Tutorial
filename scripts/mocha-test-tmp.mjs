// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T-81's door for mocha. `.mocharc.cjs` loads this into every mocha run started in this repository:
// `npm run test:unit`, a bare `npx mocha <one file>`, a mutation sweep's runs. Mocha loads it before
// any test file, so even a folder made while a file loads is this run's. See scripts/test-tmp.mjs.
//
// From here on, `os.tmpdir()` is this run's own folder in this process, in its worker threads and in
// every process it starts, because they all read it from these variables. The folder goes when the
// process exits, a failed run included, or when SIGINT, SIGTERM or SIGHUP stops it. After cleaning
// up on a signal, the process dies of that signal, as it would have without this.
import { claimTestTmp, SIGNALS } from './test-tmp.mjs';

const claim = claimTestTmp('unit');
Object.assign(process.env, claim.vars);

// Whether the run FAILED (which BUILD_TUTORIALS_KEEP_TMP=failed asks) is known only at the very end.
// Without `--exit`, mocha sets its exit code inside an 'exit' listener of its own, which it adds when
// the run finishes, so after this file's: a listener added here would read 0 for a failed run. So
// once the event loop has emptied ('beforeExit', which comes after mocha has added its listener),
// the decision moves to a listener added after mocha's, which reads process.exitCode once mocha has
// set it. A run that ends by process.exit() (mocha's `--exit`) or by a crash gets no 'beforeExit',
// and the first listener decides, from the code it exits with.
let decidedLate = false;
process.on('exit', (code) => {
  if (!decidedLate) claim.release({ failed: code !== 0 });
});
process.once('beforeExit', () => {
  decidedLate = true;
  process.on('exit', (code) => claim.release({ failed: code !== 0 || (process.exitCode ?? 0) !== 0 }));
});

for (const signal of SIGNALS) {
  process.once(signal, () => {
    claim.release({ failed: true });
    process.kill(process.pid, signal);
  });
}
