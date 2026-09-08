# A test that types the default is testing the literal, not the default

Read this before writing a test that mentions a configured value, and before changing one.

## The rule

**A suite that hard-codes the thing it is meant to be checking is not weak coverage — it is
coverage of a different program.** Read the shipped value from where it ships.

Any value that exists in two places — a manifest and a constant, a schema and a validator, a
config default and a fallback, a limit and the message that quotes it — is a place where a test
can agree with the wrong copy. **Import the one that ships, or assert the copies are identical.**

## The instance, kept because it is what makes the rule believable

T-8 changed `buildTutorials.repoTourPath`'s shipped default from `'../repo-tour'` to `''`. That
routed `resolveCoreRoot` through `require.resolve`, which **throws** where the old branch returned
a reportable failure — so the **Doctor**, the one command whose entire job is to be useful when the
core is missing, printed a raw Node stack. `README.md` promised on the same page that a
misconfiguration is *"a report in plain sentences, never a stack trace"*.

**1,212 tests were green over it.** Not thin coverage: **all ten call sites passed
`'../repo-tour'` as a literal.** Every test exercised the value the tests had typed, so the
shipped default was untested by construction and changing it changed nothing any test could see.

**The fix that mattered was not making `resolveCoreRoot` total.** That repairs one instance. It was
the new test reading `contributes.configuration.properties[…].default` out of `package.json` and
never typing the string, plus collapsing four scattered copies into one exported constant with a
test asserting it equals the manifest's. That is what stops the next change re-hiding it.

## How to tell you are doing it

Ask: **if the shipped value changed tomorrow and nothing else did, would any test go red?** If the
answer is no, the suite is pinned to a literal and the program it tests is not the one that ships.

The same question catches the sibling forms: a mutation sweep that enumerates fields by hand proves
the list somebody remembered, not the property; a test suite aimed at an exported function nothing
calls proves a property of a dead path; and a category test (`.js` is "textual") stands in for the
property it is meant to check until a file breaks the category.
