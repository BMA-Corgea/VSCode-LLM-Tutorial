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

/**
 * What the note under the button says once a press has been accepted, and after each way a build
 * can end (T-15). One table, read by the markup (a re-render mid-build) and by the client script,
 * so the two can never say different things about the same state.
 */
export const SUBMIT_NOTES = {
  building: 'Building the plan — its progress and a Cancel button are in the notification in the corner.',
  busy: 'Already building — one build at a time. Its progress and Cancel are in the corner.',
  built: 'Done — the plan is built.',
  failed: 'The build failed — the reason is under Reference repo.',
  cancelled: 'Build cancelled.',
} as const;

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
/* T-15: the note under the button is NOT a problem line. Only a refusal or a failure takes the
   validation colour; "building" or "done" in the error colour reads as an error. */
.submit-note { font-size:12px; margin-top:8px; min-height:14px; }
.submit-note[data-kind="rejected"], .submit-note[data-kind="failed"] { color:var(--kw); }
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
         cannot also be the ANSWER to pressing it. Every press changes its WORDS: a refusal names
         what to fix, a repeated refusal says "Still" and how many times, an accepted press says
         the build is running and where its progress is, and the end of a build says how it
         ended. The build's own progress notification is in the corner, not here. -->
    <p class="submit-note" id="submit-note" role="status" aria-live="polite" data-kind="${state.building ? 'building' : ''}">${state.building ? escapeHtml(SUBMIT_NOTES.building) : ''}</p>
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

  // T-15. The note under the button, and what it says for each state. Cleared on every edit so the
  // NEXT press is a change on its own — except while a build runs, when the note is the only line
  // on this page saying so. A refusal repeated with nothing edited between (Enter in the field the
  // focus move just landed you in fires no change event) says "Still …" and how many times, so its
  // WORDS differ: September's fix moved an invisible data-press attribute instead, and a person
  // pressing twice saw nothing change at all (review finding 3, re-driven 2026-11-05).
  var NOTES = ${JSON.stringify(SUBMIT_NOTES)};
  var FIELD_NAMES = { idea: 'the idea', repo: 'the reference repo', target: 'the folder to build in' };
  var buildBtn = document.getElementById('build-btn');
  var building = !!(buildBtn && buildBtn.disabled);

  function setNote(kind, text) {
    var el = document.getElementById('submit-note');
    if (!el) { return; }
    el.textContent = text || '';
    el.setAttribute('data-kind', text ? kind : '');
  }

  function refusal(problems, inARow) {
    var names = ['idea', 'repo', 'target'].filter(function (f) { return problems && problems[f]; })
      .map(function (f) { return FIELD_NAMES[f]; });
    var what = names.length === 0 ? 'the form'
      : names.length === 1 ? names[0]
      : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    return inARow > 1
      ? 'Still can\u2019t build \u2014 fix ' + what + '. Tried ' + inARow + ' times.'
      : 'Can\u2019t build yet \u2014 fix ' + what + '.';
  }

  function setBuilding(on) {
    building = on;
    var btn = document.getElementById('build-btn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Building\u2026' : 'Build the plan'; }
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
    if (!building) { setNote('', ''); }
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
      // The note first, then focus. Both change; the note is the one that survives the field
      // already having focus.
      showProblems(msg.payload.problems);
      setNote('rejected', refusal(msg.payload.problems, msg.payload.inARow));
      var target = firstProblemField(msg.payload.problems);
      if (target && target.focus) { target.focus(); }
    } else if (msg.type === 'form:accepted') {
      // The build is real from here. The button goes quiet because pressing it again would
      // start a second one, and the note says so on the surface the reader is looking at —
      // the progress notification appears in the corner, not in this panel.
      setBuilding(true);
      setNote('building', NOTES.building);
    } else if (msg.type === 'form:busy') {
      // A press that arrived while the build was already running (the second click of a
      // double-click). It started nothing, and the note says so rather than staying silent.
      setBuilding(true);
      setNote('busy', NOTES.busy);
    } else if (msg.type === 'form:idle') {
      // Every build ends, including the failed and cancelled ones: the button comes back and the
      // note says HOW it ended. A button that silently re-enables after a failure looks exactly
      // like one that was never pressed.
      setBuilding(false);
      var ended = msg.payload && msg.payload.ended;
      var said = (ended === 'built' || ended === 'failed' || ended === 'cancelled') ? NOTES[ended] : '';
      setNote(ended, said);
    } else if (msg.type === 'field:set') {
      var el = document.getElementById(msg.payload.field);
      if (el) { el.value = msg.payload.value; }
      showProblems(msg.payload.problems);
      // A folder pick changes the problems, so a note naming the OLD ones is now wrong — and
      // leaving it stale is also how the next press becomes unobservable (review finding 4).
      if (!building) { setNote('', ''); }
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
