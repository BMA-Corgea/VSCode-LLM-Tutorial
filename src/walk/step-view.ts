// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The step panel's markup and client script (spec §5.3, AC2, AC5) — pure (no `vscode`),
 * mirroring `src/start/view.ts`'s split exactly: a `PAGE_CSS` sheet, a `bodyHtml()` builder,
 * a `CLIENT_SCRIPT` template literal, and the two functions `src/walk/step-panel.ts` (the
 * real `vscode.WebviewViewProvider`, not written yet) will call. `StepViewState` — the whole
 * input this file renders — is defined in `./step-protocol.ts`, not here: that file also owns
 * `handleStepMessage`, so the message SHAPES this script posts and the shapes the host parses
 * live in one place and cannot drift apart.
 *
 * **Recreate mode only, and this page is where that shows up.** The ticket's own spec is
 * explicit: the panel shows alternatives but does not let the learner pick one (T-10). That
 * is stronger than "the control is disabled" — for every option that is not what the author
 * actually did, there is NO `<button>` and NO `<input>` in the markup at all, only `<ul>`/
 * `<li>`/`<span>`/`<p>`. A disabled control can always be a bug away from becoming enabled by
 * accident; a control that was never rendered cannot. The author's own choice (`option.taken`
 * — repo-tour guarantees this agrees with `id === decision.authorChoice`, so only one field is
 * read here) gets a "What the author did" badge instead of a "coming with T-10" one, and nets
 * no interactive markup either, since nothing on this page is selectable yet.
 *
 * **Why's source label** is a fixed three-line map, not repo-tour's own `why` text: the ticket
 * pins the exact wording (`interpret` → "from the model, reading the code", `docstring` →
 * "from the author's own comment", `none` → "not inferable from the source"). When
 * `whySource === 'none'`, this can read almost the same as `why` itself, since repo-tour's own
 * `why` value in that case already IS that sentence — confirmed against a real build's plan,
 * not a bug to "fix" by hiding one of the two lines.
 *
 * **The witness fallback text is asserted byte-for-byte** ("no history to show" — see
 * `NO_HISTORY_MESSAGE`) the same way `src/start/request.ts`'s `IDEA_FIRST_MESSAGE` is: a
 * constant, exported, so a test and this file's own rendering can never quote it differently.
 * `FILE_MISSING_MESSAGE` gets the same treatment for the exact reason `problemDiv` exists on
 * the start screen — repo-tour's lesson, restated in this repo's own conventions: "a feature
 * that is not built yet says so where the eye is ... never a disabled button with no
 * explanation." The hint node beside "Open the file" is always present in the markup, empty
 * when there is nothing to say, so nothing ever has to create or remove it.
 *
 * **The dial** reuses `DIALS`/`Dial` from `../start/request.js` (the plan-level `model.ts`
 * already does the same), but needs its OWN `DIAL_LABEL` — `src/start/view.ts`'s copy is a
 * `const`, not exported, and `src/start/**` is out of bounds for this ticket. Duplicating
 * three short lines here is cheaper than widening that file's public surface for one caller.
 * The checked radio comes from `progress.steps[step.id]?.dial`, falling back to `'manual'`
 * (`FALLBACK_DIAL`) exactly like `model.ts`'s own `statusText` does, and for the same reason:
 * a step with no per-step override yet has had nothing done to it, and "manual" is the one
 * answer that can never overstate that.
 *
 * **The note line and AC5.** `state.note` is the panel's own transient reply text (today,
 * only `step:check`'s honest "arrives with T-5" line) — never part of `progress.json`, never
 * plan data. It is rendered server-side when present, same as everything else on this page,
 * but it ALSO round-trips through the webview's own `getState()`/`setState()` (`restore()`/
 * `save()` from `src/webview/page.ts`'s bootstrap): when a `step:note` message arrives, the
 * script writes it into the node's `textContent` AND saves it, and on the very first tick of a
 * fresh script load it re-applies whatever was last saved. This is deliberately narrow — it
 * exists ONLY so a reply already on screen survives this one view being torn down while
 * hidden (`retainContextWhenHidden: false`) and shown again on the SAME step, per this
 * ticket's AC5. It is not a second source of truth for which step is current, and it is not
 * keyed by step id: the host re-render (which DOES know the current step, and clears `note`
 * on a real navigation — see `step-panel.ts`, not this file) is still the only authority for
 * everything else on the page, exactly as `src/webview/page.ts`'s own doc comment requires.
 *
 * The client script itself lives inside a TS template literal for the same reason
 * `src/start/view.ts`'s does (repo-tour lesson, T-3, 2026-08-26: a bad escape here ships a
 * page that parses and does nothing) and touches nothing beyond `document.getElementById`,
 * `addEventListener`, `.value`/`.checked`/`.textContent`, and `window`'s `message` event — the
 * same small vocabulary `test/unit/start-view.test.ts`'s fake DOM already fakes, so whoever
 * writes this file's own unit test can build an analogous harness with no surprises.
 */

import { type SkinsModule } from '../start/view.js';
import { DIALS, type Dial } from '../start/request.js';
import { bridgeCss, pickerHtml } from '../skins.js';
import { renderPage } from '../webview/page.js';
import { escapeAttr, escapeHtml } from '../webview/html.js';
import type { OptionLike, StepLike, WhySource } from './model.js';
import type { StepViewState } from './step-protocol.js';

/** Verbatim — a test asserts this exact phrase when `step.witness.sha` is `null`. */
export const NO_HISTORY_MESSAGE = 'no history to show';

/** Verbatim — the honest reason "Open the file" is disabled (repo-tour lesson: never a
 *  disabled control with no explanation). Rendered in a node that is always present. */
export const FILE_MISSING_MESSAGE = "you haven't created this file yet";

/** Exactly the mapping the ticket pins — see the file header for why `none` can look like it
 *  duplicates `why` itself sometimes. Not exported: nothing outside this file needs to quote
 *  it, only the rendered text (which a test reads off the markup, same as `DIAL_LABEL` below). */
const WHY_SOURCE_LABEL: Record<WhySource, string> = {
  interpret: 'from the model, reading the code',
  docstring: "from the author's own comment",
  none: 'not inferable from the source',
};

/** `src/start/view.ts` keeps the identical three lines as an unexported `const` — duplicated
 *  here rather than exported from there, per this ticket's own boundary (`src/start/**` is
 *  out of bounds). Kept word-for-word the same so the dial reads identically on both screens. */
const DIAL_LABEL: Record<Dial, string> = {
  manual: "I'll type it",
  scaffolded: 'Scaffold it for me',
  automated: 'Watch me build it',
};

/** Mirrors `model.ts`'s own unexported `FALLBACK_DIAL`: a step with no recorded override has
 *  had nothing done to it yet, and "manual" is the one label that can never overstate that. */
const FALLBACK_DIAL: Dial = 'manual';

/** Exported for the same reason `CHECK_NOTE` and `IDEA_FIRST_MESSAGE` are: a test should
 *  assert the string this page actually uses, never a copy of it that can drift. */
export const AUTHOR_BADGE = 'What the author did';
export const T10_BADGE = 'coming with T-10';

const PAGE_CSS = `
.notice-only { padding:20px 16px; }
.notice-only .notice { opacity:0.85; margin:0; }
main { max-width:640px; margin:0 auto; padding:20px 24px 40px; }
.step-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:18px; }
.step-head h1 { font-size:16px; margin:0; max-width:70%; }
section { margin-bottom:20px; }
section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 8px; }
.options { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.option { border:1px solid var(--line); border-radius:var(--radius); padding:10px 14px; }
.option-taken { border-color:var(--accent); background:var(--hl); }
.option-label { display:block; font-weight:600; }
.option-consequence { margin:4px 0 0; color:var(--muted); }
.badge { display:inline-block; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; padding:2px 8px; border-radius:999px; margin-bottom:6px; }
.badge-taken { background:var(--accent-soft); color:var(--accent); }
.badge-t10 { background:var(--chip); color:var(--muted); }
.why-text { margin:0 0 4px; }
.why-source, .witness-text { color:var(--muted); font-size:12px; margin:0; }
fieldset.dial { border:1px solid var(--line); border-radius:var(--radius); padding:10px 14px; margin:0 0 20px; }
fieldset.dial legend { font-weight:600; padding:0 4px; }
fieldset.dial label { display:inline-flex; align-items:center; gap:6px; margin:6px 18px 2px 0; font-weight:400; }
.actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
.open-wrap { display:inline-flex; align-items:center; gap:8px; }
.hint { color:var(--kw); font-size:12px; min-height:14px; }
.note { color:var(--muted); font-size:12px; min-height:14px; }

/* This page lives in a SIDEBAR, and everything on it is someone else's text — a docstring,
   a commit subject, a generated sentence. The real plan already ships a \`why\` that is a
   docstring beginning with a rule of box-drawing characters
   (\`── tokenizer ─────────────────\`), which has no wrap opportunity in it at all and pushes
   the whole panel sideways. Long URLs and long identifiers do the same. \`anywhere\` is the
   right strength here: break mid-token only when there is no other option. */
main, section, .option { min-width:0; }
.step-head h1, .option-label, .option-consequence, .why-text, .why-source, .witness-text,
.note, .hint { overflow-wrap:anywhere; }

/* The sidebar is narrow — often ~300px, not the 640px an editor tab gets. Below that, the
   title and the skin picker stop competing for one line and 48px of horizontal padding
   stops eating a sixth of the width. */
@media (max-width: 480px) {
  main { padding:16px 12px 32px; }
  .step-head { flex-direction:column; gap:8px; }
  .step-head h1 { max-width:100%; }
  fieldset.dial label { margin-right:12px; }
}
`;

/** Every option that is not what the author did: plain text/list markup, a "coming with
 *  T-10" badge, and — deliberately — no `<button>`, no `<input>`, nothing in the DOM to
 *  select. The author's own choice gets a distinct badge instead and no interactive markup
 *  either, since nothing on this page is selectable yet (recreate mode; see the file header). */
function optionsHtml(options: OptionLike[]): string {
  const items = options
    .map((opt) => {
      const cls = opt.taken ? 'option option-taken' : 'option option-alt';
      // The badge is suppressed when it would only repeat the option's own label. That is
      // not a rare tidy-up: a plan built with no interpretation gives every step exactly one
      // option, labelled "What the author did" by repo-tour itself, so the badge said it
      // twice in a row on all 61 steps of the first real plan we rendered. The author's
      // choice is still marked — `.option-taken` carries the accent border and highlight —
      // and the badge comes back the moment a plan has options whose labels differ.
      const badge = opt.taken
        ? (opt.label.trim().toLowerCase() === AUTHOR_BADGE.toLowerCase() ? '' : `<span class="badge badge-taken">${AUTHOR_BADGE}</span>`)
        : `<span class="badge badge-t10">${T10_BADGE}</span>`;
      return `<li class="${cls}" data-option-id="${escapeAttr(opt.id)}">${badge}<span class="option-label">${escapeHtml(opt.label)}</span><p class="option-consequence">${escapeHtml(opt.consequence)}</p></li>`;
    })
    .join('');
  return `<ul class="options">${items}</ul>`;
}

/** `NO_HISTORY_MESSAGE`, verbatim, when there is nothing to show — gated on `sha`, matching
 *  how a real build with no interpretation ever populates this triple (see `model.ts`'s own
 *  `WhySource` doc comment and this ticket's handoff: every field of `witness` is `null`
 *  together, never just one). Otherwise a short, readable sentence — no format here is pinned
 *  by the ticket beyond the null case, so this stays a plain, honest rendering of what's there. */
function witnessSentence(witness: StepLike['witness']): string {
  if (!witness.sha) return NO_HISTORY_MESSAGE;
  const subject = witness.subject ?? 'no message';
  const shortSha = witness.sha.slice(0, 7);
  return witness.date ? `${subject} — ${shortSha} (${witness.date})` : `${subject} — ${shortSha}`;
}

function dialFieldset(current: Dial): string {
  const inputs = DIALS.map((d) => {
    const checked = d === current ? ' checked' : '';
    return `<label><input type="radio" name="dial" id="dial-${d}" value="${d}"${checked}> ${escapeHtml(DIAL_LABEL[d])}</label>`;
  }).join('');
  return `<fieldset class="dial"><legend>How much do you want to type?</legend>${inputs}</fieldset>`;
}

/** Always present, beside the button it explains — `problemDiv`'s pattern in
 *  `src/start/view.ts`, restated: never a disabled control with no reason given. */
function openFileHint(fileExists: boolean): string {
  return `<span class="hint" id="open-hint">${fileExists ? '' : escapeHtml(FILE_MISSING_MESSAGE)}</span>`;
}

function bodyHtml(state: StepViewState, skins: SkinsModule): string {
  const step = state.step;
  const currentDial: Dial = state.progress.steps[step.id]?.dial ?? FALLBACK_DIAL;

  return `
<main id="step-main" data-step-id="${escapeAttr(step.id)}">
  <div class="step-head">
    <h1>${escapeHtml(step.decision.question)}</h1>
    ${pickerHtml(skins.SKINS, state.skin)}
  </div>

  <section>
    <h2>Options</h2>
    ${optionsHtml(step.decision.options)}
  </section>

  <section>
    <h2>Why</h2>
    <p class="why-text">${escapeHtml(step.decision.why)}</p>
    <p class="why-source">${escapeHtml(WHY_SOURCE_LABEL[step.decision.whySource])}</p>
  </section>

  <section>
    <h2>Witness</h2>
    <p class="witness-text">${escapeHtml(witnessSentence(step.witness))}</p>
  </section>

  ${dialFieldset(currentDial)}

  <div class="actions">
    <button type="button" class="btn" id="btn-prev">Previous</button>
    <span class="open-wrap">
      <button type="button" class="btn" id="btn-open"${state.fileExists ? '' : ' disabled'}>Open the file</button>
      ${openFileHint(state.fileExists)}
    </span>
    <button type="button" class="btn" id="btn-check">Check my work</button>
    <button type="button" class="btn primary" id="btn-next">Next</button>
  </div>

  <div class="note" id="step-note">${escapeHtml(state.note ?? '')}</div>
</main>`;
}

/**
 * The client script (repo-tour lesson, T-3, 2026-08-26 — see the file header). Every handler
 * re-reads the DOM through `document.getElementById` rather than trusting an event's own
 * `target` (the fake-DOM harness this is tested against does not simulate bubbling or
 * populate synthetic events, exactly like `src/start/view.ts`'s own script never relies on
 * `event.target` either), and the dial's three ids are spelled out rather than discovered
 * with `querySelectorAll`, so this script needs nothing from a fake `document` beyond
 * `getElementById` — the same minimal surface `test/unit/start-view.test.ts` already fakes.
 */
const CLIENT_SCRIPT = `
(function () {
  // WHICH step this page is rendering. The host's markup is the only place that knows, and
  // it is the key the note below is saved under — see the restore guard.
  var mainEl = document.getElementById('step-main');
  var stepId = mainEl ? mainEl.getAttribute('data-step-id') : null;

  // AC5, and ONLY AC5: re-apply a note the host already sent us, after this view was torn
  // down while hidden (retainContextWhenHidden: false). The saved blob is scoped to the
  // whole VIEW, not to a step, so it is keyed by step id and dropped when it does not match
  // what is on screen — navigate away while hidden and the note that comes back belongs to
  // the step you left, which would be a lie told confidently. The host's own render stays
  // authoritative for everything else (spec §5.1).
  var initial = restore();
  if (initial && typeof initial.note === 'string' && initial.stepId === stepId) {
    var initialNoteEl = document.getElementById('step-note');
    if (initialNoteEl) { initialNoteEl.textContent = initial.note; }
  }

  function on(id, type, handler) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener(type, handler); }
  }

  on('btn-prev', 'click', function () { post('step:prev', {}); });
  on('btn-open', 'click', function () { post('step:open', {}); });
  on('btn-check', 'click', function () { post('step:check', {}); });
  on('btn-next', 'click', function () { post('step:next', {}); });

  ['manual', 'scaffolded', 'automated'].forEach(function (dial) {
    on('dial-' + dial, 'change', function () { post('dial:set', { dial: dial }); });
  });

  var skinpick = document.getElementById('skinpick');
  if (skinpick) {
    skinpick.addEventListener('change', function () {
      var v = skinpick.value;
      // Applied instantly, client-side, for zero flash — mirrors src/start/view.ts exactly;
      // the host's only job is to persist the choice for the NEXT time this page opens.
      if (!v || v === 'system') { document.documentElement.removeAttribute('data-theme'); }
      else { document.documentElement.setAttribute('data-theme', v); }
      post('skin:set', { skin: v });
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg) return;
    if (msg.type === 'step:note') {
      var note = msg.payload.note;
      var el = document.getElementById('step-note');
      if (el) { el.textContent = note; }
      // Keyed by the step it belongs to, so the restore above can tell "the same view came
      // back" from "a different step is on screen now".
      save({ stepId: stepId, note: note });
    }
  });
})();
`;

export function stepScript(): string {
  return CLIENT_SCRIPT;
}

/**
 * The page this view shows when there is no step to show — no tutorial in this folder yet,
 * or repo-tour's core not loaded so there is nothing to render a step WITH.
 *
 * It exists because the alternative was `html = ''`, and a silently blank panel is precisely
 * the failure this repo's house rule is about: if a surface can have nothing to say, it says
 * so, where the eye already is. It takes no `SkinsModule` on purpose — the "core is missing"
 * case is exactly the case where there isn't one — so it is deliberately unskinned, styled by
 * the bridge sheet's editor-token mapping alone, which needs nothing from repo-tour.
 */
export function renderNoticeHtml(notice: string): string {
  return renderPage({
    title: 'Build Tutorials: Step',
    coreCss: '',
    bridgeCss: bridgeCss(),
    pageCss: PAGE_CSS,
    skin: 'system',
    body: `<main class="notice-only"><p class="notice">${escapeHtml(notice)}</p></main>`,
    script: '',
  });
}

export function renderStepHtml(state: StepViewState, skins: SkinsModule): string {
  return renderPage({
    title: 'Build Tutorials: Step',
    coreCss: skins.baseCss() + skins.alternateCss(),
    bridgeCss: bridgeCss(),
    pageCss: PAGE_CSS,
    skin: state.skin,
    body: bodyHtml(state, skins),
    script: CLIENT_SCRIPT,
  });
}
