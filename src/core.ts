// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one place repo-tour's core is imported (spec §3, T-1). Everything here is deliberately
 * ignorant of `vscode` — `doctor.ts` and `extension.ts` are the only callers, and the CLI
 * doctor (`scripts/doctor-cli.mjs`) needs this to run with no editor host at all.
 *
 * repo-tour is ESM, `private: true`, and locates its own assets (skins, tree-sitter grammars)
 * with `import.meta.url` — so it must be loaded with dynamic `import()`, never bundled. esbuild
 * is told as much (`external: ['repo-tour']` in esbuild.mjs); this file is where that promise
 * is kept.
 *
 * repo-tour has no `exports` map yet, so today every module is reached at `dist/<mod>.js`.
 * repo-tour T-11 adds one — a subpath like `repo-tour/skins` will then resolve through it. Both
 * shapes are tried, in that order, so this file needs no change when T-11 lands.
 *
 * T-3 adds `build` to the reported set (`repo-tour/build` — digest -> BuildPlan, interpret,
 * check, stubFile; T-1 spec §4). It also exports `loadAnyModule`, a one-off loader for a
 * repo-tour subpath the doctor does not track (T-3's tests need `repo-tour/assets` to exercise
 * `configureAssets` against a temp copy of repo-tour's own asset tree — AC6 — without growing
 * `CORE_MODULE_NAMES`, whose length is the load-bearing count `./build-tutorials doctor`
 * reports). It shares `loadOneModule`'s exact resolution order (scoped exports, then dist/) so
 * there remains exactly one place that knows how to reach into repo-tour, even for a module the
 * doctor itself never asks about.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** repo-tour's public modules, in the order the doctor reports them. */
export const CORE_MODULE_NAMES = ['skins', 'extract', 'llm', 'digest', 'interpret', 'ask', 'types', 'build'] as const;
export type CoreModuleName = (typeof CORE_MODULE_NAMES)[number];

/** How a module actually resolved, once loaded. */
export type ResolutionPath = 'exports' | 'dist';

export interface ModuleLoad {
  name: CoreModuleName;
  ok: boolean;
  via: ResolutionPath | null;
  /** a human sentence: what loaded (export count) or why it did not */
  detail: string;
}

export interface CoreLoadResult {
  /** whether `root` looks like a real repo-tour checkout at all */
  found: boolean;
  root: string;
  version: string | null;
  /** how the modules that DID load mostly got there; null when none loaded */
  via: ResolutionPath | null;
  modules: ModuleLoad[];
  /** set (and names the path tried) exactly when `found` is false */
  reason: string | null;
  /** the loaded module namespace objects, keyed by name — absent where a module failed */
  loaded: Partial<Record<CoreModuleName, unknown>>;
}

/**
 * Turns the `buildTutorials.repoTourPath` setting into an absolute directory.
 *
 * Purely lexical: it never touches the filesystem, so a typo'd setting is not an exception
 * here — it becomes a normal, reportable `loadCore` failure that names the exact path tried.
 *
 *   - absolute setting        -> used as-is
 *   - relative setting        -> resolved against the extension's own install directory
 *   - empty setting (cleared) -> ask Node's ordinary resolution to find the `repo-tour`
 *                                 dependency, since one is always declared in package.json
 */
export function resolveCoreRoot(setting: string, extensionRoot: string): string {
  const trimmed = setting.trim();
  if (trimmed.length === 0) {
    const require_ = createRequire(path.join(extensionRoot, 'package.json'));
    return path.dirname(require_.resolve('repo-tour/package.json'));
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(extensionRoot, trimmed);
}

/** Reads repo-tour's own package.json directly — the found/not-found gate, no resolution involved. */
function readCorePackage(root: string): { version: string } | null {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (pkg.name !== 'repo-tour') return null; // something else lives at this path
    return { version: typeof pkg.version === 'string' ? pkg.version : 'unknown' };
  } catch {
    return null;
  }
}

function describeModule(mod: unknown): string {
  const names = mod !== null && typeof mod === 'object' ? Object.keys(mod) : [];
  return names.length > 0
    ? `${names.length} export${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
    : 'loaded (no runtime exports — a types-only module)';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads one repo-tour subpath both ways and reports which one worked. `name` is a bare
 * module name (`"skins"`, `"build"`, …) — never a path — because this is exactly the
 * `repo-tour/<name>` subpath a real caller would import.
 *
 * The "exports" attempt is scoped to `root` via Node's package self-reference resolution: a
 * `require` constructed as though it lived INSIDE `root` resolves `repo-tour/<name>` through
 * `root`'s own `package.json#exports` — which is exactly what a real subpath import would do,
 * and it means a `repoTourPath` override is honoured rather than whatever `repo-tour` happens
 * to be linked into this extension's own node_modules.
 */
async function resolveAndImport(root: string, name: string): Promise<{ ok: boolean; via: ResolutionPath | null; detail: string; module?: unknown }> {
  try {
    const scoped = createRequire(path.join(root, 'package.json'));
    const resolved = scoped.resolve(`repo-tour/${name}`);
    const mod: unknown = await import(pathToFileURL(resolved).href);
    return { ok: true, via: 'exports', detail: describeModule(mod), module: mod };
  } catch {
    // No exports map yet (today's repo-tour) — fall through to the dist/ path below.
  }
  try {
    const distPath = path.join(root, 'dist', `${name}.js`);
    const mod: unknown = await import(pathToFileURL(distPath).href);
    return { ok: true, via: 'dist', detail: describeModule(mod), module: mod };
  } catch (err) {
    return { ok: false, via: null, detail: errorMessage(err) };
  }
}

async function loadOneModule(root: string, name: CoreModuleName): Promise<ModuleLoad & { module?: unknown }> {
  const result = await resolveAndImport(root, name);
  return { name, ...result };
}

/**
 * A one-off loader for a repo-tour subpath the doctor's own module list does not track (see
 * this file's header). Used by T-3's AC6 test to reach `repo-tour/assets` — `configureAssets`
 * lives there — through the exact same safe, root-scoped resolution `loadCore` itself uses,
 * rather than a second, ad hoc `require`/`import` living in test code.
 *
 * Throws (does not report) on failure: unlike `loadCore`, this is never shown to a user as a
 * doctor line, so there is no report to shape — a caller that reaches for a module this way is
 * expected to handle its own failure.
 */
export async function loadAnyModule(root: string, name: string): Promise<unknown> {
  const result = await resolveAndImport(root, name);
  if (!result.ok) throw new Error(`could not load repo-tour/${name} from ${root}: ${result.detail}`);
  return result.module;
}

/**
 * Loads every public module repo-tour offers, from whichever root the setting resolved to.
 *
 * Never throws. A missing or wrong `root` is a REPORT — `found: false`, `reason` naming the
 * exact path tried — because the doctor's whole job is to say what is wrong, not to crash the
 * extension host over a settings typo.
 */
export async function loadCore(root: string): Promise<CoreLoadResult> {
  const pkg = readCorePackage(root);
  if (!pkg) {
    return {
      found: false,
      root,
      version: null,
      via: null,
      modules: [],
      loaded: {},
      reason: `no repo-tour package.json found at ${root} — check the buildTutorials.repoTourPath setting`,
    };
  }

  const modules: ModuleLoad[] = [];
  const loaded: Partial<Record<CoreModuleName, unknown>> = {};
  for (const name of CORE_MODULE_NAMES) {
    const { module, ...status } = await loadOneModule(root, name);
    modules.push(status);
    if (module !== undefined) loaded[name] = module;
  }

  const okVias = modules.filter((m) => m.ok).map((m) => m.via);
  const via: ResolutionPath | null =
    okVias.length === 0 ? null : okVias.every((v) => v === 'exports') ? 'exports' : 'dist';

  return { found: true, root, version: pkg.version, via, modules, loaded, reason: null };
}
