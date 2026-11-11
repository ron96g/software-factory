# ADR-0019: Sandbox runtimes behind one port (no host execution)

- **Status:** Accepted. Supersedes the v0.3 sandbox section of ADR-0016 and moves the tool-call loop of ADR-0017 into v0.3.
- **Date:** 2026-11-11

## Context
Construction agents must run commands and edit code. The factory runs on developer laptops (with or without Podman/Docker)
and inside Kubernetes clusters. A single hard-wired runtime doesn't fit both.

## Decision
1. **One port, many adapters.** `ExecutionEnvironment.prepare(spec) → Sandbox`. A sandbox exposes segregated capabilities:
   `SandboxExec`, `SandboxFiles`, `SandboxArtifacts`, `SandboxLifecycle`. Tools depend only on what they use (ISP).
2. **Runtime-neutral profiles.** New definition kind `SandboxProfile`: image, resources, network (`none | allowlist`),
   user, workspace, and a **minimum isolation** level (`container | microvm`). Agents reference it with `spec.sandboxRef`.
   Repositories may set a default.
3. **Adapters, registered by name:**
   - `podman` / `docker`: container per run, rootless, `--cap-drop=ALL`, read-only root, limits, per-run network plus egress proxy.
   - `kubernetes`: Pod per run in a dedicated namespace; init container clones with a short-lived token; `pods/exec`;
     NetworkPolicy; optional `runtimeClassName` (gVisor/Kata); a namespaced Role only.
   - `remote`: a hosted sandbox service, reached over an API.
   - `none`: no sandbox. Sandbox-requiring stages fall back to simulation with an explicit reason.
4. **Selection:** `FACTORY_SANDBOX_RUNTIME=auto|<adapter>`. `auto` tries, in order: in-cluster → podman → docker → remote → none,
   using each adapter's `health()`. A runtime that can't meet the profile's minimum isolation is never used silently.
   The selected runtime is recorded in run provenance and shown in the UI.
5. **No host execution.** There is no adapter that runs commands on the factory host. Adding one requires a new ADR.
6. **Tool-call loop in v0.3:** `ToolCallingLLM` adapters and the agent tool loop move from v0.5 to v0.3, because
   construction agents need them. MCP tool servers stay in v0.5.
7. Secrets: no factory secrets inside sandboxes. Git uses short-lived, single-repo tokens, registered with the redactor (ADR-0015).

## Consequences
The factory is useful everywhere (analysis always works) and safe by default. Real construction needs at least one
working adapter. Adapters are added when an environment needs them (ADR-0010).

## Alternatives considered
Podman only: fails on machines without it and in clusters. Docker-in-Docker in Kubernetes: needs privileged pods.
Host execution with prompt-level restrictions: unsafe.
