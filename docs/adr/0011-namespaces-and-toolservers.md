# ADR-0011: Namespaces per squad & ToolServer (MCP) kind

- **Status:** Accepted (MVP: seams only. Full implementation in increment v0.4 / v0.5)
- **Date:** 2026-11-11

## Context
Each squad should be able to have its own workflows, agents, skills, and MCP servers, while reusing shared ones.
Today definitions share one flat set of names, there is no link from a squad to its definitions, and `Agent.spec.tools` is a list of strings.

## Decision

### Namespaces (Kubernetes-style)
- `metadata.namespace` on every resource. **One namespace per squad**, plus the shared namespace `factory-system`.
- Layout: `./{agents,skills,workflows,…}` is `factory-system`, and `squads/<squad>/{agents,skills,workflows,…}` is `<squad>`.
- **Reference resolution:** look in the referencing object's namespace first, then `factory-system`. An explicit
  `{ namespace, name }` is allowed **only** when the target is `factory-system`, so squads can't reference each other's
  private definitions.
- Runtime objects (WorkItems, …) live in their squad's namespace. This becomes the main mechanism for squad scoping in
  ADR-0009: visibility and edit rights are granted per namespace.
- `Squad.spec.defaults.workflowRef` joins the defaulting chain: squad → source → global.

### ToolServer (MCP)
- New definition kind `ToolServer`: `transport` (`stdio | http`), `command` or `url`, `secretRef`, `allowedTools[]`.
- Agents reference it with `spec.toolServerRefs`. It is scoped by namespace like other definitions.
- It plugs into the agent pipeline through a new port (`ToolProvider`), defined when the increment starts (interface first).

### MVP (now, seams only, per ADR-0010)
- Add `namespace?` to `ObjectMeta`, `Ref`, `ObjectKey`, and the store read and list ports. The **store key is
  `(namespace, kind, name)`** from day one.
- Everything in the MVP lives in `default` (runtime) and `factory-system` (definitions). No `squads/` folders, no
  `ToolServer`, no cross-namespace rules yet.

## Consequences
Adding real squads later doesn't need a data migration. Name collisions between squads are impossible by
construction. Supersedes the "Namespaces / multi-tenancy: not adopting (yet)" note in `docs/patterns.md`.

## Alternatives considered
Squad labels on global names: collisions and prefix conventions (`payments-triager`), with weaker isolation.
Separate deployments per squad: no sharing, and higher operating cost.
