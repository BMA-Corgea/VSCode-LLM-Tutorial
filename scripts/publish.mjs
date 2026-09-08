#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `npm run publish:dry-run` / `node scripts/publish.mjs` - say exactly what publishing this
// extension to the Visual Studio Marketplace and to Open VSX would do (T-8, AC3).
//
// THE LINE. Publishing is the OWNER's act, in his account, with his credentials. This script
// exists so that the command he eventually types is one whose output he has already read, and
// so that nothing else - not CI, not an agent, not a shell that happened to have a token in
// its environment - can perform it on his behalf.
//
// All of the reasoning about WHEN a real publish is allowed lives in `src/publish/plan.ts`,
// which is pure: it takes argv and an environment snapshot and RETURNS a decision. It cannot
// spawn anything. This file is the only place in the repository that spawns a registry
// command at all, and it does so in exactly one branch, guarded twice.
//
// The short version of the rule (the long version is in that file's header):
//
//   no credential, no confirmation  -> DRY RUN, exit 0
//   a credential IS in the env,
//     with no confirmation          -> REFUSE, exit 1. NOT a dry run: with a credential in
//                                      scope, "nothing happened" and "everything happened"
//                                      would look identical on screen and differ only by an
//                                      environment variable nobody typed.
//   --publish-for-real AND
//     BUILD_TUTORIALS_PUBLISH_CONFIRM=<publisher>.<name>@<version>
//                                   -> the real thing.
//
// Flags: --packagePath <vsix>   which artifact (default: <name>-<version>.vsix beside this repo)
//        --dry-run              force a dry run even where a real publish would be allowed
//        --publish-for-real     one of the two confirmations a real publish needs
//
// Both registry tools are reached through `npx` at PINNED versions (src/publish/plan.ts) - an
// unpinned `ovsx@latest` would be code fetched from the registry, at publish time, with a live
// credential already in the environment. What `npx` itself resolves to is still PATH's answer,
// which is a recorded decision rather than an oversight; that file's header says why.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  const next = i >= 0 ? argv[i + 1] : undefined;
  // A flag's value is never another flag: `--packagePath --dry-run` means "the default
  // artifact, dry-run", not "an artifact called --dry-run". Both sibling scripts have carried
  // this guard since they were written and this one did not (T-8 review, finding 7) - three
  // files, one ticket. Contained rather than exploitable (`path.resolve` keeps it absolute and
  // `spawnSync` runs with no shell), but a publish script that reports a nonsense artifact path
  // is a publish script whose transcript nobody can rely on.
  return next !== undefined && next.startsWith('--') ? undefined : next;
};

const bundle = pathToFileURL(path.join(root, 'dist', 'publish.js')).href;
let planModule;
try {
  planModule = await import(bundle);
} catch (err) {
  console.error(`could not load ${bundle} - run "npm run build" first.`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { decidePublish, describeDecision, commandLine } = planModule;

const manifestJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const artifactPath = path.resolve(root, flagValue('--packagePath') ?? `${manifestJson.name}-${manifestJson.version}.vsix`);
const artifactStat = fs.existsSync(artifactPath) ? fs.statSync(artifactPath) : null;

const input = {
  argv,
  env: process.env,
  artifact: {
    path: artifactPath,
    exists: artifactStat !== null,
    size: artifactStat?.size ?? null,
  },
  manifest: {
    publisher: manifestJson.publisher,
    name: manifestJson.name,
    version: manifestJson.version,
    license: manifestJson.license ?? null,
    private: manifestJson.private === true,
    repository: manifestJson.repository?.url ?? null,
  },
};

const decision = decidePublish(input);
for (const line of describeDecision(decision, input)) console.log(line);

if (decision.kind === 'dry-run') process.exit(0);
if (decision.kind === 'refused') process.exit(1);

// ---------------------------------------------------------------------------------------
// THE ONLY BRANCH THAT SPAWNS ANYTHING. Everything above this line is reading and printing.
//
// The second guard is not redundant: it is here so that a future edit which adds an early
// `return` or reorders the exits above cannot let control reach a registry command by
// accident. A publish is irreversible on both registries, so the cost of one extra comparison
// is not worth weighing against it.
// ---------------------------------------------------------------------------------------
if (decision.kind !== 'publish') {
  console.error(`refusing to continue: the decision is "${decision.kind}", which is not a publish`);
  process.exit(1);
}

let failures = 0;
for (const plan of decision.targets) {
  if (!plan.tokenPresent) {
    console.log(`\nskipping ${plan.target.name}: ${plan.target.tokenEnvVar} is not set`);
    continue;
  }
  // Printed through the same quoter the transcript uses: this repository's own path contains a
  // space, so `argv.join(' ')` printed a line that would have run a different command.
  console.log(`\npublishing to ${plan.target.name}: ${commandLine(plan.argv)}`);
  // The credential is NOT passed here. Both tools read it from the environment they inherit,
  // so it never reaches a command line - argv is world-readable through /proc.
  const result = spawnSync(plan.argv[0], plan.argv.slice(1), { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`  could not run ${plan.argv[0]}: ${result.error.message}`);
    failures += 1;
  } else if (result.status !== 0) {
    console.error(`  ${plan.target.name} publish exited ${result.status}`);
    failures += 1;
  } else {
    console.log(`  published to ${plan.target.name}: ${plan.listingUrl}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
