// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE LINE, pinned (T-8, AC3). `src/publish/plan.ts` is the file that decides whether a real
 * publish may happen, and it is pure precisely so this suite can drive every branch of that
 * decision without a filesystem, a process, or the slightest chance of publishing anything.
 *
 * What is being protected here is not a feature, it is an INVERSION. The natural design —
 * "dry-run unless a token is present" — turns a token appearing in the environment into a
 * silent mode switch: the same command starts doing something irreversible, and nothing on
 * screen looks different. So the property under test is deliberately counter-intuitive and
 * would look like a bug to anyone who had not read the header of the file it protects:
 *
 *     a credential in the environment, with nothing else, makes this REFUSE.
 *
 * That is the test the next ticket would break by "fixing" it, which is exactly why it is
 * here rather than described in a handoff. (kb/wiki/lessons.md: an invariant that is not
 * pinned by a test the next ticket would break is a coincidence that held once.)
 */

import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIRM_ENV_VAR, CONFIRM_FLAG, DRY_RUN_FLAG, PINNED_TOOL_VERSIONS, REGISTRIES,
  decidePublish, describeDecision, expectedArtifactName, expectedConfirmation, quoteForShell,
  type DecideInput, type ManifestInfo,
} from '../../src/publish/plan.js';

const MANIFEST: ManifestInfo = {
  publisher: 'bma-corgea',
  name: 'build-tutorials',
  version: '0.0.1',
  license: 'AGPL-3.0-or-later',
  private: true,
  repository: 'https://github.com/BMA-Corgea/VSCode-LLM-Tutorial',
};

const ARTIFACT = { path: '/somewhere/build-tutorials-0.0.1.vsix', exists: true, size: 6_890_000 };
const CONFIRMATION = 'bma-corgea.build-tutorials@0.0.1';

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return { argv: [], env: {}, artifact: ARTIFACT, manifest: MANIFEST, ...overrides };
}

suite('publish: the decision', () => {
  test('the confirmation string names the exact VERSION, so it cannot authorise the next one', () => {
    // Renamed from "names the exact artifact" (T-8 review, finding 6). It never did: this
    // asserts something about `package.json`'s coordinates and does not consult ARTIFACT at
    // all. A confirmation is bound to whatever it is compared against, not to whatever the
    // prose says — so the name now states the property that is actually held here, and the
    // artifact binding is the separate test below.
    assert.equal(expectedConfirmation(MANIFEST), CONFIRMATION);
    assert.notEqual(expectedConfirmation({ ...MANIFEST, version: '0.0.2' }), CONFIRMATION);
  });

  test('the artifact is bound too: a correct confirmation cannot publish a DIFFERENT .vsix', () => {
    // Driven in the review behind a shimmed npx: a correct `…@0.0.1` confirmation plus
    // `--publish-for-real` plus `--packagePath <some other build>.vsix` produced kind:'publish'
    // and invoked the registry command with that other file. The confirmation named the
    // version; `--packagePath` was a free variable.
    const decision = decidePublish(input({
      env: { VSCE_PAT: 'x', [CONFIRM_ENV_VAR]: CONFIRMATION },
      argv: [CONFIRM_FLAG],
      artifact: { path: '/tmp/some-other-build-9.9.9.vsix', exists: true, size: 10 },
    }));
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.code, 'artifact-mismatch');
    assert.ok(decision.remedy.includes(expectedArtifactName(MANIFEST)), decision.remedy);
  });

  test('the binding is by NAME, and the transcript says exactly that much', () => {
    // What is bound and what is not, stated where someone deciding to publish will read it:
    // the archive's own manifest is never opened, so a STALE build sitting at the right
    // filename is indistinguishable from a fresh one. Being precise about the strength of a
    // guarantee is the whole of finding 6.
    assert.equal(expectedArtifactName(MANIFEST), 'build-tutorials-0.0.1.vsix');
    for (const artifactPath of [
      '/somewhere/build-tutorials-0.0.1.vsix',
      '/a path with spaces/dist/build-tutorials-0.0.1.vsix',
    ]) {
      const decision = decidePublish(input({
        env: { VSCE_PAT: 'x', [CONFIRM_ENV_VAR]: CONFIRMATION },
        argv: [CONFIRM_FLAG],
        artifact: { path: artifactPath, exists: true, size: 10 },
      }));
      assert.equal(decision.kind, 'publish', artifactPath);
    }
    const text = describeDecision(decidePublish(input()), input()).join('\n');
    assert.ok(text.includes('name'), text);
  });

  test('every printed command line is runnable AS PRINTED, spaces and all', () => {
    // T-8 review, finding 8: the transcript printed `plan.argv.join(' ')` under the sentence
    // "The commands above are exactly what a real publish would execute" — and this
    // repository's own path contains a space, so the printed line ran a different command
    // than the one described. `.autodev/conventions.md` names the hazard: paths have spaces.
    const artifactPath = '/home/someone/Coding Projects/VSCode-LLM-Tutorial-T-8/build-tutorials-0.0.1.vsix';
    const inp = input({ artifact: { path: artifactPath, exists: true, size: 10 } });
    const text = describeDecision(decidePublish(inp), inp).join('\n');
    assert.ok(!text.includes(`publish ${artifactPath}`), 'an unquoted path with a space is not a command');
    assert.ok(text.includes(`'${artifactPath}'`), text);
  });

  test('quoteForShell quotes what needs it and leaves what does not alone', () => {
    assert.equal(quoteForShell('--yes'), '--yes');
    assert.equal(quoteForShell('/no/spaces/here.vsix'), '/no/spaces/here.vsix');
    assert.equal(quoteForShell('@vscode/vsce@3.9.2'), '@vscode/vsce@3.9.2');
    assert.equal(quoteForShell('/a path/x.vsix'), "'/a path/x.vsix'");
    assert.equal(quoteForShell("it's here"), "'it'\\''s here'");
    assert.equal(quoteForShell(''), "''");
  });

  test('both registry tools are PINNED, so a publish cannot fetch whatever is latest', () => {
    // T-8 review, finding 9. `npx --yes ovsx publish` resolved ovsx@latest at publish time,
    // with a live credential in the environment — arbitrary code from the registry, chosen
    // after the owner read the transcript. Both tools now carry an exact version, and the
    // printed command is the pinned one.
    for (const registry of REGISTRIES) {
      const pinned = registry.args.filter((a) => a.includes('@') && !a.startsWith('--'));
      assert.equal(pinned.length, 1, `${registry.id} names exactly one package`);
      assert.ok(/@\d+\.\d+\.\d+$/.test(pinned[0]!), `${registry.id} pins an exact version: ${pinned[0]}`);
      assert.ok(!registry.args.includes('latest'), `${registry.id} must not resolve latest`);
    }
    assert.equal(REGISTRIES[0]?.args.includes(`@vscode/vsce@${PINNED_TOOL_VERSIONS['@vscode/vsce']}`), true);
    assert.equal(REGISTRIES[1]?.args.includes(`ovsx@${PINNED_TOOL_VERSIONS['ovsx']}`), true);
  });

  test('the vsce pin agrees with the devDependency this repository actually installs', () => {
    // Two versions of the same tool — the one `scripts/package.mjs` runs out of node_modules
    // and the one a publish would fetch — drifting apart is how "the command printed is the
    // command that runs" stops being true without anyone editing either line.
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const range = manifest.devDependencies['@vscode/vsce'];
    assert.ok(range, 'the repository declares @vscode/vsce');
    const [rMajor, rMinor, rPatch] = range.replace(/^[^0-9]*/, '').split('.').map(Number);
    const [pMajor, pMinor, pPatch] = PINNED_TOOL_VERSIONS['@vscode/vsce'].split('.').map(Number);
    assert.equal(pMajor, rMajor, `pinned ${PINNED_TOOL_VERSIONS['@vscode/vsce']} vs declared ${range}`);
    assert.ok(
      pMinor! > rMinor! || (pMinor === rMinor && pPatch! >= rPatch!),
      `pinned ${PINNED_TOOL_VERSIONS['@vscode/vsce']} must satisfy ${range}`,
    );
  });

  // ── the default path ────────────────────────────────────────────────────────────────
  test('no credential, no flags: DRY RUN', () => {
    const decision = decidePublish(input());
    assert.equal(decision.kind, 'dry-run');
    assert.deepEqual(decision.state.tokensPresent, []);
  });

  test('a dry run describes BOTH registries, with the exact commands and no token in argv', () => {
    const inp = input({ env: { VSCE_PAT: 'a-real-looking-token', OVSX_PAT: 'another' }, argv: [DRY_RUN_FLAG] });
    const decision = decidePublish(inp);
    assert.equal(decision.kind, 'dry-run');
    assert.equal(decision.targets.length, 2);
    assert.deepEqual(decision.targets.map((t) => t.target.id).sort(), ['open-vsx', 'vs-marketplace']);

    for (const plan of decision.targets) {
      assert.ok(plan.argv.includes(ARTIFACT.path), 'the artifact path is on the command line');
      const joined = plan.argv.join(' ');
      assert.ok(!joined.includes('a-real-looking-token'), 'a credential must never reach argv');
      assert.ok(!joined.includes('another'), 'a credential must never reach argv');
    }

    // Everything the owner has to see before an irreversible act.
    const text = describeDecision(decision, inp).join('\n');
    for (const needed of [
      'Visual Studio Marketplace', 'Open VSX', 'bma-corgea', '0.0.1',
      ARTIFACT.path, 'MB', 'VSCE_PAT', 'OVSX_PAT',
    ]) {
      assert.ok(text.includes(needed), `the transcript should name ${needed}`);
    }
    assert.ok(!text.includes('a-real-looking-token'), 'the transcript must never print a credential');
  });

  // ── THE INVERSION ───────────────────────────────────────────────────────────────────
  test('a credential IS present and nothing confirms: REFUSED, not a quiet dry run', () => {
    for (const env of [{ VSCE_PAT: 'x' }, { OVSX_PAT: 'x' }, { VSCE_PAT: 'x', OVSX_PAT: 'y' }]) {
      const decision = decidePublish(input({ env }));
      assert.equal(decision.kind, 'refused', `${JSON.stringify(env)} must refuse`);
      assert.equal(decision.code, 'tokens-present-without-confirmation');
      // "says why": the refusal names which credential it saw and what would authorise a run.
      assert.ok(decision.reason.length > 0);
      assert.ok(decision.remedy.includes(CONFIRM_FLAG));
      assert.ok(decision.remedy.includes(CONFIRM_ENV_VAR));
      assert.ok(decision.remedy.includes(DRY_RUN_FLAG), 'and how to ask for a dry run deliberately');
    }
  });

  test('an EMPTY credential variable is not a credential', () => {
    // `VSCE_PAT=` in a CI matrix that never filled it in is absence, not presence — reading it
    // as presence would make the refusal fire on exactly the runs it is meant to let through.
    const decision = decidePublish(input({ env: { VSCE_PAT: '', OVSX_PAT: '   ' } }));
    assert.equal(decision.kind, 'dry-run');
  });

  test('an explicit --dry-run still dry-runs with credentials present, and says so', () => {
    const decision = decidePublish(input({ env: { VSCE_PAT: 'x' }, argv: [DRY_RUN_FLAG] }));
    assert.equal(decision.kind, 'dry-run');
    assert.ok(decision.reason.includes(DRY_RUN_FLAG));
    assert.deepEqual(decision.state.tokensPresent, ['vs-marketplace']);
  });

  // ── two confirmations, from two different places ────────────────────────────────────
  test('the flag alone does not publish: the env confirmation is a SEPARATE requirement', () => {
    const decision = decidePublish(input({ env: { VSCE_PAT: 'x' }, argv: [CONFIRM_FLAG] }));
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.code, 'confirmation-mismatch');
    assert.ok(decision.remedy.includes(CONFIRMATION), 'the remedy spells out the exact string');
  });

  test('the env confirmation alone does not publish: the flag is a SEPARATE requirement', () => {
    const decision = decidePublish(input({
      env: { VSCE_PAT: 'x', [CONFIRM_ENV_VAR]: CONFIRMATION },
    }));
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.code, 'tokens-present-without-confirmation');
  });

  test('a confirmation for a DIFFERENT version does not authorise this one', () => {
    // The failure this closes: someone sets the variable once, in a profile or a CI secret,
    // and every later version inherits an approval nobody gave it.
    const decision = decidePublish(input({
      env: { VSCE_PAT: 'x', [CONFIRM_ENV_VAR]: 'bma-corgea.build-tutorials@0.0.2' },
      argv: [CONFIRM_FLAG],
    }));
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.code, 'confirmation-mismatch');
  });

  test('a truthy-looking confirmation is not a confirmation', () => {
    for (const value of ['1', 'true', 'yes', 'bma-corgea.build-tutorials']) {
      const decision = decidePublish(input({
        env: { VSCE_PAT: 'x', [CONFIRM_ENV_VAR]: value },
        argv: [CONFIRM_FLAG],
      }));
      assert.equal(decision.kind, 'refused', `${value} must not authorise a publish`);
    }
  });

  test('both confirmations but no credential: REFUSED, and nothing was sent', () => {
    const decision = decidePublish(input({
      env: { [CONFIRM_ENV_VAR]: CONFIRMATION },
      argv: [CONFIRM_FLAG],
    }));
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.code, 'confirmation-without-token');
    assert.ok(decision.remedy.includes('Nothing was sent'));
  });

  test('no artifact: REFUSED before anything else is considered', () => {
    const decision = decidePublish(input({ artifact: { path: '/nope.vsix', exists: false, size: null } }));
    assert.equal(decision.kind, 'refused');
    assert.equal(decision.code, 'no-artifact');
  });

  test('the ONLY input that yields a publish is credential + flag + exact env confirmation', () => {
    const decision = decidePublish(input({
      env: { VSCE_PAT: 'x', [CONFIRM_ENV_VAR]: CONFIRMATION },
      argv: [CONFIRM_FLAG],
    }));
    assert.equal(decision.kind, 'publish');
    assert.ok(describeDecision(decision, input()).join('\n').includes('irreversible'));
  });

  /**
   * The exhaustive statement of the rule. Every combination of the three inputs that decide a
   * publish is enumerated, and exactly ONE of the eight publishes. A future edit that widens
   * the gate anywhere fails here rather than in a marketplace.
   */
  test('across all eight combinations of credential/flag/confirmation, exactly one publishes', () => {
    const results: string[] = [];
    for (const token of [false, true]) {
      for (const flag of [false, true]) {
        for (const confirm of [false, true]) {
          const env: Record<string, string> = {};
          if (token) env['VSCE_PAT'] = 'x';
          if (confirm) env[CONFIRM_ENV_VAR] = CONFIRMATION;
          const decision = decidePublish(input({ env, argv: flag ? [CONFIRM_FLAG] : [] }));
          results.push(`token=${token} flag=${flag} confirm=${confirm} -> ${decision.kind}`);
        }
      }
    }
    assert.deepEqual(results, [
      'token=false flag=false confirm=false -> dry-run',
      'token=false flag=false confirm=true -> dry-run',
      'token=false flag=true confirm=false -> refused',
      'token=false flag=true confirm=true -> refused',
      'token=true flag=false confirm=false -> refused',
      'token=true flag=false confirm=true -> refused',
      'token=true flag=true confirm=false -> refused',
      'token=true flag=true confirm=true -> publish',
    ]);
    assert.equal(results.filter((r) => r.endsWith('publish')).length, 1);
  });

  test('both registries read their credential from the environment, never from argv', () => {
    // This is what makes the printed command line both honest and safe to log: argv on Linux
    // is world-readable through /proc, so a token on one would leak to every process on the box.
    for (const registry of REGISTRIES) {
      assert.ok(registry.tokenEnvVar.length > 0);
      assert.ok(!registry.args.some((a) => a === '--pat' || a === '-p'), `${registry.id} must not pass a token in argv`);
    }
  });
});
