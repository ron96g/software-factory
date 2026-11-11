# ADR-0002: Kubernetes-style resource model for everything

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
Definitions (agents, skills, workflows) and runtime objects (work items, runs) must reference each other and be
handled uniformly by the API, the UI, and the validation.

## Decision
- All objects use the envelope `apiVersion: factory.ai-dlc.io/v1alpha1`, `kind`, `metadata`, `spec`, `status`.
- `Agent` and `Skill` are Markdown with YAML frontmatter (the body is the prompt). `Workflow`, `ArtifactType`, `Source`, and
  `Repository` are YAML custom resources.
- References are typed `*Ref` fields (`agentRef`, `skillRefs`, `workflowRef`, `artifactRef`, `sourceRef(s)`,
  `repositoryRefs`, `requires`, `delegates[].agentRef`).
- Runtime kinds: `WorkItem`, `AgentRun`, `Artifact`, `Clarification`, `Approval`, `Event`, `OutboxMessage`.
- `spec` is written by humans and sync, `status` only by controllers. Optimistic concurrency uses `resourceVersion`.

## Consequences
One generic API and UI for all kinds, and references can be validated mechanically. Authors must follow the envelope.

## Alternatives considered
Ad-hoc JSON/TS config: no uniform referencing or tooling. Plain prompt folders: no workflow structure.
