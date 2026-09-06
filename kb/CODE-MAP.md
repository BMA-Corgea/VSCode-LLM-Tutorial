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

## src/dial/check.ts

- Exports: referenceExtract, runCheck
- Imports: (none)

## src/dial/commit.ts

- Exports: commitStep, commitSubject, ensureRepo, identityConfigured
- Imports: (none)

## src/dial/core.ts

- Exports: dialCoreFor, languageOf, stubQuestionsFor
- Imports: (none)

## src/dial/writer.ts

- Exports: fileShape, isRefusal, planWrite, reproduceEntries, reproduceFiles, writeTextAtomic
- Imports: (none)

## src/doctor.ts

- Exports: CLAUDE_ENV_VAR, formatReport, runDoctor
- Imports: (none)

## src/extension.ts

- Exports: activate, deactivate, resumeOnActivate
- Imports: (none)

## src/skins.ts

- Exports: BRIDGE_TOKEN_MAP, bridgeCss, pickerHtml, readSkin, writeSkin
- Imports: (none)

## src/start/build.ts

- Exports: buildDir, buildFromRequest, completionMessage, coreFor, costLine, detectUnsupportedLanguages, languageRefusalMessage, markerPath, readFreshMarker, readMarker, realFsWriteOps, realGit, resolveRepo, resumeIfMarked, writeJsonAtomic
- Imports: (none)

## src/start/panel.ts

- Exports: StartPanel
- Imports: (none)

## src/start/protocol.ts

- Exports: handleStartMessage, parseInboundMessage
- Imports: (none)

## src/start/request.ts

- Exports: DEFAULT_DIAL, DIALS, IDEA_FIRST_MESSAGE, emptyRequest, parseGithubUrl, validateRequest
- Imports: (none)

## src/start/view.ts

- Exports: renderStartHtml, startScript
- Imports: (none)

## src/walk/editor.ts

- Exports: StepDecorator
- Imports: (none)

## src/walk/model.ts

- Exports: FALLBACK_DIAL, currentStep, emptyProgress, markDone, nextStepId, prevStepId, setCheck, setCurrent, setDial, statusText, stepDial, treeModel
- Imports: (none)

## src/walk/paths.ts

- Exports: resolveInsideTarget
- Imports: (none)

## src/walk/session.ts

- Exports: WalkSession
- Imports: (none)

## src/walk/status.ts

- Exports: WalkStatusBar
- Imports: (none)

## src/walk/step-panel.ts

- Exports: StepViewProvider
- Imports: (none)

## src/walk/step-protocol.ts

- Exports: handleStepMessage, parseStepMessage
- Imports: (none)

## src/walk/step-view.ts

- Exports: AUTHOR_BADGE, CHECK_HEADING, CHECK_PARSE_MESSAGE, EXPORTS_HEADING, FILE_MISSING_MESSAGE, IMPORTS_HEADING, MAX_CHECK_TEXT, MAX_LIST_ROWS, MAX_OPTIONS_RENDERED, MAX_PLAN_TEXT, NOT_TEXT_MESSAGE, NO_HISTORY_MESSAGE, REPRODUCE_BUTTON_LABEL, SHAPE_EMPTY_MESSAGE, SHAPE_HEADING, SHAPE_NOTE_MESSAGE, T10_BADGE, TRUNCATION_MARKER, UNKNOWN_CHECK_STATUS_MESSAGE, UNKNOWN_WHY_SOURCE_MESSAGE, listOmittedMessage, optionsOmittedMessage, renderNoticeHtml, renderStepHtml, reproduceOfferMessage, stepRenderKey, stepScript
- Imports: (none)

## src/walk/store.ts

- Exports: hasPlan, loadPlan, loadProgress, loadRequest, saveProgress
- Imports: (none)

## src/walk/tree.ts

- Exports: DecisionsTreeProvider, stepMark
- Imports: (none)

## src/webview/html.ts

- Exports: escapeAttr, escapeHtml
- Imports: (none)

## src/webview/page.ts

- Exports: renderPage
- Imports: (none)
