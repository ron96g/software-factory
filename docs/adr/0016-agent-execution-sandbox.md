# ADR-0016: Agent execution environment & sandboxing

- **Status:** Accepted (MVP: in-process, read-only tools. Sandbox implemented in v0.3)
- **Date:** 2026-11-11

## Context
Agents run inside the factory process (ADR-0007). In the MVP they only call LLMs and read code. From v0.3, agents write code
and run builds and tests. Model-generated commands must not run with the factory's privileges, file system, or secrets.

## Decision

### MVP (v0.1–v0.2)
- AgentRuns execute **in-process**. Agents can only use **tools implemented in our code** (registered handlers, e.g. code
  search), and all of them are **read-only**. Free-form shell, file writes, and network tools are **not** available.
- `Agent.spec.tools` names are resolved through a tool registry. Unknown tools fail the run visibly.

### From v0.3: sandbox
- New port **`ExecutionEnvironment`** (defined in v0.3, interface first): `prepare(run) → Sandbox`, and
  `Sandbox.exec(cmd)`, `readFile`, `writeFile`, `dispose()`.
- Default adapter: **one container per AgentRun**. Only that WorkItem's workspace (a Git clone) is mounted. No factory
  secrets. Network egress follows an allowlist (package registries, the Git remote). CPU, memory, and time limits apply.
  It runs as non-root.
- Later adapters: Kubernetes Job per run, remote sandbox services.
- Tool policies are declared per agent (`spec.tools` plus a future `spec.sandbox` profile) and enforced by the environment, not by the prompt.
- Credentials needed inside the sandbox (e.g. a push token) are short-lived and scoped to that repository.

## Consequences
The MVP stays simple and safe through restricted capabilities. v0.3 needs a container runtime (Docker or Podman) on the host.

## Alternatives considered
Running shell tools in-process with "careful prompts": not acceptable. Sandboxing in the MVP: no current need (YAGNI, ADR-0010).
