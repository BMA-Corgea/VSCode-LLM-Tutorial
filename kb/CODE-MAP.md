# Code Map

The living code map (regenerable, Aider repo-map pattern): modules, their
exported symbols, and local import edges. LOCATE reads this first, then
verifies against reality; BUILD regenerates it at close-out.
Regenerate with `node scripts/code-map.mjs`. Do not hand-edit; changes
will be overwritten.

## scripts/doctor-cli.mjs

- Exports: (none)
- Imports: (none)

## scripts/run-tests.mjs

- Exports: (none)
- Imports: (none)

## src/core.ts

- Exports: CORE_MODULE_NAMES, loadCore, resolveCoreRoot
- Imports: (none)

## src/doctor.ts

- Exports: CLAUDE_ENV_VAR, formatReport, runDoctor
- Imports: (none)

## src/extension.ts

- Exports: activate, deactivate
- Imports: (none)
