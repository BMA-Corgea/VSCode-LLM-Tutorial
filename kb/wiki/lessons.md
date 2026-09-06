---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from. These
are the things that cost real time and would cost it again.

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
