# A fixture for a detector must not contain a string that detector would match

Read this before writing a test for anything that scans, detects, or classifies.

## The rule

**A test fixture for a detector must not embed a real-looking instance of the thing being
detected.** Construct it at runtime — join it from parts, build it from a template, generate it —
so the source file holds no matchable literal while the value under test stays byte-identical.

This generalises past secrets. Any test that embeds a realistic example of what the system is
built to notice will eventually be noticed **by something else**: a scanner, a linter, a crawler, a
classifier, an antivirus, a DLP filter, another team's CI. The test is correct; the artefact
carrying it is a hazard.

## The incident, because it is what makes this memorable

T-8 built a disclosure check that scans a packaged archive for credential shapes. Its test file
listed twelve fixtures — `sk-ant-`, `github_pat_`, `glpat-`, `xoxb-`, an AWS key, a JWT — with
synthetic bodies (`AbCdEf0123456789`; the AWS one is Amazon's own published example key). **None
was real.**

**GitHub push protection rejected the push.** Two of the prefixes are distinctive enough that a
real scanner matches them regardless of the body.

> **Our secret scanner's own test file was unpushable because a real secret scanner agreed with our
> threat model.**

The scanner was not wrong. The fixtures looked like secrets *because a fixture that does not look
like a secret does not test a secret detector.* The requirement and the hazard are the same
property.

## Two things learned the expensive way

**Fixing it forward is not enough.** Push protection scans **every commit in the range**, not the
tip. Splitting the fixtures in a new commit left the literal in the earlier one and the push was
rejected again. Getting a literal out of a repository means getting it out of *history*, which is a
much larger operation than getting it out of a file — so the cheap moment to avoid this is when the
fixture is first written.

**Split them all, not the ones that were caught.** Only two of twelve were flagged. The next
scanner pattern lands without warning, and it lands on whoever is pushing that day.

## What NOT to do

Every scanner offers a way to allow a flagged string. **Do not take it to make a test file
pushable.** It whitelists that shape on that repository, permanently, for a problem whose honest
fix is one line of string concatenation — and on a public repository it is a standing hole traded
for a moment's convenience. That it takes two clicks is what makes it dangerous, not what makes it
fine.
