// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * repo-tour's REAL `schema/build-plan.schema.json`, and a checker over the subset of draft-07 it
 * uses — `$ref`, `const`, `enum`, `oneOf`, `type`, `required`/`properties`, `items`/`minItems`.
 *
 * No ajv, for the reason the copies this replaces gave: a small checker over exactly that subset
 * needs no runtime dependency. It mirrors repo-tour's own T-12 test (`test/build.test.ts`, "the
 * JSON schema (AC8)").
 *
 * **Why this is a shared file now, when it used to be copied per test file.** The old note said
 * the duplication was "the deliberate house pattern rather than a shared helper in src/". Its
 * point was keeping test code out of `src/`, and a helper here does that just as well, exactly
 * as `walk-fixtures.ts` does. Two byte-identical copies lived in `walk-model.test.ts` and
 * `build.test.ts`. T-17 (the derivation engine) was about to add a third, for the first plan this
 * extension produces itself, and a third copy is where two checkers stop agreeing about what a
 * plan is. One checker now; every plan this repository makes or reads is held to it.
 *
 * Not a test file, so mocha does not run it on its own. It is bundled into each test that
 * imports it, the way `walk-fixtures.ts` is.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveCoreRoot } from '../../src/core.js';

export type JsonSchema = Record<string, unknown>;

const CORE_ROOT = resolveCoreRoot('../repo-tour', process.cwd());

/** The schema as repo-tour ships it, read from where it ships (testing-the-shipped-value). */
export const BUILD_PLAN_SCHEMA: JsonSchema = JSON.parse(
  fs.readFileSync(path.join(CORE_ROOT, 'schema', 'build-plan.schema.json'), 'utf8'),
) as JsonSchema;

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const parts = ref.replace(/^#\//, '').split('/');
  let cur: unknown = root;
  for (const p of parts) cur = (cur as Record<string, unknown>)[p];
  return cur as JsonSchema;
}

function validateAgainst(root: JsonSchema, schema: JsonSchema, value: unknown, at: string, errors: string[]): void {
  if (typeof schema['$ref'] === 'string') {
    validateAgainst(root, resolveRef(root, schema['$ref']), value, at, errors);
    return;
  }
  if ('const' in schema) {
    if (value !== schema['const']) errors.push(`${at}: expected ${JSON.stringify(schema['const'])}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema['enum'])) {
    if (!schema['enum'].includes(value)) errors.push(`${at}: expected one of ${JSON.stringify(schema['enum'])}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema['oneOf'])) {
    const matches = (schema['oneOf'] as JsonSchema[]).filter((s) => {
      const sub: string[] = [];
      validateAgainst(root, s, value, at, sub);
      return sub.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at}: expected exactly one oneOf branch to match, ${matches.length} did`);
    return;
  }
  if (schema['type'] !== undefined) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    const ok = types.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
      return typeof value === t;
    });
    if (!ok) {
      errors.push(`${at}: expected type ${JSON.stringify(schema['type'])}, got ${JSON.stringify(value)}`);
      return;
    }
  }
  if (schema['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${at}: missing required key "${key}"`);
    }
    const props = (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateAgainst(root, sub, obj[key], `${at}.${key}`, errors);
    }
  }
  if (schema['type'] === 'array' && Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      errors.push(`${at}: expected at least ${schema['minItems']} items, got ${value.length}`);
    }
    if (schema['items']) value.forEach((v, i) => validateAgainst(root, schema['items'] as JsonSchema, v, `${at}[${i}]`, errors));
  }
}

/** Every way `value` fails `schema`, as `$.path: what was wrong` lines; empty means it passes. */
export function validateBuildPlan(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  validateAgainst(schema, schema, value, '$', errors);
  return errors;
}
