// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE LINE: what a publish would do, decided as a value, never as a side effect (T-8, AC3).
 *
 * Publishing this extension is the OWNER's act, in his account, with his credentials. This
 * module exists so that the command he eventually runs is one he has already read the output
 * of — and so that nothing in this repository, in CI, or in an agent's session can perform
 * that act on his behalf, by accident or otherwise.
 *
 * ── Why this file computes a decision instead of running a command ────────────────────────
 *
 * `decidePublish` is pure and total: it takes argv, an environment snapshot, the artifact and
 * the manifest, and RETURNS what should happen. It cannot spawn anything, so no test, import,
 * or mistake in this file can publish. Exactly one caller — `scripts/publish.mjs` — is allowed
 * to act on a `publish` decision, and that is the only place in the repository that spawns a
 * registry command at all.
 *
 * ── The inversion that makes the safe path structural rather than habitual ────────────────
 *
 * The obvious design is "dry-run unless a token is present". That design fails the moment a
 * token IS present: the same command silently becomes a real, irreversible publish, and the
 * thing that decided was an ambient environment variable nobody typed. A CI job that gains a
 * secret, a shell that sourced a profile, an inherited env in a container — any of them flips
 * it, and nothing on screen looks different until a version number is permanently taken.
 *
 * So the rule here is inverted:
 *
 *   - No token, no confirmation           -> DRY RUN. Prints what each registry command would
 *                                            do. Exit 0. This is the default path and the only
 *                                            path anything automated ever reaches.
 *   - A token IS present, unconfirmed     -> REFUSE. Exit non-zero, print why. Not a dry run:
 *                                            a refusal, because the environment now disagrees
 *                                            with the invocation and that disagreement must be
 *                                            LOUD rather than resolved silently in either
 *                                            direction.
 *   - Token + BOTH confirmations          -> publish.
 *
 * The middle row is the whole point. Token presence can never *enable* anything here; it can
 * only turn an unconfirmed run into a visible failure. A CI workflow that is handed a token it
 * was never meant to have goes red instead of going to the marketplace.
 *
 * ── "Explicit and separate": two confirmations, from two different places ─────────────────
 *
 * A real publish needs BOTH:
 *
 *   1. `--publish-for-real` on the command line — typed, unabbreviated, and impossible to
 *      arrive by inheritance. Flags do not leak into child processes; environments do.
 *   2. `BUILD_TUTORIALS_PUBLISH_CONFIRM` set to the exact `<publisher>.<name>@<version>` being
 *      published. A stale `=1` in a profile, or a CI secret set once, cannot authorise the next
 *      version; the string stops matching the moment `package.json`'s version changes.
 *
 * Neither is the token. That is what "separate" means: the credential proves you CAN publish,
 * the two confirmations prove you MEANT to, and the two facts come from different sources so
 * that no single stray value satisfies both.
 *
 * ── Exactly how much the confirmation binds ───────────────────────────────────────────────
 *
 * This header used to say the confirmation was "bound to ONE artifact". It was not: it named
 * `package.json`'s coordinates, while `--packagePath` was a free variable, and a correct
 * `…@0.0.1` confirmation would happily publish a completely different `.vsix` (review finding
 * 6, driven). A confirmation is bound to whatever it is COMPARED AGAINST, not to whatever the
 * prose says. So there are now two comparisons, and this is the honest statement of both:
 *
 *   - the confirmation is bound to the VERSION — `<publisher>.<name>@<version>` off the manifest;
 *   - the artifact is bound by FILENAME — it must be named `<name>-<version>.vsix`, whatever
 *     directory it sits in.
 *
 * What that does NOT do: the archive is never opened, so a STALE build sitting at the right
 * filename is indistinguishable from a fresh one. Binding that would mean reading
 * `extension/package.json` out of the zip, which is a parser this pure module cannot have and a
 * spawn `scripts/publish.mjs` deliberately does not make. The transcript says so on screen, so
 * the person deciding reads the real strength of the guarantee rather than a flattering one.
 *
 * ── One more property worth keeping ───────────────────────────────────────────────────────
 *
 * Tokens are never placed in argv. Both `vsce` and `ovsx` read theirs from the environment, so
 * the command lines this module builds are safe to print verbatim, safe to log in CI, and are
 * exactly what a real run would execute — argv on Linux is world-readable via /proc, and a
 * "safe to print" command line is what makes a dry run honest rather than approximate.
 *
 * "Exactly what a real run would execute" also has to survive being COPIED. The transcript used
 * to print `argv.join(' ')`, and this repository's own path contains a space (`Coding
 * Projects`), so the line under *"the commands above are exactly what a real publish would
 * execute"* was a line that would have run something else (review finding 8;
 * `.autodev/conventions.md` names the hazard). `quoteForShell` is applied to the printed form
 * only — `argv` itself stays a real argument vector, because `spawnSync` runs with no shell.
 */

/** A registry this extension can be published to. */
export interface RegistryTarget {
  /** stable id, used in output and in tests */
  id: 'vs-marketplace' | 'open-vsx';
  /** what a person calls it */
  name: string;
  /** the env var the REAL tool reads its credential from — never read for its value here */
  tokenEnvVar: string;
  /** argv[0] of the real command */
  command: string;
  /** argv[1..] with `%ARTIFACT%` standing in for the .vsix path */
  args: readonly string[];
  /** where the listing would appear, for the transcript the owner reads */
  listingUrl: (publisher: string, name: string) => string;
}

/** `%ARTIFACT%` is replaced by the real artifact path when the argv is materialised. */
export const ARTIFACT_PLACEHOLDER = '%ARTIFACT%';

/**
 * EXACT versions of the two registry tools, because a publish is the one moment this project
 * runs third-party code with a live credential in its environment.
 *
 * `npx --yes ovsx publish` resolved `ovsx@latest` at publish time (review finding 9, driven):
 * whatever the registry served in that second, executed with `OVSX_PAT` in scope, chosen after
 * the owner had already read the transcript and typed both confirmations. `@vscode/vsce` was
 * pinned as a devDependency but was still reached by NAME through `npx`, so the same applied.
 * Pinning makes the transcript's promise real: the command printed is the command that runs,
 * including which code it is.
 *
 * Bumping either is a deliberate edit here, and `test/unit/publish-plan.test.ts` asserts the
 * `@vscode/vsce` pin still satisfies the devDependency range this repository installs — the two
 * copies of that tool (the one `scripts/package.mjs` runs out of `node_modules`, the one a
 * publish fetches) drifting apart is how "the command printed is the command that runs" stops
 * being true without anyone editing a line.
 *
 * WHAT IS STILL NOT PINNED, and why this is a recorded decision rather than a fix: `npx` itself
 * is resolved through `PATH`, so whichever `npx` comes first decides who fetches those pinned
 * versions (driven with a shim). Closing that means invoking npm by absolute path, which is a
 * different trust question — the owner runs this in his own shell, on his own machine, where
 * `PATH` is already the trust boundary for `node`, `npm` and `git` alike. The transcript prints
 * argv verbatim, so what would run is on screen before anything runs.
 */
export const PINNED_TOOL_VERSIONS = {
  '@vscode/vsce': '3.9.2',
  ovsx: '1.1.1',
} as const;

/**
 * `npx --yes` on purpose for both: `@vscode/vsce` is a devDependency here, and `ovsx` is
 * deliberately NOT one — T-8 adds no dependency whose only job is to publish, so the command
 * printed is the command that would actually be run on a clean machine.
 */
export const REGISTRIES: readonly RegistryTarget[] = [
  {
    id: 'vs-marketplace',
    name: 'Visual Studio Marketplace',
    tokenEnvVar: 'VSCE_PAT',
    command: 'npx',
    args: ['--yes', `@vscode/vsce@${PINNED_TOOL_VERSIONS['@vscode/vsce']}`, 'publish', '--packagePath', ARTIFACT_PLACEHOLDER],
    listingUrl: (publisher, name) =>
      `https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}`,
  },
  {
    id: 'open-vsx',
    name: 'Open VSX',
    tokenEnvVar: 'OVSX_PAT',
    command: 'npx',
    args: ['--yes', `ovsx@${PINNED_TOOL_VERSIONS.ovsx}`, 'publish', ARTIFACT_PLACEHOLDER],
    listingUrl: (publisher, name) => `https://open-vsx.org/extension/${publisher}/${name}`,
  },
];

/** The flag that says "I mean it". Long and unabbreviated so it cannot be typed by accident. */
export const CONFIRM_FLAG = '--publish-for-real';
/** The second, separately-sourced confirmation. Its VALUE must name the exact artifact. */
export const CONFIRM_ENV_VAR = 'BUILD_TUTORIALS_PUBLISH_CONFIRM';
/** Forces a dry run even when everything else would allow a real publish. */
export const DRY_RUN_FLAG = '--dry-run';

export interface ArtifactInfo {
  path: string;
  exists: boolean;
  /** bytes, or null when the file is not there */
  size: number | null;
}

export interface ManifestInfo {
  publisher: string;
  name: string;
  version: string;
  license: string | null;
  /** npm's "do not publish me" marker — reported, because it is the owner's call, not ours */
  private: boolean;
  repository: string | null;
}

export interface TargetPlan {
  target: RegistryTarget;
  /** whether the credential env var is set and non-empty. The VALUE is never read. */
  tokenPresent: boolean;
  /** exactly what would run, artifact path substituted, token absent by construction */
  argv: string[];
  listingUrl: string;
}

export type RefusalCode =
  | 'no-artifact'
  | 'tokens-present-without-confirmation'
  | 'confirmation-mismatch'
  /** the confirmation named this version and `--packagePath` named a different build */
  | 'artifact-mismatch'
  | 'confirmation-without-token';

export interface PublishState {
  /** which registries have a credential in the environment right now */
  tokensPresent: readonly RegistryTarget['id'][];
  confirmFlagGiven: boolean;
  confirmEnvGiven: boolean;
  confirmEnvMatches: boolean;
  /** the exact string `BUILD_TUTORIALS_PUBLISH_CONFIRM` must equal */
  expectedConfirmation: string;
  /** whether the artifact is named for the coordinates the confirmation names */
  artifactNameMatches: boolean;
  /** what the artifact would have to be called */
  expectedArtifactName: string;
  dryRunFlagGiven: boolean;
}

export type PublishDecision =
  | { kind: 'dry-run'; reason: string; targets: TargetPlan[]; state: PublishState }
  | { kind: 'refused'; code: RefusalCode; reason: string; remedy: string; targets: TargetPlan[]; state: PublishState }
  | { kind: 'publish'; targets: TargetPlan[]; state: PublishState };

export interface DecideInput {
  /** the script's own arguments, without node and the script path */
  argv: readonly string[];
  /** a snapshot of the environment — passed in so this function reads no globals */
  env: Readonly<Record<string, string | undefined>>;
  artifact: ArtifactInfo;
  manifest: ManifestInfo;
  registries?: readonly RegistryTarget[];
}

/** The exact value `BUILD_TUTORIALS_PUBLISH_CONFIRM` must carry to authorise THIS version. */
export function expectedConfirmation(manifest: ManifestInfo): string {
  return `${manifest.publisher}.${manifest.name}@${manifest.version}`;
}

/**
 * What the artifact has to be CALLED for a confirmation of this version to authorise it —
 * `scripts/package.mjs`'s own default output name. Directory-independent on purpose: an
 * artifact downloaded from CI or written with `--out dist/…` is still this build.
 */
export function expectedArtifactName(manifest: ManifestInfo): string {
  return `${manifest.name}-${manifest.version}.vsix`;
}

/** The last path segment, without needing `node:path` in a module that touches no filesystem. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * One argv word, quoted so the printed command line is runnable as printed.
 *
 * Only the TRANSCRIPT uses this. `TargetPlan.argv` stays a real argument vector — `spawnSync`
 * runs with no shell, so a quoted word there would be a quote character inside a filename.
 */
export function quoteForShell(word: string): string {
  if (word.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/** A command line a person can paste — what `argv.join(' ')` only looked like. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteForShell).join(' ');
}

function planFor(target: RegistryTarget, input: DecideInput): TargetPlan {
  const token = input.env[target.tokenEnvVar];
  return {
    target,
    tokenPresent: typeof token === 'string' && token.trim().length > 0,
    argv: [target.command, ...target.args.map((a) => (a === ARTIFACT_PLACEHOLDER ? input.artifact.path : a))],
    listingUrl: target.listingUrl(input.manifest.publisher, input.manifest.name),
  };
}

/**
 * Decides what a publish run should do. Pure: no filesystem, no process, no spawn.
 *
 * The order of the checks below is the order of the rules in this file's header, and each
 * refusal carries the WHOLE state rather than only the rule that fired — a refusal that says
 * "a token is set" without saying which, or without saying what the confirmation should have
 * been, is a refusal someone will work around by guessing.
 */
export function decidePublish(input: DecideInput): PublishDecision {
  const registries = input.registries ?? REGISTRIES;
  const targets = registries.map((t) => planFor(t, input));

  const expected = expectedConfirmation(input.manifest);
  const expectedName = expectedArtifactName(input.manifest);
  const confirmEnvValue = input.env[CONFIRM_ENV_VAR];
  const state: PublishState = {
    tokensPresent: targets.filter((t) => t.tokenPresent).map((t) => t.target.id),
    confirmFlagGiven: input.argv.includes(CONFIRM_FLAG),
    confirmEnvGiven: typeof confirmEnvValue === 'string' && confirmEnvValue.length > 0,
    confirmEnvMatches: confirmEnvValue === expected,
    expectedConfirmation: expected,
    artifactNameMatches: baseName(input.artifact.path) === expectedName,
    expectedArtifactName: expectedName,
    dryRunFlagGiven: input.argv.includes(DRY_RUN_FLAG),
  };

  // An explicit --dry-run wins over everything. It is the one flag that can only ever make the
  // outcome safer, so it is checked first and never argued with — including when a token is
  // present, which is precisely the case a CI job wants to be able to state out loud.
  if (state.dryRunFlagGiven) {
    return { kind: 'dry-run', reason: `${DRY_RUN_FLAG} was given explicitly`, targets, state };
  }

  // Nothing to publish is a failure, not a quiet dry run: CI runs `package` and then this, so
  // a missing artifact means the step before it did not produce what it claimed.
  if (!input.artifact.exists) {
    return {
      kind: 'refused',
      code: 'no-artifact',
      reason: `there is no artifact at ${input.artifact.path}`,
      remedy: 'run `npm run package` first — the dry run describes a real file or it describes nothing',
      targets,
      state,
    };
  }

  if (state.confirmFlagGiven && !state.confirmEnvMatches) {
    return {
      kind: 'refused',
      code: 'confirmation-mismatch',
      reason: state.confirmEnvGiven
        ? `${CONFIRM_ENV_VAR} does not name this artifact`
        : `${CONFIRM_FLAG} was given but ${CONFIRM_ENV_VAR} is not set`,
      remedy: `a real publish needs both confirmations: ${CONFIRM_FLAG} on the command line AND ${CONFIRM_ENV_VAR}=${expected} in the environment. The second one names the exact version so that setting it once cannot authorise the next one.`,
      targets,
      state,
    };
  }

  // The confirmation names a VERSION; this is what binds it to a FILE. Without it `--packagePath`
  // is a free variable beside a confirmation that reads as though it had named the artifact —
  // driven in review, a correct `…@0.0.1` confirmation published a `some-other-build-9.9.9.vsix`.
  if (state.confirmFlagGiven && !state.artifactNameMatches) {
    return {
      kind: 'refused',
      code: 'artifact-mismatch',
      reason: `the confirmation names ${expected}, but the artifact is ${baseName(input.artifact.path)}`,
      remedy: `a confirmation for this version authorises an artifact named ${expectedArtifactName(input.manifest)} — pass --packagePath to a file with that name, or bump package.json and confirm the version you actually mean. The archive's own manifest is never opened, so this binds the file's NAME and not its contents.`,
      targets,
      state,
    };
  }

  // THE INVERSION. A credential in the environment does not enable a publish; it withdraws the
  // dry run, because from here on "nothing happened" and "everything happened" would look the
  // same on screen and differ only by an env var nobody typed.
  if (state.tokensPresent.length > 0 && !state.confirmFlagGiven) {
    return {
      kind: 'refused',
      code: 'tokens-present-without-confirmation',
      reason: `a registry credential is present in the environment (${state.tokensPresent.join(', ')}) but nothing here says a real publish was intended`,
      remedy: `either unset those variables to get a dry run, pass ${DRY_RUN_FLAG} to say the dry run is deliberate, or pass ${CONFIRM_FLAG} with ${CONFIRM_ENV_VAR}=${expected} to publish for real. This run did NOT dry-run on purpose: with a credential in scope, a silent dry run and a silent publish are one typo apart.`,
      targets,
      state,
    };
  }

  if (state.confirmFlagGiven && state.tokensPresent.length === 0) {
    return {
      kind: 'refused',
      code: 'confirmation-without-token',
      reason: 'a real publish was confirmed, but no registry credential is present',
      remedy: `set ${registries.map((r) => r.tokenEnvVar).join(' and/or ')} in the environment. Nothing was sent to either registry.`,
      targets,
      state,
    };
  }

  if (state.confirmFlagGiven) {
    return { kind: 'publish', targets, state };
  }

  return {
    kind: 'dry-run',
    reason: 'no registry credential is present, so there is nothing to do but describe the publish',
    targets,
    state,
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'missing';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Renders a decision as the transcript the owner reads before deciding to publish. Everything
 * a publish would take permanently — the registry, the publisher id, the version, the artifact
 * and its size — is on screen, and the argv is the literal command, not a paraphrase of it.
 */
export function describeDecision(decision: PublishDecision, input: DecideInput): string[] {
  const { manifest, artifact } = input;
  const lines: string[] = [];

  lines.push('build-tutorials publish');
  lines.push('');
  lines.push(`  extension     ${manifest.publisher}.${manifest.name}`);
  lines.push(`  version       ${manifest.version}    (permanent on both registries once taken — not reusable, not deletable)`);
  lines.push(`  licence       ${manifest.license ?? '(none declared)'}`);
  lines.push(`  repository    ${manifest.repository ?? '(none declared)'}`);
  lines.push(`  artifact      ${artifact.path}`);
  lines.push(`  size          ${formatBytes(artifact.size)}`);
  lines.push(
    `  binding       the confirmation names ${decision.state.expectedConfirmation}; the artifact is bound by ` +
    `file name (${decision.state.expectedArtifactName})${decision.state.artifactNameMatches ? '' : ' — THIS FILE IS NOT THAT NAME'}.`,
  );
  lines.push('                Its archive is never opened, so a stale build at that name reads as a fresh one.');
  if (manifest.private) {
    lines.push('');
    lines.push('  note          package.json still carries "private": true. npm treats that as');
    lines.push('                "do not publish me". Whether it should be cleared before the');
    lines.push('                first real publish is the owner\'s call, not this script\'s.');
  }
  lines.push('');

  for (const plan of decision.targets) {
    lines.push(`  ── ${plan.target.name} ──`);
    lines.push(`     listing      ${plan.listingUrl}`);
    lines.push(`     credential   ${plan.target.tokenEnvVar} ${plan.tokenPresent ? 'IS set (value never read or printed)' : 'is not set'}`);
    lines.push(`     command      ${commandLine(plan.argv)}`);
    lines.push('');
  }

  if (decision.kind === 'dry-run') {
    lines.push(`DRY RUN — ${decision.reason}.`);
    lines.push('Nothing was sent to either registry. The commands above are exactly what a real');
    lines.push('publish would execute; the credential is read from the environment by each tool,');
    lines.push('so it never appears on a command line.');
    lines.push('');
    lines.push('To publish for real, the owner runs, in his own shell:');
    lines.push(`  ${CONFIRM_ENV_VAR}=${decision.state.expectedConfirmation} \\`);
    lines.push(`    node scripts/publish.mjs ${CONFIRM_FLAG}`);
    lines.push('with VSCE_PAT and/or OVSX_PAT set. Both confirmations are required, and the');
    lines.push('second one names this exact version.');
  } else if (decision.kind === 'refused') {
    lines.push(`REFUSED (${decision.code}) — ${decision.reason}.`);
    lines.push('Nothing was sent to either registry.');
    lines.push('');
    lines.push(decision.remedy);
  } else {
    lines.push('PUBLISHING FOR REAL — both confirmations are present:');
    lines.push(`  ${CONFIRM_FLAG} on the command line`);
    lines.push(`  ${CONFIRM_ENV_VAR}=${decision.state.expectedConfirmation}`);
    lines.push('This is irreversible on both registries.');
  }

  return lines;
}
