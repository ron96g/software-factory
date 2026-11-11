---
name: add-extension
description: >-
  Recipes for adding a pluggable implementation to the software-factory core: source connector, gate evaluator,
  gate check, skill handler, context provider, agent executor, LLM client, code search, workspace provider,
  outbox handler. Use whenever you add a new "type" of something.
---

# Add an extension (AGENTS.md rule 4, ADR-0006)

Extensions are **registered**, never added by editing core logic. Always follow the `interface-first` skill.
Then pick the recipe below.

| Extension | Port(s) | Selected by | Folder |
|---|---|---|---|
| Source connector | `SourceConnector` + any of `ItemFetcher`, `CommentPublisher`, `CommentReader` | `Source.spec.type` | `core/adapters/sources/<type>.ts` |
| Gate evaluator | `GateEvaluator` | `gate.type` | `core/workflow/gates/<type>.ts` |
| Gate check | `GateCheck` | `gate.checks[]` name | `core/workflow/checks/<name>.ts` |
| Skill handler (deterministic skill) | `SkillHandler` | skill name | `core/agents/skills/<skill>.ts` |
| Context provider | `ContextProvider` | `appliesTo(ctx)` | `core/agents/context/<name>.ts` |
| Agent executor | `AgentExecutor` | position in the chain + `canExecute` | `core/agents/executors/<name>.ts` |
| LLM client | `LLMClient` | config | `core/adapters/llm/<provider>.ts` |
| Code search | `CodeSearch` | `Repository.spec.index.type` (default `ripgrep`) | `core/adapters/codesearch/<type>.ts` |
| Workspace provider | `WorkspaceProvider` | `local` vs `git` | `core/adapters/workspace/<type>.ts` |
| Outbox handler | `OutboxHandler` | `action` | `core/adapters/outbox/<action>.ts` |

## Common steps
1. Implement the port(s). Only implement capabilities the external system really supports (ISP).
2. Export a factory function: `export function createXyz(deps: { …ports }): Xyz`.
3. Register it in `core/factory.ts` (composition root), e.g. `connectors.register("github", createGithubConnector({ secrets }))`.
4. Add or extend a definition if needed (e.g. a `sources/*.yaml` entry with the new `type`) and run the validator.
5. Test it in isolation with fakes. For HTTP adapters, inject `fetch` so tests don't hit the network.

## Recipe notes
- **Connectors:** map external data → `ExternalItem` only (anti-corruption layer). Never create WorkItems directly.
  The `SourceSyncer` does that. Secrets come from `SecretResolver` using `connection.secretRef`.
- **Outbound effects** (comments, labels) are `OutboxHandler`s. Controllers enqueue them through `Outbox` and never call the
  connector directly (rule 7).
- **Executors and skill handlers** must record everything through `ctx.transcript` (rule 14): the prompt or system note, the response,
  every tool call and result. Never record secrets.
- **Gate evaluators** return a `GateDecision`. They don't write status. The WorkItem controller applies the decision.
- **Context providers** must be cheap when `appliesTo` is false, and must cite sources in their sections (`repo:path:line`).
- **Unknown keys:** when a registry lookup fails, emit a Warning `Event` and fail visibly. Don't silently fall back,
  except where the plan allows it (automated checks pass with a warning during the MVP).

## Done when
- [ ] Registered in the composition root only
- [ ] Unit test with fakes
- [ ] Definitions using it validate
- [ ] Glossary/docs updated if it adds a user-visible concept
