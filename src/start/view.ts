// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The start screen's markup and client script (spec §5.2) — pure (no `vscode`): built from
 * a `PanelState` and repo-tour's own skin exports, nothing else. `src/start/panel.ts` is the
 * only caller that touches a real webview; everything about WHAT the page looks like and
 * says lives here, so it can be rendered and inspected in a plain-mocha test with no
 * extension host at all.
 *
 * Validation messages render UNDER the field they belong to, always — even an empty
 * `<div class="problem">` is present in the markup, so the client script only ever has to
 * set `textContent`, never create or remove a node (repo-tour lesson, T-3, 2026-08-26: "if a
 * control can refuse, it must say so where the eye already is").
 */

import { bridgeCss, pickerHtml, type SkinRow } from '../skins.js';
import { renderPage } from '../webview/page.js';
import { escapeAttr, escapeHtml } from '../webview/html.js';
import { DIALS, type Dial } from './request.js';
import type { PanelState } from './protocol.js';

/** The shape `repo-tour/skins` actually exports — everything `view.ts` reads from it. */
export interface SkinsModule {
  SKINS: readonly SkinRow[];
  baseCss(): string;
  alternateCss(): string;
}

const DIAL_LABEL: Record<Dial, string> = {
  manual: "I'll type it",
  scaffolded: 'Scaffold it for me',
  automated: 'Watch me build it',
};

const PAGE_CSS = `
.start-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
.start-head h1 { font-size:16px; margin:0; }
main { max-width:640px; margin:0 auto; padding:20px 24px 40px; }
.field { margin-bottom:16px; }
.field > label { display:block; font-weight:600; margin-bottom:6px; }
.field textarea, .field input[type=text] { width:100%; }
.with-browse { display:flex; gap:8px; }
.with-browse input { flex:1 1 auto; }
/* repo-tour's own --kw token (a warm, keyword-ish red in every skin) doubles as this form's
   validation colour — one fewer palette this page would otherwise invent on its own. */
.problem { color:var(--kw); font-size:12px; margin-top:5px; min-height:14px; }
.checkbox-field label { display:flex; align-items:center; gap:8px; font-weight:400; }
fieldset.dial { border:1px solid var(--line); border-radius:var(--radius); padding:10px 14px; margin:0 0 20px; }
fieldset.dial legend { font-weight:600; padding:0 4px; }
fieldset.dial label { display:inline-flex; align-items:center; gap:6px; margin:6px 18px 2px 0; font-weight:400; }
`;

function problemDiv(field: 'idea' | 'repo' | 'target', message: string | undefined): string {
  return `<div class="problem" data-field="${field}" id="problem-${field}">${escapeHtml(message ?? '')}</div>`;
}

function dialFieldset(current: Dial): string {
  const inputs = DIALS.map((d) => {
    const checked = d === current ? ' checked' : '';
    return `<label><input type="radio" name="dial" value="${d}"${checked}> ${escapeHtml(DIAL_LABEL[d])}</label>`;
  }).join('');
  return `<fieldset class="field dial"><legend>How much do you want to type?</legend>${inputs}</fieldset>`;
}

function bodyHtml(state: PanelState, skins: SkinsModule): string {
  const r = state.request;
  return `
<main>
  <div class="start-head">
    <h1>Build a tutorial</h1>
    ${pickerHtml(skins.SKINS, state.skin)}
  </div>
  <form id="start-form">
    <div class="field">
      <label for="idea">What do you want to build?</label>
      <textarea id="idea" name="idea" rows="3" placeholder="a short description">${escapeHtml(r.idea)}</textarea>
      ${problemDiv('idea', state.problems.idea)}
    </div>

    <div class="field checkbox-field">
      <label><input type="checkbox" id="recreate" name="recreate"${r.recreate ? ' checked' : ''}> Just recreate the repo as it stands</label>
    </div>

    <div class="field">
      <label for="repo">Reference repo</label>
      <div class="with-browse">
        <input type="text" id="repo" name="repo" value="${escapeAttr(r.repo)}" placeholder="local path or https://github.com/owner/repo">
        <button type="button" class="btn" id="browse-repo">Browse…</button>
      </div>
      ${problemDiv('repo', state.problems.repo)}
    </div>

    <div class="field">
      <label for="target">Build it in</label>
      <div class="with-browse">
        <input type="text" id="target" name="target" value="${escapeAttr(r.target)}" placeholder="an empty or new folder">
        <button type="button" class="btn" id="browse-target">Browse…</button>
      </div>
      ${problemDiv('target', state.problems.target)}
    </div>

    ${dialFieldset(r.dial)}

    <button type="submit" class="btn primary" id="build-btn"${state.building ? ' disabled' : ''}>${state.building ? 'Building…' : 'Build the plan'}</button>
    <!-- T-15. One line, BELOW the button, empty until a press. It exists because the problem
         lines under each field are already on screen before the button is touched, so they
         cannot also be the ANSWER to pressing it.
         It carries a press ordinal in data-press, because the words alone are not enough: two
         identical refused presses would otherwise write the same sentence over itself. What is
         guaranteed to differ across a press is this element — its text, or failing that its
         ordinal — plus the button on the accepted path. The build's own progress notification
         appears in the corner, not here, which is why the accepted path needs this too. -->
    <p class="problem" id="submit-note" role="status" aria-live="polite" data-press="0">${state.building ? 'Starting the build…' : ''}</p>
  </form>
</main>`;
}

/**
 * The client script (repo-tour lesson, T-3, 2026-08-26: lives inside a TS template literal —
 * a bad escape here renders a page that parses and does nothing; `test/unit/start-view.test.ts`
 * both parses this with `new Function` and actually runs it against a fake DOM).
 *
 * `change` (not `input`) is what drives `form:changed`: it fires once a field is committed
 * (blur for a text field, immediately for a checkbox/radio), never per keystroke — so a full
 * reply round-trip never fights the user for focus while they are still typing.
 */
const CLIENT_SCRIPT = `
(function () {
  var form = document.getElementById('start-form');

  function currentRequest() {
    var dial = 'manual';
    var radios = form.querySelectorAll('input[name="dial"]');
    for (var i = 0; i < radios.length; i++) { if (radios[i].checked) { dial = radios[i].value; } }
    return {
      idea: document.getElementById('idea').value,
      recreate: document.getElementById('recreate').checked,
      repo: document.getElementById('repo').value,
      target: document.getElementById('target').value,
      dial: dial,
    };
  }

  function showProblems(problems) {
    problems = problems || {};
    ['idea', 'repo', 'target'].forEach(function (field) {
      var el = document.getElementById('problem-' + field);
      if (el) { el.textContent = problems[field] || ''; }
    });
  }

  // T-15, and review finding 3. Cleared on every edit so the NEXT press is observable — but the
  // words alone are not enough. Press Enter in the field this fix's own focus move just landed
  // you in and no change event fires, so the note is never cleared and the same sentence is
  // written over itself: byte-identical, which is the defect again one keystroke later. The
  // ordinal makes every press differ whether or not the words do.
  var presses = 0;
  function setNote(text, counts) {
    var el = document.getElementById('submit-note');
    if (!el) { return; }
    el.textContent = text || '';
    if (counts) { presses += 1; }
    el.setAttribute('data-press', String(text ? presses : 0));
  }

  function firstProblemField(problems) {
    var order = ['idea', 'repo', 'target'];
    for (var i = 0; i < order.length; i += 1) {
      if (problems && problems[order[i]]) { return document.getElementById(order[i]); }
    }
    return null;
  }

  form.addEventListener('change', function () {
    var request = currentRequest();
    save({ request: request });
    setNote('', false);
    post('form:changed', { request: request });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    post('form:submit', { request: currentRequest() });
  });

  document.getElementById('browse-repo').addEventListener('click', function () { post('pick:repo', {}); });
  document.getElementById('browse-target').addEventListener('click', function () { post('pick:target', {}); });

  var skinpick = document.getElementById('skinpick');
  if (skinpick) {
    skinpick.addEventListener('change', function () {
      var v = skinpick.value;
      // Applied instantly, client-side, for zero flash — the host's own job is only to
      // persist the choice (globalState) for the NEXT time this page opens.
      if (!v || v === 'system') { document.documentElement.removeAttribute('data-theme'); }
      else { document.documentElement.setAttribute('data-theme', v); }
      post('skin:set', { skin: v });
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg) return;
    if (msg.type === 'form:problems') {
      showProblems(msg.payload.problems);
    } else if (msg.type === 'form:rejected') {
      // The note first, then focus. Both change; the note is the one a test can see and the one
      // that survives the button already having focus.
      showProblems(msg.payload.problems);
      setNote(msg.payload.count === 1
        ? 'One thing needs fixing before this can build.'
        : msg.payload.count + ' things need fixing before this can build.', true);
      var target = firstProblemField(msg.payload.problems);
      if (target && target.focus) { target.focus(); }
    } else if (msg.type === 'form:accepted') {
      // The build is real from here. The button goes quiet because pressing it again would
      // start a second one, and the note says so on the surface the reader is looking at —
      // the progress notification appears in the corner, not in this panel.
      setNote('Starting the build…', true);
      var btn = document.getElementById('build-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    } else if (msg.type === 'form:idle') {
      // Every build ends, including the failed and cancelled ones. Without this the button that
      // was disabled on submit stayed disabled reading "Building…" beside a note still claiming
      // the build was starting — a dead control with a false explanation, which is the family
      // this whole ticket was filed about.
      setNote('', false);
      var doneBtn = document.getElementById('build-btn');
      if (doneBtn) { doneBtn.disabled = false; doneBtn.textContent = 'Build the plan'; }
    } else if (msg.type === 'field:set') {
      var el = document.getElementById(msg.payload.field);
      if (el) { el.value = msg.payload.value; }
      showProblems(msg.payload.problems);
      // A folder pick changes the problems, so a note counting the OLD ones is now wrong — and
      // leaving it stale is also how the next press becomes unobservable (review finding 4).
      setNote('', false);
    }
  });
})();
`;

export function startScript(): string {
  return CLIENT_SCRIPT;
}

export function renderStartHtml(state: PanelState, skins: SkinsModule): string {
  return renderPage({
    title: 'Build Tutorials: Start',
    coreCss: skins.baseCss() + skins.alternateCss(),
    bridgeCss: bridgeCss(),
    pageCss: PAGE_CSS,
    skin: state.skin,
    body: bodyHtml(state, skins),
    script: CLIENT_SCRIPT,
  });
}
