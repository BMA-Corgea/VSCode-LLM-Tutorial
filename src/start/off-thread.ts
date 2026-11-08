// SPDX-License-Identifier: AGPL-3.0-or-later
/** T-30 skeleton: today's behaviour, so the new tests run and fail on it rather than on a missing export. */
import type { WorkerOptions } from 'node:worker_threads';
import type { BuildCore } from './build.js';

export interface OffThreadDeps {
  /** Absolute path of the bundled worker: `<extensionRoot>/dist/build-worker.js`. */
  workerFile: string;
  /** The repo-tour root `loadCore` resolved. */
  coreRoot: string;
  /** Supplies `interpretPlan` and `defaultCacheDir`, which stay on the host. */
  inProcess: BuildCore;
  /** How often a running phase looks for a cancel. */
  pollMs?: number;
  /** Extra `Worker` options (a test's `resourceLimits`). */
  workerOptions?: WorkerOptions;
  /** Test hooks: a worker thread started, or exited with this code. */
  observe?: { started?: (threadId: number) => void; exited?: (code: number) => void };
}

export function offThreadCore(deps: OffThreadDeps): BuildCore {
  return deps.inProcess;
}
