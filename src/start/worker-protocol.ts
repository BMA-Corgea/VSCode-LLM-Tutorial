// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What crosses the thread boundary between the extension host and the build worker (T-30).
 * No `vscode` import and no `node:worker_threads` import: the publish check reads this file's
 * path constant, and both sides of the boundary read its types.
 */

/** Where esbuild puts the worker, relative to the extension's root. The one place this is written. */
export const BUILD_WORKER_RELATIVE = 'dist/build-worker.js';

/** Which repo-tour the worker loads: the root `loadCore` already resolved on the host. */
export interface BuildWorkerData {
  coreRoot: string;
}

export type WorkerRequest =
  | { id: number; kind: 'digest'; root: string; opts: { write?: boolean; outDir?: string } }
  /** `digest` is present only when the caller passed a digest other than the one the worker holds. */
  | { id: number; kind: 'plan'; digest?: unknown; opts: { root: string; witness?: boolean } };

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string };
