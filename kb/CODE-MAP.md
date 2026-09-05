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

- Exports: CORE_MODULE_NAMES, loadAnyModule, loadCore, resolveCoreRoot
- Imports: (none)

## src/doctor.ts

- Exports: CLAUDE_ENV_VAR, formatReport, runDoctor
- Imports: (none)

## src/extension.ts

- Exports: activate, deactivate
- Imports: (none)

## src/skins.ts

- Exports: BRIDGE_TOKEN_MAP, bridgeCss, pickerHtml, readSkin, writeSkin
- Imports: (none)

## src/start/build.ts

- Exports: buildDir, buildFromRequest, completionMessage, coreFor, costLine, detectUnsupportedLanguages, languageRefusalMessage, markerPath, readMarker, realGit, resolveRepo, resumeIfMarked
- Imports: (none)

## src/start/panel.ts

- Exports: StartPanel
- Imports: (none)

## src/start/protocol.ts

- Exports: handleStartMessage
- Imports: (none)

## src/start/request.ts

- Exports: DEFAULT_DIAL, DIALS, IDEA_FIRST_MESSAGE, emptyRequest, parseGithubUrl, validateRequest
- Imports: (none)

## src/start/view.ts

- Exports: renderStartHtml, startScript
- Imports: (none)

## src/webview/html.ts

- Exports: escapeAttr, escapeHtml
- Imports: (none)

## src/webview/page.ts

- Exports: renderPage
- Imports: (none)
