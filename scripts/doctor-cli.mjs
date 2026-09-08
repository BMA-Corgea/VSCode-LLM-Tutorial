#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `./build-tutorials doctor` — the exact same check the "Build Tutorials: Doctor" command
// runs inside VS Code, with no editor host at all. Possible because src/doctor.ts (bundled
// here as dist/doctor.js) never imports `vscode`.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, '..');
const doctorBundle = pathToFileURL(path.join(projectRoot, 'dist', 'doctor.js')).href;

let doctorModule;
try {
  doctorModule = await import(doctorBundle);
} catch (err) {
  console.error(`could not load ${doctorBundle} — run "./build-tutorials build" first.`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const { runDoctor, formatReport, resolveCoreRoot, DEFAULT_REPO_TOUR_PATH } = doctorModule;

// The extension's `buildTutorials.repoTourPath` default, taken from the bundle rather than
// typed again here (T-8 changed the string in three places and missed a fourth). Empty asks
// Node to resolve the `repo-tour` dependency, which in a development checkout is the symlink
// `npm install` made to the sibling and in an installed extension is the copy packaged inside
// it. Running the CLI doctor down the SAME resolution path the packaged extension uses is the
// point — a doctor that only ever proves the sibling case cannot tell you the .vsix is broken.
// An optional first argument overrides it, exactly like pointing the setting at a checkout.
//
// `resolveCoreRoot` is total, so a checkout with no node_modules at all reaches the report
// below instead of raising MODULE_NOT_FOUND here — which is the one thing this command may
// never do, since a missing core is precisely what it exists to explain.
const setting = process.argv[2] ?? DEFAULT_REPO_TOUR_PATH;
const root = resolveCoreRoot(setting, projectRoot);

const report = await runDoctor(root);
for (const line of formatReport(report)) console.log(line);

// The claude CLI is a soft dependency (only repo-tour's interpret stage needs it, and that
// arrives with repo-tour T-13) — its absence is reported but does not fail the doctor. A
// missing core, a module that would not load, or grammars that would not initialise are the
// load-bearing failures this command exists to catch.
const bad = !report.core.found || report.modules.some((m) => !m.ok) || !report.grammars.ok;
process.exit(bad ? 1 : 0);
