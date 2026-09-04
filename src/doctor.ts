// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The doctor: proves — in plain sentences, never a stack trace — that this machine can
 * actually run the extension (spec §3, §10; T-1's "first thing to prove").
 *
 * No `vscode` import here on purpose. `extension.ts` calls `runDoctor` and writes the result
 * to an output channel; `scripts/doctor-cli.mjs` calls the exact same function with no editor
 * host at all, for `./build-tutorials doctor`. One report, two presentations.
 */

import { CORE_MODULE_NAMES, loadCore, type CoreLoadResult, type ModuleLoad } from './core.js';

export interface GrammarCheck {
  ok: boolean;
  /** the languages we asked repo-tour to load — reported as loaded only when `ok` */
  loaded: string[];
  detail: string;
}

export interface ClaudeCheck {
  ok: boolean;
  path: string | null;
  reason: string | null;
}

export interface DoctorReport {
  core: {
    found: boolean;
    root: string;
    version: string | null;
    via: 'exports' | 'dist' | null;
    reason: string | null;
  };
  modules: ModuleLoad[];
  grammars: GrammarCheck;
  claude: ClaudeCheck;
}

/** The four grammars repo-tour ships (spec §10) — what `extract.initParsers()` loads by default. */
const EXPECTED_GRAMMARS = ['python', 'javascript', 'typescript', 'tsx'];

/** The env var this extension honours for an explicit claude binary — separate from repo-tour's own. */
export const CLAUDE_ENV_VAR = 'BUILD_TUTORIALS_CLAUDE';

interface ExtractModuleShape {
  initParsers(languages?: string[]): Promise<void>;
}

interface LlmModuleShape {
  resolveBin(name: string, envVar: string): string | null;
}

function isExtractModule(mod: unknown): mod is ExtractModuleShape {
  return !!mod && typeof (mod as ExtractModuleShape).initParsers === 'function';
}

function isLlmModule(mod: unknown): mod is LlmModuleShape {
  return !!mod && typeof (mod as LlmModuleShape).resolveBin === 'function';
}

async function checkGrammars(core: CoreLoadResult): Promise<GrammarCheck> {
  const extractMod = core.loaded['extract'];
  if (!isExtractModule(extractMod)) {
    return { ok: false, loaded: [], detail: 'the "extract" module did not load — see modules above' };
  }
  try {
    // initParsers() is all-or-nothing over its language list: repo-tour exposes no way to
    // ask which of several succeeded, so a clean resolve IS the four-grammar guarantee.
    await extractMod.initParsers(EXPECTED_GRAMMARS);
    return { ok: true, loaded: [...EXPECTED_GRAMMARS], detail: `tree-sitter initialised; ${EXPECTED_GRAMMARS.length} grammars loaded` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, loaded: [], detail };
  }
}

function checkClaude(core: CoreLoadResult): ClaudeCheck {
  const llmMod = core.loaded['llm'];
  if (!isLlmModule(llmMod)) {
    return { ok: false, path: null, reason: 'the "llm" module did not load — see modules above' };
  }
  const bin = llmMod.resolveBin('claude', CLAUDE_ENV_VAR);
  if (bin) return { ok: true, path: bin, reason: null };
  return {
    ok: false,
    path: null,
    reason: `not found on PATH or in known install locations (set ${CLAUDE_ENV_VAR} to override)`,
  };
}

/** Runs every check. Never throws — a missing core or claude binary is a REPORT, not a crash. */
export async function runDoctor(repoTourRoot: string): Promise<DoctorReport> {
  const core = await loadCore(repoTourRoot);

  const grammars = core.found
    ? await checkGrammars(core)
    : { ok: false, loaded: [], detail: 'core not found — cannot initialise tree-sitter' };

  const claude = core.found
    ? checkClaude(core)
    : { ok: false, path: null, reason: 'core not found — cannot ask the llm module' };

  return {
    core: { found: core.found, root: core.root, version: core.version, via: core.via, reason: core.reason },
    modules: core.modules,
    grammars,
    claude,
  };
}

/** Renders a report as plain sentences, one per line — what both the output channel and the CLI print. */
export function formatReport(report: DoctorReport): string[] {
  const lines: string[] = ['build-tutorials doctor', ''];

  if (report.core.found) {
    const viaNote =
      report.core.via === 'exports'
        ? 'loaded via its published subpath exports'
        : 'loaded via dist paths (repo-tour has no exports map yet)';
    lines.push(`core found at ${report.core.root}, v${report.core.version ?? 'unknown'} — ${viaNote}`);
  } else {
    lines.push(`core NOT found — ${report.core.reason ?? 'unknown reason'}`);
  }

  lines.push('');
  lines.push(`modules (${CORE_MODULE_NAMES.length} expected):`);
  for (const mod of report.modules) {
    const mark = mod.ok ? 'ok' : 'FAILED';
    lines.push(`  ${mod.name}: ${mark} — ${mod.detail}`);
  }
  if (report.modules.length === 0) lines.push('  (none attempted — core was not found)');

  lines.push('');
  lines.push(
    report.grammars.ok
      ? `grammars: ok — ${report.grammars.detail}`
      : `grammars: FAILED — ${report.grammars.detail}`,
  );

  lines.push(
    report.claude.ok
      ? `claude: found at ${report.claude.path}`
      : `claude: not found — ${report.claude.reason}`,
  );

  return lines;
}
