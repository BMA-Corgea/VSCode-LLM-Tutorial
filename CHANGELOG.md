# Changelog

## 0.1.0 (2026-11-17)

The first public release. Build Tutorials is a VS Code extension that turns an existing
repository into a step-by-step tutorial for rebuilding it, one decision at a time, and then has
you do the rebuilding.

### What you get

- **Start** from a GitHub URL or a local folder holding a Python, JavaScript or TypeScript
  project. The build reads the repository and its history and plans the steps in the order the
  project was actually built.
- **The walk**: one decision per step, with the options the author had, each decision's *why*
  (and where that why came from), and its *witness*, the commit where the decision was made.
  Reload the window and the walk resumes at the step you left.
- **The dial**: *manual*, *scaffolded* or *automated* on every step, which decides how much of
  the code you type yourself.
- **Check my work**: a structural check of your file against the original. It names the exports
  and imports that are present, missing or extra, and says whether the file parses.
- **The tutor**: a chat under each step that already knows the decision, the roads not taken and
  how your file differs from the author's.
- **The detour**: a small worked example of the same idea in an unrelated domain, opened as real
  editor tabs and removed again when you go back to your build.
- **The Doctor**: *Build Tutorials: Doctor* says in plain sentences what this machine can do: the
  core it found, its four grammars, and whether the `claude` CLI is there.
- A commit per step in your tutorial folder, under that folder's own git identity.

### What it needs

- VS Code 1.95 or later, or VSCodium.
- git.
- The `claude` CLI on your PATH and logged in. The build asks it for each step's why, and the tutor
  and the detour talk to it.

### Known limits

- Proven on Linux only: VS Code 1.145.2 and VSCodium on the build machine, and VS Code 1.146.0 on
  GitHub's runner. macOS and Windows are unproven.
- It builds from an existing repository only. Building from an idea, in your own words, is not
  available yet.

Install it from the `.vsix` on the release page:
https://github.com/BMA-Corgea/VSCode-LLM-Tutorial/releases
