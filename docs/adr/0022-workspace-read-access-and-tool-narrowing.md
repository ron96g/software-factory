# ADR-0022: Workspace read access without a sandbox; capability model; step-level tool narrowing

- **Status:** Accepted. Clarifies ADR-0019 (which execution needs a sandbox) and extends ADR-0021.
- **Date:** 2026-11-11

## Context
Analysis agents (triager, code-researcher, architect, reviewer) only saw code-search snippets and couldn't read whole files.
They need to read the item's workspace, but must never write or execute. Some workflow steps (e.g. the fast classification)
shouldn't use tools at all, even if the agent has them.

## Decision
1. **Capability model for tools.** A tool declares the capabilities it binds to, and receives only those (ISP):
   - `read` (`FileReader`: read/list) and `search` (`CodeSearcher`) are **workspace-bound** and need **no sandbox**.
     The factory reads the item's Ready workspaces directly, read-only.
   - `write` (`FileWriter`), `exec` and `artifacts` are **sandbox-bound** (`SANDBOX_CAPABILITIES`). An agent that needs any of
     them runs only with a `sandboxRef` and an available sandbox runtime (ADR-0019/0020).
   - `SandboxFiles` is split into `FileReader` + `FileWriter`. The "needs a sandbox" property is derived from the capabilities.
2. **Read guards:** paths must stay inside the workspace **after resolving symlinks** (`realpath`), and `.git` is never readable.
   File reads are size-capped.
3. **Search** is always served from the workspace, also in sandbox runs. It reflects the pinned workspace plus anything the
   host runtime wrote there, but not writes inside an isolated container sandbox.
4. **Step-level tool narrowing:** `StepSpec.tools` (copied to `AgentRunSpec.tools`) **intersects** the agent's tools.
   It can only narrow, never extend. `tools: []` runs the step without tools (JSON mode). `tools/validate.py` rejects step
   tools that the agent doesn't have.
5. If no workspace is available (e.g. no workspace backend for the runtime), analysis agents fall back to JSON mode with
   code-search context, as before.

## Consequences
Analysis is grounded in real code, cited as `repo:path:line`, and least privilege holds per agent and per step.
Known limit: file contents go to the model unredacted. That's acceptable because workspaces contain no factory secrets (ADR-0019 §7).
