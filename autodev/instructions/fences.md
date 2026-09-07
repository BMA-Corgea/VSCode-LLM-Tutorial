# A fence should be as fine as the work is disjoint

Read this before fanning work out to more than one worker.

## The rule

**A fence should be as fine as the work is disjoint. Files are a convenient unit, not a correct
one.** Where two changes provably do not touch — and **line ranges are provable** — the fence is
the ranges, not the file.

## The three variants, which are a progression rather than three anecdotes

| | what happened | outcome |
| --- | --- | --- |
| **T-6** | two workers handed a fence that **claimed** to be disjoint and shared `test/tutor.test.ts` | **collision** — contained only because one worker recognised a stranger's contract in an assertion and declined to overwrite it |
| **T-7** | the shared surface (`Detour` types) **hoisted into its own file and committed before dispatch** | **no collision** — disjoint by construction rather than by assertion |
| **T-12** | fence drawn at **file** granularity over work that was disjoint **within** the file | **no collision, and needless serialisation** — a real integration join invented that did not need to exist |

The first is **unsafe**. The third is **safe and wasteful**, which is exactly why nobody catches
it: nothing fails. Work simply takes longer, a join appears that nobody needed, and the worker
who reports "that's outside my fence" is behaving correctly under a wrong instruction.

## The evidence, because it is what makes the rule usable

On T-12 the driver fenced all of `src/walk/session.ts` to one worker. The actual hunks:

    T-13's changes:   session.ts  -170, -468, -1188, -1973
    T-12's need:      reproduceInto (2013), wouldReplace (2066)

They never come near each other. The check that would have caught it costs one `git diff` and one
`grep -n` — the same effort already spent asserting the fence was disjoint, pointed at line
numbers instead of filenames.

## How to draw one

1. **Hoist first.** If a surface is genuinely shared — types, constants, a small interface — pull
   it into its own file and commit it *before* dispatch. Nothing to police beats a policed fence.
2. **Then check the ranges, not the names.** For each worker, locate the functions it will change
   and confirm the sets do not overlap. A file appearing in two lists is a *question*, not a
   verdict.
3. **When the work genuinely does not split, do not split it.** T-7's seventeen review fixes all
   converged on two files and went to one worker. Refusing to parallelise is the same discipline
   as hoisting, not a retreat from it — parallelism is a property of the work, not a target.
4. **Say which it is in the brief.** "You own `session.ts` lines 2000-2100 (`reproduceInto`,
   `wouldReplace`); another worker owns the four hunks above line 1980" is a fence a worker can
   actually honour. "You own `session.ts`" is not, when someone else owns part of it.

## The failure mode to watch for in yourself

A worker reporting "I could not fix X, it is outside my fence" is **evidence about the fence**, not
just about X. Before accepting it as an integration item, check whether the constraint was real.
On T-12 it was not, and the driver relayed it upward as a legitimate join.
