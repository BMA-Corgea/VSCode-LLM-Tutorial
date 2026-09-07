# A deliberate property owes the next ticket a test

Read this before writing a handoff, and before closing any ticket that decided something on purpose.

## The rule

**A ticket that establishes an invariant owes the next ticket a test that fails when it is broken.**

A handoff that says *"we deliberately did X"* without naming the test that enforces X is a handoff
that will be silently undone. Prose transfers the **intention** and not the **guarantee** — and the
next ticket has its own problems to think about.

## What went wrong, so the rule has a body behind it

T-6 kept a model call **off** the walk's serialised chain. This was not incidental: it was reasoned
about at length, paid for in design, and written into the handoff as a deliberate choice with its
reason. One ticket later T-7 put the call back on the chain, and **every test stayed green.** A
detour generation silenced every other control in the walk — `step:check`, `dial:set`,
`tutor:clear`, `detour:back` — for up to an hour, and it took a machine review driving the
observable behaviour to find it.

Nobody ignored the handoff. The property simply had nothing standing behind it:

> **An invariant that is not pinned by a test the next ticket would break is not an invariant.
> It is a coincidence that held once.**

## How to pin one

**Pin the observable property, not the mechanism.** A test asserting something about the queue's
internals would have been satisfied by a *new* mechanism that reintroduced the same bug. What
matters is the sentence a person would say:

> *While a model call is in flight, the walk's other controls stay live.*

That is true or false regardless of how the call is made, so it survives a refactor — which is the
entire point, because a refactor is how the property gets lost.

The recipe, when a review has already found the violation, is to **invert the reproduction**: the
finding drove `session.ask(…)` during a generation and measured zero pushes, no note, no ticket.
That is the assertion, with the signs flipped.

## Auditing what is already claimed

An invariant established before this rule existed is unpinned until proven otherwise, and "we
checked" is not the same as "a test would fail". Two shapes to be suspicious of:

- **Properties established by `grep`.** "No code path reads this field except the sanitiser" is a
  measurement of *today*. A new call site tomorrow breaks it and nothing goes red.
- **Enumerated sweeps.** A mutation sweep that lists fields by hand proves the fields somebody
  remembered to add. A newly rendered field, absent from both the key and the sweep, fails nothing —
  the gap has simply moved one level up.

Where a property genuinely cannot be pinned — some whole-repo claims are honestly grep-shaped —
**say so beside the claim** rather than leaving a handoff asserting a guarantee nothing enforces.
An honest "this is checked by inspection, not by test" is worth more than a confident sentence,
because it tells the next reader what they are actually holding.

## Why this is a factory gap and not just a project habit

The handoff procedure asks what was produced, where it lives, and what is risky. It does not ask
**what this ticket made true that a later ticket could quietly make false, and what stops that.**
Until it does, the guarantee lives only in whichever reviewer happens to drive the right path for
an unrelated reason — which is how this one was found, and is not a plan.
