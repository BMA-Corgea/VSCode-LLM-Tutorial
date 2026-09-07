# When a finding is actually closed

Read this before marking any review finding fixed, waived, or resolved.

## The rule

**A finding is closed only when every path it names has been re-driven. A finding that names
two halves and is fixed on one is not closed — it is renamed.**

If you fixed part of it, the honest moves are to split the remainder into its own ticket, or to
rewrite the finding so it names only what is actually left. What you may never do is mark the
original closed and let the record carry a claim the code does not support.

## Why this is written down

Findings are usually closed by the person who just fixed them, at the moment they feel finished.
That is exactly the moment the second half of a two-part finding is easiest to lose: the fix that
was done is vivid, and the path that was not touched is not in front of you.

It happened here, twice in one day, in both directions:

- **T-5 security finding 3** named two things: `reproduceFiles` overwriting without a prompt, and
  `reproduceFiles` having **no name allowlist** on what it may write. The prompt half was fixed.
  The allowlist half was not. The finding's disposition recorded it as FIXED, and the record said
  so from 2026-09-06 until T-6's security review re-drove the path on 2026-09-07 and found a
  reference repo's `.claude/settings.json`, `.mcp.json` and `.env` still being copied into the
  learner's folder. Now filed as **T-12**.
- **T-6's own risk class** claimed `low` while a full-depth review had been run by hand, because
  an override had nowhere to be recorded. Same shape: the record asserting something the work did
  not support.

Detection was hardened and delivery was left untouched, and nothing in the process noticed —
because closing a finding takes no evidence. Passing a *stage* requires a validator and a
location; closing a *finding* requires only someone's opinion that it is done.

## What re-driving means

Not re-reading the code and satisfying yourself. **Run the thing the finding described and watch
it fail to happen.** If the original finding was confirmed by a harness, that harness is the
close criterion — run it again and show it now comes back clean. If a finding was only ever
argued from source, it was never confirmed in the first place and closing it is guesswork on
top of guesswork.

A useful test of your own honesty: *can you point at the output that shows this path is now
safe?* If the answer is a paragraph of reasoning rather than a location, you have not closed it.

## The general form

This generalises past reviews. Any record that says work is DONE — a finding, a gate, an
acceptance, a checkbox in a plan — is a claim about the code, and the value of the whole paper
trail is that such claims are true. A record that overstates in the safe-sounding direction is
worse than no record, because the next person stops looking. Both of the day's incidents were
records claiming more than the code supported, and neither was caught by a mechanism; both were
caught by someone re-driving the path for an unrelated reason.
