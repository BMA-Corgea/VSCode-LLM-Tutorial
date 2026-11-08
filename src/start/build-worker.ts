// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The build's two phases that never yield, on a thread of their own (T-30). `off-thread.ts` is the
 * other side of this file and says why it exists.
 *
 * Loaded by path from the extension's own `dist/`, as a worker thread. There is no `vscode` here and
 * none to be had. repo-tour is loaded from the root the host already resolved (the machine-scoped
 * setting or the packaged default, never a repository), through the one function that knows how to
 * reach into it.
 *
 * Every answer is a message, including a failure: a phase that throws replies with the error's own
 * message, so the build reports the same words it reported when this ran on the host.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { loadAnyModule } from '../core.js';
import type { BuildWorkerData, WorkerReply, WorkerRequest } from './worker-protocol.js';

if (!parentPort) throw new Error('dist/build-worker.js runs as a worker thread, not on its own');
const port = parentPort;
const { coreRoot } = workerData as BuildWorkerData;

/** What this build has read: held here so `buildPlan` does not make the host send it all back. */
let held: unknown;

interface DigestModule { digest: (root: string, opts: { write?: boolean; outDir?: string }) => Promise<unknown> }
interface BuildModule { buildPlan: (digest: unknown, opts: { root: string; witness?: boolean }) => Promise<unknown> }

async function perform(request: WorkerRequest): Promise<unknown> {
  if (request.kind === 'digest') {
    const { digest } = await loadAnyModule(coreRoot, 'digest') as DigestModule;
    held = await digest(request.root, request.opts);
    return held;
  }
  if (request.digest !== undefined) held = request.digest;
  const { buildPlan } = await loadAnyModule(coreRoot, 'build') as BuildModule;
  return buildPlan(held, request.opts);
}

port.on('message', (request: WorkerRequest): void => {
  void (async () => {
    // Posted inside the `try`: a result that cannot be cloned throws right here, and must come back
    // as a failure rather than as silence the host would wait on for ever.
    try {
      const reply: WorkerReply = { id: request.id, ok: true, value: await perform(request) };
      port.postMessage(reply);
    } catch (err) {
      const reply: WorkerReply = { id: request.id, ok: false, message: err instanceof Error ? err.message : String(err) };
      port.postMessage(reply);
    }
  })();
});
