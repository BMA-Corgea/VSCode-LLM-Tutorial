// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DetourSession — the state machine behind *Show me an unrelated example* (T-7, ACs 2, 3, 5).
 *
 * One instance per `WalkSession`, holding at most one detour at a time. It generates a worked
 * example in a domain deliberately unlike the learner's, writes it to the extension's own
 * global storage, opens those files as real editor tabs with a narrator beside them, walks the
 * stops, and — on the way back — closes exactly what it opened and deletes what it wrote.
 *
 * **No `vscode` import, value or type**, for the reason `src/walk/session.ts` states at length:
 * `esbuild.mjs`'s `test/unit/*.test.ts` bundle marks `repo-tour` and `mocha` external and
 * deliberately NOT `vscode`, so one such import fails the build and takes the whole unit suite
 * with it. Everything this file cannot do by itself is a plain function on `DetourAdapters`,
 * exactly as `WalkAdapters` is — which is what lets the lifecycle below be driven at full
 * strength with no extension host anywhere near it.
 *
 * ── The four rules this file is built on, and what breaks if one is dropped ──────────────────
 *
 * **1. There is ONE writer, and it is `writeDetourFiles`** (`./store.ts`).
 *
 * This file used to carry a second one. `store.ts` spent a paragraph arguing that the root
 * handed to `writeTextAtomic` must be the PROVEN store rather than the composed detour
 * directory — because a planted `detours/<hash> -> /somewhere` makes the attacker's folder the
 * root of the containment question and every write through it is perfectly "contained" — and
 * `writeDetourFiles` obeyed it, and had no caller. The code that shipped was this file's own
 * `writeDetour`, which passed the composed directory. Driven: swap the directory for a link
 * between the check and the write and the file lands outside with nothing thrown. The suite
 * could not see it, because the tests that prove the rule were attached to the function that
 * obeys it and nobody runs.
 *
 * The reason given for the split was real — `writeDetourFiles` CLEARS the directory as its
 * first act and `prepareDetourWrite` needs it to exist, so "gate, then write" could not
 * compose through it — and the answer was to move the clearing inside the one writer, which is
 * where it is now. **Two write paths that disagree about a security-critical argument is not a
 * design; it is a defence and a bug shipped side by side.**
 *
 * What that one writer guarantees, and this file therefore does not re-implement:
 * `prepareDetourWrite` before every write with its RETURNED path used (the lexical half is
 * re-run inside it, the parent is resolved before and after creation, the final component is
 * `lstat`ed); the detour directory resolved AND compared against the proven store; and
 * `writeTextAtomic` rooted at that proven store.
 *
 * **2. The generation is a paid request and goes through `AskLedger`** (plan R2). Not through
 * `askTutor`, not through `startAsk`, and not through `core.runLlm`: `ledger.open(stepId)` and
 * then `ticket.sendPrompt`, so this request is in `spend()`, is drawn by the panel, is stopped
 * by *Cancel* from any step, and dies with the session. T-6 built that ledger because five
 * separate entry points each had their own partial answer to "what stops a runaway billed
 * request"; a sixth would reintroduce the whole class.
 *
 * **3. The cache is consulted BEFORE the provider is probed** (AC5). "Retaking is free" is not
 * only about tokens: a learner who generated a detour yesterday and uninstalled `claude` today
 * should still be able to reopen it. So a hit costs no probe, no ticket and no model call — and
 * the AC5 test's "zero runner calls" is a floor rather than the whole claim. The reachability
 * probe still gates the ASK, which is where it belongs and where AC4's honesty rule put it.
 *
 * **4. Nothing lands after the moment it belonged to.** Every `await` is followed by a
 * `stopped()` check, and `stopped()` asks three questions rather than one: has this session
 * been disposed, has this ticket been abandoned, and has a NEWER detour been started since.
 * The third is what T-6's reviews would have called superseding: two presses of the button, or
 * a press and then a navigation, must not race each other into the same directory. A
 * superseded generation that has already written files removes them again, so a detour that
 * was cancelled has left nothing anywhere — no directory, no tabs, no narrator, no note.
 *
 * **5. The model call does not hold the walk's chain** (T-7 code review, finding 3).
 *
 * `start` is two halves with a wait between them, and the split is T-6's `beginAsk`/
 * `deliverAsk` verbatim. The first half runs on the walk's serialised chain and returns as
 * soon as the request is SENT: the ticket is open, `generating` is set, the panel has been
 * pushed to, so the press is visible in one chain hop. The wait then runs beside the chain,
 * and what comes back is put BACK on it (`deps.resume`) — because parsing, writing files and
 * opening tabs are exactly the things that belong on one serialised chain, and waiting is
 * exactly the thing that does not.
 *
 * T-7 shipped with the whole model call awaited inside the chain job, for up to
 * `tutorTimeoutSeconds` — capped at 3,600. Driven, with a generation in flight: `session.ask(…)`
 * produced zero pushes, zero probes, no note, `thinking === false` and no ticket, and
 * `step:check`, `dial:set`, `tutor:clear`, `reproduce:run` and `detour:back` all queued behind
 * it identically. Nothing about `beginAsk` had regressed; it simply never got to run.
 *
 * **A queue makes a control correct and says nothing about whether it is responsive**, and
 * "is this press visible yet" has to be re-asked every time something new is allowed to occupy
 * the queue. `test/unit/walk-session.test.ts` pins the property in the form that survives a
 * change of mechanism — *while a model call is in flight, the walk's other controls stay
 * live* — rather than in terms of `enqueue`, because a test written against the mechanism can
 * be satisfied by a new mechanism that reintroduces the bug.
 *
 * ── Honest controls (`.autodev/conventions.md`) ──────────────────────────────────────────────
 *
 * Every refusal this file can produce carries a SENTENCE, because both T-6 reviews found
 * "refused with no sentence" to be the failure mode that hides bugs, and because `./prompt.ts`
 * and `./store.ts` went to the trouble of returning specific reasons for exactly this purpose.
 * `refusalSentence` turns each `DetourRefusal` into something a learner can act on.
 *
 * The sharpest case is the RETURN. Closing a tab is the one thing here that can fail for a
 * reason nobody controls, and the promise *Back to my build* makes — "this leaves nothing
 * behind" — must not quietly become half true. So a tab that will not close does not stop the
 * return: the directory is still deleted, the walk still comes back, and the learner is TOLD
 * which tab is still open. A silent partial failure would be the dishonest version of the same
 * mechanism.
 */

import path from 'node:path';
import { checkReachable, type AskLedger, type AskOutcome, type AskSettings, type AskTicket } from '../tutor/ask.js';
import type { PlanLike, StepLike } from '../walk/model.js';
import type { NarratorViewState } from './narrator.js';
import {
  DETOUR_PROMPT_VERSION,
  detourPrompt,
  isDetourRefusal,
  parseDetourReply,
  refusalSentence,
} from './prompt.js';
import {
  isDetourWriteRefused,
  readCachedDetour,
  removeDetour,
  writeCachedDetour,
  writeDetourFiles,
  type DetourCacheKey,
  type DetourKey,
} from './store.js';
import type { Detour } from './types.js';

/**
 * `refusalSentence` lives in `./prompt.ts` now — beside the `DETOUR_LIMITS` it quotes (code
 * review finding 11: it hard-coded `at most 5`, `at most 60` and `between 3 and 6` while the
 * prompt and the parser both interpolated the constant, so a changed limit would have left the
 * panel stating a rule nothing enforced) and out of the way of the import `store.ts` needs in
 * order to be the one writer. Re-exported rather than moved out of reach: drawing a refusal is
 * still this layer's vocabulary, and a caller holding a `DetourRefusal` looks here for its
 * sentence.
 */
export { refusalSentence } from './prompt.js';

// ── what this file cannot do by itself ──────────────────────────────────────────────────────

/**
 * The editor and the narrator, as plain functions — `WalkAdapters`'s shape and its reasoning.
 * `src/detour/panel.ts` passes the real thing; a unit test passes fakes that record what they
 * were handed, which is the whole behaviour of a state machine whose job is which surface gets
 * what and in which order.
 */
export interface DetourAdapters {
  /** `context.globalStorageUri.fsPath` — the folder AC2 is about. Never the workspace. */
  globalStorageRoot: string;
  /**
   * Open one written detour file as a real editor tab (AC2: "opened as real editor tabs").
   *
   * `preview: false` so the tabs STACK rather than replacing one another — a three-file
   * example opened in preview mode is one tab that ends up showing the third file, which is
   * not a worked example, it is a file. `preserveFocus` so the learner keeps the caret they
   * had; the narrator is what they are meant to be reading.
   */
  openDetourTab(absPath: string): Promise<void>;
  /**
   * Bring one stop's file to the front, scroll its range into view and decorate it. Lines are
   * 1-based and inclusive (`./types.ts`).
   */
  revealDetourStop(absPath: string, startLine: number, endLine: number): Promise<void>;
  /**
   * Close every editor tab whose file sits under one of `prefixes`, and NOTHING else (AC3:
   * "closes the detour's tabs" — only those).
   *
   * Returns the paths it could not close, which is why this answers a value rather than
   * `void`: a tab with unsaved changes, or one VS Code simply declines to close, is a real
   * outcome the learner has to be told about rather than a failure to swallow.
   */
  closeTabsUnder(prefixes: string[]): Promise<string[]>;
  /** Show the narrator webview, or re-render the one already up, from this state. */
  showNarrator(state: NarratorViewState): void;
  /** Close the narrator. Safe when there is none, and called on every path out. */
  closeNarrator(): void;
  /** The resolved skin, stamped by the host before first paint (conventions.md). */
  skin(): string;
}

/** Everything the session needs that is not an adapter: the ledger that owns paid requests,
 *  the settings one is sent with, and the push that redraws the step panel. */
export interface DetourDeps {
  adapters: DetourAdapters;
  /**
   * The walk's ledger — plan R2. Handed in rather than created here so that the detour's
   * request and the tutor's are in ONE set: `spend()` counts both, *Cancel* stops both, and
   * disposing the walk closes both.
   */
  ledger: AskLedger;
  /** `WalkSession.tutorSettingsNow` — `undefined` when repo-tour will not load or no tutor is
   *  wired, which is an honest answer rather than an error. */
  settings(): Promise<AskSettings | undefined>;
  /** Redraw the step panel. Called on every state change, exactly as `WalkSession.refresh` is
   *  the only way state leaves that object. */
  refresh(): void;
  /** The provider could not be reached, in ITS words — carried up so the walk can keep the
   *  standing line beside the input that T-6 already draws (`TutorView.unreachable`). */
  reportUnreachable(detail: string): void;
  /**
   * Which TUTORIAL this session's detours belong to — `tutorialId(target, plan)`
   * (`./store.ts`), computed once by the walk.
   *
   * **Every path this session touches is keyed by it**, and that is T-7's two merge-blocking
   * findings in one field: `globalStorageUri` is per-EXTENSION, a repo-tour step id carries no
   * repository identity, and so two tutorials sharing a file path shared a detour directory and
   * a cache entry by construction. See `store.ts`'s header, section 0.
   *
   * A string rather than the target and the plan, because this file must not have an opinion
   * about what identifies a tutorial — it has one key and it uses it everywhere.
   */
  tutorial: string;
  /**
   * Put a job back on the walk's serialised chain (rule 5).
   *
   * This is the whole of the fix to code review finding 3. `WalkSession.startDetour` enqueues
   * the FIRST half of `start`, which returns as soon as the request is sent; the wait then runs
   * beside the chain and hands the outcome back through here, so that parsing, writing and
   * opening tabs still happen serialised with everything else the walk does, and no other
   * control waits on a model. `WalkSession` passes its own `enqueue`; a unit harness passes
   * something that runs the job.
   */
  resume(job: () => Promise<void>): void;
}

/** What the panel draws about the detour. Every field here joins `stepRenderKey` (plan R4) —
 *  a field rendered and missing from that key is stored on the host and never shown, which is
 *  this repository's most-repeated lesson and fails no test. */
export interface DetourView {
  /** a generation is in flight for THIS step: the button says so and cannot be pressed */
  generating: boolean;
  /** a detour is open right now — on this step or another one */
  open?: { stepId: string; title: string };
  /** why the last attempt was refused, or what the last return could not finish */
  note?: string;
}

/**
 * What `start` did. `note` is a sentence for the panel in both arms: a refusal has to explain
 * itself, and a detour that opened with one file refused has to say that too rather than
 * presenting four files as though five had been asked for.
 *
 * **`note: ''` means "nothing to say", and there are exactly two ways to get it**: the press
 * was superseded (something newer is already on the learner's screen, and a stale fact stated
 * confidently under a live one is worse than silence), or — since rule 5 — the request is
 * still IN FLIGHT and its answer will arrive through `deps.resume`. The two are told apart by
 * `view(stepId).generating`, which is what the panel draws and therefore what a test about the
 * press being visible should be asserting anyway.
 *
 * The sentence itself is NOT the walk's to store. `DetourSession` records every note it
 * returns (`this.note` → `DetourView.note` → `#detour-note`), so a caller that also put it
 * through `setTutorNote` drew it twice, verbatim, one line apart — code review finding 5. When
 * a lower layer already stores what it returns, the upper layer's job is to route it.
 */
export type DetourStartResult =
  | { started: true; title: string; note?: string }
  | { started: false; note: string };

/** What `returnToBuild` did. `title` is what the transcript note records (AC4). */
export type DetourReturnResult =
  | { returned: true; stepId: string; title: string; note?: string }
  | { returned: false; note: string };

/** One live detour. `dir` is the COMPOSED path (`store.ts`'s `detourDir`) and `realDir` the
 *  resolved one; both are kept because both are prefix-matched against a tab's URI. See
 *  `tabPrefixes`. */
interface OpenDetour {
  /** the whole key, carried rather than recomposed: `closeOpen` runs on paths where the
   *  session may already have moved on, and a delete aimed at a key rebuilt from current state
   *  is how one detour removes another's files (see `store.ts`'s header, section 0) */
  key: DetourKey;
  stepId: string;
  detour: Detour;
  dir: string;
  realDir: string;
  /** the written files, in `detour.files` order — `abs` is `prepareDetourWrite`'s answer */
  files: Array<{ path: string; abs: string }>;
  current: number;
}

// ── saying why ──────────────────────────────────────────────────────────────────────────────

/** One sentence out of several, or nothing at all. `undefined` rather than `''` so the view's
 *  optional `note` really is absent when there is nothing to say — `stepRenderKey` treats
 *  absent and empty as different states, and only one of them is true. */
function joined(sentences: string[]): string | undefined {
  return sentences.length === 0 ? undefined : sentences.join(' ');
}

/** What a thrown thing says, the way `src/walk/session.ts`'s `messageOf` says it. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : String(err);
}

/**
 * The reference repository as the model should hear it named — its own FOLDER NAME, which is
 * exactly what `tutorContext` puts in `AskContext.repo`
 * (`path.basename(path.resolve(refRoot))`).
 *
 * The two have to agree: a learner who asks the tutor about their build and then asks for an
 * unrelated example is describing one project, and a prompt that called it `my-repo` in one
 * breath and `https://github.com/…/my-repo.git` in the next is asking the model to avoid two
 * different things. A folder name is also the smallest true answer — the raw `repo` field of
 * `request.json` can be a URL with a token in it, and this string is going to a paid third
 * party.
 *
 * Anything that is not a usable string falls through unchanged, so `Outbound.text` gives its
 * own honest sentence for it rather than this inventing a second one.
 */
function referenceName(refRoot: unknown): unknown {
  if (typeof refRoot !== 'string' || refRoot.trim().length === 0) return refRoot;
  return path.basename(path.resolve(refRoot));
}

/** A path as a learner sees it — relative to the detour's own folder, so a sentence about a
 *  tab that would not close names `coins.ts` rather than 90 characters of global storage. */
function shortPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === '' || rel.startsWith('..') ? abs : rel;
}

// ── the session ─────────────────────────────────────────────────────────────────────────────

export class DetourSession {
  private disposed = false;

  /** The live detour, or nothing. At most one: a second `start` supersedes the first rather
   *  than stacking, because two narrators walking two examples is not a feature. */
  private open: OpenDetour | undefined;

  /** Which step a generation is running for, and the ticket behind it — the pair `TutorView`
   *  keeps for the same reason: `generating` is derived from it rather than tracked beside it,
   *  so there is no second flag anybody can forget to clear. */
  private generating: { stepId: string; ticket: AskTicket } | undefined;

  /**
   * Bumped at the top of every `start` and every `returnToBuild` — `StepDecorator.revealSeq`,
   * and its reasoning holds word for word: its only job is to be DIFFERENT from the number an
   * in-flight call is holding, so a superseded generation can tell that it is one. Never
   * reset, not even by `dispose`, because a reset is precisely how a stale call would find its
   * number valid again and resume writing.
   */
  private seq = 0;

  /** A sentence about the last thing that happened, for the panel. Not keyed by step: a
   *  detour is a whole-window event (it opens tabs and a narrator), so its news belongs on
   *  whichever step the learner is looking at when it lands. */
  private note: string | undefined;

  constructor(private readonly deps: DetourDeps) {}

  /** What the panel draws — see `DetourView`, and plan R4 for why every field of it has to be
   *  in `stepRenderKey`. Always a value, never `undefined`: "no detour, nothing generating" is
   *  a real state the page draws (it is what puts the button there). */
  view(stepId: string): DetourView {
    return {
      generating: this.generating?.stepId === stepId,
      ...(this.open ? { open: { stepId: this.open.stepId, title: this.open.detour.title } } : {}),
      ...(this.note !== undefined ? { note: this.note } : {}),
    };
  }

  /** Whether a detour is open, and for which step — the walk asks so it can route *Back to my
   *  build* and refuse to navigate a learner out from under their own tabs. */
  activeStepId(): string | undefined {
    return this.open?.stepId;
  }

  /**
   * The generation in flight, as something to wait on — or `undefined`.
   *
   * `WalkSession.settled()`'s counterpart for the detour, and it exists for exactly the reason
   * that method exists: since rule 5 the model call is NOT on the walk's chain, so draining the
   * chain is no longer draining everything. `settled()` waits for this, and then drains the
   * chain again for the job `resume` put on the end of it.
   *
   * It cannot wait forever — `AskLedger` bounds every deadline and `askWithPrompt` races it, so
   * a request always terminates in an outcome. That is a property of the ledger, and it is what
   * makes this safe to await in a test rather than a way to hang one.
   */
  pending(): Promise<unknown> | undefined {
    return this.generating?.ticket.delivered;
  }

  /**
   * The whole of AC2, in the order the plan sets out: cache or ask, parse, write, tabs,
   * narrator, first stop — **and the model call does not hold the caller's chain** (rule 5).
   *
   * This method is the half that runs ON the chain, and it returns at one of four places: a
   * cache hit that is already on screen, a refusal, a pre-flight that stopped, or the moment
   * the request is SENT. In that last case the answer arrives later, through `deps.resume`,
   * and what this returns is the empty note — the press is visible as `view().generating`,
   * which is what the panel draws.
   *
   * **The cache is asked FIRST** — see this file's header, rule 3. A hit is free in every
   * sense: no probe, no ticket, no model call, and it works on a machine where the provider
   * has since been uninstalled. `fresh` is the one thing that skips it: *Write a new example*
   * is the spec's promised “regenerate” control, and a cache with no way to force a miss is
   * what made a stale entry permanent (code review finding 9).
   *
   * Every `await` below is followed by `stopped()`, which is rule 4's whole implementation:
   * the walk being disposed, the learner cancelling, and a SECOND detour having been started
   * all move the same counter. Only the last can leave a directory behind, which is why the
   * abandoned path in `present` removes what it wrote.
   */
  async start(step: StepLike, plan: PlanLike, refRoot: unknown, opts: { fresh?: boolean } = {}): Promise<DetourStartResult> {
    if (this.disposed) return { started: false, note: 'This tutorial is no longer open.' };

    const stepId = step.id;
    if (this.generating) {
      // **Reachable, and that is the fix rather than an accident.** It used to be unreachable
      // through the panel: `WalkSession.startDetour` awaited the whole model call inside its
      // chain job, so a second press waited its turn, found `generating` already cleared, hit
      // the cache and tore the finished detour down to rebuild it — three tabs closed, a
      // narrator closed, three tabs opened, and no sentence anywhere (code review finding 10).
      // Now the first press returns as soon as the request is sent, so the second press
      // genuinely arrives while one is in flight and is answered.
      return this.refuse('An example is already being written. Wait for it, or press Cancel.');
    }

    const seq = ++this.seq;
    const root = this.deps.adapters.globalStorageRoot;
    const key: DetourKey = { tutorial: this.deps.tutorial, stepId };
    // Built BEFORE the cache is consulted, because the prompt IS the cache key (code review
    // finding 9): a cache is a memo of `prompt -> reply`, so a plan rebuilt with a different
    // question is a miss rather than yesterday's example served silently and forever.
    let prompt: string;
    try {
      prompt = detourPrompt(step, plan, referenceName(refRoot));
    } catch (err) {
      // A prompt builder that throws is a bug in `./prompt.ts`. It is caught here rather than
      // left to escape into a webview message listener with nobody to hear it.
      return this.refuse(`The example could not be asked for — ${messageOf(err)}.`);
    }
    const cacheKey: DetourCacheKey = { ...key, promptVersion: DETOUR_PROMPT_VERSION, prompt };

    // ── AC5: the cache, before anything that costs money or needs a provider ───────────────
    if (opts.fresh !== true) {
      const cached = readCachedDetour(root, cacheKey);
      if (cached !== null) return this.present(key, cached, seq);
    }

    const settings = await this.deps.settings();
    if (this.stopped(seq)) return this.abandonedResult();
    if (!settings) {
      return this.refuse('repo-tour could not be loaded, so there is nobody to ask for an example. Nothing was written.');
    }

    // AC4's honesty rule, applied to this button: the probe runs BEFORE a ticket is sent, so a
    // machine with no provider gets the honest answer in the time it takes to `access()` a file
    // rather than after a wait that reads like the model's fault. The same probe
    // `WalkSession.beginAsk` runs, so the same sentence reaches the same standing line beside
    // the input.
    const availability = await checkReachable(settings);
    if (this.stopped(seq)) return this.abandonedResult();
    if (!availability.ok) {
      this.deps.reportUnreachable(availability.detail);
      return this.refuse(`The model could not be reached, so no example was written and nothing was charged — ${availability.detail}.`);
    }

    // ── R2: the ONLY way a paid request starts ────────────────────────────────────
    const ticket = this.deps.ledger.open(stepId);
    this.generating = { stepId, ticket };
    ticket.sendPrompt(settings, prompt);
    // The push that draws the wait and the *Cancel* beside it. Made with the request already
    // live, so there is no window in which the page says an example is coming and none is —
    // `beginAsk`'s ordering, for `beginAsk`'s reason.
    this.deps.refresh();

    // **The wait runs beside the chain, and the answer goes back ON it.** `delivered` only ever
    // resolves (`src/tutor/ask.ts` builds it by hand); the rejection arm exists so a future edit
    // to that file cannot turn this into an unhandled rejection nobody is listening for.
    void ticket.delivered.then(
      (outcome) => { this.deps.resume(() => this.deliver(cacheKey, ticket, outcome, seq)); },
      () => { this.deps.resume(() => this.deliver(cacheKey, ticket, null, seq)); },
    );
    return { started: false, note: '' };
  }

  /**
   * What came back, on the walk's chain again — T-6's `deliverAsk`, for the detour.
   *
   * `generating` is cleared BEFORE anything is decided about the outcome, exactly as
   * `deliverAsk` clears `this.asking` first: nothing may leave the button drawn un-pressable
   * with no request behind it, which is AC4's rule wearing a different button.
   *
   * The identity check on the ticket is what makes a cancel safe, and it is the same second
   * lock `deliverAsk` keeps: a late outcome from a request the learner walked away from finds
   * a generation that is no longer this one and lands nowhere.
   */
  private async deliver(
    key: DetourCacheKey,
    ticket: AskTicket,
    outcome: AskOutcome | null,
    seq: number,
  ): Promise<void> {
    if (this.generating?.ticket === ticket) this.generating = undefined;
    if (this.stopped(seq)) {
      // Cancelled, superseded or disposed. `cancel()` has already said what stopping cost and
      // the walk has already repainted; there is nothing here to add and a second sentence
      // would be a second vocabulary for one event.
      return;
    }

    if (outcome === null) {
      // **Reachable, and no longer only in theory.** `cancel()` says its own sentence at the
      // press, so this is the OTHER way a ticket ends with nothing delivered: `abandonAll()`
      // reached it from somewhere else — *Cancel* pressed on a tutor question, or
      // `clearConversation` on a step with an ask in flight — which detaches every live
      // request including this one without moving this session's `seq`. It used to carry a
      // sentence that could never be shown, because `cancel()` bumps `seq` and `stopped(seq)`
      // is checked first (code review finding 4).
      this.refuse('That example was stopped before it arrived, so nothing was written.');
      return;
    }
    switch (outcome.kind) {
      case 'unreachable':
        this.deps.reportUnreachable(outcome.detail);
        this.refuse(`The model could not be reached, so no example was written — ${outcome.detail}.`);
        return;
      case 'timedOut':
        this.refuse('The model did not send an example in time. Nothing was written — try again, or raise `buildTutorials.tutorTimeoutSeconds`.');
        return;
      case 'failed':
        this.refuse(`The model could not write an example — ${outcome.detail}. Nothing was written.`);
        return;
      case 'reply':
        break;
    }

    const parsed = parseDetourReply(outcome.text);
    if (isDetourRefusal(parsed)) {
      this.refuse(refusalSentence(parsed));
      return;
    }

    // Cached BEFORE the files are written, so a detour that is superseded halfway through its
    // tabs is still free to retake. `writeCachedDetour` never throws and answers `false` when
    // it declined — a miss costs one regeneration, which is not worth a sentence at somebody
    // who is about to be shown their example.
    writeCachedDetour(this.deps.adapters.globalStorageRoot, key, parsed);
    await this.present({ tutorial: key.tutorial, stepId: key.stepId }, parsed, seq);
  }

  /**
   * Put a validated `Detour` on the learner's screen: write it, open its tabs, raise the
   * narrator, and stop at the first stop.
   *
   * Shared by the cache hit and the fresh generation because they are the same thing from here
   * down — which is the property AC5 depends on. A cached detour that took a different path to
   * the screen would be a second implementation of "open a detour", and the day the two
   * disagreed would be the day a free retake stopped looking like the paid original.
   */
  private async present(key: DetourKey, detour: Detour, seq: number): Promise<DetourStartResult> {
    const stepId = key.stepId;
    // A detour already open is closed first, and it is the PREVIOUS one's tabs and files that
    // go — never this one's. Doing it here rather than at the top of `start` means a
    // generation that fails leaves the detour the learner is reading exactly where it was.
    //
    // Anything the old detour could not finish is CARRIED, not stated and then overwritten: a
    // tab of the previous example that would not close is still open, and the sentence saying
    // so has to survive the sentence about the new one. That is the honest-controls rule read
    // strictly — a partial failure the learner is told about once and then quietly un-told is
    // the same silence with an extra step.
    const carried: string[] = [];
    if (this.open) {
      const closed = await this.closeOpen(this.open);
      if (this.stopped(seq)) return this.abandonedResult();
      if (closed !== undefined) carried.push(closed);
    }

    // **The one writer** (rule 1). Everything the old private `writeDetour` did — the clearing,
    // the store proof, the per-file gate — is inside it, with the containment root this file
    // used to get wrong.
    const written = writeDetourFiles(this.deps.adapters.globalStorageRoot, key, detour);
    if (isDetourWriteRefused(written)) return this.refuse(joined([...carried, written.problem]) ?? written.problem);
    if (this.stopped(seq)) {
      // Superseded between the reply and the tabs. What was written is removed rather than
      // left for the next `start` to inherit: "a detour that is cancelled lands nowhere" is
      // not true of one that left five files in global storage.
      removeDetour(this.deps.adapters.globalStorageRoot, key);
      return this.abandonedResult();
    }

    const notes = [...carried, ...written.problems];
    if (written.written.length === 0) {
      removeDetour(this.deps.adapters.globalStorageRoot, key);
      return this.refuse(joined([...notes, 'None of the example\'s files could be written, so there is nothing to show.']) ?? 'None of the example\'s files could be written.');
    }

    const live: OpenDetour = {
      key,
      stepId,
      detour,
      dir: written.dir,
      realDir: written.realDir,
      files: written.written,
      current: 0,
    };
    // Claimed BEFORE the first await below. A tab that opens after a supersede has to be
    // reachable by the cleanup that supersede runs, and the only handle on it is this object.
    this.open = live;

    for (const file of written.written) {
      try {
        await this.deps.adapters.openDetourTab(file.abs);
      } catch (err) {
        // One tab that will not open does not cost the learner the example. Said out loud,
        // because a stop that narrates a file with no tab behind it would otherwise be a
        // silent hole in the walk.
        notes.push(`${shortPath(live.dir, file.abs)} could not be opened — ${messageOf(err)}.`);
      }
      if (this.stopped(seq) || this.open !== live) {
        await this.closeOpen(live);
        if (this.open === live) this.open = undefined;
        return this.abandonedResult();
      }
    }

    this.note = joined(notes);
    // ONE render, not two. `present` used to raise the narrator here and then again inside
    // `goto(0)`, so `webview.html` was rebuilt twice on every open and every cached retake
    // (code review finding 12). `goto` is the one that knows which stop is being drawn, so it
    // is the one that renders — and it now renders a stop-less detour too, which is what the
    // direct call was quietly covering for.
    await this.goto(0);
    if (this.stopped(seq) || this.open !== live) return this.abandonedResult();

    this.deps.refresh();
    const note = joined(notes);
    return { started: true, title: detour.title, ...(note !== undefined ? { note } : {}) };
  }

  /**
   * *Back to my build* (AC3) — closes the detour's tabs and narrator, deletes its directory,
   * and hands the walk back the title so it can record the note and re-reveal the step.
   *
   * **The order is deliberate and it is the honest one.** The tabs are closed first, because
   * closing a tab whose file has just been deleted is how a learner ends up staring at a
   * "file not found" they did nothing to deserve. Then the narrator, then the delete.
   *
   * **A tab that will not close does not stop the return.** The directory is still deleted and
   * the walk still comes back; what changes is that the learner is TOLD which tab is still
   * open, by name. The alternative — refusing the return until every tab agreed to close —
   * would strand somebody inside a worked example because of an unsaved buffer, and the
   * alternative to THAT — deleting quietly and saying nothing — is the silent partial failure
   * this repository's conventions rule out by name.
   */
  async returnToBuild(): Promise<DetourReturnResult> {
    if (this.disposed) return { returned: false, note: 'This tutorial is no longer open.' };
    const live = this.open;
    // Stored, not only returned — the same rule `refuse` follows and the reason the walk no
    // longer re-records what this hands back (code review finding 5). It also retires the
    // walk's `currentStep(…)?.id ?? ''` fallback, which on a plan with no current step filed
    // the sentence under an id `tutorView` could never match (finding 12).
    if (!live) return this.refuseReturn('There is no example open to come back from.');

    // Supersedes any generation in flight: a learner pressing *Back to my build* while a
    // second example is being written wants to be out of the detour, not deeper into it.
    const seq = ++this.seq;
    this.open = undefined;

    const problem = await this.closeOpen(live);
    if (this.disposed) return { returned: false, note: 'This tutorial is no longer open.' };
    if (this.seq !== seq) {
      // Something newer started while the tabs were closing. It owns the screen now, and this
      // return has already done the only thing it still could — the old detour is gone. No
      // sentence: a stale fact stated confidently under a live one is worse than silence, and
      // the newer detour's own note is what the learner is reading.
      return { returned: false, note: '' };
    }

    this.note = problem;
    this.deps.refresh();
    return {
      returned: true,
      stepId: live.stepId,
      title: live.detour.title,
      ...(problem !== undefined ? { note: problem } : {}),
    };
  }

  /**
   * Close one detour's tabs, its narrator and its directory — the shared body of *Back to my
   * build*, of a supersede and of `dispose`. Answers the sentence the learner needs, or
   * nothing when everything went as promised.
   *
   * **Both spellings of the directory are handed to `closeTabsUnder`**, and that is not
   * belt-and-braces. The tabs were opened at `prepareDetourWrite`'s answers, which sit under
   * the RESOLVED directory; the composed one is what `store.ts` returns and what a caller
   * would naturally prefix-match with. On macOS — where `os.tmpdir()` is under a symlink —
   * those two strings genuinely differ for every legitimate detour, and matching on only one
   * of them would leave every tab open on a whole platform. `removeDetourAt` compares against
   * both spellings for exactly this reason and says so.
   */
  private async closeOpen(live: OpenDetour): Promise<string | undefined> {
    const notes: string[] = [];

    let stuck: string[] = [];
    try {
      stuck = await this.deps.adapters.closeTabsUnder(tabPrefixes(live));
    } catch (err) {
      // A failure to even ask is reported as everything still being open, which is the
      // conservative direction: naming a tab that did close is a small confusion, and
      // silently leaving one open is the thing this whole branch exists to prevent.
      stuck = live.files.map((file) => file.abs);
      notes.push(`The example's tabs could not be closed — ${messageOf(err)}.`);
    }
    if (stuck.length > 0) {
      const names = stuck.map((abs) => shortPath(live.dir, abs));
      notes.push(
        `${names.length === 1 ? 'This tab is' : 'These tabs are'} still open and you will need to close ${names.length === 1 ? 'it' : 'them'} yourself: ${names.join(', ')}.`,
      );
    }

    try {
      this.deps.adapters.closeNarrator();
    } catch (err) {
      notes.push(`The narrator could not be closed — ${messageOf(err)}.`);
    }

    // Deleted whatever the tabs did (see `returnToBuild`). `removeDetour` is the only path by
    // which a step id becomes a recursive delete, and it refuses far more than it needs to.
    const removed = removeDetour(this.deps.adapters.globalStorageRoot, live.key);
    if (!removed.removed && removed.reason !== 'absent' && removed.reason !== 'no-store') {
      notes.push(`The example's files could not be deleted — ${removed.detail}.`);
    }
    return joined(notes);
  }

  // ── walking the stops ─────────────────────────────────────────────────────────────────────

  /**
   * Show stop `n`: redraw the narrator on it, then reveal and decorate its range in its own
   * tab (AC2's "a narrator webview tab walks the stops with reveal + decoration").
   *
   * Clamped rather than refused, exactly as `narrator.ts`'s `resolvedStop` clamps: an index
   * off either end has a stop to show either way, and a narrator that silently stopped
   * responding to *Next* would be the dead control this codebase rules out. Out of range is
   * therefore the LAST stop, not an error.
   *
   * A stop whose file was refused at write time has no tab to reveal into. The narrator still
   * moves — the prose is the point and it is on the page — and nothing is revealed, which is
   * the honest outcome rather than an exception thrown from a button.
   */
  async goto(n: number): Promise<void> {
    const live = this.open;
    if (this.disposed || !live) return;
    const stops = live.detour.stops;

    const at = stops.length === 0 ? 0 : Number.isInteger(n) ? Math.min(Math.max(n, 0), stops.length - 1) : 0;
    live.current = at;
    // The ONE place the narrator is rendered from (code review finding 12). A detour with no
    // stops is still drawn — `narrator.ts` has `NO_STOPS_MESSAGE` and the way out for exactly
    // this case, and a blank screen would be the silent failure this codebase tests for
    // everywhere else.
    this.deps.adapters.showNarrator(this.narratorState(live));

    const stop = stops[at];
    if (!stop) return;
    const file = live.files.find((f) => f.path === stop.file);
    if (!file) return;
    try {
      await this.deps.adapters.revealDetourStop(file.abs, stop.startLine, stop.endLine);
    } catch {
      // The tab was closed by hand, or the document will not open. The narrator has already
      // moved and says where to look; a thrown reveal here would take down a button press.
    }
  }

  /** The next stop, stopping at the last — no wraparound, the same rule `WalkSession.next`
   *  follows, so "Next" never quietly starts the example again. */
  async next(): Promise<void> {
    if (this.open) await this.goto(this.open.current + 1);
  }

  async prev(): Promise<void> {
    if (this.open) await this.goto(this.open.current - 1);
  }

  /**
   * What the narrator draws. `skin` is asked for at the moment of the render rather than
   * captured, so a learner who changes skin mid-detour is obeyed on the next stop.
   *
   * **`files` is what was WRITTEN, not what was parsed** (code review finding 6). The narrator
   * heads that list "The files this detour opened", and it used to be handed the parsed reply —
   * so a file `prepareDetourWrite` refused was named on the page as one that opened, while the
   * step panel's note one tab over said it had been refused. Driven, a reply whose second file
   * collided with the directory the first one made opened one tab and listed two.
   *
   * The STOPS are deliberately left whole. A stop whose file was refused still has prose worth
   * reading and the narrator still moves through it — that is the documented behaviour in
   * `goto` — and filtering here would shift every index under `live.current`.
   */
  private narratorState(live: OpenDetour): NarratorViewState {
    const written = new Set(live.files.map((file) => file.path));
    const files = live.detour.files.filter((file) => written.has(file.path));
    return {
      detour: { ...live.detour, files },
      current: live.current,
      skin: this.deps.adapters.skin(),
    };
  }

  // ── the lifecycle ─────────────────────────────────────────────────────────────────────────

  /**
   * Stop a generation in flight (the walk's *Cancel* reaches this alongside the tutor's), and
   * **say what stopping did** — code review finding 4.
   *
   * It used to say nothing at all. `cancelAsk`'s `!asking` arm refreshed and returned, the
   * sentence written for the cancelled case lived in the delivery path and could never run
   * (`cancel()` bumps `seq`, and `stopped(seq)` is checked first), and driven, a *Cancel* on a
   * detour left `spend() = {sending: 1, unwatched: 1}` with both notes `undefined`. A press
   * that stops a paid request and reports nothing is exactly the shape this file's own
   * neighbouring method calls "the dishonest version of the same mechanism".
   *
   * The two sentences are `cancelAsk`'s, for the detour's button, and the split is the same
   * one: what a cancel MEANS depends on which half of the wait it lands in. Read BEFORE the
   * abandon, because the ticket has moved on by the time the sentence is written. `preparing`
   * is a real cancellation — nothing was sent, so nothing is charged. Only `sending` is still
   * costing money, and `AskSpend.unwatched` is where that goes on being counted.
   *
   * The ticket is abandoned through the LEDGER's own mechanism, so this is the same
   * cancellation the tutor gets and it is counted the same way.
   */
  cancel(): boolean {
    const running = this.generating;
    // Answers whether anything was actually stopped, and the caller needs that rather than a
    // `void`: T-6 proved that *Cancel* with nothing in flight is a no-op — no note, no push —
    // because the answer landed while the press was in the air and the reply now on screen
    // says more than any sentence about it could.
    if (!running) return false;
    this.generating = undefined;
    const wasSending = running.ticket.phase === 'sending';
    running.ticket.abandon();
    this.seq += 1;
    this.note = wasSending
      ? 'You stopped waiting for the example. The model is still finishing it and you will still be billed for it — '
        + 'the example will not appear here.'
      : 'You stopped before the example was asked for, so nothing was sent and nothing was charged.';
    return true;
  }

  /**
   * Should whatever is holding `seq` stop touching anything?
   *
   * Two conditions, one answer, and the second subsumes a third: `disposed` is the walk going
   * away, and a moved `seq` is EITHER a newer detour having been started or the learner having
   * pressed *Cancel* — `cancel()` bumps the counter for precisely that reason, so a cancelled
   * generation and a superseded one take the same road out and neither can be handled without
   * the other. `WalkSession`'s own `stopped()` folds its cases together on the same argument.
   */
  private stopped(seq: number): boolean {
    return this.disposed || this.seq !== seq;
  }

  /** What every superseded path returns. Deliberately note-less: something newer is already
   *  on the learner's screen, and a sentence about a detour they did not end up taking would
   *  be a stale fact stated confidently under a live one. */
  private abandonedResult(): DetourStartResult {
    return { started: false, note: '' };
  }

  /**
   * A refusal that is worth saying: recorded for the panel AND returned.
   *
   * Recorded is the load-bearing half. `DetourView.note` is what `#detour-note` draws, so this
   * one store is the whole of how a refusal reaches the learner — and the walk deliberately
   * does NOT put the returned string through `setTutorNote` any more, which drew every refusal
   * twice, verbatim, in adjacent paragraphs (code review finding 5). It is still returned so a
   * caller can act on the fact of a refusal and a test can read the sentence directly.
   */
  private refuse(note: string): DetourStartResult {
    this.note = note;
    this.deps.refresh();
    return { started: false, note };
  }

  /** `refuse` for the return path — the same one store, a different result shape. */
  private refuseReturn(note: string): DetourReturnResult {
    this.note = note;
    this.deps.refresh();
    return { returned: false, note };
  }

  /** Clear the sentence — the walk calls this when it navigates, for the reason `writeNote`
   *  is cleared on a step change: a note describes an ACTION, not a place. */
  clearNote(): void {
    this.note = undefined;
  }

  /**
   * The walk is going away. Everything this session opened is closed and everything it wrote
   * is deleted, on a best effort — a window closing must not leave a directory of model-written
   * files in global storage and a narrator tab describing a walk that is no longer running.
   *
   * Idempotent, and every method above turns into a no-op afterwards, so a click queued
   * against a replaced session cannot write the old target's detour or repaint a surface the
   * new session has claimed.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.seq += 1;
    this.cancelOnDispose();
    const live = this.open;
    this.open = undefined;
    this.note = undefined;
    if (live) await this.closeOpen(live);
    else {
      try {
        this.deps.adapters.closeNarrator();
      } catch {
        /* there was none, or it is already gone — either way there is nothing to close */
      }
    }
  }

  /** `cancel` without the `seq` bump `dispose` has already made, and without the guard that
   *  would refuse to run on a disposed session. */
  private cancelOnDispose(): void {
    const running = this.generating;
    this.generating = undefined;
    running?.ticket.abandon();
  }
}

/**
 * The two spellings of one detour's folder, as URI prefixes for tab matching — see
 * `closeOpen` for why both are needed and what breaks with only one. De-duplicated because
 * they are the same string on every platform where the storage root is not itself a link, and
 * a caller asked to match twice against one prefix would be doing needless work on the common
 * path.
 */
export function tabPrefixes(live: { dir: string; realDir: string }): string[] {
  return live.dir === live.realDir ? [live.dir] : [live.dir, live.realDir];
}
