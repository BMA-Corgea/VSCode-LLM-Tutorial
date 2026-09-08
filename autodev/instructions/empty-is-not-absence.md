# A check that cannot tell "did not run" from "found nothing"

Read this before writing anything that concludes from an empty result.

## The rule

**A check that cannot distinguish *did not run* from *found nothing* will report success in exactly
the conditions it exists for.**

An empty result is not evidence of absence unless **the query is known to be complete**. Prove the
query ran before drawing anything from what it did not return.

The remedy is cheap and it is a shape, not a special case: **a distinct outcome for "I could not
tell"** — a third exit code, a `refused` variant beside `pass`/`fail`, a returned reason rather
than a bare empty list. Something a caller cannot mistake for good news.

## Three instances from one day, which is why this is a rule and not an anecdote

1. **The disclosure check that passed vacuously.** With no owner needles and no git identity — the
   bare CI environment, and precisely what a GitHub runner gives you — it printed
   `passed VACUOUSLY` and **exited 0**. The check that exists to stop a personal name shipping
   reported success in the one configuration it was built for. It now exits **2**, deliberately
   distinct from the **1** a real violation returns, so *"we did not check"* and *"we found
   something"* stay different facts.
2. **`grants` returning `[]` while six covering go-aheads sat in the ledger.** The driver ran the
   query, got an empty list, and concluded no delegated authority covered a gate — then reasoned at
   length about how to obtain one. `grants` lists records from the `grant` verb; the authority in
   use was `human.go-ahead`, a different mechanism. **The query was answering a narrower question
   than the one being asked, and its empty answer looked like a complete one.**
3. **The absent extension-host log.** A verification probe found no log file and no activation
   line. That is neither a failed activation nor a successful one — the editor had been killed
   before writing anything. Related: the same editor without `--no-sandbox` dies before writing a
   line **while exiting 0**, so every signal a script reads says success.

## The test to apply

**If this query returned empty because it never really ran, would anything look different?**

If not, you have a check that is silent in exactly the case it was built for. Add the third
outcome, or assert something positive was produced — a known marker, a nonzero count, the query's
own record of having executed — before concluding from the absence of bad news.

This is the same family as *an absent value read as a meaningful one* (`kb/wiki/lessons.md`): there
the absent thing was a value, here it is the answer itself.
