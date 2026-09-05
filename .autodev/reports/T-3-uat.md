# T-3 — UAT: is this what the owner MEANT?

**Intent chain:** T-1 → spec §5.2 (Evan's own sketch of the opening window: idea box, the recreate
checkbox, repo required iff checked, the dial), §5.7 (*"just like the repo-tour I want to be able to one
shot new css styles so have it modular like that"*), §5.2's write-ahead marker (repo-tour's T-4 lesson).

**Conformance read (agent, uat level auto; accept spent on-behalf under GA-1 — "loop through it until these
are created"):**

| what was meant | what was built | verdict |
| --- | --- | --- |
| the opening window as Evan drew it | idea textarea, recreate checkbox, repo field required iff checked, target folder, three-position dial; validation shown under the field | conforms |
| honest where a mode is not here yet | idea-only shows the exact "arrives with T-9" line, in the form | conforms |
| one CSS file → both front ends | webviews inline repo-tour's `baseCss()` + `alternateCss()`; a fixture skin dropped into a copy of repo-tour's assets appears with zero extension change; System follows the editor theme through a bridge that covers every base token | conforms |
| a build that survives a reload | per-phase marker on disk; resume from it — simulated, not a literal kill (disclosed) | conforms, with the simulation noted |
| the plan lands with the project | `<target>/.repo-tour/build/plan.json` + `request.json`, schema-validated; cost shown honestly | conforms |

**Fitness in the hands:** the builder opened the real start screen in codium and captured it. Evan's own
acceptance is booting `start.sh` at the end of the set.

**Gaps / carried forward:** the literal kill-and-resume drill belongs to the acceptance run on sql-gauntlet
(orchestrator, T-8's package check). The stray VSCodium crash-recovery dialog the screenshot left behind is
desktop cosmetics, not a repo fact.
