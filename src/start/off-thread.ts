// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * digest and buildPlan, off the extension host's thread (T-30).
 *
 * The extension host has one thread and every extension in the window runs on it. repo-tour's
 * `digest` and `buildPlan` are synchronous from end to end: no `await` that yields while a
 * repository is read. Run there, they stalled that thread for 10 s on 20,000 Go files and for 45 s
 * on 20,000 TS files (buildPlan the longer half), which is every extension in the window not
 * answering, VS Code logging the host as unresponsive, and a Cancel button that cannot be delivered.
 *
 * So those two phases run in a worker thread, one per build, and this file is the host's side of
 * that. It presents the same `BuildCore`, so `buildFromRequest`'s order of phases does not change.
 * `interpretPlan` stays on the host. It is the phase that already yields, and the model call it
 * awaits is a child process whose lifetime repo-tour tracks in that thread's module state: a worker
 * terminated mid-call would orphan a `claude` process that goes on spending.
 *
 * ## What crosses, and what does not
 *
 * The digest and the plan cross whole, by structured clone, because the host goes on using them:
 * the digest for the language refusal and for `interpretPlan`, the plan for `interpretPlan`. They
 * are plain data, and measured in the real host the worst receipt was 242 ms, a 60,009-step plan.
 * Grammars do not cross: the worker's repo-tour loads its own. A failure crosses as its message,
 * so the words the build reports are unchanged. Nothing that needs a function crosses, because
 * neither phase reports progress.
 *
 * ## Cancel settles here, not when the thread has stopped
 *
 * A phase is synchronous inside the worker, so the worker cannot read a message while it runs.
 * The only way to stop it is `terminate()`, and the only way to hear about a Cancel is to look for
 * it from this side of the boundary, every `CANCEL_POLL_MS`.
 *
 * `terminate()` is two milliseconds on JavaScript, but it cannot interrupt a blocking child: while
 * repo-tour waits synchronously on `git`, the thread cannot be stopped until that call returns
 * (driven: 3,700 ms for a child that had 3,700 ms left to run). So the promise settles on our own
 * timer and `terminate()` is never awaited. What that does not buy: the abandoned thread finishes
 * the call it is in, and if the process then exits it waits for that thread (driven, T-30 review
 * F4: 8 s for an 8 s child). `unref` keeps the event loop from waiting for it, and that is all
 * it keeps. Cancel ends the BUILD at once; it cannot end a native read or a child already running.
 *
 * ## What a worker does not contain
 *
 * Running out of memory ends the worker only if there is a limit to run out of: with none, a
 * worker's limit is the host's own (4 GiB), and driven in the real host reaching it killed the
 * whole extension host (T-30 security review, finding 2). `BUILD_WORKER_HEAP_MB` is that limit. It
 * does not make it certain: one single enormous allocation can still take the host down, driven at
 * a limit, and only a separate process would prevent that. Nor is a read that never ends contained:
 * repo-tour follows a `.gitattributes` symlink, and a native read of `/dev/zero` is neither stopped
 * by `terminate()` nor counted against a heap limit (T-72).
 */

import fs from 'node:fs';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import {
  BuildPhaseCancelled,
  type BuildCore, type BuildPlanLike, type DigestResultLike, type PhaseControl,
} from './build.js';
import type { BuildWorkerData, WorkerReply, WorkerRequest } from './worker-protocol.js';

/** How often a running phase looks for a Cancel. A press lands within this, plus a `terminate()`. */
const CANCEL_POLL_MS = 100;

/**
 * The worker's own heap limit, in megabytes (see "What a worker does not contain", above). Without
 * one it inherits about 4 GiB, which the real host could not survive. Reading and planning 20,000
 * TypeScript files measured about 74 MB of heap at the end, so this is roughly 25 times a
 * very large repository and leaves the host its own memory. A worker that reaches it ends with a
 * sentence and the window goes on.
 */
export const BUILD_WORKER_HEAP_MB = 2_048;

export interface OffThreadDeps {
  /** Absolute path of the bundled worker: `<extensionRoot>/dist/build-worker.js`. */
  workerFile: string;
  /** The repo-tour root `loadCore` resolved. */
  coreRoot: string;
  /** Supplies `interpretPlan` and `defaultCacheDir`, which stay on the host. */
  inProcess: BuildCore;
  /** How often a running phase looks for a Cancel. */
  pollMs?: number;
  /** Extra `Worker` options (a test's `resourceLimits`). */
  workerOptions?: WorkerOptions;
  /** Test hooks: a worker thread started, or exited with this code. */
  observe?: { started?: (threadId: number) => void; exited?: (code: number) => void };
}

/** Each phase in the words the progress notification already uses for it. */
type Phase = 'reading the repository' | 'deriving the build order';

type WorkerRequestBody = Omit<Extract<WorkerRequest, { kind: 'digest' }>, 'id'> | Omit<Extract<WorkerRequest, { kind: 'plan' }>, 'id'>;

export function offThreadCore(deps: OffThreadDeps): BuildCore {
  const pollMs = deps.pollMs ?? CANCEL_POLL_MS;
  let worker: Worker | undefined;
  let nextId = 1;
  /** The digest the worker holds, so a `buildPlan` given that same one need not send it back. */
  let heldDigest: DigestResultLike | undefined;
  /** Why the thread died between two phases, if it did. The next phase answers with this. */
  let diedBecause: string | undefined;

  function startWorker(): Worker {
    const workerData: BuildWorkerData = { coreRoot: deps.coreRoot };
    // `execArgv: []`: the host's own flags (`--experimental-network-inspection`, a debugger's port)
    // are not a worker's to inherit.
    const started = new Worker(deps.workerFile, {
      workerData,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: BUILD_WORKER_HEAP_MB },
      ...deps.workerOptions,
    });
    deps.observe?.started?.(started.threadId);
    // For the thread's whole life, not per phase (T-30 review F2). Each phase takes its own listeners
    // off when it finishes, so a thread that dies straight after answering would be heard by nothing:
    // the next phase would post into a dead thread and wait for ever, and an 'error' with no listener
    // is thrown on this thread, which every extension in the window shares.
    const died = (why: string): void => {
      if (worker !== started) return; // we stopped it ourselves, or a running phase has this already
      worker = undefined;
      heldDigest = undefined;
      diedBecause = why;
    };
    started.on('error', (err: Error) => { died(err.message); });
    started.once('exit', (code) => {
      died(`the build worker exited with code ${code}`);
      deps.observe?.exited?.(code);
    });
    return started;
  }

  /** Lets the thread go, without waiting for it. See this file's header. Safe to call twice. */
  function stopWorker(): void {
    const stopping = worker;
    worker = undefined;
    heldDigest = undefined;
    if (!stopping) return;
    void stopping.terminate().catch(() => undefined);
    stopping.unref();
  }

  function run<T>(body: WorkerRequestBody, phase: Phase, control: PhaseControl | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Checked here because a `Worker` given a file that is not there reports it as an ordinary
      // 'error', which would read as the phase having failed part-way through. This is an install
      // with a file missing, and the person reading the sentence can do something about that.
      if (!fs.existsSync(deps.workerFile)) {
        reject(new Error(`could not start the build: the build worker is missing from this install (${deps.workerFile}); reinstalling the extension should restore it`));
        return;
      }
      if (diedBecause !== undefined) {
        reject(new Error(`${phase} stopped unexpectedly (${diedBecause})`));
        return;
      }
      const running = worker ??= startWorker();
      const id = nextId++;
      let done = false;

      function finish(act: () => void): void {
        if (done) return;
        done = true;
        if (poll !== undefined) clearInterval(poll);
        running.off('message', onMessage);
        running.off('error', onError);
        running.off('messageerror', onError);
        running.off('exit', onExit);
        act();
      }
      function onMessage(reply: WorkerReply): void {
        if (reply.id !== id) return;
        finish(() => { if (reply.ok) resolve(reply.value as T); else reject(new Error(reply.message)); });
      }
      function onError(err: unknown): void {
        finish(() => { stopWorker(); reject(new Error(`${phase} stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`)); });
      }
      function onExit(code: number): void {
        finish(() => { stopWorker(); reject(new Error(`${phase} stopped unexpectedly (the build worker exited with code ${code})`)); });
      }

      running.on('message', onMessage);
      running.on('error', onError);
      running.on('messageerror', onError);
      running.on('exit', onExit);
      const poll = control?.isCancelled === undefined ? undefined : setInterval(() => {
        if (control.isCancelled?.()) finish(() => { stopWorker(); reject(new BuildPhaseCancelled()); });
      }, pollMs);
      try {
        running.postMessage({ id, ...body } satisfies WorkerRequest);
      } catch (err) {
        // Something that cannot be cloned. A throw here would reject the promise and leave the
        // poll running behind it, so this ends the phase the same way every other path does.
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  return {
    async digest(root, opts = {}, control) {
      const value = await run<DigestResultLike>({ kind: 'digest', root, opts }, 'reading the repository', control);
      heldDigest = value;
      return value;
    },
    async buildPlan(digestResult, opts, control) {
      const digest = digestResult === heldDigest ? undefined : digestResult;
      const plan = await run<BuildPlanLike>({ kind: 'plan', digest, opts }, 'deriving the build order', control);
      stopWorker(); // nothing else needs it, and interpretPlan can run for minutes
      return plan;
    },
    interpretPlan: (plan, digestResult, opts) => deps.inProcess.interpretPlan(plan, digestResult, opts),
    defaultCacheDir: () => deps.inProcess.defaultCacheDir(),
    release: stopWorker,
  };
}
