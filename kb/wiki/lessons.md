---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from. These
are the things that cost real time and would cost it again.

## A rejected `GitRunner` call has thrown its stdout away (T-6)

`realGit` builds its `Error` from `(stderr || err.message)` and drops stdout. So for any git
command whose OUTPUT is the answer and whose non-zero exit is the NORMAL case —
`git diff --no-index` exits 1 when the files differ, with an empty stderr — catching the
rejection gets you nothing to read.

Written the obvious way ("catch the exit-1 and read the output"), a diff module produces a
diff only when the two files are IDENTICAL: the one case with nothing to say. Have git write
the result somewhere instead (`--output=<file>`) and read it on both exit paths. That also
bounds what is pulled into memory, which `execFile`'s 64 MB `maxBuffer` otherwise does not.

The general form: before catching a rejection to read a result out of it, check that the
runner you are using actually carries the result into the rejection.

## Two clips in a row: the inner one wins, and it takes your marker with it (T-6)

The tutor clips the learner's diff before handing it to repo-tour's `buildContextBlock`, which
clips at 8,000 itself with its own bare `… (truncated)`. Clip at anything above that and the
outer marker is cut off by the inner clip — the learner is billed for text the model never
sees, and the sentence explaining why is the first thing lost.

Match the downstream limit exactly, and assert the marker survives into the RENDERED output
rather than into your own return value. Also: an empty value is not always a value —
`buildContextBlock` guards `if (ctx.build.learnerDiff)`, so "identical" and "we had nothing to
give it" reach the model looking exactly the same unless one of them says so.

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
