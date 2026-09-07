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
 * **1. `prepareDetourWrite` before EVERY write, and its RETURNED path is the one used.**
 * `parseDetourReply` does the LEXICAL half of path safety and says so; it is a pure function
 * and lexical is all a pure function can do. `prepareDetourWrite` (`./prompt.ts`) is the
 * filesystem half: it re-runs the lexical check, resolves the deepest existing ancestor BEFORE
 * anything is created, creates the parent, resolves it AGAIN, `lstat`s the final component, and
 * hands back the path under the RESOLVED root. Writing a lexically-checked path without it is
 * T-5's merge-blocking HIGH verbatim — `up -> ../outside` is contained as a string and
 * elsewhere on the disk, and only `realpath` can tell the two apart. So `writeDetour` below
 * writes nothing it did not receive back from that function.
 *
 * *Why not `writeDetourFiles`* (`./store.ts`), which writes a whole `Detour` and is tested: the
 * two cannot compose. `writeDetourFiles` CLEARS the detour directory as its first act, and
 * `prepareDetourWrite` requires that directory to exist in order to resolve it — so "gate, then
 * write" is impossible through it and "write, then gate" is a check that has already had its
 * side effect. What is borrowed from that module instead is every piece the gate does not
 * cover: `removeDetour` for the clearing (which also PROVES `<storage>/detours` is really that
 * directory rather than a link standing where it should be — the one containment question one
 * level above anything model-derived, and the one `prepareDetourWrite` cannot ask), and the
 * cache pair for AC5.
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

import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from '../dial/writer.js';
import { checkReachable, type AskLedger, type AskOutcome, type AskSettings } from '../tutor/ask.js';
import type { PlanLike, StepLike } from '../walk/model.js';
import type { NarratorViewState } from './narrator.js';
import {
  DETOUR_PROMPT_VERSION,
  detourPrompt,
  isDetourRefusal,
  parseDetourReply,
  prepareDetourWrite,
} from './prompt.js';
import { detourDir, readCachedDetour, removeDetour, writeCachedDetour } from './store.js';
import type { Detour, DetourRefusal } from './types.js';

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

/** What `start` did, for the walk to record and say. `note` is a sentence for the panel in
 *  both arms: a refusal has to explain itself, and a detour that opened with one file refused
 *  has to say that too rather than presenting four files as though five had been asked for. */
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
  stepId: string;
  detour: Detour;
  dir: string;
  realDir: string;
  /** the written files, in `detour.files` order — `abs` is `prepareDetourWrite`'s answer */
  files: Array<{ path: string; abs: string }>;
  current: number;
}

// ── saying why ──────────────────────────────────────────────────────────────────────────────

/**
 * A `DetourRefusal` as a sentence for the panel (AC5: "a failed generation says why").
 *
 * `./types.ts` made the refusal a discriminated union rather than a string for exactly this:
 * every arm carries the specific fact a learner would want, so this is a rendering of
 * information that already exists rather than a second guess at what went wrong. The wording
 * blames the model, because the model is what got it wrong — a learner who pressed a button
 * has nothing to fix and should not be handed a sentence that implies they have.
 */
export function refusalSentence(refusal: DetourRefusal): string {
  switch (refusal.reason) {
    case 'not-json':
      return `The model did not answer with the JSON this asks for — ${refusal.detail}. Nothing was written. Try again.`;
    case 'bad-shape':
      return `The model's example did not have the shape this asks for — ${refusal.detail}. Nothing was written. Try again.`;
    case 'too-many-files':
      return `The model sent ${refusal.found} files and a worked example may have at most 5. Nothing was written. Try again.`;
    case 'file-too-long':
      return `The model's ${refusal.path} is ${refusal.lines} lines and a worked example's file may have at most 60. Nothing was written. Try again.`;
    case 'bad-stop-count':
      return `The model sent ${refusal.found} narration stops and this asks for between 3 and 6. Nothing was written. Try again.`;
    case 'stop-file-unknown':
      return `The model narrated a file it never sent (${refusal.file}). Nothing was written. Try again.`;
    case 'bad-range':
      return `The model pointed at lines that are not in ${refusal.file} — ${refusal.detail}. Nothing was written. Try again.`;
    case 'unsafe-path':
      return `The model asked for a file at a path this will not write (${refusal.path}): it ${refusal.detail}. Nothing was written.`;
  }
}

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
  private generating: { stepId: string; abandon: () => void } | undefined;

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
   * The whole of AC2, in the order the plan sets out: cache or ask, parse, write, tabs,
   * narrator, first stop.
   *
   * **The cache is asked FIRST** — see this file's header, rule 3. A hit is free in every
   * sense: no probe, no ticket, no model call, and it works on a machine where the provider
   * has since been uninstalled.
   *
   * Every `await` below is followed by `stopped()`, which is rule 4's whole implementation:
   * the walk being disposed, the learner cancelling, and a SECOND detour having been started
   * all move the same counter. Only the last can leave a directory behind, which is why the
   * abandoned path in `present` removes what it wrote.
   */
  async start(step: StepLike, plan: PlanLike, refRoot: unknown): Promise<DetourStartResult> {
    if (this.disposed) return { started: false, note: 'This tutorial is no longer open.' };

    const stepId = step.id;
    if (this.generating) {
      // Not a silent no-op: the button is drawn as un-pressable while a generation runs, but
      // the page is a repaint behind the host by construction, so a press can still arrive.
      // The same window `WalkSession.beginAsk` keeps its "one question already with the tutor"
      // branch open for, and answered the same way.
      return { started: false, note: 'An example is already being written. Wait for it, or press Cancel.' };
    }

    const seq = ++this.seq;
    const root = this.deps.adapters.globalStorageRoot;

    // ── AC5: the cache, before anything that costs money or needs a provider ───────────────
    const cached = readCachedDetour(root, stepId, DETOUR_PROMPT_VERSION);
    if (cached !== null) return this.present(stepId, cached, seq);

    const settings = await this.deps.settings();
    if (this.stopped(seq)) return this.abandonedResult();
    if (!settings) {
      return { started: false, note: 'repo-tour could not be loaded, so there is nobody to ask for an example. Nothing was written.' };
    }

    // AC4's honesty rule, applied to this button: the probe runs BEFORE a prompt is built and
    // before a ticket is sent, so a machine with no provider gets the honest answer in the
    // time it takes to `access()` a file rather than after a wait that reads like the model's
    // fault. The same probe `WalkSession.beginAsk` runs, so the same sentence reaches the
    // same standing line beside the input.
    const availability = await checkReachable(settings);
    if (this.stopped(seq)) return this.abandonedResult();
    if (!availability.ok) {
      this.deps.reportUnreachable(availability.detail);
      return { started: false, note: `The model could not be reached, so no example was written and nothing was charged — ${availability.detail}.` };
    }

    // ── R2: the ONLY way a paid request starts ─────────────────────────────────────────────
    const ticket = this.deps.ledger.open(stepId);
    this.generating = { stepId, abandon: () => { ticket.abandon(); } };
    this.deps.refresh();

    let outcome: AskOutcome | null;
    try {
      ticket.sendPrompt(settings, detourPrompt(step, plan, referenceName(refRoot)));
      outcome = await ticket.delivered;
    } catch (err) {
      // A prompt builder that throws is a bug in `./prompt.ts`, not a reason to leave a
      // ticket live and a button dead. `sendPrompt` itself is contracted not to throw, so
      // this covers `detourPrompt` and nothing else.
      ticket.abandon();
      if (this.generating?.stepId === stepId) this.generating = undefined;
      return this.refuse(`The example could not be asked for — ${messageOf(err)}.`);
    }
    // Cleared BEFORE anything is decided about the outcome, exactly as `deliverAsk` clears
    // `this.asking` before it chooses a sentence: nothing may leave `generating` true with no
    // request behind it, which is AC4's rule wearing a different button.
    if (this.generating?.stepId === stepId) this.generating = undefined;
    if (this.stopped(seq)) return this.abandonedResult();

    if (outcome === null) {
      // The learner cancelled. `AskTicket.abandon` already said what that costs; there is
      // nothing for this to add and a second sentence would be a second vocabulary for it.
      return { started: false, note: 'You stopped before the example arrived.' };
    }
    switch (outcome.kind) {
      case 'unreachable':
        this.deps.reportUnreachable(outcome.detail);
        return this.refuse(`The model could not be reached, so no example was written — ${outcome.detail}.`);
      case 'timedOut':
        return this.refuse('The model did not send an example in time. Nothing was written — try again, or raise `buildTutorials.tutorTimeoutSeconds`.');
      case 'failed':
        return this.refuse(`The model could not write an example — ${outcome.detail}. Nothing was written.`);
      case 'reply':
        break;
    }

    const parsed = parseDetourReply(outcome.text);
    if (isDetourRefusal(parsed)) return this.refuse(refusalSentence(parsed));

    // Cached BEFORE the files are written, so a detour that is superseded halfway through its
    // tabs is still free to retake. `writeCachedDetour` never throws and answers `false` when
    // it declined — a miss costs one regeneration, which is not worth a sentence at somebody
    // who is about to be shown their example.
    writeCachedDetour(root, stepId, DETOUR_PROMPT_VERSION, parsed);
    return this.present(stepId, parsed, seq);
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
  private async present(stepId: string, detour: Detour, seq: number): Promise<DetourStartResult> {
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

    const written = this.writeDetour(stepId, detour);
    if ('problem' in written) return this.refuse(joined([...carried, written.problem]) ?? written.problem);
    if (this.stopped(seq)) {
      // Superseded between the reply and the tabs. What was written is removed rather than
      // left for the next `start` to inherit: "a detour that is cancelled lands nowhere" is
      // not true of one that left five files in global storage.
      removeDetour(this.deps.adapters.globalStorageRoot, stepId);
      return this.abandonedResult();
    }

    const notes = [...carried, ...written.problems];
    if (written.files.length === 0) {
      removeDetour(this.deps.adapters.globalStorageRoot, stepId);
      return { started: false, note: joined([...notes, 'None of the example\'s files could be written, so there is nothing to show.']) ?? 'None of the example\'s files could be written.' };
    }

    const live: OpenDetour = { stepId, detour, ...written.dirs, files: written.files, current: 0 };
    // Claimed BEFORE the first await below. A tab that opens after a supersede has to be
    // reachable by the cleanup that supersede runs, and the only handle on it is this object.
    this.open = live;

    for (const file of written.files) {
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
    this.deps.adapters.showNarrator(this.narratorState(live));
    await this.goto(0);
    if (this.stopped(seq) || this.open !== live) return this.abandonedResult();

    this.deps.refresh();
    const note = joined(notes);
    return { started: true, title: detour.title, ...(note !== undefined ? { note } : {}) };
  }

  /**
   * The detour on disk — **the file this whole ticket's risk lives in** (AC2).
   *
   * The order is the design, and each step is doing a job the next one cannot:
   *
   *   1. **`removeDetour` first.** It clears any leftover from a session that crashed mid-
   *      detour — step 4 opens *the directory's* files, so a stale file would become a tab in
   *      an example the narration does not describe. It also does something the rest of this
   *      method cannot: `provenStoreRoot` checks that `<storage>/detours` is really that
   *      directory and not a link standing where it should be. That is the one containment
   *      question a level ABOVE anything model-derived, and `prepareDetourWrite` — which
   *      resolves the detour directory it is handed — cannot ask it. A refusal for any reason
   *      other than "there was nothing there" stops everything: a folder we could not prove
   *      enough about to empty is not a folder to fill.
   *   2. **Create the detour directory.** `prepareDetourWrite` resolves it with `realpath`,
   *      which can only answer about a path that exists. Safe HERE and nowhere earlier: step 1
   *      has just established that the store is a real directory and that this detour's own
   *      folder is gone, so there is no planted link left for `mkdir -p` to follow down.
   *   3. **`prepareDetourWrite` per file, and its ANSWER is the path written.** The lexical
   *      half is re-run inside it (`./prompt.ts` re-runs it rather than trusting that the
   *      parser ran — one forgotten call site is how this class of bug returns), the parent is
   *      resolved before and after creation, and the final component is `lstat`ed so a symlink
   *      standing at `coins.ts` is refused rather than written through. **The composed path is
   *      never used**; what comes back sits under the RESOLVED root, which on macOS — where
   *      `os.tmpdir()` is under a symlink — is a genuinely different string for every honest
   *      detour, and the difference is exactly what containment is about.
   *   4. **`writeTextAtomic` with the detour directory as its root.** Temp-file-and-rename, so
   *      a symlink appearing at the destination between step 3's `lstat` and the write is
   *      REPLACED rather than followed. A stat is a moment, not a lock, and this is what makes
   *      the residue between them not matter.
   *
   * One bad file does not cost the learner the others: a refusal becomes a sentence and the
   * rest are written, the same way `writeDetourFiles` and `reproduceFiles` report one entry
   * without dropping the rest.
   */
  private writeDetour(
    stepId: string,
    detour: Detour,
  ): { problem: string } | { dirs: { dir: string; realDir: string }; files: Array<{ path: string; abs: string }>; problems: string[] } {
    const root = this.deps.adapters.globalStorageRoot;
    const dir = detourDir(root, stepId);

    const cleared = removeDetour(root, stepId);
    if (!cleared.removed && cleared.reason !== 'absent' && cleared.reason !== 'no-store') {
      return { problem: `The example's folder could not be cleared, so nothing was written — ${cleared.detail}.` };
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { problem: `The example's folder could not be created, so nothing was written — ${messageOf(err)}.` };
    }
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch (err) {
      return { problem: `Where the example would be written could not be established, so nothing was — ${messageOf(err)}.` };
    }

    const files: Array<{ path: string; abs: string }> = [];
    const problems: string[] = [];
    for (const file of detour.files) {
      // ── The contract. Nothing below writes a path this did not hand back. ───────────────
      const target = prepareDetourWrite(dir, file.path);
      if (isDetourRefusal(target)) {
        problems.push(refusalSentence(target));
        continue;
      }
      try {
        writeTextAtomic(target, file.content, dir);
        files.push({ path: file.path, abs: target });
      } catch (err) {
        problems.push(`${file.path} could not be written — ${messageOf(err)}.`);
      }
    }
    return { dirs: { dir, realDir }, files, problems };
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
    if (!live) return { returned: false, note: 'There is no example open to come back from.' };

    // Supersedes any generation in flight: a learner pressing *Back to my build* while a
    // second example is being written wants to be out of the detour, not deeper into it.
    const seq = ++this.seq;
    this.open = undefined;

    const problem = await this.closeOpen(live);
    if (this.disposed) return { returned: false, note: 'This tutorial is no longer open.' };
    if (this.seq !== seq) {
      // Something newer started while the tabs were closing. It owns the screen now, and this
      // return has already done the only thing it still could — the old detour is gone.
      return { returned: false, note: 'A newer example replaced that one.' };
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
    const removed = removeDetour(this.deps.adapters.globalStorageRoot, live.stepId);
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
    if (stops.length === 0) return;

    const at = Number.isInteger(n) ? Math.min(Math.max(n, 0), stops.length - 1) : 0;
    live.current = at;
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

  /** What the narrator draws. `skin` is asked for at the moment of the render rather than
   *  captured, so a learner who changes skin mid-detour is obeyed on the next stop. */
  private narratorState(live: OpenDetour): NarratorViewState {
    return { detour: live.detour, current: live.current, skin: this.deps.adapters.skin() };
  }

  // ── the lifecycle ─────────────────────────────────────────────────────────────────────────

  /**
   * Stop a generation in flight (the walk's *Cancel* reaches this alongside the tutor's).
   *
   * The ticket is abandoned through the LEDGER's own mechanism, so this is the same
   * cancellation the tutor gets and it is counted the same way: a request already sending goes
   * on running and goes on billing, and `AskSpend.unwatched` is where that is said. Nothing
   * here pretends otherwise.
   */
  cancel(): boolean {
    const running = this.generating;
    // Answers whether anything was actually stopped, and the caller needs that rather than a
    // `void`: T-6 proved that *Cancel* with nothing in flight is a no-op — no note, no push —
    // because the answer landed while the press was in the air and the reply now on screen
    // says more than any sentence about it could. A detour that was cancelled DOES have to
    // repaint (the button is drawn un-pressable until it does), so the two cases are told
    // apart here rather than by a refresh the walk fires either way.
    if (!running) return false;
    this.generating = undefined;
    running.abandon();
    this.seq += 1;
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

  /** A refusal that is worth saying: recorded for the panel AND returned, because the walk
   *  puts it in the step's own note and the panel draws it from the view. */
  private refuse(note: string): DetourStartResult {
    this.note = note;
    this.deps.refresh();
    return { started: false, note };
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
    running?.abandon();
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
