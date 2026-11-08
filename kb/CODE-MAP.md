# Code Map

The living code map (regenerable, Aider repo-map pattern): modules, their
exported symbols, and local import edges. LOCATE reads this first, then
verifies against reality; BUILD regenerates it at close-out.
Regenerate with `node scripts/code-map.mjs`. Do not hand-edit; changes
will be overwritten.

## scripts/doctor-cli.mjs

- Exports: (none)
- Imports: (none)

## scripts/package.mjs

- Exports: (none)
- Imports: (none)

## scripts/publish.mjs

- Exports: (none)
- Imports: (none)

## scripts/run-tests.mjs

- Exports: (none)
- Imports: (none)

## scripts/verify-install.mjs

- Exports: (none)
- Imports: (none)

## src/core.ts

- Exports: CORE_MODULE_NAMES, DEFAULT_REPO_TOUR_PATH, loadAnyModule, loadCore, resolveCoreRoot
- Imports: (none)

## src/derive/ask.ts

- Exports: askOnce, newTally
- Imports: (none)

## src/derive/assemble.ts

- Exports: MAX_LOAD_BEARING, assemblePlan, boilerplateRanges, lineCountOf, loadBearingRanges, stepIdFor
- Imports: (none)

## src/derive/cache.ts

- Exports: MAX_DERIVE_CACHE_BYTES, MAX_DERIVE_CACHE_ENTRIES, deriveCacheKey, pruneDeriveCache, readCachedReply, writeCachedReply
- Imports: (none)

## src/derive/engine.ts

- Exports: derivePlan, extractAll, replanPlan, unsoundFileReason, unsoundStateReason
- Imports: (none)

## src/derive/graph.ts

- Exports: ancestorsOf, downstreamOf, externalDependencies, insertInOrder, keptBy
- Imports: (none)

## src/derive/prompt.ts

- Exports: DERIVE_INSTRUCTIONS, MAX_DERIVE_INSTRUCTIONS_CHARS, MAX_DERIVE_PROMPT_CHARS, codePrompt, jsonLine, outlinePrompt, parseChapter, parseCodeReply, parseNode, parseOutlineReply, parseReplanReply, quote, readReplyObject, replanPrompt, unsafeDerivedFileReason, unsoundCodeText, validatePlan, withChapterEdges
- Imports: (none)

## src/derive/python-stdlib.ts

- Exports: PYTHON_STDLIB_MODULES
- Imports: (none)

## src/derive/source-scan.ts

- Exports: codeOnly
- Imports: (none)

## src/derive/storage.ts

- Exports: DERIVED_TREES_DIR, DERIVE_CACHE_DIR, lstatOrNull, provenStorageDir
- Imports: (none)

## src/derive/tree.ts

- Exports: treeContentKey, treeSlug, tutorialKey, writeReferenceTree
- Imports: (none)

## src/derive/types.ts

- Exports: DERIVE_LIMITS, DERIVE_PROMPT_VERSION, LANGUAGE_EXTENSION, isDeriveRefusal
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

- Exports: deliverableEntries, fileShape, isRefusal, planWrite, reproduceEntries, reproduceFiles, withheldReason, writeTextAtomic
- Imports: (none)

## src/doctor.ts

- Exports: CLAUDE_ENV_VAR, EXPECTED_GRAMMARS, formatReport, runDoctor
- Imports: (none)

## src/extension.ts

- Exports: activate, deactivate, resumeOnActivate, runBuild
- Imports: (none)

## src/publish/disclosure.ts

- Exports: PATH_RULES, PUBLIC_IDENTITIES, REQUIRED_CONTENT, REQUIRED_GRAMMARS, SECRET_RULES, VACUOUS_NAME_SCAN_FLAG, certifyNameScan, checkArchive, checkContent, checkPaths, checkRequiredContent, isWordScannable, looksTextual, ownerNeedlesFrom, relativeToExtension
- Imports: (none)

## src/publish/index.ts

- Exports: (none)
- Imports: (none)

## src/publish/plan.ts

- Exports: ARTIFACT_PLACEHOLDER, CONFIRM_ENV_VAR, CONFIRM_FLAG, DRY_RUN_FLAG, PINNED_TOOL_VERSIONS, REGISTRIES, commandLine, decidePublish, describeDecision, expectedArtifactName, expectedConfirmation, quoteForShell
- Imports: (none)

## src/relative-path.ts

- Exports: unsafeRelativePathReason
- Imports: (none)

## src/skins.ts

- Exports: BRIDGE_TOKEN_MAP, bridgeCss, pickerHtml, readSkin, writeSkin
- Imports: (none)

## src/start/build-worker.ts

- Exports: (none)
- Imports: (none)

## src/start/build.ts

- Exports: BuildPhaseCancelled, GIT_KILL_GRACE_MS, GIT_TIMEOUT_MS, GitTimeoutError, buildDir, buildFromRequest, completionMessage, coreFor, costLine, detectUnsupportedLanguages, gitRunnerWith, gitTimedOut, gitTimeoutMs, languageRefusalMessage, markerPath, phaseCancelled, readFreshMarker, readMarker, realFsWriteOps, realGit, resolveRepo, resumeIfMarked, writeJsonAtomic
- Imports: (none)

## src/start/off-thread.ts

- Exports: BUILD_WORKER_HEAP_MB, offThreadCore
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

- Exports: SUBMIT_NOTES, renderStartHtml, startScript
- Imports: (none)

## src/start/worker-protocol.ts

- Exports: BUILD_WORKER_RELATIVE
- Imports: (none)

## src/tutor/ask.ts

- Exports: AskLedger, DEFAULT_TIMEOUT_MS, FETCH_UNIMPLEMENTED_DETAIL, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, askTutor, askWithPrompt, boundedTimeoutMs, checkReachable, isFetchRequestReply, startAsk, startPromptAsk, withoutFetchProtocol
- Imports: (none)

## src/tutor/context.ts

- Exports: DIFF_TIMED_OUT, MAX_CONTEXT_CHARS, MAX_DIFF_CHARS, MAX_DIFF_INPUT_BYTES, MAX_OPTIONS_SENT, MAX_OPTION_TEXT, MAX_PAGE_TEXT, MAX_PROMPT_TEXT, MAX_TURN_CHARS, NOT_ONE_FILE, NOT_TEXT_MESSAGE, NO_DIFFERENCE, NO_FILE_YET, Outbound, diffNote, optionsOmittedNote, renderOptionsText, textCutNote, tooBigToDiff, turnCutNote, tutorContext
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

- Exports: FALLBACK_DIAL, MAX_OPTIONS_RENDERED, MAX_OPTION_ID, currentStep, emptyProgress, isOptionKey, markDone, nextStepId, optionsTable, prevStepId, setCheck, setChosen, setCurrent, setDial, statusText, stepDial, treeModel, withChosen
- Imports: (none)

## src/walk/paths.ts

- Exports: resolveInsideTarget
- Imports: (none)

## src/walk/session.ts

- Exports: CHOICE_ALREADY_TAKEN, CHOICE_NOT_AN_OPTION, CHOICE_STALE_PAGE, WalkSession, choiceRefusalText
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

- Exports: ASK_BUTTON_LABEL, ASK_PLACEHOLDER, AUTHOR_BADGE, CANCEL_BUTTON_LABEL, CHECK_HEADING, CHECK_PARSE_MESSAGE, CHOOSE_LABEL, CHOSEN_BADGE, CLEAR_BUTTON_LABEL, DETOUR_BACK_LABEL, DETOUR_BUTTON_LABEL, DETOUR_REGENERATE_HINT, DETOUR_REGENERATE_LABEL, DETOUR_UNREACHABLE_MESSAGE, DETOUR_WAITING_MESSAGE, DIVERGED_NOTE, EXPORTS_HEADING, FILE_MISSING_MESSAGE, IMPORTS_HEADING, MAX_CHECK_TEXT, MAX_LIST_ROWS, MAX_PLAN_TEXT, MAX_REPLY_TEXT, MAX_TURNS_RENDERED, NOTE_TURN_LABEL, NOTICE_HEADING, NOT_TEXT_MESSAGE, NO_HISTORY_MESSAGE, PREPARING_MESSAGE, REPLY_TRUNCATION_MARKER, REPRODUCE_BUTTON_LABEL, SHAPE_EMPTY_MESSAGE, SHAPE_HEADING, SHAPE_NOTE_MESSAGE, THINKING_MESSAGE, TRUNCATION_MARKER, TUTOR_EMPTY_MESSAGE, TUTOR_HEADING, TUTOR_TURN_LABEL, UNKNOWN_CHECK_STATUS_MESSAGE, UNKNOWN_WHY_SOURCE_MESSAGE, USER_TURN_LABEL, detourElsewhereMessage, listOmittedMessage, optionsOmittedMessage, renderNoticeHtml, renderStepHtml, reproduceOfferMessage, stepRenderKey, stepScript, turnsOmittedMessage
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
