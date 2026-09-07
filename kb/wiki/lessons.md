---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from. These
are the things that cost real time and would cost it again.

## Containment was never a check for whether a contained file is one the learner meant to send anywhere (T-6)

T-4 and T-5 both hardened one boundary — *is this path inside the root* — and T-6 asks that
question correctly, on both roots, lexically and through `realpath`. Every containment check
passed. The learner's `.env` still reached a paid third-party model.

Nothing broke. The **destination** changed. T-6 is the first ticket that takes what it read and
sends it off the machine, and containment answers a question about *location* that has nothing
to say about *disclosure*. A file can be perfectly inside the root and still be one the learner
never meant to send anywhere.

The concrete shape, worth keeping because it is not obvious: a `shape` step's `target.file` is a
chapter **directory** — that is how repo-tour opens every chapter — so `git diff --no-index` runs
over two whole trees. It descends dot-directories, includes dotfiles, and **does not read
`.gitignore`**. A file the learner explicitly declared secret is exactly the kind of file that
diff picks up, and `.env` sorts first, so the size cap does not save it.

The general rule: **when a boundary's destination changes, re-ask what the boundary was
protecting.** A check written for "can this path escape the sandbox" does not become a check for
"should this content leave the building" just because it is still passing. Every existing guard
on a path deserves that question the day the path gains an egress.

## A risk class scored from diff shape is scored from the wrong thing (T-6)

T-6 carried `risk: low`, and the dispatcher spends that: a low-risk ticket's review seats drop
a model tier and the package tells the reviewer to run a "light, proportional pass". On a
5,945-line diff that shells out to an LLM CLI, reads the learner's *and* a reference repo's
files into a prompt, and renders model output into a webview, that is the wrong instruction —
AC5 of the same ticket is an escaping requirement, which is to say the ticket's own spec
already said "untrusted output reaches a page".

The label was not wrong by a notch; it was computed from the wrong input. Size and file count
describe the *shape* of a diff. Risk comes from what the code **touches**: untrusted input,
a rendering surface, a subprocess, a filesystem boundary, someone else's credentials or files.
Score those, not the line count.

Two operational notes that cost time here:

- **`risk` is immutable after creation.** It is validated and set only in `tracker.mjs`'s
  `create()`; no verb changes it later, and the ledger fence blocks editing the ticket file by
  hand. Get it right at `new --risk`, because the only later remedy is to override the sizing
  by hand at dispatch and record why.
- **Overriding it by hand leaves no trace on the ticket, and that is an audit hole, not a
  footnote.** The reviewers ran a full pass because they were told to, not because the record
  said to. So T-6's record does not describe T-6's work: the ticket reads `risk: low` and a
  full-depth review demonstrably happened, with nothing connecting the two. A later reader — a
  conformance pass, an auditor, the next session — gets two options and both are wrong: believe
  the label and conclude a security-surface ticket got a light review it did not get, or see the
  depth of the review and be unable to explain why it happened. An override that cannot be
  recorded is a divergence between what the factory did and what the factory says it did, which
  is the green-board disease pointing the other way.

  The remedy while the tracker cannot express it: put the override in the ticket's OWN evidence
  trail, where someone reading the ticket will hit it — for T-6 that is
  `.autodev/evidence/T-6/review-depth-override.md`, naming the override, who made it and why. A
  lessons file is where the general rule lives; it is not where a reader of one ticket looks.

## A rule people remember is not a guard (T-11, incident 2026-09-07)

T-11 shipped the owner's-name scrub on 2026-09-05: `.autodev/` and `kb/days/` untracked and
ignored, tracked docs reworded to "the owner", and `autodev/instructions/public-repo.md`
written "for future sessions". Every part of that is a **convention** — it works exactly as
long as whoever is typing remembers it.

On 2026-09-07 a session wrote the owner's name into `kb/CURRENT-WORK.md`, a tracked file in the
public repo, while recording an unrelated note. It was caught at commit time by the session
re-reading its own diff against the convention. Nothing mechanical would have stopped it: no
pre-commit hook, no CI check, no lint rule — the name would have been pushed.

The lesson is about the shape of the fix, not the slip: **a scrub is a one-time state, a guard
is a standing property.** T-11 delivered the state and documented the intent, which is why the
repo is clean today; it did not deliver anything that keeps it clean tomorrow. Any rule whose
enforcement is "a future session will remember" should be read as unenforced, and the cheap
mechanical version — a pre-commit grep over tracked paths — is worth more than the document
that asks for it.

## `git add <paths>` does not scope a commit (T-5)

`git commit -m <subject>` with no pathspec commits **the whole index**, not the paths you just
staged. An extension that stages one file and commits can therefore sweep up whatever the user
had staged themselves — and in a folder the extension `git init`ed for them, "Stage All
Changes" is one click away.

The second half is worse than the first: the test covering it asserted the **argv handed to a
fake git**. A fake that records arguments can only tell you what you asked for, never what
happened — it proved the staging, said nothing about the commit, and passed for the whole time
the behaviour was wrong. Where a real tool is cheap to run (git in a temp directory is),
assert the RESULT, not the request.

Same ticket, same family: `fs.existsSync('<dir>/.git')` answers "is this a repo ROOT", not "is
this inside a working tree". Ask git — `git rev-parse --is-inside-work-tree` — or you will
create a nested repository inside someone's existing one and put their commits where their own
`git log` will never show them.

## A lexical path check is not a filesystem check (T-5)

`path.resolve` plus `startsWith(root + sep)` catches `..`, absolute paths and sibling-prefix
paths. It does **not** catch a symlinked directory *component*: a repository can commit
`up -> ../..`, git recreates it on clone, and `up/anything` is then contained by arithmetic and
outside the folder on disk. `mkdirSync(recursive)` follows it happily. There is a
non-adversarial trigger too — pnpm makes `node_modules/<pkg>` a directory symlink.

Two things it taught beyond the fix:

- **Order the real check before you create anything.** Resolve the deepest already-existing
  ancestor first, or `mkdirSync(recursive)` has already followed the link and made directories
  outside on the way down before any check fires.
- **A comment claiming a defence is complete stops the next reader looking.** The file said the
  symlink half "lives with the fs gate in extension.ts" — true of the READ path, false of the
  write path the next ticket added, and precisely the sentence that let the hole ship.

## When work moves to an async chain, re-make every decision the chain invalidates (T-5)

Two bugs, one shape. The editor reveal was decided synchronously in `refresh(true)`, before the
queued write ran, so it looked at a file that did not exist yet, cleared the decorations, and
never revisited the question once the write landed. The liveness check had the mirror problem:
`applyCheck` decided nothing after either of its awaits, so a disposed session still wrote
progress, repainted every surface and ran git.

Ask, of every await introduced: what did we already decide that this could make untrue?

## A test fake that answers from a table can manufacture the blind spot (T-5)

The session suite's fake `fileExists` returned `true` for every path, so the suites using a
real target could not observe a file *appearing* — exactly the transition the missing-reveal
bug lived in. The fake was not merely failing to catch the bug; its convenience was what made
the bug unobservable.

Where the real thing is cheap — the filesystem, git, a temp directory — the fake should answer
from it, and keep the table only for what is genuinely in-memory.

## A staleness guard placed BEFORE the await it was written for drops work instead of deferring it (T-5)

`WalkSession.applyDial` opened with "if the walk has moved on, return", justified by a comment
about not writing a file for a step nobody is looking at after waiting behind a modal. The
check sat at the top of the method, before any `await`. So a queued entry pass for a step the
learner had already navigated past was **dropped, not deferred** — two `next()` calls in one
tick left two files unwritten and produced one commit instead of three, with no error, no
note and no tree mark. Nothing looked wrong; files were simply missing.

Two rules came out of it:

- **A guard that protects the tail of an async job belongs after the await, not before it.**
  Before the await it is not answering "has this become stale while I waited", it is answering
  "was this already stale when I started", which for queued work is usually "no, it was
  queued deliberately".
- **Check whether the scenario is even reachable.** The prompt in question is
  `showWarningMessage(..., { modal: true })`, and a modal blocks the window — the learner
  *cannot* navigate while it is up. The guard was paying a real cost to prevent something
  the modality already prevented.

Found by the ticket's own acceptance suite, which refused to test around it. That is the
second lesson worth keeping: a suite that walks the way the acceptance criterion *means*
(arrive at each step, let each arrival finish) is what makes a bug like this visible, whereas
one written to match the implementation would have gone green.

## Byte-for-byte means compare bytes (T-5)

AC6's mutation proof flips `0xff` to `0xfe` in a binary fixture. Both decode to U+FFFD, so a
string comparison sees no difference at all. Anything claiming byte equality compares Buffers,
and its own test should use a mutation a string comparison would miss — otherwise the claim
is untested by construction.

Related, from the same ticket: a reference file that is not valid UTF-8 is now **refused**
rather than round-tripped through a string, because that round trip rewrites it with
replacement characters and surfaces much later as a `diff -r` failure with no obvious cause.

## Anything read on activation is untrusted input (T-4)

`loadProgress` and `loadPlan` both parsed and cast. `{}`, `null` and `[]` all parse and are
fatal one property access later — thrown from a `void`ed activation promise, where nobody is
listening. The symptom is not an error; it is a feature that silently never appears.

Shape-check anything read at startup, and report the failure where the eye already is. Lean
toward reading a file you do not fully recognise (an unknown future `schemaVersion`) rather
than discarding it: throwing away a learner's real progress is the worse of the two failures.

## A development host does not enforce workspace trust (T-4)

`capabilities.untrustedWorkspaces` is ignored for extensions loaded via
`--extensionDevelopmentPath`. A workspace-trust protection therefore **cannot** be verified
from the dev host — test it by installing the packaged `.vsix` into a throwaway
`--extensions-dir`, or you will watch a working guard appear broken and "fix" it.

## A control that silently declines is a broken control (T-3, repo-tour)

Inherited from repo-tour and repeatedly earned since: if something cannot act yet, it says so
where the eye already is. T-4's alternatives carry a "coming with T-10" label and render no
`<button>` or `<input>` at all — nothing in the DOM to click is a straighter answer than
something greyed out. T-5 deleted the "arrives with T-5" placeholder the moment the real
thing existed, because by then the placeholder was the lie.
