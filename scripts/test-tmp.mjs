// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-81: a test run owns its temp folders.
 *
 * Every test run gets ONE private folder, and for the whole run `os.tmpdir()` points inside it: in
 * the test process, in its worker threads, and in every process it starts (VS Code and its
 * extension hosts, git, a fake model). The run removes the folder when it ends, whether it passed,
 * failed, or was stopped with Ctrl-C, SIGTERM or SIGHUP. So nothing a test made is left in the
 * machine's temp folder, nor anything the product made while under test, nor anything VS Code made
 * there for itself. Before this, every unit run left 390 folders and every screen run 34, and three
 * seats filled a shared root disk in one afternoon (2026-11-08).
 *
 * Three doors use it:
 *   - scripts/mocha-test-tmp.mjs, which `.mocharc.cjs` loads into every mocha run started in this
 *     repository, before any test file;
 *   - scripts/run-tests.mjs, which starts the vscode-test hosts inside a run folder, as one process
 *     group, and removes the folder once every process of that group has ended;
 *   - `.vscode-test.mjs`, for `npx vscode-test` started some other way: it owns a folder of its own
 *     unless run-tests.mjs already owns one (`OWNER_ENV`), and removes it when vscode-test exits.
 * scripts/check-tmp.mjs is the check that nothing gets past them.
 *
 * BUILD_TUTORIALS_KEEP_TMP keeps the folder for debugging: `failed` keeps it only when the run
 * fails, `1` (or `true`, `yes`, `on`, `always`) keeps it always, and `0` (or `false`, `no`, `off`,
 * `never`, or nothing) keeps nothing. Any other value keeps nothing, and says so. Where a folder is
 * kept is printed on stderr. By default nothing is kept, after a failure included.
 *
 * What cannot clean up: a run ended by a signal it does not catch (SIGKILL, SIGQUIT, the OOM killer)
 * leaves its one run folder, `bt-test-<door>-XXXXXX`, and nothing else; so does `npx vscode-test`
 * stopped by a signal, when run-tests.mjs is not its parent. And what is not in the temp folder is
 * not this module's: Xvfb's lock in /tmp, and the sockets VS Code keeps in XDG_RUNTIME_DIR.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEEP_ENV = 'BUILD_TUTORIALS_KEEP_TMP';
/** Set in the environment of everything a door starts: the run folder that already owns the temp folder. */
export const OWNER_ENV = 'BUILD_TUTORIALS_TEST_TMP';
export const ROOT_PREFIX = 'bt-test-';
/** The signals a run cleans up on before it dies of them. SIGKILL cannot be caught. */
export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** After the child exits: how long its process group may take to end on its own, then after a SIGTERM, before a SIGKILL. */
export const GROUP_GRACE_MS = 10_000;

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

const KEEP_ALWAYS = ['1', 'true', 'yes', 'on', 'always'];
const KEEP_NEVER = ['', '0', 'false', 'no', 'off', 'never'];

/** Whether `BUILD_TUTORIALS_KEEP_TMP` asks for this run's folder to be kept. An unknown value keeps nothing. */
export function keepWanted(value, failed) {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'failed') return failed;
  return KEEP_ALWAYS.includes(v);
}

/** The words for a `BUILD_TUTORIALS_KEEP_TMP` value nobody will get what they meant from, or `null`. */
export function keepValueProblem(value) {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'failed' || KEEP_ALWAYS.includes(v) || KEEP_NEVER.includes(v)) return null;
  return `${KEEP_ENV}=${value} is not a value it knows (1, failed or 0), so nothing is kept`;
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
 * folder a run could not clean up says where it came from. `startsVsCode`: see `vscodeRunFolderBase`.
 */
export function claimTestTmp(door, { startsVsCode = false } = {}) {
  const base = startsVsCode ? vscodeRunFolderBase(os.tmpdir(), door) : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, `${ROOT_PREFIX}${door}-`));
  const problem = keepValueProblem(process.env[KEEP_ENV]);
  if (problem) process.stderr.write(`[test-tmp] ${problem}\n`);
  let released = false;
  return {
    root,
    /** Every temp variable a platform reads (TMPDIR on POSIX, TMP and TEMP on Windows), pointed here, and the owner. */
    vars: { TMPDIR: root, TMP: root, TEMP: root, [OWNER_ENV]: root },
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

/** Whether any process of the group led by `pgid` is still running. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group has already ended
  }
}

async function groupEnded(pgid, ms) {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Run a child to its end, as a process group of its own, and pass on any SIGINT, SIGTERM or SIGHUP
 * this process gets to that WHOLE group. Resolves when every process of the group has ended, not
 * just the child, so a folder the run was using is never removed while something still runs in it.
 *
 * The whole group, because the child does not always pass a signal on (review F1). The real
 * `xvfb-run` is a dash script: a SIGTERM sent to it alone kills it without its clean-up, and its
 * Xvfb and VS Code ran on, Xvfb for good. In a group of its own, each of them gets the signal.
 *
 * A group still running `GROUP_GRACE_MS` after the child has exited gets SIGTERM, and one still
 * running that long after that gets SIGKILL. They are this process's own children's processes. With
 * stdin closed, because a process group in the background that reads the terminal is stopped.
 *
 * Resolves to `{ code, signal, error, caught }`: the child's exit, a spawn error, and the first
 * signal this process caught, if any. (Windows has no process groups: there the child alone gets
 * the signal, and nothing is waited for after it.)
 */
export function runForwardingSignals(command, args, options) {
  const groups = process.platform !== 'win32';
  return new Promise((resolve) => {
    let caught;
    let child;
    let settled = false;
    const forward = (signal) => {
      caught ??= signal;
      if (child?.pid === undefined) return;
      if (groups) signalGroup(child.pid, signal);
      else child.kill(signal);
    };
    for (const signal of SIGNALS) process.on(signal, forward);
    const done = (result) => {
      if (settled) return;
      settled = true;
      for (const signal of SIGNALS) process.off(signal, forward);
      resolve({ code: null, signal: null, error: undefined, ...result, caught });
    };
    try {
      child = spawn(command, args, { ...options, detached: groups, stdio: options?.stdio ?? ['ignore', 'inherit', 'inherit'] });
    } catch (error) {
      done({ error });
      return;
    }
    child.once('error', (error) => done({ error }));
    child.once('close', (code, signal) => {
      const pgid = child.pid;
      if (!groups || pgid === undefined) {
        done({ code, signal });
        return;
      }
      void (async () => {
        if (!(await groupEnded(pgid, GROUP_GRACE_MS))) {
          signalGroup(pgid, 'SIGTERM');
          if (!(await groupEnded(pgid, GROUP_GRACE_MS))) {
            signalGroup(pgid, 'SIGKILL');
            await groupEnded(pgid, GROUP_GRACE_MS);
          }
        }
        done({ code, signal });
      })();
    });
  });
}

/** Start `command` inside a run folder of its own, and remove the folder once all of it has ended. */
export async function spawnInTestTmp(command, args, door, { startsVsCode = false, ...options } = {}) {
  const claim = claimTestTmp(door, { startsVsCode });
  const result = await runForwardingSignals(command, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    ...options,
    env: { ...(options.env ?? process.env), ...claim.vars },
  });
  claim.release({ failed: result.error !== undefined || result.code !== 0 || result.caught !== undefined });
  return result;
}

/**
 * The vscode-test door for a host started some other way than through run-tests.mjs (review F2):
 * the environment `.vscode-test.mjs` gives its hosts. When run-tests.mjs is the parent, the temp
 * folder is already owned (`OWNER_ENV`) and this adds nothing. Otherwise it owns a folder of its own
 * and removes it when vscode-test exits. A signal is not caught here: vscode-test's own handling of
 * one is left as it is, so `npx vscode-test` stopped by a signal leaves its one run folder.
 */
export function vscodeTestEnv() {
  if (process.env[OWNER_ENV]) return {};
  const claim = claimTestTmp('vscode', { startsVsCode: true });
  process.env[OWNER_ENV] = claim.root;
  process.on('exit', (code) => claim.release({ failed: code !== 0 || (process.exitCode ?? 0) !== 0 }));
  return { TMPDIR: claim.root, TMP: claim.root, TEMP: claim.root };
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
