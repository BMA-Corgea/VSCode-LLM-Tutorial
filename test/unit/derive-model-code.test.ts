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

  // T-61's code review, SF1: TypeScript's import-equals reaches the module the way require does.
  test('TypeScript, import cp = require(\'child_process\'), in a replan: refused in one sentence', async () => {
    const reason = await judged('src/run.ts', "import cp = require('child_process');\nexport const run = () => cp.execSync('true');\n", 'typescript', REPO_IMPORTS);
    assert.ok(reason !== null, 'import cp = require(\'child_process\') passed the check');
    assert.match(reason, /child_process.*starts other programs/);
    assert.match(reason, AUTHORS_ROAD);
  });

  // codeOnly drops a string's contents and a comment, so its offsets are not the file's: the code is found by its own
  // reading at each offset, wherever the statement falls (SF1's read, SF2's type-only check).
  test('TypeScript, import-equals of child_process after a string and a comment: refused all the same (SF1)', async () => {
    const reason = await judged('src/late.ts', "// a note\nconst label = 'run';\nimport cp = require('child_process');\nexport const run = () => cp.execSync(label);\n", 'typescript', REPO_IMPORTS);
    assert.ok(reason !== null, 'a late import cp = require(\'child_process\') passed the check');
    assert.match(reason, /child_process.*starts other programs/);
  });

  test('a nested import the text read must still pass: a relative one, and one inside a docstring (MF1)', async () => {
    const cases: Array<[string, string]> = [
      ['app/nested.py', 'def load():\n    if True:\n        from . import helpers\n        return helpers\n'],
      ['app/doc.py', 'def run():\n    """\n    import subprocess\n    from socket import socket\n    """\n    return 1\n'],
    ];
    for (const [file, code] of cases) {
      const reason = await judged(file, code, 'python', REPO_IMPORTS);
      assert.ok(reason === null || !/starts other programs|network connections/.test(reason), `${file} was refused: ${reason ?? ''}`);
    }
  });

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
    // T-61's code review, MF1: an import deeper than repo-tour's extract reads is read from the text.
    ['subprocess, in a method\'s if', 'class Runner:\n    def run(self):\n        if True:\n            import subprocess\n            return subprocess.run(["true"])\n', /subprocess.*starts other programs/],
    ['subprocess, in a method\'s try', 'class Runner:\n    def run(self):\n        try:\n            import subprocess\n        except ImportError:\n            return None\n        return subprocess\n', /subprocess.*starts other programs/],
    ['socket, in a decorated method', 'import functools\n\nclass Client:\n    @functools.cache\n    def connect(self):\n        import socket\n        return socket\n', /socket.*network connections of its own/],
    ['from subprocess import, two blocks deep in a function', 'def run(flag):\n    if flag:\n        for _ in range(1):\n            from subprocess import run as go\n            go(["true"])\n', /subprocess.*starts other programs/],
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

  // T-61's code review, SF2: honest code that names one of them is not refused, in a sentence that would be false.
  const honest: Array<[string, string, CodeLanguage]> = [
      ['app/calc.py', 'class Calc:\n    def eval(self, node):\n        return node\n\n    def compile(self):\n        return self\n\n    def exec(self, query):\n        return query\n', 'python'],
      ['app/pattern.py', 'from re import compile\n\nPATTERN = compile(r"x+")\n', 'python'],
      ['app/own.py', 'def compile(source):\n    return source\n\nRESULT = compile("x")\n', 'python'],
      ['src/calc.js', 'export class Calc {\n  eval(node) {\n    return node;\n  }\n}\n', 'javascript'],
      ['src/calc.ts', 'export class Calc {\n  static eval(node: string): number {\n    return node.length;\n  }\n}\n', 'typescript'],
      ['src/evaluator.ts', 'export interface Evaluator {\n  eval(expr: string): number;\n}\n', 'typescript'],
      ['src/port.ts', "import type { AddressInfo } from 'node:net';\nexport const port = (a: AddressInfo): number => a.port;\n", 'typescript'],
      ['src/socket.ts', "import { type Socket } from 'net';\nexport type S = Socket;\n", 'typescript'],
      ['src/star.ts', "import type * as net from 'node:net';\nexport type S = net.Socket;\n", 'typescript'],
      ['src/reexport.ts', "export type { Socket } from 'net';\n", 'typescript'],
      // Comment-aware, wherever it falls: a quoted require, and a commented-out value import beside a type-only one.
      ['src/quoted.ts', "const label = 'x';\n// never write require('child_process') here\nexport const run = (): string => label;\n", 'typescript'],
      ['src/commented.ts', "const label = 'x';\n// import net from 'node:net';\nimport type { AddressInfo } from 'node:net';\nexport const port = (a: AddressInfo): string => label + a.port;\n", 'typescript'],
  ];
  for (const [file, code, language] of honest) {
    test(`a definition, a name the module binds, or a type-only import is not refused: ${file} (SF2)`, async () => {
      const reason = await judged(file, code, language, REPO_IMPORTS);
      assert.ok(reason === null || !AUTHORS_ROAD.test(reason), `${file} was refused: ${reason ?? ''}`);
    });
  }

  const beside: Array<[string, string, CodeLanguage, RegExp]> = [
      ['app/calc.py', 'class Calc:\n    def eval(self, node):\n        return node\n\ndef run(s):\n    return eval(s)\n', 'python', /calls eval/],
      ['app/pattern.py', 'from re import compile\n\ndef run(s):\n    return exec(s)\n', 'python', /calls exec/],
      ['src/pick.js', 'export const run = (c, a) => (c ? eval(a) : null);\n', 'javascript', /calls eval/],
      ['src/calc.js', 'export class Calc {\n  eval(node) {\n    return eval(node);\n  }\n}\n', 'javascript', /calls eval/],
      ['src/both.ts', "import type { AddressInfo } from 'node:net';\nimport net from 'node:net';\nexport const s: AddressInfo | typeof net = net;\n", 'typescript', /net.*network connections of its own/],
  ];
  for (const [file, code, language, said] of beside) {
    test(`and a real call or load beside them is still refused: ${file} (SF2)`, async () => {
      const reason = await judged(file, code, language, REPO_IMPORTS);
      assert.ok(reason !== null, `${file} passed the check`);
      assert.match(reason, said);
    });
  }

  // T-61's code review, SF3: code inside a template literal's ${} or an f-string's {} is code, and a wrapped
  // from-import is one import.
  const inside: Array<[string, string, CodeLanguage, RegExp]> = [
    ['src/show.js', 'export const show = (s) => `${eval(s)}`;\n', 'javascript', /calls eval/],
    ['src/run.js', 'export const run = (s) => `${new Function(s)()}`;\n', 'javascript', /calls Function/],
    ['app/show.py', 'def show(s):\n    return f"{eval(s)}"\n', 'python', /calls eval/],
    ['app/run.py', 'from os import (\n    path,\n    system,\n)\n\n\ndef run():\n    system("true")\n', 'python', /os\.system/],
  ];
  for (const [file, code, language, said] of inside) {
    test(`a call inside a template's \${}, an f-string's {}, or a wrapped from-import is read: ${file} (SF3)`, async () => {
      const reason = await judged(file, code, language, REPO_IMPORTS);
      assert.ok(reason !== null, `${file} passed the check`);
      assert.match(reason, said);
    });
  }

  test('and the literal text around a field is still text (SF3)', async () => {
    for (const [file, code, language] of [
      ['src/greet.js', 'export const greet = (n) => `eval( is ${n}`;\n', 'javascript'],
      ['src/nested.js', "export const t = (a) => `x${a ? `y${a}` : 'eval('}z`;\n", 'javascript'],
      ['app/greet.py', 'def greet(n):\n    return f"eval( is {n}"\n', 'python'],
      ['app/braces.py', 'def show():\n    return f"{{eval(x)}}"\n', 'python'],
      ['app/inner.py', 'def show(d):\n    return f"{d[\'eval(\']}"\n', 'python'],
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
