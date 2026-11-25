# ADR-0088: Profile-declared tools and a factory-owned toolchain cache

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** project owner
- **Amends:** ADR-0033 (toolchains in sandboxes: `SandboxProfile.env` stays for plain values; tools are declared, not scripted)
- **Addendum (2026-11-24, read-only for commands):** the cache is writable **only** in the sandbox the factory creates to
  provision it; every check, agent shell and isolated snapshot mounts it **read-only**. The *caches* (Go module cache,
  npm/pip/cargo) therefore do not live in the cache but in a **per-workspace home**, kept **outside** the mounted
  directory (`<cache>-homes/<hash of the workspace path>`) so a sandbox cannot read another item's home through the
  read-only mount; an isolated snapshot gets the ephemeral tmpfs `HOME` of ADR-0079. Provisioning itself also runs with an
  **ephemeral `HOME`**: a candidate that wrote `~/.config/go/env`, `.gitconfig` or `.netrc` must not steer what is
  installed into a cache every item shares. A candidate can then neither plant a binary another command executes nor
  leave configuration another command reads — evidence keeps coming from a runtime the candidate cannot influence
  (ADR-0080 §13). Three consequences are accepted: a command cannot `go install` onto `PATH` (a tool an agent needs is
  *declared*; `command` covers repo-specific builds), an isolated check re-downloads its dependencies because its home is
  cold (and that cold home is a tmpfs, so a large dependency tree costs memory during the run), and a `command`-type
  provisioner still runs repository code — in the item's workspace, with a writable cache — which is the same trust level
  as running the repository's own `Makefile` (SEC-22).
- **Related:** ADR-0019 (runtime-neutral profiles), ADR-0079/ADR-0081 (sandbox confinement), ADR-0080 §2/§10 (the runtime hosts the toolchain), ADR-0021 (workspaces belong to the store), ADR-0061/ADR-0063 (checks and their evidence)

## Context

Every environment failure we have hit has the same shape: the environment a command ran in was not the environment
its definition assumed, and nothing in the system knew it.

- `controlplane/preflight` failed with `spawn git ENOENT` (a missing checkout), then `SetupFailed` (a `&&` chain that
  stopped at `command -v gotestsum`, a binary only the target repo's CI installs). The operator had to know that
  `gotestsum` exists, that CI installs it, and how to install it into a directory the *later* checks would find.
- A sandboxed command had **no DNS** on WSL, because `/etc/resolv.conf` is a symlink to `/mnt/wsl/resolv.conf` and the
  sandbox binds `/etc` but not `/mnt`. It surfaced as `lookup proxy.golang.org … connection refused` inside an
  unrelated check.
- A module- or binary-installing command re-downloaded everything on every run: `HOME` is an ephemeral tmpfs, so Go's
  module cache and npm/pip caches never survive a command.
- A `scoped` check cannot put a tool on `PATH` itself (its command must be exactly `make <target>`), so "the tool is in
  the workspace" was not enough either.

The knowledge needed is *environment* knowledge — which binaries must exist, where they live, how they are installed,
whether caches persist. Today it is spread over per-repo shell strings, the target repo's CI files (which the factory
must not execute), the operator's head, and factory code. The factory cannot report a gap it does not model, and the
operator is asked for know-how nobody should need.

## Decision

1. **Tools are declared on the profile, not scripted in checks.** `SandboxProfile.spec.tools[]` names the binaries the
   environment must provide and how to obtain each one:

   ```yaml
   tools:
     - name: gotestsum
       provides: bin/gotestsum                      # where readiness is observed, relative to the cache
       via: { type: goInstall, with: { module: gotest.tools/gotestsum@v1.13.0 } }
   ```

   `provides` makes readiness a **file check** the factory can answer without running anything.

2. **Provisioning is a registry of provisioner *types*, so unknown tools need no factory change** (rule 4). A
   provisioner receives its parameters as data (`via.with`, validated) and the cache it installs into; it never knows
   how to spawn a sandbox. `goInstall` covers any Go tool; `command` is the documented escape hatch (a repo-authored
   command run in the sandbox with the cache environment) for everything else. New mechanisms (`download`, `npmGlobal`,
   `container`, `build`) are new registered implementations — never a `switch` in core.

3. **The runtime owns a persistent, factory-owned toolchain cache.** One directory per store, mounted read-write into
   the sandbox at a fixed path (`/factory-tools`) and **on `PATH`**; the runtime also sets the per-language conventions
   an operator should not have to know: `GOBIN`, `GOPATH`, `npm_config_cache`, `PIP_CACHE_DIR`, `CARGO_HOME`. Installs
   therefore persist across commands and are visible to every later command — including `scoped` checks that cannot set
   `PATH` themselves.

4. **`HOME` becomes factory-owned and persistent** (`<cache>/home`, still never the operator's home). The guarantee of
   ADR-0079 ("commands cannot see `$HOME`, `~/.ssh`, `~/.config`") is unchanged; only *ephemerality* is dropped, which is
   what made caches useless.

5. **The factory ensures the declared tools before a sandbox is handed out** (`ExecutionEnvironment.prepare`), and the
   ensure is idempotent: a tool whose `provides` file exists is not touched.

6. **Readiness is visible before an item runs.** `SystemHealth` gains `toolGaps`: for each repository, the declared
   tools whose `provides` file is missing, next to the existing `policyGaps`. The UI shows them in the health badge, so
   "this repository's environment is not prepared" is a badge, not a blocked item.

7. **Environment portability is the factory's job, and it is contract-tested.** The DNS bind (a symlinked
   `/etc/resolv.conf` needs its target bound) is an example: an operator must not discover their platform's quirks
   through a failing check.

## Consequences

- A Go (or Node, or Rust) repository needs **no** hand-written `PATH`/install plumbing in its checks; declaring the
  tools is one line each, and forgetting one produces a visible gap rather than a cryptic `SetupFailed`.
- Checks that install tools (or download assets) stop re-downloading them: the cache is the difference between a 20 s
  preflight and a 10-minute one.
- The cache is shared by every command of the store, so a check with write access can leave a binary that a later check
  executes. That is the **same trust level as running the repository's own `Makefile`**, which checks already do, and it
  is bounded by the cache being factory-owned and outside the candidate workspace. Closing it completely (cache
  read-only for verification, provisioning only in a factory-controlled runtime) is the runtime work of ADR-0080.
- `SandboxProfile` gains a field, so the CRD is regenerated and the definition validator learns the new shape.
- Known limits of this increment: no detectors yet (a profile must declare its tools), provisioning happens where a
  sandbox is prepared (checks) rather than inside `AgentRuntime`, and `command`-type tools are still shell.

## Alternatives considered

- **Keep scripting installs in each check.** Rejected: duplicated per repository, invisible to the factory, and it
  cannot work for `scoped` checks at all.
- **Execute the target repository's CI workflow.** Rejected: it is untrusted content (SEC-2 class) and not a contract
  the factory can rely on.
- **A global tool directory on the host (e.g. `~/.local/bin`).** Rejected: it is the operator's environment, it leaks
  into every repository, and the sandbox cannot write it (by design).
- **A new `Toolchain` kind referenced from the repository.** Deferred: `SandboxProfile` already is the environment
  definition (ADR-0033) and the repository already references one, so a new kind buys nothing yet. If tools must be
  shared across profiles or versioned independently, that becomes its own ADR.
