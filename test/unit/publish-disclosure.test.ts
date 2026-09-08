// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE DISCLOSURE CHECK, pinned (T-8, step 6). `src/publish/disclosure.ts` decides what may and
 * may not be inside a published .vsix; `scripts/package.mjs` runs it over the real archive and
 * fails the packaging step when it fires.
 *
 * Two halves, and the second is the one that gets forgotten:
 *
 *   - what must NOT ship. A .vsix goes to strangers, permanently. Nothing goes red when it
 *     carries the factory ledger or a source map with the whole source tree inside it, which
 *     is exactly why a checklist does not work and a failing test does.
 *   - what MUST ship. An archive missing the WASM grammars installs, activates, and looks
 *     perfectly healthy until the first real digest — a long way from the packaging change
 *     that caused it.
 *
 * The needles this suite uses are SYNTHETIC. The rule under test is that a short personal name
 * is matched as a WORD, because the AGPL text shipped as LICENSE.txt contains an ordinary
 * English word with a four-letter first name sitting inside it — so a substring search fires on
 * every single run, and a check that cries wolf every run is a check someone disables. `ana`
 * inside `banana` is that shape, with nobody named.
 */

import * as assert from 'node:assert/strict';
import {
  PUBLIC_IDENTITIES, REQUIRED_GRAMMARS,
  certifyNameScan, checkArchive, checkContent, checkPaths, checkRequiredContent,
  isWordScannable, looksTextual, ownerNeedlesFrom, relativeToExtension,
} from '../../src/publish/disclosure.js';
import { EXPECTED_GRAMMARS } from '../../src/doctor.js';

const NEEDLES = { ownerNeedles: [] as string[] };

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

/** A file with a NUL in it: what a .wasm grammar looks like to the textual heuristic. */
function binary(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x00]), bytes(text)]);
}

suite('disclosure: paths that must never ship', () => {
  test('the archive prefix is stripped so rules read like repository paths', () => {
    assert.equal(relativeToExtension('extension/dist/extension.js'), 'dist/extension.js');
    assert.equal(relativeToExtension('extension.vsixmanifest'), 'extension.vsixmanifest');
  });

  test('every named forbidden path is caught', () => {
    const cases: [string, string][] = [
      ['extension/.autodev/events.jsonl', 'autodev-ledger'],
      ['extension/node_modules/whatever/.autodev/x', 'autodev-ledger'],
      ['extension/autodev/instructions/build.md', 'shop-overlay'],
      ['extension/kb/wiki/lessons.md', 'knowledge-base'],
      ['extension/kb/days/2026-09-07.md', 'knowledge-base'],
      ['extension/.env', 'env-file'],
      ['extension/.env.local', 'env-file'],
      ['extension/dist/extension.js.map', 'source-map'],
      ['extension/dist/test/unit/walk-store.test.js', 'test-bundle'],
      ['extension/.git/config', 'git-directory'],
      ['extension/.scratch/20260907/plan.json', 'scratch-directory'],
      ['extension/.vscode-test/user-data/x', 'scratch-directory'],
      // The barrier a script builds does not cover the file that script plants afterwards
      // (T-8 review, finding 3). `scripts/package.mjs` mkdirs `vendor/` inside the staging
      // copy and puts a 920 KB tarball in it, AFTER the allowlist has done its work — and a
      // re-zipped archive carrying it passed the real --verify-only and printed its size in
      // the script's own table.
      ['extension/vendor/repo-tour-0.1.0.tgz', 'packaging-intermediate'],
      ['extension/vendor/anything', 'packaging-intermediate'],
      ['extension/.package-staging/package.json', 'packaging-intermediate'],
      ['extension/some-package-1.0.0.tgz', 'packaging-intermediate'],
      // The other three the review drove past this check.
      ['extension/src/extension.ts', 'source-tree'],
      ['extension/src/publish/plan.ts', 'source-tree'],
      ['extension/dist/anything.d.ts', 'typescript-source'],
      ['extension/.npmrc', 'npm-config'],
      ['extension/node_modules/x/.npmrc', 'npm-config'],
      ['extension/test/unit/whatever.test.js', 'source-tree'],
    ];
    for (const [entry, rule] of cases) {
      const found = checkPaths([entry]);
      assert.ok(found.some((v) => v.rule === rule), `${entry} should trip ${rule}, got ${JSON.stringify(found)}`);
      assert.ok(found[0]?.detail.length ?? 0 > 0, 'a violation says why, not just that');
    }
  });

  test('.env.example and its family are NOT flagged', () => {
    // Withholding the placeholders projects commit on purpose is the failure T-12's review
    // found in the product half of this same idea. Flagging them here is its cry-wolf twin:
    // a violation on every run of any project that ships an ordinary example file.
    for (const entry of ['extension/.env.example', 'extension/.env.sample', 'extension/.env.template']) {
      assert.deepEqual(checkPaths([entry]), []);
    }
  });

  test('a legitimate archive trips nothing', () => {
    assert.deepEqual(checkPaths([
      'extension.vsixmanifest',
      '[Content_Types].xml',
      'extension/package.json',
      'extension/readme.md',
      'extension/LICENSE.txt',
      'extension/dist/extension.js',
      'extension/media/icon.svg',
      'extension/node_modules/repo-tour/dist/extract.js',
      'extension/node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm',
    ]), []);
  });
});

suite('disclosure: credential shapes', () => {
  const secrets: [string, string][] = [
    ['stripe-live-key', 'const k = "sk_live_51H8xQ2abcdefgh";'],
    ['github-token', 'GH=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'],
    ['aws-access-key-id', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE'],
    ['private-key-header', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
  ];

  for (const [rule, content] of secrets) {
    test(`${rule} is caught`, () => {
      const found = checkContent('extension/dist/extension.js', bytes(content), NEEDLES);
      assert.ok(found.some((v) => v.rule === `secret:${rule}`), `expected secret:${rule}, got ${JSON.stringify(found)}`);
    });
  }

  /**
   * T-8 review, finding 5: 5 of 15 probed shapes were caught. The first one below is the
   * credential this project's own tutor and detour spend money through — `BUILD_TUTORIALS_CLAUDE`
   * is already a name this codebase knows — and it was not among the five.
   */
  /**
   * **Every fixture below is SPLIT so the file never contains the literal.**
   *
   * These are synthetic — `AbCdEf0123456789` bodies, and the AWS one is Amazon's own published
   * example key — but several of the prefixes are distinctive enough that a real secret scanner
   * matches them anyway. GitHub push protection rejected this file for exactly two of them
   * (`glpat-`, `xoxb-`), which is the scanner doing its job on a test **for a scanner**.
   *
   * The fix is the honest one and it generalises: **a fixture for a secret detector must not
   * contain a string a secret detector would match.** Joining at runtime keeps the value under
   * test byte-identical while leaving no matchable literal in the source. The alternative —
   * clicking the "allow this secret" link — would have whitelisted secret-shaped strings on a
   * public repository forever to make one test file pushable, which trades a permanent hole for
   * a moment's convenience.
   *
   * Split them ALL rather than only the two that were caught: the next scanner pattern lands
   * without warning, and it lands on whoever is pushing that day.
   */
  const j = (...parts: string[]): string => parts.join('');
  const alsoSecrets: [string, string][] = [
    ['anthropic-key', j('ANTHROPIC_API_KEY=sk-', 'ant-api03-AbCdEf0123456789AbCdEf0123456789AbCdEf')],
    ['openai-project-key', j('const k = "sk-', 'proj-AbCdEf0123456789AbCdEf0123456789";')],
    ['github-fine-grained-token', j('TOKEN=github', '_pat_11ABCDEFG0AbCdEfGhIjKl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
    ['github-oauth-token', j('gho', '_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7r8')],
    ['github-oauth-token', j('ghs', '_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7r8')],
    ['github-oauth-token', j('ghu', '_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7r8')],
    ['github-oauth-token', j('ghr', '_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7r8')],
    ['gitlab-token', j('CI_TOKEN=glpat', '-AbCdEf0123456789AbCd')],
    ['slack-token', j('xoxb', '-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')],
    ['npm-auth-token', j('//registry.npmjs.org/:_authToken=npm', '_AbCdEf0123456789AbCdEf0123456789AbCd')],
    ['aws-secret-access-key', j('aws_secret_access_key = wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY')],
    ['jwt', j('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')],
  ];

  for (const [rule, content] of alsoSecrets) {
    test(`${rule} is caught: ${content.slice(0, 24)}…`, () => {
      const found = checkContent('extension/dist/extension.js', bytes(content), NEEDLES);
      assert.ok(found.some((v) => v.rule === `secret:${rule}`), `expected secret:${rule}, got ${JSON.stringify(found)}`);
    });
  }

  test('the shapes are specific enough not to cry wolf on ordinary text', () => {
    // A rule that fires on a README is a rule people learn to pass with `|| true`.
    const innocuous = [
      'see https://example.com/sk-ant- for the key format',
      'set _authToken in your ~/.npmrc, never here',
      'the token starts with glpat- followed by twenty characters',
      'aws_secret_access_key is read from the environment',
      'eyJ is what a base64 JSON header looks like',
      'gho_ / ghs_ / ghu_ / ghr_ are GitHub app tokens',
    ];
    for (const text of innocuous) {
      assert.deepEqual(checkContent('extension/readme.md', bytes(text), NEEDLES), [], text);
    }
  });

  test('a credential hiding inside a BINARY file is still caught', () => {
    // The scan decodes as latin1 rather than utf8 so a byte sequence in a .wasm cannot become
    // a replacement character and vanish on the way to the regex.
    const found = checkContent('extension/node_modules/x/thing.wasm', binary('AKIAIOSFODNN7EXAMPLE'), NEEDLES);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.rule, 'secret:aws-access-key-id');
  });

  test('prose that merely mentions the shapes is not a credential', () => {
    const doc = 'Never commit an AKIA key, a ghp_ token or an sk_live_ secret.';
    assert.deepEqual(checkContent('extension/readme.md', bytes(doc), NEEDLES), []);
  });
});

suite('disclosure: the owner\'s name, matched as a word', () => {
  const opts = { ownerNeedles: ['ana'] };

  test('a short needle inside a longer word is NOT a match', () => {
    // This is the LICENSE.txt false positive, with nobody named: a four-letter first name
    // sitting inside an ordinary English word, on every run, forever.
    for (const text of ['a banana split', 'Banana', 'ananas', 'canal', 'Anagram']) {
      assert.deepEqual(checkContent('extension/LICENSE.txt', bytes(text), opts), [], text);
    }
  });

  test('the same needle as a whole word IS a match, case-insensitively', () => {
    for (const text of ['Ana wrote this', 'by ana', 'ana@example.com', '(ana)']) {
      const found = checkContent('extension/readme.md', bytes(text), opts);
      assert.equal(found.length, 1, `${text} should match`);
      assert.equal(found[0]?.rule, 'owner-identity');
    }
  });

  test('a short needle is not word-matched inside a binary, and the skip is NAMED', () => {
    // A word boundary is a property of text. Asserting one inside a 2 MB compiled grammar
    // means nothing — so those files are excluded, and the exclusion is reported BY NAME
    // rather than as a count: a count makes an exclusion look surveyed, and it is exactly
    // what hid a .js file sitting among the .wasm files (T-8 review, finding 4).
    const entries = ['extension/readme.md', 'extension/g.wasm'];
    const files = new Map([
      ['extension/readme.md', bytes('nothing here')],
      ['extension/g.wasm', binary('ana')],
    ]);
    const result = checkArchive(entries, (e) => files.get(e)!, opts);
    assert.deepEqual(result.violations, []);
    assert.equal(result.filesScanned, 2);
    assert.equal(result.textFilesScanned, 1);
    assert.deepEqual(result.nameScanExemptions, ['extension/g.wasm']);
  });

  test('a JavaScript file with a NUL in it is still word-scanned', () => {
    // The finding, exactly: `node_modules/repo-tour/dist/architecture.js` is 9,415 bytes of
    // ordinary JavaScript that joins two map-key strings with a NUL separator, putting one
    // literal NUL at byte 7254 — which classified a shipped source file as "binary" and
    // exempted it from the name scan. Driven with a control: the identical planted line in
    // `dist/extract.js` (no NUL) was caught, and in `architecture.js` it was not.
    const withNul = Buffer.concat([
      bytes('export const k = (a, b) => a + "'),
      Buffer.from([0x00]),
      bytes('" + b;\n// written by ana\n'),
    ]);
    const found = checkContent('extension/node_modules/repo-tour/dist/architecture.js', withNul, opts);
    assert.equal(found.length, 1, 'a .js file is a .js file whatever bytes are in it');
    assert.equal(found[0]?.rule, 'owner-identity');
  });

  test('classification is by EXTENSION, which is the question actually being asked', () => {
    // "Binary" is not a property of a file; it is the answer to whichever question you asked.
    // The question here is "can a word boundary mean anything in this file", and the honest
    // answer comes from what kind of file it is, not from whether byte 7254 happens to be NUL.
    for (const textual of [
      'extension/dist/extension.js', 'extension/package.json', 'extension/readme.md',
      'extension/LICENSE.txt', 'extension/build-tutorials', 'extension/media/icon.svg',
      'extension/node_modules/repo-tour/assets/skins/base.css',
    ]) {
      assert.equal(isWordScannable(textual), true, textual);
    }
    for (const opaque of [
      'extension/node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm',
      'extension/node_modules/repo-tour/assets/img/hero.jpg',
      'extension/x.png', 'extension/x.woff2', 'extension/x.node', 'extension/x.tgz',
    ]) {
      assert.equal(isWordScannable(opaque), false, opaque);
    }
  });

  test('image METADATA is in scope for specific needles, and out of scope for short ones', () => {
    // Stated rather than left to be discovered: `hero-alt.jpg` really does ship XMP carrying a
    // third party's name in <dc:creator>, correctly credited in credits.json. XMP is literal
    // ASCII inside the file, so a long needle and every credential rule DO see it; a short
    // name inside it would not be word-matched, because .jpg is not word-scannable. That is
    // the limit, and this test is where it is written down.
    const xmp = binary('<dc:creator><rdf:Seq><rdf:li>ana@example.com</rdf:li>');
    const long = checkContent('extension/node_modules/repo-tour/assets/img/hero-alt.jpg', xmp, {
      ownerNeedles: ['ana@example.com'],
    });
    assert.equal(long.length, 1, 'a specific needle is searched byte-for-byte, metadata included');

    const short = checkContent('extension/node_modules/repo-tour/assets/img/hero-alt.jpg', xmp, opts);
    assert.deepEqual(short, [], 'a short needle in image metadata is NOT covered — the stated limit');
  });

  test('a long, specific needle IS searched in binaries too', () => {
    // An email address cannot be a chance match, so it is not worth losing coverage over.
    const opts2 = { ownerNeedles: ['someone@example.com'] };
    const found = checkContent('extension/g.wasm', binary('someone@example.com'), opts2);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.rule, 'owner-identity');
  });

  test('the scan reports which needles it used, so a vacuous run is visible', () => {
    const result = checkArchive([], () => Buffer.alloc(0), { ownerNeedles: [] });
    assert.deepEqual(result.needlesChecked, []);
    assert.equal(result.filesScanned, 0);
  });

  test('looksTextual is the "NUL in the first 8 KiB" heuristic — a STATISTIC, not the gate', () => {
    assert.equal(looksTextual(bytes('plain text')), true);
    assert.equal(looksTextual(binary('x')), false);
    assert.equal(looksTextual(Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])])), true);
    // …and it no longer decides whether a file is word-scanned. That is what this pins.
    assert.equal(looksTextual(binary('x')), false);
    assert.equal(isWordScannable('extension/dist/architecture.js'), true);
  });
});

suite('disclosure: the name half certifies, or it REFUSES', () => {
  /**
   * T-8 review, finding 2 — the blocker. With no `BUILD_TUTORIALS_OWNER_NAMES` and no usable
   * git identity, the check printed `passed VACUOUSLY` and exited 0. That is the default shape
   * of a GitHub Actions runner (`actions/checkout` configures no git identity), so the one
   * place the check most needs to work is the one place it did nothing and said "verified".
   *
   * The rule this suite pins: THE FAILURE OF A CHECK'S INPUT IS A FAILURE OF THE CHECK. The
   * same file already gets this exactly right for `unzip` — a missing tool is a hard failure
   * because an unverified archive is the thing being prevented.
   */
  test('no needles is a REFUSAL to certify, and it is non-zero', () => {
    const certification = certifyNameScan({ gitName: '', gitEmail: '' });
    assert.equal(certification.kind, 'refused');
    assert.notEqual(certification.exitCode, 0, 'a check that checked nothing must not exit 0');
    assert.deepEqual(certification.needles, []);
    // "with a message saying how to supply them" — a refusal nobody can act on gets routed around.
    assert.ok(certification.remedy.includes('BUILD_TUTORIALS_OWNER_NAMES'), certification.remedy);
    assert.ok(certification.remedy.includes('git config'), certification.remedy);
  });

  test('a git identity that is entirely PUBLIC identifiers still refuses', () => {
    // The live shape on the machine this was built on: `git config user.name` is a public
    // identity and is correctly dropped, so the needle list can come back empty from a git
    // that answered perfectly well.
    const certification = certifyNameScan({ gitName: 'Corgea', gitEmail: '' });
    assert.equal(certification.kind, 'refused');
    assert.notEqual(certification.exitCode, 0);
  });

  test('git being UNAVAILABLE is not git answering empty', () => {
    // kb/wiki/lessons.md (T-13): an absent value read as a meaningful one. `spawnSync('git')`
    // returning nothing because the binary is missing was indistinguishable from a git that
    // answered with an empty identity — two different facts, one exit code.
    const certification = certifyNameScan({ gitUnavailable: 'git is not on PATH' });
    assert.equal(certification.kind, 'refused');
    assert.notEqual(certification.exitCode, 0);
    assert.ok(certification.message.includes('git is not on PATH'), certification.message);
  });

  test('needles supplied: certified, and it says which sources it used', () => {
    const certification = certifyNameScan({ envValue: 'Ana,ana@example.com' });
    assert.equal(certification.kind, 'certified');
    assert.equal(certification.exitCode, 0);
    assert.deepEqual(certification.needles, ['Ana', 'ana@example.com']);
  });

  test('the ONLY way past an empty needle list is a waiver the caller says out loud', () => {
    const certification = certifyNameScan({ gitName: '', gitEmail: '', allowVacuous: true });
    assert.equal(certification.kind, 'waived');
    assert.equal(certification.exitCode, 0);
    // And the record must not read as a pass: a waived run is not a verified archive.
    assert.ok(/NOT checked|NOT certified/i.test(certification.message), certification.message);
    assert.ok(certification.message.includes('--allow-vacuous-name-scan'), certification.message);
  });

  test('a waiver cannot manufacture needles, and does not apply when there are some', () => {
    const certification = certifyNameScan({ envValue: 'Ana', allowVacuous: true });
    assert.equal(certification.kind, 'certified', 'the waiver is about absence, not about skipping');
    assert.deepEqual(certification.needles, ['Ana']);
  });
});

suite('disclosure: where the needles come from', () => {
  test('the public GitHub org, publisher id and project names are not personal names', () => {
    // Already in package.json's repository URL and in the git remote. Flagging them would fire
    // on every run, which is how a check gets routed around.
    assert.deepEqual(ownerNeedlesFrom({ gitName: 'Corgea', gitEmail: '' }), []);
    for (const id of PUBLIC_IDENTITIES) {
      assert.deepEqual(ownerNeedlesFrom({ gitName: id.toUpperCase(), gitEmail: '' }), []);
    }
  });

  test('the git identity is the fallback, so a bare run still checks something real', () => {
    assert.deepEqual(
      ownerNeedlesFrom({ gitName: 'Corgea', gitEmail: 'someone@example.com' }),
      ['someone@example.com'],
    );
  });

  test('an explicit list REPLACES the derived one rather than adding to it', () => {
    // Appending silently would make the result depend on whose machine it ran on.
    assert.deepEqual(
      ownerNeedlesFrom({ envValue: 'Ana, ana@example.com', gitName: 'Somebody', gitEmail: 'else@example.com' }),
      ['Ana', 'ana@example.com'],
    );
  });

  test('duplicates collapse and two-character fragments are not identities', () => {
    assert.deepEqual(ownerNeedlesFrom({ envValue: 'Ana,ana,ANA,  ,Jo' }), ['Ana']);
  });
});

suite('disclosure: what the archive MUST contain', () => {
  test('the grammars are written down ONCE, and the archive check reads the doctor\'s list', () => {
    // T-8 review, finding 11 — T-7's recorded DETOUR_LIMITS lesson, one ticket later. What
    // `initParsers` is asked for and what the archive is checked for were two independent
    // literals whose only connection was a comment pointing at the other. Neither module
    // touches `vscode`, so one can simply import the other; this asserts it did.
    assert.deepEqual([...REQUIRED_GRAMMARS], [...EXPECTED_GRAMMARS]);
    assert.equal(REQUIRED_GRAMMARS, EXPECTED_GRAMMARS, 'the same array, not a copy that agrees today');
  });

  const goodArchive = [
    'extension/package.json',
    'extension/dist/extension.js',
    'extension/node_modules/repo-tour/package.json',
    'extension/node_modules/repo-tour/schema/build-plan.schema.json',
    ...['extract', 'digest', 'skins', 'llm', 'ask', 'types'].map((m) => `extension/node_modules/repo-tour/dist/${m}.js`),
    'extension/node_modules/web-tree-sitter/tree-sitter.js',
    'extension/node_modules/web-tree-sitter/tree-sitter.wasm',
    ...REQUIRED_GRAMMARS.map((g) => `extension/node_modules/tree-sitter-wasms/out/tree-sitter-${g}.wasm`),
  ];

  test('a properly vendored archive satisfies every requirement', () => {
    const results = checkRequiredContent(goodArchive);
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed, [], `unmet: ${failed.map((f) => f.id).join(', ')}`);
  });

  test('the pre-T-8 archive — no node_modules at all — fails on every count', () => {
    // Eleven files, 129 KB, and an extension that reports "core NOT found" on any machine
    // without a sibling repo-tour checkout. This is what AC2 was measured against.
    const results = checkRequiredContent([
      'extension.vsixmanifest', 'extension/package.json', 'extension/readme.md',
      'extension/LICENSE.txt', 'extension/NOTICE', 'extension/start.sh',
      'extension/build-tutorials', 'extension/media/icon.svg',
      'extension/dist/extension.js', 'extension/dist/doctor.js',
    ]);
    assert.ok(results.every((r) => !r.ok), 'nothing about that archive should have passed');
  });

  test('dropping ONE grammar fails, and names which one', () => {
    // The write-ahead risk this whole requirement exists for: a .vsix missing a grammar
    // installs, activates, and stays silent until the first real digest.
    for (const dropped of REQUIRED_GRAMMARS) {
      const results = checkRequiredContent(
        goodArchive.filter((e) => !e.endsWith(`tree-sitter-${dropped}.wasm`)),
      );
      const failed = results.filter((r) => !r.ok);
      assert.deepEqual(failed.map((f) => f.id), [`grammar-${dropped}`]);
      assert.ok(failed[0]?.why.includes(dropped));
    }
  });

  test('a repo-tour whose dist was never built fails, even with the package.json present', () => {
    const results = checkRequiredContent(goodArchive.filter((e) => !e.includes('/repo-tour/dist/')));
    assert.deepEqual(results.filter((r) => !r.ok).map((f) => f.id), ['core-dist']);
  });

  test('web-tree-sitter without its own .wasm runtime fails', () => {
    const results = checkRequiredContent(goodArchive.filter((e) => !e.endsWith('web-tree-sitter/tree-sitter.wasm')));
    assert.deepEqual(results.filter((r) => !r.ok).map((f) => f.id), ['web-tree-sitter-wasm']);
  });
});
