// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-61 (b), ruled 2026-11-17: what a file a MODEL wrote may not reach for, whatever the repository's own code imports. The
 * modules that start a program, open a raw socket, run code from text or reach into the runtime, and the calls that do the
 * same with no import at all. Both engines judge a model's file through `refusalForFile` (Mode A's `derivePlan`, the
 * replan's `divergePlan`), so it is pinned here against repo-tour's REAL `extract`, in both languages and both rule sets.
 * An intent check, never a sandbox: the learner is told to read the code first (T-61 a).
 */

import * as assert from 'node:assert/strict';
import { loadCore, resolveCoreRoot, type CoreLoadResult } from '../../src/core.js';
import { dialCoreFor, type DialCore } from '../../src/dial/core.js';
import { extractAll, MODE_A_IMPORTS, REPO_IMPORTS, refusalForFile, type ImportRules } from '../../src/derive/engine.js';
import type { CodeLanguage } from '../../src/derive/types.js';

let dialCore: DialCore;

suiteSetup(async () => {
  const loaded: CoreLoadResult = await loadCore(resolveCoreRoot('../repo-tour', process.cwd()));
  assert.equal(loaded.found, true, loaded.reason ?? 'repo-tour should be found at the sibling checkout');
  dialCore = dialCoreFor(loaded.loaded);
});

async function judged(file: string, content: string, language: CodeLanguage, rules: ImportRules): Promise<string | null> {
  const extracts = await extractAll(dialCore, [{ path: file, content }]);
  if (typeof extracts === 'string') assert.fail(extracts);
  const refused = refusalForFile({ path: file }, content, extracts.get(file), new Set(), new Set([file]), language, rules);
  return refused === null ? null : refused.refused;
}

const AUTHORS_ROAD = /code a model writes may not, so this step keeps the author.s road/;

suite('a file a model wrote may not start a program, open a raw socket, run text as code, or reach into the runtime (T-61 b)', () => {
  const js: Array<[string, string, RegExp]> = [
    ['child_process', "import { execSync } from 'child_process';\nexport const run = () => execSync('true');\n", /child_process.*starts other programs/],
    ['node:child_process', "import { spawn } from 'node:child_process';\nexport const run = () => spawn('true');\n", /node:child_process/],
    ['worker_threads', "import { Worker } from 'worker_threads';\nexport const w = Worker;\n", /worker_threads/],
    ['cluster', "import cluster from 'cluster';\nexport const c = cluster;\n", /cluster/],
    ['vm', "import vm from 'vm';\nexport const r = (s) => vm.runInNewContext(s);\n", /"vm".*runs text as code/],
    ['inspector', "import inspector from 'inspector';\nexport const i = inspector;\n", /inspector/],
    ['dgram', "import dgram from 'dgram';\nexport const d = dgram;\n", /dgram.*network connections of its own/],
    ['net', "import net from 'net';\nexport const n = net;\n", /"net"/],
    ['tls', "import tls from 'node:tls';\nexport const t = tls;\n", /tls/],
    ['process.binding', "export const b = () => process.binding('spawn_sync');\n", /process\.binding/],
    ['process.dlopen', "export const d = (m, f) => process.dlopen(m, f);\n", /process\.dlopen/],
    ['repl (the security review, SF1)', "import repl from 'node:repl';\nexport const r = () => repl.start();\n", /node:repl.*runs text as code/],
    ['eval', "export const e = (s) => eval(s);\n", /calls eval/],
    ['Function', "export const f = (s) => Function(s)();\n", /calls Function/],
    ['new Function', "export const f = (s) => new Function(s)();\n", /calls Function/],
  ];
  for (const [name, code, said] of js) {
    for (const [rulesName, rules] of [['a replan', REPO_IMPORTS], ['Mode A', MODE_A_IMPORTS]] as const) {
      test(`JavaScript, ${name}, in ${rulesName}: refused in one sentence that says why and what the learner keeps`, async () => {
        const reason = await judged('src/run.js', code, 'javascript', rules);
        assert.ok(reason !== null, `${name} passed the check`);
        assert.match(reason, said);
        assert.match(reason, AUTHORS_ROAD);
      });
    }
  }

  // CommonJS, which only a replan's rules allow (Mode A's files are ES modules and refuse require outright).
  test('JavaScript, a CommonJS require of child_process, in a replan: refused in one sentence', async () => {
    const reason = await judged('src/run.cjs', "const { execSync } = require('child_process');\nmodule.exports = () => execSync('true');\n", 'javascript', REPO_IMPORTS);
    assert.ok(reason !== null, 'require(\'child_process\') passed the check');
    assert.match(reason, /child_process/);
    assert.match(reason, AUTHORS_ROAD);
  });

  const py: Array<[string, string, RegExp]> = [
    ['subprocess', 'import subprocess\n\ndef run():\n    return subprocess.run(["true"])\n', /subprocess.*starts other programs/],
    ['multiprocessing', 'import multiprocessing\n\nPOOL = multiprocessing\n', /multiprocessing/],
    ['socket', 'import socket\n\nS = socket\n', /socket.*network connections of its own/],
    ['ctypes', 'import ctypes\n\nC = ctypes\n', /ctypes.*reaches into the runtime/],
    ['pty', 'import pty\n\nP = pty\n', /pty/],
    ['os.system', 'import os\n\ndef run():\n    os.system("true")\n', /calls os\.system/],
    ['os.popen', 'import os\n\ndef run():\n    return os.popen("true")\n', /calls os\.popen/],
    ['os.execv', 'import os\n\ndef run():\n    os.execv("/bin/true", ["true"])\n', /calls os\.exec/],
    ['os.spawnl', 'import os\n\ndef run():\n    os.spawnl(os.P_WAIT, "/bin/true", "true")\n', /calls os\.spawn/],
    ['from os import system', 'from os import system\n\ndef run():\n    system("true")\n', /os\.system/],
    ['eval', 'def run(s):\n    return eval(s)\n', /calls eval/],
    ['exec', 'def run(s):\n    exec(s)\n', /calls exec/],
    ['compile', 'def run(s):\n    return compile(s, "x", "exec")\n', /calls compile/],
    // T-61's security review, SF1: named vectors the first list missed.
    ['os.fork', 'import os\n\ndef run():\n    return os.fork()\n', /calls os\.fork/],
    ['os.forkpty', 'import os\n\ndef run():\n    return os.forkpty()\n', /calls os\.fork/],
    ['os.posix_spawn', 'import os\n\ndef run():\n    os.posix_spawn("/bin/true", ["true"], {})\n', /calls os\.spawn/],
    ['asyncio.create_subprocess_exec', 'import asyncio\n\nasync def run():\n    await asyncio.create_subprocess_exec("true")\n', /calls asyncio\.create_subprocess/],
    ['asyncio.create_subprocess_shell', 'import asyncio\n\nasync def run():\n    await asyncio.create_subprocess_shell("true")\n', /calls asyncio\.create_subprocess/],
    ['asyncio.open_connection', 'import asyncio\n\nasync def run():\n    await asyncio.open_connection("example.invalid", 80)\n', /calls asyncio\.open_connection.*network connections/],
  ];
  for (const [name, code, said] of py) {
    test(`Python, ${name}: refused in one sentence that says why and what the learner keeps`, async () => {
      const reason = await judged('app/run.py', code, 'python', REPO_IMPORTS);
      assert.ok(reason !== null, `${name} passed the check`);
      assert.match(reason, said);
      assert.match(reason, AUTHORS_ROAD);
    });
  }

  test('what an app may still use passes: http, https, fs, path, events; re.compile, obj.eval, retrieval(), a "Function" type', async () => {
    for (const [file, code, language] of [
      ['src/serve.js', "import http from 'http';\nimport https from 'node:https';\nimport fs from 'fs';\nimport path from 'path';\nimport { EventEmitter } from 'events';\nexport const s = [http, https, fs, path, EventEmitter];\nconst retrieval = (x) => x;\nexport const r = (o) => o.eval(retrieval(1));\n", 'javascript'],
      ['src/types.ts', "export type Handler = Function;\nexport const call = (h: Handler): unknown => h;\n", 'typescript'],
      ['app/text.py', 'import re\nimport os\n\nPATTERN = re.compile(r"x")\nHERE = os.path.dirname(__file__)\n', 'python'],
      // asyncio itself is ordinary async Python: only its subprocess and raw-socket calls are refused.
      ['app/tasks.py', 'import asyncio\n\nasync def main():\n    await asyncio.sleep(0)\n\nasyncio.run(main())\n', 'python'],
    ] as Array<[string, string, CodeLanguage]>) {
      assert.equal(await judged(file, code, language, REPO_IMPORTS), null, `${file} was refused`);
    }
  });

  test('the words are about the model\'s code: a sentence that names one of them in a comment or a string is not refused', async () => {
    const js = "// we do not use child_process or eval( here\nexport const note = 'process.binding( is not called';\n";
    assert.equal(await judged('src/notes.js', js, 'javascript', REPO_IMPORTS), null);
    const py = '# no subprocess, no os.system( here\nNOTE = "eval( is not called"\n';
    assert.equal(await judged('app/notes.py', py, 'python', REPO_IMPORTS), null);
  });
});
