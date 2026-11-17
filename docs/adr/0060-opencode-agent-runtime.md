# ADR-0060: OpenCode v2 as the agent runtime

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** project owner
- **Builds on:** ADR-0012, ADR-0014, ADR-0019, ADR-0020, ADR-0028, ADR-0031, ADR-0033, ADR-0034, ADR-0057, ADR-0058, ADR-0059
- **Replaces (staged):** the factory's own tool loop (ADR-0019 S3) and JSON-mode LLM executor as the default way agents run

## Context
Agents run in a tool loop the factory built itself: a fixed set of tools (`read_file`, `write_file`, `run`, …), whole-file
writes, no context compaction, no skills from the repository being worked on and no sub-agents. Results depend heavily
on the harness, and a mature coding-agent harness is a large product on its own.

OpenCode v2 ships an embeddable SDK (`@opencode/sdk`) that hosts its agent runtime inside our Node process, without an
HTTP listener. It brings precise edit/patch tools, a real shell, glob/grep, compaction, retries, skills (including the
repository's own `.agents/skills` / `.opencode/skills` and `AGENTS.md`), background sub-agents in child sessions, MCP,
and a plugin API with transforms (providers, models, tools, skills, MCP) and hooks (model requests, permissions, tool
execution, shell creation, retries).

A spike against a local fake model server confirmed on Node 25: our provider can be the only one; repository skills and
`AGENTS.md` load; sub-agents run as linked child sessions; a plugin `finish` tool captures the result; deny-by-default
session permissions block `.git` writes and paths outside the workspace; the shell hook removes inherited factory
secrets from commands; the context hook removes tools per request; a throwing `execute.before` hook reaches the model as
a tool error; with retries vetoed, a 429 ends the session with `provider.rate-limit` and `retryAfterMs`.

## Decision
### 1. One runtime for all LLM agent runs
- Every model-backed AgentRun (analysis, planning, review, construction, verification) runs as one OpenCode session in
  an OpenCode host embedded in the factory process (`@opencode/sdk` and `@opencode/plugin` v2, pinned to an exact
  version). The host lives behind the existing `AgentExecutor` port as the `opencode` executor, first in the chain.
- `FACTORY_AGENT_RUNTIME=tool-loop` disables it. The existing `tool-loop` and `llm` executors stay in the chain behind it
  until the OpenCode runtime has proven parity on real items, then they are removed (follow-up). Deterministic skill
  handlers and the simulated executor (ADR-0029) are unchanged.
- Conversations (explain, chat, refinement) keep the plain LLM client: they must stay side-effect free.

### 2. The factory controls models and configuration
- All providers bundled with OpenCode are removed. The run's model comes from `ModelResolver` (tier and per-agent
  `agentModels`, ADR-0014/0028) and is registered as an OpenCode provider with the endpoint and key of the factory's
  `ModelProvider`. The key is resolved by `SecretResolver` in-process and never reaches a prompt or a command.
- OpenCode never loads project configuration or plugins from the repository (`config.project: false`), never fetches
  the public model catalogue, and keeps its own state under the factory's data directory. Its session store is a cache;
  the factory transcript stays the record (ADR-0012).

### 3. Capabilities become deny-by-default permissions
Every session starts from "deny everything" and allows only what the agent's tools (ADR-0016/0057) declare, narrowed by
the step's `run.spec.tools` and by recovery diagnosis (ADR-0059):
- `read`/`search` → OpenCode `read`, `glob`, `grep` inside the workspace.
- `write` → `edit`/`write`/`patch`, never inside `.git`.
- `exec` → `shell`.
- Access outside the workspace (`external_directory`), web access (`webfetch`, `websearch`), Code Mode (`execute`),
  OpenCode's session/worktree management tools and the interactive `question` tool are denied and hidden from the
  model. Questions for humans go through `finish` and become Clarifications (rule 6).
- `skill` and `subagent` are always allowed. Child sessions inherit the parent's rules; they cannot call `finish` or
  start further sub-agents. Because project configuration is off, the host discovers the workspace's skills itself
  (`.agents/skills`, `.opencode/skills`, `.claude/skills`), and the executor adds the repository's `AGENTS.md` (or
  `CLAUDE.md`) to the recorded system prompt. Nothing from the host user, OpenCode's built-in skills or the factory's
  own development harness is offered.
- Factory tools (`run_check`, `read_check_log`, `run_baseline_check`, `search_knowledge`) and the agent's ToolServer
  tools (ADR-0034) are plugin tools dispatched to the run that owns the session; other sessions never see them.

### 4. Sandboxing (rule 18) is unchanged
- Agents with `write`/`exec` capabilities run in OpenCode only when the selected sandbox runtime is `host` (ADR-0020,
  explicit opt-in). OpenCode then works in the item's Workspace exactly where the host sandbox did. Commands get the
  scrubbed environment (PATH, HOME, LANG, TERM, USER) plus the sandbox profile's plain `env` (ADR-0033).
- For isolated runtimes the `opencode` executor declines and the run falls back to the tool loop until a workspace
  driver bridges OpenCode's command and file operations into the sandbox (OpenCode's `WorkspaceDriver`, follow-up).
- Read-only agents need no sandbox (ADR-0022).
- Every mutating tool call passes the mutation guard and is serialized with workspace jobs, as before.

### 5. Factory semantics stay the same
- Prompts come from the `PromptBuilder`. The harness adds a tool guide for the tools actually offered and the step
  budget (ADR-0057/0058).
- `finish` is validated in the loop (ADR-0057). Rejections come back as the tool result for correction. An accepted
  result ends the session.
- Step budget and wrap-up (ADR-0058) count model steps of the run's session. The last step offers only `finish`.
- `source-code` artifacts get the workspace diff against the pinned base, as before.
- Quota (ADR-0031): retries on 429/503/529 are vetoed and the run fails with `ModelUnavailableError` carrying the
  provider's retry delay, so the item waits instead of failing.

### 6. Everything is recorded (rule 14)
- Model steps (with token usage), assistant text, every tool call and result, harness notices, permission denials
  and failures are written to the run's transcript, from OpenCode events and tool hooks.
- Sub-agent activity goes into the same transcript, marked with the child session and agent.
- One session per execution. A process restart re-executes the run as before; the session is not resumed (follow-up).

## Consequences
- Agents get a stronger harness: precise edits, compaction, repository skills, sub-agents, a real shell. Factory
  rules (permissions, gates, recording, quota waits, budgets) still apply.
- A large dependency tree (Effect 4, about 700 packages) enters the server. It is pinned and kept out of client bundles
  (`serverExternalPackages`).
- Two runtimes coexist until parity is shown. Tests that feed fake non-streaming LLM responses pin
  `FACTORY_AGENT_RUNTIME=tool-loop`.
- Isolated sandboxes do not use OpenCode yet. The follow-up is a workspace driver that runs OpenCode's process and file
  operations inside the sandbox while model calls and keys stay in the factory process (ADR-0019 §7).
- AGENTS.md adds X40, and rule 18 references this ADR. The glossary adds **Agent runtime**.

## Alternatives considered
- **Keep improving our tool loop:** we would rebuild what OpenCode already ships, more slowly.
- **Run `opencode serve` inside the sandbox:** puts model keys into the sandbox, which ADR-0019 §7 forbids.
- **OpenCode v1 (`@opencode-ai/sdk`) over HTTP:** a separate process with its own configuration and no in-process hooks
  for permissions, tools and retries.
- **OpenCode only for the developer agent:** keeps two harnesses with different abilities. The factory semantics are
  shared, so all LLM agents use the same runtime.
