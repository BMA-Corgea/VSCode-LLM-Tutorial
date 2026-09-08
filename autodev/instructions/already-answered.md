# A question the sponsor's own design already answers is not a question

Read this before putting anything to the person who owns the work.

## The rule

**Before asking, look in the spec they already agreed to.** A question closed by a design they
accepted is not a question — it is a lookup, and asking it spends the one resource that does not
parallelise on work you could have done.

The check is one sentence: **is there a decision already on the record that entails this answer?**
If yes, settle it, and **show the working** — cite the clause. Listing what you decided for them is
not padding; it is how they can tell the difference between a question you did not ask and a
question you did not notice.

## The instances, which is why this is a rule

Four candidate questions for one sponsor, all of which looked real while being drafted:

| the question | already closed by |
| --- | --- |
| *Does Mode A derive the whole plan up front, or the next few steps lazily?* | **T-1 §2** defines a divergence as re-deriving *"the remainder"* — and a remainder only exists if a whole plan does. Lazy derivation would make the divergence ticket undefined. |
| *Does Mode A hide behind a flag until it is proven?* | **T-1 §5.1**'s opening window already carries an idea box **and** a *"simply recreate the repo as it stands"* checkbox. Mode A is simply what happens when that box is unticked. **The UI decision predates the question.** |
| *Does the idea path need new UI?* | **T-3 shipped the field.** Only the path behind it was missing. |
| *Does deriving a plan from an idea need a new cost rule?* | **T-1 §9 criterion 10** already requires the plan to report what interpreting cost, and it applies unchanged. |

Two of the four were entailed by decisions the sponsor made *months* before the question arose, in
a document he had confirmed. Neither felt closed while being written — that is the point. **A
question feels open when you have not looked, and looking is cheaper than asking.**

## Why this matters more than tidiness

A form padded with questions the sponsor has already answered does three things, all bad:

1. **It spends attention that does not parallelise.** Everything else in a factory can be
   parallelised, delegated or retried. Their reading time cannot.
2. **It makes the real questions harder to find.** The one question that genuinely needs them is
   now surrounded by four that do not, and it is not marked.
3. **It quietly invites them to contradict themselves.** Offered a menu, a person picks from the
   menu — and may pick something their own earlier decision rules out, which then has to be
   unpicked by someone.

## The failure this does NOT license

Do not use the rule to answer something they never decided. The test is *entailment*, not
plausibility: an answer that follows from a clause they accepted is a lookup, an answer that
follows from your reading of their preferences is a **guess wearing a citation**. When it is a
guess, ask — that is what `dir-goals` and `dir-clarify` exist for, and inventing a sponsor's intent
is worse than waiting for it (`autodev/instructions/delegated-authority.md`).
