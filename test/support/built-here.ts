// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-92: the record the Start build writes for every tutorial it makes (`recordBuiltReference`,
 * `src/walk/provenance.ts`), written for a fixture a test made by hand.
 *
 * Without it the real extension, correctly, believes no reference for a `request.json` it did not
 * build: the walk opens, says why, and the dial, the check and the tutor read nothing. A vscode-test
 * that wants the honest path writes what the build would have written, in the extension's own
 * global storage, exactly as the build does.
 *
 * Test-only. Nothing under `test/` ships (`.vscodeignore`).
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { recordBuiltReference } from '../../src/walk/provenance.js';

const EXTENSION_ID = 'bma-corgea.build-tutorials';

/** `target` was built from `reference`, in this test host's own extension storage. */
export async function recordBuiltHere(target: string, reference: string): Promise<void> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension "${EXTENSION_ID}" is not installed in the test host`);
  const api = await ext.activate();
  recordBuiltReference(api._context.globalStorageUri.fsPath, target, reference);
}
