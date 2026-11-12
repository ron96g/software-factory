# ADR-0033: Sandbox profile environment and repository-first profiles

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** project owner
- **Extends:** ADR-0019, ADR-0020

## Context
On the `host` runtime, commands get only PATH, HOME, LANG, TERM and USER (so no factory secret leaks), and run in a
non-interactive login shell. Toolchain settings that live in a developer's interactive shell (e.g. `GOPROXY` in
`~/.bashrc`) are missing, so `go install` failed and agents could not install `controller-gen` or envtest; they asked
humans instead. Also, the tool loop always used the agent's `sandboxRef` (e.g. `node-build` for the developer), even
for a Go repository whose `Repository.sandboxRef` names a Go profile; only the build/test checks used the repository's.

## Decision
- `SandboxProfile.spec.env`: plain, non-secret environment variables that every command in that sandbox gets
  (host runtime now; container runtimes map them later). Definitions live in Git, so secrets never go here (rule 16).
- The tool loop uses the profile of the item's repository (one with a Ready workspace and a `sandboxRef`) and falls
  back to the agent's `sandboxRef`. The agent still declares `sandboxRef` to say it needs a sandbox at all.
  The transcript records which profile was used and where it came from.
- The `go-build` profile sets `GOPROXY=https://proxy.golang.org,direct`. Developer and verifier agents are told to use
  the repository's documented targets and to install missing tools themselves before asking a human.

## Consequences
- Agents can install repository tooling (`make controller-gen`, `make setup-envtest`) on the host runtime regardless of
  a developer's shell configuration.
- Profile env values are visible in Git and in transcripts; anything sensitive still needs a different mechanism.

## Alternatives considered
- Pass the factory's whole environment through: leaks secrets into agent commands (rejected, ADR-0019 §7).
- Run an interactive shell (`bash -i`): picks up personal shell config, unpredictable and machine-specific.
