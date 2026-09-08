// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one bundle the packaging and publishing scripts import (T-8).
 *
 * Same shape as `src/doctor.ts` and `scripts/doctor-cli.mjs`: the logic is TypeScript in
 * `src/`, typechecked and unit-tested like everything else, and the `.mjs` scripts are thin
 * shells around it. esbuild emits this to `dist/publish.js`; nothing under `src/publish/`
 * imports `vscode`, so the scripts run with no editor host at all.
 *
 * `disclosure.ts` imports `EXPECTED_GRAMMARS` from `src/doctor.ts`, so this bundle carries the
 * doctor and `src/core.ts` too. That is deliberate — what the archive is checked for IS what
 * the doctor asks `initParsers` for, and two lists agreeing by comment is the failure T-8's
 * review found (finding 11). The chain stays free of `vscode` and starts no subprocess of its
 * own — `test/unit/build.test.ts`'s allow-list scan says so about every file in `src/`, and it
 * said so about this sentence first — so the decision this bundle computes can never itself
 * publish anything. `scripts/publish.mjs` is the only caller allowed to act on one.
 *
 * `dist/publish.js` is excluded from the .vsix (`.vscodeignore`) — it is release tooling for
 * this repository, not part of the extension a user installs.
 */

export * from './plan.js';
export * from './disclosure.js';
