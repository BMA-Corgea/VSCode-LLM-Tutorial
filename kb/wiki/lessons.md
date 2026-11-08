---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from. These
are the things that cost real time and would cost it again.

## A defence that makes a defect harmless also makes it invisible to the tests (T-17)

Twice in one build, a test passed against the exact defect it was named for. Both were caught
only because each new pin was broken by hand and the failures counted
(`.autodev/evidence/T-17/red-checks.md`):

- **A refactor "kept the tests green".** The detour's path rule was hoisted into a shared function
  that takes the folder's name as an argument. Passing the WRONG name left all 271 detour tests
  green, because they match refusals loosely (`/deep/i`, `/longer than/i`). "Green after a
  refactor" proved only what those tests pinned, and the wording was not among it.
- **A cache that kept garbage looked identical to one that did not.** The rule is "only a reply
  that parsed is cached". The mutant cached every reply before parsing it, and **nothing failed**:
  every cached reply is re-parsed on the way back in, so a cached bad reply is refused there and
  the next call happens anyway. The defence (re-parse every cached read) made the defect harmless,
  and harmless is exactly what a behaviour test cannot see. The claim had to be pinned where it
  lives, by asserting that nothing is on disk after a refused reply.

> **When one safeguard covers for another, a test of the behaviour cannot tell whether the second
> safeguard exists. Pin each claim at the place it is true.**

The trap is that the first green is honest. Nothing about reading the test says it would miss the
defect: it only misses it because something else catches the defect first. Stacked defences are
right — two halves of containment, a parser behind a cache. But each half needs its own pin, or
the day the covering half is loosened, both go at once and the suite notices neither.

Tooling note from the same build: the file-writing tool turned the escapes `\u2028` and `\u2029`
into the raw characters, and a raw U+2028 ends a JavaScript line. It broke a regex mid-literal.
`String.fromCharCode(0x2028)` writes the same value with no escape for a tool to "helpfully"
decode. Check new files with `grep -cP "\x{2028}|\x{2029}"`.

## Read the screen, not the markup — `webview.html` never changes after a press (T-15, 2026-11-05)

T-15's September fix was reviewed, corrected and merged with its pins green. Re-driven two months
later **by reading the real webview's DOM**, it still had four holes the screen showed at once: a
second refused press changed only an invisible `data-press` attribute; a double-click started two
builds; closing the tab mid-build swallowed the build's ending; and the progress notification
outlived the build. Separately, deleting the host's `buildFinished()` call left **1256 unit + 75
vscode-test green**. Its only test handed the page `form:idle` by hand, so nothing checked that the
host ever sent it.

Every one of those survived because **no test looked at the screen**. A vscode-test can read
`panel.webview.html`, and that is the markup the host handed over. It is not the page. Everything a
press changes is changed by the page's own script afterwards, so a test reading `webview.html` sees
the same thing before and after any press: blind in exactly the way the owner was not.

> **If a property is about what a person sees, the test has to read what a person sees.** Here
> that is `test/support/screen.ts`: the test host runs with a loopback, OS-assigned DevTools port,
> and a test finds the webview's frame by its title, reads the DOM, and clicks the real button.

Two things it taught beyond the harness:

- **Name what "observable" means, then check the pin uses it.** The September suite defined
  `observable()` as "what a person could SEE" and then pinned finding 3 on an attribute outside
  that definition. Under the suite's own definition the defect was still there.
- **The corner toasts are not a witness either.** Driven: an error toast sent while a progress
  toast was up was not drawn in the corner at all. The notification centre (the bell's list)
  holds every notification until it is closed, so read that.

## A message without buttons waits for the person, not for the message (T-15, 2026-11-05)

`await vscode.window.showErrorMessage('…')` with no buttons settles **when the person closes the
notification**, not when it appears. Inside `withProgress` that kept "reading the repository…" and a
live *Cancel* on screen after the build had already ended, and held back everything after it:
clearing the bookmark and, on success, opening the walk. A finished build looked like a running one
until somebody dismissed a toast. **Await a message only when you need its answer.**

Same ticket, same shape of mistake one layer up: the build's ending was reported to the panel
**captured when the build started**. Close that tab mid-build and `panel.webview` throws "Webview is
disposed" from inside `reportOutcome`, unhandled, and the error, the completion and the walk all
vanish with it. **Report to what is open now, not to what was open when you started.** Here that is
`StartPanel.current`, which is cleared on dispose, so it can never be a disposed panel.

## A test that types the default is not testing the default (T-8)

T-8 changed `buildTutorials.repoTourPath`'s shipped default from `'../repo-tour'` to `''`. That
one character routed `resolveCoreRoot` through `require.resolve`, which **throws** where the old
branch returned a reportable failure — so the **Doctor**, the one command whose entire job is to
be useful when the core is missing, printed a raw Node stack. `README.md` promised on the same
page that a misconfiguration is *"a report in plain sentences, never a stack trace"*.

**1,212 tests were green over it.** Not because the coverage was thin — because **all ten call
sites passed `'../repo-tour'` as a literal**. Every test exercised the value the tests had typed,
so the shipped default was untested by construction, and changing it changed nothing any test
could observe.

> **A test that types the default is testing the literal, not the default. Read the shipped value
> from where it ships.**

The fix that mattered was not making `resolveCoreRoot` total — that repairs this instance. It was
the new test reading `contributes.configuration.properties[…].default` **out of `package.json`**
and never typing the string, plus collapsing four scattered copies into one exported constant with
a test asserting it equals the manifest's. That is what stops the next change re-hiding it.

The general form, which is bigger than defaults: **any value that exists in two places — a
manifest and a constant, a schema and a validator, a config default and a fallback — is a place
where a test can agree with the wrong copy.** Import the one that ships, or assert the copies are
identical. This is the fourth costume the same failure wore in one run: a hand-enumerated mutation
sweep proving the list rather than the property; a 972-line suite proving a property of a function
nothing called; a "binary" exclusion that was really a NUL probe with a shipped `.js` hidden inside
its count; and this.

## A process that dies before it can speak looks exactly like one that ran clean (T-8)

Verifying the packaged extension in real VS Code needed `--no-sandbox`. Without it that build dies
**before writing a single line to its log** — while the CLI still exits **0**. Every signal a
verification script reads says success: no error, no stack, clean exit, and an empty log that a
"no errors found" grep is delighted by.

This is the same failure as a timed-out `git rev-parse` read as *"you are not in a repository"*
and an unset `$C` expanding to nothing — **an absent value read as a meaningful one** — but the
absent thing here is *the entire output*, which is the hardest case to notice because there is no
wrong value to catch, only nothing where something should be.

> **A verification that concludes from the absence of bad news must first prove there was news.**

Assert something POSITIVE was produced — a known line in the log, a nonzero byte count, an
expected marker — before drawing any conclusion from what is missing. The T-8 review then asked
the right follow-up, which is the reusable part: *what else in this repo concludes from silence?*

## Give the prose to someone who has not seen the predicate (T-12)

T-12's fix stated its rule in prose above the code — deliberately, because the instruction was to
design *a rule* rather than hand-type four filenames, so that a reader could extend it correctly.
The prose was **right**. The predicates behind it were not.

The reviewer found six under-refusals — `.envrc`, `.husky/pre-commit`,
`.github/copilot-instructions.md`, `.codex/config.toml`, `.zed/settings.json`, `auth.json` — and it
found them by **reading the stated rule cold and enumerating what it covers**, then checking that
list against what the code actually did. It also found the opposite: `.env.example` and its family
withheld, which the prose never asked for.

That is a test method, not an anecdote:

> **When a rule is stated in prose and implemented as a predicate, verify it by giving the prose to
> someone who has not seen the predicate and asking them to enumerate what it covers. The gap
> between their list and the predicate's behaviour is the bug — in both directions.**

It works because the two artefacts are written by the same person minutes apart, and the prose is
where the intent is complete while the predicate is where attention ran out. Reading them together
hides the gap; reading the prose *first and alone* is what exposes it. The same trick applies to a
docstring against its function, an AC against its test, and a schema comment against its validator.

Corollary worth keeping: **a rule that is documented well enough to audit is a rule that can be
audited against its documentation.** Writing the prose was not overhead that happened to be nice —
it is what made the six misses findable.

## Choosing the narrower option does not exempt you from the rejected one's failure (T-12)

The decision form offered three shapes for T-12 and the owner picked **A** (deny known-secret
names). Option **B** — copy only what the tutorial's steps reference — was rejected on the record
for one reason: it *"will silently stop delivering legitimate files… you would discover it as
missing scaffolding halfway through a tutorial, not as an error."*

The implementation of A then withheld `.env.example`, `.env.sample`, `.env.template` — the
placeholders projects commit on purpose — and a learner would have met that exactly as B's
rejection describes: missing scaffolding, mid-tutorial, no error.

> **Picking the narrower option makes its sibling's failure a bug instead of a design. It does not
> make it impossible.**

So the reason an option was rejected is a **test to run against the option you chose**. Every
rejected alternative in a decision record names a failure mode someone already thought was worth
avoiding; that list is free, specific, and written before anyone was invested in the
implementation.

## A trailing slash in .gitignore matches a directory, not a symlink to one (T-15)

A worktree shared dependencies with the main checkout the obvious way — `ln -s
../VSCode-LLM-Tutorial/node_modules node_modules`. `.gitignore` said `node_modules/`.

**The trailing slash matches a DIRECTORY only.** A symlink is not a directory, so the link was
not ignored, was committed, and on merge replaced the main checkout's real `node_modules` with a
link pointing at itself. `require.resolve` then failed with `ELOOP`.

> **Ignore both forms — `node_modules/` and `node_modules` — whenever a path might ever be a
> link.** The slash is a promise about what the entry IS, and a symlink quietly breaks it.

Two things worth keeping beyond the one-line fix:

- **The tell was in the merge output**, not at the next build: `create mode 120000 node_modules`.
  Mode `120000` is a symlink, and a symlink appearing in a merge that should have touched only
  source is worth a second look. Reading what a merge says it created is cheap; discovering it
  through a broken toolchain is not.
- **The convenience caused it.** Sharing `node_modules` between worktrees saves a minute of
  `npm install` and costs a class of failure that does not exist otherwise. The repo's own
  conventions already say worktrees are siblings so `file:../repo-tour` resolves — which means
  each worktree can afford its own install, and should have one.

## Red-checking is the only thing that separates a pin from a decoration (T-15)

The pin written for T-15 was **worthless, and it took thirty seconds to find out.**

It built a fake page, delivered `form:rejected` to it by hand, and asserted the page changed. It
passed. It also passed **with the defect fully reintroduced** — because the defect lives in *which
message the host chooses to send*, and a test that supplies the right message never exercises that
choice. Coverage aimed at a path the bug does not live on, written inside the pin for that exact
lesson.

The rewrite drives the real `handleStartMessage`, takes **its actual reply**, and feeds that to the
page — spanning the protocol's choice and the view's rendering, which is where the property lives.
Re-driven: **3 failing with the defect restored, 16 passing without it.**

> **A pin you have not watched fail is not a pin. Break the code by hand and count the failures.**

Two things make this the sharpest instance so far:

- **The green was honest.** No mistake in the assertions, the fake DOM, or the wiring. The test did
  exactly what it said. It was simply pointed one layer away from the defect — and *nothing about
  reading it would have revealed that*, because reading a test tells you what it checks, never what
  it would have missed.
- **The number matters, not the colour.** "It goes red" is weaker than "3 fail, and they are the
  two named cases plus the one that depends on them." Count them, name them, and notice if the
  count is smaller than expected — a pin that fails in one place where you predicted three is
  telling you the other two are aimed wrong.

This is the same family as the store's 972-line suite proving a property of a function nothing
called, and as ten call sites typing a default the shipped code no longer used. **A suite is
evidence only for the path it actually exercises**, and the cheapest way to find out which path
that is, is to break the code and watch.

## Feedback has to be a CHANGE, not a state (T-15)

The start screen validates on every keystroke, so a field's problem is already on screen before the
button is pressed. Pressing **Build the plan** with a blocking problem returns the same message the
keystroke already returned — so the reply to the press is **byte-identical to what preceded it**.

The owner pressed the button and nothing happened. His words: *"I clicked build the plan but I have
no way of knowing if it's loading or if it's errored."*

> **A validation message that is already on screen cannot also serve as the response to a press.
> If the reply to an action is identical to what preceded it, the action is indistinguishable from
> being ignored.**

The trap is that the message is *correct*. Every problem is named, under its own field, in plain
language — the requirement is met. What is missing is not information, it is **difference**. A user
does not read the page fresh after a press; they look for what moved.

Two consequences worth keeping:

- **"Nothing happened" and "it is working" are the same picture.** A slow accepted submit shows the
  same unchanged screen as a rejected one, so the ambiguity is worst exactly when the action
  succeeded and is taking time.
- **The requirement was written against the wrong failure.** T-3's README promised *"never a
  disabled button with no explanation"* — and satisfied it by shipping an **enabled button with no
  response**, which is worse, because a disabled button at least tells you it will not work. When a
  requirement names a specific bad pattern, check whether it forbids the pattern or forbids the
  *harm* — and fix the sentence when you fix the code, or the trap is reset for the next feature.

## The family: two states that look identical (T-3, T-6, T-8, T-13, and the ledger)

Six instances in one project, and they are one defect wearing six costumes. **Two situations that
should be distinguishable produce the same observable.**

| where | the two states |
| --- | --- |
| **T-15** the start screen | a rejected press and a working press both leave the screen unchanged |
| **T-6** the tutor | *"a button that did nothing, with no spinner and no way to cancel"* — pressing *Ask* looked exactly like a dead control |
| **T-13** git | a **killed** `rev-parse` and a `rev-parse` that **answered false** were the same rejection, so `ensureRepo` created a nested repository |
| **T-8** the disclosure check | *"did not run"* and *"found nothing"* both exited 0 |
| **T-8** the VS Code probe | a build that died before writing a log line and a clean run both exited 0 with no errors |
| **the ledger** | `grants` returning `[]` meant *"no grant of this kind"* and read as *"no authority exists"*, while six covering go-aheads sat unqueried |

**The remedy is the same shape every time: make the two states produce different observables.** A
distinct exit code, a distinct message type, a positive assertion that something was produced, a
transient the eye can catch. Not more information — *different* information.

**And the review method matters.** This family is nearly invisible to the way these reviews work.
Every T-3 review checked the emitted markup and the markup was right; the defect is in **what does
not change between two renders**, which no single-render inspection can see. Asking *"is the right
thing on the page?"* cannot find it. Only pressing the button twice can — which is why the owner
found in five minutes what eleven machine reviews across five tickets did not, and why a human
walking the thing is not a formality.

## An absent value read as a meaningful one — the same bug in the product and in the harness (T-13)

Two failures from the same hour, which look unrelated and are not:

- **In the product.** `realGit` had no timeout, so a `git rev-parse --is-inside-work-tree` that was
  killed came back indistinguishable from git answering. `ensureRepo` read that as **`false`** and
  ran `git init` — creating a **nested repository inside the learner's own repo**, where every
  later step commits somewhere their `git log` never looks. A timed-out `git config` likewise
  reported a perfectly good identity as missing.
- **In the test harness.** A probe written as `rm "$C/$file"` where `$C` was inherited from an
  earlier unchecked command. An unset `$C` expands to nothing, and the line becomes `rm /<file>`.

**Both are an absent value being read as a meaningful one.** Not "no answer" — a *specific* answer
that happens to be falsy, empty, or zero-length, and that flows onward as if it were real. The
product turned "we killed git" into "you are not in a repository". The shell turned "this variable
was never set" into "the filesystem root".

> **Distinguish "no answer" from "an answer that happens to be falsy", and make the absent case
> abort rather than proceed.**

The remedy has the same shape in both places, which is what makes it a rule rather than two fixes:

- **Product:** a bound with a *working default*, so a call site added later inherits it by
  existing; and a distinguishable failure (`GitTimeoutError`) so "killed" can never be mistaken for
  "answered". Note which half matters — the timeout stops the hang, but the **distinguishable
  rejection** is what stops the wrong answers downstream.
- **Shell:** `set -euo pipefail` so an unset variable aborts instead of expanding; mint the scratch
  directory in the same script and prove it (`[ -n "$C" ] && [ -d "$C" ]`) before anything touches
  it; `trap 'rm -rf "$C"' EXIT` so a removal names a directory you created rather than a path you
  assembled.

And one habit that removes the class rather than guarding it: **a probe that only ever adds and
moves cannot delete the wrong thing.** To test whether something notices a file, copy the tree and
`mv` the file aside, or write the mutation to a fresh path. Reach for `rm` in a harness only when
nothing else will do, and then only against a directory the same script created.

The reason this is worth one entry rather than two: the discipline the codebase applies to its own
error paths is the discipline the throwaway scripts deserve too, and the throwaway script is where
it is easiest to skip — it is temporary, it is about to be deleted, and it is running with the same
permissions as everything else.

## Keys do not travel: an identifier is only a key inside the space it was minted for (T-7)

repo-tour mints a step id as `sha256(file + ' ' + kind + ' ' + symbolName)`. **Nothing is wrong
with it.** Inside one plan, for one repository, it is a correct and sufficient identifier — that
is the space it was minted for.

It became a defect the moment it was used as a key in `globalStorageUri`, which is
**per-extension, not per-tutorial**. Two tutorials that happen to share a file path — `src/index.ts`
is not an exotic coincidence — collide by construction. Driven, both halves: a session being
disposed **deleted a live session's detour directory** (leaving tabs open on deleted files, a
narrator describing them, and no sentence anywhere), and one repository's worked example was served
to a different repository for free, `runLlm` calls = 0.

The rule:

> **An identifier is only a key inside the space it was minted for. Moving state into a wider
> store requires re-deriving every key in it.**

The shape is worth recognising because it does not look like a bug at either end. The id is
correct. The store is correct. The defect lives in the join, and it appears at the moment scope
widens — a per-plan id reused per-extension, a per-request id reused per-session, a per-tenant id
reused globally. Nothing changed except the space, and the space is exactly what the key encoded
implicitly.

Ask it as a question whenever state moves outward: **what did this identifier assume about its
world, and is that still true here?** If the answer needs a sentence, the key needs a component.

## Coverage aimed at a dead path is evidence about nothing, while looking like evidence about everything (T-7)

`src/detour/store.ts` carries a **972-line test suite** that proves, carefully and correctly, that
a write's containment root must be the *proven store* rather than a composed path. The function it
proves that about — `writeDetourFiles` — **has no caller.** The code that ships is
`session.ts`'s `writeDetour`, which makes the **opposite** choice, and a symlink swapped in between
check and write put a file outside the store with nothing thrown.

This is not missing coverage. Missing coverage is honest: it reads as a gap and invites someone to
fill it. **This is coverage pointing at a corpse, and it is strictly more dangerous than no tests
at all** — anyone auditing that file sees 972 lines of security tests, concludes the property is
held, and moves on. The suite is not wrong about anything; it is simply about a path nobody walks.

> **Coverage proves a property of the path it exercises. A suite aimed at a dead path is evidence
> about nothing.**

So: when a security property is claimed, check what CALLS the thing the tests exercise, not just
what the tests assert. A `grep` for callers is a one-line check and it is the difference between a
proof and a decoration.

## The class: records that are easier to write than to earn (T-5, T-6, T-7)

Three instances in a single day, each in a different medium, all the same disease:

| # | The record | What it claimed | What was true |
| --- | --- | --- | --- |
| T-5 | a review finding marked **FIXED** | both halves of finding 3 were closed | only the overwrite half; the missing allowlist is live on main (now T-12) |
| T-6 | a ticket's **`risk: low`** | a light review was proportionate | the diff shelled out to an LLM, read two repos into a prompt and rendered model output into a webview |
| T-7 | a **972-line test suite** | the write path's containment root is proven | it proves it of a function nothing calls |

None of the three was a lie, and no one was careless. Each is a record that costs almost nothing to
write and a great deal to earn — a disposition field, a label, a test file — and each was written
in the direction that ends the conversation. **A record that overstates in the safe-sounding
direction is worse than no record, because the next person stops looking.** All three were caught
by someone re-driving a path for an unrelated reason, never by a mechanism.

The counter-discipline, and it is the same move every time: **ask what would have to be true for
this record to be false, then go and look.** A finding is closed when its path is re-driven
(`autodev/instructions/closing-findings.md`); a risk class is earned by naming what the code
touches; a test suite is evidence only for the path it actually exercises.

## An invariant nothing would trip is a coincidence that held once (T-6 → T-7)

T-6 deliberately kept the model call **off** the walk's serialised chain — reasoned about at
length, paid for in design, written down in the handoff. T-7 put it back on. **Every test stayed
green**, and it took a machine review driving the observable behaviour to notice that a detour
generation silenced `step:check`, `dial:set`, `tutor:clear` and `detour:back` for up to an hour.

The property was real and was never pinned by anything a later ticket would break. So:

> **An invariant that is not pinned by a test the next ticket would break is not an invariant. It
> is a coincidence that held once.**

Two consequences worth keeping:

- **Pin the observable property, not the mechanism.** A test asserting something about `enqueue`
  would have been satisfied by a new mechanism that reintroduced the same bug. The property that
  matters is *"while a model call is in flight, the other controls stay live"* — true or false
  regardless of how the call is made.
- **A handoff that says "we deliberately did X" without naming the test that enforces X is a
  handoff that will be silently undone.** A ticket that establishes an invariant owes the next
  ticket a test that fails when it is broken. Saying it in prose transfers the intention and not
  the guarantee — and the next ticket has its own problems to think about.

## A reviewer that re-derives its own baseline is why a mistake in the brief is survivable (T-7)

T-7's review brief told both reviewers "baseline entering T-7 was 966 unit tests". That was
wrong — 966 was the mid-ticket count after three workers had already landed; `main` measures
**737**. The brief was written by the driver who had just run both numbers and still conflated
them.

It cost nothing, and the reason it cost nothing is the whole lesson: **the code reviewer measured
`main` itself before starting, found 737, and said so in its report.** It reported a genuine
+308/+9 diff instead of the +79 the brief implied.

Had it inherited the number, it would have verified a diff a third the size of the real one and
called it green — and the reader of that review would have been measuring the driver's confidence
rather than the code. That is the same failure as a green board with nothing behind it, wearing a
number.

**A brief is an input to a review, never a substitute for the review's own measurement.** A
reviewer re-deriving a baseline it was handed is not being pedantic and is not wasting a step; it
is the only reason an error upstream of the review is recoverable. The same applies to every
figure a brief carries — a test count, a file count, a line count, "this was verified" — each is a
claim to check, not a fact to build on.

The general form, which outlives this incident: **whoever checks the work must not inherit the
numbers from whoever did it.** The two prior tickets say the same thing from the other side — a
finding closed without re-driving its path, and a risk label spent without re-deriving what the
code touches. Same disease, different direction of travel.

## Parallelism is a property of the work, not a target (T-6 and T-7)

T-6 fanned out two workers and put one test file in both fences; the collision was contained only
because the colliding worker chose to read carefully. T-7 fanned out three and hit nothing,
because the shared surface — the `Detour` types — was **hoisted into its own file and committed
before dispatch**, making the fences disjoint by construction rather than by assertion.

The corollary is the half nobody remembers to check. When T-7's review fixes came back, every one
of the seventeen findings converged on `store.ts` and `session.ts`. **There was no honest fence to
split them along, so they went to one worker.**

> Make it so there is nothing for two workers to both touch. When that is impossible, do not run
> parallel workers.

Refusing to split is the same discipline as hoisting the shared file, not a retreat from it. A
shop under pressure to keep N agents busy will be tempted to split work that does not split — and
it will get exactly what the T-6 collision predicted: two writers, one shared surface, and
correctness resting on whichever worker happens to read the other's assertion carefully enough.

T-7 shipped that failure in miniature anyway, from a different direction: two write paths into the
detour directory, disagreeing on the security-critical argument, with the test suite proving the
property against the one nothing called.

## A paragraph in the right file about the wrong function documents itself out of the code (T-7)

`store.ts` states, at length and correctly, that the containment root handed to `writeTextAtomic`
must be the PROVEN store rather than the composed detour directory — because a planted
`detours/<hash> -> /somewhere` makes the attacker's folder the root of the containment question
and every write through it is perfectly "contained". `writeDetourFiles` obeys it and carried most
of the module's suite, **including the test that plants the link and asserts the far end stays
empty. It had no caller.** The code that shipped was a second writer in `session.ts`, written the
same day under the same plan, which passed the composed directory; a symlink swapped in between
the check and the write put a file outside with nothing thrown.

Neither file is wrong about anything it says. They disagree, and the suite could not see it,
because the tests that prove the rule are attached to the function that obeys it and nobody runs.
This is T-5's lesson's sibling — there, a comment claiming a defence was complete stopped the next
reader looking; here, a test proving a property against dead code stopped the suite looking.

**An exported function with no caller in `src/` is a finding, not a loose end** (T-6 found the
same shape in `clearTranscript`). Unify or delete; do not keep. And when the stated reason for two
paths is real — here, that clearing the directory has to precede the `realpath` — the answer is to
move the ordering inside the one implementation, never to keep two.

## A cache is a second parser, and it will be the looser one (T-7)

Persisting model output means the validated shape is re-entered from disk by a function that is
not the parser. `sanitizeDetour` is genuinely careful — drops rather than coerces, rebuilds field
by field, re-applies the count limits — and its module header said in as many words that "the
cache is a SECOND door into the same data and gets the same bounds as the first". It got the same
COUNT bounds. It did not get the path allow-list, which is the one bound the whole ticket exists
for; nor a stop's range fitting its file; nor the parser's treatment of a lone `\r`; nor its
case-folded duplicate rule.

Nothing escaped, because the write gate re-runs the lexical check itself rather than trusting a
caller — which was a deliberate decision in another file, and is now load-bearing rather than
defensive.

**If a validator's header says "the same bounds as the first", the bounds it means have to be a
value both of them IMPORT — not a property both of them are supposed to have implemented.** And
the direction matters: the second door must never be STRICTER than the first, or the write path
refuses silently, the cache never hits, and the acceptance criterion fails with every test green.

## "Leaves nothing behind" needs a list of what "nothing" covers (T-7)

AC3 was satisfied: the tabs close, the directory goes, the workspace hash is byte-identical. And
the narrator said on screen, *"These files live outside your project. Going back closes them and
deletes them."* True of the tabs, true of the directory, and not true of the cached copy — same
model-written bytes, in global storage, never pruned, surviving the return and the window
closing. Neither half was a bug; the pair was a promise the code did not keep.

It was invisible because **the acceptance check measured the workspace and the thing that
persists is in global storage**. When a criterion says "leaves nothing behind", write down every
place the feature writes, and check each one — or the check proves the sentence only where you
already looked.

Two fixes, both needed: the copy is bounded, and the sentence now says the copy exists and why.
This repository's honest-controls rule is not only about buttons.

## A sentence with two owners is a sentence drawn twice (T-7)

`DetourSession` returned its refusal AND recorded it for the panel; `WalkSession` took the
returned one and recorded it again on its own channel. Both are reasonable in isolation. Together
the learner read the identical sentence twice, one line apart, in the same section.

**When a lower layer already stores what it returns, the upper layer's job is to route it, not to
re-store it.** The value is still returned — a caller needs to know a refusal happened — but the
storing happens once, where the sentence was composed.

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

## A polish audit compares consecutive states, not frames (T-16)

The design-polish probe measures each state as its own fresh page, and every per-page number
came back clean on the Current Step panel's press outcomes. The defect was between pages: at a
side-bar width, the first screen after *Check my work* is byte-identical for a pass and a fail,
and idle, "writing an example…" and an open detour are one picture. The outcome renders below
the action row and the page re-renders from the top. Hash the first-screen screenshot of the
state before a press and the state after it; identical hashes are a finding whatever the
metrics say. This is T-15's lesson again, one layer up: a press must change what is on screen.

## A theme token can be legal and still wrong for its role (T-16)

The bridge sheet maps every colour to a `--vscode-*` variable, and the hard-coded-colour check
proved it: zero on every page. But the status colours borrowed `symbolIcon.keywordForeground`
and `symbolIcon.stringForeground`, which every default theme sets to plain `foreground`. Pass,
fail and the "news" lines all rendered as body text, and in Light Modern `descriptionForeground`
is `foreground` too, so "muted" collapsed as well. Pick a token by its role (`testing.icon*`,
`errorForeground`, `notificationsInfoIcon.foreground`), then check in every theme that two
states meant to differ really do.
