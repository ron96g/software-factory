# ADR-0079: Bubblewrap (`bwrap`) filesystem-isolated runtime and OpenCode shell confinement

- **Status:** Accepted (extends ADR-0019, ADR-0020; amends ADR-0060 §4). Its isolation claim covers **commands**, not the
  agent: see `docs/security.md` §4 (enforcement matrix) and SEC-1/SEC-8/SEC-19/SEC-20. ADR-0081 (proposed) narrows the
  claim formally and completes the flag set; ADR-0080 (proposed) is where the boundary itself moves.
- **Amended by ADR-0080 §10:** the `host` runtime it mentions was removed; `bwrap` and `none` remain as runtimes, with `kubernetes` planned.
- **Date:** 2026-11-20
- **Deciders:** project owner

## Context
Today only two `ExecutionEnvironment` adapters exist: `none` and `host` (ADR-0020). On `host`, commands run directly as
the OS user with full read/write access to `$HOME` (`~/.ssh`, `~/.config`, `~/.aws`), other repositories, and the
factory's own data directory (`web/data/`).

Operators running the factory on a Linux host want **filesystem isolation** (agents and checks can only see and modify
the work item's workspace) **while keeping outbound network access** (to download Go/npm modules or research) and
reusing host-installed toolchains without maintaining container images or a Docker daemon.

## Decision

### 1. New `bwrap` `ExecutionEnvironment` adapter (`isolation: "process"`)
- Add `BwrapEnvironment` implementing `ExecutionEnvironment` and `IsolatedSnapshotEnvironment` (registered under key
  `"bwrap"` in the composition root `web/src/core/factory.ts`).
- `health()` probes `bwrap --version` and `git --version` (plus a quick `bwrap --ro-bind / / true` smoke check to verify
  unprivileged user/mount namespaces work on the host kernel). If unavailable, it reports `available: false` with a
  clear install/kernel message.
- **Filesystem confinement:** every command runs inside `bwrap` with:
  - Read-only binds (`--ro-bind`) for host OS and toolchain roots that exist on the host (`/usr`, `/lib`, `/lib64`,
    `/bin`, `/sbin`, `/etc`, `/opt`, and any non-`$HOME` toolchain prefixes on `PATH`, plus Linuxbrew if present on
    `PATH`, never the user's `$HOME` itself, never the factory data dir, and never other workspaces).
  - `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`, and a fresh ephemeral `--tmpfs` home directory (`HOME=/tmp/home`).
  - Read-write bind (`--bind <workspace> <workspace>`) **only** for the work item's Ready workspace (or the isolated
    snapshot directory for `prepareIsolated`), with `--chdir <cwd>`.
  - **`.git` hardening:** after the workspace bind, `<workspace>/.git` (whether a worktree pointer file or a real `.git`
    directory) is overlaid read-only (`--ro-bind`), and backing worktree gitdirs are bound read-only. Host-side `git`
    calls in `BwrapSandbox` (`diff`, `listFiles`) run with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
    `-c core.fsmonitor=false`, and `-c core.hooksPath=/dev/null` so confined commands cannot plant git hooks or config
    that execute on the host.
  - `--unshare-pid` and `--die-with-parent` for process isolation.
  - `--share-net` to **preserve outbound network access** for package managers and research.
- **Scrubbed environment:** same allowlist as ADR-0020 (`PATH`, `LANG`, `TERM`, `USER`) plus `HOME=/tmp/home` and the
  `SandboxProfile.spec.env` plain variables (ADR-0033). No factory secrets reach the process.
- **`IsolatedSnapshotEnvironment`:** `isolatesCandidate = true`. `prepareIsolated()` clones the exact commit/snapshot
  into a disposable directory and binds *only* that directory into `bwrap`, so isolated baseline/candidate checks cannot
  read or modify the candidate workspace.

### 2. Selection and isolation waiver semantics
- `bwrap` is registered in `DefaultEnvironmentSelector`'s `auto` order after container runtimes (`kubernetes`, `podman`,
  `docker`, `remote`) and before `none`.
- When selected via `auto`, `bwrap` reports `isolation: "process"` and `waivesIsolation: false` (it satisfies profiles
  requiring `process` or `none`, never silently downgrading `container`).
- When explicitly opted in via `FACTORY_SANDBOX_RUNTIME=bwrap`, it sets `waivesIsolation: true` (like `host` in
  ADR-0020), allowing local use with `isolation: container` profiles (`node-build`, `go-build`) while recording a clear
  transcript notice that `container` isolation was waived to `process` (`bwrap`).
- `GitWorktreeWorkspaces` is enabled for `bwrap` (explicit or auto-selected) in `web/src/core/factory.ts`, alongside
  `host`.

### 3. OpenCode shell confinement (amends ADR-0060 §4)
- `OpenCodeExecutor` accepts `bwrap` in addition to `host` for agents with `write`/`exec` capabilities.
- OpenCode's file tools (`read`, `glob`, `grep`, `edit`, `write`, `patch`) already stay inside the workspace via
  `external_directory: deny` and `.git` protection (`PROTECTED`).
- When the run's sandbox runtime is `bwrap`, `OpenCodeHost.onShell` (`ctx.shell.hook("create.before")`) rewrites the
  shell command to execute inside `bwrap` using the same workspace-only bind, read-only system binds, ephemeral
  `HOME=/tmp/home`, scrubbed env, `--unshare-pid`, `--die-with-parent`, and `--share-net`.

```mermaid
flowchart LR
  Agent[OpenCode / CheckRunner] --> Shell[shell / SandboxExec]
  Shell --> Bwrap[bwrap: --unshare-pid --share-net --die-with-parent]
  Bwrap -->|ro-bind| OS[Host OS & toolchains: /usr /lib /bin /etc]
  Bwrap -->|tmpfs| Tmp[/tmp & ephemeral HOME=/tmp/home]
  Bwrap -->|rw-bind| WS[WorkItem Workspace only]
  Bwrap -.->|invisible| Host[Host $HOME, ~/.ssh, factory DB, other workspaces]
```

## Consequences
- On Linux hosts with `bubblewrap` installed, agents and checks can no longer read `~/.ssh`, `~/.config`, other repos,
  or the factory's SQLite database, while still downloading dependencies and using host toolchains at native speed.
- **Accepted trade-offs:**
  - Outbound network remains open (`--share-net`) by design, which includes host `localhost` services (e.g. the
    factory's own HTTP/MCP server if bound to loopback); `SandboxProfile.spec.network.allow` is not enforced at the
    packet level by `bwrap` (container/Kubernetes adapters remain the target for strict network allowlisting).
  - `/etc` is mounted read-only so DNS resolution, TLS root CAs, and system libraries work.
  - OpenCode's in-process file tools (`read`, `glob`, `grep`, `edit`, `write`, `patch`) are not wrapped by `bwrap`; they
    rely on OpenCode's `external_directory: deny` and `PROTECTED` `.git` permission rules. Only `shell` and
    `SandboxExec` commands run inside `bwrap`.
  - Because `.git` and the worktree gitdir are read-only inside `bwrap`, mutating Git commands (`git commit`,
    `git add`, etc.) fail inside the sandbox; this is intended because the factory owns commits and PR publication.
- `AGENTS.md` updates rule 18 and adds milestone **X58**.

## Alternatives considered
- **Docker/Podman container adapter first:** Stronger isolation and enforces container images, but requires a running
  container daemon and maintaining toolchain images matching every repo; slower iteration on a single dev host. Can be
  added later as another `ExecutionEnvironment` adapter without changing core logic.
- **Unshare network (`--unshare-net`) by default:** Blocks npm/Go module downloads and external research, which the
  operator explicitly wants enabled.
- **Keep `host` only:** Leaves `$HOME` and factory runtime files readable by every agent shell command.
