// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The detour's narrator: the webview that WALKS the stops (T-7 AC2), and the message protocol
 * it speaks. Pure — no `vscode` — exactly like `src/walk/step-view.ts`, whose split this file
 * mirrors: a `PAGE_CSS` sheet, a `bodyHtml()` builder, a `CLIENT_SCRIPT` template literal, and
 * the functions `src/detour/session.ts` will call. The real editor tabs beside it show the
 * detour's FILES; this page is the voice that says what to look at and why.
 *
 * The protocol lives here rather than in a file of its own (contrast `src/walk/
 * step-protocol.ts`) because it is three no-payload messages and one state — splitting it
 * would put the shapes this page POSTS one file away from the markup that posts them, which
 * is exactly the distance a drift needs.
 *
 * ── THE SECURITY RULE, and it is the reason this file is reviewed on its own ────────────────
 *
 * **`title`, `domain`, every `stops[].text` and every `files[].path` are MODEL-AUTHORED.** A
 * `Detour` is `JSON.parse`d output from a language model, cast to an interface (see
 * `./types.ts`). It is exactly as untrusted as a tutor's reply, and T-6's AC5 rule applies
 * again, word for word: escape everything, at the point of render, with the one helper this
 * extension has (`src/webview/html.ts`). Four properties hold it up, and each is a line
 * somebody could delete:
 *
 *   1. **Every model string passes through `escapeHtml` exactly once, and lands in a TEXT
 *      NODE.** Not an attribute, not a `class`, not a URL, not `<script>`, not `<style>`,
 *      not the page `<title>`. `test/unit/detour-narrator.test.ts` proves that with a
 *      sentinel sweep of the whole document rather than by reading this sentence.
 *   2. **No attribute on this page is built from anything the model wrote.** There is exactly
 *      one attribute computed at run time — `data-stop`, the ordinal THIS file counted — and
 *      it is an integer by construction (`resolvedStop`). `escapeAttr` is therefore not
 *      imported: an escape would imply there is something here to escape, and the stronger
 *      claim is that there is no attribute for an injection to land in at all. That is the
 *      same reasoning T-6's `answerHtml` uses when it DISCARDS a fence's info string rather
 *      than escaping-and-rendering it.
 *   3. **A file path never becomes a DOM id, a `data-` attribute or an `href`.** The stop list
 *      is `<li>`/`<span>` only: no `<button>`, no `<a>`, no `<input>`. Navigation is
 *      *Previous* / *Next*, which carry no key at all, so the page never needs to name a stop to
 *      the host — and a control that was never rendered cannot be a bug away from carrying a
 *      path (the same argument `src/walk/step-view.ts`'s options list makes about T-10).
 *   4. **Nothing is markup.** Unlike `answerHtml` this page honours no fences and no syntax
 *      whatsoever — a stop's prose is prose, and the code it talks about is in a real editor
 *      tab next door. That is a STRONGER guarantee than T-6's, and it is free here: there is
 *      no parser standing between the model's output and the webview.
 *
 * The client script keeps the same rule on its own side: the one thing that reaches the page
 * without a repaint (`detour:note`) is written with `textContent`, and the script contains no
 * `innerHTML` at all — asserted at the source, because a future edit is the threat.
 *
 * **Control and bidi characters are neutralised, not passed through** (`CONTROL_STAND_IN`).
 * They cannot make markup, so this is not an escaping fix; it is a Trojan-Source one. A
 * learner reads a path here and matches it against a real editor tab, and `U+202E` in a
 * model-chosen filename makes those two disagree while looking identical. The stand-in is
 * VISIBLE rather than a silent deletion, for the reason every cap in this codebase leaves a
 * marker: a page that quietly rewrote what it was given would be misrepresenting it.
 *
 * A nonce CSP and the parse-tested inline script come from `src/webview/page.ts` — the one
 * shell every webview here uses (`.autodev/conventions.md`).
 */

import type { SkinsModule } from '../start/view.js';
import { bridgeCss } from '../skins.js';
import { renderPage } from '../webview/page.js';
import { escapeHtml } from '../webview/html.js';
import type { Detour } from './types.js';

/** The page's own `<title>`. FIXED: the model names the detour, never the tab. */
export const NARRATOR_TITLE = 'Build Tutorials: Detour';

export const PREV_LABEL = 'Previous';
export const NEXT_LABEL = 'Next';
/** AC3's control, worded as the spec words it. */
export const BACK_LABEL = 'Back to my build';

/**
 * Verbatim — a test asserts the exact sentence, never a copy of it.
 *
 * **The second clause is new and it is T-7 security review finding 3.** The sentence used to
 * end at "deletes them", which was true of the tabs and of the detour directory and NOT of the
 * copy: `detours/cache/<hash>.json` holds the same model-written bytes, `removeDetourAt`
 * refuses it by name (correctly), `dispose()` does not touch it, and nothing pruned it — so the
 * page made a promise the code did not keep, which this repository's honest-controls rule does
 * not allow. Both halves moved rather than one: the copy is now bounded
 * (`MAX_CACHE_ENTRIES`, `src/detour/store.ts`) and the page now says it exists.
 *
 * It says WHERE and WHY rather than merely admitting to it, because "a copy is kept" with no
 * reason reads like a leak and the reason is the feature: AC5's free retake IS that copy.
 */
export const DETOUR_ASIDE =
  'These files live outside your project. Going back closes them and deletes them — a copy of the example '
  + 'stays in this extension\'s own storage, outside your project too, so retaking it is free.';

/** The honest line beside a disabled walk control (conventions.md: never a disabled control
 *  with no explanation). Both are FIXED text — nothing the model wrote reaches them. */
export const FIRST_STOP_HINT = 'This is the first stop — there is nothing before it.';
export const LAST_STOP_HINT = 'This is the last stop — Back to my build puts you where you were.';

export const FILES_HEADING = 'The files this detour opened';

/** What the page says when the model gave nothing to walk. A blank page would be the silent
 *  failure this codebase tests for everywhere else; the way OUT is still rendered. */
export const NO_STOPS_MESSAGE = 'This detour arrived with no stops to walk — there is nothing to narrate.';
export const NO_FILES_MESSAGE = 'This detour opened no files.';

/** What stands in for a model string that is not a string at all — `src/walk/step-view.ts`'s
 *  `NOT_TEXT_MESSAGE`, reworded for the one thing that can be blamed here. Not an error and
 *  not a silent blank: "the model wrote nothing readable" is a true sentence; a blank is not. */
export const NOT_TEXT_MESSAGE = '(the model wrote nothing readable here)';

/** Left exactly where a string was cut, so the page never pretends it drew the whole thing. */
export const TRUNCATION_MARKER = '… (cut off here — the model wrote more than this panel draws)';

/** What a stop's line range reads as when it is not a range. Deliberately a SENTENCE and not
 *  `lines NaN–undefined`: the numbers come out of the same JSON as everything else here. */
export const BAD_RANGE_LABEL = 'a range this detour did not describe';

/** U+FFFD. What a control or bidi character is replaced with — see the file header. */
export const CONTROL_STAND_IN = '\uFFFD';

/**
 * How many characters of one model-authored LABEL this page draws — a title, a domain, a file
 * path. 400 is `src/walk/step-view.ts`'s `MAX_CHECK_TEXT`, chosen there for the same
 * population (short model-authored identifiers) and far past anything honest: the spec's own
 * shape asks for a title, a domain name and a relative path inside a five-file example.
 */
export const MAX_LABEL_TEXT = 400;

/**
 * The same for one stop's PROSE — 4,000, `step-view.ts`'s `MAX_REPLY_TEXT`, because a stop is
 * the same population as a tutor turn: a paragraph a model wrote about a few lines of code.
 *
 * Both caps are this page's own defence rather than a duplicate of the parser's. `parseDetourReply`
 * bounds the COUNTS the spec bounds (≤ 5 files, ≤ 60 lines, 3–6 stops) and nothing upstream
 * bounds a single string's LENGTH — so without these, one reply could hand `webview.html = …`
 * a megabyte to build, synchronously, on the extension host (T-4 security review, finding 3).
 */
export const MAX_STOP_TEXT = 4000;

/**
 * How many rows either list draws. The parser already refuses more than 6 stops and 5 files,
 * so this can only fire on a `Detour` that did not come through it — which is exactly why it
 * is here: this file is called by tests and by a session with a hand-built state, and a
 * renderer that trusts its caller to have validated is a renderer with no bound at all.
 */
export const MAX_ROWS_RENDERED = 24;

/** The count of what a list did not draw. A NUMBER, not a vague "and more", so the learner
 *  can tell from the page how much was left out (the whole-codebase rule for a cap). */
export function rowsOmittedMessage(omitted: number, noun: string): string {
  return `${omitted} more ${noun}${omitted === 1 ? '' : 's'} in this detour, not shown here`;
}

/** "Stop 2 of 4" — 1-based, because it is read by a person. */
export function stopProgressMessage(ordinal: number, total: number): string {
  return `Stop ${ordinal} of ${total}`;
}

/** The line under the title. Takes the ALREADY-GUARDED domain text; the caller escapes the
 *  whole composed sentence, so the model's words are escaped exactly once, like every other
 *  string on this page. */
export function domainSentence(domain: string): string {
  return `A worked example in ${domain} — a different problem from yours, on purpose.`;
}

/**
 * A stop's line range, made total. 1-based and inclusive (`./types.ts`), so line 0 is not a
 * line, and an end before its start is not a range — both are things a model really writes,
 * and both would otherwise render as a confident lie about where to look.
 */
export function linesLabel(start: unknown, end: unknown): string {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return BAD_RANGE_LABEL;
  const a = start as number;
  const b = end as number;
  if (a < 1 || b < a) return BAD_RANGE_LABEL;
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}

/** The whole input this file renders. `current` is an index into `detour.stops`; it is typed
 *  `number` and treated as `unknown` anyway (`resolvedStop`), because the session that sets it
 *  is not the only caller and an out-of-range stop must not blank the page. */
export interface NarratorViewState {
  detour: Detour;
  current: number;
  /** the resolved skin name, stamped by the host before first paint (spec §5.7). */
  skin: string;
}

// ── the model's own strings, made safe to BUILD with ────────────────────────────────────────

// Control characters, bidi overrides/isolates and the zero-width family. Newline, tab and
// carriage return are deliberately absent: a stop's prose legitimately contains them.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One model-authored string, made safe to build with — NOT safe to inject with, which is
 * still `escapeHtml`'s job and every caller below still does it. `src/walk/step-view.ts`'s
 * `planText`, with the two differences this file needs: the stand-in blames the model rather
 * than the plan, and control/bidi characters are neutralised (see the file header).
 *
 * The order is load-bearing. Neutralise, then CUT, then the caller escapes — so a cut can
 * never land inside an HTML entity this function had already produced, and the marker can
 * never end up inside anything.
 */
function modelText(value: unknown, max: number): string {
  if (typeof value !== 'string') return NOT_TEXT_MESSAGE;
  const clean = value.replace(UNSAFE_CHARS, CONTROL_STAND_IN);
  return clean.length <= max ? clean : clean.slice(0, max) + TRUNCATION_MARKER;
}

const labelText = (value: unknown): string => modelText(value, MAX_LABEL_TEXT);
const stopText = (value: unknown): string => modelText(value, MAX_STOP_TEXT);

/** `detour.stops` / `detour.files`, as an array whatever the JSON actually held. */
function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * WHICH stop is on screen, made total (`src/walk/step-view.ts`'s `resolvedDial`, same shape
 * and same reason). Clamped rather than refused: a session that has walked off the end has a
 * stop to show either way, and an unhighlighted list with no text under it would be a page
 * that silently stopped working.
 */
function resolvedStop(current: unknown, count: number): number {
  if (count <= 0) return 0;
  if (typeof current !== 'number' || !Number.isInteger(current)) return 0;
  if (current < 0) return 0;
  return current >= count ? count - 1 : current;
}

/** `<path> · <lines a–b>` — both halves model-authored, composed and then escaped ONCE by the
 *  caller, so no part of it can be escaped twice or not at all. */
function stopWhere(stop: unknown): string {
  const rec = isRecord(stop) ? stop : {};
  return `${labelText(rec['file'])} · ${linesLabel(rec['startLine'], rec['endLine'])}`;
}

// ── the page ────────────────────────────────────────────────────────────────────────────────

const PAGE_CSS = `
main { max-width:640px; margin:0 auto; padding:20px 24px 40px; }
h1 { font-size:1.25rem; margin:0 0 4px; }
h2 { font-size:0.95rem; margin:24px 0 8px; }
.detour-domain { margin:0 0 4px; }
.detour-aside { margin:0 0 16px; color:var(--muted); font-size:0.9rem; }
.stop-progress { margin:0 0 8px; font-size:0.9rem; }
.stop-list { list-style:none; margin:0 0 16px; padding:0; }
.stop-list .stop { display:flex; gap:8px; padding:4px 8px; border-left:3px solid transparent; color:var(--muted); }
.stop-list .stop-current { border-left-color:var(--accent, currentColor); color:var(--ink); font-weight:600; }
.stop-ord { min-width:1.5em; text-align:right; }
.stop-where { overflow-wrap:anywhere; }
.stop-now { padding:12px 0; }
.now-where { margin:0 0 8px; font-family:var(--mono, monospace); overflow-wrap:anywhere; }
.stop-text { margin:0; white-space:pre-wrap; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin:20px 0 4px; }
.btn { padding:4px 12px; border-radius:var(--radius, 4px); cursor:pointer; }
.btn[disabled] { cursor:default; opacity:0.5; }
.detour-hint { margin:0 0 8px; min-height:1.2em; color:var(--muted); font-size:0.9rem; }
.note { margin:8px 0; color:var(--muted); }
.rows-omitted { margin:0 0 12px; color:var(--muted); font-size:0.9rem; }
.file-list { margin:0; padding-left:20px; }
.file-path { overflow-wrap:anywhere; }
.empty { color:var(--muted); }
`;

/** The stop list — `<li>`/`<span>` only. See property 3 in the file header: there is nothing
 *  here a path could become, because there is nothing here that carries a key. */
function stopsHtml(stops: unknown[], current: number): string {
  if (stops.length === 0) return `<p class="empty">${escapeHtml(NO_STOPS_MESSAGE)}</p>`;

  // The window always contains the current stop — a cap that hid the stop the page is
  // narrating would be worse than the unbounded render it is protecting against.
  const start = current < MAX_ROWS_RENDERED ? 0 : current - MAX_ROWS_RENDERED + 1;
  const shown = stops.slice(start, start + MAX_ROWS_RENDERED);
  const omitted = stops.length - shown.length;

  const items = shown
    .map((stop, i) => {
      const at = start + i;
      // Two FIXED class names, picked by an integer comparison and never interpolated — the
      // reasoning `step-view.ts`'s `turn-user`/`turn-tutor` pair records: a class built from
      // untrusted input is an attribute injection that escaping the surrounding TEXT cannot see.
      const cls = at === current ? 'stop stop-current' : 'stop';
      return `<li class="${cls}"><span class="stop-ord">${at + 1}</span>`
        + `<span class="stop-where">${escapeHtml(stopWhere(stop))}</span></li>`;
    })
    .join('');

  const omittedNote = omitted > 0
    ? `<p class="rows-omitted">${escapeHtml(rowsOmittedMessage(omitted, 'stop'))}</p>`
    : '';

  return `<ol class="stop-list">${items}</ol>${omittedNote}`;
}

/** The current stop: where to look, and what to notice there. */
function currentStopHtml(stop: unknown): string {
  const rec = isRecord(stop) ? stop : {};
  return '<section class="stop-now">'
    + `<h2 class="now-where">${escapeHtml(stopWhere(stop))}</h2>`
    + `<p class="stop-text">${escapeHtml(stopText(rec['text']))}</p>`
    + '</section>';
}

/** Which files the detour opened, so a learner can tell the detour's tabs from their own —
 *  which is the whole of AC3's promise, stated on the page that makes it. `content` is NOT
 *  drawn: the real editor tab beside this one is what shows a file's contents. */
function filesHtml(files: unknown[]): string {
  const heading = `<h2>${escapeHtml(FILES_HEADING)}</h2>`;
  if (files.length === 0) return `${heading}<p class="empty">${escapeHtml(NO_FILES_MESSAGE)}</p>`;

  const shown = files.slice(0, MAX_ROWS_RENDERED);
  const omitted = files.length - shown.length;
  const items = shown
    .map((file) => {
      const rec = isRecord(file) ? file : {};
      return `<li><code class="file-path">${escapeHtml(labelText(rec['path']))}</code></li>`;
    })
    .join('');
  const omittedNote = omitted > 0
    ? `<p class="rows-omitted">${escapeHtml(rowsOmittedMessage(omitted, 'file'))}</p>`
    : '';
  return `${heading}<ul class="file-list">${items}</ul>${omittedNote}`;
}

/**
 * The walk's own controls. *Previous* and *Next* exist only when there is a walk — a detour
 * that arrived with no stops gets neither, rather than two buttons that would do nothing —
 * and each is disabled at the end it cannot move past, WITH the sentence that says why.
 * *Back to my build* is never disabled: it is the way out of every state this page can be in,
 * including the broken ones.
 */
function actionsHtml(count: number, current: number): { actions: string; hint: string } {
  const back = `<button type="button" class="btn primary" id="btn-detour-back">${escapeHtml(BACK_LABEL)}</button>`;
  if (count === 0) return { actions: `<div class="actions">${back}</div>`, hint: '' };

  const atFirst = current <= 0;
  const atLast = current >= count - 1;
  const actions = '<div class="actions">'
    + `<button type="button" class="btn" id="btn-detour-prev"${atFirst ? ' disabled' : ''}>${escapeHtml(PREV_LABEL)}</button>`
    + `<button type="button" class="btn" id="btn-detour-next"${atLast ? ' disabled' : ''}>${escapeHtml(NEXT_LABEL)}</button>`
    + `${back}</div>`;
  // The end a learner is most likely to be looking for a way out of wins when a one-stop
  // detour is both: the hint that names the way out is the more useful of the two.
  const hint = atLast ? LAST_STOP_HINT : atFirst ? FIRST_STOP_HINT : '';
  return { actions, hint };
}

function bodyHtml(state: NarratorViewState): string {
  const detour: unknown = state.detour;
  const rec = isRecord(detour) ? detour : {};
  const stops = rows(rec['stops']);
  const current = resolvedStop(state.current, stops.length);
  const { actions, hint } = actionsHtml(stops.length, current);

  const walk = stops.length === 0
    ? ''
    : `<p class="stop-progress">${escapeHtml(stopProgressMessage(current + 1, stops.length))}</p>`;

  return `
<main id="detour-main" data-stop="${current}">
  <h1 class="detour-title">${escapeHtml(labelText(rec['title']))}</h1>
  <p class="detour-domain">${escapeHtml(domainSentence(labelText(rec['domain'])))}</p>
  <p class="detour-aside">${escapeHtml(DETOUR_ASIDE)}</p>

  ${walk}
  ${stopsHtml(stops, current)}
  ${stops.length === 0 ? '' : currentStopHtml(stops[current])}

  ${actions}
  <p class="detour-hint" id="detour-hint">${escapeHtml(hint)}</p>
  <div class="note" id="detour-note"></div>

  ${filesHtml(rows(rec['files']))}
</main>`;
}

/**
 * The client script (repo-tour lesson, T-3, 2026-08-26: a stray escape in a TS template
 * literal renders a page that parses fine and does nothing, and says nothing about why — so
 * every caller's script is executed against a fake DOM as well as parse-tested).
 *
 * It is deliberately tiny, and the two things it does NOT do are the point. It never builds
 * markup — no `innerHTML`, no `insertAdjacentHTML`, no `document.write`, asserted at the
 * source in this page's tests — and it never decides anything: which stop is current is the
 * host's answer, arriving as a repaint. All this holds is the note the host can put on the
 * page WITHOUT a repaint, and the one value that makes that survive a torn-down view.
 */
const CLIENT_SCRIPT = `
(function () {
  // WHICH stop this page is drawing. The host's markup is the only place that knows, and it is
  // the key the note is saved under: a view torn down while hidden and restored under a
  // DIFFERENT stop must not have the old stop's sentence re-applied to it as though it were
  // about this one.
  var mainEl = document.getElementById('detour-main');
  var stop = mainEl ? mainEl.getAttribute('data-stop') : null;

  var savedNote = '';
  var initial = restore();
  if (initial && initial.stop === stop && typeof initial.note === 'string') { savedNote = initial.note; }
  var noteEl = document.getElementById('detour-note');
  if (savedNote && noteEl) { noteEl.textContent = savedNote; }

  function on(id, type, handler) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener(type, handler); }
  }

  // \`on\` is null-safe, so the two walk controls that a stop-less detour never renders hook
  // nothing here rather than needing a condition of their own.
  on('btn-detour-prev', 'click', function () { post('detour:prev', {}); });
  on('btn-detour-next', 'click', function () { post('detour:next', {}); });
  on('btn-detour-back', 'click', function () { post('detour:back', {}); });

  window.addEventListener('message', function (event) {
    var msg = event ? event.data : null;
    if (!msg || msg.type !== 'detour:note' || !msg.payload) { return; }
    var note = msg.payload.note;
    // Checked rather than coerced: a host message is untyped at run time on this side too,
    // and \`textContent = undefined\` would silently blank a sentence somebody is reading.
    if (typeof note !== 'string') { return; }
    var el = document.getElementById('detour-note');
    // textContent, never innerHTML — the host's sentence can quote a model, and this is the
    // one place on the client where that text becomes part of the document.
    if (el) { el.textContent = note; }
    savedNote = note;
    save({ stop: stop, note: savedNote });
  });
})();
`;

/** The script this page ships, for the test that runs it. */
export function narratorScript(): string {
  return CLIENT_SCRIPT;
}

export function renderNarratorHtml(state: NarratorViewState, skins: SkinsModule): string {
  return renderPage({
    title: NARRATOR_TITLE,
    coreCss: skins.baseCss() + skins.alternateCss(),
    bridgeCss: bridgeCss(),
    pageCss: PAGE_CSS,
    skin: state.skin,
    body: bodyHtml(state),
    script: CLIENT_SCRIPT,
  });
}

// ── what actually arrives from the webview ──────────────────────────────────────────────────

/** The three messages this page speaks. None carries a payload: navigation is relative
 *  (*Previous* / *Next*) and the way out names nothing, so the page never tells the host WHICH
 *  stop or WHICH file to act on — the host already knows, and a webview-supplied key would be
 *  the one shape of message a validator exists to refuse. */
export type NarratorMessage =
  | { type: 'detour:prev' }
  | { type: 'detour:next' }
  | { type: 'detour:back' };

const INBOUND_TYPES = ['detour:prev', 'detour:next', 'detour:back'] as const;

/**
 * `null` for anything whose `type` is not one of the three — the same
 * `src/walk/step-protocol.ts` `parseStepMessage` discipline, for the same reason: a webview's
 * `postMessage` is untyped at run time, so the host parses first and drops what does not
 * match rather than letting a malformed payload throw inside a `void`-ed promise where
 * nothing is listening for the rejection.
 *
 * The returned object is FRESH, never the caller's own: what arrives from a webview is a
 * structured clone the page can hold a reference to, and handing it onward would let the view
 * keep a handle on a value the host is about to act upon. It carries only `type`, so a
 * `payload` smuggled alongside a known type is left behind rather than passed through —
 * `sanitizeTranscript`'s rebuild-don't-copy rule (T-6 security review), applied here.
 */
export function parseNarratorMessage(raw: unknown): NarratorMessage | null {
  if (!isRecord(raw)) return null;
  const type: unknown = raw['type'];
  if (typeof type !== 'string' || !(INBOUND_TYPES as readonly string[]).includes(type)) return null;
  return { type: type as NarratorMessage['type'] };
}
