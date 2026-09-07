# A finding carried across three fences is a ticket, not a note

Read this when you are about to write "known, not fixed" into a handoff for something you have
seen before.

## The rule

**A finding that has been carried across three tickets' fences is not a note. It is a ticket.**

File it, with honest severity and a link to the finding that first raised it. Do not mention it a
fourth time.

## Why this needs saying

Fences are what make a defect homeless. A worker is given a file list; a defect one file outside
it is correctly reported rather than fixed — that is the fence working, and the alternative
(workers reaching outside their fence) is worse. But nothing in the process notices that the same
defect has now been correctly reported and correctly not-fixed **three times in a row**.

Each individual hand-off is right. The sequence is a slow failure, and it is invisible from
inside any one ticket, because from there it looks like diligence.

The tell is a note that repeats with a new ticket number in front of it. Search the last two
handoffs for the thing you are about to record; if it is already there, you are not deferring, you
are drifting.

## The distinction that matters

**Deferral has a trigger. Drift has a mention.**

A deliberately-unfixed defect is legitimate when it carries the condition that makes it real —
see the `feature-regulated` landmine in `kb/CURRENT-WORK.md`, which names exactly what must happen
before it bites, and is therefore *findable at the moment it matters*. A note that just says "still
unfixed, outside the fence" carries no condition, so nothing will ever surface it. It relies on the
next person happening to read the right handoff.

Two of this repo's tickets exist because that failed:

- **T-12** — `reproduceFiles` with no name allowlist. Recorded as FIXED in T-5's review, live on
  main, found only when T-6's security review re-drove the path for an unrelated reason.
- **T-13** — `realGit` spawning git with no timeout. Raised as T-6 security finding 5's tail,
  repeated in T-6's handoff, repeated again in T-7's monitor evidence. Three mentions, zero fixes,
  no trigger condition, no owner.

## What filing costs, and what it buys

Filing is cheap: a ticket at `intake` blocks nothing and can sit. What it buys is that the defect
now has an **id**, a **severity**, and a place on the board — so it is visible without archaeology
and can be scheduled against other work rather than rediscovered.

And a defect with a ticket has an owner. A defect in a handoff has a reader, which is not the same
thing.
