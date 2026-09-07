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

## src/detour/narrator.ts

- Exports: BACK_LABEL, BAD_RANGE_LABEL, CONTROL_STAND_IN, DETOUR_ASIDE, FILES_HEADING, FIRST_STOP_HINT, LAST_STOP_HINT, MAX_LABEL_TEXT, MAX_ROWS_RENDERED, MAX_STOP_TEXT, NARRATOR_TITLE, NEXT_LABEL, NOT_TEXT_MESSAGE, NO_FILES_MESSAGE, NO_STOPS_MESSAGE, PREV_LABEL, TRUNCATION_MARKER, domainSentence, linesLabel, narratorScript, parseNarratorMessage, renderNarratorHtml, rowsOmittedMessage, stopProgressMessage
- Imports: (none)

## src/detour/panel.ts

- Exports: NarratorPanel, detourAdaptersFor
- Imports: (none)

## src/detour/prompt.ts

- Exports: DETOUR_PROMPT_VERSION, MAX_DETOUR_INSTRUCTIONS_CHARS, MAX_DETOUR_PATH_CHARS, MAX_DETOUR_PATH_SEGMENTS, MAX_DETOUR_PROMPT_CHARS, MAX_DETOUR_REPLY_CHARS, detourLineCount, detourPrompt, isDetourRefusal, parseDetourReply, prepareDetourWrite, refusalSentence, unsafeDetourPathReason
- Imports: (none)

## src/detour/session.ts

- Exports: DetourSession, tabPrefixes
- Imports: (none)

## src/detour/store.ts

- Exports: MAX_CACHE_BYTES, MAX_CACHE_ENTRIES, detourCachePath, detourDir, detoursRoot, isDetourWriteRefused, pruneDetourCache, readCachedDetour, removeDetour, removeDetourAt, sanitizeDetour, tutorialId, writeCachedDetour, writeDetourFiles
- Imports: (none)

## src/detour/types.ts

- Exports: DETOUR_LIMITS
- Imports: (none)

## src/dial/check.ts

- Exports: referenceExtract, runCheck
- Imports: (none)

## src/dial/commit.ts

- Exports: TUTORIAL_DIR_IGNORE, TUTORIAL_IGNORE_HEADER, commitStep, commitSubject, ensureRepo, ensureTranscriptIgnored, identityConfigured
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

## src/tutor/ask.ts

- Exports: AskLedger, DEFAULT_TIMEOUT_MS, FETCH_UNIMPLEMENTED_DETAIL, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, askTutor, askWithPrompt, boundedTimeoutMs, checkReachable, isFetchRequestReply, startAsk, startPromptAsk, withoutFetchProtocol
- Imports: (none)

## src/tutor/context.ts

- Exports: MAX_CONTEXT_CHARS, MAX_DIFF_CHARS, MAX_DIFF_INPUT_BYTES, MAX_OPTIONS_SENT, MAX_OPTION_TEXT, MAX_PAGE_TEXT, MAX_PROMPT_TEXT, MAX_TURN_CHARS, NOT_ONE_FILE, NOT_TEXT_MESSAGE, NO_DIFFERENCE, NO_FILE_YET, Outbound, diffNote, optionsOmittedNote, renderOptionsText, textCutNote, tooBigToDiff, turnCutNote, tutorContext
- Imports: (none)

## src/tutor/core.ts

- Exports: tutorCoreFor
- Imports: (none)

## src/tutor/transcript.ts

- Exports: MAX_TURNS_KEPT, appendTurn, clearTranscript, getTranscript, sanitizeTranscript, sentTurns
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

- Exports: MAX_ASK_TEXT, NOTHING_TO_ASK_MESSAGE, askTooLongMessage, handleStepMessage, parseStepMessage
- Imports: (none)

## src/walk/step-view.ts

- Exports: ASK_BUTTON_LABEL, ASK_PLACEHOLDER, AUTHOR_BADGE, CANCEL_BUTTON_LABEL, CHECK_HEADING, CHECK_PARSE_MESSAGE, CLEAR_BUTTON_LABEL, DETOUR_BACK_LABEL, DETOUR_BUTTON_LABEL, DETOUR_REGENERATE_HINT, DETOUR_REGENERATE_LABEL, DETOUR_UNREACHABLE_MESSAGE, DETOUR_WAITING_MESSAGE, EXPORTS_HEADING, FILE_MISSING_MESSAGE, IMPORTS_HEADING, MAX_CHECK_TEXT, MAX_LIST_ROWS, MAX_OPTIONS_RENDERED, MAX_PLAN_TEXT, MAX_REPLY_TEXT, MAX_TURNS_RENDERED, NOTE_TURN_LABEL, NOT_TEXT_MESSAGE, NO_HISTORY_MESSAGE, PREPARING_MESSAGE, REPLY_TRUNCATION_MARKER, REPRODUCE_BUTTON_LABEL, SHAPE_EMPTY_MESSAGE, SHAPE_HEADING, SHAPE_NOTE_MESSAGE, T10_BADGE, THINKING_MESSAGE, TRUNCATION_MARKER, TUTOR_EMPTY_MESSAGE, TUTOR_HEADING, TUTOR_TURN_LABEL, UNKNOWN_CHECK_STATUS_MESSAGE, UNKNOWN_WHY_SOURCE_MESSAGE, USER_TURN_LABEL, detourElsewhereMessage, listOmittedMessage, optionsOmittedMessage, renderNoticeHtml, renderStepHtml, reproduceOfferMessage, stepRenderKey, stepScript, turnsOmittedMessage
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
