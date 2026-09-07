# A reviewer re-derives its own numbers

Read this before writing a review brief, and before believing one.

## The rule

**A brief is an input to a review, never a substitute for the review's own measurement.** Every
figure a brief carries — a test count, a file count, a baseline, "this was verified" — is a claim
to check, not a fact to build on.

**Re-deriving the baseline is a required step of a review, not a habit good reviewers happen to
have.**

## Why it is written down: twice in one day, both times the brief was wrong

- **T-7.** The brief said "baseline entering T-7 was 966 unit tests". `main` measured **737** — 966
  was the mid-ticket count after three workers had landed. The code reviewer measured `main`
  itself and reported the real **+308/+9** instead of the +79 the brief implied.
- **T-12.** The brief repeated a builder's "1 withheld of 83 for repo-tour". 83 was repo-tour's
  *tracked file count*, not its reproduce list; the real figures were **27 entries in a fresh
  clone (1 withheld)** and **785 in the live tree (1 withheld)**. The reviewer re-derived and said
  so.

Both briefs were written by someone who had just run the numbers and still conflated them. Neither
error cost anything, and in both cases the *only* reason was that the reviewer measured instead of
inheriting.

## What a review that inherits its numbers is actually measuring

The author's confidence. A review that verifies a diff a third of the real size and reports green
has produced a record that reads exactly like a real one — the same failure as a green board with
nothing behind it, wearing a number.

## The general form

**Whoever checks the work must not inherit the numbers from whoever did it.** The same disease
travels the other way in this project's other two incidents: a finding closed without re-driving
its path, and a risk label spent without re-deriving what the code touches.
