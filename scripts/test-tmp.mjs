// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-81: a test run owns its temp folders.
 *
 * Every test run gets ONE private folder, and for the whole run `os.tmpdir()` points inside it: in
 * the test process, in its worker threads, and in every process it starts (VS Code and its
 * extension hosts, git, a fake model). The run removes the folder when it ends, whether it passed,
 * failed, or was stopped with Ctrl-C or SIGTERM. So nothing a test made is left in the machine's
 * temp folder, nor anything the product made while under test, nor anything VS Code made for
 * itself. Before this, every unit run left 390 folders and every screen run 34, and three seats
 * filled a shared root disk in one afternoon (2026-11-08).
 *
 * Two doors use it:
 *   - scripts/mocha-test-tmp.mjs, which `.mocharc.cjs` loads into every mocha run started in this
 *     repository, before any test file;
 *   - scripts/run-tests.mjs, which starts each vscode-test host inside a run folder.
 * scripts/check-tmp.mjs is the check that nothing gets past them.
 *
 * BUILD_TUTORIALS_KEEP_TMP keeps the folder for debugging: `failed` keeps it only when the run
 * fails, and any other value except `0` and `false` keeps it always. Where it is kept is printed on
 * stderr. By default nothing is kept, after a failure included.
 *
 * A run killed with SIGKILL, or by the OOM killer, cannot clean up. It leaves its one run folder,
 * `bt-test-<door>-XXXXXX`, and nothing else.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEEP_ENV = 'BUILD_TUTORIALS_KEEP_TMP';
export const ROOT_PREFIX = 'bt-test-';
/** The signals a run cleans up on before it dies of them. SIGKILL cannot be caught. */
export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Where the folder of a run that starts VS Code goes: in `tmpdir`, unless VS Code's sockets would
 * not fit inside it.
 *
 * VS Code makes its random IPC sockets as `<tmpdir>/vscode-ipc-<uuid>.sock` on macOS always, and on
 * other Unixes when XDG_RUNTIME_DIR is unset (it prefers that folder when it has one). A Unix
 * socket's path has a hard limit (`sun_path`: 104 bytes on macOS and 108 on Linux, counting the
 * NUL). macOS's own TMPDIR is already about 49 characters, so a run folder nested in it would leave
 * such a socket no room, and the test host would not start. Such a folder goes under /tmp instead,
 * whose parent is short; `mkdtemp` makes it private (0700) there too. Windows uses named pipes,
 * which have no such limit. A run that starts no VS Code always stays in `tmpdir`.
 */
const SOCKET_NAME = 'vscode-ipc-00000000-0000-0000-0000-000000000000.sock';
export function vscodeRunFolderBase(tmpdir, door, platform = process.platform, env = process.env) {
  if (platform === 'win32') return tmpdir;
  if (platform !== 'darwin' && env.XDG_RUNTIME_DIR) return tmpdir;
  const limit = platform === 'darwin' ? 103 : 107;
  const longest = path.join(tmpdir, `${ROOT_PREFIX}${door}-XXXXXX`, SOCKET_NAME);
  return longest.length <= limit ? tmpdir : '/tmp';
}

/** Whether `BUILD_TUTORIALS_KEEP_TMP` asks for this run's folder to be kept. */
export function keepWanted(value, failed) {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  return value === 'failed' ? failed : true;
}

/**
 * Remove a run folder and everything in it, never following a link out of it.
 *
 * `fs.rmSync` alone fails on a folder a test made unwritable and left that way, for example a test
 * that `chmod 0500`s a parent and was stopped before its `finally` put it back. So on a failure,
 * every folder inside is made owner-writable and the removal runs again. Links are `lstat`ed and
 * left alone, because `chmod` would follow one to whatever it points at.
 */
export function removeTree(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch {
    // fall through: make every folder writable, then try once more
  }
  const writable = (dir) => {
    try {
      fs.chmodSync(dir, 0o700);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) writable(path.join(dir, entry.name));
      }
    } catch {
      // a folder this process cannot change is reported by the second removal below
    }
  };
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) writable(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Claim this run's folder. `door` names the run in the folder's name (`unit`, `vscode`), so a
 * folder that a SIGKILL left behind says where it came from. `startsVsCode`: see
 * `vscodeRunFolderBase`.
 */
export function claimTestTmp(door, { startsVsCode = false } = {}) {
  const base = startsVsCode ? vscodeRunFolderBase(os.tmpdir(), door) : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, `${ROOT_PREFIX}${door}-`));
  let released = false;
  return {
    root,
    /** Every temp variable a platform reads (TMPDIR on POSIX, TMP and TEMP on Windows), pointed here. */
    vars: { TMPDIR: root, TMP: root, TEMP: root },
    /** Once only: remove the folder, or keep it and say where when BUILD_TUTORIALS_KEEP_TMP asks. */
    release({ failed }) {
      if (released) return;
      released = true;
      if (keepWanted(process.env[KEEP_ENV], failed)) {
        process.stderr.write(`[test-tmp] kept this run's temp folder (${KEEP_ENV}=${process.env[KEEP_ENV]}): ${root}\n`);
        return;
      }
      try {
        removeTree(root);
      } catch (err) {
        process.stderr.write(`[test-tmp] could not remove this run's temp folder ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    },
  };
}

/**
 * Run a child to its end and pass on any SIGINT, SIGTERM or SIGHUP this process gets, so that
 * stopping this process stops the child too, and this process is still alive to clean up after it.
 * Resolves to `{ code, signal, error, caught }`: the child's exit, a spawn error, and the first
 * signal this process caught, if any.
 */
export function runForwardingSignals(command, args, options) {
  return new Promise((resolve) => {
    let caught;
    let child;
    let settled = false;
    const forward = (signal) => {
      caught ??= signal;
      child?.kill(signal);
    };
    for (const signal of SIGNALS) process.on(signal, forward);
    const done = (result) => {
      if (settled) return;
      settled = true;
      for (const signal of SIGNALS) process.off(signal, forward);
      resolve({ code: null, signal: null, error: undefined, ...result, caught });
    };
    try {
      child = spawn(command, args, options);
    } catch (error) {
      done({ error });
      return;
    }
    child.once('error', (error) => done({ error }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
}

/** Start `command` inside a run folder of its own, and remove the folder when it ends. */
export async function spawnInTestTmp(command, args, door, { startsVsCode = false, ...options } = {}) {
  const claim = claimTestTmp(door, { startsVsCode });
  const result = await runForwardingSignals(command, args, {
    stdio: 'inherit',
    ...options,
    env: { ...(options.env ?? process.env), ...claim.vars },
  });
  claim.release({ failed: result.error !== undefined || result.code !== 0 || result.caught !== undefined });
  return result;
}

/**
 * End this process the way its run ended: by the signal it caught (re-raised now that nothing
 * listens for it, so a calling shell sees a stopped run as stopped), or with the child's status.
 */
export function exitLike({ caught, code }) {
  if (caught !== undefined) {
    process.kill(process.pid, caught);
    // In case something else still listens for that signal: exit as a shell would report it.
    setTimeout(() => process.exit(128 + (os.constants.signals[caught] ?? 0)), 1000).unref();
    return;
  }
  process.exit(code ?? 1);
}
