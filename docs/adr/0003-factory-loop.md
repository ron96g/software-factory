# ADR-0003: Factory loop mapped onto AI-DLC phases

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
AI-DLC defines Inception, Construction, and Operations, with human oversight. We need a concrete, operable loop.

## Decision
The loop is `input → classify → triage → spec → spec-review → implement → code-review → verify → ship → monitor → repeat`.
- Inception: classify, triage, spec, spec-review (human gate, Mob Elaboration).
- Construction: one Bolt per Unit of Work: implement, code-review (human gate, Mob Construction), verify (automated gate).
- Operations: ship (human gate), monitor (automated gate). Failures create a new WorkItem through the
  `monitoring-feedback` source.
- Classification runs automatically on create or sync. Any stage can block an item through `human-clarification`.
- `code-researcher` is a shared, read-only agent that other agents delegate to (`spec.delegates`).

Defined in `workflows/factory-loop.yaml` and `workflows/construction-bolt.yaml`.

## Consequences
Every stage has an owning agent, skills, typed artifacts, and an explicit gate.
