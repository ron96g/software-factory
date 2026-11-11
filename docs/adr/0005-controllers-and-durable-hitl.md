# ADR-0005: Controllers, reconciliation, and durable human-in-the-loop

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
Work items move through long-running flows with human waits that can last hours or days, and the process may restart.

## Decision
- Controllers are level-triggered and idempotent, and run from a de-duplicating work queue with backoff and periodic resync.
- Each agent execution is an `AgentRun` resource (Job pattern). Its idempotency key is `<workitem>-<stage>-<step>-<round>`.
- Human waits are durable resources (`Clarification`, `Approval`). A WorkItem becomes `Blocked` or `AwaitingApproval`
  and resumes when the resource is answered or decided.
- Outbound effects use a transactional outbox (`OutboxMessage`).
- Audit trail: `Event` resources. State lives in the resources (no full event sourcing).

## Consequences
The system survives restarts and the behavior is traceable. It is more complex than direct calls.

## Alternatives considered
Temporal or Argo: powerful, but more operational weight than needed now (revisit in M8).
